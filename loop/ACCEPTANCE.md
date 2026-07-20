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

- [ ] #228a — Optional Thick-mode opt-in: a new `ORACLE_CLIENT_LIB_DIR` env var, when set, makes
      the provider call `oracledb.initOracleClient({ libDir: <value> })` instead of destroying
      the function reference; when unset, behavior is unchanged (Thin mode, no call). The call
      happens at most once per process and before any pool/connection creation — pinned by a
      test that constructs two `OracleProvider` instances in one process and asserts at most one
      call. No per-connection config field (node-oracledb's Thin/Thick choice is a process-wide
      singleton — see the spec's approach hint).
- [ ] #228b — NJS-138 (Thin-mode-incompatible pre-12.1 server) maps to a distinct,
      **non-retryable** error with a message naming the version incompatibility and pointing at
      `ORACLE_CLIENT_LIB_DIR`; `connect()`'s catch block is routed through `mapDatabaseError()` (or
      gains an equivalent explicit check) so the mapping is actually reachable.
- [ ] `docs/providers/oracle.md` updated in the same PR as each of the above (tri-sync): Thin-mode
      pre-12.1 caveat, the new env var documented, NJS-138 known-limitation entry.

## Quality

- [ ] Built test-first; every change has a regression test that fails before the fix and passes
      after (RED evidence recorded in `loop/PROGRESS.md`)
- [ ] Full gate green on a clean working tree: `bun run format && bun run lint && bun run typecheck && bun run test && bun run build`
- [ ] Every task's `loop-reviewer` verdict is PASS or PASS WITH NOTES, recorded in
      `loop/PROGRESS.md`
- [ ] No placeholder/stub implementations in shipped code paths
- [ ] No new npm dependency (node-oracledb already supports Thick mode; only conditional wiring
      is needed) — if build mode finds this untrue, stop and escalate per PROMPT.md 1b rather
      than adding one

## Documentation

- [ ] `docs/providers/oracle.md` (code ↔ doc ↔ test tri-sync, since this is a provider-triad
      change per the root CLAUDE.md rule) — the doc mirrors the code in the same commit as each
      sub-task, not a follow-up
- [ ] `loop/PROGRESS.md` and `loop/HANDOFF.md` reflect actual state

## Process

- [ ] Both tasks in `loop/IMPLEMENTATION_PLAN.md` are `[x]` (or explicitly re-routed via 1a/1b
      with the label and PROGRESS record to show for it — never silently dropped)
- [ ] No GitHub mutations beyond `loop:*` labels and 1a clarifying comments; no non-loop labels
      touched; nothing closed (#228 stays open — a human closes it at PR merge)

## Completion signal

When all above are satisfied:

1. Update `loop/HANDOFF.md`
2. Create file `.loop/COMPLETE`
3. Print the sentinel (informational only): `LIBREDB-STUDIO-ORACLE-THICK-MODE-DONE`
