"""Exercise the real installer stage entry points, not source-text patterns."""
from __future__ import annotations

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
