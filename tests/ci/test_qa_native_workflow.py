from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/qa-native-candidate.yml"

BRANCH = "qa/electron42-native-20260907"
SOURCE_SHA = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5"
BASE_SHA = "29112bef099274229cadff79cdff7bf7b99c4b77"
CHECKOUT_SHA = "de0fac2e4500dabe0009e67214ff5f5447ce83dd"
SETUP_NODE_SHA = "249970729cb0ef3589644e2896645e5dc5ba9c38"
UPLOAD_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"

EXPECTED_GATE = (
    "github.repository == 'Slechts/hermes-agent' && "
    "github.event_name == 'push' && "
    f"github.ref == 'refs/heads/{BRANCH}' && "
    "github.sha == github.event.after"
)


class _Yaml12SafeLoader(yaml.SafeLoader):
    """Keep ``on`` a string while retaining real YAML booleans."""


_Yaml12SafeLoader.yaml_implicit_resolvers = {
    first_char: list(resolvers)
    for first_char, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}

for first_char, resolvers in list(_Yaml12SafeLoader.yaml_implicit_resolvers.items()):
    _Yaml12SafeLoader.yaml_implicit_resolvers[first_char] = [
        resolver
        for resolver in resolvers
        if resolver[0] != "tag:yaml.org,2002:bool"
    ]

_Yaml12SafeLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|false)$", re.IGNORECASE),
    list("tTfF"),
)


def _load_workflow() -> dict[str, Any]:
    return yaml.load(WORKFLOW.read_text(encoding="utf-8"), Loader=_Yaml12SafeLoader)


def _all_steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    return job.get("steps", [])


def _find_step(job: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((step for step in _all_steps(job) if step.get("name") == name), None)


def _walk(value: Any):
    yield value
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def validate_workflow(document: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if document.get("name") != "QA Native Candidate":
        errors.append("workflow name must be unique and exact")

    if document.get("on") != {"push": {"branches": [BRANCH]}}:
        errors.append("trigger must be the single exact push branch")

    if document.get("permissions") != {"contents": "read"}:
        errors.append("global permissions must be contents: read only")

    jobs = document.get("jobs", {})
    if set(jobs) != {"preflight", "native-desktop", "update", "installer"}:
        errors.append("jobs must be preflight, native-desktop, update, and installer")
        return errors

    preflight = jobs["preflight"]
    if preflight.get("if") != EXPECTED_GATE:
        errors.append("preflight must bind repository, push, exact branch, and event SHA")
    if preflight.get("runs-on") != "ubuntu-24.04":
        errors.append("preflight must use the standard ubuntu-24.04 runner")
    if preflight.get("timeout-minutes") != 10:
        errors.append("preflight timeout must be explicit and bounded")

    for job_name in ("native-desktop", "update", "installer"):
        if jobs[job_name].get("needs") != "preflight":
            errors.append(f"{job_name} must depend on the gated preflight")

    native = jobs["native-desktop"]
    if native.get("timeout-minutes") != 45:
        errors.append("native job timeout must be explicit and bounded")
    if native.get("runs-on") != "${{ matrix.runner }}":
        errors.append("native job must select the runner from the fixed matrix")
    strategy = native.get("strategy", {})
    if strategy.get("fail-fast") is not False:
        errors.append("native matrix must set fail-fast: false")
    expected_matrix = [
        {"os": "linux", "runner": "ubuntu-24.04", "arch": "x64"},
        {"os": "windows", "runner": "windows-2025", "arch": "x64"},
        {"os": "macos", "runner": "macos-15", "arch": "arm64"},
    ]
    if strategy.get("matrix") != {"include": expected_matrix}:
        errors.append("native matrix must contain only the three standard native runners")

    checkout_uses = f"actions/checkout@{CHECKOUT_SHA}"
    setup_node_uses = f"actions/setup-node@{SETUP_NODE_SHA}"
    upload_uses = f"actions/upload-artifact@{UPLOAD_SHA}"
    allowed_actions = {checkout_uses, setup_node_uses, upload_uses}
    action_uses = [
        node
        for node in _walk(document)
        if isinstance(node, str) and node.startswith("actions/")
    ]
    if not action_uses or any(action not in allowed_actions for action in action_uses):
        errors.append("all first-party actions must use the approved full SHA pins")

    for job_name in ("preflight", "native-desktop"):
        checkout = next(
            (step for step in _all_steps(jobs[job_name]) if step.get("uses") == checkout_uses),
            None,
        )
        if checkout is None:
            errors.append(f"{job_name} must checkout with the approved pin")
        elif checkout.get("with") != {"persist-credentials": False, "fetch-depth": 0}:
            errors.append(f"{job_name} checkout must disable credentials and fetch full history")

    setup_node = next(
        (step for step in _all_steps(native) if step.get("uses") == setup_node_uses),
        None,
    )
    if setup_node is None:
        errors.append("native job must use the approved setup-node pin")
    elif setup_node.get("with") != {
        "node-version": "22.23.1",
        "package-manager-cache": False,
    }:
        errors.append("setup-node must pin Node 22.23.1 and disable action caching")

    npm_step = _find_step(native, "Install and verify locked dependencies")
    npm_run = str((npm_step or {}).get("run", ""))
    for contract in (
        "10.9.8",
        "npm ci",
        "npm audit",
        "npm ls",
        "support.mjs install-electron",
    ):
        if contract not in npm_run:
            errors.append(f"dependency step is missing fail-closed contract: {contract}")

    pack_step = _find_step(native, "Build unsigned unpacked Desktop bundle")
    pack_run = str((pack_step or {}).get("run", ""))
    if "run pack --workspace=apps/desktop" not in pack_run:
        errors.append("native job must pack Desktop on its own runner")
    if (pack_step or {}).get("env", {}).get("CSC_IDENTITY_AUTO_DISCOVERY") != "false":
        errors.append("pack step must explicitly disable signing discovery")

    smoke_step = _find_step(native, "Run packaged GUI smoke with loopback gateway")
    smoke_run = str((smoke_step or {}).get("run", ""))
    if "playwright.config.mjs" not in smoke_run or "xvfb-run" not in smoke_run:
        errors.append("native job must run the dedicated Playwright smoke and Linux Xvfb")
    forbidden_skip_tokens = ("--pass-with-no-tests", "--grep-invert", "test.skip", "|| true")
    if any(token in smoke_run for token in forbidden_skip_tokens):
        errors.append("native smoke must not skip or suppress failures")

    result_gate = _find_step(native, "Require complete non-flaky Playwright results")
    if "support.mjs check-results" not in str((result_gate or {}).get("run", "")):
        errors.append("native job must have a fail-closed Playwright results gate")

    linux_deps = _find_step(native, "Install Ubuntu GUI runtime dependencies")
    if (linux_deps or {}).get("if") != "matrix.os == 'linux'":
        errors.append("privileged GUI dependencies must be limited to the Linux runner")

    sandbox_helper = _find_step(native, "Configure packaged Linux sandbox helper")
    sandbox_run = str((sandbox_helper or {}).get("run", ""))
    if (sandbox_helper or {}).get("if") != "matrix.os == 'linux'":
        errors.append("sandbox helper privilege must be limited to the Linux runner")
    for contract in (
        "apps/desktop/release/linux-unpacked/chrome-sandbox",
        "sudo chown root:root",
        "sudo chmod 4755",
    ):
        if contract not in sandbox_run:
            errors.append(f"packaged Linux sandbox helper is missing contract: {contract}")

    privileged_steps = [
        step.get("name")
        for step in _all_steps(native)
        if "sudo " in str(step.get("run", ""))
    ]
    if privileged_steps != [
        "Install Ubuntu GUI runtime dependencies",
        "Configure packaged Linux sandbox helper",
    ]:
        errors.append("privilege must be confined to Ubuntu dependencies and chrome-sandbox")

    upload = next(
        (step for step in _all_steps(native) if step.get("uses") == upload_uses),
        None,
    )
    upload_with = (upload or {}).get("with", {})
    if (upload or {}).get("if") != "always()":
        errors.append("native evidence upload must run even after a failure")
    if upload_with.get("retention-days") != 7:
        errors.append("native QA artifacts must expire after seven days")
    artifact_name = str(upload_with.get("name", ""))
    for identity in ("github.sha", "matrix.os", "matrix.arch", "packaged-gui-smoke"):
        if identity not in artifact_name:
            errors.append(f"native artifact name must include {identity}")

    reusable = "./.github/workflows/install-e2e-run.yml"
    for route in ("update", "installer"):
        job = jobs[route]
        if job.get("uses") != reusable:
            errors.append(f"{route} must reuse install-e2e-run.yml")
        if job.get("with") != {
            "route": route,
            "install-ref": SOURCE_SHA,
            "runner": "ubuntu-24.04",
            "timeout-minutes": 45,
        }:
            errors.append(f"{route} must use the fixed source SHA and bounded Ubuntu runner")

    preflight_step = _find_step(preflight, "Validate fixed source and target metadata")
    preflight_run = str((preflight_step or {}).get("run", ""))
    preflight_env = (preflight_step or {}).get("env", {})
    if "support.mjs preflight" not in preflight_run:
        errors.append("preflight must call the metadata and ancestry helper")
    if preflight_env.get("QA_SOURCE_SHA") != SOURCE_SHA:
        errors.append("preflight source must be the fixed v2026.8.27 SHA")
    if preflight_env.get("QA_BASE_SHA") != BASE_SHA:
        errors.append("preflight base must be the fixed v2026.8.31 SHA")
    if preflight_env.get("QA_TARGET_SHA") != "${{ github.sha }}":
        errors.append("preflight target must be github.sha")

    flattened_strings = [node for node in _walk(document) if isinstance(node, str)]
    if any("secrets." in value or value == "inherit" for value in flattened_strings):
        errors.append("workflow must not consume or inherit secrets")
    if any(key == "continue-on-error" for key in _walk(document)):
        errors.append("workflow must not continue after errors")
    if any("retry" in value.lower() for value in flattened_strings):
        errors.append("workflow must not auto-retry")
    if any("--no-sandbox" in value for value in flattened_strings):
        errors.append("workflow must not bypass the Electron sandbox")

    return errors


def test_real_workflow_satisfies_native_candidate_policy() -> None:
    assert validate_workflow(_load_workflow()) == []


@pytest.mark.parametrize(
    ("mutate", "expected_error"),
    [
        (
            lambda doc: doc["on"].update({"pull_request": {}}),
            "trigger must be the single exact push branch",
        ),
        (
            lambda doc: doc["permissions"].update({"contents": "write"}),
            "global permissions must be contents: read only",
        ),
        (
            lambda doc: doc["jobs"]["update"].update({"secrets": "inherit"}),
            "workflow must not consume or inherit secrets",
        ),
        (
            lambda doc: doc["jobs"].pop("native-desktop"),
            "jobs must be preflight, native-desktop, update, and installer",
        ),
        (
            lambda doc: doc["jobs"]["native-desktop"]["strategy"]["matrix"]["include"][0].update(
                {"runner": "ubuntu-latest-32-core"}
            ),
            "native matrix must contain only the three standard native runners",
        ),
        (
            lambda doc: doc["jobs"]["update"]["with"].update({"install-ref": "main"}),
            "update must use the fixed source SHA and bounded Ubuntu runner",
        ),
        (
            lambda doc: doc["jobs"].pop("installer"),
            "jobs must be preflight, native-desktop, update, and installer",
        ),
        (
            lambda doc: doc["jobs"]["native-desktop"]["steps"].__setitem__(
                slice(None),
                [
                    step
                    for step in doc["jobs"]["native-desktop"]["steps"]
                    if step.get("name") != "Require complete non-flaky Playwright results"
                ],
            ),
            "native job must have a fail-closed Playwright results gate",
        ),
    ],
    ids=(
        "extra-event",
        "write-permission",
        "secrets-inherit",
        "native-skip",
        "larger-runner",
        "moving-ref",
        "installer-omitted",
        "results-gate-omitted",
    ),
)
def test_policy_rejects_dangerous_mutations(mutate, expected_error: str) -> None:
    document = copy.deepcopy(_load_workflow())
    mutate(document)
    assert expected_error in validate_workflow(document)
