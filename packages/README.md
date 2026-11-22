# Workspace packages

This directory holds Studio's bun workspace packages: code staged as separate packages inside this repository before it moves to a repository of its own.
The root `package.json` declares them with `"workspaces": ["packages/*"]`.
No package exists yet; this file is here so the layout is written down, and so every gate that names `packages/` names a directory that exists.

## Layout

A workspace package is a directory `packages/<name>/` holding a `package.json`.
Its source is under `packages/<name>/src/` and its tests are under `packages/<name>/tests/`, with `packages/<name>/tests/live/` left to be run by hand, as the root's `tests/live/` is.
Nothing else under `packages/` is code.
A file such as this README is not a package, and a directory without a `package.json` is refused by name by every gate that lists packages, so a stray directory never holds tests that silently do not run.

`scripts/workspace-packages.mjs` states this rule once, and the gates below read it from there.

## Install

`bunfig.toml` sets `[install] linker = "hoisted"`.
Without it, bun 1.4.4 installs a workspace root with its isolated linker as soon as one package exists, which moves every dependency under `node_modules/.bun` and changes the layout Studio builds, tests and ships with.
With it, the layout stays the one a root without packages gets, and each package is linked at `node_modules/<name>`.
The linker is not recorded in `bun.lock`, so the setting has to travel with every install, the images' included.

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

## Gates

Every gate that finds its files by a `src/` or `tests/` path also reads a package:

- The test runner (`tests/runner/discover.ts`) runs `packages/<name>/tests/` beside `tests/`, and accepts a selector under either.
- The focused-test guard (`scripts/only-check.mjs`) reads the tracked files under `packages/<name>/tests/`.
- The coverage merge (`scripts/merge-lcov.mjs`) keeps `packages/<name>/src/` records, so a package's uncovered line fails the 100% gate, and `bun run coverage:check` passes `--packages-from=.`, so a package with a `src/` directory and no record fails it by name.
- SonarCloud (`sonar-project.properties`) reads a package's `src/` as source and its `tests/` as tests.
- Biome (`biome.json` `files.includes`) formats `packages/**`.
- oxlint and ESLint lint the whole tree, and the type-aware ESLint block also covers `packages/*/src/**/*.ts`.
- knip analyses each package as a workspace, through the root `package.json` `workspaces`.
- The root `tsc` checks every `.ts` file under the root, packages included.
- The VS Code extension's bundle checks (`vscode-extension/scripts/bundle-checks.mjs`) refuse package code in the host bundle, and let the webview bundle a package file only when a sql-grammar row reaches it.

`tests/unit/package-gates.test.ts` plants a violation in a throwaway package for the install, Biome, ESLint and knip, and fails when one of them stops seeing it.
`docs/TOOLCHAIN.md`, "Workspace packages (`packages/`)", records the measurements behind these choices.
