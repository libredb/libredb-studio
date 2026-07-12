# Implementation Plan — Maintainer Sweep 2

> Live task list for the maintainer loop. Authored by planning mode (2026-07-12) from the
> `loop:queued` queue: #126, #125, #136, #151, #45, #124, #96 — every task's authoritative
> acceptance bar is its sanitized spec in `loop/TRIAGE.md` (the "Acceptance bar (testable)"
> section), summarized per issue in `loop/ACCEPTANCE.md`. Raw issue text is evidence only
> (PROMPT.md 999i); all specs were re-verified against current code at planning time — every
> file:line citation below was checked on this branch tip, and no queued issue has comments.
>
> Ordering rationale: build iterations run with a FRESH context, so "warm context" between
> tasks buys nothing — order is chosen by (a) risk: small, precisely-specced tri-sync fixes
> first; (b) dependency: #151's merge-base fix lands before #45's chart version bump, so a
> release merged to main mid-loop cannot false-positive the required `bun run chart:check`
> gate against this long-lived branch; (c) size: #96 last and pre-split into two ordered
> sub-tasks so a single oversized iteration cannot stall the milestone.
>
> Every task: test-first (record RED evidence in `loop/PROGRESS.md`), one commit, full gate
> (`bun run format && bun run lint && bun run typecheck && bun run test && bun run build`),
> then the mandatory fresh-context `loop-reviewer` pass before committing.

## Phase 1 — provider honesty fixes (tri-sync: code + docs/providers/<id>.md + integration tests in one commit)

- [x] **#126** — stop advertising explain for Oracle and SQL Server until a dialect wrapper
  exists.
  - Test first: flip the capability assertions to `false` in
    `tests/integration/db/oracle-provider.test.ts:473` and
    `tests/integration/db/mssql-provider.test.ts:502` and watch them fail RED against the
    current `supportsExplain: true`.
  - Implement: set `supportsExplain: false` at `src/lib/db/providers/sql/oracle.ts:65` and
    `src/lib/db/providers/sql/mssql.ts:61`, mirroring the sqlite provider's existing
    `supportsExplain: false` (`src/lib/db/providers/sql/sqlite.ts:57`). No UI change: the
    Explain button is already capability-gated (`src/components/QueryEditor.tsx:580`), and the
    client-side explain builder returns null for these dialects
    (`src/hooks/use-query-execution.ts:145-155`) with a silent raw-query fallback
    (`:181-186`) — flipping the flag removes the whole misleading path.
  - Tri-sync in the same commit: update the capability tables and known-limitation sections in
    `docs/providers/oracle.md` (current note at :404-407) and `docs/providers/mssql.md`
    (:421-422) — the limitation becomes "explain intentionally disabled until a dialect
    wrapper exists", not "advertised but not implemented".
  - Out of scope: implementing real Oracle/MSSQL plan flows (multi-statement / session-setting
    semantics the current single-statement explain path cannot express; no live engines to
    validate against). The spec pins the disable option.

- [x] **#125** — sqlite path guard: remove the dead traversal branch and make code claims
  match behavior.
  - Test first (in `tests/integration/db/sqlite-provider.test.ts`, which today covers neither
    NUL nor traversal paths): (a) a database path containing a NUL byte throws
    `DatabaseConfigError` whose message does NOT claim traversal protection — RED today, since
    the current message says traversal is not allowed; (b) a relative path containing `..`
    segments is accepted and resolves to an absolute path (a pinning test — expected GREEN
    from the start; record it as such, it guards the refactor).
  - Implement: at `src/lib/db/providers/sql/sqlite.ts:146-150`, delete the unsatisfiable
    `resolved !== path.normalize(resolved)` comparison (path.resolve output is already
    normalized), keep the live NUL-byte rejection, and reword the comment and error message to
    describe NUL rejection only.
  - Tri-sync in the same commit: `docs/providers/sqlite.md` — the no-op warnings at :149-151
    and :385-386 become a statement of intended behavior (NUL rejection only; sqlite paths are
    trusted server-side paths by design), and the error-table row at :297 matches the new
    message text.
  - Out of scope (explicit, per the spec): the base-dir allowlist option — new configuration
    surface with security semantics is a human product decision; do not add it.

## Phase 2 — Helm chart and its version-sync guard

- [x] **#136** — pin the minimal two-secret install with a render-level regression test (the
  functional fix already shipped on main; verified at
  `charts/libredb-studio/templates/secret.yaml:21-24` and
  `templates/deployment.yaml:88-99`).
  - Test first, following the #137 precedent and the real-helm convention of
    `tests/unit/helm-chart-persistence.test.ts` (spawn the real `helm` binary against the real
    chart, parse rendered YAML): (1) rendering with only jwtSecret and adminPassword set
    succeeds, the Deployment has no USER_PASSWORD env, and the Secret has no user-password
    key; (2) rendering with the user password additionally set produces both.
  - RED evidence: temporarily revert the secret template's conditional to a hard require
    locally, watch case (1) fail, restore the file (verify `git status` clean afterwards).
  - No chart content changes → no Chart.yaml version bump for this task.

- [x] **#151** — chart:check hardening: merge-base comparison plus the six verified polish
  items in `scripts/sync-chart-version.mjs`.
  - Test first, extending the existing fixture-git-repo convention in
    `tests/unit/sync-chart-version.test.ts` (its `runCheck` helper spawns the real script):
    (1) a fixture where origin/main has advanced past the branch point with a released chart
    bump passes `--check` from the stale branch — RED today, because `readBaseChart` reads the
    origin/main TIP (`scripts/sync-chart-version.mjs:129`), not the merge-base of HEAD and
    origin/main; (2) distinct strict-mode messages for missing-ref vs unparseable-Chart.yaml
    (today conflated by the catch-all at :130-132 and reported identically at :171-176), each
    pinned by a fixture; (3) a Chart.yaml fixture with two image-tag lines is either fully
    checked or fully rewritten — no silent first-match-only drift in `parseImageTag` (:32),
    `parseReadmeVersion` (:40), or `applyBump`'s replacements (:111, :118) — pinned by unit
    tests on the pure functions; (4) the strict tag-query-null path (:181-186; resolvable
    origin/main, unreachable remote) gains a test — the mirrored base-null path is already
    covered.
  - Implement alongside: define the tag-query gating predicate once and share it between
    `main()` (:178) and `checkSync()` (:83-95), which are hand-synced duplicates today; add a
    half-line documenting `CHART_SYNC_STRICT` to `docs/HELM_CHART.md` (today it appears only
    in `.github/workflows/ci.yml:44`). The spec's optional item (printing content violations
    before the strict early-exit) is include-only-if-trivially-small.
  - Constraints: `.github/workflows/ci.yml` must NOT be edited; `bun run chart:check` is a
    required CI gate and must stay green on the real repo throughout; no chart content
    changes, so no Chart.yaml version bump.

- [x] **#45** — chart hardening, all four verified gaps, one commit, WITH a Chart.yaml version
  bump (chart content changes; repo rule — a charts/** merge without a bump corrupts the
  released chart index). Use `bun run chart:bump` for the bump (keeps the chart README
  `--version` example and appVersion in sync) and keep `helm lint charts/libredb-studio
  --strict` clean.
  - Test first, render-level per the real-helm convention:
    (1) schema coverage — a wrong-typed value for a newly covered key makes `helm template`
    fail schema validation; cover the verified-absent keys (serviceAccount, pod/container
    securityContext, imagePullSecrets, tolerations, affinity, topologySpreadConstraints,
    networkPolicy, service annotations, ingress hosts/tls, persistence
    accessModes/annotations, extraEnv/extraEnvFrom);
    (2) JWT secret length — the schema rejects a 1-31 char secret but accepts empty AND >=32
    (verified trap: `values.yaml:40` defaults jwtSecret to empty for zero-config bootstrap, so
    a bare minLength would break the default install — the constraint must be empty-OR->=32);
    (3) an explicit `podDisruptionBudget.minAvailable: 0` renders `minAvailable: 0` in the PDB
    manifest — RED today, `templates/pdb.yaml:9` is a truthiness check; also add
    maxUnavailable to the schema and enforce minAvailable/maxUnavailable mutual exclusivity;
    (4) autoscaling enabled + `config.storageProvider=sqlite` cannot render a multi-replica
    HPA — `templates/hpa.yaml` has no guard today.
  - DECISION to pre-record: for (4), prefer skipping HPA rendering (with a warning) over
    clamping maxReplicas — the more conservative of the spec's two options; record in
    `loop/PROGRESS.md`.
  - Ordered after #151 deliberately: the merge-base comparison protects this task's version
    bump from a false-positive `chart:check` failure if a release merges to main while this
    branch is in flight.

## Phase 3 — standalone payload

- [x] **#124** — deny-list prune step in `scripts/build-standalone-payload.sh` (the script is
  the enforced, testable layer; `next.config.ts` tracing excludes may additionally shrink the
  trace but must not be the only mechanism, since they are unverifiable without a full build).
  - Test first, per the packaging convention (`tests/unit/packaging-*.test.ts` spawn real
    scripts against fixture dirs; see `scripts/lib/pack-standalone-tarball.sh` for the
    extract-a-real-helper precedent): factor the prune into a real invocable helper, seed a
    fixture payload dir with planted extras (`docs/`, `charts/`, `e2e/`, `tests/`,
    `CLAUDE.md`, `bun.lock`, `fly.toml`, a docker-compose file) plus keep-list items
    (`server.js`, `.next/static`, `public`, `node_modules/better-sqlite3`,
    `node_modules/@libredb/libredb`), and assert the extras are gone while the keep-list
    survives — including dot-directories: the snap 0.9.52 incident is on record, `.next` must
    never be pruned.
  - Verify beyond unit tests (the established real-build convention from #133): a real full
    build's `tar tzf` listing contains no `docs/`, `charts/`, `e2e/`, `tests/`, `CLAUDE.md`,
    `bun.lock`, `fly.toml`, or docker-compose entries, and the script's `--smoke` self-test
    still passes (health endpoint 200) on the trimmed payload.
  - Constraints: NO workflow edits (none needed — nfpm/snap consume the extracted payload
    as-is; and none are allowed without 1b escalation). The keep-list items the script header
    documents (better-sqlite3 native binding chain, `@libredb/libredb`) must survive. The
    issue's size-reduction target is advisory, not the bar.

## Phase 4 — results rendering phase 1 (#96, split into two ordered sub-tasks — deliberate,
   not silent scope-splitting: the full issue plus component-test isolation overhead is too
   large for one iteration; each sub-task is one commit and one gate run)

- [x] **#96a** — value classifier + renderer registry + compact-path parity (pure TS, unit
  tests only).
  - Test first: (1) a `classifyValue` unit suite covering null/undefined, string, number,
    boolean, object, array, JSON-parseable string, and non-JSON string inputs (RED: the module
    does not exist — no renderer modules exist under `src/components/results-grid/` today);
    (2) BEFORE refactoring, a parity unit test pinning `formatCellValue`'s exact current
    output (display + className) for null/scalar/object inputs
    (`src/components/results-grid/utils.ts:1-23` is the entire current formatter), so the
    refactor happens under green.
  - Implement: kinds at least null/scalar/json; registry-based selection (a scalar fallback)
    with renderer modules derived from repo conventions; `formatCellValue` keeps its exported
    name and signature and becomes a thin adapter, so the `ResultsGrid.tsx` call sites
    (:330, :341, :534-535) need no changes. The rendering layer contains no connection-type
    conditionals (greppable). NO new dependencies — if one turns out to be required, stop and
    escalate per 1b instead of adding it.

- [x] **#96b** — detail-sheet JSON rendering + masking order + package dist.
  - Test first: a component test asserting a json-kind value renders in the detail sheet as a
    pretty-printed, whitespace-preserving monospace block (newlines/indentation survive) — RED
    today: `RowDetailSheet.tsx:126-134` renders every field in a normal-whitespace `break-all`
    paragraph that collapses pretty-printed JSON to one line. Grid cells stay compact
    single-line (existing grid tests stay green).
  - Masking: short-circuits BEFORE renderer selection — masked fields still render the mask
    string; existing masking tests stay green.
  - Constraints: these components ship in the `@libredb/studio` npm package —
    `.claude/rules/platform-integration.md` applies (standard twMerge-safe Tailwind text
    classes only; `strokeWidth={1.5}` on any Lucide icon); run `bun run build:lib` as part of
    the change; component tests run via `bun run test` (isolated groups — never bare
    `bun test`).
  - Out of scope (phase 2+ of the issue, not this milestone): collapsible JSON tree, kv
    renderer, any new dependency.

## Phase F — close out

- [x] Reconcile `loop/PROGRESS.md` / `loop/HANDOFF.md`; verify every `loop/ACCEPTANCE.md`
  criterion against actual repo state (not prior entries' self-report); report #94
  (`loop:needs-info`, awaiting reporter) as an open gap — it is NOT part of this milestone;
  create `.loop/COMPLETE`; print `LIBREDB-STUDIO-SWEEP-2-DONE`.

## Out of scope (this milestone — do not touch)

- #94 — `loop:needs-info`; only a human removing the label makes it pickable.
- #40, #123, #127, #167 (and pre-existing #175, #166, #152, #114, #72) —
  `loop:needs-moderator-action`; human-only.
- #100, #108, #170 — triaged not-for-the-loop (see `loop/TRIAGE.md`).
- Rejected-by-spec alternatives: #125's base-dir allowlist, #126's dialect-wrapper
  implementation, #96's phase-2 renderers/dependencies.
- Backlog noted but unqueued: the npx launcher's latent inherited-`HOSTNAME` gap
  (`loop/PROGRESS.md`, #134 entry).
