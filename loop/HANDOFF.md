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

COMPLETE. As of 2026-07-12, all three stages of the first fully autonomous milestone ran on
this branch:

- Triage: 15 issues across three batches (commits `3c78105`, `26fb92f`, `ca7cc05`) —
  7 queued, 1 needs-info (#94), 4 escalated to moderator (#40, #123, #127, #167),
  3 not-for-loop (#100, #108, #170).
- Planning: 7 queued issues → 8 build tasks (#96 pre-split), commit `3b5472d`.
- Build: all 8 tasks done, one commit each, every one with RED evidence and a fresh-context
  `loop-reviewer` verdict of PASS or PASS WITH NOTES (details per entry in
  `loop/PROGRESS.md`):
  - #126 `01873b9` — Oracle/MSSQL `supportsExplain: false` + docs tri-sync
  - #125 `f334137` — sqlite path guard rejects NUL only; dead traversal branch removed
  - #136 `586b3b5` — render-level test pins the minimal two-secret install
  - #151 `b751399` — chart:check merge-base comparison + shared predicate + polish
  - #45 `496c191` — chart hardening (schema coverage, jwtSecret length, PDB zero-value and
    exclusivity, no HPA with sqlite); chart 0.1.11 → 0.1.12
  - #124 `e26dcf9` — deny-list prune of the standalone payload (105M → 32M locally)
  - #96a `c2de170` — registry-based value renderers behind `formatCellValue`
  - #96b `7a7f7e4` — pretty-printed json-kind values in the row detail sheet
- Close-out: every `loop/ACCEPTANCE.md` criterion re-verified against actual repo state; the
  full gate re-run fresh and green (format, lint, typecheck, all 18 test groups, build, plus
  `helm lint --strict` and `bun run chart:check`); `.loop/COMPLETE` created.
- All 7 queued issues remain OPEN by design — a human closes them at PR merge.

## Human gates outstanding

- #94 (`loop:needs-info`) — awaiting the reporter's answer (question posted as issue comment
  4949538647); only a human removing the label makes it pickable. Reported as an open gap at
  close-out, NOT part of this milestone.
- Moderator queue (`loop:needs-moderator-action`): #40 (ER-diagram export needs a new runtime
  dependency decision), #123 (release signing/SLSA — privileged pipeline), #127 (expose
  sqlite in the connection form — trust-model product call), #167 (helm-release republish
  guard — workflow edit), plus pre-existing #175, #166, #152, #114, #72. Build mode must not
  touch any of these.
- Final human gate: review the branch (8 task commits + close-out), push, open the PR
  (base `main`) — the loop never pushes. The PR bumps chart content (#45), and the chart
  version bump (0.1.12) is already in the same commit per the charts/** repo rule.
- Human-follow-up flags collected during the build (details in the matching
  `loop/PROGRESS.md` entries): the embedded libredb provider carries the same dead traversal
  branch #125 removed from sqlite; the Dockerfile runner stage still copies the untrimmed
  standalone output (#124's prune covers only the payload script); a real `npmjs-token` file
  sits at this dev machine's repo root (credential hygiene — move it off the repo root);
  deployment.yaml's pre-existing zero-config guard message is slightly stale for the
  sqlite+autoscaling case (#45); RowDetailSheet's pre-existing `Eye` icon lacks
  `strokeWidth={1.5}` (#96b).
- Next milestone: start with triage mode (`LOOP_PROMPT_FILE="loop/PROMPT-TRIAGE.md"`), new
  sentinel in `loop/config/loop.env`, and remove the stale `.loop/COMPLETE` before running.
