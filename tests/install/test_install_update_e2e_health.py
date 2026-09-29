"""Behavioral harness contracts; sandbox calls are unit-test doubles, not E2E."""
import os
import re
import subprocess
from pathlib import Path
import pytest

SCRIPT = Path(__file__).with_name("install-update-e2e.sh")


def functions(*names: str) -> str:
    source = SCRIPT.read_text()
    blocks = []
    for name in names:
        found = re.search(rf"(?ms)^{name}\(\) \{{\n.*?^\}}", source)
        assert found, f"required harness function absent: {name}"
        blocks.append(found[0])
    return "\n".join(blocks)


def run(code: str, root: Path, **extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", "set -euo pipefail\n" + code],
        env={**os.environ, "SANDBOX_ROOT": str(root / "sandbox"),
             "LOG_DIR": str(root / "logs"), **extra},
        text=True, capture_output=True, timeout=20)


@pytest.mark.parametrize("present", [True, False])
def test_large_installer_probe_drains_pipe_without_sigpipe(tmp_path: Path, present: bool) -> None:
    fixture = tmp_path / "installer.sh"
    fixture.write_text(("--skip-browser\n" if present else "absent\n") + "# large installer\n" * 50000)
    code = functions("installer_supports") + '''
    git() { if [ "$1" = show ]; then cat "$FIXTURE"; else return 1; fi; }
    installer_supports origin --skip-browser
    '''
    result = run(code, tmp_path, FIXTURE=str(fixture))
    assert result.returncode == (0 if present else 1), result.stderr


@pytest.mark.parametrize("mode", ["success", "failure", "missing-marker"])
def test_install_always_preserves_logs(tmp_path: Path, mode: str) -> None:
    (tmp_path / "logs").mkdir()
    code = functions("collect_sandbox_logs", "install_in_sandbox") + '''
    ok() { :; }
    fail() { echo "$*" >&2; exit 1; }
    fake_sandbox() {
      mkdir -p "$SANDBOX_ROOT/root/logs" "$SANDBOX_ROOT/home/.npm/_logs"
      printf 'proxy fixture\n' > "$SANDBOX_ROOT/root/logs/proxy.log"
      printf 'npm fixture\n' > "$SANDBOX_ROOT/home/.npm/_logs/debug.log"
      case "$MODE" in success) echo 'Installation Complete';;
        failure) echo 'install failed'; return 42;; *) echo 'incomplete';; esac
    }
    SANDBOX=(fake_sandbox)
    install_in_sandbox fixture '' install
    '''
    result = run(code, tmp_path, MODE=mode)
    assert result.returncode == (0 if mode == "success" else 1), result.stderr
    saved = tmp_path / "logs/sandbox-install"
    assert (saved / "npm/debug.log").read_text() == "npm fixture\n"
    assert (saved / "proxy.log").read_text() == "proxy fixture\n"


@pytest.mark.parametrize("status", [0, 42])
def test_logged_sandbox_operation_preserves_transcript_and_diagnostics(tmp_path: Path, status: int) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    npm = tmp_path / "sandbox/home/.npm/_logs"
    npm.mkdir(parents=True)
    (npm / "debug.log").write_text("update npm fixture\n")
    # Exercise the generic production capture boundary with a harmless fixture
    # command. Do not bypass the canonical live-updater guard to test logging.
    code = functions("collect_sandbox_logs", "run_in_sandbox_logged") + '''
    in_sandbox() { echo 'update transcript fixture'; return "$STATUS"; }
    run_in_sandbox_logged 'fixture operation' update
    '''
    result = run(code, tmp_path, STATUS=str(status))
    assert result.returncode == status, result.stderr
    assert (logs / "update.log").read_text() == "update transcript fixture\n"
    assert (logs / "sandbox-update/npm/debug.log").read_text() == "update npm fixture\n"


def test_update_route_uses_logged_sandbox_boundary() -> None:
    source = SCRIPT.read_text()
    assert 'run_in_sandbox_logged "cd $INSTALL_DIR && $update_cmd" update' in source


@pytest.mark.parametrize("unmerged", ["", "package-lock.json"])
def test_unmerged_checkout_is_not_healthy(tmp_path: Path, unmerged: str) -> None:
    code = functions("require_no_unmerged_paths") + '''
    INSTALL_DIR=/fixture
    fail() { echo "$*" >&2; exit 1; }
    ok() { :; }
    in_sandbox() { printf '%s' "$UNMERGED"; }
    require_no_unmerged_paths fixture
    '''
    result = run(code, tmp_path, UNMERGED=unmerged)
    assert result.returncode == (1 if unmerged else 0), result.stderr
    if unmerged:
        assert unmerged in result.stderr
