# LibreDB Studio Toolchain - 2026 Adoption Record

> Status: IMPLEMENTED (PR #98, phased; each phase green through CI before the next). A per-tool adoption
> record for five tools, ported from the researched-then-adversarially-verified decision record in
> `libredb-database/docs/TOOLCHAIN.md` and adapted to Studio's reality: a Next.js 16 + React 19 + TSX
> application that ALSO ships as the dual-format npm package `@libredb/studio` (consumed by
> `libredb-platform`). The database record is the rationale source of truth; this document records only what
> changes for Studio and why. Deviations surfaced during implementation are marked "as implemented".

## Scope

Five tools, deliberately a subset of the database gate (no size-limit, commitlint, changesets, secretlint,
license, etc.):

| Tool | Decision | Reason for Studio |
| --- | --- | --- |
| `@biomejs/biome` (format-only) | ADOPT | No formatter today - the one unambiguous gap. Same as database. |
| `oxlint` | ADOPT | Fast Rust syntactic linter; a sub-second fail-fast layer in front of ESLint. |
| `typescript-eslint` + `eslint` | KEEP (Strategy A) | `eslint-config-next` stays as-is and keeps owning React/Next/hooks rules; oxlint is layered on top. |
| `knip` | KEEP | Already wired into the CI gate. Verify, do not rebuild. |
| `@arethetypeswrong/cli` (attw) | ADOPT | Higher value here than in database: 5 subpath exports x dual CJS+ESM x both `.d.ts` and `.d.mts`. |

## How Studio differs from database (and why the configs change)

| Dimension | libredb-database | libredb-studio |
| --- | --- | --- |
| Type | Pure ESM TS library, synchronous core, ZERO runtime deps | Next.js 16 + React 19 + TSX (256 ts/tsx, 121 tsx), async-heavy (API routes, DB drivers) |
| Build | `tsc` + isolatedDeclarations, single entry | `tsup`, dual ESM+CJS, 5 subpath exports (`.`, `/providers`, `/types`, `/components`, `/workspace`) |
| Linting today | oxlint + type-aware-only ESLint | `eslint-config-next` (core-web-vitals + typescript + react-hooks) |
| Formatter today | Biome (present) | None (no prettier) |
| knip | present | present (in CI gate) |
| Tests | single `bun test` | process-isolated (`run-core.sh` / `run-components.sh`) to avoid `mock.module()` cross-contamination |

Consequences:

- **attw uses the DEFAULT profile, NOT `--profile esm-only`** - the package is intentionally dual CJS+ESM,
  so attw must verify CJS resolution too.
- **ESLint is NOT reduced to type-aware-only** (the database move). `eslint-config-next` is the canonical
  Next linter and Studio ships as a Next app; reducing it would drop curated Next/React coverage.
- **CSS is excluded from the Biome formatter** - the platform-integration rules
  (`.claude/rules/platform-integration.md`) warn that `globals.css` can break silently when embedded in
  platform. Keep CSS out of Biome's scope as a safe start.
- **attw needs `build:lib` (tsup), not `next build`** - do not mix the two in CI.

## Why lineWidth = 120 (carried over from database)

Not the Biome/Prettier default of 80. The 80 default is terminal/prose-era inertia; code is scanned, not
read like prose. Reformatting the database repo from 80 to 120 was a net -245 lines because width-80
over-wrapped signatures and calls that fit cleanly on one line at 120. 120 is the JetBrains default and the
modern wide-but-still-review-friendly choice (140 strains side-by-side review). Biome's JS formatter is
configured: 2-space indent, double quotes, semicolons always.

## Why Biome is formatter-only

Biome's type-aware lint rules use a re-implemented inference engine its own authors say "cannot guarantee
full coverage or alignment with TS." Linting stays with oxlint (syntactic) + ESLint (`eslint-config-next`,
including the type-aware Next rules). Biome's `linter` and `assist` are disabled.

## Phase 0 - Prep (shared)

- Add `.editorconfig` (identical to database: 2-space, LF, UTF-8, final newline, trim trailing whitespace;
  `*.md` exempted from trim since hard breaks use trailing spaces) so editors agree before Biome runs.
- Branch `feat/toolchain` off `main` (trunk-based).

## Phase 1 - Biome (formatter only)

Lowest-risk, path-clearing step. One-shot full-repo reformat.

`biome.json`:

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.5.1/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["src/**", "tests/**", "e2e/**", "scripts/**", "bin/**", "*.ts", "*.mts", "*.mjs"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "css": { "formatter": { "enabled": false } },
  "json": { "formatter": { "enabled": false } },
  "linter": { "enabled": false },
  "assist": { "enabled": false }
}
```

Scripts:

```jsonc
"format": "biome format .",
"format:fix": "biome format --write ."
```

As implemented, scope is not passed on the command line: `biome.json`'s `files.includes`
(`src/**`, `tests/**`, `e2e/**`, `scripts/**`, `bin/**`, `*.ts`, `*.mts`, `*.mjs`) does the filtering, so the
scripts can stay a plain `biome format .` / `biome format --write .`.

Notes:

- Style is double-quote + semicolons: consistent with database and with the existing `eslint.config.mjs`.
  The repo is inconsistent today (`tsup.config.ts` is single-quote / no-semi); the reformat unifies it.
- `css.formatter.enabled: false` (plus `json.formatter.enabled: false`) keeps `globals.css` and JSON files
  untouched (platform-integration risk).
- Deliverable: a single `chore(format): adopt Biome formatter` PR (~256 files). Afterwards run `build:lib`
  and verify BOTH modes (standalone + embedded), per the repo's UI-change rule. Coordinate timing to avoid
  clashing with open PRs.

## Phase 2 - Oxlint

Sub-second syntactic linter; a fail-fast layer in front of ESLint.

`.oxlintrc.json` (plugins + categories; the rule tuning below is the as-implemented set):

```jsonc
{
  "plugins": ["typescript", "oxc", "react", "react-hooks", "jsx-a11y", "nextjs", "import"],
  "categories": { "correctness": "error", "suspicious": "error", "perf": "warn", "pedantic": "off", "style": "off" }
}
```

As implemented (the first run surfaced ~1300 findings; the breakdown drove these decisions):

- Disabled as false-positives / eslint-config-next-owned duplicates / idioms:
  - `react/react-in-jsx-scope` (936) - the project uses the automatic JSX runtime (`jsx: react-jsx`), so React
    need not be in scope. This is correct, not a workaround; eslint-config-next disables it too.
  - `import/no-unassigned-import` (202) - intentional side-effect imports (setup/registration).
  - `no-underscore-dangle` (64) - the `_`-prefix is the codebase's deliberate intentionally-unused marker.
  - `no-unused-vars` (25) and `react-hooks/exhaustive-deps` (2) - eslint-config-next already owns these as
    warnings; disabling in oxlint avoids duplicate/contradictory reporting.
  - `no-shadow` (17) - same call as database; shadcn/ui vendored components shadow idiomatically.
  - `no-control-regex` (4) - intentional control-char matching in `logger.ts` log-injection sanitization.
  - `react/no-unstable-nested-components` - the TanStack cell/header-renderer idiom
    (`src/components/ResultsGrid.tsx`).
  - `import/no-named-as-default` - the monaco default+named export.
- Scoped to tests via `overrides` (test idioms): `typescript/no-extraneous-class`, `no-useless-constructor`,
  `no-new` (constructor-throws assertions), `no-constant-binary-expression` (intentional falsy-class test data).
- `jsx-a11y` rules that fired (8) are downgraded to `warn`, not disabled: accessibility matters, but fixing
  ~60 a11y findings (many in vendored shadcn/ui, several needing markup/behaviour changes) belongs in a
  dedicated accessibility pass, not a tooling-adoption PR. They remain a visible, non-blocking backlog signal.
- Three genuine bugs oxlint surfaced were FIXED, not silenced (see the Phase 2 commit): a dead
  `typeof ... || "unknown"` fallback in `profile/route.ts`, a dropped error cause in `seed/config-loader.ts`,
  and a useless regex escape in `merge-lcov.mjs`.
- The `unicorn` plugin is NOT added (taste noise, same call as database). NOTE: an unknown rule key is a HARD
  error in oxlint (it exits 1), not a warning - `react/jsx-uses-react` does not exist and had to be removed;
  only `react/react-in-jsx-scope` is needed for the automatic runtime.
- Scripts: `"lint:oxc": "oxlint"`, and `lint` runs oxlint first: `"lint": "oxlint && eslint ."`.

## Phase 3 - typescript-eslint + ESLint (Strategy A: keep Next, layer oxlint)

`eslint-config-next` stays exactly as it is in `eslint.config.mjs` (it owns core-web-vitals, the typescript
config, and the react-hooks rules). Oxlint is layered on top for fast syntactic feedback; ESLint remains the
curated Next/React safety net.

As implemented, the narrow type-aware layer WAS added (it earned its place): a `typescript-eslint` flat-config
block scoped to the async-heavy code (`src/app/api/**`, `src/lib/db/**`) via `parserOptions.projectService`,
enabling `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `await-thenable` as errors. It
immediately caught five genuine fire-and-forget bugs (async functions invoked in setInterval/setTimeout/process
signal handlers without handling the promise, in `factory.ts`, `mysql.ts`, `postgres.ts`), fixed with the
`void` operator. Scoping keeps lint fast; eslint-config-next still owns everything else.

Rejected for Studio: the database-style reduction of ESLint to type-aware-only with React/Next rules moved
to oxlint. For a shipping Next app the risk of losing `eslint-config-next`'s curated coverage outweighs the
single-linter simplicity.

## Phase 4 - attw (@arethetypeswrong/cli)

High value here: the package has 5 subpath exports, dual CJS+ESM, and emits both `.d.ts` and `.d.mts` - the
exact surface where types-resolution and CJS/ESM-masquerading bugs hide.

```jsonc
// scripts
"attw": "rm -rf .attw && bun pm pack --quiet --destination .attw && attw .attw/*.tgz --profile node16 --exclude-entrypoints styles.css",
"prepublishOnly": "bun run build:lib && bun run attw"
```

Notes:

- `--profile node16` (as implemented, a deviation from the planned default profile). The first run was green
  for the main `.` entry under all modes, but the four subpath exports (`/providers`, `/types`, `/components`,
  `/workspace`) failed ONLY on the legacy `node10` resolution algorithm (node16 CJS+ESM and bundler were all
  green). node10 cannot resolve subpath exports without redirect stubs, and the package requires Node >=24 and
  is consumed by modern bundlers (Next.js/platform), so supporting node10 is moot. `--profile node16` scopes
  the check to node16 CJS+ESM (the real consumer scenarios) and is more honest and precise than the broad
  `--ignore-rules no-resolution`, which could mask a real node16 failure.
- `rm -rf .attw` runs FIRST (not trailing): a trailing `&& rm` would mask attw's exit code, and pre-cleaning
  drops a stale tarball from a previous version bump.
- attw needs `dist/` from `build:lib`, so `prepublishOnly` runs `build:lib` before `attw`. In CI use
  `build:lib`, never `next build`, before attw. **`build:lib`, not bare `tsup`** — see the stylesheet note
  below; a bare `tsup` here published a dist with the stylesheet missing.
- `--exclude-entrypoints styles.css` is not a waiver, it is a statement of scope. attw resolves entry points
  as *modules*; `./styles.css` is a plain file, so attw reports it as unresolvable no matter how correct the
  export map is. Excluding it keeps the check green on a non-finding — and means attw is NOT what guards that
  entry point. `tests/unit/packaging-theme-stylesheet.test.ts` is, and it exists precisely because nothing
  else in the publish chain would have failed loudly.

### The token stylesheet is part of the published surface

`src/app/globals.css` is a Next.js concern and is not packaged. Everything under `src/exports/` colours
itself through `var(--studio-*)`, so an embedding host that imports the components and not the tokens gets
invalid computed values — grounds fall to transparent, hairlines to `currentColor`. The tokens ship as their
own file for that reason:

```ts
import "@libredb/studio/styles.css"; // required once, before any studio component renders
```

`build:lib` is `tsup && node scripts/copy-theme.mjs`, and the order is load-bearing: tsup runs with
`clean: true`, so anything staged into `dist/` before it is wiped. The copy has to come after.
- Git-ignore `.attw/` and `*.tgz` (packaging scratch).
- CI: the `lint-and-build` job runs `build:lib` then `attw` (plus a Biome format check) so the package
  surface is gated on every PR.

## Phase 5 - knip (keep, verify)

Each new tool (`biome`, `oxlint`, `attw`, `typescript-eslint`) gets a real package.json script or a config
import, so knip resolves them and counts them as used. As implemented, `bun run knip` was green with NO
`knip.json` change needed (database's finding held: scripts suffice, even for `attw` whose binary name differs
from `@arethetypeswrong/cli`, and `typescript-eslint` is seen via the `eslint.config.mjs` import).

## CI and pre-commit integration

As implemented in `.github/workflows/ci.yml`, the "Lint, Typecheck and Build" job runs, in order: Biome format
check (`bun run format`), linters (`bun run lint`, i.e. oxlint then ESLint), typecheck, knip, `next build`,
`build:lib`, then `attw`. oxlint is folded into `bun run lint` rather than a separate step. The pre-commit git
hook (`.claude/settings.json`) runs `lint && typecheck && test && build` and now transitively enforces oxlint
and the type-aware layer via `bun run lint`.

### Dependency installation in CI

Every workflow job installs dependencies through the local composite action
[`.github/actions/bun-install`](../.github/actions/bun-install/action.yml), never with a bare
`bun install`:

```yaml
      - name: Install dependencies
        uses: ./.github/actions/bun-install
```

It restores bun's global package cache (`~/.bun/install/cache`, keyed on `bun.lock` with a
`restore-keys` prefix so a lockfile bump warms from the previous entry) and then runs
[`scripts/ci-install.sh`](../scripts/ci-install.sh), which retries `bun install --frozen-lockfile`
with a linear backoff and logs a `::warning::` per failed attempt.

**Why:** `bun install` has no retry of its own, so one failed package download fails the step with
`error: Fail extracting tarball for <package>`. On 2026-07-29 that broke three runs in a single day
— two CI runs and the **npm publish of release 0.9.61**, which left the release published on GitHub
while npm still served the previous version. Nothing was reproducible or code-related; a re-run of
the same commit passed. The cache is the other half of the fix: warm, the packages are not fetched
at all, which removes the exposure rather than retrying through it.

The action deliberately does **not** set up Bun — each job's existing `Setup Bun` step keeps owning
the pinned version, so the action makes no assumption about being adjacent to it. It requires bun on
`PATH` and the repository checked out. The retry policy lives in one place because there are 17
install sites across 7 workflows; duplicated, it would drift immediately.
`tests/unit/ci-install.test.ts` covers the policy against a stub `bun` (first-try success, retry then
success, exhaustion, custom attempt count, no dead sleep after the final attempt).

## Rollout order and per-phase gate

1. Biome formatter + `.editorconfig` (one-shot reformat PR).
2. Oxlint (tune rules to green).
3. ESLint Strategy A wiring + optional type-aware layer.
4. attw + `.gitignore` + `prepublishOnly` + CI packaging step.
5. knip verification.

Each phase must end green on the repo's checks - `bun run lint`, `bun run typecheck`, `bun run test`,
`bun run build` - PLUS `bun run build:lib` and a both-modes (standalone + embedded) verification for any
phase that can affect output.

## Studio-specific risks

1. Big-bang reformat diff churn - coordinate with open PRs / platform; one PR; verify both modes.
2. platform-integration rules - keep CSS out of Biome; verify the embedded mode after the reformat.
3. Oxlint React noise on the first run - expect minor rule tuning.
4. attw must use `build:lib`, not `next build`.
5. `mock.module()` test isolation is unaffected by these static tools.

## `experimental.optimizePackageImports` — measured at zero, so not enabled (2026-08-18)

Proposed in #422 for `lucide-react`, `recharts`, `@xyflow/react`, `framer-motion` and `date-fns`.
Measured before merging, and it changed nothing: first-load JS for `/` was **6030 KiB across 37 files
with the option, and 6030 KiB across 37 files without it** — identical, measured in Chrome against
`bun run build` + `bun run start`, summing every JS response from `/login` through the studio being
interactive.

Two reasons it cannot help here. `lucide-react`, `recharts` and `date-fns` are already in Next's own
default list (`next/dist/esm/server/config.js`), which is concatenated with whatever the config names,
so three of the five entries were never doing anything. And the remaining two are not barrel-of-icons
packages, which is the shape the transform exists for.

Do not re-add it without a number. The measurement takes one build and one page load.

## Suggested package versions

`@biomejs/biome@^2.5`, `oxlint@^1.71`, `@arethetypeswrong/cli@^0.18.4`. `eslint` / `eslint-config-next` /
`typescript-eslint` / `knip` stay at their current Studio versions.

## Coverage measurement (100% line coverage, held since 2026-07-14)

The merged `coverage/lcov.info` sits at 100% lines (#192/#195/#196) and CI enforces it:
`scripts/check-coverage.mjs` fails the `Unit & Integration Tests` job on any zero-hit DA record,
printing the uncovered file:line ranges. Local check: `bun run test:coverage && bun run coverage:check`.

Holding 100% honestly requires knowing how bun measures:

1. **Per-function granularity (V8 semantics).** Functions that executed in a process get a precise
   executable-line map; functions that never ran are reported as coarse whole-span blocks whose DA
   sets include type annotations and JSX text lines. A process that merely loads a module (a
   mocked-away child, a transitive import) therefore claims lines as "coverable" that no exercising
   process does.
2. **Authority-universe merge** (`scripts/merge-lcov.mjs`, tested in `tests/unit/merge-lcov.test.ts`):
   per file, the record with the most executed lines decides which lines are coverable; per-line hit
   counts still take the max across all records, so secondary groups (e.g. the mobile-drawer group of
   a desktop-rendered component) keep contributing. Without this rule, load-only records surface
   phantom uncovered lines that no test can ever close.
3. **`run_group --nocov`** (`tests/run-components.sh`): groups that import without exercising (the
   exports CJS shim pulls the whole component chain) run without coverage collection entirely.
4. **Non-executable-line strip** (`merge-lcov.mjs`): bun emits DA records for blanks, comments, and
   bare punctuation; these are removed against the actual source before SonarCloud reads the report.
5. **Diagnosis recipe:** when a file shows stubborn uncovered lines, compare its records across
   `coverage/components/group-*/lcov.info` and `coverage/core/file-*/lcov.info`. If the zero lines
   are absent from the record with the most hits, they are measurement phantoms (fix the merge
   inputs), not test gaps.
6. **Mock fidelity over stubs:** hover/portal-dependent branches are closed by making test mocks
   honor the real library contract (recharts `Tooltip` renders its `content` element with an active
   payload; the select mock drives `onValueChange` through clickable items; dropdown items honor
   Radix `onSelect`) instead of reshaping production code.

`src/exports/index.js` (one-line CJS shim) is the single `sonar.coverage.exclusions` entry — it is
smoke-tested functionally in `tests/isolated/exports-shim.test.ts`.
