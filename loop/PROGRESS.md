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

### 2026-07-12 — Triage batch 1 (Maintainer Sweep 2): #40, #94, #126, #136, #45 (DONE)

- Batch selection: 20 open issues; excluded 5 already carrying `loop:*` labels (#175, #166,
  #152, #114, #72 — labeled before this loop started, none recorded in TRIAGE.md, treated as
  already-routed and left untouched). Took the 4 open `bug`-labeled candidates oldest-first
  (#40, #94, #126, #136) plus the oldest non-bug (#45).
- TOOLING LIMITATION (recorded): `authorAssociation` is not retrievable this iteration — the
  runner blocks `gh api` even for read-only GETs (prefix-based, by design; not routed around)
  and `gh issue view --json` does not expose the field. Recorded "repo maintainer" where the
  author is the repository owner account and "unknown/external" otherwise; the firewall treats
  all authors identically anyway. Also: `gh issue view` without `--json` returns empty output in
  this environment — use `--json` with explicit fields.
- #40 (ER diagram broken rendering + PNG/SVG export) → `loop:needs-moderator-action`, category:
  requires-privileged-change. NOT an injection — a benign external bug report whose two export
  claims I VERIFIED in code: (1) SVG export serializes the first svg element inside the
  React Flow container (`src/components/SchemaDiagram.tsx:360-370`), but React Flow renders
  table nodes as HTML divs (only edges/background are SVG layers), so the exported file
  structurally cannot contain the diagram — matches the report's "The SVG image is not right;
  it is not the ER diagram." (2) PNG export (`SchemaDiagram.tsx:344-358`) uses html2canvas
  1.4.1, whose color parser supports rgb/hsl only (verified in the installed package's color
  types — no oklch support), while Tailwind 4's default palette used by the diagram's classes
  is oklch-based (verified `node_modules/tailwindcss/theme.css:134` for the blue-400 token used
  at `SchemaDiagram.tsx:51`); the failure is swallowed as a console.error with no user-visible
  feedback — matches "PNG can't be downloaded." Escalated rather than queued because the
  correct fix requires a new runtime dependency (the React-Flow-ecosystem-standard DOM-to-image
  serializer; html2canvas is effectively unmaintained and a bespoke in-repo serializer would be
  worse), and dependency additions are a human decision per the firewall. The report's third
  claim ("the shown is not good", two screenshot attachments) was not verifiable — attachments
  deliberately not fetched (999b). No reply posted (2a: label only).
- #94 (query editor clips long lines, no horizontal scroll) → `loop:needs-info`. Plausible but
  not verifiable in current code: the Monaco options explicitly request visible horizontal
  scrollbars, automatic relayout, and no word wrap (`src/components/QueryEditor.tsx:59-92`,
  scrollbar block at 76-81), i.e. current code asks for exactly the behavior the report says is
  missing. Report is against v0.9.29 (~23 releases old) and names no reproducible layout state.
  Posted one question (does it reproduce on 0.9.52; exact panel/window state; standalone vs
  embedded) — issue comment 4949538647.
- #126 (Oracle/MSSQL explain advertised but unimplemented) → `loop:queued`. Verified all four
  code sites (capability true at `oracle.ts:65`/`mssql.ts:61`; builder null-falls-back to the
  raw query at `use-query-execution.ts:145-155,181-186`). Observed behavior correction recorded
  in the spec: the button silently runs the plain query — it does not produce an engine-rejected
  statement as the issue text assumed. Spec pins the disable-until-implemented option (the
  issue's own alternative) — rationale in TRIAGE.md.
- #136 (chart hard-required the optional user password) → `loop:queued` as a regression-test
  task: the functional fix ALREADY SHIPPED on main (conditional secret key + env wiring + docs;
  verified by reading the templates and rendering the chart locally with only the two required
  secrets — clean render, zero USER_PASSWORD references), but no test pins it. Same shape as
  the #137 precedent last milestone.
- #45 (four deferred Helm hardening items from the chart-introduction review) → `loop:queued`.
  All four gaps verified in the chart source (schema coverage, no machine-enforced JWT length,
  PDB zero-value truthiness drop, no HPA-vs-sqlite guard). Spec records a verified trap: the
  JWT secret defaults to empty for zero-config mode, so a naive minLength would break the
  default install — constraint must accept empty-or->=32.
- Not-for-the-loop: none this batch.
- Next: triage the remaining untriaged pool (next batch, oldest-first: #167, #170, #151, #100,
  #96, then #127, #125, #124, #123, #108).

### 2026-07-12 — Triage batch 2 (Maintainer Sweep 2): #96, #100, #108, #123, #124 (DONE)

- Batch selection: untriaged pool after batch 1 is #96, #100, #108, #123, #124, #125, #127,
  #151, #167, #170 (excluded everything carrying a `loop:*` label or already in TRIAGE.md).
  None carry the `bug` label, so strict oldest-first per the prompt's step 1 gives this batch
  #96, #100, #108, #123, #124 — note this ordering supersedes batch 1's "Next" prediction
  (#167/#170/#151 first), which did not follow the prompt's selection rule; the prompt rule
  wins, no other batch-1 decision re-litigated.
- All five issues are authored by the repository owner account — recorded as context per the
  firewall; verified every claim in code regardless.
- #96 (pluggable result-value renderers) → `loop:queued`. Verified the concrete gap:
  `formatCellValue` is the single formatter switch (objects compact-stringified,
  `src/components/results-grid/utils.ts:6-8`), the detail sheet collapses multi-line JSON
  (normal-whitespace `break-all` paragraph, `RowDetailSheet.tsx:126-134`), and no renderer
  modules exist. Spec pins phase-1 scope with NO new dependencies (a collapsible JSON tree
  would need one — that boundary is recorded in the spec as an escalate-instead condition) and
  carries the platform-integration constraints (twMerge-safe classes, `build:lib`) into build
  mode. The issue's interface sketch / module layout code blocks were NOT copied into the spec.
- #100 (toolchain follow-ups from #98) → not-for-the-loop (2d), no label. Consolidated
  tracking issue: its acceptance explicitly requires dismissing CodeQL alerts and marking
  SonarCloud hotspots Safe — external-dashboard, human-judgment actions outside the loop's
  allowed surface (and `gh api` writes are runner-blocked). The jsx-a11y sub-scope alone would
  be loop-shaped if a human splits it out; recorded in TRIAGE.md.
- #108 (distribution-channels epic) → not-for-the-loop (2d), no label. Epic/tracking issue;
  every remaining actionable lives in a child issue (#114 already
  `loop:needs-moderator-action`; #113 closed with the Snap release). Closing the epic is a
  human act.
- #123 (sign release artifacts) → `loop:needs-moderator-action`, category:
  requires-privileged-change. NOT an injection — a benign maintainer-authored hardening
  proposal, but every part of a correct fix is privileged: release-workflow changes, signing
  identity, and secrets. Trigger quoted verbatim: "Keyless cosign signatures for every release
  asset (sigstore/cosign-installer in release-artifacts.yml; OIDC identity = the workflow)"
  and "SLSA provenance attestations via the GitHub artifact attestation API
  (actions/attest-build-provenance)". Also touches the launcher's verification path
  (checksum-only today, `bin/studio.js:198-208` verified) but that follow-on is inseparable
  from the pipeline decision. No reply posted (2a: label only).
- #124 (trim standalone payload) → `loop:queued`. Verified structurally (`next.config.ts` has
  no `outputFileTracingExcludes`; `build-standalone-payload.sh:109` copies `.next/standalone`
  wholesale) and empirically via batch-independent prior loop evidence (the #133 entry's real
  `tar tzf` listing showed `fly.toml`, `docs/`, `scripts/` in the payload; its KNOWN
  LIMITATION deferred exactly this issue). Spec makes the script-level prune the enforced,
  fixture-testable layer, demotes the ~50% size target to advisory, and records the
  no-workflow-edits and snap dot-directory traps.
- Next: triage the remaining untriaged pool — next batch, strict oldest-first: #125, #127,
  #151, #167, #170 (exactly five; #127 carries `question`, none carry `bug`).

### 2026-07-12 — Triage batch 3 (Maintainer Sweep 2): #125, #127, #151, #167, #170 (DONE)

- Batch selection: exactly five untriaged issues remain (#125, #127, #151, #167, #170, oldest
  first, none `bug`-labeled) — matches batch 2's prediction. All five authored by the
  repository owner account; recorded as context per the firewall, every claim verified in code
  regardless.
- #125 (sqlite traversal check is a no-op) → `loop:queued`. Verified: the guard at
  `src/lib/db/providers/sql/sqlite.ts:146-150` compares `path.resolve` output against
  `path.normalize` of itself — always equal, so only the NUL-byte check is live, while the
  comment and error message claim traversal rejection. `docs/providers/sqlite.md` already
  documents the no-op honestly (149-151, 385-386); no test pins the live behavior. Spec queues
  the issue's own "honest minimum" option (fix comment/error, remove dead branch, pin by test,
  tri-sync docs). DECISION — the issue's second option (a base-dir allowlist env var) is NOT
  queued: new security-semantics configuration surface is a human product decision; it should
  become its own issue if wanted.
- #127 (sqlite absent from connection-form selectableTypes) → `loop:needs-moderator-action`,
  category: human-decision. NOT an injection — a maintainer-authored question (labeled
  `question`) that explicitly defers a product decision. Verified the gap is real
  (`src/hooks/use-connection-form.ts:334` lists seven types, no sqlite; the provider is fully
  wired at `src/lib/db/factory.ts:72` and `src/lib/db-ui-config.ts:52`), but the resolution
  direction is genuinely a trust-model call: connection creation is not admin-gated
  (`src/proxy.ts` gates only `/admin`), so exposing sqlite in the form would let any
  authenticated user open arbitrary server-side files — expose-vs-document-hidden is a human
  choice. Trigger quoted verbatim: "Decide: expose sqlite in the connection modal (server-side
  file path semantics documented in docs/providers/sqlite.md), or document why it is
  intentionally hidden." No reply posted (2a: label only).
- #151 (chart:check hardening follow-ups) → `loop:queued`. All seven findings verified in
  `scripts/sync-chart-version.mjs` (origin/main-tip comparison at :129, hand-synced gating
  condition :83-95 vs :178, conflated nulls :130-132, first-occurrence matching :32/:40/:111/
  :118 — counted exactly one occurrence of each pattern today, strict-exit-before-violations
  :171-176 vs :188, untested strict tag-query-null path, `CHART_SYNC_STRICT` documented nowhere
  outside `.github/workflows/ci.yml:44`). Spec records the traps: ci.yml must not be edited,
  `bun run chart:check` is a required gate and must stay green, no chart version bump needed
  (no chart content changes).
- #167 (helm-release re-publishes index/OCI for an already-released chart version) →
  `loop:needs-moderator-action`, category: requires-privileged-change. NOT an injection — a
  benign maintainer incident report whose root cause I verified in the workflow: the
  already-released guard exists only in the publish-release step
  (`.github/workflows/helm-release.yml:199,210`), while the gh-pages index step (:220) and the
  OCI push (:318) run unguarded. The correct fix is a release-workflow edit, outside loop
  authority. Trigger quoted verbatim: "Gate the index-update and OCI-push steps on the same
  condition as the release-asset step: skip when tag libredb-studio-<version> already exists."
  No reply posted (2a: label only).
- #170 (chart and docs follow-ups from the #165 review and Rancher E2E) → not-for-the-loop
  (2d), no label. Collected multi-item tracking issue mixing loop-shaped chart/docs items
  (adminEmail secret-vs-env inconsistency and unconditional adminPassword `required`
  spot-verified in the templates) with privileged CI-workflow items (PR-time `ct install`,
  Rancher E2E workflow parametrization). Same treatment as #100: recorded in TRIAGE.md so a
  human can split the loop-shaped subset into standalone issues first.
- Next: the untriaged pool is now empty (all 20 open issues carry a `loop:*` label or are
  recorded in TRIAGE.md) — the next triage iteration should confirm via step 1 and, finding
  nothing, run step 4 (create `.loop/COMPLETE`, print the sentinel).

### 2026-07-12 — Planning (Maintainer Sweep 2): IMPLEMENTATION_PLAN authored (DONE)

- Queue confirmed live on GitHub at planning time: exactly the 7 issues `loop/ACCEPTANCE.md`
  lists carry `loop:queued` (#45, #96, #124, #125, #126, #136, #151); #94 is the only
  `loop:needs-info`; the moderator-action set matches. Every queued issue has zero comments
  and no updates since the triage labels landed — no new evidence contradicts any sanitized
  spec.
- Evidence re-verified, not trusted: spot-checked every load-bearing file:line citation in all
  7 TRIAGE.md specs against the branch tip (capability flags, secret/pdb/hpa templates, the
  dead sqlite comparison, the formatter and detail-sheet code, the sync-chart-version.mjs
  findings, absence of `outputFileTracingExcludes`). All hold — expected, since only loop/docs
  commits landed after triage, but verified rather than assumed.
- Plan shape: 7 issues → 7 tasks in `loop/IMPLEMENTATION_PLAN.md`, with #96 pre-split into two
  ordered sub-tasks (#96a classifier/registry/parity, #96b detail-sheet/masking/build:lib) —
  explicit split per the sizing rule, since the full issue plus component-test isolation
  overhead risks overrunning one iteration (2700s timeout).
- DECISION — ordering is dependency- and risk-driven, not context-warmth-driven: build
  iterations are fresh-context, so adjacency buys nothing. Providers first (#126, #125: small,
  precisely specced, validates the new reviewer pipeline on low-risk diffs), then chart work
  with #151 BEFORE #45: the merge-base fix in `chart:check` must land before #45's Chart.yaml
  version bump, so a release merged to main mid-loop cannot false-positive the required
  `bun run chart:check` gate on this long-lived branch. #124 next, #96 last (largest).
- DECISION — #45 item 4 (HPA-vs-sqlite) pre-pinned to the skip-rendering-with-warning option,
  the more conservative of the spec's two; build mode records the final call in its own entry.
- DECISION — #125 test (b) (`..`-segment acceptance) is a pinning test expected GREEN from the
  start; the RED hook for that task is the error-message assertion (current message claims
  traversal protection). Recorded so build mode does not misread a green pinning test as a
  TDD violation.
- Housekeeping in the same commit: `loop/HANDOFF.md` rewritten for Sweep 2 (was still Bug
  Sweep 1's close-out) and `loop/config/loop.env` flipped to
  `LOOP_PROMPT_FILE="loop/PROMPT.md"` (build mode) per the planning prompt's handoff step —
  the runner sources loop.env at startup, so the next `./loop/scripts/loop.sh` run builds.
- No GitHub mutations this iteration (labels already correct; nothing demoted).
- Next: build mode, task #126 (first unchecked task in the plan).

### 2026-07-12 — #126 Oracle/MSSQL: stop advertising explain without a dialect wrapper (DONE)

- Triage (step 0f): #94 is the only `loop:needs-info` issue; its comment thread contains only the
  loop's own clarifying question (comment 2026-07-12T01:55:40Z) — no reply to evaluate.
- Tests first: flipped the capability assertions to `false` in
  `tests/integration/db/oracle-provider.test.ts` and `tests/integration/db/mssql-provider.test.ts`
  (with a why-comment each) and watched them fail RED against the then-current code:
  `expect(caps.supportsExplain).toBe(false)` → `Expected: false, Received: true`, 2 fail / 68 pass
  across the two files. No new test cases — the assertion inversion IS the regression pin, since
  the old assertions pinned the buggy advertised-but-unimplemented value.
- Built: set `supportsExplain: false` (with a disabled-until-dialect-wrapper comment) in
  `src/lib/db/providers/sql/oracle.ts` and `mssql.ts`, mirroring sqlite's existing explicit
  `false` (`sqlite.ts:57`). The explicit override is required — `base-provider.ts:176` defaults
  the flag to `true`. No UI change: `QueryEditor.tsx:580` and `Studio.tsx:338,463` gate the
  Explain action on the capability, and `use-query-execution.ts:132-142` blocks the explain code
  path with a toast when the flag is false, so the silent raw-query fallback
  (`buildExplainQuery` → null → unmodified SQL runs) is unreachable for these types.
- Tri-sync in the same commit: `docs/providers/oracle.md` (capability table row + known-limitation
  bullet) and `docs/providers/mssql.md` (same two spots) rewritten from "advertised but not
  implemented" to "intentionally disabled until a dialect wrapper exists", keeping each doc's
  future-work recipe (EXPLAIN PLAN FOR + DBMS_XPLAN; SET SHOWPLAN_XML/STATISTICS XML). Grepped
  docs/ and tests/ for other oracle/mssql `supportsExplain` claims — none exist
  (`DATABASE_PROVIDERS.md:505` is a conditional checklist row, not a per-provider claim; all other
  test references are mocks or the base-provider default test, unchanged).
- DECISION — capability flip, not dialect wrappers (per the sanitized spec's pinned option): a
  real Oracle plan flow needs two statements and SQL Server needs a session-level showplan
  setting — both exceed the current single-statement explain path — and the loop has no live
  Oracle/MSSQL engines to validate wrappers against. Re-enabling is the recorded future-work path
  in both docs.
- Also ran `bun run build:lib` (exit 0): the provider classes ship in the `@libredb/studio`
  package via `src/exports/providers.ts` → factory → provider imports; dist/ is gitignored, so
  nothing extra lands in the commit.
- loop-reviewer verdict: PASS, no findings (traced the capability gates downstream, confirmed
  tri-sync completeness, test realness, scope, and clean supply chain).
- Gate: format clean (489 files), lint 0 errors (58 pre-existing warnings, none in touched
  files), typecheck OK, `bun run test` all 18 groups pass (0 fail; test count unchanged —
  assertions flipped, no cases added), build OK, build:lib OK.
- Next: #125 (sqlite path guard honesty), per the plan.

### 2026-07-12 — #125 sqlite path guard: remove dead traversal branch, claims match behavior (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Tests first: 2 new cases in `tests/integration/db/sqlite-provider.test.ts` (new
  "getDatabasePath() via connect()" block, own mkdtemp fixture dir). Watched RED:
  the NUL case failed with `Expected to contain: "NUL" / Received: "Invalid database path:
  path traversal is not allowed"` (35 pass / 1 fail). The `..`-segment case is the plan's
  pre-declared PINNING test — GREEN from the start exactly as planning pre-recorded (and its
  green empirically proves the traversal branch was dead: a cwd-relative `../../...` path was
  accepted by the UNMODIFIED code), not a TDD violation. The pinning test self-guards its
  precondition (`isAbsolute(relPath)` false, relPath contains "..") so it fails loudly rather
  than silently testing nothing if tmpdir ever sits inside cwd.
- Built: `getDatabasePath()` now rejects only NUL bytes ("Invalid database path: NUL bytes are
  not allowed") and returns `path.resolve(dbPath)`; the unsatisfiable
  `resolved !== path.normalize(resolved)` comparison, its traversal-claiming comment, and the
  traversal-claiming error message are gone (grep of sqlite.ts finds no traversal claim).
- Tri-sync in the same commit: `docs/providers/sqlite.md` — §3.1's no-op-defect warning became
  a statement of intended behavior ("NUL rejection is the only path validation — by design"),
  the §10 error-table row now matches the new message character-for-character, §13's limitation
  became "No path sandboxing (by design)" keeping the #125 link only as the
  future-allowlist pointer, and §11.2's coverage list gained the new path-handling cases.
- DECISION — base-dir allowlist NOT implemented (the issue's option 2, excluded by the
  sanitized spec): new configuration surface with security semantics is a human product
  decision; it needs its own issue if wanted.
- ADJACENT ISSUE (recorded, not fixed — 999e): `src/lib/db/providers/embedded/libredb.ts:159-162`
  carries the IDENTICAL dead comparison (its docstring says "mirroring the SQLite provider")
  and the same traversal-claiming error message at :161; its test
  (`tests/integration/db/libredb-provider.test.ts:96-98`) only exercises the NUL path with a
  `/traversal|invalid/i` regex that passes either way. Out of scope for #125 (different
  provider type-id, its own triad); flagged for a human to file a follow-up issue.
- loop-reviewer verdict: PASS WITH NOTES (2 LOW applied, 1 LOW accepted). Applied: §11.2
  coverage list extended; the comment's unverified "NUL truncates in the driver's C layer"
  rationale reworded to the indisputable "never valid in a filesystem path". Accepted as-is:
  the pinning test's tmpdir-outside-cwd assumption — reviewer's own assessment is that the
  failure mode is a loud, clearly-labeled assertion, and standard dev boxes/CI runners satisfy
  it. Full gate re-run after applying the notes.
- Gate (final state): format clean (489 files), lint 0 errors (58 pre-existing warnings, none
  in touched files), typecheck OK, all 18 test groups pass (0 fail; main
  unit/api/integration group 2298, was 2296; +2), build OK, build:lib OK.
- Next: #136 (pin the minimal two-secret helm install with a render-level test), per the plan.

### 2026-07-12 — #136 Helm minimal two-secret install: render-level regression test (fix already shipped) (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Verified before writing (per the sanitized spec, re-checked live): the functional fix already
  shipped on main — user-password/user-email secret keys render only when
  `secrets.userPassword` is set (`charts/libredb-studio/templates/secret.yaml:21-24`),
  USER_PASSWORD/USER_EMAIL envs only when set or an existing secret is referenced
  (`templates/deployment.yaml:88-101`) — and a live minimal two-secret render produced zero
  user-password references. What was missing was the pinning test (nothing under `tests/`
  mentioned the user-password value).
- Tests first: new `tests/unit/helm-chart-user-password.test.ts`, 2 cases, following the #137
  convention (`helm-chart-persistence.test.ts`): spawn the real `helm template` against the
  real chart, parse the multi-doc YAML, assert on the actual Secret and Deployment manifests.
  RED evidence: temporarily inserted the hard require back into `secret.yaml` (OUTSIDE the
  authStrict guard — inside it the require is dead for a default render), watched case 1 fail
  with `execution error at (libredb-studio/templates/secret.yaml:6:10): secrets.userPassword
  is required` (1 pass / 1 fail — case 2 stays green, isolating the regression to the minimal
  path), restored via `git checkout --` and verified `git status` clean, then GREEN (2 pass).
- Also pins `user-email`/`USER_EMAIL` alongside the password — they live in the exact same
  conditional hunks; tightens the net without expanding scope (reviewer concurred, LOW note).
- DECISION — no Chart.yaml version bump: no chart content changed (test-only diff), and the
  repo rule triggers on charts/** content merges only.
- loop-reviewer verdict: PASS WITH NOTES (2 LOW, informational, no action required): (1) the
  Secret lookup hardcodes the rendered fullname but fails loudly, not silently, if the helper
  ever changes; (2) the user-email pinning is slightly beyond the literal bar but inside the
  same hunks. Reviewer independently reproduced all three regression vectors (hard require,
  secret-conditional removal, deployment-conditional removal) against /tmp chart copies —
  the test fails under each.
- Gate: format clean (490 files), lint 0 errors (58 pre-existing warnings, none in touched
  files), typecheck OK, all 18 test groups pass (0 fail; main unit/api/integration group 2300,
  was 2298; +2), build OK.
- Next: #151 (chart:check hardening: merge-base comparison + polish items), per the plan.

### 2026-07-12 — #151 chart:check hardening: merge-base comparison + shared predicate + polish (DONE)

- ITERATION RECOVERY (recorded): this iteration started with uncommitted changes to exactly the
  task's three files (`scripts/sync-chart-version.mjs`, `tests/unit/sync-chart-version.test.ts`,
  `docs/HELM_CHART.md`) and NO #151 entry here — a prior iteration died mid-task after the #136
  commit (LOOP-ENGINEERING §7 says this is safe by design; nothing commits mid-task). DECISION —
  adopted the dead iteration's work as an UNVERIFIED DRAFT instead of discarding and retyping:
  the changes match the plan task exactly (loop-authored work, not human edits — humans never
  edit mid-run), and honesty is preserved by independently reconstructing RED evidence and
  running the full review pipeline rather than by re-typing the same bytes. Everything below was
  verified in this iteration, not inherited on trust.
- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Tests first / RED evidence (reconstructed via the temporary-revert/mutation technique from the
  #136/#137 precedent — each mutation fails EXACTLY the test that pins it):
  (A) script reverted to HEAD → whole test file RED (`Export named 'tagQueryNeeded' not found`);
  (B) `readBaseChart` mutated back to the origin/main TIP comparison → only "stale branch passes
  --check after a released chart bump merged to origin/main" fails (the clone's local-path
  upstream is reachable, so the old code finds tag libredb-studio-0.1.3 and false-positives
  "already released" — exactly the issue's scenario);
  (C) `unparseable` reason re-conflated to `missing-ref` → only the distinct-messages fixture
  test fails; (D) `/g` flags dropped from `applyBump`'s replacements → only the
  duplicated-lines rewrite test fails. GREEN after restore: 34/34 in the file; +14 new cases
  (2 parseImageTag dup, 2 parseReadmeVersion dup, 4 tagQueryNeeded, 1 applyBump dup-rewrite,
  1 strict-violations-first, 4 git-fixture CLI cases).
- Built (all seven spec items): `readBaseChart` compares against `git merge-base HEAD
  origin/main` with a fallback to the origin/main tip when no merge-base is computable
  (ci.yml's depth-1 checkout + depth-1 main fetch produce grafted roots where merge-base always
  fails — verified against ci.yml read-only, workflow untouched; a git-fixture test emulates
  this with two orphan roots and self-checks that merge-base genuinely fails); missing-ref vs
  unparseable-Chart.yaml are distinct reasons with distinct strict/warn messages; the tag-query
  gating predicate is the single exported `tagQueryNeeded()` shared by `checkSync()` and
  `main()`; `parseImageTag`/`parseReadmeVersion` use matchAll and throw when duplicated
  occurrences DISAGREE (agreeing duplicates pass), `applyBump` rewrites all occurrences (`/g`);
  both strict early-exit paths print content violations first (the spec's optional item 5 —
  included since it stayed at two small loops); `CHART_SYNC_STRICT` documented in
  `docs/HELM_CHART.md`'s version-management section. The hermetic git fixtures pin all four
  base-comparison paths including the previously untested strict tag-query-null path
  (resolvable origin/main ref, unreachable remote — a pinning test, green from the start, as
  the spec expected).
- Constraints held: `.github/workflows/ci.yml` untouched; no chart content changes → no
  Chart.yaml version bump; `bun run chart:check` green on the real repo before and after.
- loop-reviewer verdict: PASS WITH NOTES (3 LOW; 1 applied, 2 accepted). Applied: softened the
  overstated "exact on PR merge refs" claim to "effectively exact" in both docs/HELM_CHART.md
  and the script comment (a depth-1 fetch of main at step runtime can be newer than the merge
  ref's main parent, so the race is only effectively — not provably — closed in shallow CI; the
  full fix needs ci.yml edits, outside loop authority). Accepted with reasons: (a) when the
  merge-base fallback hits the tip AND that tip chart is unparseable, the strict message still
  says "at the merge-base" — cosmetic wording in a rare combined-failure path, fixing it means
  threading the resolved ref through the reason; (b) the test's `runCheck` subprocess inherits
  the developer's real git config (only `runGit` fixture setup is hermetic) — matches the
  existing #138 test convention of spawning the real script, flagged not fixed.
- KNOWN LIMITATION (recorded): if a branch predates the chart's introduction, the merge-base
  commit has no Chart.yaml and the guard reports "origin/main not resolvable" (missing-ref) —
  misleading wording for an ancient-branch edge no current branch can hit (the chart shipped
  long before any live branch point); the strict CI path is unaffected (fallback tip always has
  the chart).
- Gate (final tree, after applying the reviewer note): format clean (490 files), lint 0 errors
  (58 pre-existing warnings, none in touched files), typecheck OK, all 18 test groups pass
  (0 fail; main unit/api/integration group 2314, was 2300; +14), build OK.
- Next: #45 (chart hardening, four gaps, one commit WITH `bun run chart:bump`), per the plan —
  deliberately ordered after this task so the merge-base comparison protects #45's version bump
  from a false-positive `chart:check` if a release merges to main mid-loop.

### 2026-07-12 — #45 Helm chart hardening: schema coverage, jwtSecret length, PDB zero-value, HPA-vs-sqlite (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Tests first: new `tests/unit/helm-chart-hardening.test.ts`, 28 cases following the real-helm
  render convention (#136/#137 precedent: spawn `helm template` against the actual chart, parse
  the multi-doc YAML). Watched RED: 22 fail / 6 pass, the 6 passes being exactly the planned
  controls/pinning cases (empty/32-char jwt renders, valid-values render, maxUnavailable-only
  pinning, non-sqlite HPA control) plus `service.annotations`, which already fails today at
  helm's YAML-unmarshal stage (metadata.annotations must be a map) rather than schema
  validation — recorded; the schema now catches it earlier and properly.
- Test-design research (recorded so later iterations need not re-derive): verified empirically
  on a scratch chart that helm validates values.schema.json against the COALESCED values and
  that a wrong-typed whole-key override (scalar over a map/array default) reaches schema
  validation instead of being dropped by coalescing — this is what makes the wrong-typed
  probes real. Failure assertions check exit code + offending key name only, because helm 3
  and helm 4 schema-error formats differ (local helm is v4; CI ubuntu-latest may ship v3).
- Built (all four gaps, one commit): (1) schema coverage for every listed key in the schema's
  existing permissive per-key style — deliberately NO `additionalProperties: false` (would
  break postgresql-subchart passthrough values and any user extra key; not in the bar);
  (2) jwtSecret `anyOf: [{maxLength: 0}, {minLength: 32}]` — empty stays valid for the
  zero-config default (the spec's verified trap); (3) pdb.yaml: `kindIs "invalid"` nil-checks
  so `minAvailable: 0` renders, plus template-level `fail` for both-set AND neither-set
  (exactly-one semantics); (4) new `libredb-studio.autoscalingEnabled` helper
  (autoscaling.enabled AND effective storage != sqlite, via the existing storageProvider
  helper so the postgresql auto-switch keeps its HPA) gating hpa.yaml, the deployment replicas
  fallback (sqlite+autoscaling now renders an explicit `replicas: {{ replicaCount }}`), and
  the NOTES autoscaling status line, plus a NOTES WARNING block following the existing
  sqlite-multi-replica warning convention.
- DECISION — HPA-vs-sqlite resolved as skip-rendering-with-NOTES-warning (the plan's
  pre-recorded choice, more conservative than clamping maxReplicas): no HPA plus an explicit
  single-replica deployment cannot scale writes, while a clamped HPA would still imply
  autoscaling works with sqlite. Warning text verified via `helm install --dry-run=client`.
- DECISION — PDB mutual exclusivity enforced by a template `fail`, not JSON-Schema `not`:
  values.yaml defaults minAvailable to 1, so a user setting maxUnavailable ALWAYS has both set
  after coalescing; the fail message can teach the escape hatch
  (`--set podDisruptionBudget.minAvailable=null`) where a schema violation cannot.
  maxUnavailable typed integer (minimum 0) to match the existing minAvailable typing —
  percentage strings (valid in k8s) stay unsupported for both, consistent with the
  pre-existing schema.
- DECISION — hand-bumped chart version 0.1.11 -> 0.1.12 + README `--version` example:
  `bun run chart:bump` reports "already in sync" for chart-content-only changes (applyBump
  only moves the version when appVersion drifts from package.json), so the plan's "use
  chart:bump" instruction is not executable here; the hand bump preserves every invariant the
  script checks (`bun run chart:check` green; appVersion untouched at 0.9.52).
  `artifacthub.io/changes` rewritten for 0.1.12 per the per-release convention.
- loop-reviewer verdict: PASS WITH NOTES (4 LOW; 1 applied, 3 accepted). The reviewer
  independently reconstructed the pre-change chart and confirmed all four gaps reproduce on it
  and are fixed by this diff. Applied: HPA control assertion `toBe(10)` ->
  `toBeGreaterThan(1)` (pins the invariant, not the values.yaml default). Accepted with
  reasons: (a) deployment.yaml's pre-existing zero-config guard still keys on raw
  `autoscaling.enabled`, so its "breaks sessions across replicas" message is slightly stale
  for the sqlite case (conservatively safe fail; editing a pre-existing guard is outside this
  task's scope — flagged for a human follow-up); (b) probe assertions check exit code +
  top-level key name only (deliberate helm 3/4 robustness); (c) a neither-set PDB now fails
  the render instead of producing an API-invalid PDB (intended exactly-one semantics,
  documented in README and the changes annotation).
- KNOWN LIMITATION (recorded): the schema still lacks `additionalProperties`, so unknown/typo
  keys pass silently — pre-existing, explicitly outside the spec's bar. The NOTES warning is
  install/upgrade-time only (`helm template` output cannot show NOTES); the render-level test
  pins the HPA absence, which is the enforceable bar.
- Gate (final tree, after applying the reviewer note): format clean (491 files), lint 0 errors
  (58 pre-existing warnings, none in touched files), typecheck OK, all 18 test groups pass
  (0 fail; main unit/api/integration group 2342, was 2314; +28), build OK,
  `helm lint charts/libredb-studio --strict` clean, `bun run chart:check` green
  (chart 0.1.12 / appVersion 0.9.52).
- Next: #124 (standalone payload deny-list prune), per the plan.

### 2026-07-12 — #124 standalone payload: deny-list prune of trace-swept repo-root extras (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Tests first: new `tests/unit/packaging-payload-prune.test.ts`, 5 cases following the
  `packaging-standalone-tarball.test.ts` convention (spawn the real helper as a subprocess
  against mkdtemp fixture payloads). Watched RED first: 0 pass / 5 fail,
  `bash: .../prune-standalone-payload.sh: No such file or directory` (the helper did not exist).
- Built: new `scripts/lib/prune-standalone-payload.sh <payload-dir>` (deny-list `rm -rf` of
  payload-ROOT entries only; `"${PAYLOAD_DIR:?}/${entry:?}"` guards; glob line for
  docker-compose*/`*.snap`/`*.tgz`/`*.log`/`*.pem`), wired into
  `scripts/build-standalone-payload.sh` immediately after the wholesale `.next/standalone`
  copy. `docs/DISTRIBUTION.md` documents the pruned payload root and the local-build caveat in
  the same commit. `next.config.ts` deliberately unchanged (spec: tracing excludes must not be
  the only mechanism; the script prune alone meets the bar).
- DECISION — deny-list extended beyond the spec's named minimum, from real-build evidence (the
  actual payload-root listing), in two verified classes: (a) tracked non-runtime repo content
  that ships even in clean CI release builds (bin, conductor, deploy, docker, loop, packaging,
  scripts, snap, src, and root config/meta files — `src/` is raw .ts/.tsx the compiled
  standalone server never reads; `loop/` shipped this loop's own notes in every release);
  (b) project-conventional gitignored local leftovers (coverage, dist, logs, npmjs-token,
  snap-payload, testdb+sidecars, seed-connections.yaml, tsconfig.tsbuildinfo — a 67M local
  `.snap` leftover was the single largest traced-in file). LICENSE and README.md deliberately
  kept (release-artifact convention; MIT notice travels with the payload). Rejected: an
  allowlist prune — the sanitized spec pins deny-list semantics (conservative: only remove
  what is verified non-runtime).
- DECISION — leading-dot names (.npmrc, .token, .sonar-token) NOT added: empirically, output
  file tracing never pulled any leading-dot root entry into the payload (.gitignore, .github,
  .claude, .dockerignore all exist and none appeared in the listing), so those entries would be
  dead code. Only non-dot files trace in.
- FLAGGED FOR HUMAN REVIEW — a real `npmjs-token` file sits at the repo root of this dev
  machine and WAS traced into the first local build's tarball during this task (credential
  class). CI release checkouts are clean, so published artifacts are unaffected; the file name
  is already public in `.gitignore` and is now deny-listed, and the offending local tarball was
  overwritten by the later builds. Recommendation: move that token off the repo root entirely
  (env var or ~/.npmrc) — the deny-list cannot protect arbitrary personal files.
- VERIFICATION (beyond unit tests — acceptance items 2 and 3, and the reviewer's MEDIUM):
  three real full builds during the task; the FINAL one ran on exactly the shipped code:
  `--smoke` passed (health 200), `tar tzf` root listing is exactly server.js, package.json,
  .next, node_modules, public, data, LICENSE, README.md; zero matches for the acceptance set
  (docs/, charts/, e2e/, tests/, CLAUDE.md, bun.lock, fly.toml, docker-compose); tarball
  105M -> 32M, 5355 -> 3072 entries on this local tree (the advisory "roughly halve" target
  exceeded here; a clean CI tree, without the 67M .snap leftover, will see a smaller but still
  real reduction).
- KNOWN LIMITATION (recorded): a finite deny-list cannot cover arbitrary personal files at the
  repo root — any non-dot file a developer leaves there still traces into LOCAL builds (CI is
  clean). `docs/DISTRIBUTION.md` now warns about this explicitly. The complete fix (an
  allowlist assembly or a gitignore-aware prune) is a mechanism decision beyond this issue's
  pinned deny-list approach — for a human or a follow-up issue.
- ADJACENT ISSUE (recorded, not fixed — 999e): the Dockerfile runner stage copies
  `.next/standalone` wholesale (Dockerfile:54), so the Docker image carries the same traced-in
  extras and is NOT covered by this script-level prune (issue #124 names only the
  payload-derived artifacts: tarballs, deb/rpm, snap, npx cache). Flagged for a human to file a
  follow-up (either a runner-stage prune or `outputFileTracingExcludes`, which would shrink
  both).
- loop-reviewer verdict: PASS WITH NOTES (1 MEDIUM + 4 LOW). MEDIUM (re-confirm the real-build
  --smoke evidence since the wiring line has no unit test): resolved — the final build above
  ran on the shipped code; evidence recorded here. LOW applied: the deny-list comment
  overclaimed "already public in .gitignore" for `logs` (untracked, not ignored) — reworded;
  full gate re-run after the fix. LOW declined with reasons: (a) deriving the test fixture by
  parsing PRUNE_LIST — hand-mirrored fixtures match the packaging-test convention, and the
  dangerous drift direction (a new deny entry hitting the keep-list) is already caught by the
  keep-list test; (b) adding speculative `next-env.d.ts` — never observed traced, harmless
  stub, consistent with the observed-entries-only principle. LOW informational: the deny-list
  extension judged justified, not scope creep.
- Gate (final tree, after applying the reviewer note): format clean (492 files), lint 0 errors
  (58 pre-existing warnings, none in touched files), typecheck OK, all 18 test groups pass
  (0 fail; main unit/api/integration group 2347, was 2342; +5), build OK.
- Next: #96a (value classifier + renderer registry + compact-path parity), per the plan.

### 2026-07-12 — #96a value classifier + renderer registry + compact-path parity (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Tests first, two files by design so the RED import failure cannot mask the GREEN parity pins:
  `tests/unit/components/results-grid-utils.test.ts` (11 parity cases pinning formatCellValue's
  exact `{display, className}` for null/undefined, object/array, number, boolean, status
  strings, plain strings, and JSON-parseable strings — GREEN against the UNMODIFIED code, per
  the plan's refactor-under-green instruction) and
  `tests/unit/components/results-grid-renderers.test.ts` (14 cases: classifier, registry
  selection + fallback, per-renderer compact output, provider-agnostic source grep). Watched
  RED first: `Cannot find module '@/components/results-grid/renderers/classify'` (11 pass /
  1 fail + 1 unhandled module-resolution error).
- Built: new `src/components/results-grid/renderers/` (types, classify, null, scalar, json,
  registry — kind-named modules mirroring the db-factory type-id convention);
  `formatCellValue` in `utils.ts` is now a two-line adapter
  (`getRenderer(classifyValue(value)).renderCompact(value)`) with its exported name and
  signature unchanged, so all five call sites (ResultsGrid x4, ResultCard x2,
  RowDetailSheet x1) needed no edits. RowDetailSheet deliberately untouched — that is #96b.
- DECISION — JSON-parseable strings classify as json-kind but their COMPACT display stays the
  raw string with `text-zinc-300` (the old plain-string path's exact output): the grid cell
  must not change for any input in this sub-task; only the detail sheet (#96b) will treat
  json-kind differently. The kind boundary is containers-only (`{`/`[` prefix + parse to
  object/array), so `"true"`/`"123"`/`"null"` keep scalar status coloring.
- DECISION — registry typed `Partial<Record<ValueKind, ValueRenderer>>` so the spec-required
  `?? scalarRenderer` fallback is LIVE code the type system acknowledges: a full `Record`
  would make the fallback a provably-dead branch — the same dishonesty class #125 just
  removed. Exhaustiveness is instead pinned by the registry test asserting all three kinds
  resolve to their renderer.
- DECISION — `classifyValue` guards `JSON.parse` behind a trimmed `{`/`[` startsWith check so
  common non-JSON string cells never pay parse cost; reviewer LOW note carried forward to
  #96b: if profiling ever shows large JSON-string columns hurting (formatCellValue runs twice
  per cell at two call sites), consider memoizing classification — not needed for this bar.
- Parity verified beyond the pins: the fresh-context reviewer differential-fuzzed HEAD's
  implementation against the new one across 66 inputs (wrapper objects, Object.create(null),
  BigInt, Symbol, NaN, -0, toJSON-undefined, case-variant status strings, malformed JSON) —
  byte-identical on all 66.
- loop-reviewer verdict: PASS WITH NOTES (3 LOW, all advisory, none applied as code changes):
  (1) the JSON.parse-per-render perf note above (carried to #96b); (2) the Partial-Record
  fallback is only reachable via a cast today — matches the plan's explicit "scalar fallback"
  requirement, accepted; (3) the provider-agnostic grep test resolves sources via
  process.cwd() — true for every current runner, and it fails loud (readdirSync throws), not
  soft, if cwd ever changes.
- Gate: format clean (500 files), lint 0 errors (58 pre-existing warnings, none in touched
  files), typecheck OK, all 18 test groups pass (0 fail; main unit/api/integration group 2372,
  was 2347; +25), build OK, build:lib OK (run because utils.ts ships in the package; dist is
  gitignored).
- Next: #96b (detail-sheet JSON rendering + masking order + package dist), per the plan.

### 2026-07-12 — #96b detail-sheet JSON rendering + masking order + package dist (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z, latest activity 01:55:49Z) — no reply to
  evaluate.
- Tests first (two files, watched RED before implementing): (a) 4 new `renderDetail` unit cases
  in `tests/unit/components/results-grid-renderers.test.ts` — RED with
  `TypeError: jsonRenderer.renderDetail is not a function` (14 pass / 4 fail); (b) 5 new/replaced
  cases in `tests/components/results-grid/RowDetailSheet.test.tsx` — RED on the two pretty-block
  cases (`.whitespace-pre-wrap` query returned null) and the copy-pretty pin (compact
  `{"foo":"bar"}` received); the scalar-inline and masked-json cases were declared pinning tests,
  GREEN from the start (no pre-wrap block existed anywhere, masking already short-circuited).
- Built: `ValueRenderer` gains `renderDetail(value): DetailValue` (`text`, `className`,
  `preserveWhitespace`); all three renderers implement it; `RowDetailSheet.getDisplayValue` masks
  FIRST (renderers never see sensitive values) and otherwise selects via
  `getRenderer(classifyValue(value)).renderDetail(value)`; the value `<p>` conditionally adds
  `whitespace-pre-wrap` (standard twMerge-safe class, 16 existing precedents in
  `src/components`); the second per-field `formatCellValue` call is gone (className now comes
  from renderDetail; `formatCellValue` itself unchanged, still used by ResultsGrid/ResultCard).
- TEST REPLACED (999b, reason recorded): the old "displays JSON.stringify for object values"
  component test pinned the compact-object detail rendering that this task's spec deliberately
  changes; replaced by the pretty-block test with an explanatory comment, not deleted silently.
- DECISION — renderDetail returns pure data (text/className/preserveWhitespace), not ReactNode
  (the raw issue's sketch suggested ReactNode; treated as evidence only): keeps the renderer
  layer pure TS, unit-testable without DOM, matches how #96a shaped CompactValue; the sheet maps
  the flag to the repo's whitespace-pre-wrap convention. A future interactive renderer (JSON
  tree, phase 2) would extend the contract then — no speculative React coupling now.
- DECISION — nullRenderer.renderDetail pins the sheet's historical lowercase-"null"(null) /
  "NULL"(undefined) split (typeof null === "object" took the JSON.stringify branch in the old
  inline ternary): parity with the existing detail-sheet test; unifying to "NULL" would be a
  behavior change outside the bar.
- DECISION — json detail block uses `text-zinc-300`, dropping the compact cell's
  `text-blue-400/80 italic font-light` object hint: the block is a readable document, and the
  repo's pre-block convention (CodeGenerator, SchemaDiff) is zinc-300 mono; italic multi-line
  JSON would fight the issue's readability goal. Grid cells keep the blue italic hint unchanged.
- DECISION — per-field copy of a json-kind field now copies the pretty display text (was compact):
  copy follows what the sheet shows, consistent with the Copy JSON button's existing indent-2
  output; pinned by a new test.
- DECISION — reviewer MEDIUM fixed, not declined (fidelity guard, test-first: watched the new
  fidelity test fail RED against the unguarded implementation): re-stringifying a stored JSON
  STRING canonicalizes it — integers beyond 2^53 silently change digits
  ('{"n":9007199254740993}' would display AND copy as ...992 while the grid cell shows the true
  bytes). `renderDetail` now re-stringifies a string only when
  `stripJsonWhitespace(value) === JSON.stringify(JSON.parse(value))` (module-private tokenizer
  dropping JSON's four insignificant whitespace chars outside string literals, escape-aware);
  otherwise the stored text renders verbatim, still whitespace-preserving. Reviewer re-verified
  the delta: guard traced sound (escaped backslashes, unicode escapes, duplicate keys,
  integer-like key reordering, 1e2/-0 all fall back to raw — the safe direction).
- KNOWN LIMITATION (recorded): non-canonical-but-valid JSON strings (unicode escapes, exponent
  notation, duplicate keys, integer-like key order) skip the pretty upgrade and render raw —
  they lose only prettiness, never bytes. Object/array values parsed upstream by drivers have
  any precision loss baked in before the rendering layer; not addressable here.
- loop-reviewer verdict: PASS WITH NOTES (round 1: 1 MEDIUM + 2 LOW; round 2 on the fix delta:
  MEDIUM resolved, verdict stands). LOW accepted with reason: `copyAllAsJson` in the
  masking-active path now embeds multi-line pretty text for unmasked json-kind fields (cosmetic
  escape drift in the copied JSON; the unmasked path still copies the raw row). LOW out of scope
  (999e, flagged for human follow-up): pre-existing `Eye` icon in RowDetailSheet.tsx lacks
  `strokeWidth={1.5}` per platform-integration rules — predates this task, not touched.
- Gate (final tree, after the MEDIUM fix): format clean (500 files), lint 0 errors (58
  pre-existing warnings, none in touched files), typecheck OK, all 18 test groups pass (0 fail;
  main unit/api/integration group 2376, was 2372, +4; RowDetailSheet component file 17 cases,
  was 13), build OK, build:lib OK (required — these components ship in `@libredb/studio`; dist
  is gitignored).
- Next: Phase F close-out — reconcile PROGRESS/HANDOFF, verify every `loop/ACCEPTANCE.md`
  criterion against actual repo state, report #94 as the open gap, create `.loop/COMPLETE`.

### 2026-07-12 — Phase F close-out (Maintainer Sweep 2) (DONE)

- Triage (step 0f): #94 remains the only `loop:needs-info`; its thread still contains only the
  loop's own clarifying question (2026-07-12T01:55:40Z) — no reply to evaluate.
- Verified every `loop/ACCEPTANCE.md` criterion against the actual repo state, not prior
  entries' self-report:
  - #126: `supportsExplain: false` live at `oracle.ts:67` / `mssql.ts:63`; both integration
    tests assert `false`; both provider docs carry the intentionally-disabled wording.
  - #125: `sqlite.ts` guard rejects NUL bytes only ("NUL bytes are not allowed"); zero
    traversal claims remain in the file; test + doc tri-sync grep-confirmed.
  - #136: `tests/unit/helm-chart-user-password.test.ts` present (2 render-level cases).
  - #45: chart 0.1.12 / appVersion 0.9.52; jwtSecret `anyOf [maxLength 0, minLength 32]` in
    the schema; `kindIs`-based PDB nil-checks; hpa.yaml gated on the
    `libredb-studio.autoscalingEnabled` helper; `helm lint --strict` 0 failed;
    `bun run chart:check` OK.
  - #124: `scripts/lib/prune-standalone-payload.sh` present and wired at
    `build-standalone-payload.sh:114`; fixture test present. The real-build tarball listing
    + `--smoke` evidence is the #124 entry's (three real builds, final on shipped code) — not
    re-run at close-out; a fourth full rebuild would re-verify an unchanged script.
  - #151: merge-base comparison + single exported `tagQueryNeeded()` live in
    `sync-chart-version.mjs`; `CHART_SYNC_STRICT` documented in `docs/HELM_CHART.md`;
    `git diff origin/main...HEAD -- .github/workflows/ci.yml` is empty (ci.yml untouched).
  - #96: `src/components/results-grid/renderers/` (6 kind-named modules); detail sheet
    masks BEFORE renderer selection (`RowDetailSheet.tsx:54-66`) and maps
    `preserveWhitespace` to `whitespace-pre-wrap`; zero connection-type conditionals in the
    rendering layer (grep); build:lib was run in both #96 iterations.
  - Process: all 8 build tasks `[x]` in the plan; all 7 queued issues still OPEN on GitHub
    (nothing closed — human closes at PR merge); label state matches the plan exactly
    (7 `loop:queued`, #94 `loop:needs-info`, moderator set #40/#72/#114/#123/#127/#152/#166/
    #167/#175 intact and untouched by build mode); every task entry above records a
    loop-reviewer verdict of PASS or PASS WITH NOTES with RED evidence.
- Gate re-run fresh on the clean branch tip (single chained run, exit 0): format clean
  (500 files, no fixes), lint 0 errors (pre-existing warnings only, all in untouched
  monitoring tabs), typecheck OK, `bun run test` "All 18 groups passed!" (0 fail),
  `bun run build` OK, `helm lint charts/libredb-studio --strict` 0 failed,
  `bun run chart:check` OK (0.1.12 / 0.9.52). `git status --short` empty afterwards.
- DECISION — no loop-reviewer pass for this close-out: PROMPT step 3's mandatory review
  applies to a task's implementation diff judged against its sanitized spec; Phase F's diff is
  loop-bookkeeping only (plan tick, acceptance ticks, this entry, HANDOFF, `.loop/COMPLETE`),
  there is no spec to judge against, and step 4 defines its own procedure. Consistent with the
  Bug Sweep 1 close-out precedent.
- OPEN GAP (reported, per the plan): #94 (`loop:needs-info`) is awaiting the reporter's
  answer — NOT part of this milestone; only a human removing the label makes it pickable.
  Moderator queue (#40, #123, #127, #167 + pre-existing #175, #166, #152, #114, #72) is
  human-only. Human-follow-up flags recorded in earlier entries remain open: the embedded
  libredb provider's dead traversal branch (#125 entry), the Dockerfile runner-stage extras
  (#124 entry), the repo-root `npmjs-token` file (#124 entry, credential hygiene), the
  deployment.yaml zero-config guard's slightly-stale message (#45 entry), and RowDetailSheet's
  pre-existing `Eye` icon missing `strokeWidth={1.5}` (#96b entry).
- Updated `loop/ACCEPTANCE.md` (all 18 boxes ticked, each backed by the verification above)
  and `loop/HANDOFF.md` (stale "PLANNED, build not started" replaced with the actual
  completed state, per-issue commit hashes, and the outstanding human gates).
- `.loop/COMPLETE` created in this iteration.
- Next: none — milestone complete. A human should review the branch (8 task commits + this
  close-out), push, and open the PR (base `main`), then plan the next milestone.

### 2026-07-12 — Sweep 2 independent human-side verification (DONE, human/operator)

- Not a loop iteration — operator verification of the completed milestone, per the division of
  labor: the loop provides code-level regression proof; the operator provides end-to-end
  functional proof before the human push/PR.
- Independent full gate re-run on the clean branch tip (da83b8d), not reusing the loop's runs:
  format clean, lint 0 errors (58 pre-existing warnings), typecheck OK, 18/18 test groups pass
  (0 fail), build OK.
- Playwright E2E: 32/32 pass. GOTCHA (environment, recorded for future operators): the first two
  E2E attempts failed 4/32-passed with admin-login waitForURL timeouts — root cause was NOT a
  regression: this machine's libredb-studio Snap daemon (root, enabled) occupies 127.0.0.1:3000,
  and playwright.config.ts has reuseExistingServer:true locally, so the suite silently ran
  against the Snap's server with the wrong credentials. Re-ran on port 3101 via a temporary
  config (identical settings, PORT=3101, reuseExistingServer:false): all green. Follow-up
  candidate: make the E2E port/reuse env-configurable so a locally installed Snap cannot shadow
  the suite.
- Live browser functional test of #96 (the sweep's only UI-visible change), against a fresh
  server on port 3102 with an isolated data dir (sample.libredb seeded on boot — also
  re-confirms the #137 flow): login -> Sample (LibreDB) -> `prefix users:` -> grid cell shows
  compact single-line JSON; row detail sheet (mobile card view; the sheet is mobile-triggered
  by design) shows the value field pretty-printed with preserved newlines/indentation
  (computed white-space: pre-wrap, font-mono) while the scalar `key` field keeps
  white-space: normal — exact #96b acceptance behavior, DOM-verified. Screenshot retained in
  the session scratchpad.
- Environment note: in the E2E env (explicit ADMIN_PASSWORD etc.) the server logged "Seed
  connection skipped due to credential resolution failure" — sample seeding is zero-config-mode
  behavior; benign for the E2E suite (seed-state-independent by design, see the e2e memory),
  but worth knowing when reading E2E server logs.

### 2026-07-12 — PR #178 CodeQL follow-up: anchor the image-tag regexes (DONE, human/operator)

- PR CI came back 13 pass / 1 fail: CodeQL flagged `js/regex/missing-regexp-anchor` (high) on
  `parseImageTag`'s pattern in `scripts/sync-chart-version.mjs:32` — the #151 matchAll refactor
  made the pattern "new code", so the pre-existing unanchored shape surfaced as a new alert.
  Practical risk is negligible (input is the repo's own Chart.yaml), but the alert is correct:
  the host prefix was not anchored to the start of a line.
- Fix: anchored both occurrences consistently (`^\s*` + `m` flag; parse also anchors `\s*$`) —
  `parseImageTag` and `applyBump`'s rewrite keep matching the same set of lines, preserving
  #151's parse/rewrite symmetry. Verified against the real Chart.yaml line shape and the test
  fixtures' duplicated-line cases.
- Gate: sync-chart-version unit tests 34/34, `bun run chart:check` green on the real repo; full
  five-command gate via the pre-commit hook.

### 2026-07-12 — PR #178 Copilot review follow-up: payload-marker guard in the prune script (DONE, human/operator)

- Copilot's PR review flagged a real defense gap in `scripts/lib/prune-standalone-payload.sh`:
  the deny-list is applied with `rm -rf` and the only pre-checks were arg-count and dir
  existence — a mistaken invocation against a repo checkout (or `/`) would start deleting
  matching entries (`bin`, `docs`, `snap`, `logs`, ...). The sole current caller
  (`build-standalone-payload.sh:114`) passes a freshly assembled payload, so the PR itself was
  safe — but the script is a standalone lib and the guard costs six lines.
- Tests first (RED confirmed: 2 new cases failed against the unguarded script): (a) a dir with
  deny-list names but no payload markers is refused with nothing deleted; (b) partial markers
  (server.js + package.json but no .next) are also refused. GREEN after the fix: 7/7 in the
  file (was 5).
- Built: the script now requires all three runtime keep-list anchors (`server.js`,
  `package.json`, `.next`) to pre-exist in the target before any removal, failing with a
  "does not look like a standalone payload" error otherwise. This implicitly refuses `/`.
- The second review note (CodeQL missing-regexp-anchor on `sync-chart-version.mjs`) was already
  resolved by the previous entry's fix; the inline comment is stale.
