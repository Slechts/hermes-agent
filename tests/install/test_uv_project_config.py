"""The explicit uv config must be semantically identical, not source-shaped."""
from __future__ import annotations
import subprocess
import sys
import tomllib
from pathlib import Path
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "uv_project_config.py"

@pytest.mark.parametrize("config", [
    'exclude-newer="14 days"\n',
    'concurrent-downloads=3\n[tool.uv.exclude-newer-package]\n"quoted.name"=false\n',
    'index=[{name="local",url="https://example.invalid/simple",default=true}]\n',
    'exclude-newer=2026-08-03T00:00:00Z\n',
    'cache-keys=[{file="pyproject.toml"}, {git={commit=true,tags=true}}]\n',
    '[[tool.uv.index]]\nname="fixture"\nurl="https://example.invalid/a?x=1&y=2"\n',
    'config-settings={"demo"="quoted \'value\'"}\n',
])
def test_project_configuration_round_trips(tmp_path: Path, config: str) -> None:
    text = '[project]\nname="fixture"\nversion="1"\n[tool.uv]\n' + config
    source = tmp_path / "pyproject.toml"
    source.write_text(text)
    result = subprocess.run([sys.executable, str(SCRIPT), str(source)],
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert tomllib.loads(result.stdout) == tomllib.loads(text)["tool"]["uv"]


def test_missing_uv_table_does_not_discover_ancestor_config(tmp_path: Path) -> None:
    source = tmp_path / "pyproject.toml"
    source.write_text('[project]\nname="fixture"\nversion="1"\n')
    (tmp_path / "uv.toml").write_text('index-url="https://untrusted.invalid"\n')
    result = subprocess.run([sys.executable, str(SCRIPT), str(source)],
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert tomllib.loads(result.stdout) == {}


def test_project_metadata_is_left_for_uv_to_read_from_pyproject(tmp_path: Path) -> None:
    source = tmp_path / "pyproject.toml"
    source.write_text('[tool.uv]\npackage=false\nexclude-newer="14 days"\n'
                      'override-dependencies=["pynacl>=1.6,<1.7"]\n'
                      '[tool.uv.sources]\nlocal={path="./local"}\n')
    result = subprocess.run([sys.executable, str(SCRIPT), str(source)],
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert tomllib.loads(result.stdout) == {"exclude-newer": "14 days"}


@pytest.mark.parametrize("text", ['[tool.uv\n', '[tool]\nuv="not a table"\n'])
def test_invalid_config_is_rejected_without_partial_output(tmp_path: Path, text: str) -> None:
    source = tmp_path / "pyproject.toml"
    source.write_text(text)
    result = subprocess.run([sys.executable, str(SCRIPT), str(source)],
                            text=True, capture_output=True, timeout=10)
    assert result.returncode != 0
    assert result.stdout == ""
