"""Real-Git contracts: preserve both index and worktree across an update."""
import os
import shutil
import subprocess

import pytest

from hermes_cli import update_cmd


@pytest.fixture
def repo(tmp_path, monkeypatch):
    if not shutil.which("git"):
        pytest.skip("git not available")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "Synthetic Test")
    git(tmp_path, "config", "user.email", "synthetic@example.invalid")
    git(tmp_path, "config", "core.autocrlf", "false")
    git(tmp_path, "config", "core.filemode", "true")
    for name in ("mixed.txt", "staged-only.txt", "unstaged.txt", "delete.txt"):
        (tmp_path / name).write_bytes(b"base\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "synthetic base")
    return tmp_path


def git(repo, *args, check=True):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, check=check,
    )


def index(repo):
    return git(repo, "ls-files", "--stage", "-z").stdout


def worktree(repo):
    result = {}
    for path in repo.rglob("*"):
        rel = path.relative_to(repo)
        if ".git" in rel.parts or path.is_dir():
            continue
        result[str(rel)] = (
            ("symlink", os.readlink(path)) if path.is_symlink()
            else ("file", path.stat().st_mode & 0o777, path.read_bytes())
        )
    return result


def save(repo):
    ref = update_cmd._stash_local_changes_if_needed(["git"], repo)
    assert ref
    return ref


def saved_refs(repo):
    return git(repo, "stash", "list", "--format=%H").stdout.decode().splitlines()


def advance(repo, *, conflict=False):
    if conflict:
        (repo / "mixed.txt").write_bytes(b"upstream conflict\n")
    else:
        (repo / "upstream.txt").write_bytes(b"upstream addition\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "synthetic upstream")


def test_restore_preserves_staged_only_and_split_index(repo):
    # The staged-only version does not occur in the final worktree.
    for name in ("mixed.txt", "staged-only.txt"):
        (repo / name).write_bytes(b"staged version\n")
    (repo / "added.txt").write_bytes(b"staged addition\n")
    (repo / "delete.txt").unlink()
    git(repo, "add", "-A")
    (repo / "mixed.txt").write_bytes(b"unstaged version\n")
    (repo / "staged-only.txt").write_bytes(b"base\n")
    (repo / "unstaged.txt").write_bytes(b"unstaged change\n")
    (repo / "untracked.txt").write_bytes(b"untracked bytes\n")
    expected_index = index(repo)
    expected_tree = worktree(repo)
    ref = save(repo)
    advance(repo)

    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is True
    # Only the new upstream file is added to the expected index/worktree.
    actual_index = b"\0".join(
        row for row in index(repo).split(b"\0")
        if not row.endswith(b"\tupstream.txt")
    )
    assert actual_index == expected_index
    tree = worktree(repo)
    assert tree.pop("upstream.txt")[2] == b"upstream addition\n"
    assert tree == expected_tree
    assert ref not in saved_refs(repo)


def test_untracked_collision_retains_recovery_reference(repo, capsys):
    (repo / "mixed.txt").write_bytes(b"staged saved\n")
    git(repo, "add", "mixed.txt")
    (repo / "mixed.txt").write_bytes(b"unstaged saved\n")
    (repo / "untracked.txt").write_bytes(b"original untracked\n")
    ref = save(repo)
    advance(repo)
    # A file appearing while updating is not necessarily the same file saved.
    (repo / "untracked.txt").write_bytes(b"new untracked\n")

    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is False
    assert ref in saved_refs(repo)
    assert (repo / "untracked.txt").read_bytes() == b"new untracked\n"
    assert git(repo, "show", f"{ref}^3:untracked.txt").stdout == b"original untracked\n"
    assert git(repo, "show", f"{ref}^2:mixed.txt").stdout == b"staged saved\n"
    out = capsys.readouterr().out
    assert ref in out and "preserved" in out
    assert "were restored on top" not in out


@pytest.mark.parametrize("reset_fails", [False, True])
def test_conflict_message_matches_reset_result(repo, monkeypatch, capsys, reset_fails):
    (repo / "mixed.txt").write_bytes(b"local conflict\n")
    (repo / "untracked.txt").write_bytes(b"saved untracked\n")
    ref = save(repo)
    advance(repo, conflict=True)
    real_run = subprocess.run

    def run(cmd, **kwargs):
        if reset_fails and cmd == ["git", "reset", "--hard", "HEAD"]:
            return subprocess.CompletedProcess(cmd, 1, b"", b"simulated reset failure")
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(update_cmd.subprocess, "run", run)
    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is False
    assert ref in saved_refs(repo)
    assert (repo / "untracked.txt").read_bytes() == b"saved untracked\n"
    out = capsys.readouterr().out
    assert "clean state" not in out
    assert ref in out and f"git stash apply --index {ref}" in out
    assert "conflict again" in out
    if reset_fails:
        assert "Could not reset" in out
        assert "Tracked files and index reset" not in out
        assert git(repo, "diff", "--name-only", "--diff-filter=U").stdout
    else:
        assert "Tracked files and index reset to HEAD" in out
        assert "untracked files may remain" in out
        assert not git(repo, "diff", "--name-only", "--diff-filter=U").stdout
        assert (repo / "mixed.txt").read_bytes() == b"upstream conflict\n"


def test_declining_restore_gives_index_preserving_command(repo, capsys):
    (repo / "mixed.txt").write_bytes(b"staged\n")
    git(repo, "add", "mixed.txt")
    ref = save(repo)
    before = (index(repo), worktree(repo))
    assert update_cmd._restore_stashed_changes(
        ["git"], repo, ref, prompt_user=True, input_fn=lambda *_: "n"
    ) is False
    assert (index(repo), worktree(repo)) == before
    assert ref in saved_refs(repo)
    assert f"git stash apply --index {ref}" in capsys.readouterr().out


def test_failed_conflict_check_never_drops_saved_reference(repo, monkeypatch, capsys):
    (repo / "mixed.txt").write_bytes(b"staged change\n")
    git(repo, "add", "mixed.txt")
    ref = save(repo)
    real_run = subprocess.run

    def run(cmd, **kwargs):
        if cmd == ["git", "diff", "--name-only", "--diff-filter=U"]:
            return subprocess.CompletedProcess(cmd, 128, "", "cannot read index")
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(update_cmd.subprocess, "run", run)
    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is False
    assert ref in saved_refs(repo)
    assert (repo / "mixed.txt").read_bytes() == b"staged change\n"
    out = capsys.readouterr().out
    assert "Could not verify" in out and ref in out
    assert "were restored on top" not in out


def test_index_conflict_can_recover_on_original_base(repo):
    (repo / "mixed.txt").write_bytes(b"staged conflict\n")
    (repo / "staged-only.txt").write_bytes(b"staged only\n")
    git(repo, "add", ".")
    (repo / "mixed.txt").write_bytes(b"unstaged conflict\n")
    (repo / "staged-only.txt").write_bytes(b"base\n")
    (repo / "untracked.txt").write_bytes(b"untracked\n")
    expected_index, expected_tree = index(repo), worktree(repo)
    ref = save(repo)
    advance(repo, conflict=True)
    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is False
    assert ref in saved_refs(repo)
    recovered = repo.parent / (repo.name + "-recovery")
    git(repo, "worktree", "add", "--detach", str(recovered), f"{ref}^1")
    git(recovered, "stash", "apply", "--index", ref)
    assert index(recovered) == expected_index
    assert worktree(recovered) == expected_tree
    assert ref in saved_refs(repo)


@pytest.mark.skipif(os.name == "nt", reason="POSIX modes and symlinks")
def test_binary_mode_and_symlink_roundtrip(repo):
    (repo / "mixed.txt").write_bytes(b"\x00staged\xff")
    (repo / "mixed.txt").chmod(0o755)
    (repo / "link").symlink_to("mixed.txt")
    git(repo, "add", ".")
    (repo / "mixed.txt").write_bytes(b"\x00unstaged\xff")
    (repo / "link").unlink()
    (repo / "link").symlink_to("unstaged.txt")
    expected = index(repo), worktree(repo)
    ref = save(repo)
    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is True
    assert (index(repo), worktree(repo)) == expected
    assert ref not in saved_refs(repo)


def test_cleanup_targets_saved_oid_not_newest_stash(repo):
    (repo / "mixed.txt").write_bytes(b"first stash\n")
    git(repo, "add", ".")
    ref = save(repo)
    (repo / "untracked.txt").write_bytes(b"second stash\n")
    git(repo, "stash", "push", "--include-untracked", "-m", "other stash")
    other_ref = saved_refs(repo)[0]
    assert other_ref != ref
    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is True
    assert saved_refs(repo) == [other_ref]
    assert (repo / "mixed.txt").read_bytes() == b"first stash\n"


@pytest.mark.parametrize("failure", ["selector", "drop"])
def test_cleanup_failure_keeps_successfully_restored_changes(repo, monkeypatch, capsys, failure):
    (repo / "mixed.txt").write_bytes(b"staged\n")
    git(repo, "add", ".")
    expected = index(repo), worktree(repo)
    ref = save(repo)
    real_run = subprocess.run

    def run(cmd, **kwargs):
        if cmd[:3] == ["git", "stash", "drop"]:
            return subprocess.CompletedProcess(cmd, 1, "", "simulated drop failure")
        return real_run(cmd, **kwargs)

    if failure == "selector":
        monkeypatch.setattr(update_cmd, "_resolve_stash_selector", lambda *_: None)
    else:
        monkeypatch.setattr(update_cmd.subprocess, "run", run)
    assert update_cmd._restore_stashed_changes(["git"], repo, ref) is True
    assert (index(repo), worktree(repo)) == expected
    assert ref in saved_refs(repo)
    assert "left in place" in capsys.readouterr().out
