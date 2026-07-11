# Handoff

> Orientation only — not authoritative. Authoritative state is
> `loop/IMPLEMENTATION_PLAN.md` + `loop/PROGRESS.md` + git log.

## Current milestone

Maintainer Bug Sweep 1 — issues #132, #133, #134, #135, #137 (first-run/install-path bugs across
the npx, standalone tarball, deb/rpm, Homebrew, and Helm distribution channels).

## Status

COMPLETE. All 5 issues fixed test-first on `loop/maintainer-bugsweep-1`, one commit each:

- #134 — `8779173` — force loopback bind on direct deb/rpm and Homebrew runs
- #135 — `bf4080c` — default Homebrew direct-run state dir outside the Cellar keg
- #132 — `0150d94` — preserve payload/data across npx launcher re-extraction
- #133 — `b8ed99a` — extract standalone tarball under a versioned root, not a tarbomb
- #137 — `50e3a2f` — regression test pinning the writable `/app/data` default (fix itself
  predates this loop, shipped in PR #165/commit `3a22428`)

Full gate reverified green on the clean branch tip at close-out: format clean, lint 0 errors
(pre-existing warnings only), typecheck OK, `bun run test` 18/18 groups pass (0 fail), build OK,
`helm lint charts/libredb-studio --strict` 0 charts failed. No issue is labeled
`loop:needs-info`. All 5 functional tasks plus Phase F are ticked in
`loop/IMPLEMENTATION_PLAN.md`. `docs/DISTRIBUTION.md` updated for #134/#135/#133 (verified via
grep for `LIBREDB_BIND`, `STORAGE_SQLITE_PATH`, and the versioned-root paragraph); #137 needed no
doc changes (already documented by PR #165). All 5 issues remain OPEN on GitHub — this loop does
not close issues; a human closes them at PR merge.

## Next milestone (infrastructure ready, not yet planned)

The loop is now hardened for FULLY AUTONOMOUS operation against the open public issue tracker
(2026-07-12, human-driven hardening — see the PROGRESS.md entry of that date). The pipeline for
the next milestone, on a fresh dedicated branch off `main`:

1. **Triage mode** — set `LOOP_PROMPT_FILE="loop/PROMPT-TRIAGE.md"` in `loop/config/loop.env`,
   run `./loop/scripts/loop.sh <N>`. Classifies every untriaged open issue into `loop:queued`
   (sanitized spec written to `loop/TRIAGE.md`), `loop:needs-info` (question posted),
   `loop:needs-moderator-action` (human-only), or the TRIAGE.md "Not for the loop" list.
   Labels exist already (`loop/scripts/setup-labels.sh`, idempotent).
2. **Human checkpoint (optional but recommended for the first run)** — skim `loop/TRIAGE.md`
   and the labels; veto by removing `loop:queued` or editing specs.
3. **Planning mode** — `LOOP_PROMPT_FILE="loop/PROMPT-PLANNING.md"`, one iteration; writes
   `loop/IMPLEMENTATION_PLAN.md` from the queue. Author `loop/ACCEPTANCE.md` for the milestone
   (or let it list "all loop:queued issues at planning time") and bump
   `LOOP_COMPLETION_SENTINEL` in `loop/config/loop.env`.
4. **Build mode** — `LOOP_PROMPT_FILE="loop/PROMPT.md"`, run to completion. Each task now ends
   with a mandatory fresh-context `loop-reviewer` pass before its commit.
5. **Human close** — review the branch, push, open the PR (the loop never pushes).

Backlog candidates known today: open `bug` issues not in Bug Sweep 1 (#40, #94, #126), #127
(question: sqlite absent from selectableTypes), #125 (traversal-check intent), #124 (trim
standalone payload; deferred from #133), the npx launcher's latent `HOSTNAME`-passthrough gap
noted in `loop/PROGRESS.md`'s #134 entry, and whatever triage mode queues from the rest.
