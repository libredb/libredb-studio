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
| Tests | single `bun test` | `tests/run-tests.ts`: one bun process per test file, several at a time, to avoid `mock.module()` cross-contamination |

Consequences:

- **attw uses the DEFAULT profile, NOT `--profile esm-only`** - the package is intentionally dual CJS+ESM,
  so attw must verify CJS resolution too.
- **ESLint is NOT reduced to type-aware-only** (the database move). `eslint-config-next` is the canonical
  Next linter and Studio ships as a Next app; reducing it would drop curated Next/React coverage.
- **CSS is excluded from the Biome formatter** - `src/app/globals.css` is order-sensitive: it carries
  deliberately unlayered declarations that must outrank Tailwind's utility layer and shadcn's `@layer base`
  rules, and a formatter that reorders or re-nests them silently changes which rule wins (every gate stays
  green; only the rendered page differs). Keep CSS out of Biome's scope.
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
  "markdown": { "formatter": { "enabled": false } },
  "yaml": { "formatter": { "enabled": false } },
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
(`src/**`, `tests/**`, `packages/**`, `e2e/**`, `scripts/**`, `bin/**`, `*.ts`, `*.mts`, `*.mjs`) does the filtering, so the
scripts can stay a plain `biome format .` / `biome format --write .`.

Notes:

- Style is double-quote + semicolons: consistent with database and with the existing `eslint.config.mjs`.
  The repo is inconsistent today (`tsup.config.ts` is single-quote / no-semi); the reformat unifies it.
- `css.formatter.enabled: false` (plus `json.formatter.enabled: false`) keeps `globals.css` and JSON files
  untouched - `globals.css` is order-sensitive (see the CSS note above) and formatting JSON would churn
  generated/config files for no gain.
- Biome 2.6 added Markdown and YAML formatters, enabled by default.
  `markdown.formatter.enabled: false` and `yaml.formatter.enabled: false` keep the scope at JS/TS: the 2.6 Markdown formatter pads every table column to one width, which turns a one-row change into a whole-table diff, and the YAML formatter refuses the deliberately malformed seed fixtures under `tests/fixtures/seed-connections/`.
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
  - `react/immutability` (8, added in oxlint 1.91) - a port of the React Compiler rule that eslint-config-next
    already runs as `react-hooks/immutability` at error; the port also flags the cancel-flag idiom inside an
    effect, which the original accepts, so ESLint stays the only enforcer.
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
The block also covers a workspace package's source, `packages/*/src/**/*.ts` ("Workspace packages (`packages/`)" below).

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

`dist/styles.css` is the line `@import "@xyflow/react/dist/style.css";`, the ER diagram's base styles, followed by `src/styles/theme.css` unchanged.
The published JavaScript imports no stylesheet: `tsup.config.ts` puts `/\.css$/` in `noExternal` and loads it with esbuild's `empty` loader (`loader: { ".css": "empty" }`), because Node cannot load a `.css` import, and before this a host's `import("@libredb/studio")` or `require("@libredb/studio")` under Node failed on the SchemaDiagram chunk's import of that sheet.
Both options are needed: tsup marks a dependency's stylesheet external by its package name before any user esbuild plugin runs, and tsup's own postcss step then loads every bundled `.css` with the configured loader.
The earlier `handle-css-and-xyflow` plugin never ran for that reason and was removed.
So the ER diagram's styles reach a host through the one documented import, as an `@import` the host's bundler resolves from the package's location (measured with esbuild and with Tailwind 4's PostCSS plugin), which redistributes none of xyflow's text.
`scripts/copy-theme.mjs` exits 1 naming the sheet when it does not resolve from the repository's install.

### The packed library loads (`lib:load`)

attw resolves the declared types and `lib:closure` reads the built text, and both passed a dist that could not load: one whose JavaScript or declarations named an unpublished workspace package, and one that imported a stylesheet.
`bun run lib:load` (`scripts/check-lib-load.mjs`), run after `build:lib`, is the check that installs the package the way a consumer gets it and loads it under Node:

1. It packs the repository with `bun pm pack` (as `attw` does), extracts the tarball to `<os.tmpdir()>/lib-load-<random>/node_modules/@libredb/studio/`, and fails by name when `dist/index.mjs`, `dist/index.js`, `dist/providers.mjs` or `dist/providers.js` is not in it.
2. It applies the two workspace rules below to the packed `package.json`.
3. It reads every module specifier of every `.js`, `.mjs`, `.d.ts` and `.d.mts` file of the packed `dist/` with the TypeScript parser, so SQL or fixture text inside a string is never taken for an import, and fails naming the file and the specifier unless the specifier is relative, a `dependencies` or `peerDependencies` name of the packed manifest (subpath dropped), a Node builtin (`module.isBuiltin`, so `node:sqlite` passes and a stripped `sqlite` fails), or a Bun runtime module (`bun:`, today only `bun:sqlite`).
   A computed `import()` or `require()` fails too, naming the file, because what it loads cannot be checked; there is none today.
   A relative specifier of a JavaScript file is left to the load in step 4, but nothing loads a declaration file, so a relative specifier of a `.d.ts` or `.d.mts` file must be one of the two forms the build writes, `./<name>.js` naming `<name>.d.ts` from a `.d.ts` or `./<name>.mjs` naming `<name>.d.mts` from a `.d.mts`, with that file in the dist; any other fails naming the file and the specifier.
4. It links only the declared names into the temporary `node_modules`, each to the repository's install, and a child `node` (`scripts/load-lib-closure.mjs`) loads every module of the `index` and `providers` closures once, ESM by `import()` and CJS by `require`, dynamic imports included, reporting each failing module with its error code and the first line of its message.

The load is isolated so that only a declared package can resolve.
The check refuses a temporary root that has an ancestor directory holding `node_modules`, and refuses when `<node prefix>/lib/node` exists.
The child runs without `NODE_PATH` and `NODE_OPTIONS`, with `HOME` and `USERPROFILE` set to an empty directory, because Node's CommonJS loader also searches `$HOME/.node_modules` and `$HOME/.node_libraries`.
The child has a 1 GB heap and a 120 s timeout, so a module whose top-level code hangs is named rather than waited on.
The temporary root is always removed.

The workspace rules: the packed manifest names no workspace package under `dependencies`, `peerDependencies` or `optionalDependencies`, since a consumer cannot install an unpublished package (`devDependencies` may name one); and every `dependencies` and `peerDependencies` name of a workspace package is a root `dependencies` or `peerDependencies` name, since tsup computes its externals from the root manifest alone and would otherwise inline the package's driver silently.
A workspace dependency is recognised by name, because `bun pm pack` writes `workspace:*` as the package's own version.

The packed manifest keeps `"workspaces": ["packages/*"]`.
Measured with npm 11.19.1 and bun 1.4.4, neither `npm install` nor `bun add` reads `workspaces` from a dependency's manifest, even when the tarball ships the directory, so the field is inert for consumers; it sits beside other root-only fields the packed manifest already carries unchanged (`scripts`, `devDependencies`, `overrides`, `patchedDependencies`), and removing it would need a pack-time rewrite of the tracked `package.json`.

Measured cost on main's dist: pack about 1.4 s, load about 1.4 s, scan under 1 s; the whole check takes about 4 s.
- Git-ignore `.attw/` and `*.tgz` (packaging scratch).
- CI: the `lint-and-build` job runs `build:lib`, `attw`, `lib:closure` and `lib:load`, in that order (plus a Biome format check), so the package
  surface is gated on every PR.

### The published engine id type (`DatabaseType`)

attw, `lib:closure` and `lib:load` check that the package resolves and loads, and none of them reads what a published type holds.
The engine id type is the one whose members move with Studio's engines, so `tests/unit/exports-database-type.test.ts` pins it as an exported-type snapshot.
It pins four things: the package's entries, as tsup's `entry` gives them and held one to one to the types exports of `package.json`; the form of `DatabaseType` in `src/lib/types.ts`, a union of string literals written in its own declaration, so it never moves with a table, a generated module or the engine catalog; the `index` and `types` entries exporting that one declaration; and its members and every published position whose type names it, such as `DatabaseConnection.type` and `WorkspaceConnection.type`.
Each position is pinned with how it is written: `?` when its declaration is optional, then its declaration's whole type, so `WorkspaceConnection.type: DatabaseType` becoming `DatabaseType | string`, `Exclude<DatabaseType, "postgres">` or optional fails the test although it still names the alias.
A reference outside its declaration's written type, such as a type parameter's constraint or a heritage clause, has no such form, and the test refuses it by name until it learns to key one.
It reads source with the TypeScript checker, not the built `dist/`, so it runs in `bun run test` on every platform of the unit matrix without a build.
The program has the package's entries as roots and `tsconfig.lib.json`'s options, and the walk reads only the types the declaration emitter publishes, following their type references from every export through every declaration of the repository it reaches: a declaration's written type, its type parameters and parameters, heritage clauses and members, and for a declaration written without a type, the type the checker infers for it, which is the type the emitter writes.
It never reads an initializer, a function body or an expression body, so a `satisfies` or a cast there is no position, and it skips a `private` or `#private` class member, which the declarations publish without its type.
A position spelled as an import type, `import("./types").DatabaseType`, is recorded like any other reference; an indexed access such as `DatabaseConnection["type"]` is not, since it follows a base position that is pinned in its own right.
When the test was written, its positions were exactly the places where `build:lib`'s declarations name `DatabaseType`, compared by a `grep` over `dist/*.d.ts`.
The file builds its program once, in about two seconds and 1.2 GB of resident memory on a developer machine, under a 60 s timeout per test.

A difference is classed by kind, and the failure names each id or position under `added` or `removed`.
An added id or an added position is a deliberate edit of the test's frozen list, made by the change that ships it and stated in that PR as a new member or position of a published type: not breaking for a value a consumer passes in, a new case for one it receives.
A removed id, a removed position, or the alias or a position opened to other text is breaking and waits for the library's next major.
A position whose written type or optionality changes is reported removed under its old form and added under its new one, so it is held as a removed position.
The change that first gives core an engine id outside the union declares the library's alias apart from core's and keeps every published position on that alias.

## Phase 5 - knip (keep, verify)

Each new tool (`biome`, `oxlint`, `attw`, `typescript-eslint`) gets a real package.json script or a config
import, so knip resolves them and counts them as used. As implemented, `bun run knip` was green with NO
`knip.json` change needed (database's finding held: scripts suffice, even for `attw` whose binary name differs
from `@arethetypeswrong/cli`, and `typescript-eslint` is seen via the `eslint.config.mjs` import).

## CI and pre-commit integration

As implemented in `.github/workflows/ci.yml`, the "Lint, Typecheck and Build" job runs, in order: Biome format
check (`bun run format`), linters (`bun run lint`, i.e. oxlint then ESLint), typecheck, knip, `next build`,
`build:lib`, `attw`, `lib:closure`, then `lib:load`. oxlint is folded into `bun run lint` rather than a separate step. The pre-commit git
hook (`.claude/settings.json`) runs `lint && typecheck && test && build` and now transitively enforces oxlint
and the type-aware layer via `bun run lint`.
In every workflow, the type check, `next build` and the Playwright runs whose first server builds run Node with `NODE_OPTIONS=--max-old-space-size=6144`, as the release payload build has since #1535, because `tsconfig.json` takes every TypeScript file, tests included, and that program peaks within tens of MB of Node's default heap of about 4 GB on a GitHub runner (`tests/unit/ci-node-heap.test.ts`).
The `typecheck` and `build` scripts in `package.json` set the same heap themselves, as `NODE_OPTIONS="--max-old-space-size=6144 $NODE_OPTIONS"` with any caller's options after it, because a cold local run with no `tsconfig.tsbuildinfo` aborted `tsc --noEmit` with `JavaScript heap out of memory` at the 4288 MiB default (measured 2026-11-02 on node v24.22.1), and `next build` type-checks in a worker that takes its heap from `NODE_OPTIONS`, so the workflow settings above are now redundant but kept.

`bun run lint` ends with one more step, added after the phases above: `node scripts/only-check.mjs`, the
focused-test guard from #979, also reachable on its own as `bun run only:check`. A committed `.only` makes bun
run that one test in the file, report it honestly and exit 0, so every other test the file registers is absent
from the report, the totals and the verdict alike - no report can show that, so it is refused from the source
before the run. It sits beside the other `scripts/*-check.mjs` guards rather than in the lint pipeline for the
reason its own docblock gives: a finding is printed as a file and a line for an editor to jump to, not as a
rule id. Its scope is `tests/` and `e2e/`, enumerated with `git ls-files` rather than a glob, so an untracked
draft cannot red a check that CI, which checks out tracked files only, cannot reproduce (#980).

### Golden files

`UPDATE_GOLDEN=1` makes a golden test write its files from the current tree, and the test then throws, so a rewrite is never a silent pass and a CI run with the variable set fails.
No file under `.github/` and no root `package.json` script sets the variable.
`tests/unit/golden-update-guard.test.ts` holds both: it parses every tracked code file that names `UPDATE_GOLDEN` and accepts a read only in the condition of an `if`, directly or through a `const` alias used only in `if` conditions, whose then-branch always ends in a `throw` and holds no `return`, `break` or `continue`.
It names by file and line a read anywhere else, a branch that does not end in a throw or can leave before it, a destructured variable and one set for a child process.
A dynamic name such as `process.env[name]` is out of a static guard's reach, and so is a throw a surrounding `try` catches and drops; the scan of `.github/` and the package scripts is the second line for both.

### `bun run test` and the process-wide `mock.module()`, and where isolation has to sit

`mock.module()` is process-wide with no undo, so a mock one layer installs reaches every file that
shares its process. `bun run test` is `bun tests/run-tests.ts`, which discovers every test file under
`tests/` except `tests/live/` and runs EACH ONE in its own bun process, several at a time, so no
file is ever reached by another file's mock. That is the whole reason the runner spawns a process
per file instead of handing a directory to `bun test`; the decision is argued in
`tests/runner/execute.ts`.

It used to be the other way round, and the cost was paid by contributors rather than by a gate.
`bun run test` ran `bun test tests/unit tests/api tests/integration` in ONE process while CI ran
the now-deleted `tests/run-core.sh`, one process per file, so the command CLAUDE.md documents for
pre-commit was red on a clean checkout and no gate could see it: 12849 pass, 42 fail, exit 1 on the
tree this change was written against, all of it one layer's mocks reaching a sibling that wanted the
real module. Those 42 are gone because the documented command and the gate now run the same way, not
because any mock was repaired. What the mocks are still wrong ABOUT is `docs/BACKLOG.md` D85.

Two bun options were measured on this suite and are NOT used. `bun test --isolate` (1.4.2) resets
the module registry per file inside one process, which would let the runner start far fewer
processes, and it does contain `mock.module` - but it is the subject of
[oven-sh/bun#41655](https://github.com/oven-sh/bun/issues/41655), a NAPI finalizer SIGSEGV that
reproduces serially on 1.4.2, and this suite loads three NAPI addons (`better-sqlite3`, `oracledb`,
`@duckdb/node-api`). `bun test --parallel` gave 0 fail in seven runs, then one run that hung for 17
minutes inside a synchronous helm spawn and one that failed 7 tests of
`tests/unit/docker-bind-address.test.ts` on 5000 ms timeouts; and
[oven-sh/bun PR 41467](https://github.com/oven-sh/bun/pull/41467), which stops a crashed worker
leaking its subprocesses, is merged but in no release, so 1.4.2 leaks them. A process boundary needs
no upstream fix. Re-probing `--isolate` when 41655 closes is `docs/BACKLOG.md` D86.

The process boundary is now structural, but the two cases it was first built by hand for are still
the clearest statement of what it buys, so both measurements stay here.

The first is a file that must load a module before anything else does:

- `tests/isolated/factory.test.ts` mocks six native driver packages and `@/lib/ssh/tunnel`, then
  imports `@/lib/db/factory` under a temporary `NODE_ENV=production`, diffing `process.listeners`
  around the import to show that it adds no SIGTERM or SIGINT listener even under production. Both
  steps happen once per process.
- So it passes only while it is the FIRST file in its process to evaluate `@/lib/db/factory`. Any
  earlier evaluation leaves it with an already-built module: an import that proves nothing, and unmocked
  drivers behind `getOrCreateProvider`, whose cached entry throws inside the `clearProviderCache()`
  in `beforeEach` and fails every remaining test in the file.
- Measured 2026-09-13: the file alone is 99 pass 0 fail; adding a three-line probe under
  `tests/unit/` whose only content is an import of `@/lib/db/factory` makes it 44 pass 56 fail. A
  probe importing `@/lib/ssh/tunnel` or `@/lib/db/compatibility` instead reproduces nothing, and an
  empty probe reproduces nothing. Both CLI orders give the same 56, because bun does not run test
  files in the order they are listed.
- It used to hold by accident: nothing else under `tests/unit` imported the factory.
  `tests/isolated/exports-shim.test.ts` had already been moved out for the same reason. #789 added
  two `tests/unit` files that construct every provider through the real factory, and a
  fleet census cannot do its job without importing it, so the accident ran out.

The second is the mirror image: a file that must read a module the rest of a layer replaces.

- `tests/isolated/object-source-declarations.test.ts` censuses what every provider
  declares, and `tests/isolated/monaco-language-ids.test.ts` checks every declared source language
  against the ids the installed Monaco registers. Both build providers through the REAL
  `createDatabaseProvider`, which is the point: a census that read a double would certify the
  double.
- Every file under `tests/api/` mocks `@/lib/db` with a `createDatabaseProvider: mock()` that
  answers undefined, which is that layer's standard pattern, and the mock reaches
  `@/lib/db/factory` through the index re-export. Measured 2026-09-13: the census beside
  `tests/api/db-objects.test.ts` is 3 fail, the language guard beside it is 1 fail, and each of
  them alone is 0 fail.

Moving those files into `tests/isolated/` was the only way to get each a process of its own while a
runner named its groups by hand. It is no longer what protects them, and no new file needs
that treatment: the directory keeps its name and its files because `docs/SECURITY.md`,
`sonar-project.properties` and several source comments cite the paths, not because the runner treats
it specially.

The rule the two cases leave: a test file whose assumption is unshareable - it has to be the first to
evaluate some module, or it has to read a module a whole layer replaces - says so in its own
docblock, naming the module and what the failure looks like. It needs no directory and no
registration, because the runner already gives it a process. What is still not allowed is the
reverse repair: pushing one file's constraint outward onto every file that might legitimately import
the module.

A test file that needs a tool a contributor may not have says so on its first line, and today there is one such tool.
The twelve chart tests that drive the real `helm` binary open with `// @requires helm`, and `tests/runner/requirements.ts` reads the marker before it starts a file.
Where `helm` is missing, or the chart's PostgreSQL subchart is not built, those files are not started, and the summary names them once under the reason and the command that fixes it; a selection made only of such files is an error, not an empty green run.
Every CI job that runs the suite sets `LIBREDB_REQUIRE_HELM=1`, which makes the same condition stop the run before anything starts, and `tests/unit/helm-pin-matrix.test.ts` fails if one of those jobs loses the variable.
The decision is per file rather than per test because each of those files needs Helm for everything it does, so skipping inside them would print about 180 test titles where twelve file names say the same.
Leaving them out costs no line coverage, because what they exercise is the chart's templates, which no lcov measures: measured on 2026-09-15 with `helm` hidden from `PATH`, 531 of the 543 files the tree held then ran, and the merged report was still 100% of its lines.
`tests/unit/test-runner-requirements.test.ts` holds the marker true of the tree in both directions: a file that spawns helm carries it, and a file that carries it spawns helm.

### What a file's verdict is read from, and how a run ends

A file's counts come from the junit report bun writes for it, never from its console output.
Every child is spawned with `--reporter=junit --reporter-outfile=<scratch>/file-N.xml`, and those two options are appended AFTER any argument forwarded past `--`, because bun takes the last of a repeated option: a forwarded `--reporter-outfile` would otherwise redirect the report and leave every file looking as though it wrote none.
Reading the console is what the runner did before, and free-form text mixed with whatever the tests printed can be made to say anything: measured on bun 1.4.2, a file that registered no test and printed the line ` 1 pass` was reported PASS with exit 0, and so was a test that printed a whole summary block on stderr and then called `process.exit(0)` so the tests after it never ran.
Both shapes defeat exactly the two guards that keep a red tree from turning green, "printed no summary" and "registered nothing".
`--bail` is the same defect from the other side: it prints no count line at all, while the report still carries the failure.
A report that is absent and one the parser cannot read are told apart, and neither ever becomes zero counts: the file fails, its line reads "no test report" or "unreadable test report", and the summary says how many files left no readable report and that their tests are not in the totals above it.
There is one shape no report can show, and the runner says so rather than pretending otherwise: bun honours a committed `.only`, so such a file writes an honest report naming that one test and exits 0, and the tests it never ran are absent from the report, the totals and the verdict alike (measured on 1.4.2).
That has to be refused before the run rather than read out of what the run wrote, and `scripts/only-check.mjs`
refuses it: see "CI and pre-commit integration" above.

Forwarding a flag to `bun test` works only when the runner is invoked directly and a selector comes first.
Measured on 1.4.2: `bun run test -- --bail` reaches the script as `["--bail"]`, because `bun run` removes the first `--`, and bun removes one that sits straight after the script path too, so `bun tests/run-tests.ts -- --bail` loses it as well.
`bun tests/run-tests.ts tests/unit -- --bail` is the form that arrives whole, and it is what the runner's unknown-option error names when it refuses a flag it does not own.

One flag the runner supplies itself: on Windows, and only there, every child is started with `--timeout=60000` in place of bun's own 5000ms per-test default.
Measured across three CI runs on windows-latest, six tests in four unrelated files died between 5003ms and 5522ms: the flat-zip packer, the agent run store, the SQLite provider and the agent investigation.
Every one of them was doing filesystem work under the user's temp directory or spawning a process, and the failures came with transient Windows sharing violations (`EPERM`, `EBUSY`, `ENOENT` on a rename) that the libraries doing the work retry internally.
The retries are correct and they are not free, so 5000ms is not a budget chosen for that machine, it is a default that happens to sit just under what it costs; the same files pass in 2.5s on a run where the machine is not loaded.
Raising it hides no hang, because a file that genuinely stops is still killed and reported by the runner's own per-file budget, which is 300 seconds.
The same thing happened one order of magnitude up, which is why the flag says 60000 and not the 30000 it said first: the runner's own coverage test, which spawns a second runner that spawns bun with coverage and then merges the report, died at 30671ms on windows-latest against 16.3s for that whole file on linux-x64.
Linux and macOS are left on bun's default on purpose: Linux is the leg the coverage gate and every contributor run on, and it is where a test that really did get slow has to stay visible.
The flag is placed before the forwarded arguments, so `-- --timeout=...` still wins, bun taking the last of a repeated option; `tests/unit/test-runner-cli.test.ts` measures that precedence against the real bun binary rather than assuming it.

One shape hangs a file on Windows that no per-test timeout catches.
Measured on windows-latest with Bun 1.4.4 (#2331): a test that awaits a timer (`Bun.sleep`, or a promise around `setTimeout`) and then calls `expect(promise).rejects` or `.resolves` on a promise a later timer settles spins at 100% CPU, no timer fires again, bun's per-test timeout included, and only the runner's 300-second per-file budget ends it.
The same case with the promise settled by a plain `await promise.catch(...)` passes, and Linux and macOS pass both.
Bun runs a timer's continuation inside its Windows timer dispatch, where the matcher's nested wait cannot fire a timer (oven-sh/bun#40023; oven-sh/bun#44833 makes the matcher non-blocking, in no Bun release yet).
So a test that needs events in an order waits on a signal its fixture gives rather than on a clock, as the read-only deadline cases in `tests/integration/db/mysql-provider.test.ts` wait for the statement to reach the fixture, or it settles the promise with a plain `await` before asserting.
This holds until the Bun that `package.json` pins carries both fixes.

The titles of the tests a file skipped come from the same report, and their describe path from its nested `<testsuite>` elements rather than from the `classname` attribute.
classname lists those titles too, but bun joins them with " &gt; " and writes a literal ">" inside a title as "&gt;" as well, so no split rule can tell the separator from the character: measured on 1.4.2, splitting classname turned a describe titled "rows where count > 100" into "100 > rows where count".
The titles are worth printing at all because a skip in this repository states its reason in its title, and bun prints that title nowhere: piped, with `FORCE_COLOR` set, and under a real pty, the output carries the count and nothing else.
A todo is in neither the count nor the list, although bun writes one as `<skipped message="TODO" />` as well: a todo has no reason to state and is already its own column in the totals line, and listing one under an "(N skipped)" header that does not count it would print two different numbers for one block.
A file whose report could not be read still prints the titles the parser reached before it stopped, under "unreadable report; it named N skipped tests" instead of a count it does not have.

Each child's stdout and stderr are captured rather than inherited, because several files run at once and interleaved output belongs to nobody, and each stream is bounded at BOTH ends by `tests/runner/capture.ts`: the first megabyte, the last megabyte, and one line naming how many bytes fell between them.
Both ends are kept because both are read, the head for bun's file header and the first failure diff, the tail for the rest of the diffs and bun's own per-file summary.
The megabyte is measured against this tree rather than guessed: across the 543 files the tree held when the measurement was taken on 2026-09-15, the largest prints 154,526 bytes on stdout, the largest stderr is 48,369 bytes and the median is 104 bytes, so nothing that runs here today is ever cut, and the worst case per running child is 4 MB.
Nothing is decided from that text, so a cut can never change a verdict.
A passing file's output is dropped once its line has been printed, which is what stops a whole run's output adding up: held to the end, four passing files printing 100 MB each peaked at 406 MB of RSS against 249 MB for one.

Every exit path writes its last line and waits for the bytes to leave the process before it calls `process.exit`.
bun writes to a pipe asynchronously and `process.exit` throws away whatever is still queued: measured on 1.4.2 through a piped stdout, a run whose failing file printed a megabyte lost about a third of that output and the whole summary with it, "Failed files:" and the re-run hint included, while the exit code stayed 1.
The wait has to be a real write whose callback resolves, because an empty write's callback does not wait for the queue and a `drain` event never arrives: `write()` returned false while `writableLength` was 0 and `writableNeedDrain` was false.
A non-empty write's callback does wait for everything queued before it, measured at 1 MB and at 10 MB and against a reader that started 1.5 seconds late, so one such write also drains the lines printed as the files landed.
What that covers is the lines this process writes: the per-file lines, the summary, the failed-file block and the re-run hint.
It does not cover a child's own console output, and nothing here can: measured under CPU load on 1.4.2, a failing file's `bun test` process drops part of its queued stdout as it exits, between 20 and 90 per cent of a megabyte, and it does so with no runner in the picture at all, so a failure diff read from a busy CI machine can still be truncated under an accurate verdict (`docs/BACKLOG.md` D96).
A write that fails because the reader has gone rather than because this process could not write is not the runner's problem and does not become its exit code: an `EPIPE` from `| head -1` or a closed terminal leaves the run's own 0, 1 or 128 plus signal in place, and exit 2 stays for a write the runner really could not make, a full disk for instance (measured against `/dev/full`, which reports `ENOSPC` and does exit 2).

SIGINT, SIGTERM, SIGHUP and SIGBREAK all end a run the same way: no further file is started, the files still running are killed, the scratch directory is removed, `Interrupted (SIGNAL).` is written, and the runner exits 128 plus the signal's number, so 130, 143 and 129, measured end to end for those three, and 149 for SIGBREAK, which only Windows can deliver and which is therefore pinned over the mapping rather than over a run.
The number is taken from the platform's own `os.constants.signals` where the platform names the signal, because that is the number its shell will report, and from the table written out in `tests/runner/signals.ts` where it does not: measured on 1.4.2, that table has no SIGBREAK on Linux or macOS, and `128 + undefined` is NaN, which `process.exit` refuses with a RangeError thrown from inside the listener.
SIGTERM is what `timeout(1)`, `docker stop`, Kubernetes and systemd send, and what `bun run test` forwards; SIGBREAK is Ctrl+Break, which GitHub Actions on Windows sends 7.5 seconds after Ctrl+C, and naming it is valid on every platform.
Handling only SIGINT, as this did, meant a run stopped any other way printed nothing at all and left its junit scratch directory behind in the temporary directory.
A scratch directory that cannot be removed is named on stderr and exits 2, neither swallowed nor thrown: measured on 1.4.2, a throw from inside a signal listener left the process RUNNING and the queue started the next file.
The default disposition is put back before the handler awaits anything, so a second signal kills the process outright instead of starting a second cleanup over the first, and the last write is raced against a three-second grace.
That grace is there because a reader that has stopped reading blocks the write behind a full pipe: measured on 1.4.2, the process then sat out the whole stall and survived a second SIGINT, a SIGTERM and a SIGHUP.
When the grace runs out the run still ends with its own exit code and its scratch directory gone, and the only thing lost is the `Interrupted` line, which the reader that was not reading would not have seen anyway.

Discovery refuses a symbolic link or junction under `tests/` by name instead of walking through it.
It used to skip one in silence, because a `readdirSync` Dirent for a link reports neither `isDirectory()` nor `isFile()`, so a linked directory and a file link named `*.test.ts` both fell out of the selection with nothing printed; entries are classified with `lstat` now, which also reports a Windows junction as a link.
Refusing rather than following is the other half of that decision: following a link can run files from outside the repository, loop on a link to a parent, or list one file twice under two names, while skipping it drops its tests without a word.

The default concurrency is one job per available CPU, and it is not memory-aware.
`availableParallelism()` in bun 1.4.2 follows CPU affinity and a cgroup v2 CPU quota, measured on a 20-core host: 2 under `taskset -c 0-1`, and 2 under `CPUQuota=200%`.
So a container with a CPU limit already gets as many jobs as it has CPU, and a laptop, a Codespace and a GitHub-hosted runner are all sized by that.
What the default does not read is a memory limit.
A test file's peak RSS over a 32-file sample runs from 58 MiB to 341 MiB with a median of 100 MiB, and under real concurrency the heaviest layer adds about 80 to 90 MiB per extra job: `tests/components` measured 599 MB at 4 jobs, 998 MB at 8 and 1599 MB at 16.
In a container with a memory limit and no CPU limit on a many-core host, pass `--jobs=N`.
A run that did not is readable rather than mysterious in the one case where the kernel kills a single child: that file's line names the OOM killer and `--jobs=N` in its reason, because the runner sends SIGKILL itself only to a child that outran its budget, and that child is reported as timed out instead.
Where the cgroup kills the whole group the runner dies with its children, so that reason is never printed and no file is named at all.
Under Kubernetes's default `memory.oom.group` the kernel SIGKILLs every process in the cgroup, and SIGKILL cannot be handled, so the output simply stops after the files that had already landed and the exit code is the only signal: reasoned from the kernel's semantics, not measured here.
Under systemd's default `OOMPolicy` the unit is stopped with SIGTERM instead, which this runner now takes: measured before that handling existed, such a run ended at exit 143 with no summary and its scratch directory left behind, so it now ends at the same 143 with `Interrupted (SIGTERM).` and nothing left in the temporary directory.
Neither shape names the file that exhausted the memory, which is the second reason a memory-aware default is worth having.
That default is `docs/BACKLOG.md` D95.

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
`PATH` and the repository checked out. The retry policy lives in one place because there are 21
install sites across 9 workflows; duplicated, it would drift immediately.
`tests/unit/ci-install.test.ts` covers the policy against a stub `bun` (first-try success, retry then
success, exhaustion, custom attempt count, no dead sleep after the final attempt).

## Patched dependencies

A driver flaw that Studio cannot fix through the driver's public API is fixed by patching the installed package (owner decision, 2026-11-21).
Bun takes one patch file per package, so each patch is the smallest change that fixes the flaws listed for it, each flaw held by an end-to-end test.
Each patch is listed in the table below and is removed when the upstream release Studio installs carries a fix for every flaw it lists.
A release that already fixes the flaw is installed instead, unless moving to it is work of its own, such as a major the Dependabot configuration holds back; the row then says so.

### How a patch is made

1. `bun patch <name>` copies the installed package out of Bun's global cache, so it can be edited in `node_modules/<name>`.
2. Edit the files there, and run the test that holds the fix.
3. `bun patch --commit node_modules/<name>` writes `patches/<name>@<version>.patch`, adds the entry to `patchedDependencies` in `package.json` and records it in `bun.lock`.
4. Add the row to the table below.

Never edit a file under `node_modules` any other way.
Bun links an installed package's files from its global cache (`~/.bun/install/cache`), so an in-place edit changes the cache entry itself, and every later install that links that entry, in any checkout on the machine, gets the edited file.
Measured 2026-11-21: a `cp` over `node_modules/ioredis/built/Redis.js` changed the patched cache entry, and a reinstall served the changed file; deleting that cache entry and reinstalling restored the patched one.

### What Bun 1.4.4 does when a patch and the install disagree

Measured 2026-11-21 in a scratch project with the ioredis patch:

| Situation | `bun install` (with or without `--frozen-lockfile`) |
| --- | --- |
| The installed version no longer matches the key, as after a version bump | warns `patches/<file> no longer applies (<name> is now <version>)`, installs the package unpatched, drops the entry from `bun.lock`, exits 0 |
| The patch file is missing | `error: patch file not found`, exits 1 |
| A hunk does not apply to a package of the key's version | `error: failed applying patch file: hunk #1 does not apply`, exits 1 |
| The entry is removed from `package.json` but kept in `bun.lock` | installs unpatched, exits 0 |

The first row is the one a Dependabot bump reaches, and Bun lets it through.
So [`tests/unit/patched-dependencies.test.ts`](../tests/unit/patched-dependencies.test.ts) fails instead: every entry's package must be installed at the key's version with every hunk of its patch present, every file in `patches/` must belong to an entry, `bun.lock` must record the same entries, every entry must have a row here and every row an entry, and each Dockerfile must copy the patches in before its install.
A bump of a patched package therefore lands together with the patch made again for the new version, or with the patch removed because the new version fixes the flaw.

### Where the patches are applied

Every install from a full checkout applies them: the CI composite action above, the devcontainer's `postCreateCommand`, and a contributor's `bun install`.
The three Dockerfiles install from a partial file set, so their deps stage copies `patches/` beside `package.json` and `bun.lock`; without it the install fails with the missing-file error above.
The images, the standalone payload and the desktop, Linux, Windows, Homebrew, AUR, Chocolatey, winget, Flatpak and Snap packages are all built from those installs, and none of them installs dependencies again.
The VS Code extension bundles the providers from the root `node_modules` (`absWorkingDir` in `vscode-extension/esbuild.mjs`; ioredis is not on `CHILD_EXTERNALS`), so its backend carries the patched code: measured 2026-11-21, the child bundle's ioredis inputs are `../node_modules/ioredis/built/DataHandler.js`, `Redis.js` and `redis/event_handler.js`, and its output holds every patched line.

The limit is the npm library.
`build:lib` (tsup) keeps every database driver external, so an application that embeds `@libredb/studio` installs the drivers itself, unpatched, and `patches/` is not in the published package.
Embedders read this in the README's "Embedding in your own app" section, which points here; they apply the same patch files, from the repository at the release's tag, with their own package manager.

### The patches

| Package and version | Patch file | What it fixes | Test that holds it | Upstream | Remove when |
| --- | --- | --- | --- | --- | --- |
| `cassandra-driver@4.10.0` | `patches/cassandra-driver@4.10.0.patch` | `lib/connection.js`: the connection's three read streams (`Protocol`, `Parser`, `ResultEmitter`) get an `error` listener that destroys the socket with a `DriverError` naming the host, so a frame the driver cannot parse fails the connect or the pending requests by name through the driver's own socket-error path and the pool replaces the connection, instead of being thrown out of the stream's handler; a connect that failed this way is not reopened by the driver's protocol-version downgrade ([cassandra.md §3.10](providers/cassandra.md#310-a-frame-the-driver-cannot-read-fails-the-connection-by-name-patched-driver)). `lib/control-connection.js`: when the control connection reconnects through the contact points after a lost connection, it shuts down the host it replaces, registers one set of listeners on its new connection instead of two, closes a connection whose reconnection failed on a server error, and closes its new connection when the client started shutting down meanwhile, so a connection the driver opens again after a lost one is closed by `disconnect()` ([cassandra.md §3.11](providers/cassandra.md#311-a-connection-the-driver-opens-again-after-a-lost-one-is-closed-by-disconnect-patched-driver)) | [`cassandra-provider.test.ts`](../tests/integration/db/cassandra-provider.test.ts), "a frame the driver cannot parse fails the connection by name", its `lost-connection` cases for the second file, with [`cassandra-fake-peer.ts`](../tests/helpers/cassandra-fake-peer.ts) | Not reported yet; the project tracks issues in the Apache JIRA project CASSNODEJS, and `trunk` is unfixed as of 2026-11-21 | A `cassandra-driver` release listens for `error` on the three streams, does not reopen a connect that has failed, and makes the four control-connection changes itself |
| `ioredis@5.11.1` | `patches/ioredis@5.11.1.patch` | `built/DataHandler.js`: a reply redis-parser 3.0.0 throws on (an array header longer than a JS array can be, or arrays nested deeper than the stack) takes ioredis's fatal-error path, which rejects the commands in flight and reconnects, instead of leaving the socket's `data` listener as an exception with the command waiting forever ([redis.md §4.6](providers/redis.md#46-a-reply-the-driver-cannot-read-and-a-tls-stream-that-fails-twice)) | [`redis-driver.test.ts`](../tests/integration/db/redis-driver.test.ts), [`redis-nested-reply-live.ts`](../tests/live/redis-nested-reply-live.ts) | Fixed in ioredis 6.0.0, whose `DataHandler` catches its decoder's throw the same way; not in any 5.x release | Studio moves to ioredis 6, a major `.github/dependabot.yml` holds back because it defaults to RESP3 |
| `ioredis@5.11.1` | `patches/ioredis@5.11.1.patch` | `built/Redis.js`: an error the socket survives, a TLS record it cannot decrypt, after which Node keeps the socket open and no reply can be read from it, takes ioredis's fatal-error path, which fails the commands in flight with that error at once and reconnects; and the client listens on its socket's `error` for the socket's whole life (`on`, was `once`), so an error that follows while the socket closes reaches the client's `error` event like the first ([redis.md §4.6](providers/redis.md#46-a-reply-the-driver-cannot-read-and-a-tls-stream-that-fails-twice)) | [`redis-driver.test.ts`](../tests/integration/db/redis-driver.test.ts) | Still `once` in 6.0.0 and 6.1.0-beta.1, whose socket `error` listener only emits the error; not reported yet | An ioredis release Studio installs fails the commands in flight on an error its socket survives, and keeps an `error` listener on its socket for the socket's whole life |
| `ioredis@5.11.1` | `patches/ioredis@5.11.1.patch` | `built/redis/event_handler.js`: with `autoResendUnfulfilledCommands` off, which `redisOptions()` sets so a command the server may already have run is not sent again after a reconnect, a connection that was ready and closes fails the commands in flight at once with ioredis's own "Connection is closed." (`flushQueue` with `offlineQueue: false`, so a command sent while the client reconnects still goes out once on the next connection); unpatched, `closeHandler` kept them for the next connection and `readyHandler` dropped them there without settling, so the caller waited forever. A connection that closes before it is ready again is not covered (D470 in [`BACKLOG.md`](BACKLOG.md)). The `SELECT`s `readyHandler` sends itself, which no caller awaits, are left as ioredis ships them: Studio gives every connection that reconnects its database as the `db` option, so ioredis selects it in `connectHandler`, whose `SELECT` already has a handler, and Studio's connections do not reach them ([redis.md §4.6](providers/redis.md#46-a-reply-the-driver-cannot-read-and-a-tls-stream-that-fails-twice)) | [`redis-driver.test.ts`](../tests/integration/db/redis-driver.test.ts), "a reset while a command waits fails the command with a named error, once, and the next command answers" and "a reset while an object read waits fails the read with the editor's named error, once"; "a reset while the reconnect's own SELECT waits is logged, and the next command runs in the database" and "a header no JS array can hold answering the reconnect's own SELECT is logged, and the next command answers", which fail with an unhandled rejection when a connection that reconnects reaches those `readyHandler` `SELECT`s instead | Dropped unsettled in 6.0.0; 6.1.0-beta.1 rejects them with an `AbortError`, "Command aborted due to connection close", but only once the client is ready again; not reported yet | An ioredis release Studio installs fails the commands in flight when the connection closes, with `autoResendUnfulfilledCommands` off |
| `oracledb@26.0.0` | `patches/oracledb@26.0.0.patch` | `lib/thin/sqlnet/ntTcp.js`: when an HTTPS proxy named in a TCPS descriptor answers the CONNECT with any status but 200, the socket the proxy answered on is destroyed at once; the driver kept no reference to it and it had no `error` listener, so it stayed open and a later reset of it was thrown out of the socket's event handler. Also in `ntTcp.js`: a TNS packet header shorter than 8 bytes is refused on the socket that read it, so a header that arrives after the client has closed the session itself fails the connect with its own error instead of failing inside the socket's event handler ([oracle.md §4.5](providers/oracle.md#45-a-proxy-that-refuses-the-connect-and-a-packet-header-the-driver-cannot-read)) | [`oracle-thin-transport.test.ts`](../tests/integration/db/oracle-thin-transport.test.ts) | The proxy flaw is in every release up to 26.0.0, the latest, the header flaw in every release from 7.0.0 to 26.0.0; neither reported yet | An oracledb release Studio installs destroys the socket of a refused proxy CONNECT and refuses a short header on the socket that read it |

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
2. Order-sensitive CSS - keep `globals.css` out of Biome; verify the embedded (`StudioWorkspace`) render
   path as well as the standalone app after the reformat.
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

`bun run test:coverage` is the same runner as `bun run test` with `--coverage
--merge-into=coverage/lcov.info`: one lcov per TEST FILE under `coverage/raw/`, merged by
`scripts/merge-lcov.mjs` at the end. Measured 2026-09-15 on Linux, 8 files at a time: about 60
seconds, and the merged report is 100% of 57157 lines. Two mechanics of that merge exist for
Windows: the report list is handed over as a manifest (`--inputs-from=<file>`) because 500-odd paths
do not fit in a Windows command line, and `merge-lcov.mjs` normalises a backslash `SF:` path, so
coverage produced on Windows merges as the same file as coverage produced on Linux instead of as a
second file the source filter then drops.
The source filter keeps `src/` (minus `src/components/ui/`) and each workspace package's `packages/<name>/src/` ("Workspace packages (`packages/`)" below).

Holding 100% honestly requires knowing how bun measures:

1. **Per-function granularity (V8 semantics).** Functions that executed in a process get a precise
   executable-line map; functions that never ran are reported as coarse whole-span blocks whose DA
   sets include type annotations and JSX text lines. A process that merely loads a module (a
   mocked-away child, a transitive import) therefore claims lines as "coverable" that no exercising
   process does.
2. **Authority-universe merge** (`scripts/merge-lcov.mjs`, tested in `tests/unit/merge-lcov.test.ts`):
   per file, the record with the most executed lines decides which lines are coverable; per-line hit
   counts still take the max across all records, so a secondary record (e.g. the mobile-drawer test
   of a desktop-rendered component) keeps contributing. Without this rule, load-only records surface
   phantom uncovered lines that no test can ever close. Per-file processes made this rule carry MORE
   than it used to: a run merges one report per test file rather than one per hand-written group, so
   a source file is now described by every test file that so much as imports it, and the load-only
   records among them outnumber what a grouped run produced. The max-hit record is what keeps those
   extra descriptions from adding uncoverable lines.
3. **`COVERAGE_EXEMPT_FILES`** (`tests/runner/discover.ts`): the two files that pull in a module
   chain without exercising it - the exports CJS shim loads every component, and the Monaco loader
   file imports the editor to observe a call it makes at module scope - run without coverage
   collection entirely. The docblock beside the list is where the reason lives, with what the shim
   alone would otherwise contribute (31 phantom uncovered lines in `src/lib/llm/factory.ts`).
4. **Non-executable-line strip** (`merge-lcov.mjs`): bun emits DA records for blanks, comments, and
   bare punctuation; these are removed against the actual source before SonarCloud reads the report.
5. **Diagnosis recipe:** when a file shows stubborn uncovered lines, compare its records across
   `coverage/raw/file-*/lcov.info` - one directory per test file, numbered by that file's position
   in the sorted selection, so line N of `bun tests/run-tests.ts --list` is what wrote `file-N`. If
   the zero lines are absent from the record with the most hits, they are measurement phantoms (fix
   the merge inputs), not test gaps.
6. **Mock fidelity over stubs:** hover/portal-dependent branches are closed by making test mocks
   honor the real library contract (recharts `Tooltip` renders its `content` element with an active
   payload; the select mock drives `onValueChange` through clickable items; dropdown items honor
   Radix `onSelect`) instead of reshaping production code.

`src/exports/index.js` (one-line CJS shim) is the single `sonar.coverage.exclusions` entry — it is
smoke-tested functionally in `tests/isolated/exports-shim.test.ts`.

## The host page benchmark

`bun run bench:host-page` (`scripts/host-page-benchmark.ts`) measures what the provider host adds to an editor query's answer, and checks it against the thresholds the owner signed for it, T1 to T5.
Each case answers a generated page twice: on today's path, composed from the production helpers without the host, and on the host's in-process path, through `runEditorQuery`, the legacy bridge, the host core's execute call and the SDK's pump.
The rows are generated, never real data: a narrow shape of 5 columns and a wide shape of 20, at 50, 500, 10,000 and 100,000 rows and at the most rows a 32 MiB page holds.
Both paths must answer the same text on every row the host answers in every case before anything is timed, compared row by row outside every timed section; where the host cut the page by bytes, its rows are today's first rows and the rest of its body is today's with the cut's row count and pagination.

The thresholds read the median time the host adds over 25 repetitions at 10,000 rows and 9 at the largest pages:
- T1, at most 150 ms per 10,000 wide rows.
- T2, at most 250 ms at the largest page the editor asks for, 100,000 narrow rows and the 32 MiB wide page.
- T3, at most 600 ms at a 32 MiB page of either shape.
- T4, at most 50 ms for the longest event-loop slice while the host's execute call runs, in every case, read by a `setImmediate` ticker.
- T5, at most 160 MiB of live heap the host path adds at a 32 MiB page, read after a forced gc at every turn the host yields and at the answer.

The whole-page `rowsWithNonFiniteWords` and the route's `JSON.stringify` are today's cost on both paths, so T4 leaves them out.
A 100,000-row wide page is larger than 32 MiB, so the host answers its first 32 MiB and today's path all of it; that case is printed and read by no threshold.

The runner bundles its case module with `Bun.build` into a temporary directory under `node_modules/.cache`, so the bundle's external packages resolve from the repository's own `node_modules`, then runs one fresh Node child per case and path, one at a time, under `--expose-gc --max-old-space-size=3000` with a 300 s timeout.
The child's entry is its composition root: it installs the process's host core (`installHostCore(createHostCore(), "benchmark-case")`, `src/lib/provider-host/instance.ts`) before the case runs, as `register()` does for the server.
The case reads its event-loop slice through that installed core (`hostCore().executeCall`), so the slices run on the process's one page budget as production does, and it releases each page record once the page answered.
It prints the machine, the runtime, every case and a pass or fail per threshold, and exits 1 when a threshold fails or a case failed.
The lead runs it on the reference machine before a change to the host's query path, through `heavy` with the production Node: `HEAVY_RUN_MEMORY_MAX=4G heavy bun run bench:host-page -- --node <path to node 26.13.1>`.
A failed threshold is the owner's decision, never a silent change of the threshold or of the path.
It never runs in `bun run test`: its timings hold only on an idle machine, not on a shared runner.
`tests/unit/host-page-benchmark.test.ts`, which does run there, holds that the case module imports the production facade, bridge and installed core and declares no pump of its own, that both paths answer the same text on a small page of each shape, that the comparison reads every answered row, a page cut by bytes included, and that the runner's thresholds are T1 to T5.

## Workspace packages (`packages/`)

The root `package.json` declares `"workspaces": ["packages/*"]`, and [`packages/README.md`](../packages/README.md) states the layout: a package is `packages/<name>/` with a `package.json`, its source under `src/` and its tests under `tests/`.
`scripts/workspace-packages.mjs` lists the packages for every gate that needs the list, and refuses by name a directory under `packages/` without a `package.json` and a link there.
The gates were widened before any package existed, so the first package, `packages/provider-sdk`, could not fall silently out of any of them.

### The linker

`bunfig.toml` sets `[install] linker = "hoisted"`.
Measured on bun 1.4.4 (2026-11-22): declaring the workspaces with no package, or with only `packages/README.md`, leaves `bun install --frozen-lockfile`, `bun.lock` and the whole `node_modules` layout byte for byte as they were.
One package with no dependencies switches bun to its isolated linker: the top level drops from 933 entries to 85 and every package moves under `node_modules/.bun`.
With the hoisted linker the layout is the same as without packages, plus a link `node_modules/@libredb/<name>` to the package, and `bun.lock` is identical to the isolated one, because the linker is not recorded in it.
The VS Code extension's `npm ci --ignore-scripts` is unaffected: its `npm prefix` stays `vscode-extension/` and its `node_modules` is unchanged.

### The images

The three Dockerfiles install from a partial file set, where two omissions change the install without failing it (measured 2026-11-22): without `bunfig.toml` the image installs with the isolated linker, and with a `bun.lock` naming a package whose `package.json` is absent, `bun install --frozen-lockfile` exits 0 and does not link the package.
So the deps stage copies `package.json bun.lock bunfig.toml`, then `patches/`, then one `COPY packages/<name>/package.json ./packages/<name>/` line per package, which `tests/unit/docker-workspace-install.test.ts` holds to the package list.
The builder asserts that `.next/standalone/packages` does not exist, and `scripts/lib/prune-standalone-payload.sh` removes `packages/` from every standalone payload.

### How each gate covers a package

- Format: `biome.json` `files.includes` has `packages/**`; without it Biome skips a misformatted package file and reports nothing.
- Lint: oxlint and ESLint lint the whole tree; the type-aware block (Phase 3) covers `packages/*/src/**/*.ts`, the sources only, as its `src/` scopes are; package tests get the untyped rules root tests get.
  A provider package's source also gets the coupling rules below.
- knip: it reads the root `package.json` `workspaces` and analyses each package with its defaults, so `knip.json` names no `packages/*` workspace; one there before any package exists only adds a "Remove from knip.json" hint.
- Tests: the runner (`tests/runner/discover.ts`) collects `packages/<name>/tests/` beside `tests/`, excluding `live/` in each, and accepts a selector under either; the focused-test guard reads the tracked files under `packages/<name>/tests/`.
- Coverage: `scripts/merge-lcov.mjs` keeps `packages/<name>/src/` records, so an uncovered package line fails the 100% gate; before, the merge dropped every record outside `src/`.
  `bun run coverage:check` passes `--packages-from=.`, which fails naming any package that has a `src/` directory and no record in the report, since a package no test loads has no record and so no gap to report.
  The check sits in the gate rather than in the merge, because the merge also serves partial runs, where a package the selection never loads rightly contributes nothing, and the VS Code extension's gate calls the same script without the option.
- SonarCloud: `sonar.sources` and `sonar.tests` both name `packages`, kept apart by patterns: package tests are `sonar.test.inclusions` and `sonar.exclusions`, and out of duplication detection.
- The VS Code extension: the host bundle refuses any `packages/` input, and the webview bundles a package file only when a sql-grammar row reaches it, as it does a file under `src/lib/db/providers/`.
- The standalone payload: pruned, as above.
- The library: `tsup.config.ts` bundles every package, because `@libredb/studio` on npm cannot depend on an unpublished package: its code through `noExternal`, read from `workspacePackageNames` in `scripts/workspace-packages.mjs`, and its declarations through `dts.compilerOptions.paths`, the root tsconfig's `paths` plus `workspacePackageSourcePaths`, which maps each `exports` entry of each package (root and subpaths) to its file under `packages/<name>/`.
  rollup-plugin-dts keeps a module TypeScript found through `node_modules` as an external import and inlines any other, so a package resolved through these paths is inlined with its own relative imports; tsup's `dts.resolve` matched a name exactly and resolved to the `node_modules` link, which left a subpath import, or a root package's relative import, in the declarations.
  `bun run lib:load` fails by name on a bare import of a package, on a declaration's relative import of a file the dist does not have, on a packed manifest that names a package, and on a package dependency the root does not declare ("The packed library loads (`lib:load`)").

### The package import rule

A package's source and tests import their own files, Node built-ins, the names their `package.json` declares and `@libredb/provider-sdk`, and its tests may also import a Bun runtime module; nothing in a package imports an `@/` path or a path out of its directory.
Core, under `src/`, `bin/`, `scripts/`, `tests/`, `e2e/` and `vscode-extension/src/`, reaches a package only by its name.
`tests/unit/package-imports.test.ts` reads the specifiers with the TypeScript compiler's `preProcessFile`, through the provider import scanner, and plants a package and core files that break each rule.
A root file that imports a package by name needs the package in the root `devDependencies` as `"workspace:*"`: knip reports it as an unlisted dependency otherwise (measured with knip 6 on the SDK, 2026-11-23).

### The SDK's generated files

Three generators keep the SDK's contract, the engine declarations and Studio's tables in step, each committed output held byte for byte by a test that renders it in memory, as the governance manifest is:

- `bun run manifest:types` (`scripts/generate-manifest-types.ts`) renders the manifest's TypeScript types and the schema's digest from `packages/provider-sdk/src/manifest/manifest.schema.json`; `tests/unit/provider-sdk/manifest-types.test.ts` fails on drift.
- `scripts/generate-engine-catalog.ts` writes, from the members each declaration authors, the engine catalog, `src/lib/db/engine-catalog/catalog.generated.ts`, the data-only connection tables, `src/lib/db/engine-catalog/connection.generated.ts` and `src/lib/db/engine-catalog/connection-flags.generated.ts`, the second holding the three tables `src/lib/db/compatibility.ts` reads, the connection forms, `src/lib/db/engine-catalog/connection-form.generated.ts`, which only `src/lib/db/connection-form.ts` reads, the connection strings, `src/lib/db/engine-catalog/connection-string.generated.ts`, which only `src/lib/db/connection-string/index.ts` reads, and each engine's execution UI and the fence aliases, `src/lib/db/engine-catalog/editor.generated.ts`, which `src/lib/db/execution-ui/index.ts` and `src/lib/sql/fence-tags.ts` read, and the query dialects, the tab type editors and the editor languages, `src/lib/db/engine-catalog/query-editor.generated.ts`, which `src/lib/db/query-dialects.ts`, `src/lib/editor/dialect-editors.ts` and `src/lib/db/editor-language/index.ts` read, each laid out as Biome lays them out; `--out` names a directory that receives all seven, and `tests/unit/db/engine-catalog.test.ts` fails on drift in any of them.
- `scripts/generate-engine-declarations.ts` writes `src/lib/db/engine-declarations/<type-id>.json`, each declaration's authored members kept from its committed file and every other member from the per-engine tables and each provider's unconnected declarations; `tests/unit/db/engine-declarations.test.ts` fails on drift.

`bun run engines:generate` runs the catalog generator's `--write`, then the declaration generator, then the catalog generator's `--check`.
The order is the declaration generator's need: it builds every provider through the factory, which builds only an engine the catalog holds.
`--write` reads each file's authored members without admitting the whole file, because a file whose authored members just changed still holds the generated members the previous ones gave, which the validator refuses beside them.
`--check` admits every engine declaration through the SDK's validator and holds every module to the admitted set, so the run ends with the written declarations admitted, or exits 1 with the validator's refusal, such as a placeable field the authored dialog does not place.
One run is exact, because the projections read only authored members, which the declaration generator writes back unchanged.

All three run inside `bun run test`, so none needs a CI step of its own.
The generators live in `scripts/`, which the coverage merge does not measure, so their tests are what holds them.

Tests resolve source: `tests/unit/source-plane.test.ts` holds every package's entry points (`exports`, `main`, `module`, `types`) under its `src/`, and fails a test under `tests/` or `packages/<name>/tests/` that imports a `dist/` path, the root package by name or a package's `dist/` subpath, so `lib:load` is the only path through a built artifact.

`tests/unit/package-gates.test.ts` proves the install, Biome, ESLint and knip rows on a throwaway root that carries the repository's own configuration file and one planted violation, so a tool upgrade that changes one of these behaviours fails a named test.
The other rows are held by the tests of the script that implements them.

### Provider source coupling lint

A block in `eslint.config.mjs` covers `packages/provider-*/src/**`, every JavaScript and TypeScript extension, except `packages/provider-kit/**`.
The kit is outside because it is the tool that checks providers: its CLI reads its own environment, working directory and console by design, and the half of it that runs inside Studio is host code.
The SDK, `packages/provider-sdk`, is inside, because it is loaded into Studio's process with every provider.
A new `provider-*` package is covered by default, and excluding one is a change to that block, reviewed with its own reason.

Every rule is an error, so `bun run lint` fails on a violation, and each message names this section:

- `no-restricted-properties` refuses `process.env` and `process.cwd`, in member, computed, destructured and default-parameter form.
- `no-restricted-globals` refuses `globalThis`, `global` and `console`.
- `no-restricted-imports` refuses `process`, `node:process`, `console` and `node:console`, which are the same objects under another name.

There is no exception list, and the block sets `linterOptions.noInlineConfig`, because a per-line exception is an exception list too: an `eslint-disable` comment there gets a warning that it has no effect, and the error stands.
Every value reference to `globalThis` and `global` is refused, not only an assignment to one of their properties.
The one provider that writes process-global state today, `processLanes` in the modbus agent pacing, writes through an alias (`const holder = globalThis as LanesHolder;` then `holder[LANES_KEY] ??= new Map();`), which a rule on the left-hand side of an assignment cannot see.
A type-only `typeof globalThis` is not a value reference and is not reported.
`console` goes through `no-restricted-globals` rather than core `no-console`, which reports `console.warn(...)` but not `const { warn } = console`, `const c = console; c.log(...)` or `globalThis.console.log(...)` (measured on ESLint 10.14.0).

It is a lint-time coupling check, not a security control.
It cannot see a driver under `node_modules` reading a proxy variable, `const p = process; p.env`, a `require` with a computed name, `createRequire(import.meta.url)("process")`, a dynamic `import("node:process")` or `Function("return this")()`; the kit's run under a poisoned environment is the run-time check.

The cost falls on the provider moves.
Spark's heartbeat takes `= globalThis` as the default for its timers, which becomes an error in a package, so its move passes `{ setInterval, clearInterval }` instead.
The providers' `eslint-disable-next-line` comments stop suppressing their warnings once the provider is in a package, so the move types the value or accepts the warning.

`tests/unit/provider-source-coupling-lint.test.ts` proves each rule on a throwaway root that carries the repository's `eslint.config.mjs`, with planted lines copied from today's providers and named by file and enclosing symbol, the scope boundaries above, and a probe in every provider package the repository has.

## VS Code extension (vscode-extension/)

`vscode-extension/` is a second package beside the Bun root, with its own toolchain and its own CI job.
It bundles LibreDB's provider layer from the root's `src/`, but it is not a workspace of the root's package manager, so the root's `bun install` does not install its packages.

### npm beside Bun

The extension's package manager is npm, because `vsce` reads a package's dependencies only through npm or Yarn 1.
`vscode-extension/package-lock.json` is its lockfile; a dependency is added with `npm install --save-exact` (or `--save-dev`) inside the directory, never by editing the lockfile.
CI installs it with `npm ci --ignore-scripts`.
The root's packages (React, the drivers) resolve from the root's `node_modules`, so `bun install` at the root runs first.

### Mocha with tsx

`@vscode/test-cli` runs Mocha only, so one framework serves the unit, integration and e2e legs.
tsx loads the TypeScript and honours `tsconfig.test.json`'s `paths`, which send `@/` to the root's `src/` and `vscode` to `test/fakes/vscode.ts`; `test/setup/register.cjs` points tsx at that file.
The editor modules' unit tests drive `FakeTextDocument` and `FakeTextEditor` from `test/fakes/documents.ts`, which compute offsets and positions over a text's lines as VS Code does for `\n` line ends.
Every Mocha configuration sets `forbid-only` (`.mocharc.json`, `test/integration/.mocharc.json` and `.vscode-test.mjs`), and `SCAN_ROOTS` in `scripts/only-check.mjs` reads `vscode-extension/test`, so `bun run lint` refuses a focused test there too.
`.vscode-test.mjs` also sets `failZero`: `@vscode/test-cli` hands Mocha an empty file list without an error, so an e2e glob that matches no file, a moved `test/e2e/smoke/` for one, would otherwise pass with nothing run.
The webview's unit files are `.tsx` and register happy-dom per file, through `useDom()` in `test/setup/dom.ts` at the top of a `describe` block, so no host or backend test ever sees a DOM global.
`tsconfig.test.json` sends `sonner` and `@/components/copy-button` to the webview's shims, so the unit leg renders `ResultsGrid` against what the bundle carries.
React and `@testing-library/react` resolve from the root's install.

### The extension's own 100% gate

c8 measures the unit leg only (`.c8rc.json`: `all: true` over `src/**`), and the root's `scripts/check-coverage.mjs` holds `coverage/lcov.info` to 100% lines: `npm run test:unit && npm run coverage:check`.
The root gate, Sonar and Codecov never see these lines, because `scripts/merge-lcov.mjs` keeps only the root's `src/` records and its workspace packages' `packages/<name>/src/` records.
The gate is line-granular: a callback written on the line that registers it counts as covered once the registration runs, so its test alone holds it.
A callback whose behaviour the gate must hold keeps its body on its own line, as `startBackend` in `src/backend/start.ts` does for its `disconnect` listener; without the case that closes the channel, the gate names that line.

### The five legs

- Unit: `npm run test:unit`, on Node 24, against the fake `vscode`.
- Integration: `npm run test:integration` forks the built child from `LIBREDB_BACKEND_RUNTIME=node` (the job's Node) or `LIBREDB_BACKEND_RUNTIME=vscode` (the pinned stable binary of `test/vscode-versions.json`, downloaded into `.vscode-test/` and run in Node mode with `ELECTRON_RUN_AS_NODE=1`), so a child that works on Node but not on VS Code's own runtime fails here (P5).
  `test/integration/backend-child.test.ts` runs against PostgreSQL, SQL Server, MySQL and MongoDB containers that `test/integration/containers.ts` starts from the images and environment of the same services in `database-compose.yml`, so the leg and the dev stack cannot drift.
  Each container is capped for a shared machine (`ENGINE_LIMITS`: 1 CPU and `512m` for PostgreSQL, 1 CPU and `1g` for MySQL and MongoDB, 2 CPUs and `2g` for SQL Server, whose `MSSQL_MEMORY_LIMIT_MB=1536` keeps it inside that cap), publishes its port on `127.0.0.1` only, and carries the label `org.libredb.vscode-extension.integration=<pid>-<epoch ms>`.
  The leg waits up to 180 s for each port, then for a `connection/test` through the child that succeeds, retried every second, because SQL Server opens its port before it accepts a login.
  It removes each container by its id in `after`, never by label or name, since another checkout's run may be live on the same machine; a killed run's leftovers are listed with `docker ps --filter label=org.libredb.vscode-extension.integration` and removed by hand.
  A local run therefore needs Docker on the machine.
- E2e: `npm run test:e2e` runs `@vscode/test-cli` on the floor and stable builds of `test/vscode-versions.json`, under `xvfb-run -a` on Linux.
  The build machine has no Xvfb, so the leg runs locally in a `node:24-bookworm` container that installs `xvfb` and VS Code's libraries and runs `xvfb-run -a npm run test:e2e` as the image's `node` user.
  Mount the checkout at a short path such as `/w`: VS Code listens on a socket under `.vscode-test/user-data/`, and a socket path over the 107-byte Unix limit fails with `listen EINVAL`.
  `test/e2e/backend-lifecycle.test.ts` starts PostgreSQL through Docker, so the local e2e container also runs with `--network host` and `-v /var/run/docker.sock:/var/run/docker.sock` and installs `docker.io` beside `xvfb`; the smoke subset needs no Docker access.
  The `node` user reaches the socket through a group with the socket's group id, created in the container and passed to `runuser -G`, as the command below does.
  The leg runs a second configuration per build, `vscode-<version>-workspace`, which opens `test/e2e-workspace/fixture` so the connections setting can be checked against a workspace value.
  That configuration also runs `test/e2e-workspace/connections.test.ts`, which drives the connection commands through scripted quick inputs against PostgreSQL in Docker: it and `backend-lifecycle.test.ts` each need a host whose extension has started no child yet, and Add Connection leaves the extension's own child running.
  The smoke subset runs neither the workspace configuration nor any file that needs Docker.
  `@vscode/test-electron` starts every host with `--disable-workspace-trust`, so the leg sees a trusted workspace only.
  `activate` exports nothing, so a test reaches what the extension created through `test/e2e/tree-capture.ts`, which wraps `vscode.window.createTreeView` before the extension activates and keeps the Connections view it captured on `globalThis`.
  The editor cases read the same way through `test/e2e/host-capture.ts`, which wraps `vscode.window.createStatusBarItem`, `vscode.window.createOutputChannel` and `vscode.commands.executeCommand` before the extension activates and keeps every `setContext` call, the LibreDB log's lines and the connection status bar item on `globalThis`.
  The same file also wraps `vscode.window.registerWebviewViewProvider` for the Results view, so `test/e2e/results-view.test.ts` and `test/e2e/smoke/results-view.test.ts` read each resolve, every message the host posts, every message the real webview sends and the view's description, and hand the host a message as the webview would.
  `test/e2e/first-run.test.ts` drives the first-run flow once per engine against PostgreSQL, SQL Server, MySQL and MongoDB in Docker: the empty view, Add Connection through the real quick inputs, New Query and Run, the tree down to a table's columns, Select Rows to the Results view, Load More and Cancel.
  It does not repeat the cases that already pass in `test/e2e/editors.test.ts` and `test/e2e/results-view.test.ts`.
  The coexistence subset, `LIBREDB_E2E_SUBSET=coexistence`, runs `test/e2e-coexistence/coexistence.test.ts` alone, with `ms-mssql.mssql` installed beside LibreDB.
  `configurationsFor` in `.vscode-test.mjs` gives it one `vscode-<version>-coexistence` configuration per build, whose `--extensions-dir` is `COEXISTENCE_EXTENSIONS_DIR` (`.vscode-test/extensions-coexistence`): `@vscode/test-cli` installs every `installExtensions` entry into the shared `.vscode-test/extensions`, so mssql installed there would load into every other e2e host.
  `scripts/coexistence-extensions.mjs` installs the pinned `COEXISTENCE_EXTENSIONS` into that directory from the Marketplace before `vscode-test` starts, and installs nothing outside the subset.
  mssql declares an extension pack of four more extensions, so `COEXISTENCE_EXTENSIONS` pins each of them beside mssql in the same install call, and `listingViolations` fails the run when the directory then lists anything but that pinned set.
  Because it downloads from the Marketplace, the subset runs in the daily workflow and by hand, never in the pull request job.
- Smoke: the e2e leg with `LIBREDB_E2E_SUBSET=smoke`, on macOS and Windows, with no Xvfb and no database.
  The smoke subset runs `test/e2e/smoke/tree-root.test.ts`, which needs no Docker; the full leg also runs `test/e2e/connections-tree.test.ts`, which does.
- Browser: `npm run test:browser` runs the results webview in Chromium with Playwright, after `npm run build`.
  `@playwright/test` is pinned to the root's version, because `npm run` finds only the package's own binaries, and the same version shares the root's Chromium.
  Its `playwright.config.mjs` starts no server: `test/browser/harness.ts` serves `dist/webview/` through `renderResultsHtml` with `page.route` and a fake `acquireVsCodeApi`, so the bundle runs under the view's real CSP.
  It sets `forbidOnly`, and it does not count toward coverage.

Beside the legs, `npm run test:vsix` runs `scripts/vsix-install-check.mjs` after `npm run package`: it installs the packed VSIX with the stable build's CLI into a scratch extensions and user data directory and reads `--list-extensions --show-versions`, because the e2e leg runs `dist/` from the development path, which proves the files and not the package.

The local e2e run, from the checkout's root after `npm run build` in `vscode-extension/`:

```bash
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD:/w" -w /w/vscode-extension node:24-bookworm bash -euc '
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends xvfb xauth libasound2 libgbm1 libgtk-3-0 libnss3 libxkbfile1 libsecret-1-0 docker.io >/dev/null
  gid=$(stat -c %g /var/run/docker.sock)
  getent group "$gid" >/dev/null || groupadd -g "$gid" hostdocker
  runuser -u node -G "$(getent group "$gid" | cut -d: -f1)" -- env HOME=/tmp/e2e-home xvfb-run -a npm run test:e2e'
```

`LIBREDB_VSCODE_VERSION` replaces the pinned builds of the integration and e2e legs with one version, which the Insiders run sets to `insiders`.

### Bundles and notices

`vscode-jsonrpc` 10.0.0 is the bundles' one runtime package: the host bundle's metafile check refuses any other `node_modules` input, and `test/unit/manifest.test.ts` holds it as the package's only dependency.
`CHILD_EXTERNALS` in `scripts/bundle-checks.mjs` names what the child bundle leaves to a runtime `require`: the drivers of the engines outside v0 (`bun:sqlite`, `@duckdb/*`, `db2-node`, `oracledb`), `cpu-features`, `proper-lockfile` and any `*.node` path.
`OPTIONAL_REQUIRES` names the nine packages the bundled drivers require inside their own `try` and do not install (`pg-native` from `pg`, `cardinal` from `mysql2`, `kerberos` from `mongodb` and `cassandra-driver`, and six more from `mongodb`), each with the packages allowed to require it.
The child's metafile check accepts such an import only as a `require()` from inside a package its entry names, so the same name required from anywhere else fails the build.
`renderNotices` in `scripts/notices.mjs` writes `THIRD_PARTY_NOTICES.txt` from every package that contributed an input to a bundle, and refuses a package whose licence it cannot place.
A package passes with an id on `LICENSE_ALLOWLIST` (`Unlicense` among them), with an `OR` expression one of whose plain ids is on the list, or with npm's legacy `licenses` array when every type in it is on the list; an expression with `AND` or `WITH` stays refused.
A package that ships no licence file takes its text from `third-party-licenses/<name>@<version>.txt`, whose first line, `Source: <URL>`, names where the text was copied from; a version bump finds no file and fails the build until the text is checked again.
`LICENSE_OVERRIDES` records, by exact `name@version`, the reviewed licence of a package whose `package.json` names none, and where that licence is stated.
A dependency bump that trips one of these rules is a reviewed change to that rule, never a widened pass.

### The webview bundle

The Results webview is built from LibreDB's source, not from the published package: `src/webview/main.tsx` is one IIFE for the browser at `es2022`, `dist/webview/results.js`.
Three module shims replace what cannot run in a webview, listed in `WEBVIEW_SHIMS` in `scripts/webview-shims.mjs`: `sonner` inserts an un-nonced `<style>` the CSP blocks, so each toast posts `notify` to the host instead; `@/components/copy-button` would write the clipboard itself, so its `writeToClipboard` asks the host to; and `@/lib/storage` throws, since the view keeps its state through `getState` and `setState`.
React, `react-dom` and `get-nonce` come in one copy each from the root's install, and the extension never declares them: a second copy would put two Reacts in the bundle.
`webviewViolations` in `scripts/bundle-checks.mjs` holds the metafile to that boundary inside `esbuild.mjs`, as the host's and the child's checks are held, and its unit test reads fixture metafiles, so the unit leg never reads `dist/`.

The stylesheet, `dist/webview/results.css`, is built by `@tailwindcss/cli`, pinned to the root's `tailwindcss`, from `src/webview/results.css`.
Its `@source` list is explicit, and `sourceCoverageViolations` in `scripts/webview-css.mjs` fails the build when a bundled file under `src/components/` lies under none of them.
`src/webview/vscode-bridge.css` maps LibreDB's tokens onto the `--vscode-*` variables every webview receives, so one mapping serves every theme.
`tailwindcss` is in the notices, because its preflight is compiled into the stylesheet.

### The engine logos

The build first bundles `scripts/engine-icons.tsx` into `out/scripts/` and runs it, before it bundles the extension.
The script writes `media/engines/**`, a light and a dark logo per engine and `index.json` with each engine's label, from `DB_UI_CONFIG` with the root's React and `react-dom/server`, so `npm run build` needs the root's `bun install` first.
It fails the build unless `DB_UI_CONFIG` and `SHIPPED_DATABASE_TYPES` hold the same set of types.
`media/engines/` is a build artifact that `vscode-extension/.gitignore` ignores and every build writes again, while the activity bar icon `media/libredb.svg` is committed.
The build also writes the 128 by 128 Marketplace icon `media/icon.png` from the brand mark `public/logo.svg` through `scripts/marketplace-icon.mjs`, and `vscode-extension/.gitignore` ignores it too.

### How the root tools cover the directory

- The root `tsc` excludes `vscode-extension` (`tsconfig.json` `exclude`); `npm run typecheck` checks it in its own job, where Mocha's globals and the `vscode` types exist.
- Biome formats `vscode-extension/**` minus `dist`, `out`, `dist-vsix`, `.vscode-test` and `coverage` (`biome.json` `files.includes`).
- oxlint (`.oxlintrc.json` `ignorePatterns`) and ESLint (`globalIgnores` in `eslint.config.mjs`) lint it minus the same five build paths.
  `vscode-extension/test/setup/register.cjs` is the repository's first `.cjs` file, so the ESLint block that tunes eslint-config-next's rules names eslint-config-next's own files pattern.
- knip has a `vscode-extension` workspace in `knip.json` beside the root's `workspaces["."]`.
  Its entries list neither bundle entry nor `esbuild.mjs`, which knip finds without them (it reports them as redundant entry patterns, `src/webview/main.tsx` among them); an export of the fake `vscode` module that only the code under test reaches, through `tsconfig.test.json`'s alias, which knip does not read, carries `@public` (today `window`).
  Its `project` and test entries take `.tsx` as well as `.ts`.
  The workspace turns knip's Playwright plugin off and names `test/browser/**/*.spec.ts` as an entry instead: the plugin loads `playwright.config.mjs`, which requires the extension's `@playwright/test` after knip has loaded the root's, and Playwright refuses a second copy.
  It ignores exactly `get-nonce`, `@radix-ui/react-use-layout-effect` and `sharp`.
  The webview and its tests import the first two from the root's install on purpose; declaring them in the extension would install a second copy beside React's.
  `scripts/marketplace-icon.mjs` renders the Marketplace icon through the root's `sharp`, the copy Next.js installs as its optional dependency, so the build reads one brand source with one renderer.
  The required `Lint, Typecheck and Build` job installs the extension's packages with `npm ci --ignore-scripts` before knip: measured on a clone with only the root installed, knip otherwise reports `c8`, `mocha` and `vscode-test` as unlisted binaries and `c8` and `@vscode/test-cli` as unused dependencies.
  Its `actions/setup-node` step gives that install npm's cache, keyed on `vscode-extension/package-lock.json`, and runs the job's Node tools on Node 24.
  Biome, oxlint, ESLint and the root `tsc` pass there without them.

### The CI job

`.github/workflows/vscode-extension.yml` is a reusable workflow that `ci.yml` calls as the `vscode-extension` job.
Its Linux job runs the typecheck, the build with its metafile checks, the unit leg and its gate, the browser leg, both integration runtimes, the e2e leg, `npm run package` and `npm run test:vsix`, and uploads the VSIX, failing when there is none; its smoke job runs on `macos-latest` and `windows-latest`.
`.github/workflows/vscode-extension-release.yml` calls the same file as its `gates` job on a pushed `vscode-extension-*` tag, so a release passes the gates a pull request does; its release runbook is in `docs/DISTRIBUTION.md`, "VS Code extension (Marketplace)".
The browser leg's Chromium comes from `bunx playwright install --with-deps chromium` at the repository root, because the job does not run in Playwright's image; the root's Playwright is the extension's version, so the extension's own Playwright finds that browser.
The smoke and Insiders runs have no browser leg: the webview is the same bytes on every OS and VS Code build.
It caches Bun's packages through `.github/actions/bun-install`, npm's through `actions/setup-node` keyed on `vscode-extension/package-lock.json`, and the VS Code builds through `actions/cache` keyed on `vscode-extension/test/vscode-versions.json`.
The VS Code cache holds `.vscode-test/vscode-*` only: the e2e leg's profile in `.vscode-test/user-data` and `.vscode-test/extensions` stays out of it, so no run starts from a profile an earlier run left, and a fork's pull request restores none.
`.github/workflows/vscode-extension-insiders.yml` runs the build, the `vscode` integration runtime and the e2e leg against VS Code Insiders daily and on demand, so an Electron or Node bump shows up before stable ships it; `test/vscode-versions.json` is bumped by hand.
Its `coexistence` job runs the coexistence subset on the pinned builds on the same schedule.
Dependabot watches `vscode-extension/` through its own `npm` entry, with `@types/vscode` held at the `engines.vscode` floor.
The job is not a required check until the owner adds it to `main`'s branch protection.
