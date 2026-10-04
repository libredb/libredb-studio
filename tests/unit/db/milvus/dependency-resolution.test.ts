/**
 * The Milvus descriptor's generator and the runtime loader read one protobufjs, at the version package.json pins, as
 * the etcd provider's do (vector-family spec 5.1, E21): zero new packages, the two gRPC pins now serving two
 * providers, and the `//dependencies` note saying so.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const NODE_MODULES = path.join(ROOT, "node_modules");
const ROOT_MANIFEST = path.join(ROOT, "package.json");
const GENERATOR = path.join(ROOT, "scripts", "generate-milvus-descriptor.mjs");

interface Manifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly "//dependencies"?: string;
}

const readManifest = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Manifest;
const resolveFrom = (fromFile: string, specifier: string) => createRequire(fromFile).resolve(specifier);
const MANIFEST = readManifest(ROOT_MANIFEST);

describe("the Milvus client's dependency pins", () => {
  test("the two gRPC packages are the exact runtime pins etcd measured, and protobufjs a dev pin only", () => {
    expect(MANIFEST.dependencies?.["@grpc/grpc-js"]).toBe("1.14.5");
    expect(MANIFEST.dependencies?.["@grpc/proto-loader"]).toBe("0.8.1");
    expect(MANIFEST.devDependencies?.protobufjs).toBe("7.6.6");
    expect(MANIFEST.dependencies?.protobufjs).toBeUndefined();
  });

  test("the generator and @grpc/proto-loader resolve one protobufjs inside this repository, at the pin", () => {
    const fromProtoLoader = resolveFrom(
      resolveFrom(ROOT_MANIFEST, "@grpc/proto-loader/package.json"),
      "protobufjs/package.json",
    );
    expect(resolveFrom(GENERATOR, "protobufjs/package.json")).toBe(fromProtoLoader);
    expect(fromProtoLoader.startsWith(NODE_MODULES + path.sep)).toBe(true);
    expect(readManifest(fromProtoLoader).version).toBe("7.6.6");
  });

  test("the //dependencies note says the gRPC pins serve the etcd and Milvus providers, and names both generators", () => {
    const note = MANIFEST["//dependencies"] ?? "";
    expect(note).toContain("pinned exactly for the two gRPC providers, etcd and Milvus");
    expect(note).toContain("scripts/generate-milvus-descriptor.mjs");
    expect(note).toContain("tests/unit/db/milvus/dependency-resolution.test.ts");
  });
});
