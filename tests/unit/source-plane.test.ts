/**
 * Tests resolve source (packages/README.md, "Planes").
 *
 * A test that imports a built artifact proves the build, not the code, and passes against a stale dist. So every
 * workspace package's entry points resolve under its `src/`, and no test under `tests/` or `packages/<name>/tests/`
 * names a `dist/` path, the root package (`@libredb/studio`, whose exports are `dist/`) or a workspace package's
 * `dist/`. `bun run lib:load` (scripts/check-lib-load.mjs) and the SDK's pack test
 * (packages/provider-sdk/tests/pack.test.ts), which builds the tarball it reads in a temporary directory, are the only
 * paths through a built artifact.
 *
 * Out of scope, by design: `e2e/`, since Playwright drives a built server; `vscode-extension/test`, which is not a bun
 * workspace package; and a computed specifier in a test, which cannot be read without running it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtArtifactImports, entryPointFailures } from "../helpers/source-plane";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway root named like the repository's package, holding the given files. */
function plantedRoot(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "source-plane-"));
  roots.push(root);
  const all = { "package.json": JSON.stringify({ name: "@libredb/studio", workspaces: ["packages/*"] }), ...files };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

/** A root with one workspace package whose manifest carries `fields`. */
function packageWith(fields: Record<string, unknown>): string {
  return plantedRoot({
    "packages/planted/package.json": JSON.stringify({ name: "@libredb/planted", ...fields }),
  });
}

describe("workspace package entry points resolve source", () => {
  test("fails an exports path under dist/, naming the package and the key", () => {
    expect(entryPointFailures(packageWith({ exports: { ".": "./dist/index.js" } }))).toEqual([
      expect.stringMatching(/^packages\/planted exports\["\."\] is "\.\/dist\/index\.js"/),
    ]);
  });

  test("fails a nested condition under dist/, naming its path", () => {
    const root = packageWith({ exports: { ".": { import: "./src/index.ts", require: "./dist/index.cjs" } } });

    expect(entryPointFailures(root)).toEqual([
      expect.stringMatching(/^packages\/planted exports\["\."\]\["require"\] is "\.\/dist\/index\.cjs"/),
    ]);
  });

  test("fails main, module and types under dist/, each by field", () => {
    const root = packageWith({ main: "./dist/index.js", module: "dist/index.mjs", types: "./src/../dist/index.d.ts" });

    expect(entryPointFailures(root)).toEqual([
      expect.stringMatching(/^packages\/planted main is/),
      expect.stringMatching(/^packages\/planted module is/),
      expect.stringMatching(/^packages\/planted types is/),
    ]);
  });

  test("passes source paths and a null leaf that blocks a subpath", () => {
    const root = packageWith({
      types: "./src/index.ts",
      main: "./src/index.ts",
      exports: { ".": "./src/index.ts", "./internal/*": null, "./both": ["./src/a.ts", "./src/b.ts"] },
    });

    expect(entryPointFailures(root)).toEqual([]);
  });
});

describe("tests import no built artifact", () => {
  test("fails a root test that imports the root's dist/", () => {
    const root = plantedRoot({ "tests/unit/a.test.ts": 'import { x } from "../../dist/index.mjs";\n' });

    expect(builtArtifactImports(root)).toEqual([
      expect.stringMatching(/^tests\/unit\/a\.test\.ts imports "\.\.\/\.\.\/dist\/index\.mjs"/),
    ]);
  });

  test("fails a package test that imports its package's dist/", () => {
    const root = plantedRoot({
      "packages/planted/package.json": JSON.stringify({ name: "@libredb/planted" }),
      "packages/planted/tests/a.test.ts": 'const x = require("../dist/index.js");\n',
    });

    expect(builtArtifactImports(root)).toEqual([
      expect.stringMatching(/^packages\/planted\/tests\/a\.test\.ts imports "\.\.\/dist\/index\.js"/),
    ]);
  });

  test("fails the root package by name and a workspace package's dist/ subpath", () => {
    const root = plantedRoot({
      "packages/planted/package.json": JSON.stringify({ name: "@libredb/planted" }),
      "tests/unit/a.test.ts":
        'import "@libredb/studio";\nimport "@libredb/planted/dist/x";\nimport "@libredb/planted";\n',
    });

    expect(builtArtifactImports(root)).toEqual([
      expect.stringContaining('tests/unit/a.test.ts imports "@libredb/studio"'),
      expect.stringContaining('tests/unit/a.test.ts imports "@libredb/planted/dist/x"'),
    ]);
  });

  test("passes a third-party dist/ subpath and dist text inside a template literal", () => {
    const root = plantedRoot({
      "tests/unit/a.test.ts": 'import "@xyflow/react/dist/style.css";\nconst text = `import "../../dist/index.mjs"`;\n',
    });

    expect(builtArtifactImports(root)).toEqual([]);
  });

  test("the repository keeps both rules", () => {
    expect(entryPointFailures(REPOSITORY_ROOT)).toEqual([]);
    expect(builtArtifactImports(REPOSITORY_ROOT)).toEqual([]);
  });
});
