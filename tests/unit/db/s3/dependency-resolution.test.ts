/**
 * The S3 object preview's Parquet reader must load the exact versions it was measured against:
 * the page pre-scan, the guarded compressors and the prefetch buffer depend on how hyparquet 1.31.1 plans column
 * chunk reads and parses page headers, so a bump is a provider change. Both packages run no install script, and the
 * library build keeps them external because preview-parquet.ts loads them through a dynamic import.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const NODE_MODULES = path.join(ROOT, "node_modules");

interface Manifest {
  readonly version: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly "//dependencies"?: string;
}

const read = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest;
const manifest = read(path.join(ROOT, "package.json"));
const compressorsManifest = path.join(NODE_MODULES, "hyparquet-compressors", "package.json");
const resolveFrom = (from: string, specifier: string): string => createRequire(from).resolve(specifier);

describe("the Parquet preview's dependencies", () => {
  test("hyparquet and hyparquet-compressors are pinned exactly", () => {
    expect(manifest.dependencies?.hyparquet).toBe("1.31.1");
    expect(manifest.dependencies?.["hyparquet-compressors"]).toBe("1.1.2");
  });

  test("the installed manifests carry the pinned versions, and the two codecs are the ones hyparquet-compressors pins", () => {
    expect(read(path.join(NODE_MODULES, "hyparquet", "package.json")).version).toBe("1.31.1");
    expect(read(compressorsManifest).version).toBe("1.1.2");
    expect(read(resolveFrom(compressorsManifest, "fzstd/package.json")).version).toBe("0.1.1");
    expect(read(resolveFrom(compressorsManifest, "hysnappy/package.json")).version).toBe("1.1.1");
  });

  test("none of the four packages declares an install script, so no trustedDependencies entry is needed", () => {
    const manifests = [
      read(path.join(NODE_MODULES, "hyparquet", "package.json")),
      read(compressorsManifest),
      read(resolveFrom(compressorsManifest, "fzstd/package.json")),
      read(resolveFrom(compressorsManifest, "hysnappy/package.json")),
    ];
    for (const each of manifests) {
      expect(each.scripts?.preinstall).toBeUndefined();
      expect(each.scripts?.install).toBeUndefined();
      expect(each.scripts?.postinstall).toBeUndefined();
    }
  });

  test("the //dependencies note names both packages and the one module that loads them", () => {
    const note = manifest["//dependencies"] ?? "";
    expect(note).toContain(
      "hyparquet and hyparquet-compressors are pinned exactly for the S3 provider's object preview",
    );
    expect(note).toContain("src/lib/db/providers/objectstore/s3/preview-parquet.ts is the only module that loads them");
  });

  test("the library build keeps both packages external", () => {
    const tsup = readFileSync(path.join(ROOT, "tsup.config.ts"), "utf8");
    expect(tsup).toContain('    "hyparquet",\n    "hyparquet-compressors",\n');
  });
});
