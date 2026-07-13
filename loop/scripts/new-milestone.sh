#!/usr/bin/env bash
# ==============================================================================
# Open a new maintainer-loop milestone.
#
# Archives the previous milestone's working-set content (the fresh-context
# loop re-reads PROGRESS.md every iteration, so an ever-growing log would
# re-introduce the context rot the loop exists to avoid) and resets the loop
# state files for a fresh queue:
#
#   loop/archive/<prev>/PROGRESS.md   <- the previous "## Log" entries
#   loop/archive/<prev>/TRIAGE.md     <- the previous "## Queue" specs
#   loop/archive/<prev>/ACCEPTANCE.md <- the previous milestone criteria
#   loop/archive/<prev>/IMPLEMENTATION_PLAN.md
#
#   loop/PROGRESS.md   -> entry-anatomy template + empty log + archive pointer
#   loop/TRIAGE.md     -> spec format + empty queue; "Not for the loop" is
#                         PRESERVED (it is the anti-re-triage memory)
#   loop/ACCEPTANCE.md -> stub; planning mode writes the real criteria
#   loop/IMPLEMENTATION_PLAN.md -> stub; planning mode writes the task list
#   loop/config/loop.env -> new sentinel, prompt set to TRIAGE mode
#   .loop/COMPLETE     -> removed
#
# Mutates files only - review the diff and commit; this script never commits
# and never touches git state.
#
# Usage: new-milestone.sh <milestone-name> [root-dir]
#   milestone-name: kebab-case, e.g. sweep-3
#   root-dir: repo root override (used by the unit tests; defaults to the
#             repository this script lives in)
# ==============================================================================

set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <milestone-name> [root-dir]" >&2
  exit 1
fi

NAME=$1
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LOOP_DIR="$ROOT/loop"
ENV_FILE="$LOOP_DIR/config/loop.env"

if ! printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
  echo "Milestone name must be kebab-case (got: '$NAME')" >&2
  exit 1
fi

for f in "$LOOP_DIR/PROGRESS.md" "$LOOP_DIR/TRIAGE.md" "$LOOP_DIR/ACCEPTANCE.md" \
  "$LOOP_DIR/IMPLEMENTATION_PLAN.md" "$ENV_FILE"; do
  if [ ! -f "$f" ]; then
    echo "Missing loop state file: $f" >&2
    exit 1
  fi
done

# The previous milestone's name comes from its completion sentinel.
PREV=$(sed -n 's/^LOOP_COMPLETION_SENTINEL="LIBREDB-STUDIO-\(.*\)-DONE"$/\1/p' "$ENV_FILE" |
  tr '[:upper:]' '[:lower:]')
PREV="${PREV:-previous}"

if [ "$PREV" = "$NAME" ]; then
  echo "Milestone '$NAME' is already the current one (sentinel matches) - pick a new name" >&2
  exit 1
fi

ARCHIVE="$LOOP_DIR/archive/$PREV"
if [ -e "$ARCHIVE" ]; then
  echo "Archive already exists: $ARCHIVE - refusing to overwrite history" >&2
  exit 1
fi
mkdir -p "$ARCHIVE"

# --- PROGRESS.md: archive everything from "## Log" on; keep the template ----
awk '/^## Log$/{found=1} found{print}' "$LOOP_DIR/PROGRESS.md" > "$ARCHIVE/PROGRESS.md"
awk '/^## Log$/{exit} {print}' "$LOOP_DIR/PROGRESS.md" > "$LOOP_DIR/PROGRESS.md.tmp"
cat >> "$LOOP_DIR/PROGRESS.md.tmp" << EOF
## Log

> Earlier milestones are archived under \`loop/archive/\` (one directory per
> milestone). Consult them only when a task genuinely needs that history.

### $(date -u +%Y-%m-%d) — Milestone $NAME opened (human)

- State reset by \`loop/scripts/new-milestone.sh $NAME\`; previous milestone
  ($PREV) archived to \`loop/archive/$PREV/\`.
- Next: triage mode over the untriaged open issues.
EOF
mv "$LOOP_DIR/PROGRESS.md.tmp" "$LOOP_DIR/PROGRESS.md"

# --- TRIAGE.md: archive the Queue; preserve "Not for the loop" --------------
awk '/^## Queue$/{found=1} found && /^## Not for the loop$/{exit} found{print}' \
  "$LOOP_DIR/TRIAGE.md" > "$ARCHIVE/TRIAGE.md"
{
  awk '/^## Queue$/{exit} {print}' "$LOOP_DIR/TRIAGE.md"
  printf '## Queue\n\n(empty — populated by triage mode; previous queue archived to loop/archive/%s/)\n\n' "$PREV"
  awk '/^## Not for the loop$/{found=1} found{print}' "$LOOP_DIR/TRIAGE.md"
} > "$LOOP_DIR/TRIAGE.md.tmp"
mv "$LOOP_DIR/TRIAGE.md.tmp" "$LOOP_DIR/TRIAGE.md"

# --- ACCEPTANCE.md / IMPLEMENTATION_PLAN.md: archive whole, write stubs -----
mv "$LOOP_DIR/ACCEPTANCE.md" "$ARCHIVE/ACCEPTANCE.md"
SENTINEL="LIBREDB-STUDIO-$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')-DONE"
cat > "$LOOP_DIR/ACCEPTANCE.md" << EOF
# Acceptance Criteria — Milestone $NAME

> STUB: planning mode (\`loop/PROMPT-PLANNING.md\`) rewrites this file from the
> \`loop:queued\` queue and \`loop/TRIAGE.md\` sanitized specs — one functional
> criterion per queued issue plus the standard Quality / Documentation /
> Process sections. A human may instead list issues here by hand before
> planning runs (the human-listed path).
>
> The completion sentinel for this milestone is \`$SENTINEL\`;
> the marker file \`.loop/COMPLETE\` remains the only authoritative signal.
EOF

mv "$LOOP_DIR/IMPLEMENTATION_PLAN.md" "$ARCHIVE/IMPLEMENTATION_PLAN.md"
cat > "$LOOP_DIR/IMPLEMENTATION_PLAN.md" << EOF
# Implementation Plan — Milestone $NAME

> STUB: planning mode (\`loop/PROMPT-PLANNING.md\`) rewrites this file from the
> milestone queue. Build mode must not run against this stub.
EOF

# --- loop.env: new sentinel, triage mode (tmp+mv, consistent with the file
# --- rewrites above and portable across GNU/BSD sed) --------------------------
sed \
  -e "s|^LOOP_COMPLETION_SENTINEL=.*|LOOP_COMPLETION_SENTINEL=\"$SENTINEL\"|" \
  -e "s|^LOOP_PROMPT_FILE=.*|LOOP_PROMPT_FILE=\"loop/PROMPT-TRIAGE.md\"|" \
  "$ENV_FILE" > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

rm -f "$ROOT/.loop/COMPLETE"

cat << EOF
Milestone '$NAME' opened (previous: '$PREV', archived to loop/archive/$PREV/).
Sentinel: $SENTINEL | mode: TRIAGE | stale completion marker removed.

Next steps:
  1. Review the diff and commit it (this script never commits).
  2. Run the full pipeline unattended:  ./loop/scripts/pipeline.sh
  3. When it finishes: review the branch, push, open the PR (always human).
EOF
