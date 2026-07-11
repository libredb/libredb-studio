#!/usr/bin/env bash
#
# Loop Engineering — generic autonomous build loop (fresh context per iteration).
#
# Each iteration spawns a new agent process fed PROMPT.md. Progress persists in
# files and git, not in the model's context window.
#
# Configure via loop/config/loop.env (copy from loop.env.example).
#
# SAFETY: unattended mode typically bypasses permission prompts. Run in a
# sandbox (Docker), on a dedicated branch, with a clean working tree.
#
# Usage:
#   loop/scripts/loop.sh [MAX_ITERATIONS]
#
# Exit codes:
#   0 — completion marker found
#   1 — max iterations without completion
#   2 — stuck on usage limits
#   3 — repeated transient failures
#   4 — fatal / non-recoverable error

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

# --- load config -----------------------------------------------------------
ENV_FILE="${LOOP_ENV_FILE:-loop/config/loop.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

MAX_ITERATIONS="${1:-${LOOP_MAX_ITERATIONS:-50}}"
PROMPT_FILE="${LOOP_PROMPT_FILE:-loop/PROMPT.md}"
LOG_DIR="${LOOP_LOG_DIR:-.loop/logs}"
COMPLETE_MARKER="${LOOP_COMPLETE_MARKER:-.loop/COMPLETE}"
COMPLETION_SENTINEL="${LOOP_COMPLETION_SENTINEL:-PROJECT-MILESTONE-DONE}"
AGENT_CMD="${LOOP_AGENT_CMD:-claude}"
AGENT_ARGS="${LOOP_AGENT_ARGS:---dangerously-skip-permissions}"
DISALLOWED_TOOLS="${LOOP_DISALLOWED_TOOLS:-Bash(rm:*)}"
USAGE_WAIT="${LOOP_USAGE_WAIT:-1800}"
MAX_USAGE_WAITS="${LOOP_MAX_USAGE_WAITS:-48}"
MAX_TRANSIENT="${LOOP_MAX_TRANSIENT:-5}"
MODEL="${LOOP_MODEL:-}"
# Hard cap per iteration. An agent process that hangs (observed: usage limit
# hit mid-iteration leaves `claude -p` alive but idle forever) never exits,
# so classify() never runs. timeout(1) turns a hang into exit 124, which
# classify() treats as transient (backoff + retry the same iteration).
ITERATION_TIMEOUT="${LOOP_ITERATION_TIMEOUT:-1800}"

mkdir -p "$LOG_DIR" "$(dirname "$COMPLETE_MARKER")"
rm -f "$COMPLETE_MARKER"

# Claude Code retry env (ignored by other agents)
export CLAUDE_CODE_RETRY_WATCHDOG="${CLAUDE_CODE_RETRY_WATCHDOG:-1}"
export CLAUDE_CODE_MAX_RETRIES="${CLAUDE_CODE_MAX_RETRIES:-15}"

# --- guards ----------------------------------------------------------------
if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "ERROR: prompt file not found: $PROMPT_FILE" >&2
  echo "Copy loop/PROMPT.md.template → loop/PROMPT.md and customize." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not a git repository; the loop relies on git for recovery." >&2
  exit 1
fi

if ! command -v ${AGENT_CMD%% *} >/dev/null 2>&1; then
  echo "ERROR: agent command not found: $AGENT_CMD" >&2
  exit 1
fi

# --- classify iteration output ---------------------------------------------
# Echoes: ok | usage_limit | fatal | transient
classify() {
  local log="$1" code="$2"

  if grep -qiE "hit your (session|weekly|opus) limit|resets [0-9A-Za-z]" "$log"; then
    echo usage_limit; return
  fi

  if grep -qiE "not logged in|invalid api key|oauth token (revoked|has expired)|could not resolve authentication|credit balance is too low|organization has been disabled|disabled (api key authentication|claude subscription access)|issue with the selected model|violate our usage policy|usage credits required" "$log"; then
    echo fatal; return
  fi

  # timeout(1) expiry: the agent process hung past ITERATION_TIMEOUT (observed
  # with usage limits hitting mid-iteration). Retry as transient; if the cause
  # persists, MAX_TRANSIENT stops the loop for a human.
  if [[ "$code" -eq 124 ]]; then
    echo transient; return
  fi

  if [[ "$code" -ne 0 ]]; then
    if grep -qiE "unable to connect to api|api error: 5[0-9][0-9]|overloaded|request timed out|fetch failed|request rejected \(429\)|temporarily limiting requests|econnreset|etimedout|econnrefused" "$log"; then
      echo transient; return
    fi
    echo fatal; return
  fi

  echo ok
}

# --- run one agent iteration -----------------------------------------------
run_agent() {
  local prompt_content="$1"
  # Default: Claude Code non-interactive
  if [[ "$AGENT_CMD" == "claude" ]]; then
    # shellcheck disable=SC2086
    timeout --foreground --kill-after=30 "$ITERATION_TIMEOUT" \
      claude -p "$prompt_content" \
      ${MODEL:+--model "$MODEL"} \
      $AGENT_ARGS \
      ${DISALLOWED_TOOLS:+--disallowedTools "$DISALLOWED_TOOLS"}
  else
    # Generic: LOOP_AGENT_CMD can be a full command; prompt via env or stdin
    # Example: LOOP_AGENT_CMD='cursor agent --print --force'
    if [[ -n "${LOOP_AGENT_USE_STDIN:-}" ]]; then
      printf '%s' "$prompt_content" | eval "$AGENT_CMD"
    else
      eval "$AGENT_CMD" "\"$prompt_content\""
    fi
  fi
}

# --- main loop -------------------------------------------------------------
echo "Loop Engineering: up to $MAX_ITERATIONS iterations"
echo "Project root: $REPO_ROOT"
echo "Prompt: $PROMPT_FILE  |  Agent: $AGENT_CMD"
echo "Completion sentinel (informational): $COMPLETION_SENTINEL"
echo "Completion marker (authoritative): $COMPLETE_MARKER"
echo "Logs: $LOG_DIR/iteration-*.log"
echo

i=1
consec_transient=0
usage_waits=0

while (( i <= MAX_ITERATIONS )); do
  echo "=== Iteration $i / $MAX_ITERATIONS ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
  LOG="$LOG_DIR/iteration-$i.log"

  # Re-read the prompt every iteration so "steer by inputs" works mid-run:
  # pause the loop, sharpen PROMPT.md, resume — the next iteration picks it up.
  PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

  # Write to the log directly instead of piping through tee: a pipe is held
  # open by ANY surviving child of a killed agent (orphaned tool processes),
  # which would block the loop long after timeout(1) fired. With a file, the
  # exit code is available the moment timeout returns. Follow live with
  # `tail -f` on the log; the iteration's output is echoed once it ends.
  run_agent "$PROMPT_CONTENT" > "$LOG" 2>&1
  code=$?
  cat "$LOG"

  case "$(classify "$LOG" "$code")" in
    ok)
      consec_transient=0
      if [[ -f "$COMPLETE_MARKER" ]]; then
        echo
        echo "=== Completion marker found at iteration $i ($COMPLETE_MARKER). Done. ==="
        exit 0
      fi
      echo "--- iteration $i complete ---"
      echo
      (( i++ ))
      ;;

    usage_limit)
      reset_hint="$(grep -oiE "resets [^.·\"]+" "$LOG" | head -1)"
      (( usage_waits++ ))
      if (( usage_waits > MAX_USAGE_WAITS )); then
        echo "STOP: usage-limited after $MAX_USAGE_WAITS waits. ${reset_hint:-} Check account quota." >&2
        exit 2
      fi
      echo "Usage limit. Wait ${USAGE_WAIT}s, retry iteration $i ($usage_waits/$MAX_USAGE_WAITS)."
      sleep "$USAGE_WAIT"
      ;;

    transient)
      (( consec_transient++ ))
      if (( consec_transient > MAX_TRANSIENT )); then
        echo "STOP: $consec_transient consecutive transient failures." >&2
        exit 3
      fi
      backoff=$(( consec_transient * 60 ))
      echo "Transient failure (exit $code). Backoff ${backoff}s ($consec_transient/$MAX_TRANSIENT)."
      sleep "$backoff"
      ;;

    fatal)
      echo "STOP: non-recoverable error at iteration $i (exit $code). See $LOG" >&2
      exit 4
      ;;
  esac
done

echo "Reached MAX_ITERATIONS ($MAX_ITERATIONS) without completion marker."
echo "Inspect: git log | loop/IMPLEMENTATION_PLAN.md | loop/PROGRESS.md"
exit 1
