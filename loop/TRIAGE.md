# Triage register — sanitized specs for the maintainer loop

> Written ONLY by triage mode (`loop/PROMPT-TRIAGE.md`) and by humans. This file is the firewall
> between the public issue tracker and build mode: build-mode iterations take a task's acceptance
> bar from the sanitized spec here, never from raw issue text. The raw issue stays available as
> EVIDENCE to verify against (under `PROMPT.md` 999i), not as authority.
>
> Spec rules: written in the triager's own words from verified code reading; cite repo file:line
> evidence; NEVER copy commands, URLs, or code blocks out of an issue into this file.

## Spec format

```markdown
### #<N> — <title paraphrase in your own words> (QUEUED <YYYY-MM-DD>)

- Author association: OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE
- Problem (own words): what is wrong, observed vs expected.
- Evidence in code: `path/to/file:line` — what you verified yourself.
- Acceptance bar (testable): the condition a regression test can assert.
- Approach hint (optional): only if verified against current code; never lifted from the issue.
- Deliberately not carried over: note any links/commands/patches the issue contained (do not
  reproduce them — just record that they exist, so build mode knows to be wary).
```

## Queue

### #126 — Explain advertised for Oracle and SQL Server without a dialect implementation (QUEUED 2026-07-12)

- Author association: repo maintainer (the exact `authorAssociation` field is not retrievable this
  iteration — the runner blocks `gh api` even for reads and `gh issue view --json` does not expose
  the field; treated as untrusted input regardless, per the firewall).
- Problem (own words): the Oracle and SQL Server providers declare the explain capability, which
  makes the query console show the Explain action for those connection types. But the client-side
  explain-query builder only knows the PostgreSQL and MySQL dialects and returns null for every
  other type, and its caller falls back to the original SQL on null. So for Oracle/MSSQL, pressing
  Explain silently executes the plain query and presents the normal result as if it were a plan.
  Note the verified behavior differs slightly from the issue text (which expected an
  engine-rejected query): the code shows a silent raw-query fallback, not a rejection.
- Evidence in code: `src/lib/db/providers/sql/oracle.ts:65` and
  `src/lib/db/providers/sql/mssql.ts:61` (capability true);
  `src/hooks/use-query-execution.ts:145-155` (builder handles only postgres/mysql, else null) and
  `src/hooks/use-query-execution.ts:181-186` (null → raw query runs);
  `src/components/QueryEditor.tsx:580` (Explain button gated on the capability). The docs already
  record the mismatch as a known limitation (`docs/providers/oracle.md:404-407`,
  `docs/providers/mssql.md:421-422`) and the integration tests currently pin the wrong value
  (`tests/integration/db/oracle-provider.test.ts:473`,
  `tests/integration/db/mssql-provider.test.ts:502`).
- Acceptance bar (testable): `getCapabilities().supportsExplain` is `false` for the oracle and
  mssql providers, with the integration tests updated to assert false, and the two provider docs'
  capability tables plus known-limitation sections updated in the same PR (tri-sync: the
  limitation note becomes "explain intentionally disabled until a dialect wrapper exists" instead
  of "advertised but not implemented"). No UI change needed — the existing capability gates hide
  the button and block the code path once the flag is false.
- Approach hint: flip the capability rather than implementing wrappers. A real Oracle plan flow
  needs two statements (run the plan statement, then query the plan table) and SQL Server needs a
  session-level showplan setting — both exceed what the current single-statement explain path can
  express, and the loop has no live Oracle/MSSQL engines to validate a wrapper against. The
  maintainer-authored issue explicitly allows the disable-until-implemented option. Mirrors the
  sqlite provider, which already declares `supportsExplain: false`
  (`src/lib/db/providers/sql/sqlite.ts:57`).
- Deliberately not carried over: none — the issue contained no commands, URLs, or patches.

### #136 — Helm minimal install with optional user password: fix shipped, regression unpinned (QUEUED 2026-07-12)

- Author association: repo maintainer (field not retrievable this iteration; see #126 note).
- Problem (own words): the issue reports that the chart's secret template hard-required the
  optional non-admin user password, breaking the documented minimal two-secret install. Verified
  this is ALREADY FIXED on current main: the user-password key renders only when set
  (`charts/libredb-studio/templates/secret.yaml:21-24`), the USER_PASSWORD env renders only when
  set or when an existing secret is referenced
  (`charts/libredb-studio/templates/deployment.yaml:88-99`), the schema does not require it
  (`charts/libredb-studio/values.schema.json:58-61`, no `required` array), and the docs show the
  minimal install (`docs/DISTRIBUTION.md:159-164`; the chart README documents the user password
  as optional throughout). Rendered the chart locally with only the JWT secret and admin password
  set: renders cleanly with zero USER_PASSWORD references. What remains is that no test pins this
  behavior — nothing under `tests/` mentions the user-password value.
- Acceptance bar (testable): a render-level test (convention:
  `tests/unit/helm-chart-persistence.test.ts` — spawns the real helm binary against the real
  chart) asserting (1) rendering with only jwtSecret and adminPassword set succeeds and produces
  no USER_PASSWORD env and no user-password secret key, and (2) rendering with the user password
  additionally set produces both. The test must fail if the secret template's conditional is
  reverted to a hard require.
- Approach hint: follow the #137 precedent from the previous milestone (fix shipped pre-loop →
  add the pinning regression test; RED-check by temporarily reverting the template hunk locally,
  then restoring it).
- Deliberately not carried over: the issue contains a shell install command and an error
  transcript — not reproduced here; verified by rendering locally with repo tooling instead.

### #45 — Helm chart hardening: schema coverage, jwtSecret length, PDB zero-value, HPA-vs-sqlite (QUEUED 2026-07-12)

- Author association: repo maintainer (field not retrievable this iteration; see #126 note).
- Problem (own words) and evidence in code — all four deferred hardening gaps verified:
  1. Schema coverage: `charts/libredb-studio/values.schema.json` covers only a subset of
     `values.yaml` — serviceAccount, pod/container securityContext, imagePullSecrets, tolerations,
     affinity, topologySpreadConstraints, networkPolicy, service annotations, ingress hosts/tls,
     persistence accessModes/annotations, and extraEnv/extraEnvFrom are all absent (verified by
     reading the whole schema; it also lacks `additionalProperties`, so the gap costs validation
     depth and IDE autocomplete, not install failures).
  2. JWT secret length is not machine-enforced: `values.schema.json:40-43` has only a prose
     description and `templates/secret.yaml:3` merely mentions the length in the `required`
     message. Verified caution: `values.yaml:40` defaults the JWT secret to empty (zero-config
     bootstrap mode), so a bare `minLength: 32` would reject the default install — the constraint
     must accept empty OR >= 32 chars.
  3. `templates/pdb.yaml:9` uses a truthiness check, so an explicit `minAvailable: 0` renders
     nothing; nothing enforces minAvailable/maxUnavailable mutual exclusivity, and the schema
     lacks maxUnavailable entirely (`values.schema.json:217-230`).
  4. `templates/hpa.yaml` renders an HPA whenever autoscaling is enabled with no guard for
     `config.storageProvider=sqlite`, allowing multi-replica writes against a single-writer
     sqlite file.
- Acceptance bar (testable): (1) the schema validates the listed values keys (a wrong-typed value
  fails schema validation in a test; `helm lint charts/libredb-studio --strict` stays clean);
  (2) the schema rejects a 1-31 char JWT secret but accepts empty and >=32; (3) an explicit
  `minAvailable: 0` renders `minAvailable: 0` in the PDB manifest; (4) a render with autoscaling
  enabled plus sqlite storage does not produce an HPA permitting more than one replica. All
  pinned via render-level tests per the existing real-helm test convention.
- Approach hint: a Chart.yaml version bump in the same PR is mandatory (repo rule: chart-content
  merges without a version bump corrupt the released chart index). For item 4 the issue offers
  two options (skip rendering with a warning, or clamp the replica ceiling); prefer the first as
  the more conservative choice and record the decision in PROGRESS.md.
- Deliberately not carried over: none — the issue lists tasks in prose with no commands or URLs.

### #96 — Results area: one formatter for every value shape; JSON/document values unreadable in the detail sheet (QUEUED 2026-07-12)

- Author association: repo maintainer (issue-body field not retrievable this iteration — see the
  #126 note; the same account's comments elsewhere carry MEMBER).
- Problem (own words): every result value renders through a single formatter switch that
  compact-stringifies objects and stringifies everything else, and the row detail sheet prints
  each field inside a normal-whitespace paragraph with break-all — so a pretty-printed JSON
  string collapses back into one long unreadable line. There is no extension point for richer
  value shapes (JSON documents, KV rows): adding one today means growing the central switch.
  Verified: no renderer modules exist under the results-grid component tree (only ResultCard,
  RowDetailSheet, StatsBar, utils).
- Evidence in code: `src/components/results-grid/utils.ts:1-23` (the entire formatter —
  null/object/number/boolean/string branches; objects compact-stringified at lines 6-8);
  `src/components/results-grid/RowDetailSheet.tsx:126-134` (field value rendered in a
  `font-mono text-xs break-all` paragraph with default white-space, which collapses newlines);
  grid call sites `src/components/ResultsGrid.tsx:330,341,534-535`.
- Acceptance bar (testable): (1) a value classifier (kinds at least: null, scalar, json) with
  unit tests across null/undefined, string/number/boolean, object/array, JSON-parseable string,
  and non-JSON string inputs; (2) scalar parity — existing grid/detail-sheet tests stay green
  and the formatter's output for null/scalar inputs is pinned identical to today by a unit
  test; (3) a json-kind value renders in the detail sheet as a pretty-printed,
  whitespace-preserving monospace block (component test asserts newlines/indentation survive)
  while the grid cell keeps a compact single line; (4) adding a renderer requires only a new
  module plus a registry entry, and the rendering layer contains no connection-type
  conditionals (greppable); (5) masking short-circuits before renderer selection — masked
  fields still render the mask string and existing masking tests stay green.
- Approach hint (verified against current code): keep the formatter's exported name and
  signature so the `ResultsGrid.tsx` call sites need no changes; only `RowDetailSheet` gains a
  detail-render path. Phase-1 scope only: a pretty preformatted block, NO new dependencies (a
  collapsible JSON tree would need one, and dependency additions are a human decision —
  escalate instead if it turns out to be required). These components ship inside the
  `@libredb/studio` npm package: `.claude/rules/platform-integration.md` applies (standard
  twMerge-safe Tailwind text classes only; `strokeWidth={1.5}` on any Lucide icon) and
  `build:lib` must be run as part of the change.
- Deliberately not carried over: the issue contains a TypeScript interface sketch and a
  proposed module layout in code blocks — not reproduced here; the acceptance bar above was
  restated from code reading, and build mode should derive the module structure from repo
  conventions, treating the issue's sketch as evidence only.

### #124 — Standalone payload ships repo-root extras pulled in by output file tracing (QUEUED 2026-07-12)

- Author association: repo maintainer (field not retrievable this iteration; see #126 note).
- Problem (own words): the standalone payload is assembled by copying the whole
  `.next/standalone` tree, and the Next config declares no output-file-tracing excludes, so
  the build's dependency tracing drags non-runtime repo-root content (docs, charts, e2e,
  lockfile, deploy manifests, agent config) into every payload-derived artifact — release
  tarballs, deb/rpm, snap, and the npx cache. Verified structurally (no excludes configured;
  wholesale copy) and empirically by the previous milestone: the #133 iteration's real
  `tar tzf` listing recorded `fly.toml`, `docs/`, `scripts/` and other repo-root extras inside
  the payload, and that entry's KNOWN LIMITATION explicitly deferred this issue
  (`loop/PROGRESS.md`, #133 entry).
- Evidence in code: `next.config.ts:1-31` (no `outputFileTracingExcludes` key exists);
  `scripts/build-standalone-payload.sh:109` (wholesale `.next/standalone` copy into the
  payload) and lines 110-115 (the script already prunes exactly one traced-in hazard — local
  `data/` dev databases — proving the trace-pulls-extras mechanism is real and already
  partially worked around).
- Acceptance bar (testable): (1) a deny-list prune step runs during payload assembly, covered
  by a test in the existing packaging-test convention (spawn the real script or a real helper
  against a fixture payload dir seeded with planted extras; assert the extras are gone and a
  keep-list — server.js, `.next/static`, `public`, `node_modules/better-sqlite3`,
  `node_modules/@libredb/libredb` — survives); (2) a real full build's tarball listing
  contains no `docs/`, `charts/`, `e2e/`, `tests/`, `CLAUDE.md`, `bun.lock`, `fly.toml`, or
  docker-compose entries; (3) the script's `--smoke` self-test still passes (health endpoint
  200) on the trimmed payload. The issue's rough size-reduction target is advisory, not the
  bar.
- Approach hint (verified): make the prune step in `scripts/build-standalone-payload.sh` the
  enforced layer (single source for CI and local builds, fixture-testable); tracing excludes
  in the Next config may additionally shrink the trace but cannot be unit-tested without a
  full build, so they must not be the only mechanism. Do not touch the keep-list items the
  script header documents (the better-sqlite3 native binding chain and `@libredb/libredb`,
  which tracing cannot see). Downstream consumers (nfpm deb/rpm, snap) consume the extracted
  payload as-is, so no workflow edits are needed — and none are allowed without escalation.
  Snap gotcha on record: the hidden `.next` dir must stay explicitly staged (see the 0.9.52
  fileset fix) — the prune must never remove dot-directories from the keep-list.
- Deliberately not carried over: none — the issue lists proposals in prose with no commands,
  URLs, or patches.

### #125 — sqlite path guard: dead traversal branch behind a comment that promises protection (QUEUED 2026-07-12)

- Author association: repo maintainer (field not retrievable this iteration; see #126 note).
- Problem (own words): the sqlite provider's path resolver claims — in a code comment and in the
  thrown error message — to reject path traversal, but the guard compares `path.resolve` output
  against `path.normalize` of that same output, which are always equal (resolve already
  normalizes), so the traversal branch is dead and only the NUL-byte check is live. Under the
  product trust model this is not a vulnerability (the sqlite path is deliberately a server-side
  file path and pointing at arbitrary server files is the feature), but the code promises
  protection it does not provide. The provider doc ALREADY documents the guard as a no-op
  honestly; what is out of sync is the code comment/error message and the absence of any test
  pinning the live behavior.
- Evidence in code: `src/lib/db/providers/sql/sqlite.ts:146-150` (comment "reject path traversal
  attempts"; unsatisfiable condition; error message says traversal is not allowed);
  `docs/providers/sqlite.md:149-151` and `docs/providers/sqlite.md:385-386` (doc already flags
  the no-op) plus the error-mapping row at `docs/providers/sqlite.md:297`;
  `tests/integration/db/sqlite-provider.test.ts` has no case covering NUL bytes or traversal
  paths (verified by grep).
- Acceptance bar (testable): (1) an integration test pins actual behavior — a database path
  containing a NUL byte throws `DatabaseConfigError`, and a relative path containing `..`
  segments is accepted and resolves absolute (no rejection); (2) the dead comparison branch is
  removed and neither the comment nor the error message claims traversal protection (grep of
  `sqlite.ts` finds no traversal-rejection claim); (3) `docs/providers/sqlite.md` updated in the
  same PR — the no-op warning becomes a statement of intended behavior (NUL rejection only;
  sqlite paths are trusted server-side paths) and the error-table row matches the new message.
  Provider tri-sync: code, doc, and test move together in one PR.
- Approach hint: this is the issue's own "honest minimum" option. The issue's second option (a
  base-dir allowlist environment variable restricting resolvable paths) is deliberately NOT
  queued — new configuration surface with security semantics is a human product decision; if
  wanted, it should become its own issue.
- Deliberately not carried over: none — the issue contains no commands, URLs, or patches.

### #151 — chart version-sync guard: merge-base comparison plus hardening polish (QUEUED 2026-07-12)

- Author association: repo maintainer (field not retrievable this iteration; see #126 note).
- Problem (own words) and evidence in code — the issue lists seven deferred findings on the
  version-sync guard script; all verified in current code:
  1. Base comparison reads main's Chart.yaml from the origin/main TIP
     (`scripts/sync-chart-version.mjs:129`), not from the merge-base of HEAD and origin/main —
     on a stale local branch, or a push build racing a just-merged release bump, the
     already-released check can false-positive.
  2. The tag-query gating condition is duplicated: `main()` computes it at
     `scripts/sync-chart-version.mjs:178` and `checkSync()` re-derives the same nested condition
     at `scripts/sync-chart-version.mjs:83-95` — hand-synced today.
  3. `readBaseChart`'s catch-all (`scripts/sync-chart-version.mjs:130-132`) conflates
     "origin/main not resolvable" with "main's Chart.yaml unparseable"; strict mode reports "not
     resolvable" for both (`scripts/sync-chart-version.mjs:171-176`).
  4. `parseImageTag` (`:32`), `parseReadmeVersion` (`:40`), and `applyBump`'s replacements
     (`:111`, `:118`) match only the first occurrence. Verified fine today (exactly one image
     line in Chart.yaml, one `--version` example in the chart README — counted), but a second
     occurrence would silently drift.
  5. In strict mode with unresolvable git state, the script exits before computing content
     violations (`:171-176` runs before `:188`), so equality violations surface one CI re-run
     later. The issue itself marks this optional.
  6. The strict tag-query-null path (`:181-186`) is untested —
     `tests/unit/sync-chart-version.test.ts` covers strict base-null (its test at line 209) but
     not the resolvable-base/unreachable-remote strict path.
  7. `CHART_SYNC_STRICT` appears only as a ci.yml env line (`.github/workflows/ci.yml:44`) — it
     is not documented in `docs/HELM_CHART.md`.
- Acceptance bar (testable): (1) a fixture repo whose origin/main has advanced past the branch
  point with a released chart bump passes `--check` from the stale branch (fails today);
  (2) the tag-query gating condition is defined once and shared by both call sites; (3) strict
  mode emits distinct messages for missing-ref vs unparseable-Chart.yaml, each pinned by a
  fixture test; (4) a chart fixture with two image-tag lines is either fully checked or fully
  rewritten (no silent first-match-only drift), pinned by a unit test on the pure functions;
  (5) the strict tag-query-null path gains a test (resolvable origin/main, unreachable remote);
  (6) `docs/HELM_CHART.md` documents `CHART_SYNC_STRICT`. Problem item 5 is optional polish —
  include only if it stays small.
- Approach hint: the existing test file already spawns the real script against fixture git
  repos (its `runCheck` helper) — extend that convention rather than reimplementing logic. No
  chart content changes are involved, so no Chart.yaml version bump is needed. ci.yml must NOT
  be edited (workflow edits are outside loop authority), and `bun run chart:check` must stay
  green on the real repo throughout — this script is a required CI gate.
- Deliberately not carried over: the issue contains one inline git command sketch for the
  merge-base comparison — not reproduced; the acceptance bar restates the intent from code
  reading.

## Not for the loop

Issues triaged as benign but not loop work (epics, tracking issues, other-repo work, human-owned
release/infra chores, duplicates). One line each: `#<N> — reason`. This record is what stops the
next triage iteration from re-processing them; they get no label and no comment.

- #100 — consolidated tracking issue (toolchain follow-ups from #98); its acceptance requires
  human actions on external dashboards the loop cannot and must not perform (dismissing CodeQL
  alerts with by-design justifications, marking SonarCloud hotspots Safe). The jsx-a11y code
  sub-scope is loop-shaped but would need a human to split it into its own issue first.
- #108 — epic/tracking issue for distribution channels; all remaining work lives in child
  issues (#114 already routed to moderator; #113 closed), the epic itself is human-owned
  status tracking and gets closed by a human.
- #170 — collected follow-ups/tracking issue from the #165 review and the Rancher E2E
  validation: mixes loop-shaped chart/docs items (spot-verified: the adminEmail secret-key
  vs env-gating inconsistency at `charts/libredb-studio/templates/secret.yaml:17` vs
  `templates/deployment.yaml:70-75`; the unconditional `required` on adminPassword at
  `templates/secret.yaml:3-4` regardless of authProvider) with CI-workflow items (PR-time
  `ct install`, Rancher E2E workflow parametrization) that are privileged. Same treatment
  as #100: a human should split the loop-shaped subset into standalone issues before the
  loop takes them.
