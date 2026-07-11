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

### 2026-07-11 — Milestone setup (DONE, human)

- Plan hand-authored directly from issues #132, #133, #134, #135, #137 — planning mode was not
  run since the scope was already fully known and fixed before the loop started.
- Order chosen: #134, #135 (both touch the packaging wrapper bind/data-dir logic, kept adjacent
  to reuse warm context), then #132, #133 (npx/tarball), then #137 (Helm, largest/most distinct).
- Next: #134.

### 2026-07-11 — #134 local-first bind for deb/rpm and Homebrew direct runs (DONE)

- Tests first: new `tests/unit/packaging-bind-address.test.ts`, 7 cases (4 for the deb/rpm
  wrapper, 3 for the Homebrew formula's embedded launcher script). Each spawns the *real* wrapper
  file as a subprocess against a stub `node` that only echoes `$HOSTNAME`, so the test exercises
  production shell text, not a reimplementation. Watched RED first: all 7 failed (deb/rpm: empty
  stdout, since `set -eu` with no `LIBREDB_STUDIO_HOME` override made the stub node unreachable;
  Homebrew: `HOSTNAME=` empty / `HOSTNAME=3f9a1c2b4d5e` inherited, since neither wrapper touched
  `HOSTNAME` at all before this fix).
- Built: both wrappers now default `HOSTNAME` to `127.0.0.1` unless `LIBREDB_BIND` is set, in
  which case that value becomes `HOSTNAME`. `packaging/linux/libredb-studio` also gained
  `LIBREDB_STUDIO_HOME="${LIBREDB_STUDIO_HOME:-/usr/lib/libredb-studio}"` (was hardcoded) so the
  test can point it at a fixture directory instead of the real root-owned install path.
- DECISION — the deb/rpm wrapper's bind-forcing is skipped when `INVOCATION_ID` is set (flagged
  for human review): systemd sets this env var for every unit process since systemd 232.
  `ExecStart=/usr/bin/libredb-studio` in `libredb-studio.service` already resolves `HOSTNAME`
  correctly before this wrapper execs (default `127.0.0.1` via the unit's `Environment=` line,
  operator override via `HOSTNAME=0.0.0.0` in `/etc/libredb-studio/env`'s `EnvironmentFile=`).
  Without the `INVOCATION_ID` guard, forcing `HOSTNAME` unconditionally in the wrapper would have
  silently broken that already-correct, already-documented systemd override path (the wrapper
  would reset an operator's `HOSTNAME=0.0.0.0` back to loopback, since only `LIBREDB_BIND` would
  be honored). The issue (#134) and `loop/ACCEPTANCE.md` both scope the fix to "direct runs" — the
  systemd/brew-services paths were explicitly called out as already correct — so this guard keeps
  the fix surgical to the two files the plan names, with no edits to
  `packaging/linux/libredb-studio.service` or `packaging/linux/env`. Rejected alternative: migrate
  the whole package to a single `LIBREDB_BIND` knob (systemd unit + env file included) - cleaner
  long-term but touches files outside the issue's stated scope and changes already-working,
  documented systemd behavior; not attempted here.
- DECISION — no `INVOCATION_ID`-equivalent guard needed for the Homebrew wrapper: `brew services`
  already hardcodes `HOSTNAME: "127.0.0.1"` in the rendered formula's `service do` block (no
  operator override mechanism exists there to protect), so forcing `HOSTNAME` unconditionally
  computes the same value brew services already passed in. The only prior "override" was the
  `service do` block's own comment ("run the binary manually with HOSTNAME=0.0.0.0") - updated to
  `LIBREDB_BIND=0.0.0.0` in the same file, since that manual/direct run is exactly the case this
  fix targets.
- Also updated `docs/DISTRIBUTION.md`'s bind-address table: added a ".deb / .rpm (direct run)" row
  and changed the Homebrew row's opt-in from `HOSTNAME=0.0.0.0` to `LIBREDB_BIND=0.0.0.0`, plus a
  paragraph explaining the systemd-vs-direct-run split via `INVOCATION_ID`.
- KNOWN LIMITATION (recorded): the npx launcher (`bin/studio.js`) has the same latent gap (only
  checks `if (!env.HOSTNAME)`, so an inherited Docker `HOSTNAME` would flow through uncorrected)
  but is explicitly out of scope for #134 (issue and acceptance criteria name only the deb/rpm and
  Homebrew wrappers, and the npx launcher's own docs treat `HOSTNAME` as an intentional `--host`
  equivalent, not an ambient value to guard against). Not touched here; flagged for a future issue
  if it proves to bite in practice.
- Gate: format clean, lint clean (0 errors, pre-existing warnings only, none in touched files),
  typecheck OK, 2292 tests pass (was 2285; +7), build OK.
- Next: #135.

### 2026-07-11 — #135 Homebrew direct-run state outside the Cellar keg (DONE)

- Tests first: new `tests/unit/packaging-homebrew-datadir.test.ts`, 2 cases. Extracts the real
  `bin/"libredb-studio"` heredoc from `packaging/homebrew/libredb-studio.rb.tmpl` (same technique
  as the existing `packaging-bind-address.test.ts` Homebrew block) and runs it as a subprocess
  against a stub `node` that echoes `STORAGE_SQLITE_PATH`. Watched RED first: "defaults
  STORAGE_SQLITE_PATH outside the versioned Cellar keg" failed with
  `Received: "STORAGE_SQLITE_PATH=\n"` — the wrapper set no default at all before this fix.
- Root cause confirmed by reading `src/lib/data-dir.ts` (`getDataDir()` = `dirname(STORAGE_SQLITE_PATH
  || "./data/libredb-storage.db")`) and `src/lib/auth-bootstrap.ts` (`resolveBootstrapPath()` joins
  `getDataDir()` + `auth-bootstrap.json`): setting `STORAGE_SQLITE_PATH` alone relocates both the
  zero-config credentials file and any `STORAGE_PROVIDER=sqlite` data — no separate data-dir env
  var exists, so the issue's suggested fix is complete as stated.
- Built: the Homebrew template's bin wrapper heredoc now exports `STORAGE_SQLITE_PATH` (only if
  unset, so an explicit value still wins) to `#{var}/libredb-studio/libredb-storage.db` — a Ruby
  string interpolation resolved once at `brew install` time into a literal absolute path, same
  pattern already used for `#{libexec}` and `#{Formula[...].opt_bin}` in the same heredoc.
- DECISION — reused the exact path the `service do` block already sets
  (`var/"libredb-studio/libredb-storage.db"`), rather than a separate XDG-style location (the
  second option the issue mentioned): unlike systemd's `DynamicUser` isolation between the unit
  and a direct run (which is why the deb/rpm wrapper's direct-run fallback and its systemd unit's
  `/var/lib/libredb-studio` deliberately stay separate), Homebrew has no privilege boundary
  between `brew services start` and running the binary directly — both run as the same user — so
  sharing one location means credentials/data generated in either mode are visible in the other,
  rather than silently forking into two divergent stores. Rejected: XDG state dir (would diverge
  from the service path for no isolation benefit on this platform).
- Updated `docs/DISTRIBUTION.md`'s Homebrew section: replaced the old "set STORAGE_SQLITE_PATH
  manually" instruction with a description of the new automatic default and the shared-location
  rationale.
- KNOWN LIMITATION (recorded): `post_install`'s `(var/"libredb-studio").mkpath` already creates
  the parent directory at install time, and `auth-bootstrap.ts`'s `createBootstrapFile`/
  `writeBootstrapFile` both `mkdirSync(..., { recursive: true })` regardless, so no additional
  directory-creation code was needed in the wrapper itself — verified by reading both call sites
  rather than assumed.
- Gate: format clean, lint clean (0 errors, pre-existing warnings only, none in touched files),
  typecheck OK, all test groups pass (0 fail; +2 new cases in the new file), build OK.
- Next: #132.
