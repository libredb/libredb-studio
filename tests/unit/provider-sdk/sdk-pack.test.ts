/**
 * The pure half of `bun run sdk:pack` (scripts/sdk-pack.ts): its command line, the published manifest it writes at
 * pack time, the build plan it reads from the repository manifest, and the check of the staged package.
 *
 * The build and the pack themselves run in packages/provider-sdk/tests/pack.test.ts, in a child process, which installs
 * the tarball outside the repository and imports and type-checks it there.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPlan,
  main,
  missingPublishedFiles,
  parsePackArguments,
  publishedManifest,
  SDK_BUILD_TSCONFIG,
  SDK_DIRECTORY,
} from "../../../scripts/sdk-pack";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SDK_MANIFEST = JSON.parse(readFileSync(path.join(SDK_DIRECTORY, "package.json"), "utf8")) as Record<
  string,
  unknown
>;

/** A small ES module manifest with one TypeScript entry, one nested entry and one JSON entry. */
function manifest(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@libredb/planted",
    version: "1.0.0",
    private: true,
    type: "module",
    types: "./src/index.ts",
    exports: {
      ".": "./src/index.ts",
      "./calls": "./src/calls/index.ts",
      "./schema.json": "./src/manifest/schema.json",
    },
    dependencies: { ajv: "^8.17.1" },
    ...fields,
  };
}

describe("the published manifest", () => {
  test("publishedManifest points each TypeScript entry at its built module and declaration under dist/, and the JSON entry at its copy", () => {
    const published = publishedManifest(manifest());

    expect(published.types).toBe("./dist/index.d.ts");
    expect(published.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./calls": { types: "./dist/calls/index.d.ts", default: "./dist/calls/index.js" },
      "./schema.json": "./dist/manifest/schema.json",
    });
    expect(Object.keys(published.exports as object)).toEqual([".", "./calls", "./schema.json"]);
  });

  test("publishedManifest leaves every other field as the repository manifest writes it, private included", () => {
    const source = manifest({ description: "d", license: "MIT", devDependencies: { typescript: "^6.0.3" } });
    const published = publishedManifest(source);

    expect(Object.keys(published)).toEqual(Object.keys(source));
    const withoutEntryPoints = (fields: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(fields).filter(([field]) => field !== "exports" && field !== "types"));
    expect(withoutEntryPoints(published)).toEqual(withoutEntryPoints(source));
    expect(published.private).toBe(true);
    expect(source.exports).toEqual(manifest().exports);
  });

  test("publishedManifest refuses an entry that is not one TypeScript or JSON file under src/, naming it", () => {
    for (const target of ["./dist/index.js", { default: "./src/index.ts" }, "./src/x.mjs", null, "src/index.ts"]) {
      expect(() => publishedManifest(manifest({ exports: { ".": "./src/index.ts", "./x": target } }))).toThrow(
        `exports "./x" is ${JSON.stringify(target)}`,
      );
    }
    expect(() => publishedManifest(manifest({ types: "./dist/index.d.ts" }))).toThrow('types is "./dist/index.d.ts"');
    expect(() => publishedManifest(manifest({ types: "./src/schema.json" }))).toThrow('types is "./src/schema.json"');
  });

  test("publishedManifest refuses a package that is not an ES module, and one without an exports object", () => {
    expect(() => publishedManifest(manifest({ type: "commonjs" }))).toThrow('"type" is "commonjs", not "module"');
    expect(() => publishedManifest(manifest({ type: undefined }))).toThrow('"type" is undefined, not "module"');
    for (const exports of [undefined, "./src/index.ts", ["./src/index.ts"], null]) {
      expect(() => publishedManifest(manifest({ exports }))).toThrow("has no exports object");
    }
  });

  test("the repository's SDK manifest maps to a published one with no refusal", () => {
    const published = publishedManifest(SDK_MANIFEST);

    expect(Object.keys(published.exports as object)).toEqual(Object.keys(SDK_MANIFEST.exports as object));
    expect(published.dependencies).toEqual({ ajv: expect.any(String) });
    expect(published.type).toBe("module");
  });
});

describe("the build plan and the staged package", () => {
  test("buildPlan names one build entry per TypeScript entry and one copy per JSON entry, under the SDK directory", () => {
    const plan = buildPlan(manifest(), "/sdk");

    expect(plan.entries).toEqual({
      index: path.join("/sdk", "src", "index.ts"),
      "calls/index": path.join("/sdk", "src", "calls", "index.ts"),
    });
    expect(plan.copies).toEqual([
      { from: path.join("/sdk", "src", "manifest", "schema.json"), to: path.join("dist", "manifest", "schema.json") },
    ]);
  });

  test("buildPlan builds the repository SDK's seven TypeScript entries and copies its schema", () => {
    const plan = buildPlan(SDK_MANIFEST, SDK_DIRECTORY);

    expect(Object.keys(plan.entries)).toEqual([
      "index",
      "manifest/index",
      "values/index",
      "errors/index",
      "calls/index",
      "sql/index",
      "testing/index",
    ]);
    expect(plan.copies.map((copy) => path.relative(SDK_DIRECTORY, copy.from).split(path.sep).join("/"))).toEqual([
      "src/manifest/manifest.schema.json",
    ]);
    expect(path.dirname(SDK_BUILD_TSCONFIG)).toBe(SDK_DIRECTORY);
  });

  test("missingPublishedFiles names every published target the staged package lacks", () => {
    const staged = mkdtempSync(path.join(tmpdir(), "sdk-pack-staged-"));
    try {
      const published = publishedManifest(manifest());
      expect(missingPublishedFiles(published, staged)).toEqual([
        "types ./dist/index.d.ts",
        'exports["."].types ./dist/index.d.ts',
        'exports["."].default ./dist/index.js',
        'exports["./calls"].types ./dist/calls/index.d.ts',
        'exports["./calls"].default ./dist/calls/index.js',
        'exports["./schema.json"] ./dist/manifest/schema.json',
      ]);

      mkdirSync(path.join(staged, "dist", "calls"), { recursive: true });
      for (const file of ["index.d.ts", "index.js", "calls/index.d.ts"]) {
        writeFileSync(path.join(staged, "dist", file), "");
      }
      expect(missingPublishedFiles(published, staged)).toEqual([
        'exports["./calls"].default ./dist/calls/index.js',
        'exports["./schema.json"] ./dist/manifest/schema.json',
      ]);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });
});

describe("the command line", () => {
  test("parsePackArguments takes --out and one directory", () => {
    expect(parsePackArguments(["--out", "a"])).toEqual({ out: "a" });
    for (const argv of [[], ["--out"], ["--out", "--x"], ["--out", "a", "b"], ["--outdir", "a"]]) {
      expect(parsePackArguments(argv)).toBeNull();
    }
  });

  test("the command line is --out and one directory; anything else exits 2 with the usage line and builds nothing", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      const refused = [[], ["--out"], ["--out", "--x"], ["--out", "a", "b"], ["--outdir", "a"]];
      expect(await Promise.all(refused.map((argv) => main(argv)))).toEqual([2, 2, 2, 2, 2]);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual(Array(5).fill("Usage: bun run sdk:pack -- --out <dir>"));
  });

  test("package.json runs the pack as sdk:pack", () => {
    const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;

    expect(scripts["sdk:pack"]).toBe("bun scripts/sdk-pack.ts");
  });
});
