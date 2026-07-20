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
