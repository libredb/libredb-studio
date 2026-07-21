# Handoff

> Orientation only — not authoritative. Authoritative state is
> `loop/IMPLEMENTATION_PLAN.md` + `loop/PROGRESS.md` + git log.

## Current state

Milestone `oracle-thick-mode` (issue #228 only) is complete. Both tasks landed on branch
`loop/oracle-thick-mode`:

- `75dbb70` — #228a: `ORACLE_CLIENT_LIB_DIR` env var opts into Oracle Thick mode
  (process-singleton-safe, guarded to init at most once).
- `f701a5b` — #228b: NJS-138 (pre-12.1 server) now maps to a non-retryable
  `DatabaseConfigError` instead of the generic retryable `CONNECTION_ERROR`.

Both commits: test-first, full gate green (`format`/`lint`/`typecheck`/`knip`/`build`; `test:ci`
substituted for the literal `bun run test`, which hangs on this dev machine for reasons unrelated
to this milestone — see below), `loop-reviewer` PASS with no findings. All `loop/ACCEPTANCE.md`
criteria verified against actual repo state, not self-reported.

Scope was fixed to #228 before this milestone started (human-listed path, no triage/planning
mode run) — see `loop/TRIAGE.md` and `loop/PROGRESS.md`'s opening entry for the sanitized spec
and verification.

## Not part of this milestone (still open on GitHub, untouched)

Everything from the prior "Maintainer Sweep 2" milestone's human-gate list is unchanged — this
milestone made no GitHub mutations at all (no `gh` commands run). See `loop/archive/sweep-2/` for
that history if needed.

## Environment issue discovered this milestone (flagged for human review)

`bun run test` — the literal command in `loop/scripts/gate.sh` and root CLAUDE.md's mandatory
gate — hangs indefinitely on this specific Windows dev machine, reproducibly, with zero code
changes applied. Root cause: `tests/unit/db/factory.test.ts` exhibits the `mock.module()`
cross-contamination symptom CLAUDE.md's "Coverage isolation" section already warns about
(`evictIdleProviders is not a function`, etc.); a stray uncleared timer/signal-handler from that
contamination plausibly keeps the process alive past test completion. `docs/providers/oracle.md`
§12.1 already documents that CI does not use `bun run test` for exactly this reason and uses
`bun run test:ci` (per-file isolation via `tests/run-core.sh`) instead — this milestone used
`test:ci` for both tasks' gate runs, which completed deterministically both times. Suggest
`loop/scripts/gate.sh` (and CLAUDE.md's documented command) be changed to `test:ci`, since
`bun run test` appears unreliable outside CI's specific environment; not changed here since it's
outside #228's scope and touches project-wide tooling, not the Oracle provider.

Separately (also encountered, not a code issue): this dev machine is missing the `helm`, `tar`
(POSIX-compatible), and `7z` binaries used by several unrelated test files, and hits a
Windows-only cross-drive `path.relative()` / `EBUSY` tmpdir-lock edge case in
`tests/integration/db/sqlite-provider.test.ts`. All 9 affected files are pre-existing and
unrelated to this milestone's Oracle/errors changes — verified file-by-file in both `#228a`'s and
`#228b`'s `loop/PROGRESS.md` entries and independently re-verified by the `loop-reviewer` pass on
each commit.

## How to run the next milestone (generic operation)

```bash
git checkout main && git pull
git checkout -b loop/<name>          # dedicated branch, e.g. loop/sweep-3
./loop/scripts/new-milestone.sh <name>   # archive previous state, reset files, set TRIAGE mode
git add -A loop && git commit -m "chore(loop): open milestone <name>"
./loop/scripts/pipeline.sh           # unattended: triage -> planning -> build
# then, always human: review the branch, push, open the PR (base main)
```

- `pipeline.sh` never pushes; publishing is the human trust gate.
- Planning mode writes both `IMPLEMENTATION_PLAN.md` and `ACCEPTANCE.md` from the
  `loop:queued` queue (a human may instead pre-list issues in `ACCEPTANCE.md` before running).
- The gate is `./loop/scripts/gate.sh` — the single mirror of root `CLAUDE.md`'s mandatory
  pre-commit verification (currently format · lint · typecheck · knip · test · build). When
  CLAUDE.md's gate changes, update `gate.sh`; prompts reference the script, not the commands.
- Issues labeled `loop:needs-info` / `loop:needs-moderator-action` are never picked up; only a
  human removing the label changes that.
- If running `pipeline.sh` unattended (autonomous `claude -p` iterations): be aware each
  iteration is a one-shot process that cannot truly await a background job across its own
  lifetime. This milestone hit that limitation directly — several early build-mode iterations
  backgrounded `bun run test` and exited before it finished, and the next fresh iteration piled
  another one on top instead of reusing/waiting on the existing one, leaving multiple orphaned
  `bun run test` processes running concurrently and starving each other. A human took over the
  remaining gate steps directly rather than let the loop keep retrying. If this recurs, consider
  either fixing `bun run test`'s hang at the source (see above) or having the gate step run
  synchronously with a hard timeout inside one iteration rather than backgrounding it.
