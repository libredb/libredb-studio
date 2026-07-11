# Acceptance Criteria — Maintainer Bug Sweep 1

> Current milestone definition of "done" for the maintainer loop.
> The agent may create `.loop/COMPLETE` only when every criterion below is true and the gate
> is green.
> Issues: #132, #133, #134, #135, #137.

## Functional

- [x] #134 — deb/rpm (`packaging/linux/libredb-studio`) and Homebrew
      (`packaging/homebrew/libredb-studio.rb.tmpl`) wrappers bind `127.0.0.1` by default on a
      direct run regardless of an inherited `HOSTNAME` (empty, or set to a container ID); an
      explicit opt-in variable allows binding elsewhere. Matches the npx launcher's existing
      correct behavior.
- [x] #135 — running `libredb-studio` directly via the Homebrew formula stores zero-config
      state (auth-bootstrap credentials, SQLite data) outside the versioned Cellar keg, so it
      survives `brew upgrade`. Matches the deb/rpm wrapper's existing behavior for direct runs.
- [x] #132 — `npx @libredb/studio --verify-cache` (and the `--archive` path) no longer wipes
      `payload/data/` (in particular `auth-bootstrap.json`) on re-extraction; a previously
      generated admin password keeps working after `--verify-cache`.
- [x] #133 — the standalone release tarball extracts under a top-level
      `libredb-studio-<version>/` directory instead of spilling into the current directory;
      the npx launcher's extraction path and any packaging that consumes the payload
      (deb/rpm/snap/brew) still work against the new layout.
- [x] #137 — a default Helm install (`persistence.enabled=false`) gets a writable `/app/data`
      (e.g. an `emptyDir`, consistent with the existing `next-cache`/`tmp` emptyDirs) so the
      embedded "Sample (LibreDB)" connection seeds successfully; the login → open sample →
      query E2E flow passes without `--set persistence.enabled=true`.

## Quality

- [x] Built test-first; every fix has a regression test that fails before the fix and passes
      after
- [x] Full gate green on a clean working tree: `bun run format && bun run lint && bun run typecheck && bun run test && bun run build`
- [x] No placeholder/stub implementations in shipped code paths

## Documentation

- [x] `docs/DISTRIBUTION.md` updated if the fix changes documented behavior (e.g. the
      local-first bind guarantee, the data directory location)
- [x] `loop/PROGRESS.md` and `loop/HANDOFF.md` reflect actual state

## Process

- [x] All 5 tasks in `loop/IMPLEMENTATION_PLAN.md` are `[x]`
- [x] Any issue still labeled `loop:needs-info` at the time all other criteria are met is
      reported as an open gap in `loop/PROGRESS.md` — completion still requires either a fix
      or an explicit human decision to drop that issue from this milestone, not a silent skip
      (none were labeled `loop:needs-info` at close-out; verified via `gh issue list --label
      loop:needs-info --state all`, empty result)

## Completion signal

When all above are satisfied:

1. Update `loop/HANDOFF.md`
2. Create file `.loop/COMPLETE`
3. Print sentinel (informational only): `LIBREDB-STUDIO-BUGSWEEP-1-DONE`
