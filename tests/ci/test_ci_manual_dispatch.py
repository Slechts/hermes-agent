"""Manual CI recovery must retain the ordinary post-merge classifier coverage."""

import os
from pathlib import Path
import subprocess
import sys

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]

# BaseLoader constructs only strings/containers, not Python objects; it also
# preserves the Actions "on" key instead of coercing it to a YAML 1.1 boolean.


def test_ci_accepts_manual_runs_without_inputs() -> None:
    workflow = yaml.load(
        (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    triggers = workflow["on"]

    assert "workflow_dispatch" in triggers, "CI must support a fresh manual recovery run"
    assert triggers["workflow_dispatch"] in ("", {})
    assert "pull_request" in triggers
    assert triggers["push"]["branches"] == ["main"]


@pytest.mark.parametrize("event_name", ["push", "workflow_dispatch"])
def test_full_validation_events_preserve_postmerge_lanes(tmp_path: Path, event_name: str) -> None:
    action = yaml.load(
        (ROOT / ".github/actions/detect-changes/action.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    script = next(step["run"] for step in action["runs"]["steps"] if step.get("id") == "classify")
    output = tmp_path / "github-output"
    result = subprocess.run(
        ["bash", "-c", script],
        cwd=ROOT,
        env={
            "PATH": os.pathsep.join((str(Path(sys.executable).parent), os.defpath)),
            "HOME": str(tmp_path),
            "EVENT_NAME": event_name,
            "GITHUB_OUTPUT": str(output),
        },
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    outputs = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines())
    assert set(outputs) == set(action["outputs"])
    assert outputs["ci_review_files"] == "[]"
    # The existing classifier intentionally excludes MCP-catalog review unless
    # those files changed; manual recovery must preserve that push behaviour.
    assert outputs["mcp_catalog"] == "false"
    assert all(
        value == "true"
        for name, value in outputs.items()
        if name not in {"ci_review_files", "mcp_catalog"}
    )
