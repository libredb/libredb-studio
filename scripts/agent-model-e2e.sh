#!/bin/bash
# Drives every supported model through the application's own rail, one after another.
#
# The measurements behind `docs/llms/` were taken over HTTP: real runs, real database, real
# models, and never once through the interface a person uses. This closes that gap. For each
# model it points the server at it, restarts, and runs `e2e/agent-models.spec.ts`, which logs in,
# opens the embedded sample, types an objective into the rail and waits for the run to finish on
# screen.
#
# The model is an environment variable and the product has no picker, so switching it means
# restarting the server — which is why the loop lives here rather than inside the spec.
#
# Usage: scripts/agent-model-e2e.sh [model ...]      (default: all ten)
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

MODELS=("$@")
if [ ${#MODELS[@]} -eq 0 ]; then
  # Fastest first, so the run reports something early, and the hosted model last because it needs
  # its own environment file swapped in rather than a line rewritten.
  MODELS=(granite4.1:8b granite4.1:30b ornith:9b qwen3.5:9b qwen3:8b gemma4:26b qwen3:14b qwen3.8:latest qwen3:4b gemini-3.5-flash-lite)
fi

# Watchable by default: the browser opens on screen and every click is visible, and a video of
# each run is kept so a sweep run overnight can still be reviewed in the morning.
HEADED="${HEADED:---headed}"
# Slowed down on purpose. Watched live, the fast models finish a run in six seconds and the
# window opens and closes before anything is readable; this puts a beat between actions so the
# login, the connection, the objective and the run itself are all visible.
export PWSLOWMO="${PWSLOWMO:-350}"

BACKUP=$(mktemp)
cp .env.local "$BACKUP"
restore() {
  cp "$BACKUP" "$REPO/.env.local"
  rm -f "$BACKUP"
  echo "@@@@ .env.local restored"
}
trap restore EXIT

# Models whose sweep did not pass, collected rather than exited on: an hour of measurement is
# worth finishing, and one model's failure is not a reason to stop asking about the other nine.
FAILED=""

for MODEL in "${MODELS[@]}"
do
  echo "======== $MODEL ========"
  PREVIOUS=$(grep -E '^LLM_MODEL=' .env.local | cut -d= -f2-)
  [ -n "$PREVIOUS" ] && ollama stop "$PREVIOUS" >/dev/null 2>&1

  if [ "$MODEL" = "gemini-3.5-flash-lite" ]; then
    # The hosted one: provider, key and model all change together, so its own file is swapped in
    # whole rather than one line being rewritten.
    grep -vE '^(LLM_PROVIDER|LLM_MODEL|LLM_API_KEY|LLM_API_URL)=' "$BACKUP" > .env.local
    grep -E '^(LLM_PROVIDER|LLM_MODEL|LLM_API_KEY)=' .env.gemini.local >> .env.local
  else
    cp "$BACKUP" .env.local
    perl -pi -e "s{^LLM_MODEL=.*}{LLM_MODEL=$MODEL}" .env.local
  fi

  # The server reads the model at boot, so a restart is the switch. Killing by port rather than by
  # name: this machine has run several of these and a stale one holding 3000 is the failure that
  # measures the previous model under the new name.
  OLD=$(lsof -ti:3000)
  [ -n "$OLD" ] && kill "$OLD" && sleep 3
  nohup bun start > "/tmp/e2e-server-$(echo "$MODEL" | tr ':/' '--').log" 2>&1 &
  for _ in $(seq 30); do
    sleep 2
    [ "$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/db/health)" = "200" ] && break
  done

  AGENT_MODEL_E2E=1 \
    E2E_EMAIL="$(grep -E '^USER_EMAIL=' .env.local | cut -d= -f2-)" \
    E2E_PASSWORD="$(grep -E '^USER_PASSWORD=' .env.local | cut -d= -f2-)" \
    npx playwright test e2e/agent-models.spec.ts --project=chromium --reporter=line --workers=1 $HEADED 2>&1 |
    sed "s/^/[$MODEL] /"
  # Read IMMEDIATELY after the pipeline, because $? here is sed's and sed always succeeds.
  # Without this a model could fail its whole sweep while the script printed "done" and exited 0,
  # so anything reading the exit status - a wrapper, CI, or the next person - was told a sweep
  # passed that had not. The prefix is worth keeping, so the status is captured rather than the
  # pipe removed.
  STATUS=${PIPESTATUS[0]}
  [ "$STATUS" -eq 0 ] || FAILED="$FAILED $MODEL"
  echo "@@@@ $MODEL done (exit $STATUS)"
done
if [ -n "$FAILED" ]; then
  # Named rather than counted: the question after an hour-long sweep is WHICH model to look at.
  echo "@@@@ FAILED:$FAILED"
  exit 1
fi
echo "@@@@ done"
