# Workspace packages

This directory holds Studio's bun workspace packages: code staged as separate packages inside this repository before it moves to a repository of its own.
The root `package.json` declares them with `"workspaces": ["packages/*"]`.
The first package is `packages/provider-sdk/`, `@libredb/provider-sdk`: the provider contract's schema, its generated types and its validator under `/manifest`, the value codec under `/values`, the error record's contract under `/errors`, the call surface a provider package implements under `/calls`, the SQL grammar facts under `/sql`, and the memory test transport its tests and the kit call a provider through under `/testing` (`docs/providers/CONTRACT.md`).

## Layout

A workspace package is a directory `packages/<name>/` holding a `package.json`.
Its source is under `packages/<name>/src/` and its tests are under `packages/<name>/tests/`, with `packages/<name>/tests/live/` left to be run by hand, as the root's `tests/live/` is.
Nothing else under `packages/` is code.
A file such as this README is not a package, and a directory without a `package.json` is refused by name by every gate that lists packages, so a stray directory never holds tests that silently do not run.

`scripts/workspace-packages.mjs` states this rule once, and the gates below read it from there.

## Provider packages

A database provider can live as a workspace package named for its type-id, `packages/provider-<type-id>/`.
It holds the three legs of the provider triad: its code under `src/`, its doc as `docs/<type-id>.md`, and its integration test as `tests/integration/<type-id>-provider.test.ts`.
A type-id lives in exactly one layout, so the change that moves a provider here deletes its legacy code under `src/lib/db/providers/`, its `docs/providers/<type-id>.md` and its `tests/integration/db/<type-id>-provider.test.ts`.
A package serves only the type-id its directory names, until the provider manifest can declare several, so a doc or an integration test for another type-id in any package is refused.
The agent leg has no place in a package yet, so a type-id with a non-null `AGENT_STATEMENT_LANGUAGE` row stays in the legacy layout until the change that moves it gives its package one.
`tests/unit/db/provider-triad.test.ts` holds these rules for every shipped type-id, and `tests/helpers/provider-layout.ts` is how a test finds a provider's files in either layout.

## Install

`bunfig.toml` sets `[install] linker = "hoisted"`.
Without it, bun 1.4.4 installs a workspace root with its isolated linker as soon as one package exists, which moves every dependency under `node_modules/.bun` and changes the layout Studio builds, tests and ships with.
With it, the layout stays the one a root without packages gets, and each package is linked at `node_modules/<name>`.
The linker is not recorded in `bun.lock`, so the setting has to travel with every install, the images' included.

## Imports

A package imports its own files, Node built-ins, the names its `package.json` declares and `@libredb/provider-sdk`, and its tests may also import a Bun runtime module such as `bun:test`.
A package never imports an `@/` path or a path out of its own directory, so it depends on no other package's internals and on none of Studio's, and moving it to a repository of its own changes no import.
Studio's own code, under `src/`, `bin/`, `scripts/`, `tests/`, `e2e/` and `vscode-extension/src/`, reaches a package only by its name, never by a path into `packages/`, so what Studio sees of a package is what its `exports` publish.
A package never imports or declares another provider package: only `@libredb/provider-sdk`, and `@libredb/provider-kit` in its tests and its `devDependencies`.
A root file that imports a package by name needs the package in the root `devDependencies` as `"workspace:*"`, or knip reports it as unlisted.
`tests/unit/package-imports.test.ts` holds these rules.

## Docker

Each Dockerfile installs its dependencies from a partial file set, and two files change what that install does without failing it.
Without `bunfig.toml` the image installs with the isolated linker, and without a package's `package.json` a frozen install skips the package and still exits 0.
So the deps stage copies `package.json bun.lock bunfig.toml` together, and adding a package adds one line to each of the three Dockerfiles, before `RUN bun install --frozen-lockfile`:

```dockerfile
COPY packages/<name>/package.json ./packages/<name>/
```

A wildcard `COPY` would flatten the directories, so each package has its own line.
`tests/unit/docker-workspace-install.test.ts` fails when a Dockerfile lacks one.
The builder stage asserts that `.next/standalone/packages` does not exist, and `scripts/lib/prune-standalone-payload.sh` removes `packages/` from every standalone payload.

## Library

`@libredb/studio` on npm cannot depend on an unpublished package, so the library build (`tsup.config.ts`) bundles every workspace package, its code and its declarations, by the names `scripts/workspace-packages.mjs` lists.
The declaration build resolves a package through TypeScript `paths` that map each of its `exports` entries, the root and every subpath, to the entry's file under `packages/<name>/` (`workspacePackageSourcePaths`), so rollup-plugin-dts inlines the package's declarations, its own relative imports included, instead of leaving an import of the unpublished package.
Every `exports` entry is therefore one path string; a conditional-exports object is refused by name, because no single source file stands for it.
A package is never a root `dependencies`, `peerDependencies` or `optionalDependencies` entry, since a consumer's install would look for it on the registry; the root may list it under `devDependencies`.
Every `dependencies` and `peerDependencies` name of a package is also a root `dependencies` or `peerDependencies` name, because the bundled package's drivers are the library's own.
`bun run lib:load` enforces all of this on the packed package (`docs/TOOLCHAIN.md`, "The packed library loads (`lib:load`)").

## The SDK tarball

`bun run sdk:pack -- --out <dir>` builds `@libredb/provider-sdk` into a tarball of ES modules with declarations that a provider developer outside the repository installs with npm.
The repository's `packages/provider-sdk/package.json` keeps its entry points on the source; the packed `package.json` points them at `dist/`, written at pack time.
The build runs in a temporary directory and writes nothing into the repository.
`docs/TOOLCHAIN.md`, "The SDK tarball (`sdk:pack`)", records why and what the pack test checks.

## Planes

Tests resolve source: a package's `exports`, `main`, `module` and `types` point under its `src/`, and no test under `tests/` or `packages/<name>/tests/` imports a `dist/` path, `@libredb/studio` by name or a package's `dist/` subpath.
`bun run lib:load`, the SDK's pack test (`packages/provider-sdk/tests/pack.test.ts`), which builds the tarball it reads, and the out-of-tree acceptance (`scripts/out-of-tree-acceptance.ts`), which packs the tarball it installs, are the only paths through a built artifact.
`tests/unit/source-plane.test.ts` holds both rules.

## Gates

Every gate that finds its files by a `src/` or `tests/` path also reads a package:

- The test runner (`tests/runner/discover.ts`) runs `packages/<name>/tests/` beside `tests/`, and accepts a selector under either.
- The focused-test guard (`scripts/only-check.mjs`) reads the tracked files under `packages/<name>/tests/`.
- The coverage merge (`scripts/merge-lcov.mjs`) keeps `packages/<name>/src/` records, so a package's uncovered line fails the 100% gate, and `bun run coverage:check` passes `--packages-from=.`, so a package with a `src/` directory and no record fails it by name.
- SonarCloud (`sonar-project.properties`) reads a package's `src/` as source and its `tests/` as tests.
- Biome (`biome.json` `files.includes`) formats `packages/**`.
- oxlint and ESLint lint the whole tree, and the type-aware ESLint block also covers `packages/*/src/**/*.ts`.
- ESLint refuses `process.env`, `process.cwd()`, `globalThis`, `global` and `console` in `packages/provider-*/src/` (the kit excepted), with no inline disable (`docs/TOOLCHAIN.md`, "Provider source coupling lint").
- knip analyses each package as a workspace, through the root `package.json` `workspaces`.
- The root `tsc` checks every `.ts` file under the root, packages included.
- The packed library check (`bun run lib:load`) fails on a dist or a packed manifest that names a package, and on a package dependency the root does not declare.
- The package import rule (`tests/unit/package-imports.test.ts`) reads every package's `src/` and `tests/`, and every core file that names `packages/`, as "Imports" says.
- The VS Code extension's bundle checks (`vscode-extension/scripts/bundle-checks.mjs`) refuse package code in the host bundle, and let the webview bundle a package file only when a sql-grammar row reaches it.

`tests/unit/package-gates.test.ts` plants a violation in a throwaway package for the install, Biome, ESLint and knip, and fails when one of them stops seeing it.
`docs/TOOLCHAIN.md`, "Workspace packages (`packages/`)", records the measurements behind these choices.
