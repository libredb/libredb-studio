# Progress Log (lab notebook)

> Append-only during the loop. This file is the loop's cross-iteration memory: the next
> fresh-context iteration learns dead ends, pinned decisions, and known limitations ONLY from here
> and from git history. Thin entries starve later iterations — write decision-record grade notes.

## Entry anatomy (follow this shape)

```markdown
### YYYY-MM-DD — {{issue # and title}} (DONE | BLOCKED | NEEDS-INFO)

- Tests first: {{suite/file, N new cases}}; watched them fail RED ({{the actual failure message}})
  before implementing.
- {{What was built or changed — one or two factual sentences.}}
- DECISION — {{the decision, pinned}}: {{rationale in one or two sentences; what was rejected and
  why}}. (add "flagged for human review" when non-obvious)
- KNOWN LIMITATION (recorded): {{honest deferral or edge left open, and why it is acceptable now}}.
- Gate: typecheck OK, lint clean, {{N}} tests pass (was {{M}}; +{{K}}), build OK.
- Next: {{the single next task, per the plan}}.
```

Rules:

- Record decisions WITH their reasoning. A bare "chose X" cannot stop a later fresh-context
  iteration from re-litigating X; the rationale can.
- Record failures and dead ends explicitly — preventing re-attempts is this file's whole purpose.
- Record known limitations at the moment you accept them, not when they bite.
- Tag anything a human should re-check with "flagged for human review".
- Include the gate numbers (test count delta) so progress is measurable, not narrated.
- `needs-info` triage evaluations (step 0f) get their own entry too — quote the reply verbatim.

---

## Log

> Earlier milestones are archived under `loop/archive/` (one directory per
> milestone). Consult them only when a task genuinely needs that history.

### 2026-07-20 — Milestone oracle-thick-mode opened (human)

- State reset by `loop/scripts/new-milestone.sh oracle-thick-mode`; previous milestone
  (sweep-2) archived to `loop/archive/sweep-2/`.
- Scope fixed before the loop started: issue #228 only (Oracle provider hardcodes Thin mode,
  no Thick-mode opt-in; NJS-138 pre-12.1 failures surface as a generic retryable
  `CONNECTION_ERROR`). Triage mode was skipped — human-listed path, same precedent as "Bug
  Sweep 1" (see `loop/archive/sweep-2/` history) — since the scope is one already-verified
  issue, not the open tracker.
- Verified both of the issue's claims directly in code before queuing (not taken at face
  value): (1) `src/lib/db/providers/sql/oracle.ts` constructor destroys
  `oracledb.initOracleClient` unconditionally on every instantiation, and no
  `ORACLE_CLIENT_LIB_DIR`/`initOracleClient`/`oracleClientLibDir` configuration surface exists
  anywhere in the repo (grepped clean); (2) `connect()`'s catch block builds a bare
  `ConnectionError` directly and never calls `mapDatabaseError()`, and `mapDatabaseError()`
  itself has no `njs-`/NJS-138 branch (only `ora-01017`/`ora-12541`/`ora-12154`/`tns:`/
  `ora-00942`) — so a pre-12.1 NJS-138 failure is structurally indistinguishable from a
  transient network blip by the time it reaches the API layer (`CONNECTION_ERROR`/503/
  `retryable: true`).
- Hand-authored `loop/TRIAGE.md` (#228 sanitized spec), `loop/ACCEPTANCE.md`, and
  `loop/IMPLEMENTATION_PLAN.md` directly from that verification, splitting the work into two
  ordered sub-tasks (#228a Thick-mode opt-in, #228b NJS-138 error mapping) — same rationale as
  the prior milestone's `#96a`/`#96b` split, since a process-singleton-safe init guard and a
  new error-mapping branch are independent concerns that risk overrunning one 2700s iteration
  together.
- DECISION — env var only (`ORACLE_CLIENT_LIB_DIR`), not a per-connection config field (the
  issue's alternative): node-oracledb's Thin/Thick mode choice is a process-wide singleton
  (`oracledb.initOracleClient()` may run at most once per process, before any pool/connection
  exists), so a per-connection field cannot actually deliver per-connection behavior — every
  `OracleProvider` in the process shares one driver mode regardless of which connection's
  config it reads from. Recorded in `loop/TRIAGE.md` so build mode does not re-litigate this.
- `loop/config/loop.env` set to BUILD mode directly (`LOOP_PROMPT_FILE="loop/PROMPT.md"`)
  rather than the `new-milestone.sh` default of TRIAGE mode — triage and planning were both
  hand-done in this entry.
- Next: build mode, task #228a (first unchecked task in the plan).

### 2026-07-21 — #228a Oracle Thick-mode opt-in via ORACLE_CLIENT_LIB_DIR (DONE)

- Tests first: 2 new cases in `tests/integration/db/oracle-provider.test.ts` (new "Thick-mode
  opt-in (ORACLE_CLIENT_LIB_DIR)" block); the mock's `initOracleClient` was upgraded from a bare
  `undefined` to a real `mock()` fn so calls could be asserted. Watched RED first: with only the
  test file staged (provider code still on the old unconditional
  `initOracleClient = undefined`), "calls initOracleClient with libDir at most once, even across
  multiple providers" failed — `Received number of calls: 0` vs expected `1` (the "unset → not
  called" case passes either way, since old code never *calls* the function, it only destroys
  the reference — not a tautology, confirmed by reverting only the provider file and re-running).
- Built: constructor now reads `process.env.ORACLE_CLIENT_LIB_DIR`; when set, calls
  `oracledb.initOracleClient({ libDir })` exactly once (guarded by a new module-scope
  `thickClientInitialized` flag) before any pool/connection exists; when unset, behavior is
  unchanged (Thin mode, no call). Thin mode stays the unconditional default.
- DECISION — env var only, no per-connection field: pinned already in this milestone's opening
  entry (see above); re-verified against the actual `oracledb` driver behavior during
  implementation, not just assumed from the spec.
- Ran into an infrastructure problem, not a code problem: several autonomous loop iterations
  (build mode, `claude -p` one-shot invocations) got stuck repeatedly backgrounding
  `bun run test` and exiting before it finished, each fresh-context iteration re-discovering the
  same interrupted state. Root cause found on manual inspection: FIVE concurrent orphaned
  `bun run test` processes (from iterations 4, 5, 6, and stray retries) were all running at once
  on this machine, competing for resources — each iteration's background test invocation
  survived past that iteration's own process exit (nested `claude -p` has no mechanism to await
  a background job across its own one-shot lifetime), and the next fresh iteration piled another
  one on top instead of reusing/waiting on the existing one. Killed all orphaned
  `bun`/`gate.sh`/`loop.sh` processes and took over the remaining gate steps directly (a
  persistent session can actually wait on a background process across turns; a one-shot `-p`
  iteration cannot) rather than let the autonomous loop keep retrying the same non-convergent
  pattern for its remaining iteration budget.
- KNOWN LIMITATION (recorded, environment-specific, not a code issue): `bun run test` — the
  literal command in `loop/scripts/gate.sh` / root CLAUDE.md's mandatory gate — hangs
  indefinitely on this machine even in isolation (single run, no contention), stalling right
  after `tests/unit/db/factory.test.ts`. That file's tests exhibit the exact `mock.module()`
  cross-contamination symptom CLAUDE.md's "Coverage isolation" section warns about
  (`evictIdleProviders is not a function` etc.) when run in the shared-process core group, and a
  stray uncleared timer/signal-handler from that contamination plausibly keeps the process alive
  past test completion. This is corroborated by `docs/providers/oracle.md` §12.1, which already
  documents that CI does NOT use `bun run test` for exactly this reason and uses
  `bun run test:ci` (per-file isolation via `tests/run-core.sh`) instead. Substituted
  `bun run test:ci` for this task's gate run — same test files, deterministic execution, and
  what CI's required check actually exercises. Flagged for human review: `gate.sh` (and
  CLAUDE.md's documented command) should arguably say `test:ci`, since `bun run test` is
  apparently unreliable outside CI's specific environment; not changed here since it's outside
  #228's scope and touches project-wide tooling docs, not the Oracle provider.
- Gate: `bun run format` clean, `bun run lint` 0 errors, `bun run typecheck` clean,
  `bun run knip` clean, `bun run test:ci` → `tests/integration/db/oracle-provider.test.ts` 64
  pass / 0 fail (including the 2 new cases); 9 of 159 core files failed, all verified unrelated
  to this diff and specific to this Windows dev machine (4 need the `helm` binary, not installed
  here; 2 need `tar`/`7z`, missing/misbehaving here; 1 exercises the loop pipeline itself; 1,
  `tests/integration/db/sqlite-provider.test.ts`, hits a Windows-only cross-drive
  `path.relative()` edge case plus an `EBUSY` tmpdir-cleanup file lock — none import or
  transitively touch `oracle.ts`, confirmed by grep and by the loop-reviewer pass below).
  `bun run build` exit 0.
- loop-reviewer verdict: PASS, no findings (independently re-verified the RED/GREEN split, the
  64/0 oracle suite result, provider-triad completeness, and that the 9 unrelated failures share
  no import with Oracle code).
- Next: #228b (NJS-138 → distinct non-retryable error), per the plan.
