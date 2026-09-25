"""Candidate autostash evidence driver and behavioral contracts.

The CLI is stdlib-only so an installed candidate need not carry pytest.
All destructive fixture work runs in the dev sandbox; snapshot/check are read-only.
"""
from pathlib import Path
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SHELL = ROOT / "tests/install/autostash-candidate-e2e.sh"

if __name__ != "__main__":
    import pytest

    pytestmark = pytest.mark.linux_only


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-c", "user.name=Autostash E2E", "-c", "user.email=e2e@example.invalid", *args],
        cwd=repo, stderr=subprocess.PIPE,
    )


def snapshot(repo, prefix):
    import hashlib

    directory = repo / prefix
    if not prefix or Path(prefix).is_absolute() or ".." in Path(prefix).parts:
        raise ValueError("fixture prefix must be a relative child path")
    tree = {}
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in [*dirs, *files]:
            path = Path(parent) / name
            rel = path.relative_to(repo).as_posix()
            if path.is_symlink():
                tree[rel] = {"type": "symlink", "target": os.readlink(path)}
            elif path.is_file():
                tree[rel] = {"type": "file", "mode": path.stat().st_mode & 0o777,
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    rows = git(repo, "ls-files", "--stage", "-z", "--", prefix).decode().split("\0")
    return {"index": sorted(row for row in rows if row), "worktree": tree}


def verify_state(expected, actual):
    for field in ("index", "worktree"):
        if field not in expected or expected[field] != actual[field]:
            raise ValueError(f"{field} was not preserved")


def code_identity(repo):
    import hashlib

    paths = ("scripts/install.sh", "hermes_cli/main.py", "hermes_cli/update_cmd.py",
             "hermes_cli/subcommands/update.py")
    return {rel: hashlib.sha256((repo / rel).read_bytes()).hexdigest()
            if (repo / rel).is_file() else None for rel in paths}


def export_stash(repo, saved, output):
    """Small bundle: requires the recorded base, retains every stash parent."""
    import re

    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", saved):
        raise ValueError("invalid stash OID")
    base = git(repo, "rev-parse", f"{saved}^1").decode().strip()
    ref = f"refs/autostash-e2e/{saved}"
    # The fresh sandbox owns this evidence ref; it also protects the object.
    git(repo, "update-ref", ref, saved)
    bundle = output / f"stash-{saved}.bundle"
    git(repo, "bundle", "create", str(bundle), ref, f"^{base}")
    git(repo, "bundle", "verify", str(bundle))
    return {"oid": saved, "base": base, "ref": ref, "bundle": bundle.name}


def capture_repository(repo, output):
    output.mkdir(parents=True, exist_ok=True)
    saved = git(repo, "stash", "list", "--format=%H").decode().splitlines()
    evidence = {
        "head": git(repo, "rev-parse", "HEAD").decode().strip(),
        "code": code_identity(repo), "stashes": saved,
        "status": git(repo, "status", "--porcelain=v1").decode(),
        "unmerged": git(repo, "ls-files", "--unmerged", "-z").decode(),
        "bundles": [export_stash(repo, oid, output) for oid in saved],
    }
    (output / "index.entries").write_bytes(git(repo, "ls-files", "--stage", "-z"))
    (output / "staged.patch").write_bytes(git(repo, "diff", "--cached", "--binary"))
    (output / "unstaged.patch").write_bytes(git(repo, "diff", "--binary"))
    (output / "provenance.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence


def exercise_candidate(repo, remote, output, route, case, operation):
    """Shared invariant engine; operation is real CLI in CI, real stages locally."""
    if route not in {"update", "installer"} or case not in {"clean", "conflict"}:
        raise ValueError("invalid candidate route/case")
    output.mkdir(parents=True, exist_ok=False)
    prefix = "autostash-e2e-fixture"
    fixture = repo / prefix
    fixture.mkdir()  # Refuse to reuse another route's state.
    for name in ("mixed", "staged-only", "delete", "binary"):
        (fixture / name).write_bytes(b"base\n")
    (fixture / "link").symlink_to("mixed")
    if git(repo, "diff", "--cached", "--name-only").strip():
        raise ValueError("candidate index is not initially clean")
    git(repo, "add", "--", prefix)
    git(repo, "commit", "-m", "synthetic autostash base")
    base = git(repo, "rev-parse", "HEAD").decode().strip()
    code_before = code_identity(repo)
    work = repo.parent / f".autostash-proof-{route}-{case}"
    work.mkdir()
    upstream = work / "upstream"
    git(repo, "clone", "--no-hardlinks", str(repo), str(upstream))
    target_file = upstream / (prefix + "/mixed" if case == "conflict" else "autostash-upstream-marker")
    target_file.write_bytes(b"upstream change\n")
    git(upstream, "add", "--", str(target_file.relative_to(upstream)))
    git(upstream, "commit", "-m", "synthetic autostash target; code unchanged")
    target = git(upstream, "rev-parse", "HEAD").decode().strip()
    git(upstream, "push", str(remote), "HEAD:refs/heads/main")
    for name in ("mixed", "staged-only"):
        (fixture / name).write_bytes(b"staged bytes\n")
    (fixture / "binary").write_bytes(b"\x00staged\xff")
    (fixture / "binary").chmod(0o755)
    (fixture / "delete").unlink()
    (fixture / "added").write_bytes(b"staged addition\n")
    git(repo, "add", "--", prefix)
    (fixture / "mixed").write_bytes(b"unstaged bytes\n")
    (fixture / "staged-only").write_bytes(b"base\n")
    (fixture / "binary").write_bytes(b"\x00unstaged\xff")
    (fixture / "link").unlink()
    (fixture / "link").symlink_to("binary")
    (fixture / "untracked").write_bytes(b"untracked bytes\n")
    before = snapshot(repo, prefix)
    (output / "before.json").write_text(json.dumps(before, indent=2) + "\n")
    report = {"route": route, "case": case, "base": base, "target": target,
              "code_before": code_before, "verified": False,
              "recovered_on_original_base": False}
    try:
        report["operation_exit"] = operation(repo, route, output)
        after = snapshot(repo, prefix)
        (output / "after.json").write_text(json.dumps(after, indent=2) + "\n")
        report["code_after"] = code_identity(repo)
        if report["operation_exit"] != 0:
            raise ValueError("candidate operation failed")
        if report["code_after"] != code_before:
            raise ValueError("candidate implementation changed during proof")
        if git(repo, "rev-parse", "HEAD").decode().strip() != target:
            raise ValueError("candidate did not reach synthetic target")
        if git(repo, "ls-files", "--unmerged").strip():
            raise ValueError("candidate left unresolved conflicts")
        if case == "clean":
            verify_state(before, after)
        else:
            stashes = git(repo, "stash", "list", "--format=%H").decode().splitlines()
            matching = [oid for oid in stashes
                        if git(repo, "rev-parse", f"{oid}^1").decode().strip() == base]
            if len(matching) != 1:
                raise ValueError("saved recovery reference missing or ambiguous")
            saved = matching[0]
            bundle = export_stash(repo, saved, output)
            recovered = work / "recovered"
            recovered.mkdir()
            git(recovered, "init")
            git(recovered, "fetch", str(repo), base)
            git(recovered, "bundle", "verify", str(output / bundle["bundle"]))
            git(recovered, "fetch", str(output / bundle["bundle"]), bundle["ref"])
            git(recovered, "checkout", "--detach", base)
            git(recovered, "stash", "apply", "--index", saved)
            verify_state(before, snapshot(recovered, prefix))
            report["stash"] = bundle
            report["recovered_on_original_base"] = True
        report["verified"] = True
        return report
    finally:
        # Preserve evidence on a failed assertion/operation, not only on success.
        try:
            capture_repository(repo, output / "final")
        except Exception:
            report["verified"] = False
            raise
        finally:
            (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")


def require_dev_sandbox(repo):
    if (repo.resolve() != Path('/home/hermes/.hermes/hermes-agent')
            or ROOT != Path('/work/repo')
            or not Path('/work/repos/hermes-agent.git').is_dir()):
        raise ValueError("candidate operation requires the dev sandbox")


def trace_update(repo, output):
    """Observe real function calls without replacing any updater implementation."""
    import hashlib
    import marshal

    require_dev_sandbox(repo)
    sys.path.insert(0, str(repo))
    from hermes_cli import update_cmd
    from hermes_cli.main import main as cli_main

    if Path(update_cmd.__file__).resolve() != repo / "hermes_cli/update_cmd.py":
        raise ValueError("updater imported from the wrong candidate")
    expected = {name: getattr(update_cmd, name).__code__ for name in (
        "_stash_local_changes_if_needed", "_restore_stashed_changes")}
    observed = {}

    def observer(frame, event, arg):
        name = frame.f_code.co_name
        if event == "call" and name in expected and frame.f_code is expected[name]:
            observed[name] = {"path": frame.f_code.co_filename,
                              "code_sha256": hashlib.sha256(marshal.dumps(frame.f_code)).hexdigest()}

    previous = sys.getprofile()
    sys.argv = ["hermes", "update", "--yes"]
    try:
        sys.setprofile(observer)
        cli_main()
    finally:
        sys.setprofile(previous)
        output.write_text(json.dumps(observed, indent=2) + "\n")
        if set(observed) != set(expected):
            raise ValueError("candidate stash/restore functions were not both executed")


def installed_operation(repo, route, output):
    require_dev_sandbox(repo)
    if route == "update":
        command = [sys.executable, str(Path(__file__)), "--trace-update", str(repo), str(output / "executed-code.json")]
    else:
        command = ["bash", str(repo / "scripts/install.sh"), "--skip-setup", "--skip-browser", "--non-interactive"]
        (output / "executed-code.json").write_text(json.dumps({
            "path": str(repo / "scripts/install.sh"), "sha256": code_identity(repo)["scripts/install.sh"],
            "command": command,
        }, indent=2) + "\n")
    with (output / "operation.log").open("w") as log:
        return subprocess.run(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT,
                              stdin=subprocess.DEVNULL, timeout=1800).returncode


def main():
    args = sys.argv[1:]
    if len(args) == 5 and args[0] == "--state":
        _, action, repo, prefix, output = args
        actual = snapshot(Path(repo), prefix)
        if action == "capture":
            Path(output).write_text(json.dumps(actual, indent=2) + "\n")
        elif action == "verify":
            verify_state(json.loads(Path(output).read_text()), actual)
        else:
            raise ValueError("unknown state action")
    elif len(args) == 3 and args[0] == "--candidate-run":
        repo = Path('/home/hermes/.hermes/hermes-agent')
        require_dev_sandbox(repo)
        if code_identity(repo) != code_identity(ROOT):
            raise ValueError("installed code is not the candidate under test")
        if git(repo, "rev-parse", "HEAD").strip() != git(repo, "--git-dir=/work/repos/hermes-agent.git", "rev-parse", "main").strip():
            raise ValueError("initial install is not at the candidate commit")
        exercise_candidate(repo, Path('/work/repos/hermes-agent.git'),
                           Path('/work/logs/candidate-proof'), args[1], args[2], installed_operation)
    elif len(args) == 3 and args[0] == "--trace-update":
        trace_update(Path(args[1]), Path(args[2]))
    elif len(args) == 3 and args[0] == "--history":
        repo = Path(args[1])
        require_dev_sandbox(repo)
        capture_repository(repo, Path(args[2]))
    else:
        raise ValueError("unknown evidence operation")


def _test_git(repo, *args):
    return subprocess.check_output(
        ["git", "-c", "user.name=Synthetic", "-c", "user.email=test@example.invalid", *args],
        cwd=repo, stderr=subprocess.PIPE,
    ).decode().strip()


def _test_seed(tmp_path):
    repo = tmp_path / "fixture"
    repo.mkdir()
    _test_git(repo, "init", "--initial-branch=main")
    (repo / "data").mkdir()
    (repo / "data/file").write_bytes(b"base\n")
    _test_git(repo, "add", ".")
    _test_git(repo, "commit", "-qm", "base")
    (repo / "data/file").write_bytes(b"staged\n")
    _test_git(repo, "add", ".")
    (repo / "data/file").write_bytes(b"unstaged\n")
    return repo


def _state_command(action, repo, evidence):
    assert SHELL.is_file(), "candidate E2E entry point must exist"
    return subprocess.run(
        ["bash", str(SHELL), "--state", action, str(repo), "data", str(evidence)],
        capture_output=True, text=True, timeout=30,
    )


def test_snapshot_and_verify_separate_index_and_worktree(tmp_path):
    repo = _test_seed(tmp_path)
    evidence = tmp_path / "before.json"
    result = _state_command("capture", repo, evidence)
    assert result.returncode == 0, result.stderr
    assert _state_command("verify", repo, evidence).returncode == 0
    _test_git(repo, "reset", "-q")  # Working bytes unchanged; staging lost.
    result = _state_command("verify", repo, evidence)
    assert result.returncode == 1 and "index" in result.stderr


def test_snapshot_detects_worktree_mode_and_symlink_changes(tmp_path):
    repo = _test_seed(tmp_path)
    (repo / "data/link").symlink_to("file")
    evidence = tmp_path / "before.json"
    assert _state_command("capture", repo, evidence).returncode == 0
    (repo / "data/file").chmod(0o755)
    assert _state_command("verify", repo, evidence).returncode == 1
    (repo / "data/file").chmod(0o644)
    (repo / "data/link").unlink()
    (repo / "data/link").symlink_to("missing")
    assert _state_command("verify", repo, evidence).returncode == 1


def test_missing_evidence_is_not_a_pass(tmp_path):
    repo = _test_seed(tmp_path)
    result = _state_command("verify", repo, tmp_path / "absent.json")
    assert result.returncode != 0


def test_candidate_refuses_host_execution(tmp_path, monkeypatch):
    import pytest

    assert SHELL.is_file(), "candidate E2E entry point must exist"
    outside = tmp_path / "outside-sandbox"
    outside.mkdir()
    monkeypatch.chdir(outside)

    def unexpected_operation(*args, **kwargs):
        pytest.fail("candidate work started before the real sandbox guard refused")

    # Exercise the real entry boundary without spawning an updater-shaped
    # command. Keep require_dev_sandbox and the canonical live guard intact.
    for name in ("code_identity", "git", "exercise_candidate", "installed_operation"):
        monkeypatch.setitem(globals(), name, unexpected_operation)
    for route in ("update", "installer"):
        for case in ("clean", "conflict"):
            monkeypatch.setattr(sys, "argv", [__file__, "--candidate-run", route, case])
            with pytest.raises(ValueError, match="candidate operation requires the dev sandbox"):
                main()
    assert list(outside.iterdir()) == []


def _probe_fixture(tmp_path):
    import shutil

    repo = tmp_path / "installed"
    repo.mkdir()
    _test_git(repo, "init", "--initial-branch=main")
    for rel in ("scripts/install.sh", "hermes_cli/update_cmd.py", "hermes_cli/main.py"):
        dest = repo / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dest)
    _test_git(repo, "add", ".")
    _test_git(repo, "commit", "-qm", "candidate code snapshot")
    remote = tmp_path / "remote.git"
    _test_git(tmp_path, "clone", "--bare", str(repo), str(remote))
    _test_git(repo, "remote", "add", "origin", str(remote))
    return repo, remote


def _local_operation(repo, route, output):
    if route == "installer":
        result = subprocess.run(
            ["bash", str(repo / "scripts/install.sh"), "--stage", "repository", "--non-interactive"],
            cwd=repo, env=os.environ | {"HERMES_HOME": str(output / "home"), "HERMES_INSTALL_DIR": str(repo)},
            capture_output=True, text=True, timeout=60,
        )
        (output / "operation.log").write_text(result.stdout + result.stderr)
        return result.returncode
    from hermes_cli import update_cmd

    saved = update_cmd._stash_local_changes_if_needed(["git"], repo)
    git(repo, "fetch", "origin", "main")
    git(repo, "merge", "--ff-only", "origin/main")
    update_cmd._restore_stashed_changes(["git"], repo, saved)
    return 0


def test_candidate_probe_real_git_clean_and_conflict(tmp_path):
    exercise = globals().get("exercise_candidate")
    assert callable(exercise), "candidate-executed fixture must be implemented"
    for route in ("update", "installer"):
        for case in ("clean", "conflict"):
            root = tmp_path / f"{route}-{case}"
            root.mkdir()
            repo, remote = _probe_fixture(root)
            result = exercise(repo, remote, root / "evidence", route, case, _local_operation)
            assert result["verified"] is True
            assert result["code_before"] == result["code_after"]
            assert result["recovered_on_original_base"] is (case == "conflict")


def test_probe_rejects_false_green_and_missing_stash(tmp_path):
    import pytest

    exercise = globals().get("exercise_candidate")
    assert callable(exercise), "candidate-executed fixture must be implemented"
    for case in ("clean", "conflict"):
        root = tmp_path / case
        root.mkdir()
        repo, remote = _probe_fixture(root)

        def bad_operation(repo, route, output):
            _local_operation(repo, route, output)
            if case == "clean":
                git(repo, "reset", "-q")
            else:
                git(repo, "stash", "drop", "stash@{0}")
            return 0  # Exit zero is not proof of preservation.

        with pytest.raises(ValueError, match="index|recovery reference"):
            exercise(repo, remote, root / "evidence", "update", case, bad_operation)
        report = json.loads((root / "evidence/result.json").read_text())
        assert report["verified"] is False


def test_evidence_collection_failure_is_not_verified(tmp_path, monkeypatch):
    import pytest

    repo, remote = _probe_fixture(tmp_path)

    def unavailable(*args):
        raise OSError('evidence disk unavailable')

    monkeypatch.setitem(globals(), 'capture_repository', unavailable)
    with pytest.raises(OSError, match='evidence disk'):
        exercise_candidate(repo, remote, tmp_path / 'evidence', 'update', 'clean', _local_operation)
    assert json.loads((tmp_path / 'evidence/result.json').read_text())['verified'] is False


def test_candidate_workflows_have_independent_legs_and_failure_artifacts():
    import yaml

    workflow = yaml.safe_load((ROOT / '.github/workflows/install-e2e.yml').read_text())
    jobs = workflow['jobs']
    for route in ('update', 'installer'):
        key = f'candidate-{route}'
        assert key in jobs, 'candidate preservation needs independent jobs'
        job = jobs[key]
        assert set(job['strategy']['matrix']['case']) == {'clean', 'conflict'}
        assert job['with']['route'] == route
        assert job['with']['candidate-case'] == '${{ matrix.case }}'
        assert 'pick-releases' not in job.get('needs', [])
    reusable = yaml.safe_load((ROOT / '.github/workflows/install-e2e-run.yml').read_text())
    steps = reusable['jobs']['e2e']['steps']
    candidate = next(s for s in steps if s.get('name') == 'Run candidate autostash proof')
    assert candidate['env']['CANDIDATE_CASE'] == '${{ inputs.candidate-case }}'
    assert any(s.get('if') == 'always()' and 'upload-artifact@' in s.get('uses', '') for s in steps)
    assert reusable['permissions'] == {'contents': 'read'}


def test_candidate_shell_explains_separate_proof():
    result = subprocess.run(['bash', str(SHELL), '--help'], capture_output=True, text=True)
    assert result.returncode == 0
    assert 'independent' in result.stdout and '--case' in result.stdout


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"autostash evidence failed: {exc}", file=sys.stderr)
        sys.exit(1)
