/**
 * The Kafka client must load from this repository's own install, not by luck from a parent directory.
 *
 * `@platformatic/kafka` imports `ajv-draft-04`, whose optional peer is `ajv` ^8.5.0, and the draft-04
 * module requires `ajv/dist/core` at load time. Bun hoists `ajv-draft-04` to the top of node_modules,
 * where `ajv` used to be eslint's 6.x, which has no `dist/core`. The library's single entry point
 * re-exports its schema registries, so `import("@platformatic/kafka")` then failed in any clean install
 * (a Docker build, CI) with "Cannot find module 'ajv/dist/core'", and passed on a machine that happened
 * to hold an ajv 8 in a directory above the checkout. The direct `ajv` dependency in package.json is
 * what puts ajv 8 at the top; nothing here imports ajv, so these assertions are what keep it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const NODE_MODULES = path.join(ROOT, "node_modules");

/** Resolve `specifier` the way the file at `fromFile` would, with Node's algorithm. */
function resolveFrom(fromFile: string, specifier: string): string {
  return createRequire(fromFile).resolve(specifier);
}

function packageVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;
}

describe("Kafka client dependency resolution", () => {
  const kafkaManifest = path.join(NODE_MODULES, "@platformatic", "kafka", "package.json");
  const draft04Entry = resolveFrom(kafkaManifest, "ajv-draft-04");

  test("ajv-draft-04 resolves inside this repository", () => {
    expect(draft04Entry.startsWith(NODE_MODULES + path.sep)).toBe(true);
  });

  test("the ajv that ajv-draft-04 sees is an 8.x inside this repository", () => {
    const ajvManifest = resolveFrom(draft04Entry, "ajv/package.json");
    expect(ajvManifest.startsWith(NODE_MODULES + path.sep)).toBe(true);
    expect(packageVersion(ajvManifest).split(".")[0]).toBe("8");
  });

  test("ajv/dist/core, which ajv-draft-04 requires at load time, resolves inside this repository", () => {
    expect(resolveFrom(draft04Entry, "ajv/dist/core").startsWith(NODE_MODULES + path.sep)).toBe(true);
  });
});
