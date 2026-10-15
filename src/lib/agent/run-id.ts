/**
 * Ids are `[A-Za-z0-9_]` and bounded: no `-` (see the docblock of `run-store.ts`), no `.` (the
 * backend refuses it). It is a property of the LEDGER, because a run id becomes a stream name, so
 * the run store and the drive token both check against this one definition rather than against a
 * second copy that could drift from it.
 *
 * It lives in a module of its own, which imports nothing, because the proxy verifies drive tokens:
 * importing it from `run-store.ts` would pull the agent's configuration, and through it the
 * governance settings store, into the proxy's module graph, which docs/GOVERNANCE.md#runtime-settings rules out
 * (tests/unit/governance-proxy-boundary.test.ts).
 */
export const AGENT_RUN_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
