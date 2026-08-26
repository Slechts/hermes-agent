from pathlib import Path


WORKFLOW = Path(__file__).parents[2] / ".github" / "workflows" / "install-e2e.yml"
UPSTREAM_TAG_FETCH = (
    "git fetch --force --no-tags https://github.com/NousResearch/hermes-agent.git "
    "'+refs/tags/v*:refs/tags/v*'"
)
PICK_RELEASES = 'tags="$(scripts/sandbox/pick-release-tags.sh'


def test_pick_releases_fetches_upstream_release_tags_before_sampling() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert UPSTREAM_TAG_FETCH in workflow
    assert workflow.index(UPSTREAM_TAG_FETCH) < workflow.index(PICK_RELEASES)
