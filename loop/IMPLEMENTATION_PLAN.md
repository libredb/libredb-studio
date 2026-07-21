# Implementation Plan — Milestone oracle-thick-mode

> Hand-authored directly from #228 (human-listed path; see `loop/ACCEPTANCE.md`'s header note).
> The sanitized spec in `loop/TRIAGE.md` is each task's authoritative acceptance bar; this file
> orders the work. Split into two sub-tasks — same rationale as the prior milestone's `#96a`/
> `#96b` split: a process-singleton-safe init guard, a new error-mapping branch, and doc tri-sync
> for two independent concerns risk overrunning one iteration (2700s timeout) if done together.
>
> Every task: test-first (record RED evidence in `loop/PROGRESS.md`), one commit, full gate
> (`bun run format && bun run lint && bun run typecheck && bun run test && bun run build`), then
> the mandatory fresh-context `loop-reviewer` pass before committing.

## Phase 1 — Oracle Thick-mode opt-in and honest error mapping (#228)

- [x] **#228a** — `ORACLE_CLIENT_LIB_DIR` env var opts into Thick mode; Thin mode stays the
  unconditional default.
  - Test first: a test asserting `initOracleClient` is called with `{ libDir: <env value> }`
    when `ORACLE_CLIENT_LIB_DIR` is set, is NOT called when unset (today's behavior — the
    provider destroys the function reference instead), and — the key regression this task
    exists to pin — is called **at most once** across two `OracleProvider` construction calls
    in the same process (node-oracledb throws if `initOracleClient()` runs twice or after a
    connection/pool already exists, so a naive "call it every constructor" fix would break the
    second connection opened by a running server).
  - Implement: replace the unconditional `oracledb.initOracleClient = undefined` in the
    constructor (`src/lib/db/providers/sql/oracle.ts`) with a module-level guarded call —
    invoke `oracledb.initOracleClient({ libDir })` at most once per process, only when
    `process.env.ORACLE_CLIENT_LIB_DIR` is set, before any pool/connection is created. Let
    `initOracleClient()`'s own error (bad `libDir`, Instant Client not found) surface rather
    than being swallowed. No per-connection config field — node-oracledb's Thin/Thick mode is a
    process-wide singleton (verify this in the installed `oracledb` package/docs before
    implementing, don't just trust the spec's citation).
  - Tri-sync: `docs/providers/oracle.md` — §1/§3.5 gain the env var (config table + short usage
    note), consistent with how other server-side-only env vars are documented elsewhere in the
    repo (check `.env.example` conventions).
  - Out of scope: a per-connection `oracleClientLibDir` field (see spec rationale).

- [x] **#228b** — NJS-138 (pre-12.1 server, Thin-mode incompatible) maps to a distinct,
  non-retryable error instead of a generic retryable `CONNECTION_ERROR`.
  - Test first: a test driving `connect()` (or `mapDatabaseError()` directly, whichever the
    existing test convention in `tests/integration/db/oracle-provider.test.ts` favors) with an
    error whose message contains the driver's actual NJS-138 wording (verify the exact string
    against the installed `oracledb` package's error catalogue — don't guess it) asserts: (a)
    the resulting error is NOT retryable (`isRetryableError()` returns false, or the new error
    type is excluded the same way `AuthenticationError`/`DatabaseConfigError` already are); (b)
    the message names the version incompatibility and points at `ORACLE_CLIENT_LIB_DIR`. RED
    evidence: today this case falls through to the bare `ConnectionError` thrown directly in
    `connect()`'s catch block (never reaches `mapDatabaseError()` at all), so the existing
    retryable/503 behavior is what the test must show failing first.
  - Implement: add an `ora`/`njs`-138-aware branch, and route `connect()`'s catch block through
    `mapDatabaseError()` (or add an equivalent explicit pre-check) so the branch is reachable —
    today it structurally cannot be, since `connect()` builds a `ConnectionError` directly and
    never calls `mapDatabaseError()`. Keep the existing ORA-* branches and their tests green.
  - Tri-sync: `docs/providers/oracle.md` §14 Known limitations gains an NJS-138 entry describing
    the new non-retryable error and pointing at #228a's env var as the fix.
  - Constraint: `isRetryableError()`'s existing behavior for every other error type must stay
    unchanged (only the new case is added) — existing tests pin this; don't weaken them.

## Phase F — close out

- [ ] Reconcile `loop/PROGRESS.md` / `loop/HANDOFF.md`; verify every `loop/ACCEPTANCE.md`
  criterion against actual repo state (not prior entries' self-report); create `.loop/COMPLETE`;
  print `LIBREDB-STUDIO-ORACLE-THICK-MODE-DONE`.

## Out of scope (this milestone — do not touch)

- A per-connection `oracleClientLibDir` config field (rejected by the spec — incompatible with
  node-oracledb's actual process-wide Thin/Thick singleton).
- Bundling Oracle Instant Client into the Docker image or any packaging/workflow change — the
  env var only points at a user-supplied path; no infra changes are in scope or permitted
  without human escalation (PROMPT.md 1b).
- Every other open issue — this milestone is scoped to #228 only; the untriaged pool is
  otherwise unmodified (no triage mode ran).
