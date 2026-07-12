# Handoff

> Orientation only — not authoritative. Authoritative state is
> `loop/IMPLEMENTATION_PLAN.md` + `loop/PROGRESS.md` + git log.

## Current milestone

Maintainer Sweep 2 — the first fully autonomous milestone (triage → planning → build over the
open public issue tracker), on branch `loop/maintainer-sweep-2`. Queue: the 7 issues labeled
`loop:queued` at planning time — #126, #125, #136, #151, #45, #124, #96 — each with a
sanitized spec in `loop/TRIAGE.md`. Definition of done: `loop/ACCEPTANCE.md` (sentinel
`LIBREDB-STUDIO-SWEEP-2-DONE`).

## Status

PLANNED, build not started. As of 2026-07-12:

- Triage complete: 15 issues triaged across three batches (commits `3c78105`, `26fb92f`,
  `ca7cc05`) — 7 queued, 1 needs-info (#94), 4 escalated to moderator (#40, #123, #127,
  #167), 3 not-for-loop (#100, #108, #170).
- Planning complete: `loop/IMPLEMENTATION_PLAN.md` rewritten for Sweep 2 — 7 tasks (one per
  queued issue; #96 pre-split into #96a/#96b), ordered providers (#126, #125) → chart
  (#136, #151, then #45 — #151's merge-base fix deliberately lands before #45's chart
  version bump) → payload (#124) → results rendering (#96a, #96b) → close-out. All spec
  evidence re-verified against the branch tip at planning time; no queued issue has
  comments or updates since triage.
- `loop/config/loop.env` is already flipped to build mode
  (`LOOP_PROMPT_FILE="loop/PROMPT.md"`): the next `./loop/scripts/loop.sh <N>` run starts
  building at task #126. Each build iteration ends with the mandatory fresh-context
  `loop-reviewer` pass before its commit.

## Human gates outstanding

- #94 (`loop:needs-info`) — awaiting the reporter's answer (question posted as issue comment
  4949538647); only a human removing the label makes it pickable. Reported as an open gap at
  close-out, NOT part of this milestone.
- Moderator queue (`loop:needs-moderator-action`): #40 (ER-diagram export needs a new runtime
  dependency decision), #123 (release signing/SLSA — privileged pipeline), #127 (expose
  sqlite in the connection form — trust-model product call), #167 (helm-release republish
  guard — workflow edit), plus pre-existing #175, #166, #152, #114, #72. Build mode must not
  touch any of these.
- Final human gate: review the branch, push, open the PR (base `main`) — the loop never
  pushes.
