#!/usr/bin/env python3
"""Project-only uv configuration for the installer's isolated locked sync.

uv's --no-config also ignores [tool.uv], invalidating locks that record resolver
settings such as exclude-newer. Emit its configuration as explicit uv.toml while
leaving automatic user/system/ancestor discovery disabled. Python 3.11+ only;
the installer has already selected that interpreter before calling this helper.
"""
from __future__ import annotations

import datetime
import json
import sys
import tomllib
from pathlib import Path

# These are project metadata, not uv.toml configuration. uv still reads them
# from pyproject.toml with --no-config; copying them into uv.toml is rejected.
# https://docs.astral.sh/uv/reference/settings/#project-metadata
PROJECT_METADATA = frozenset({
    "build-constraint-dependencies", "conflicts", "constraint-dependencies",
    "default-groups", "dependency-groups", "dev-dependencies", "environments",
    "exclude-dependencies", "managed", "override-dependencies", "package",
    "required-environments", "sources", "build-backend", "workspace",
})


def _value(value: object) -> str:
    """Encode values produced by tomllib, including nested inline tables."""
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{_value(key)} = {_value(item)}" for key, item in value.items()) + " }"
    raise ValueError(f"Unsupported TOML value: {type(value).__name__}")


def project_config(source: Path) -> str:
    with source.open("rb") as stream:
        config = tomllib.load(stream).get("tool", {}).get("uv", {})
    if not isinstance(config, dict):
        raise ValueError("[tool.uv] must be a table")
    # Build completely before printing: a parse/encoding failure cannot leave
    # a partial config that changes the solver's meaning.
    return "".join(f"{_value(key)} = {_value(value)}\n" for key, value in config.items()
                   if key not in PROJECT_METADATA)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: uv_project_config.py PYPROJECT")
    sys.stdout.write(project_config(Path(sys.argv[1])))
