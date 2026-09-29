"""Regression: installer autostash restore conflicts must not abort the run.

An interrupted/repeated managed install can leave local tracked edits in the
checkout. If upstream then changes the same lines, ``git stash apply`` conflicts
during the repository-update stage. Both installers must leave the stash intact
and complete the real repository stage. Bash additionally preserves staging;
the unchanged PowerShell behavior is tested separately, not claimed as parity.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"
POWERSHELL = next(
    (candidate for candidate in ("pwsh", "powershell") if shutil.which(candidate)),
    None,
)


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


def _make_conflicted_managed_checkout(tmp_path: Path) -> Path:
    """Create a managed checkout whose autostash conflicts with its origin."""
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init")
    (seed / "tracked.txt").write_text("base\n", encoding="utf-8")
    _git(seed, "add", "tracked.txt")
    _git(seed, "commit", "-m", "base")
    _git(seed, "branch", "-M", "main")

    remote = tmp_path / "origin.git"
    _git(tmp_path, "init", "--bare", str(remote))
    _git(seed, "remote", "add", "origin", str(remote))
    _git(seed, "push", "-u", "origin", "main")

    managed = tmp_path / "hermes-agent"
    _git(tmp_path, "clone", "--branch", "main", str(remote), str(managed))

    (managed / "tracked.txt").write_text("local edit\n", encoding="utf-8")

    upstream = tmp_path / "upstream"
    _git(tmp_path, "clone", "--branch", "main", str(remote), str(upstream))
    (upstream / "tracked.txt").write_text("upstream edit\n", encoding="utf-8")
    _git(upstream, "commit", "-am", "upstream")
    _git(upstream, "push", "origin", "main")

    return managed


def _assert_conflict_was_recovered(repo: Path, output: str, *, bash=False) -> None:
    if bash:
        saved = _git(repo, "rev-parse", "refs/stash").stdout.strip()
        assert "restoring local changes failed or hit conflicts" in output
        assert "Tracked files and index reset to HEAD; untracked files may remain." in output
        assert f"git stash apply --index {saved}" in output
    else:
        assert "restoring local changes hit conflicts" in output
        assert "Working tree reset to clean state." in output
        assert "Restore your changes later with: git stash apply stash@{0}" in output
    assert "Conflicted files:" in output
    assert "tracked.txt" in output
    assert _git(repo, "status", "--porcelain").stdout.strip() == ""
    assert _git(repo, "stash", "list").stdout.strip(), "stash must be preserved"
    content = (repo / "tracked.txt").read_text(encoding="utf-8")
    assert content == "upstream edit\n", content
    # No conflict markers must be left in tracked source — they would crash
    # the backend on import (SyntaxError on the <<<<<<< line).
    assert "<<<<<<<" not in content and ">>>>>>>" not in content


@pytest.mark.live_system_guard_bypass
@pytest.mark.skipif(
    shutil.which("git") is None or shutil.which("bash") is None,
    reason="needs git and bash",
)
def test_install_sh_repository_stage_recovers_from_autostash_conflict(
    tmp_path: Path,
) -> None:
    managed = _make_conflicted_managed_checkout(tmp_path)
    env = os.environ | {
        "HERMES_HOME": str(tmp_path / "hermes-home"),
        "HERMES_INSTALL_DIR": str(managed),
    }

    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--stage", "repository", "--non-interactive"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    _assert_conflict_was_recovered(managed, result.stdout, bash=True)


@pytest.mark.live_system_guard_bypass
@pytest.mark.skipif(
    shutil.which("git") is None or POWERSHELL is None,
    reason="needs git and PowerShell",
)
def test_install_ps1_repository_stage_recovers_from_autostash_conflict(
    tmp_path: Path,
) -> None:
    managed = _make_conflicted_managed_checkout(tmp_path)
    result = subprocess.run(
        [
            POWERSHELL,
            "-NoProfile",
            "-File",
            str(INSTALL_PS1),
            "-Stage",
            "repository",
            "-NonInteractive",
            "-InstallDir",
            str(managed),
            "-HermesHome",
            str(tmp_path / "hermes-home"),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    _assert_conflict_was_recovered(managed, result.stdout)


@pytest.mark.live_system_guard_bypass
@pytest.mark.skipif(
    shutil.which("git") is None or shutil.which("bash") is None,
    reason="needs git and bash",
)
def test_install_sh_repository_stage_clean_apply_drops_stash(
    tmp_path: Path,
) -> None:
    """Happy path: a non-conflicting restore must still apply and drop the stash.

    The conflict-recovery fix must not regress the normal path — when stash apply
    succeeds cleanly, the stash should be dropped and local changes restored.
    """
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init")
    (seed / "tracked.txt").write_text("base\n", encoding="utf-8")
    _git(seed, "add", "tracked.txt")
    _git(seed, "commit", "-m", "base")
    _git(seed, "branch", "-M", "main")

    remote = tmp_path / "origin.git"
    _git(tmp_path, "init", "--bare", str(remote))
    _git(seed, "remote", "add", "origin", str(remote))
    _git(seed, "push", "-u", "origin", "main")

    managed = tmp_path / "hermes-agent"
    _git(tmp_path, "clone", "--branch", "main", str(remote), str(managed))

    # Local edit on a file upstream will NOT touch — no conflict on apply.
    (managed / "local-only.txt").write_text("local edit\n", encoding="utf-8")

    upstream = tmp_path / "upstream"
    _git(tmp_path, "clone", "--branch", "main", str(remote), str(upstream))
    (upstream / "tracked.txt").write_text("upstream edit\n", encoding="utf-8")
    _git(upstream, "commit", "-am", "upstream")
    _git(upstream, "push", "origin", "main")

    env = os.environ | {
        "HERMES_HOME": str(tmp_path / "hermes-home"),
        "HERMES_INSTALL_DIR": str(managed),
    }
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--stage", "repository", "--non-interactive"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "Local changes were restored on top of the updated codebase." in result.stdout
    # Stash must be dropped on a clean apply — not preserved.
    assert _git(managed, "stash", "list").stdout.strip() == "", "stash must be dropped on clean apply"
    # Local changes must be present in the working tree.
    assert (managed / "local-only.txt").read_text(encoding="utf-8") == "local edit\n"
    assert (managed / "tracked.txt").read_text(encoding="utf-8") == "upstream edit\n"


def _fixture_checkout(tmp_path: Path, *, conflict=False):
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "--initial-branch=main")
    for name in ("tracked.txt", "delete.txt", "binary"):
        (seed / name).write_bytes(b"base\n")
    (seed / "link").symlink_to("tracked.txt")
    _git(seed, "add", ".")
    _git(seed, "commit", "-m", "synthetic base")
    remote = tmp_path / "origin.git"
    _git(tmp_path, "clone", "--bare", str(seed), str(remote))
    managed = tmp_path / "managed"
    _git(tmp_path, "clone", "--branch", "main", str(remote), str(managed))
    _git(seed, "remote", "add", "origin", str(remote))
    name = "tracked.txt" if conflict else "upstream.txt"
    (seed / name).write_bytes(b"upstream\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-m", "synthetic target")
    _git(seed, "push", "origin", "main")
    return managed, _git(seed, "rev-parse", "HEAD").stdout.strip()


def _state(repo: Path):
    entries = _git(repo, "ls-files", "--stage", "-z").stdout.split("\0")
    index = sorted(e for e in entries if e and not e.endswith("\tupstream.txt"))
    tree = {}
    for p in repo.rglob("*"):
        rel = p.relative_to(repo)
        if ".git" in rel.parts or str(rel) == "upstream.txt":
            continue
        if p.is_symlink():
            tree[str(rel)] = ("symlink", os.readlink(p))
        elif p.is_file():
            tree[str(rel)] = ("file", p.stat().st_mode & 0o777, p.read_bytes())
    return index, tree


def _run_installer(tmp_path, managed, *, env_extra=None):
    return subprocess.run(
        ["bash", str(INSTALL_SH), "--stage", "repository", "--non-interactive"],
        cwd=tmp_path, env=os.environ | {
            "HERMES_HOME": str(tmp_path / "home"),
            "HERMES_INSTALL_DIR": str(managed),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        } | (env_extra or {}), capture_output=True, text=True, timeout=60,
    )


@pytest.mark.linux_only
@pytest.mark.parametrize("worktree_bytes", [b"base\n", b"unstaged version\n"])
def test_install_sh_preserves_index_and_worktree(tmp_path, worktree_bytes):
    managed, target = _fixture_checkout(tmp_path)
    (managed / "tracked.txt").write_bytes(b"staged version\n")
    (managed / "binary").write_bytes(b"\x00staged\xff")
    (managed / "binary").chmod(0o755)
    (managed / "added.txt").write_bytes(b"staged addition\n")
    (managed / "delete.txt").unlink()
    _git(managed, "add", "-A")
    (managed / "tracked.txt").write_bytes(worktree_bytes)
    (managed / "binary").write_bytes(b"\x00unstaged\xff")
    (managed / "link").unlink()
    (managed / "link").symlink_to("binary")
    (managed / "untracked.txt").write_bytes(b"untracked\n")
    expected = _state(managed)
    result = _run_installer(tmp_path, managed)
    assert result.returncode == 0, result.stdout + result.stderr
    assert _git(managed, "rev-parse", "HEAD").stdout.strip() == target
    assert _state(managed) == expected, "staged entries and filesystem must be preserved separately"
    assert not _git(managed, "stash", "list").stdout.strip()


def _fault_git(tmp_path, fault):
    """Fault only the named Git boundary; all storage/merges use real Git."""
    import json
    import sys

    bindir = tmp_path / "bin"
    bindir.mkdir()
    wrapper = bindir / "git"
    wrapper.write_text(
        f"#!{sys.executable}\nREAL = {shutil.which('git')!r}\nFAULT = {fault!r}\n"
        f"RECORD = {str(tmp_path / 'saved-oid')!r}\n" + '''
import os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
if FAULT == 'query' and args == ['diff', '--name-only', '--diff-filter=U']:
    sys.exit(128)
if FAULT == 'reset' and args == ['reset', '--hard', 'HEAD']:
    sys.exit(1)
if FAULT == 'drop' and args[:2] == ['stash', 'drop']:
    sys.exit(1)
if FAULT == 'selector' and args[:2] == ['stash', 'list']:
    sys.exit(1)
status = subprocess.call([REAL, *args])
if status == 0 and args[:2] == ['stash', 'push']:
    Path(RECORD).write_bytes(subprocess.check_output([REAL, 'rev-parse', 'refs/stash']))
if status == 0 and args[:2] == ['pull', '--ff-only']:
    if FAULT == 'collision':
        Path('untracked.txt').write_bytes(b'new untracked\\n')
    if FAULT == 'reorder':
        Path('other.txt').write_bytes(b'other stash\\n')
        subprocess.run([REAL, 'stash', 'push', '-u', '-m', 'other owner'], check=True)
sys.exit(status)
'''
    )
    wrapper.chmod(0o755)
    (tmp_path / "fault.json").write_text(json.dumps({"fault": fault}))
    return {"PATH": str(bindir) + os.pathsep + os.environ["PATH"]}


@pytest.mark.linux_only
@pytest.mark.parametrize("fault", ["query", "drop", "selector", "reorder"])
def test_install_sh_conservative_cleanup(tmp_path, fault):
    managed, target = _fixture_checkout(tmp_path)
    (managed / "tracked.txt").write_bytes(b"staged\n")
    _git(managed, "add", "tracked.txt")
    (managed / "tracked.txt").write_bytes(b"unstaged\n")
    expected = _state(managed)
    result = _run_installer(tmp_path, managed, env_extra=_fault_git(tmp_path, fault))
    saved = (tmp_path / "saved-oid").read_text().strip()
    refs = _git(managed, "stash", "list", "--format=%H").stdout.splitlines()
    assert result.returncode == 0, result.stdout + result.stderr
    assert _git(managed, "rev-parse", "HEAD").stdout.strip() == target
    assert _state(managed) == expected
    if fault == "reorder":
        assert saved not in refs and len(refs) == 1
        assert _git(managed, "show", f"{refs[0]}^3:other.txt").stdout == "other stash\n"
    else:
        assert saved in refs, "unknown verification/failed cleanup must keep saved OID referenced"
        assert saved in result.stdout
        if fault == "query":
            assert "unverified" in result.stdout
            assert "were restored on top" not in result.stdout
        else:
            assert "left in place" in result.stdout


@pytest.mark.linux_only
@pytest.mark.parametrize("fault", ["none", "reset", "collision"])
def test_install_sh_incomplete_restore_and_recovery(tmp_path, fault):
    managed, target = _fixture_checkout(tmp_path, conflict=fault != "collision")
    (managed / "tracked.txt").write_bytes(b"staged conflict\n")
    _git(managed, "add", "tracked.txt")
    (managed / "tracked.txt").write_bytes(b"unstaged conflict\n")
    (managed / "untracked.txt").write_bytes(b"saved untracked\n")
    expected = _state(managed)
    result = _run_installer(tmp_path, managed, env_extra=_fault_git(tmp_path, fault))
    saved = (tmp_path / "saved-oid").read_text().strip()
    assert result.returncode == 0, result.stdout + result.stderr
    assert _git(managed, "rev-parse", "HEAD").stdout.strip() == target
    assert saved in _git(managed, "stash", "list", "--format=%H").stdout.splitlines()
    assert f"git stash apply --index {saved}" in result.stdout
    assert "clean state" not in result.stdout and "were restored on top" not in result.stdout
    if fault == "reset":
        assert "Could not reset" in result.stdout
        assert "Tracked files and index reset" not in result.stdout
    elif fault == "collision":
        assert "incomplete" in result.stdout
        assert (managed / "untracked.txt").read_bytes() == b"new untracked\n"
        assert "Tracked files and index reset" not in result.stdout
    else:
        assert "Tracked files and index reset to HEAD; untracked files may remain" in result.stdout
        assert "conflict again" in result.stdout
    # Prove independent recovery from a verified bundle on the ORIGINAL base.
    # This is not an automatic merge onto the updated target.
    bundle = tmp_path / "recovery.bundle"
    _git(managed, "bundle", "create", str(bundle), "--all")
    _git(managed, "bundle", "verify", str(bundle))
    recovered = tmp_path / "recovered"
    _git(tmp_path, "clone", str(bundle), str(recovered))
    _git(recovered, "checkout", "--detach", f"{saved}^1")
    _git(recovered, "stash", "apply", "--index", saved)
    assert _state(recovered) == expected
    assert saved in _git(managed, "stash", "list", "--format=%H").stdout.splitlines()
