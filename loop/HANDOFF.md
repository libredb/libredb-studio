# Handoff

> Orientation only — not authoritative. Authoritative state is
> `loop/IMPLEMENTATION_PLAN.md` + `loop/PROGRESS.md` + git log.

## Current state

No milestone is open. The last completed one — Maintainer Sweep 2, the first fully autonomous
run (triage → planning → build over the open public issue tracker) — shipped in PR #178,
released as 0.9.53 (chart 0.1.13), and its 7 queued issues (#45, #96, #124, #125, #126, #136,
#151) are closed. Its working-set files still sit in `loop/` until the next milestone opens;
`new-milestone.sh` will archive them to `loop/archive/sweep-2/` at that moment.

## How to run the next milestone (generic operation)

```bash
git checkout main && git pull
git checkout -b loop/<name>          # dedicated branch, e.g. loop/sweep-3
./loop/scripts/new-milestone.sh <name>   # archive previous state, reset files, set TRIAGE mode
git add -A loop && git commit -m "chore(loop): open milestone <name>"
./loop/scripts/pipeline.sh           # unattended: triage -> planning -> build
# then, always human: review the branch, push, open the PR (base main)
```

- `pipeline.sh` never pushes; publishing is the human trust gate.
- Planning mode writes both `IMPLEMENTATION_PLAN.md` and `ACCEPTANCE.md` from the
  `loop:queued` queue (a human may instead pre-list issues in `ACCEPTANCE.md` before running).
- The gate is `./loop/scripts/gate.sh` — the single mirror of root `CLAUDE.md`'s mandatory
  pre-commit verification (currently format · lint · typecheck · knip · test · build). When
  CLAUDE.md's gate changes, update `gate.sh`; prompts reference the script, not the commands.
- Issues labeled `loop:needs-info` / `loop:needs-moderator-action` are never picked up; only a
  human removing the label changes that.

## Human gates outstanding (as of 2026-07-13)

- #94 (`loop:needs-info`) — awaiting the reporter's answer (question posted as issue comment
  4949538647).
- Moderator queue (`loop:needs-moderator-action`): #123 (release signing/SLSA — privileged
  pipeline), #127 (expose sqlite in the connection form — trust-model product call), #167
  (helm-release republish guard — workflow edit), plus pre-existing #175, #166, #152, #114,
  #72. (#40 was resolved by a human directly in PR #180.)
- Not-for-the-loop tracking issues needing a human split before they can be queued: #100,
  #108, #170 (see `loop/TRIAGE.md`).
- Human-follow-up flags collected during Sweep 2 (details in the matching `loop/PROGRESS.md`
  entries; archived with the milestone): the embedded libredb provider carries the same dead
  traversal branch #125 removed from sqlite; the Dockerfile runner stage still copies the
  untrimmed standalone output (#124's prune covers only the payload script); a real
  `npmjs-token` file sits at this dev machine's repo root (credential hygiene); the
  deployment.yaml zero-config guard message is slightly stale for the sqlite+autoscaling case
  (#45); RowDetailSheet's pre-existing `Eye` icon lacks `strokeWidth={1.5}` (#96b).
