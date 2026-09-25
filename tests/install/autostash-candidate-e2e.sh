#!/usr/bin/env bash
# Independent candidate install + autostash proof, never a reused historical leg.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIVER="$REPO_ROOT/tests/install/test_autostash_candidate_e2e.py"
if [ "${1:-}" = --state ]; then
  exec "${PYTHON:-python3}" "$DRIVER" "$@"
fi
if [ "${1:-}" = --help ]; then
  printf '%s\n' 'Usage: autostash-candidate-e2e.sh --route update|installer --case clean|conflict' \
    'A fresh, independent candidate install per route/case; not historical-updater proof.' \
    'Read-only states: --state capture|verify REPO PREFIX JSON'
  exit 0
fi
[ "$#" = 4 ] && [ "$1" = --route ] && [ "$3" = --case ] || { printf 'error: invalid arguments\n' >&2; exit 1; }
ROUTE="$2" CASE="$4"
case "$ROUTE" in update|installer) ;; *) exit 1 ;; esac
case "$CASE" in clean|conflict) ;; *) exit 1 ;; esac
cd "$REPO_ROOT"
[ -z "$(git status --porcelain)" ] || { printf 'error: candidate worktree must be clean\n' >&2; exit 1; }
if command -v sandbox >/dev/null 2>&1; then
  SANDBOX=(sandbox)
elif command -v bwrap >/dev/null 2>&1; then
  SANDBOX=("$REPO_ROOT/scripts/dev-sandbox.sh")
else
  printf 'error: no usable dev sandbox\n' >&2; exit 1
fi
LOG_DIR="${HERMES_E2E_LOG_DIR:-$(mktemp -d -t hermes-candidate-logs.XXXXXX)}"
mkdir -p "$LOG_DIR"
LOG_DIR="$(cd "$LOG_DIR" && pwd)"
case "$LOG_DIR/" in "$REPO_ROOT/"*) printf 'error: logs must be outside checkout\n' >&2; exit 1 ;; esac
SANDBOX_ROOT="$(mktemp -d "$REPO_ROOT/.hermes-sandbox-e2e-candidate-$ROUTE-$CASE.XXXXXX")"
export HERMES_DEV_SANDBOX_DIR="${SANDBOX_ROOT##*/}"
collect_and_cleanup() {
  local status=$?
  trap - EXIT
  if [ -d "$SANDBOX_ROOT/root/logs" ]; then
    mkdir -p "$LOG_DIR/sandbox"
    cp -a "$SANDBOX_ROOT/root/logs/." "$LOG_DIR/sandbox/" || status=1
  fi
  if [ -d "$SANDBOX_ROOT/home/.npm/_logs" ]; then
    mkdir -p "$LOG_DIR/npm"
    cp -a "$SANDBOX_ROOT/home/.npm/_logs/." "$LOG_DIR/npm/" || status=1
  fi
  rm -rf -- "$SANDBOX_ROOT"
  exit "$status"
}
trap collect_and_cleanup EXIT
"${SANDBOX[@]}" install --persistent -- --skip-setup --skip-browser 2>&1 | tee "$LOG_DIR/install.log"
# One invocation owns preparation, actual update and assertions. A new sandbox
# invocation rebuilds fake main, so it must not interrupt the synthetic target.
"${SANDBOX[@]}" --persistent bash -lc \
  "exec /home/hermes/.hermes/hermes-agent/venv/bin/python /work/repo/tests/install/test_autostash_candidate_e2e.py --candidate-run '$ROUTE' '$CASE'" \
  2>&1 | tee "$LOG_DIR/proof.log"
printf 'Candidate autostash proof passed: %s / %s\n' "$ROUTE" "$CASE"
