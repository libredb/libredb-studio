#!/usr/bin/env bash
# ==============================================================================
# Run one full maintainer-loop milestone unattended:
#
#   TRIAGE  (loop/PROMPT-TRIAGE.md,   until .loop/COMPLETE)  ->
#   PLANNING (loop/PROMPT-PLANNING.md, exactly one iteration) ->
#   BUILD   (loop/PROMPT.md,          until .loop/COMPLETE)
#
# Each stage drives loop/scripts/loop.sh with a stage-specific prompt override;
# loop/config/loop.env stays untouched. Publishing (push / PR / merge) remains
# a HUMAN step by design - this script never pushes.
#
# Usage: pipeline.sh [TRIAGE_MAX] [BUILD_MAX]
#   TRIAGE_MAX: max triage iterations (default 8 - covers 35+ issues at 5/batch)
#   BUILD_MAX:  max build iterations  (default 20)
#
# Exit codes: 0 all stages complete; 1 a stage failed or hit its iteration cap
# (inspect loop/PROGRESS.md and .loop/logs/); the planning-contract violation
# (planning created the completion marker) also exits 1.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TRIAGE_MAX="${1:-8}"
BUILD_MAX="${2:-20}"
BASE_ENV="${LOOP_ENV_FILE:-$ROOT/loop/config/loop.env}"
MARKER="$ROOT/.loop/COMPLETE"

if [ ! -f "$BASE_ENV" ]; then
  echo "Loop env file not found: $BASE_ENV" >&2
  exit 1
fi

# Refuse to run over uncommitted work or on a protected branch - the loop's
# containment model is a clean tree on a dedicated branch (LOOP-ENGINEERING §7).
if git -C "$ROOT" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "Working tree is not clean - commit or stash before running the pipeline" >&2
    exit 1
  fi
  branch="$(git -C "$ROOT" branch --show-current)"
  if [ "$branch" = "main" ]; then
    echo "Refusing to run on 'main' - create a dedicated loop branch first" >&2
    exit 1
  fi
fi

# stage <label> <prompt-file> <max-iterations> <expectation>
#   expectation "marker":    loop.sh must exit 0 (completion marker found)
#   expectation "no-marker": a single planning iteration; exit 1 (cap reached,
#                            no marker) is the NORMAL outcome, a marker is a
#                            contract violation (planning must never complete)
stage() {
  local label=$1 prompt=$2 max=$3 expectation=$4
  local stage_env code
  stage_env=$(mktemp "${TMPDIR:-/tmp}/loop-stage-env.XXXXXX")
  printf 'source "%s"\nLOOP_PROMPT_FILE="%s"\n' "$BASE_ENV" "$prompt" > "$stage_env"

  echo
  echo "=== pipeline stage: $label ($prompt, up to $max iterations) ==="
  set +e
  LOOP_ENV_FILE="$stage_env" "$SCRIPT_DIR/loop.sh" "$max"
  code=$?
  set -e
  rm -f "$stage_env"

  case "$expectation" in
    marker)
      if [ "$code" -ne 0 ]; then
        echo "PIPELINE STOP: $label stage failed (loop.sh exit $code) - inspect loop/PROGRESS.md and .loop/logs/" >&2
        exit 1
      fi
      rm -f "$MARKER" # consumed; the next stage must earn its own
      ;;
    no-marker)
      if [ "$code" -eq 0 ]; then
        echo "PIPELINE STOP: $label created the completion marker - planning must never complete a milestone; inspect loop/PROGRESS.md" >&2
        exit 1
      fi
      if [ "$code" -ne 1 ]; then
        echo "PIPELINE STOP: $label stage failed (loop.sh exit $code)" >&2
        exit 1
      fi
      ;;
  esac
  echo "=== pipeline stage: $label DONE ==="
}

stage "TRIAGE" "loop/PROMPT-TRIAGE.md" "$TRIAGE_MAX" marker
stage "PLANNING" "loop/PROMPT-PLANNING.md" 1 no-marker
stage "BUILD" "loop/PROMPT.md" "$BUILD_MAX" marker

echo
echo "=== pipeline COMPLETE: triage, planning and build all finished ==="
echo "Next (human): review the branch (git log / loop/PROGRESS.md), push, open the PR."
