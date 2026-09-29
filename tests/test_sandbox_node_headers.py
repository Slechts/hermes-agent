"""Header selection contracts; argv capture is not a namespace E2E test."""
import os
from pathlib import Path
import re
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
STAGE1 = ROOT / 'scripts/dev-sandbox.sh'
STAGE2 = ROOT / 'scripts/sandbox/stage2-run.sh'
pytestmark = pytest.mark.linux_only


def function(source: str, name: str) -> str:
    match = re.search(rf'(?ms)^{name}\(\) \{{\n.*?^\}}\n', source)
    assert match, name
    return match[0]


def _stage1_selection(home: str, override: str = '') -> str:
    source = STAGE1.read_text()
    block = source.split('INTERACTIVE=false\n', 1)[1].split('WAYLAND_SOCKET=""', 1)[0]
    env = {'PATH': os.environ['PATH'], 'SANDBOX_HOME': home,
           'INSTALL_SHORTCUT': 'true', 'DEV_SANDBOX_NODE_DIR': override}
    result = subprocess.run(['bash', '-ceu', block + '\nprintf "%s" "$NODE_DIR"'],
                            env=env, text=True, capture_output=True, check=True, timeout=10)
    return result.stdout


@pytest.mark.parametrize('home', ['/home/hermes', '/root', '/home/custom user'])
@pytest.mark.parametrize('override', ['', '/nix/store/custom-node'])
def test_stage1_forwards_only_explicit_override(home: str, override: str) -> None:
    assert _stage1_selection(home, override) == override


def capture_stage2(tmp_path: Path, home: str, node_dir: str) -> list[str]:
    root = tmp_path / 'sandbox'
    for folder in ['root/logs', 'root/usr/local', 'root/usr/bin', 'root/bin',
                   'root/lib64', 'home', 'etc']:
        (root / folder).mkdir(parents=True, exist_ok=True)
    (root / 'root/logs/slirp.ready').write_text('1\n')
    capture = tmp_path / 'bwrap-args'
    tools = tmp_path / 'bin'
    tools.mkdir()
    bwrap = tools / 'bwrap'
    bwrap.write_text('#!/bin/sh\nprintf "%s\\0" "$@" > "$CAPTURE"\n')
    bwrap.chmod(0o755)
    env = {'PATH': f'{tools}:' + os.environ['PATH'], 'CAPTURE': str(capture),
           'DEV_SANDBOX_ROOT': str(root), 'DEV_SANDBOX_BASH': '/usr/bin/bash',
           'DEV_SANDBOX_INTERACTIVE': 'false', 'DEV_SANDBOX_USER': 'hermes',
           'DEV_SANDBOX_HOME': home, 'DEV_SANDBOX_NODE_DIR': node_dir}
    subprocess.run(['bash', str(STAGE2), 'true'], env=env, check=True,
                   text=True, capture_output=True, timeout=20)
    args = capture.read_bytes().rstrip(b'\0').decode().split('\0')
    assert '--unshare-pid' in args and '--clearenv' in args and '--die-with-parent' in args
    assert ('--bind', str(root / 'root/usr/local'), '/usr/local') in zip(args, args[1:], args[2:])
    return args


@pytest.mark.parametrize('home,node_dir,expected', [
    ('/home/hermes', '/usr/local', None),
    ('/home/hermes', '/usr', '/usr'),
    ('/home/hermes', '/opt/host-node', None),
    ('/home/hermes', '/home/other/node', None),
    ('/home/hermes', '/nix/store/nodejs-22', None),
    ('/home/hermes', '', None),
    ('/home/hermes', '/home/hermes/.hermes/node', '/home/hermes/.hermes/node'),
    ('/root', '/root/.hermes/node', '/root/.hermes/node'),
    ('/home/custom user', '/home/custom user/custom-node', '/home/custom user/custom-node'),
])
def test_host_runtime_header_handoff(tmp_path: Path, home: str, node_dir: str, expected: str | None) -> None:
    args = capture_stage2(tmp_path, home, node_dir)
    triplets = list(zip(args, args[1:], args[2:]))
    values = [value for option, key, value in triplets if (option, key) == ('--setenv', 'npm_config_nodedir')]
    assert values == ([] if expected is None else [expected])
    assert (('--setenv', 'DEV_SANDBOX_AUTO_NODE_HEADERS', '1') in triplets) == (expected is None)


def test_automatic_header_setup_runs_in_actual_payload_before_command(tmp_path: Path) -> None:
    args = capture_stage2(tmp_path, '/home/hermes', _stage1_selection('/home/hermes'))
    payload = args[args.index('-ceu') + 1]
    # Execute the exact preamble supplied to bwrap's payload Bash, not a rebuilt helper.
    preamble = payload.split('    python3 /work/proxy.py', 1)[0]
    env = {'PATH': os.environ['PATH'], 'DEV_SANDBOX_AUTO_NODE_HEADERS': '1',
           'npm_config_nodedir': '/nonexistent/stale-prefix'}
    result = subprocess.run(['bash', '-ceu', preamble + '\nprintf "%s" "${npm_config_nodedir:-}"'],
                            env=env, check=True, capture_output=True, text=True, timeout=10)
    expected = Path(subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()).parent.parent
    assert result.stdout == str(expected)


@pytest.mark.parametrize('node_dir,host_runtime,forward', [
    ('/nix/store/nodejs-22', 'false', True), ('/nix/store/nodejs-22', 'true', False),
    ('/usr', 'true', True), ('/usr', 'false', False),
])
def test_override_visibility_tracks_runtime(node_dir: str, host_runtime: str, forward: bool) -> None:
    block = function(STAGE2.read_text(), 'configure_node_env') + '\nconfigure_node_env\n'
    env = {'PATH': os.environ['PATH'], 'DEV_SANDBOX_HOME': '/home/hermes',
           'DEV_SANDBOX_NODE_DIR': node_dir, 'USE_HOST_RUNTIME': host_runtime}
    result = subprocess.run(['bash', '-ceu', block + '\nprintf "%s\\0" "${node_env[@]}"'],
                            env=env, check=True, capture_output=True, timeout=10)
    actual = result.stdout.rstrip(b'\0').decode().split('\0')
    assert actual == (['--setenv', 'npm_config_nodedir', node_dir] if forward else
                      ['--setenv', 'DEV_SANDBOX_AUTO_NODE_HEADERS', '1'])


def test_runtime_header_resolver_is_identical_at_both_boundaries() -> None:
    assert function(STAGE2.read_text(), 'configure_sandbox_node_headers') == function(
        (ROOT / 'scripts/install.sh').read_text(), 'configure_sandbox_node_headers')


@pytest.mark.parametrize('headers', ['matching', 'wrong-version', 'absent'])
def test_automatic_headers_require_matching_executing_node(tmp_path: Path, headers: str) -> None:
    original = Path(subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip())
    runtime = tmp_path / 'runtime'
    (runtime / 'bin').mkdir(parents=True)
    shutil.copy2(original, runtime / 'bin/node')
    if headers != 'absent':
        include = runtime / 'include/node'
        include.mkdir(parents=True)
        (include / 'common.gypi').write_text('{}\n')
        version = (original.parent.parent / 'include/node/node_version.h').read_text()
        if headers == 'wrong-version':
            version = re.sub(r'(#define NODE_MAJOR_VERSION\s+)\d+', r'\g<1>99', version)
        (include / 'node_version.h').write_text(version)
    helper = function(STAGE2.read_text(), 'configure_sandbox_node_headers')
    env = {'PATH': str(runtime / 'bin') + os.pathsep + os.environ['PATH'],
           'DEV_SANDBOX_AUTO_NODE_HEADERS': '1', 'npm_config_nodedir': '/stale'}
    result = subprocess.run(['bash', '-ceu', helper + '\nconfigure_sandbox_node_headers\nprintf "%s" "${npm_config_nodedir:-}"'],
                            env=env, check=True, capture_output=True, text=True, timeout=10)
    assert result.stdout == (str(runtime) if headers == 'matching' else '')
