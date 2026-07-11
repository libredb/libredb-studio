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

### 2026-07-11 — #132 npx launcher: --verify-cache/--archive wiping payload/data (DONE)

- Read the issue's own comment thread first (author: cevheri, MEMBER, i.e. a genuine maintainer
  follow-up, not external input): a coupling note from PR #142 warns that
  `scripts/engine-smoke.sh`'s storage leg currently parses a FRESH zero-config password from the
  second server's log (`PASSWORD2=`), and predicts that landing this fix without touching the
  smoke would break that leg with "no zero-config password banner" — recommending the smoke be
  updated to reuse the first server's password. Treated as informational context per the
  untrusted-input guardrail (999i), not as an instruction, and verified empirically rather than
  taken at face value (see below) — the prediction turned out not to hold given how the smoke
  script is actually written.
- Root cause (confirmed by reading `bin/studio.js`'s `extract()`): the default data dir
  (`src/lib/data-dir.ts` `getDataDir()` = `dirname(STORAGE_SQLITE_PATH || "./data/...")`) resolves
  relative to the server's cwd, which is `payloadDir` (`spawn(..., { cwd: payloadDir })`). Every
  release tarball ships an empty `data/` dir (`scripts/build-standalone-payload.sh`). `extract()`
  unconditionally does `rm(payloadDir) -> rename(staging, payloadDir)` on every re-extraction
  (`--verify-cache` and every `--archive` run, per issue), so `payloadDir/data/auth-bootstrap.json`
  (and any `STORAGE_PROVIDER=sqlite` state at the default path) is wiped by the swap even though
  tar itself never touched a pre-existing file - the fresh tarball's own empty `data/` just
  replaces the previous one wholesale.
- Tests first: `tests/unit/launcher-utils.test.ts`, 4 new cases for a new pure helper
  `preservePayloadData(payloadDir, stagingDir)` in `bin/lib/launcher-utils.mjs` (mirrors the
  existing test-fixture-directory convention, no tarball/subprocess needed since the helper is
  pure fs). Watched RED first: `SyntaxError: Export named 'preservePayloadData' not found` (the
  function did not exist yet).
- Built: `preservePayloadData` moves `payloadDir/data` (if present) onto the freshly extracted
  `stagingDir/data` (replacing the tarball's own empty one) via `rmSync` + `renameSync`, before
  `extract()` deletes the old `payloadDir` and renames staging into place. No-op when there is
  nothing to preserve (first extraction, or a payload with no `data/` dir). Wired into
  `bin/studio.js`'s `extract()` — a single call site used by both the `--verify-cache`/download
  path (`preparePayload`) and the `--archive` path, so both hazards named in the issue are fixed
  by the same change.
- VERIFICATION (beyond the unit tests — this is real production code exercising a real release
  tarball, not just the pure helper in isolation): built the actual standalone payload
  (`scripts/build-standalone-payload.sh`) and drove `bin/studio.js` directly, twice in a row, once
  reproducing the issue's literal `--verify-cache` repro (pre-seeded cache dir + SHA256SUMS, first
  boot then `--verify-cache`) and once for `--archive` (same tarball, two consecutive boots). Both
  confirmed: second boot prints NO new credentials banner, and login with the FIRST boot's password
  succeeds against the second boot's server (`{"success":true,"role":"admin"}`). This is the exact
  scenario from the issue's reproduction steps and evidence section.
- DECISION — did NOT change `scripts/engine-smoke.sh` despite the issue-thread coupling note: ran
  the smoke script as-is (unmodified) against a real build with the fix applied (`node24` tier) and
  it passed end-to-end, including the storage leg. Investigated why the predicted breakage didn't
  happen: the storage leg's second server boot sets `STORAGE_SQLITE_PATH=$WORK/storage.db` — an
  ABSOLUTE path OUTSIDE the payload tree entirely (a sibling of the `.libredb-studio` cache dir, not
  nested under `payloadDir`), so `getDataDir()` resolves to `$WORK` for that boot, not
  `payloadDir/data`. That server's `auth-bootstrap.json` therefore lives at
  `$WORK/auth-bootstrap.json`, never touched by `preservePayloadData`, and is (and always was)
  freshly generated on every run regardless of this fix — the coupling the comment predicted
  requires the smoke script to ALSO stop pointing `STORAGE_SQLITE_PATH` outside the payload's
  default data dir, which is a separate, untested behavior change to a passing CI script that this
  issue does not ask for and that empirical evidence shows is unnecessary. Rejected making that
  change: it would swap a currently-passing, currently-correct smoke assertion for an unverified
  one, on a script this issue's acceptance criteria do not name. Flagged for human review: if a
  future change ever makes `scripts/engine-smoke.sh`'s storage leg share the payload's default data
  dir, revisit whether `PASSWORD2` parsing needs to become a `PASSWORD` reuse at that time — not
  today.
- KNOWN LIMITATION (recorded): `preservePayloadData` moves (renames) the previous `data/` dir
  wholesale; it does not merge file-by-file with whatever the tarball would otherwise have shipped
  in `data/` (currently always empty per `build-standalone-payload.sh`, so there is nothing to
  merge in practice). If a future release ever ships non-empty seed files under `data/` in the
  tarball itself, they would be silently shadowed by a preserved previous `data/` dir on upgrade.
  Not a concern today; flagged in case `data/` ever stops being purely a runtime-state directory.
- Gate: format clean, lint clean (0 errors, pre-existing warnings only, none in touched files),
  typecheck OK, test 2287 -> 2291 (+4, the new `preservePayloadData` cases; verified the exact delta
  by diffing `bun test tests/unit tests/api tests/integration` against the pre-change HEAD via
  `git stash`, since a prior entry's baseline number in this file did not match what `bun run test`
  reports locally), all 18 groups pass (0 fail), build OK.
- Next: #133.

### 2026-07-11 — #133 standalone tarball tarbomb -> versioned root (DONE)

- Root cause confirmed by reading `scripts/build-standalone-payload.sh`'s final packing step
  (`tar -czf "$OUT_DIR/$TARBALL" -C "$PAYLOAD_DIR" .`): entries were packed relative to
  `$PAYLOAD_DIR` itself, so extracting spills every file (`fly.toml`, `scripts/`, `src/`, `.next/`,
  ...) into the caller's cwd - exactly the issue's `tar tzf | head` evidence.
- Tests first: new `tests/unit/packaging-standalone-tarball.test.ts` (2 cases) spawns a NEW real
  script, `scripts/lib/pack-standalone-tarball.sh`, as a subprocess against a small fixture payload
  dir (no full `bun run build` needed - that script only wraps an already-assembled payload), then
  asserts every `tar tzf` entry is prefixed `libredb-studio-<version>/`. New `describe("extractTarball"`
  block in `tests/unit/launcher-utils.test.ts` (1 case) builds a real fixture tarball with a
  top-level `libredb-studio-9.9.9/` root via the real `tar` binary and asserts the new
  `extractTarball` helper strips it so `server.js` lands directly in destDir. Watched RED first:
  `scripts/lib/pack-standalone-tarball.sh` didn't exist yet (exit 127 / "No such file or
  directory"), and `SyntaxError: Export named 'extractTarball' not found`.
- Built:
  - New `scripts/lib/pack-standalone-tarball.sh <payload-dir> <version> <output-tarball>`: renames
    the payload dir to `libredb-studio-<version>/` in its parent, then tars that named directory
    (not `--transform`, since BSD tar on macOS runners doesn't share GNU tar's transform syntax -
    packing a renamed directory works identically on both). `build-standalone-payload.sh`'s final
    packing step now calls this script instead of tarring `$PAYLOAD_DIR` directly; its own
    `--smoke` self-test extraction gained `--strip-components=1` to match.
  - New `extractTarball(tarballPath, destDir)` in `bin/lib/launcher-utils.mjs` (`tar -xzf ... -C
    destDir --strip-components=1`, mirroring the "CLI entry stays thin, composes tested helpers"
    convention already used for `preservePayloadData`). `bin/studio.js`'s `extract()` now calls this
    instead of its own inline `spawnSync("tar", ...)` - both the download/cache path
    (`preparePayload`) and the `--archive` path share the one `extract()` call site, so both are
    fixed together.
  - `.github/workflows/release-artifacts.yml`: added `--strip-components=1` to the two other direct
    `tar -xzf "dist/libredb-studio-standalone-...tar.gz" -C ...` extractions (the linux-packages/nfpm
    job and the snap job) - found by grepping the repo for every tarball-consuming `tar -xzf`, per
    the plan's "check whether any of those reference the archive root path directly."
    `scripts/engine-smoke.sh` needed no change: it always drives `bin/studio.js --archive`, so it
    inherits the `extract()` fix automatically.
  - `packaging/homebrew/libredb-studio.rb.tmpl`: no functional change - researched (WebSearch +
    DeepWiki on Homebrew/brew) and confirmed `Resource::Downloader` defaults
    `strip_leading_dir = true` for a formula's *primary* `url`/`sha256` download (as opposed to a
    named secondary `resource do` block, where no stripping happens by default), so Homebrew already
    auto-strips a single top-level directory before `def install` runs - the new layout needs no
    code change there. Updated the now-stale `def install` comment (previously said "no top-level
    directory") to describe the new layout and why it still works unchanged.
  - `docs/DISTRIBUTION.md`: added a paragraph under "Release artifact naming" documenting the
    versioned root and which consumers strip it how.
- VERIFICATION (beyond unit tests): ran the real `scripts/build-standalone-payload.sh` end-to-end
  (full `bun run build` + packing, no `--smoke` flag) and confirmed `tar tzf` on the produced
  tarball shows all 4378 entries prefixed `libredb-studio-0.9.50/` (not `./`). Then drove that exact
  tarball through the real `bin/studio.js --archive` end-to-end: extraction succeeded, the server
  booted, printed the zero-config admin password, and `GET /api/db/health` returned 200 - the same
  real-process verification style used for #132.
- DECISION - renamed the payload directory and tarred the named directory rather than using
  `tar --transform`/`--owner`-style flag tricks: GNU tar (Linux CI/dev) and BSD tar (macOS CI
  runners, per the release matrix) do not share transform-flag syntax, but every `tar` implementation
  packs a named directory identically, so this is the one approach guaranteed to produce the same
  archive layout on both platforms without an `if [[ $(uname) == Darwin ]]` branch.
- KNOWN LIMITATION (recorded): #124 (trim the repo-root extras out of the payload itself, e.g.
  `fly.toml`, `docker-compose.example.yml`) is explicitly out of scope per
  `loop/IMPLEMENTATION_PLAN.md`'s "Later" section - the payload still contains those files, just
  under a conventional root now instead of spilled at the archive root.
- Gate: format clean, lint clean (0 errors, pre-existing warnings only, none in touched files),
  typecheck OK, `bun run test` all 18 groups pass (0 fail; +3 new cases: 2 in
  `packaging-standalone-tarball.test.ts`, 1 in `launcher-utils.test.ts`'s new `extractTarball`
  block), build OK.
- Next: #137.

### 2026-07-11 — #137 Helm default install: writable /app/data (regression test added; fix already shipped)

- Read the issue in full (`gh issue view 137`, 0 comments): default install
  (`persistence.enabled=false`) left `/app/data` unwritable under
  `readOnlyRootFilesystem: true`, so embedded-sample seeding silently failed (WARN-only log,
  no crash) and the login → open "Sample (LibreDB)" → query E2E flow broke without
  `--set persistence.enabled=true`.
- Investigated before writing anything: `git log`/`git show` on
  `charts/libredb-studio/templates/deployment.yaml` showed this was already fixed by commit
  `3a22428` ("fix(helm): install with default values - zero-config bootstrap as chart default
  (#165)", merged 2026-07-07, well before this loop started) - the `data` volume already has an
  `{{- else }}` branch rendering `emptyDir: {}` when `persistenceEnabled` is false, and the
  `data` volumeMount at `/app/data` is unconditional. Confirmed live with `helm template
  charts/libredb-studio` (default values): rendered `data` volume is `emptyDir: {}`. Also
  confirmed `docs/HELM_CHART.md`, `docs/DISTRIBUTION.md`, and `docs/RANCHER.md` already document
  this exact behavior (emptyDir-by-default, PVC when `persistence.enabled=true`) from the same
  PR - no doc drift, no doc changes needed this iteration.
- DECISION - the milestone's functional fix for #137 was ALREADY shipped before this loop
  started; what was genuinely missing (and what `loop/ACCEPTANCE.md`'s Quality criterion
  "every fix has a regression test that fails before the fix and passes after" flags) was
  automated regression coverage pinning the specific "writable /app/data by default" behavior.
  Checked existing CI coverage first per the plan's instruction: `helm lint --strict` (ci.yml)
  is syntax-only: the `ct install` (default-values, zero-config) real-Kind-cluster step added in
  the same PR #165 (`helm-release.yml`) only asserts the pod reaches Ready, which the pre-#165
  broken template would ALSO have satisfied (the original bug was a silent WARN, not a crash) -
  so no existing test actually pins this regression at the granularity the issue describes.
  Wrote `tests/unit/helm-chart-persistence.test.ts` to close that gap.
- Tests first: 2 new cases, spawning the REAL `helm` binary (`Bun.spawnSync`) against the real
  `charts/libredb-studio` chart (mirrors this loop's established convention of exercising real
  production files/binaries rather than reimplementing logic - see `packaging-*.test.ts`), then
  parsing the rendered multi-doc YAML with the `yaml` package (already a project dependency) to
  assert on the actual `Deployment` manifest. Watched RED first: temporarily reverted
  `deployment.yaml`'s two hunks to their pre-#165 shape (conditional volumeMount, no `else`
  emptyDir branch) via `Edit`, re-ran `bun test tests/unit/helm-chart-persistence.test.ts` -
  first case failed exactly as expected (`dataMount` undefined, i.e. no `/app/data` mount
  renders at all with default values), second case (`persistence.enabled=true`) still passed
  correctly (isolates the regression to the default-values path only). Restored the file via
  `git checkout --` (verified `git status --short` showed no diff afterward) and reran - both
  cases GREEN.
  - Test 1: default values -> `data` volumeMount exists at `/app/data`, `data` volume has
    `emptyDir` and no `persistentVolumeClaim`.
  - Test 2: `--set persistence.enabled=true` -> `data` volume has `persistentVolumeClaim` and no
    `emptyDir` (no-regression guard on the existing correct branch).
- Verified `helm` is preinstalled on GitHub's `ubuntu-latest` runner image (confirmed via web
  search of `actions/runner-images` docs: Helm ships under "Package Management" on the
  Ubuntu 24.04 image) before committing to a test that shells out to the real `helm` CLI - the
  `test`/`test:coverage` CI job does not run `azure/setup-helm` (only the separate `helm-lint`
  job does, for version pinning), so this confirms the new test runs deterministically in CI
  without needing any workflow changes. Also confirmed `helm template charts/libredb-studio`
  needs no `helm repo add bitnami` / `helm dependency build` step locally, since the postgresql
  subchart `.tgz` is already vendored at `charts/libredb-studio/charts/postgresql-16.7.27.tgz`.
- KNOWN LIMITATION (recorded): this is a template-render assertion, not a live E2E "login → open
  sample → query" browser flow against a real cluster (`loop/ACCEPTANCE.md` accepts either, via
  "and/or"). A full k8s E2E harness (spin a Kind cluster, deploy the chart, port-forward, drive
  Playwright) is out of scope for one loop iteration and materially overlaps both the existing
  `ct install` CI smoke step and the already-completed manual Rancher K3s E2E validation (9/9
  scenarios, see project memory) - not attempted here; flagged only as a documented gap, not a
  blocker, since the acceptance wording explicitly allows the render-level check.
- Gate: format clean, lint clean (0 errors, pre-existing warnings only, none in touched files),
  typecheck OK, `bun run test` all 18 groups pass (0 fail; +2 new cases, 2296 tests total in the
  main unit/api/integration group), build OK, `helm lint charts/libredb-studio --strict` clean
  (0 charts failed).
- Next: Phase F close-out - reconcile `loop/PROGRESS.md`/`loop/HANDOFF.md` against
  `loop/ACCEPTANCE.md` (all 5 functional tasks in `loop/IMPLEMENTATION_PLAN.md` are now `[x]`)
  and create `.loop/COMPLETE` if every criterion holds.

### 2026-07-11 — Phase F close-out (DONE)

- Triage (step 0f): `gh issue list --label "loop:needs-info" --state all` returned `[]` — no
  issue needs triage or blocks completion.
- Verified every `loop/ACCEPTANCE.md` criterion against the actual repo state rather than
  trusting the prior entries' self-report:
  - Functional: confirmed all 5 issues (#132-#135, #137) are still `OPEN` on GitHub (`gh issue
    view <N> --json state` for each) - expected, since this loop never closes issues (a human
    closes them at PR merge, per `PROMPT.md` step 3).
  - Documentation: `grep` of `docs/DISTRIBUTION.md` confirmed the `LIBREDB_BIND` row (#134), the
    Homebrew `STORAGE_SQLITE_PATH` default paragraph (#135), and the versioned-tarball-root
    paragraph (#133) are all present; #137 needed no doc change (already covered by the
    pre-loop PR #165 docs, per that entry's own investigation).
  - Quality/gate: re-ran the full gate fresh on the clean branch tip (not reusing any
    mid-implementation run): `bun run format` clean (489 files, no fixes), `bun run lint` 0
    errors (58 pre-existing warnings, none new), `bun run typecheck` clean, `bun run test`
    printed "All 18 groups passed!" with 0 fail (the runner's final tail only echoes the last
    group's own tally - 486 pass / 0 fail / 983 expect() calls for that group - not a
    whole-suite total; did not re-derive the exact whole-suite count, so not claiming it matches
    the #137 entry's prior "2296 tests total" figure, only that all groups reported 0 fail),
    `bun run build` exit 0 (all routes compiled). Also ran `helm lint charts/libredb-studio
    --strict` (named in root `CLAUDE.md`'s Helm section though not itself a `PROMPT.md` gate
    command): 0 charts failed. `git status --short` empty after the build (no stray build
    artifacts staged/untracked).
  - Process: `loop/IMPLEMENTATION_PLAN.md` Phase 1-3 (#134, #135, #132, #133, #137) were already
    `[x]`; ticked Phase F's own line in the same edit as this entry.
- Updated `loop/ACCEPTANCE.md`: ticked all boxes (Functional, Quality, Documentation, Process),
  each backed by the verification above, not a rubber stamp.
- Updated `loop/HANDOFF.md`: replaced the stale "Not started — scaffold just created" status
  (dated to milestone setup, before any iteration ran) with the actual completed state - per-issue
  commit hashes, the re-verified gate summary, and the open-issues-stay-open note - plus queued
  backlog candidates for the next milestone (#124, the npx launcher's own latent `HOSTNAME` gap
  noted in the #134 entry, and the pre-existing `bug`-labeled backlog from the original scaffold).
- DECISION - did not attempt a live E2E browser run for #137 beyond what its own entry already
  recorded (a `helm template`-level render assertion): `loop/ACCEPTANCE.md`'s wording accepts
  "and/or" between the render-level check and a live E2E flow, the render-level test already
  exists and passes, and spinning a Kind cluster + Playwright run from inside this close-out
  iteration would be new scope beyond "reconcile progress/handoff and verify criteria" - consistent
  with the KNOWN LIMITATION already flagged in the #137 entry.
- Gate: format clean, lint clean (0 errors), typecheck OK, 18/18 test groups pass (0 fail), build
  OK, `helm lint --strict` 0 failed - same numbers as the #137 entry, confirming no drift between
  that commit and this close-out.
- Next: none - all `loop/ACCEPTANCE.md` criteria met; `.loop/COMPLETE` created in this same
  iteration. A human should review before merging `loop/maintainer-bugsweep-1` into `main` (5
  fixes, 5 commits, base `main` per branch rules) and plan the next milestone via
  `loop/PROMPT-PLANNING.md`.

### 2026-07-12 — Full-autonomy hardening (DONE, human)

- Not a loop iteration — human-driven infrastructure work preparing the loop to run against the
  OPEN public issue tracker autonomously (Bug Sweep 1 ran against a maintainer-curated queue).
- Built: triage mode (`loop/PROMPT-TRIAGE.md` + `loop/TRIAGE.md` sanitized-spec register), the
  `loop:queued` / `loop:needs-moderator-action` labels (`loop/scripts/setup-labels.sh`,
  idempotent, run against the repo), a mandatory fresh-context `loop-reviewer` pass before every
  build-mode commit (`.claude/agents/loop-reviewer.md`; `loop-judge.md` ported alongside, fixing
  LOOP-ENGINEERING.md's previously broken references), and runner-level tool blocks in
  `loop/config/loop.env` (no curl/wget/WebFetch, gh surface reduced to issue read/label/comment).
- DECISION — issue BODIES are now untrusted, not just comments (PROMPT.md 0e + 999i rewritten;
  999j added): Bug Sweep 1 could treat "the issue is the spec" because the maintainer authored
  the queue; that assumption does not survive arbitrary public reporters. Build mode's
  acceptance bar is now maintainer-loop-authored text only (TRIAGE.md sanitized spec + plan task
  text); raw issues are evidence to re-verify.
- DECISION — suspicious issues get a label and NO reply (PROMPT-TRIAGE.md 999e, PROMPT.md 1b):
  replying leaks what tripped detection and invites iteration on the injection. Trigger text is
  quoted verbatim here instead, for the human moderator.
- DECISION — `authorAssociation` is recorded as context but exempts no one from the firewall:
  uniform rules are the only kind a fresh-context agent applies reliably, and maintainer
  accounts can be compromised.
- DECISION — triage may queue autonomously (no human approval gate between triage and build):
  the final human gate is push/PR/merge, which the loop cannot perform (runner-blocked), and
  humans can veto any stage by removing labels or editing TRIAGE.md. Flagged for human review
  after the first full autonomous run.
- KNOWN LIMITATION (recorded): `LOOP_DISALLOWED_TOOLS` is prefix-based — it cannot distinguish
  `gh issue edit --add-label loop:queued` from `gh issue edit` adding a non-loop label; that
  narrower rule is prompt-enforced only (999j). Acceptable: label edits are reversible and
  audited in PROGRESS.md.
- Gate: full five-command gate green on this change set (docs/config/agents only, no product
  code touched).
- Next: none for Bug Sweep 1 (complete). The next milestone starts with triage mode per
  `loop/HANDOFF.md`.
