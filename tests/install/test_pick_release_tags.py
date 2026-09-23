"""Exercise the real release selector against isolated Git histories."""

import json
import os
from pathlib import Path
import subprocess

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]
SELECTOR = ROOT / "scripts/sandbox/pick-release-tags.sh"
pytestmark = pytest.mark.linux_only


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True,
        text=True, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                        "GIT_CONFIG_NOSYSTEM": "1"},
    ).stdout.strip()


def commit(repo: Path, message: str, version: str = "0.21.0", release_date: str = "2026.8.31") -> str:
    metadata = repo / "hermes_cli/__init__.py"
    metadata.parent.mkdir(exist_ok=True)
    metadata.write_text(f'__version__ = "{version}"\n__release_date__ = "{release_date}"\n')
    git(repo, "add", "hermes_cli/__init__.py")
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def history(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    commit(repo, "oldest", "0.2.0", "2026.3.12")
    git(repo, "tag", "v2026.3.12")
    commit(repo, "older", "0.19.0", "2026.8.3")
    git(repo, "tag", "v2026.8.3")
    target = commit(repo, "target", "0.20.0", "2026.8.26")
    git(repo, "tag", "v2026.8.26")
    commit(repo, "newer release")
    git(repo, "tag", "v2026.8.31")
    git(repo, "checkout", "--detach", target)
    return repo, target


def select(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SELECTOR), "--repo", str(repo), *args],
        text=True, capture_output=True, timeout=10, cwd=repo,
    )


def test_default_target_excludes_newer_release_before_sampling(history) -> None:
    repo, _ = history
    result = select(repo, "--count", "1")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["v2026.8.26"]
    assert "v2026.8.31" in result.stderr
    assert "newer than target" in result.stderr


def test_explicit_target_retains_older_and_equal_releases(history) -> None:
    repo, target = history
    result = select(repo, "--target", target, "--count", "5")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["v2026.3.12", "v2026.8.3", "v2026.8.26"]


def test_newer_divergent_release_is_not_mistaken_for_an_upgrade_source(history) -> None:
    repo, target = history
    git(repo, "checkout", "--detach", "v2026.3.12")
    commit(repo, "divergent release")
    git(repo, "tag", "v2026.4.1")
    git(repo, "checkout", "--detach", target)
    result = select(repo, "--count", "5")
    assert result.returncode == 0, result.stderr
    assert "v2026.4.1" not in json.loads(result.stdout)
    assert "v2026.4.1" in result.stderr


def test_empty_compatible_selection_fails_without_a_matrix(history) -> None:
    repo, _ = history
    git(repo, "tag", "-d", "v2026.3.12", "v2026.8.3", "v2026.8.26")
    result = select(repo)
    assert result.returncode != 0
    assert result.stdout == ""
    assert "no release tags compatible" in result.stderr


@pytest.mark.parametrize("target", ["missing-target", "", "--all"])
def test_unresolvable_target_fails_without_a_matrix(history, target) -> None:
    repo, _ = history
    result = select(repo, "--target", target)
    assert result.returncode != 0
    assert result.stdout == ""
    assert "target" in result.stderr


def test_shallow_history_fails_closed(history, tmp_path) -> None:
    repo, _ = history
    shallow = tmp_path / "shallow"
    subprocess.run(["git", "clone", "--depth=1", repo.as_uri(), str(shallow)],
                   check=True, capture_output=True)
    result = select(shallow)
    assert result.returncode != 0
    assert result.stdout == ""
    assert "complete history" in result.stderr


def test_annotated_tag_resolves_to_its_commit(history) -> None:
    repo, _ = history
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "tag", "-a", "v2026.8.26.1", "-m", "annotated")
    result = select(repo, "--count", "1")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["v2026.8.26.1"]


def test_workflow_binds_selection_to_run_sha_and_complete_history() -> None:
    workflow = yaml.safe_load((ROOT / ".github/workflows/install-e2e.yml").read_text())
    job = workflow["jobs"]["pick-releases"]
    checkout = next(step for step in job["steps"] if "actions/checkout@" in step.get("uses", ""))
    assert checkout["with"]["fetch-depth"] == 0
    picker = next(step for step in job["steps"] if step.get("id") == "pick")
    assert picker["env"]["TARGET_SHA"] == "${{ github.sha }}"
    assert picker["env"]["TAG_COUNT"] == "${{ inputs.tag-count || 5 }}"
    assert '--target "$TARGET_SHA"' in picker["run"]
    assert '--count "$TAG_COUNT"' in picker["run"]


def test_workflow_keeps_sparse_checkout_and_filters_upstream_fetch() -> None:
    workflow = yaml.safe_load((ROOT / ".github/workflows/install-e2e.yml").read_text())
    job = workflow["jobs"]["pick-releases"]
    checkout = next(step for step in job["steps"] if "actions/checkout@" in step.get("uses", ""))
    # checkout@v6 explicitly makes filter override sparse-checkout. Supplying
    # both hydrates the whole tree, despite the apparently narrow path.
    assert "filter" not in checkout["with"]
    assert checkout["with"]["sparse-checkout"] == "scripts/sandbox/pick-release-tags.sh"
    assert checkout["with"]["sparse-checkout-cone-mode"] is False
    upstream = next(step for step in job["steps"] if step.get("name") == "Fetch canonical upstream release tags")
    assert "git fetch --filter=blob:none --force --no-tags" in upstream["run"]
    assert "https://github.com/NousResearch/hermes-agent.git" in upstream["run"]
    assert "'+refs/tags/v*:refs/tags/v*'" in upstream["run"]
    assert "--depth" not in upstream["run"]
    assert job["timeout-minutes"] == 5


def test_upstream_metadata_is_lazy_fetched_when_origin_fork_lacks_it(history, tmp_path) -> None:
    upstream, _ = history
    git(upstream, "config", "uploadpack.allowFilter", "true")
    fork = tmp_path / "fork"
    fork.mkdir()
    git(fork, "init", "-q")
    target = commit(fork, "independent fork target", "0.20.0", "2026.8.26")
    git(fork, "config", "uploadpack.allowFilter", "true")
    oldest_blob = git(upstream, "rev-parse", "v2026.3.12:hermes_cli/__init__.py")
    absent = subprocess.run(["git", "-C", str(fork), "cat-file", "-e", oldest_blob], capture_output=True)
    assert absent.returncode != 0, "fixture origin must not contain upstream metadata"
    consumer = tmp_path / "consumer"
    subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", fork.as_uri(), str(consumer)],
                   check=True, capture_output=True)
    workflow = yaml.safe_load((ROOT / ".github/workflows/install-e2e.yml").read_text())
    fetch_step = next(step for step in workflow["jobs"]["pick-releases"]["steps"]
                      if step.get("name") == "Fetch canonical upstream release tags")
    command = fetch_step["run"].replace("https://github.com/NousResearch/hermes-agent.git", upstream.as_uri())
    fetched = subprocess.run(["bash", "-euo", "pipefail", "-c", command], cwd=consumer,
                             capture_output=True, text=True, timeout=20)
    assert fetched.returncode == 0, fetched.stderr
    # Prove this exercises lazy fetching, not an eager server that ignored the
    # filter: the upstream-only blob must still be absent from local packs.
    pack_dump = "\n".join(git(consumer, "verify-pack", "-v", str(index))
                          for index in (consumer / ".git/objects/pack").glob("*.idx"))
    assert not any(line.split()[0] == oldest_blob for line in pack_dump.splitlines() if line)
    result = select(consumer, "--target", target, "--count", "5")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["v2026.3.12", "v2026.8.3", "v2026.8.26"]


def test_older_backport_remains_eligible_without_git_ancestry(history) -> None:
    repo, target = history
    git(repo, "checkout", "--detach", "v2026.3.12")
    commit(repo, "supported backport", "0.15.2", "2026.5.29.2")
    git(repo, "tag", "v2026.5.29.2")
    git(repo, "checkout", "--detach", target)
    result = select(repo, "--count", "10")
    assert result.returncode == 0, result.stderr
    assert "v2026.5.29.2" in json.loads(result.stdout)


def test_same_version_with_newer_release_date_is_excluded(history) -> None:
    repo, target = history
    commit(repo, "same version later release", "0.20.0", "2026.8.27")
    git(repo, "tag", "v2026.8.27")
    result = select(repo, "--target", target, "--count", "99")
    assert result.returncode == 0, result.stderr
    assert "v2026.8.27" not in json.loads(result.stdout)


@pytest.mark.parametrize("metadata", [
    "__version__ = 'invalid'\n__release_date__ = '2026.8.27'\n",
    "__version__ = '0.20.0'\n__release_date__ = '2026.13.27'\n",
    "__version__ = '0.20.0'\n",
    "__version__ = '0.20.0'\n__version__ = '0.1.0'\n__release_date__ = '2026.8.27'\n",
    "__version__ = __import__('pathlib').Path('EXECUTED').touch()\n__release_date__ = '2026.8.27'\n",
])
def test_invalid_metadata_fails_closed_without_execution_or_partial_matrix(history, metadata) -> None:
    repo, target = history
    (repo / "hermes_cli/__init__.py").write_text(metadata)
    git(repo, "add", "hermes_cli/__init__.py")
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "-c", "commit.gpgsign=false", "commit", "-qm", "invalid release metadata fixture")
    git(repo, "tag", "v2026.8.30")
    result = select(repo, "--target", target)
    assert result.returncode != 0
    assert not result.stdout.strip()
    assert not (repo / "EXECUTED").exists()
    assert "cannot select upgrade sources" in result.stderr


def test_sampling_keeps_oldest_and_newest_compatible_endpoints(history) -> None:
    repo, target = history
    result = select(repo, "--target", target, "--count", "2")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == ["v2026.3.12", "v2026.8.26"]
