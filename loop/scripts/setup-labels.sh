#!/usr/bin/env bash
#
# Idempotently create/update the maintainer-loop's GitHub label taxonomy.
# Safe to re-run: --force updates the color/description of an existing label.
#
# The taxonomy (see loop/LOOP-ENGINEERING.md, "Untrusted input firewall"):
#   loop:queued                 — triage verified the issue in code and queued a sanitized spec
#   loop:needs-info             — loop posted a clarifying question; only a human clears it
#   loop:needs-moderator-action — suspicious content or a decision beyond loop authority;
#                                 the loop never touches the issue again until a human acts

set -euo pipefail

gh label create "loop:queued" \
  --description "Triaged by the maintainer loop: verified in code, sanitized spec recorded, queued" \
  --color "0E8A16" --force

gh label create "loop:needs-info" \
  --description "Maintainer-loop task blocked on human-reviewed clarification" \
  --color "D93F0B" --force

gh label create "loop:needs-moderator-action" \
  --description "Flagged by the maintainer loop: suspicious content or a decision only a human can make" \
  --color "B60205" --force

echo "Loop labels ensured: loop:queued, loop:needs-info, loop:needs-moderator-action"
