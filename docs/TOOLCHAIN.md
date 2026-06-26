# LibreDB Studio Toolchain - 2026 Adoption Plan

> Status: PLANNED (no code changes yet). This is a per-tool adoption plan for five tools, ported from the
> researched-then-adversarially-verified decision record in `libredb-database/docs/TOOLCHAIN.md` and adapted to
> Studio's reality: a Next.js 16 + React 19 + TSX application that ALSO ships as the dual-format npm package
> `@libredb/studio` (consumed by `libredb-platform`). The database record is the rationale source of truth;
> this document records only what changes for Studio and why.

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
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "css": { "formatter": { "enabled": false } },
  "linter": { "enabled": false },
  "assist": { "enabled": false }
}
```

Scripts:

```jsonc
"format": "biome format src tests *.ts *.mjs",
"format:fix": "biome format --write src tests *.ts *.mjs"
```

Notes:

- Style is double-quote + semicolons: consistent with database and with the existing `eslint.config.mjs`.
  The repo is inconsistent today (`tsup.config.ts` is single-quote / no-semi); the reformat unifies it.
- `css.formatter.enabled: false` keeps `globals.css` and other CSS untouched (platform-integration risk).
- Deliverable: a single `chore(format): adopt Biome formatter` PR (~256 files). Afterwards run `build:lib`
  and verify BOTH modes (standalone + embedded), per the repo's UI-change rule. Coordinate timing to avoid
  clashing with open PRs.

## Phase 2 - Oxlint

Sub-second syntactic linter; a fail-fast layer in front of ESLint.

`.oxlintrc.json`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "plugins": ["typescript", "oxc", "react", "react-hooks", "jsx-a11y", "nextjs", "import"],
  "categories": { "correctness": "error", "suspicious": "error", "perf": "warn", "pedantic": "off", "style": "off" },
  "rules": {},
  "ignorePatterns": ["dist/**", ".next/**", "out/**", "build/**", "coverage/**", "node_modules/**", "next-env.d.ts"]
}
```

Notes:

- The `unicorn` plugin is NOT added (taste noise, same call as database).
- The first run on a React codebase may surface noise; reaching green may require turning off one or two
  rules. Any disabled rule gets a justifying comment (as `no-shadow` / `approx-constant` do in database).
- Scripts: add `"lint:oxc": "oxlint"`, and make `lint` run oxlint first: `"lint": "oxlint && eslint ."`.

## Phase 3 - typescript-eslint + ESLint (Strategy A: keep Next, layer oxlint)

`eslint-config-next` stays exactly as it is in `eslint.config.mjs` (it owns core-web-vitals, the typescript
config, and the react-hooks rules). Oxlint is layered on top for fast syntactic feedback; ESLint remains the
curated Next/React safety net.

Optional follow-up (recommended, can be a later phase): add a narrow type-aware layer scoped to the
async-heavy code (`src/app/api/**`, `src/lib/db/**`) - `@typescript-eslint/no-floating-promises`,
`no-misused-promises`, `await-thenable`. These pay off more in Studio than in database (synchronous core).
Cost: enabling `parserOptions.projectService: true` makes that scope's lint slower.

Rejected for Studio: the database-style reduction of ESLint to type-aware-only with React/Next rules moved
to oxlint. For a shipping Next app the risk of losing `eslint-config-next`'s curated coverage outweighs the
single-linter simplicity.

## Phase 4 - attw (@arethetypeswrong/cli)

High value here: the package has 5 subpath exports, dual CJS+ESM, and emits both `.d.ts` and `.d.mts` - the
exact surface where types-resolution and CJS/ESM-masquerading bugs hide.

```jsonc
// scripts
"attw": "rm -rf .attw && bun pm pack --quiet --destination .attw && attw .attw/*.tgz",
"prepublishOnly": "tsup && bun run attw"
```

Notes:

- DEFAULT profile (no `--profile esm-only`): the package is intentionally dual-format, so CJS resolution
  must be checked.
- `rm -rf .attw` runs FIRST (not trailing): a trailing `&& rm` would mask attw's exit code, and pre-cleaning
  drops a stale tarball from a previous version bump.
- attw needs `dist/` from `build:lib` (tsup), so `prepublishOnly` runs `tsup` before `attw`. In CI use
  `build:lib`, never `next build`, before attw.
- Git-ignore `.attw/` and `*.tgz` (packaging scratch).
- Expectation: the `exports` map already orders `types` first within each `import`/`require` condition, so
  attw is likely green - but verifying that across all 5 entries is exactly the point.

## Phase 5 - knip (keep, verify)

Each new tool (`biome`, `oxlint`, `attw`) gets a real package.json script, so knip resolves their binaries to
their packages and counts them as used - no `knip.json` change is expected (database's finding: scripts
suffice, even for `attw` whose binary name differs from `@arethetypeswrong/cli`). After adoption, run
`bun run knip`; if anything is flagged, add a single justified `ignoreBinaries` / `ignoreDependencies` entry.

## CI and pre-commit integration

- `.github/workflows/ci.yml`, the "Lint, Typecheck and Build" job: add two steps before the existing ESLint
  step - Format check (`bun run format`) and oxlint (`bun run lint:oxc`).
- attw belongs in a packaging step/job that runs `bun run build:lib && bun run attw` (not `next build`).
  Natural homes: `npm-publish.yml` and/or a small dedicated package-check job.
- Update `libredb-studio/CLAUDE.md`: the mandatory pre-commit four (lint, typecheck, test, build) becomes six
  with `format` and `oxlint`.

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

## Suggested package versions

`@biomejs/biome@^2.5`, `oxlint@^1.71`, `@arethetypeswrong/cli@^0.18.4`. `eslint` / `eslint-config-next` /
`typescript-eslint` / `knip` stay at their current Studio versions.
