# Implementation Plan — Maintainer Bug Sweep 1

> Live task list for the maintainer loop. Hand-authored directly from 5 filed issues — planning
> mode was skipped for this milestone since the scope was already fully known.
> Acceptance: `loop/ACCEPTANCE.md`.

## Phase 1 — local-first bind and state location (packaging wrappers)

- [x] **#134** — Force `packaging/linux/libredb-studio` and
  `packaging/homebrew/libredb-studio.rb.tmpl` to bind `127.0.0.1` by default on a direct run.
  Test first: exercise the wrapper (or the shared logic it should factor out) with (a) `HOSTNAME`
  unset, (b) `HOSTNAME` set to an inherited value (simulating Docker's container-id export), and
  (c) an explicit opt-in bind variable set — assert the effective bind address in each case.
  Mirror the npx launcher's already-correct logic (see `bin/lib/launcher-utils.mjs` and its test
  `tests/unit/launcher-utils.test.ts` for the existing pattern/convention to follow). Suggested
  shape from the issue: translate an explicit opt-in var (e.g. `LIBREDB_BIND`) into `HOSTNAME`,
  otherwise force `127.0.0.1` — do not just fall back on an empty-`HOSTNAME` check, since the
  inherited-hostname case (Docker) also needs covering.

- [x] **#135** — Default the Homebrew formula's bin wrapper
  (`packaging/homebrew/libredb-studio.rb.tmpl`) to store zero-config state outside the versioned
  Cellar keg. Test first: exercise the wrapper and assert the effective data/state directory is
  NOT under `.../Cellar/libredb-studio/<version>/...`. Suggested shape from the issue: export
  `STORAGE_SQLITE_PATH` (or equivalent) under `$(brew --prefix)/var/libredb-studio/` or XDG state,
  matching what `packaging/linux/libredb-studio` already does for direct deb/rpm runs — read that
  file first as the reference implementation.

## Phase 2 — npx launcher and standalone tarball

- [x] **#132** — Stop `npx @libredb/studio --verify-cache` (and `--archive`) from wiping
  `payload/data/` on re-extraction. Test first: in `tests/unit/launcher-utils.test.ts`'s style,
  simulate an existing `payload/data/auth-bootstrap.json`, run the verify-cache re-extraction
  path, and assert the file is preserved (or restored) rather than overwritten. Suggested shape
  from the issue: keep `data/` outside the extracted payload root, or explicitly preserve/restore
  `payload/data` across re-extraction in `bin/lib/launcher-utils.mjs`.

- [x] **#133** — Make `scripts/build-standalone-payload.sh` package the tarball under a
  top-level `libredb-studio-<version>/` directory instead of tarbomb-style root entries. Test
  first: run the packaging script (or a scoped unit test around its tar invocation) and assert
  `tar tzf <artifact> | head` entries are prefixed with `libredb-studio-<version>/`, not `./`.
  Then verify the npx launcher's extraction path (which currently expects the payload at archive
  root — check `bin/lib/launcher-utils.mjs`) is updated to match the new layout in the SAME task,
  since the issue notes these must change together. Do not silently break deb/rpm/snap/brew
  packaging that consumes the payload — check whether any of those reference the archive root
  path directly.

## Phase 3 — Helm chart persistence

- [x] **#137** — Give a default Helm install (`persistence.enabled=false`) a writable
  `/app/data` so the embedded sample seeds. Test first: whatever test convention already covers
  `charts/libredb-studio` (check for existing helm-lint/template/E2E test patterns before
  inventing one) — assert that with default values, a rendered pod spec has a writable mount at
  `/app/data`, and/or that the login → open "Sample (LibreDB)" → query E2E flow passes without
  `--set persistence.enabled=true`. Suggested shape from the issue: mount an `emptyDir` at
  `/app/data` when persistence is disabled, consistent with the existing `next-cache`/`tmp`
  emptyDirs in `charts/libredb-studio/templates/deployment.yaml`.

## Phase F — close out

- [x] Reconcile `loop/PROGRESS.md` / `loop/HANDOFF.md`; verify all `loop/ACCEPTANCE.md` criteria;
  create `.loop/COMPLETE`

## Later (NOT this milestone)

- #175 (Dokploy template version bump) — different repo/toolchain, out of scope (see design spec)
- #124 (trim standalone payload repo-root extras) — related to #133 but explicitly a separate,
  larger issue; do not fold in
