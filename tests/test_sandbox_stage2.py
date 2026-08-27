import os
import re
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).parents[1]
DEV_SANDBOX = REPO_ROOT / "scripts" / "dev-sandbox.sh"
STAGE2 = REPO_ROOT / "scripts" / "sandbox" / "stage2-run.sh"


def _extract_shell_function(source: str, name: str) -> str:
    match = re.search(rf"(?ms)^{re.escape(name)}\(\) \{{\n.*?^\}}\n", source)
    assert match is not None, f"missing shell function: {name}"
    return match.group(0)


def test_host_runtime_does_not_inject_host_node_headers(tmp_path: Path) -> None:
    root = tmp_path / "sandbox"
    (root / "root" / "logs").mkdir(parents=True)
    (root / "root" / "logs" / "slirp.ready").write_text("1\n")
    (root / "root" / "usr" / "local").mkdir(parents=True)
    (root / "root" / "usr" / "bin").mkdir(parents=True)
    (root / "root" / "bin").mkdir(parents=True)
    (root / "root" / "lib64").mkdir(parents=True)
    (root / "home").mkdir()
    (root / "etc").mkdir()

    capture = tmp_path / "bwrap-args"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_bwrap = fake_bin / "bwrap"
    fake_bwrap.write_text(
        "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" > \"$CAPTURE\"\n",
        encoding="utf-8",
    )
    fake_bwrap.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "CAPTURE": str(capture),
            "DEV_SANDBOX_ROOT": str(root),
            "DEV_SANDBOX_BASH": "/usr/bin/bash",
            "DEV_SANDBOX_INTERACTIVE": "false",
            "DEV_SANDBOX_USER": "hermes",
            "DEV_SANDBOX_HOME": "/home/hermes",
            "DEV_SANDBOX_NODE_DIR": "/usr/local",
            "DEV_SANDBOX_ELECTRON_LD_LIBRARY_PATH": "",
            "DEV_SANDBOX_XDG_RUNTIME_DIR": "",
            "DEV_SANDBOX_WAYLAND_DISPLAY": "",
            "DEV_SANDBOX_WAYLAND_SOCKET": "",
        }
    )
    subprocess.run(
        ["bash", str(STAGE2), "true"],
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )

    args = capture.read_bytes().rstrip(b"\0").decode().split("\0")
    assert ("--setenv", "npm_config_nodedir", "/usr/local") not in zip(
        args, args[1:], args[2:]
    )


def test_install_shortcut_targets_future_managed_node_headers() -> None:
    source = DEV_SANDBOX.read_text(encoding="utf-8")
    function = _extract_shell_function(source, "configure_node_dir")
    command = f"""
set -euo pipefail
{function}
INSTALL_SHORTCUT=true
SANDBOX_HOME=/home/hermes
DEV_SANDBOX_NODE_DIR=
configure_node_dir
printf '%s\\n' "$NODE_DIR"
"""
    result = subprocess.run(
        ["bash", "-c", command],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout == "/home/hermes/.hermes/node\n"


def test_managed_node_headers_are_injected_after_install() -> None:
    source = STAGE2.read_text(encoding="utf-8")
    function = _extract_shell_function(source, "configure_node_env")
    command = f"""
set -euo pipefail
{function}
USE_HOST_RUNTIME=true
DEV_SANDBOX_HOME=/home/hermes
DEV_SANDBOX_NODE_DIR=/home/hermes/.hermes/node
configure_node_env
printf '%s\\n' "${{node_env[@]}}"
"""
    result = subprocess.run(
        ["bash", "-c", command],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout == (
        "--setenv\n"
        "npm_config_nodedir\n"
        "/home/hermes/.hermes/node\n"
    )


def test_nix_runtime_preserves_immutable_node_headers() -> None:
    source = STAGE2.read_text(encoding="utf-8")
    function = _extract_shell_function(source, "configure_node_env")
    command = f"""
set -euo pipefail
{function}
USE_HOST_RUNTIME=false
DEV_SANDBOX_HOME=/home/hermes
DEV_SANDBOX_NODE_DIR=/nix/store/nodejs-22
configure_node_env
printf '%s\\n' "${{node_env[@]}}"
"""
    result = subprocess.run(
        ["bash", "-c", command],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout == (
        "--setenv\n"
        "npm_config_nodedir\n"
        "/nix/store/nodejs-22\n"
    )
