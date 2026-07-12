# Acceptance Criteria — Maintainer Sweep 2

> Current milestone definition of "done" for the maintainer loop.
> The agent may create `.loop/COMPLETE` only when every criterion below is true and the gate
> is green.
> Queue source (autonomous path): issues labeled `loop:queued` at planning time — #45, #96,
> #124, #125, #126, #136, #151 — each with a sanitized spec in `loop/TRIAGE.md`. The spec's
> "Acceptance bar (testable)" section is the authoritative detailed bar per issue; the lines
> below are the summary checklist.

## Functional

- [x] #126 — `getCapabilities().supportsExplain` is `false` for the oracle and mssql providers;
      their integration tests assert `false`; both provider docs' capability tables and
      known-limitation sections updated in the same commit (tri-sync).
- [x] #136 — a render-level helm test pins the minimal two-secret install (renders cleanly with
      no `USER_PASSWORD` env and no user-password secret key) and the with-user-password render
      (produces both); the test fails if the secret template's conditional reverts to a hard
      require.
- [x] #45 — chart hardening, all four gaps: (1) `values.schema.json` covers the previously
      unvalidated keys; (2) JWT secret length machine-enforced as empty-OR->=32 (empty stays
      valid for zero-config); (3) explicit `minAvailable: 0` renders in the PDB; (4) autoscaling
      enabled + sqlite storage cannot render a multi-replica HPA. `helm lint --strict` stays
      clean; Chart.yaml version bump in the same commit (repo rule for chart-content changes).
- [x] #96 — results rendering phase 1: value classifier with unit tests; scalar output parity
      pinned; json-kind values render pretty-printed (whitespace-preserving) in the detail sheet
      while grid cells stay compact; renderer selection is registry-based with no
      connection-type conditionals; masking short-circuits before renderer selection; NO new
      dependencies (escalate per 1b if one turns out to be required); platform-integration rules
      respected and `build:lib` run.
- [x] #124 — payload prune: deny-list prune step in `scripts/build-standalone-payload.sh`
      covered by a fixture test (planted extras removed, keep-list survives — including
      dot-directories like `.next`); a real build's tarball listing contains no `docs/`,
      `charts/`, `e2e/`, `tests/`, `CLAUDE.md`, `bun.lock`, `fly.toml`, or docker-compose
      entries; the script's `--smoke` self-test still passes. No workflow edits.
- [x] #125 — sqlite path guard honesty: integration test pins NUL-byte rejection AND
      `..`-segment acceptance; the dead traversal branch, its comment, and the error-message
      claim are gone; `docs/providers/sqlite.md` updated in the same commit (tri-sync). The
      base-dir allowlist option is explicitly out of scope.
- [x] #151 — version-sync guard: merge-base comparison (stale-branch fixture passes `--check`);
      single shared tag-query gating predicate; distinct strict-mode messages for missing-ref vs
      unparseable-Chart.yaml; no silent first-match-only drift on duplicated version lines;
      strict tag-query-null path tested; `CHART_SYNC_STRICT` documented in `docs/HELM_CHART.md`.
      `ci.yml` untouched; `bun run chart:check` stays green throughout.

## Quality

- [x] Built test-first; every change has a regression test that fails before the fix and passes
      after (RED evidence recorded in `loop/PROGRESS.md`)
- [x] Full gate green on a clean working tree: `bun run format && bun run lint && bun run typecheck && bun run test && bun run build`
- [x] Every task's `loop-reviewer` verdict is PASS or PASS WITH NOTES, recorded in
      `loop/PROGRESS.md`
- [x] No placeholder/stub implementations in shipped code paths

## Documentation

- [x] Provider tri-sync respected where providers changed (#126 oracle/mssql, #125 sqlite):
      code, `docs/providers/<type-id>.md`, and the provider tests move in the same commit
- [x] Any other documented behavior change lands with its doc update in the same commit
- [x] `loop/PROGRESS.md` and `loop/HANDOFF.md` reflect actual state

## Process

- [x] All 7 tasks in `loop/IMPLEMENTATION_PLAN.md` are `[x]` (or explicitly re-routed via 1a/1b
      with the label and PROGRESS record to show for it — never silently dropped)
- [x] #94 (`loop:needs-info`, awaiting reporter) is reported as an open gap at close-out — it is
      NOT part of this milestone's completion
- [x] No GitHub mutations beyond `loop:*` labels and 1a clarifying comments; no non-loop labels
      touched; nothing closed
- [x] Issues labeled `loop:needs-moderator-action` (including #40, #123, #127, #167) were not
      touched by build mode

## Completion signal

When all above are satisfied:

1. Update `loop/HANDOFF.md`
2. Create file `.loop/COMPLETE`
3. Print the sentinel (informational only): `LIBREDB-STUDIO-SWEEP-2-DONE`
