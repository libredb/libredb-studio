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

## Next milestone (not yet planned)

Backlog candidates for a future maintainer-loop run: open issues labeled `bug` not in this
milestone (e.g. #94, #96, #100, #125, #126, #127), plus #124 (trim standalone payload repo-root
extras, explicitly deferred from #133 — see `loop/IMPLEMENTATION_PLAN.md`'s "Later" section) and
the npx launcher's own latent `HOSTNAME`-passthrough gap noted as a known limitation in
`loop/PROGRESS.md`'s #134 entry. Use planning mode (`loop/PROMPT-PLANNING.md`) to select and
scope the next queue.
