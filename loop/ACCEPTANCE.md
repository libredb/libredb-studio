# Acceptance Criteria — Milestone oracle-thick-mode

> Human-listed path: this milestone's scope was fixed before the loop started (issue #228 only),
> so triage mode was skipped and this file was hand-authored directly from the sanitized spec in
> `loop/TRIAGE.md`, mirroring the "Bug Sweep 1" precedent recorded in `loop/archive/`. Planning
> mode may still run to expand `loop/IMPLEMENTATION_PLAN.md` from the single queued issue below,
> or a human may hand-author the plan too (done here, see IMPLEMENTATION_PLAN.md).
>
> Queue source: #228 — `loop:queued`, sanitized spec in `loop/TRIAGE.md`. The spec's "Acceptance
> bar (testable)" section is the authoritative detailed bar; the lines below are the summary
> checklist.
>
> The completion sentinel for this milestone is `LIBREDB-STUDIO-ORACLE-THICK-MODE-DONE`; the
> marker file `.loop/COMPLETE` remains the only authoritative signal.

## Functional

- [x] #228a — Optional Thick-mode opt-in: a new `ORACLE_CLIENT_LIB_DIR` env var, when set, makes
      the provider call `oracledb.initOracleClient({ libDir: <value> })` instead of destroying
      the function reference; when unset, behavior is unchanged (Thin mode, no call). The call
      happens at most once per process and before any pool/connection creation — pinned by a
      test that constructs two `OracleProvider` instances in one process and asserts at most one
      call. No per-connection config field (node-oracledb's Thin/Thick choice is a process-wide
      singleton — see the spec's approach hint). Commit `75dbb70`.
- [x] #228b — NJS-138 (Thin-mode-incompatible pre-12.1 server) maps to a distinct,
      **non-retryable** error with a message naming the version incompatibility and pointing at
      `ORACLE_CLIENT_LIB_DIR`; `connect()`'s catch block is routed through `mapDatabaseError()` (or
      gains an equivalent explicit check) so the mapping is actually reachable. Commit `f701a5b`.
- [x] `docs/providers/oracle.md` updated in the same PR as each of the above (tri-sync): Thin-mode
      pre-12.1 caveat, the new env var documented, NJS-138 known-limitation entry.

## Quality

- [x] Built test-first; every change has a regression test that fails before the fix and passes
      after (RED evidence recorded in `loop/PROGRESS.md`)
- [x] Full gate green on a clean working tree — WITH A RECORDED CAVEAT: `bun run format`,
      `bun run lint`, `bun run typecheck`, `bun run knip`, and `bun run build` all ran literally
      as CLAUDE.md specifies and are green. `bun run test` (the literal 5th command) hangs
      indefinitely on this dev machine — a pre-existing, environment-specific issue (documented
      in `docs/providers/oracle.md` §12.1 and root CLAUDE.md's "Coverage isolation" section;
      reproduced with zero changes applied, not caused by this milestone) — so
      `bun run test:ci` (the documented deterministic equivalent, same test files, per-file
      isolated) was run instead for both tasks. Full details and the 9 pre-existing/unrelated
      failing files in the `#228a`/`#228b` `loop/PROGRESS.md` entries.
- [x] Every task's `loop-reviewer` verdict is PASS or PASS WITH NOTES, recorded in
      `loop/PROGRESS.md` — both PASS, no HIGH/MEDIUM findings.
- [x] No placeholder/stub implementations in shipped code paths
- [x] No new npm dependency (node-oracledb already supports Thick mode; only conditional wiring
      is needed) — confirmed true; `package.json`/`bun.lock` diffs are empty for both commits.

## Documentation

- [x] `docs/providers/oracle.md` (code ↔ doc ↔ test tri-sync, since this is a provider-triad
      change per the root CLAUDE.md rule) — the doc mirrors the code in the same commit as each
      sub-task, not a follow-up
- [x] `loop/PROGRESS.md` and `loop/HANDOFF.md` reflect actual state

## Process

- [x] Both tasks in `loop/IMPLEMENTATION_PLAN.md` are `[x]` (or explicitly re-routed via 1a/1b
      with the label and PROGRESS record to show for it — never silently dropped)
- [x] No GitHub mutations beyond `loop:*` labels and 1a clarifying comments; no non-loop labels
      touched; nothing closed (#228 stays open — a human closes it at PR merge) — no `gh` commands
      of any kind were run this milestone.

## Completion signal

When all above are satisfied:

1. Update `loop/HANDOFF.md`
2. Create file `.loop/COMPLETE`
3. Print the sentinel (informational only): `LIBREDB-STUDIO-ORACLE-THICK-MODE-DONE`
