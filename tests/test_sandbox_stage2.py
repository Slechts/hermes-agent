import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).parents[1]
NODE_HEADERS = REPO_ROOT / "scripts" / "sandbox" / "node-headers.sh"
STAGE2 = REPO_ROOT / "scripts" / "sandbox" / "stage2-run.sh"


def _run_node_headers_function(name: str, *args: str) -> str:
    result = subprocess.run(
        [
            "bash",
            "-ceu",
            'source "$1"; shift; "$@"',
            "node-headers-test",
            str(NODE_HEADERS),
            name,
            *args,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def _stage2_bwrap_args(tmp_path: Path, node_dir: str) -> list[str]:
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
            "DEV_SANDBOX_NODE_DIR": node_dir,
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

    return capture.read_bytes().rstrip(b"\0").decode().split("\0")


def _has_nodedir(args: list[str], expected: str) -> bool:
    return ("--setenv", "npm_config_nodedir", expected) in zip(
        args, args[1:], args[2:]
    )


def test_install_shortcut_targets_future_managed_node_headers() -> None:
    assert (
        _run_node_headers_function(
            "sandbox_select_node_dir", "", "true", "/home/hermes", "/usr"
        )
        == "/home/hermes/.hermes/node\n"
    )


def test_explicit_node_dir_takes_precedence_over_runtime_discovery() -> None:
    assert (
        _run_node_headers_function(
            "sandbox_select_node_dir",
            "/custom/node",
            "true",
            "/home/hermes",
            "/usr",
        )
        == "/custom/node\n"
    )


def test_header_prefix_visibility_matches_sandbox_mounts() -> None:
    assert (
        _run_node_headers_function(
            "sandbox_visible_node_headers",
            "/home/hermes",
            "/home/hermes/.hermes/node",
            "true",
        )
        == "/home/hermes/.hermes/node\n"
    )
    assert (
        _run_node_headers_function(
            "sandbox_visible_node_headers",
            "/home/hermes",
            "/nix/store/nodejs-22",
            "false",
        )
        == "/nix/store/nodejs-22\n"
    )
    assert (
        _run_node_headers_function(
            "sandbox_visible_node_headers",
            "/home/hermes",
            "/usr/local",
            "true",
        )
        == ""
    )


def test_stage2_does_not_inject_hidden_host_node_headers(tmp_path: Path) -> None:
    assert not _has_nodedir(_stage2_bwrap_args(tmp_path, "/usr/local"), "/usr/local")


def test_stage2_injects_managed_node_headers(tmp_path: Path) -> None:
    managed = "/home/hermes/.hermes/node"
    assert _has_nodedir(_stage2_bwrap_args(tmp_path, managed), managed)
