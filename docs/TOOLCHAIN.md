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
  untouched - `globals.css` is order-sensitive (see the CSS note above) and formatting JSON would churn
  generated/config files for no gain.
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

`bun run lint` ends with one more step, added after the phases above: `node scripts/only-check.mjs`, the
focused-test guard from #979, also reachable on its own as `bun run only:check`. A committed `.only` makes bun
run that one test in the file, report it honestly and exit 0, so every other test the file registers is absent
from the report, the totals and the verdict alike - no report can show that, so it is refused from the source
before the run. It sits beside the other `scripts/*-check.mjs` guards rather than in the lint pipeline for the
reason its own docblock gives: a finding is printed as a file and a line for an editor to jump to, not as a
rule id. Its scope is `tests/` and `e2e/`, enumerated with `git ls-files` rather than a glob, so an untracked
draft cannot red a check that CI, which checks out tracked files only, cannot reproduce (#980).

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
  imports `@/lib/db/factory` under a temporary `NODE_ENV=production` so the SIGTERM and SIGINT
  handlers the module registers on load can be captured by diffing `process.listeners`. Both steps
  happen once per process.
- So it passes only while it is the FIRST file in its process to evaluate `@/lib/db/factory`. Any
  earlier evaluation leaves it with an already-built module: no handler to capture, and unmocked
  drivers behind `getOrCreateProvider`, whose cached entry throws inside the `clearProviderCache()`
  in `beforeEach` and fails every remaining test in the file.
- Measured 2026-09-13: the file alone is 99 pass 0 fail; adding a three-line probe under
  `tests/unit/` whose only content is an import of `@/lib/db/factory` makes it 44 pass 56 fail. A
  probe importing `@/lib/ssh/tunnel` or `@/lib/db/compatibility` instead reproduces nothing, and an
  empty probe reproduces nothing. Both CLI orders give the same 56, because bun does not run test
  files in the order they are listed.
- It used to hold by accident: nothing else under `tests/unit` imported the factory.
  `tests/isolated/exports-shim.test.ts` had already been moved out for the same reason. #789 added
  two `tests/unit` files that construct all seventeen providers through the real factory, and a
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
second file the `src/` filter then drops.

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
