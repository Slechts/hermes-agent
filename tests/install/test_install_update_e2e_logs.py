import os
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).with_name("install-update-e2e.sh")


def _collect_sandbox_logs_function() -> str:
    source = SCRIPT.read_text(encoding="utf-8")
    start = source.index("collect_sandbox_logs() {")
    end = source.index("# ── preflight", start)
    return source[start:end]


def test_collect_sandbox_logs_preserves_npm_debug_logs(tmp_path: Path) -> None:
    sandbox_root = tmp_path / "sandbox"
    npm_logs = sandbox_root / "home" / ".npm" / "_logs"
    npm_logs.mkdir(parents=True)
    (npm_logs / "debug-0.log").write_text("first causal npm failure\n", encoding="utf-8")
    log_dir = tmp_path / "artifacts"

    subprocess.run(
        ["bash", "-ceu", _collect_sandbox_logs_function() + "\ncollect_sandbox_logs install\n"],
        check=True,
        env={
            **os.environ,
            "SANDBOX_ROOT": str(sandbox_root),
            "LOG_DIR": str(log_dir),
        },
    )

    captured = log_dir / "sandbox-install" / "npm" / "debug-0.log"
    assert captured.read_text(encoding="utf-8") == "first causal npm failure\n"
