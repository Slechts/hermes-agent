"""Exercise the real installer stage entry points, not source-text patterns."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "scripts" / "install.sh"
pytestmark = pytest.mark.linux_only


def environment(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    home = tmp_path / "home"
    home.mkdir()
    project = home / "project"
    project.mkdir()
    env = {"PATH": os.environ["PATH"], "HOME": str(home),
           "HERMES_HOME": str(home / ".hermes"),
           "HERMES_INSTALL_DIR": str(project), "LANG": "C.UTF-8",
           "UV_OFFLINE": "1", "UV_CACHE_DIR": str(tmp_path / "cache"),
           "UV_PYTHON_DOWNLOADS": "never", "XDG_CONFIG_HOME": str(home / ".config")}
    return project, env


def run_stage(stage: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(INSTALLER), "--stage", stage,
                           "--skip-browser", "--non-interactive"],
                          env=env, text=True, capture_output=True, timeout=30)


def test_locked_python_stage_uses_only_project_configuration(tmp_path: Path) -> None:
    project, env = environment(tmp_path)
    uv = shutil.which("uv")
    assert uv, "real uv is required for this behavioral regression"
    (project / "pyproject.toml").write_text(
        '[project]\nname="installer-lock-fixture"\nversion="0.0.0"\n'
        'requires-python=">=3.11"\ndependencies=[]\n'
        '[project.optional-dependencies]\nall=[]\n'
        '[tool.uv]\npackage=false\nexclude-newer="14 days"\n')
    subprocess.run([uv, "lock", "--offline", "--project", str(project),
                    "--python", sys.executable], env=env, check=True, capture_output=True)
    locked = (project / "uv.lock").read_bytes()
    subprocess.run([uv, "venv", str(project / "venv"), "--python", sys.executable],
                   env=env, check=True, capture_output=True)
    managed = Path(env["HERMES_HOME"]) / "bin"
    managed.mkdir(parents=True)
    (managed / "uv").symlink_to(uv)
    helper = ROOT / "scripts" / "uv_project_config.py"
    if helper.exists():
        (project / "scripts").mkdir()
        shutil.copy2(helper, project / "scripts" / helper.name)
    # Invalid ancestor/user configuration must never be discovered by uv.
    home = Path(env["HOME"])
    (home / "uv.toml").write_text("not valid toml [[[\n")
    user_config = home / ".config" / "uv"
    user_config.mkdir(parents=True)
    (user_config / "uv.toml").write_text("not valid user config [[[\n")
    result = run_stage("python-deps", env)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "hash-verified via uv.lock" in output, output
    assert "falling back to PyPI" not in output, output
    assert (project / "uv.lock").read_bytes() == locked


@pytest.mark.parametrize("npm_exit", [0, 42])
def test_node_stages_report_actual_dependency_outcome(tmp_path: Path, npm_exit: int) -> None:
    project, env = environment(tmp_path)
    (project / "package.json").write_text('{}\n')
    (project / "ui-tui").mkdir()
    (project / "ui-tui" / "package.json").write_text('{}\n')
    tools = tmp_path / "bin"
    tools.mkdir()
    npm = tools / "npm"
    npm.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then printf "10.9.9\\n"; exit 0; fi\n'
                   'if [ "$1" != "install" ]; then exit 99; fi\n'
                   'mkdir -p "$HOME/.npm/_logs"\n'
                   'printf "fixture npm detail\\n" > "$HOME/.npm/_logs/debug.log"\n'
                   'printf "dependency diagnostic\\n" >&2\n'
                   f'exit {npm_exit}\n')
    npm.chmod(0o755)
    env["PATH"] = str(tools) + os.pathsep + env["PATH"]
    # Compose the actual installer stage with the actual E2E log collector.
    # Only npm is a deliberate exit-code fixture; this is not hosted sandbox E2E.
    harness = (ROOT / "tests/install/install-update-e2e.sh").read_text()
    blocks = []
    for name in ("collect_sandbox_logs", "run_in_sandbox_logged"):
        found = re.search(rf"(?ms)^{name}\(\) \{{\n.*?^\}}", harness)
        assert found, name
        blocks.append(found[0])
    env.update(SANDBOX_ROOT=str(tmp_path), LOG_DIR=str(tmp_path / "logs"),
               FIXTURE_INSTALLER=str(INSTALLER))
    Path(env["LOG_DIR"]).mkdir()
    script = "set -euo pipefail\n" + "\n".join(blocks) + '''
    in_sandbox() { bash "$FIXTURE_INSTALLER" --stage node-deps --skip-browser --non-interactive; }
    run_in_sandbox_logged 'fixture node stage' install
    '''
    result = subprocess.run(["bash", "-c", script], env=env, text=True,
                            capture_output=True, timeout=30)
    output = result.stdout + result.stderr
    # Browser/TUI dependencies remain optional: do not make the CLI uninstallable.
    assert result.returncode == 0, output
    assert "dependency diagnostic" in output
    for message in ("Node.js dependencies installed", "TUI dependencies installed"):
        assert (message in output) == (npm_exit == 0), output
    assert ("npm install failed or timed out" in output) == (npm_exit != 0)
    saved = Path(env["LOG_DIR"])
    assert (saved / "sandbox-install/npm/debug.log").read_text() == "fixture npm detail\n"
    assert "dependency diagnostic" in (saved / "install.log").read_text()


@pytest.mark.parametrize("monorepo", [True, False])
def test_real_npm_installs_browser_and_tui_without_desktop(tmp_path: Path, monorepo: bool) -> None:
    """Execute real npm lifecycle scripts; Desktop must never be selected."""
    assert shutil.which("npm"), "real npm required for workspace regression"
    project, env = environment(tmp_path)
    events = tmp_path / "lifecycle.jsonl"
    env.update(HERMES_FIXTURE_EVENTS=str(events), npm_config_offline="true",
               npm_config_audit="false", npm_config_fund="false",
               npm_config_registry="http://127.0.0.1:9",
               npm_config_foreground_scripts="true")

    def package(folder: Path, name: str, fail: bool = False) -> dict:
        folder.mkdir(parents=True, exist_ok=True)
        script = ("require('fs').appendFileSync(process.env.HERMES_FIXTURE_EVENTS, "
                  + json.dumps(name + "\n") + ");"
                  + ("process.exit(42);" if fail else ""))
        manifest = {"name": name, "version": "1.0.0", "private": True,
                    "scripts": {"postinstall": "node -e '" + script.replace("'", '"') + "'"}}
        (folder / "package.json").write_text(json.dumps(manifest))
        return manifest

    root = package(project, "fixture-root")
    package(project / "browser-tools", "fixture-browser")
    package(project / "ui-tui", "fixture-tui")
    package(project / "apps/desktop", "fixture-desktop", fail=True)
    root["dependencies"] = {"fixture-browser": "file:./browser-tools"}
    if monorepo:
        root["workspaces"] = ["ui-tui", "apps/*"]
    (project / "package.json").write_text(json.dumps(root))
    result = run_stage("node-deps", env)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    selected = events.read_text().splitlines()
    assert "fixture-desktop" not in selected, (selected, output)
    assert {"fixture-root", "fixture-browser", "fixture-tui"} <= set(selected), (selected, output)
    assert (project / "node_modules/fixture-browser/package.json").is_file()
    assert "Node.js dependencies installed" in output, output
    assert "TUI dependencies installed" in output, output
    assert "npm install failed or timed out" not in output, output


@pytest.mark.parametrize("automatic", [True, False])
@pytest.mark.parametrize("stale_exists", [True, False])
def test_node_stage_uses_executing_runtime_headers(tmp_path: Path, automatic: bool, stale_exists: bool) -> None:
    project, env = environment(tmp_path)
    (project / "package.json").write_text('{}\n')
    actual = Path(subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()).parent.parent
    assert (actual / 'include/node/common.gypi').is_file(), 'runtime headers required for this regression'
    stale = Path(env['HERMES_HOME']) / 'node'
    if stale_exists:
        (stale / 'include/node').mkdir(parents=True)
        (stale / 'include/node/common.gypi').write_text('{}\n')
        (stale / 'include/node/node_version.h').write_text('#define NODE_MAJOR_VERSION 99\n')
    tools = tmp_path / 'tools'
    tools.mkdir()
    capture = tmp_path / 'npm-headers'
    npm = tools / 'npm'
    npm.write_text('#!/bin/sh\nif [ "$1" = --version ]; then printf "10.9.9\\n"; exit 0; fi\n'
                   'printf "%s" "${npm_config_nodedir:-}" > "$HEADER_CAPTURE"\n')
    npm.chmod(0o755)
    env.update(PATH=str(tools) + os.pathsep + env['PATH'], HEADER_CAPTURE=str(capture),
               npm_config_nodedir=str(stale), DEV_SANDBOX_AUTO_NODE_HEADERS='1' if automatic else '0')
    result = run_stage('node-deps', env)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'Node.js v' in result.stdout and 'found' in result.stdout
    assert capture.read_text() == str(actual if automatic else stale)


def test_locked_stage_keeps_project_overrides_sources_and_constraints(tmp_path: Path) -> None:
    """Real offline uv must select v2 despite the project's v1 requirement."""
    project, env = environment(tmp_path)
    uv = shutil.which("uv")
    assert uv, "real uv is required for this behavioral regression"
    wheel = project / "uv_review_dep-2.0.0-py3-none-any.whl"
    dist = "uv_review_dep-2.0.0.dist-info"
    members = {
        "uv_review_dep.py": "VALUE = 2\n",
        f"{dist}/METADATA": "Metadata-Version: 2.3\nName: uv-review-dep\nVersion: 2.0.0\n",
        f"{dist}/WHEEL": "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    members[f"{dist}/RECORD"] = "".join(f"{name},,\n" for name in members) + f"{dist}/RECORD,,\n"
    with zipfile.ZipFile(wheel, "w") as archive:
        for name, text in members.items():
            archive.writestr(name, text)
    (project / "pyproject.toml").write_text(
        '[project]\nname="metadata-fixture"\nversion="0.0.0"\nrequires-python=">=3.11"\n'
        'dependencies=["uv-review-dep==1.0.0"]\n[project.optional-dependencies]\nall=[]\n'
        '[tool.uv]\npackage=false\nexclude-newer="14 days"\n'
        'override-dependencies=["uv-review-dep==2.0.0"]\n'
        'constraint-dependencies=["uv-review-dep<3"]\n'
        'build-constraint-dependencies=["setuptools<76"]\n'
        '[tool.uv.sources]\nuv-review-dep={path="./' + wheel.name + '"}\n')
    subprocess.run([uv, "lock", "--offline", "--project", str(project),
                    "--python", sys.executable], env=env, check=True, capture_output=True)
    locked = (project / "uv.lock").read_bytes()
    manifest = tomllib.loads(locked.decode())["manifest"]
    assert manifest["overrides"] and manifest["constraints"] and manifest["build-constraints"]
    subprocess.run([uv, "venv", str(project / "venv"), "--python", sys.executable],
                   env=env, check=True, capture_output=True)
    managed = Path(env["HERMES_HOME"]) / "bin"
    managed.mkdir(parents=True)
    (managed / "uv").symlink_to(uv)
    (project / "scripts").mkdir()
    shutil.copy2(ROOT / "scripts/uv_project_config.py", project / "scripts")
    result = run_stage("python-deps", env)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "hash-verified via uv.lock" in output, output
    assert "falling back to PyPI" not in output, output
    assert (project / "uv.lock").read_bytes() == locked
    imported = subprocess.run([str(project / "venv/bin/python"), "-c",
                               "import uv_review_dep; print(uv_review_dep.VALUE)"],
                              env=env, capture_output=True, text=True, check=True)
    assert imported.stdout.strip() == "2"
