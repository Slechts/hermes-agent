#!/usr/bin/env bash
# Pick the release tags the install/update E2E should update FROM.
#
# Emits a JSON array of tag names on stdout, suitable for a GitHub Actions
# matrix (`fromJSON`). Choosing at runtime rather than hardcoding keeps the
# matrix honest as releases land: a pinned list silently stops covering the
# newest release the day after it ships, and pins the "oldest" forever even
# after it stops being a version anyone still runs.
#
# Selection: compare declared version and release date with the target. Newer
# releases are reported on stderr, never tested as downgrades. Older backports
# remain eligible even when they are not Git ancestors of the target.
# Sample the newest eligible tag, the oldest, and evenly spaced tags between.
# Newest catches "did the last release break updating?", oldest is the longest
# upgrade jump anyone can still make, and the spread samples the migrations in
# between (config-schema bumps, venv layout changes, dependency floors).
#
# Usage:
#   scripts/sandbox/pick-release-tags.sh [--count N] [--repo DIR] [--target REF]
#
#   --count   how many tags to emit (default 5, minimum 1). Fewer tags than
#             requested emits all of them.
#   --repo    repository to read tags from (default: this checkout).
#   --target commit to update to (default: HEAD in --repo).
#
# Reads local tags and complete history (actions/checkout fetch-depth: 0).
# Missing history or an empty compatible set fails rather than emitting an
# empty or downgrade matrix.
#
# Only vYYYY.M.D[.N] release tags are considered; the repo also carries
# backup/* and one-off tags that are not releases.

set -euo pipefail

COUNT=5
TARGET=HEAD
# Default to the repository containing this script, resolved through its real
# path so a symlinked or copied script still reads the checkout it lives in
# rather than whatever repo the caller happens to be standing in.
REPO=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --count)
      [ "$#" -ge 2 ] || { echo 'error: --count needs a value' >&2; exit 1; }
      COUNT="$2"; shift 2 ;;
    --repo)
      [ "$#" -ge 2 ] || { echo 'error: --repo needs a value' >&2; exit 1; }
      REPO="$2"; shift 2 ;;
    --target)
      [ "$#" -ge 2 ] || { echo 'error: --target needs a value' >&2; exit 1; }
      TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 1 ;;
  esac
done
case "$COUNT" in
  ''|*[!0-9]*) echo "error: --count must be a positive integer: $COUNT" >&2; exit 1 ;;
esac
[ "$COUNT" -ge 1 ] || { echo 'error: --count must be at least 1' >&2; exit 1; }

# Resolve the script's own location through symlinks, then ask git which
# worktree that path belongs to. Deriving the repo from the script rather than
# from $PWD means a copied script cannot silently report a different checkout's
# tags, and --show-toplevel keeps it correct when invoked from a subdirectory.
if [ -z "$REPO" ]; then
  script_path="${BASH_SOURCE[0]}"
  if command -v readlink >/dev/null 2>&1; then
    script_path="$(readlink -f "$script_path" 2>/dev/null || printf '%s' "$script_path")"
  fi
  script_dir="$(cd "$(dirname "$script_path")" && pwd)"
  REPO="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$script_dir")"
fi

target_commit="$(git -C "$REPO" rev-parse --verify --end-of-options "$TARGET^{commit}" 2>/dev/null)" || {
  echo "error: cannot resolve target commit: $TARGET" >&2; exit 1;
}
if [ "$(git -C "$REPO" rev-parse --is-shallow-repository)" != false ]; then
  echo 'error: complete history is required to select upgrade sources' >&2
  exit 1
fi

# sort -V orders v2026.4.8 before v2026.4.13 (numeric), which a plain
# lexicographic sort gets wrong.
mapfile -t tags < <(
  git -C "$REPO" tag --list 'v*' \
    | grep -E '^v[0-9]{4}\.[0-9]+\.[0-9]+(\.[0-9]+)?$' \
    | sort -V
)

total="${#tags[@]}"
if [ "$total" -eq 0 ]; then
  echo "error: no release tags found in $REPO" >&2
  echo '       Fetch release tags and complete history (fetch-depth: 0).' >&2
  exit 1
fi

compatible_tags="$(python3 - "$REPO" "$target_commit" "${tags[@]}" <<'PY'
import ast
import datetime
import re
import subprocess
import sys

repo, target, *tags = sys.argv[1:]


def release_key(ref):
    # Parse literals only: never import or execute code from a release.
    source = subprocess.run(
        ["git", "-C", repo, "show", "--end-of-options", f"{ref}:hermes_cli/__init__.py"],
        check=True, capture_output=True, text=True,
    ).stdout
    values = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign):
            for name in node.targets:
                if isinstance(name, ast.Name) and name.id in {"__version__", "__release_date__"}:
                    if name.id in values:
                        raise ValueError(f"duplicate release metadata in {ref}")
                    values[name.id] = ast.literal_eval(node.value)
    version = values.get("__version__")
    date = values.get("__release_date__")
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError(f"invalid version metadata in {ref}")
    if not isinstance(date, str) or not re.fullmatch(r"[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]+)?", date):
        raise ValueError(f"invalid release date metadata in {ref}")
    date_parts = tuple(map(int, date.split(".")))
    datetime.date(*date_parts[:3])
    return tuple(map(int, version.split("."))), date_parts + (0,) * (4 - len(date_parts))


try:
    target_key = release_key(target)
    eligible = []
    for tag in tags:
        if release_key(f"refs/tags/{tag}") > target_key:
            print(f"Skipping {tag}: newer than target {target}", file=sys.stderr)
        else:
            eligible.append(tag)
    if not eligible:
        raise ValueError(f"no release tags compatible with target {target}")
except (ValueError, SyntaxError, subprocess.CalledProcessError) as error:
    print(f"error: cannot select upgrade sources: {error}", file=sys.stderr)
    sys.exit(1)
print("\n".join(eligible))
PY
)"
mapfile -t tags <<< "$compatible_tags"
total="${#tags[@]}"

if [ "$total" -le "$COUNT" ]; then
  picked=("${tags[@]}")
elif [ "$COUNT" -eq 1 ]; then
  # One slot means the newest release; there is no span to spread across.
  picked=("${tags[$((total - 1))]}")
else
  # Evenly spaced indices across [0, total-1], endpoints included, so the
  # oldest and newest are always present and the rest are spread between them.
  picked=()
  for slot in $(seq 0 $((COUNT - 1))); do
    # Round to nearest rather than truncate, so the spacing does not bunch
    # toward the oldest end.
    index=$(( (slot * (total - 1) * 2 + (COUNT - 1)) / ((COUNT - 1) * 2) ))
    candidate="${tags[$index]}"
    # Guard against a duplicate if rounding lands twice on the same tag.
    case " ${picked[*]-} " in
      *" $candidate "*) continue ;;
    esac
    picked+=("$candidate")
  done
fi

printf '['
for i in "${!picked[@]}"; do
  [ "$i" -eq 0 ] || printf ','
  printf '"%s"' "${picked[$i]}"
done
printf ']\n'
