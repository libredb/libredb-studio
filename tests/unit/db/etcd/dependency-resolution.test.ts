/**
 * The etcd descriptor's generator and its runtime loader must read one protobufjs, at the version package.json pins.
 *
 * The vendored `versionpb/version.proto` imports `google/protobuf/descriptor.proto`, which protobufjs does not
 * register as a common file of its own. `@grpc/proto-loader` registers it, in the protobufjs copy that proto-loader
 * resolves, when it loads, and `scripts/generate-etcd-descriptor.mjs` imports proto-loader first for exactly that
 * reason: the generator can load the protos only while the protobufjs it imports is that same copy. It is also the
 * copy whose `fromJSON` reads the committed descriptor at run time. package.json therefore pins protobufjs exactly,
 * as a devDependency inside proto-loader's own range, so bun dedupes both onto one copy at the top of node_modules,
 * and `@platformatic/kafka`'s optional protobufjs 8 nests under the Kafka package instead of sitting at the top.
 *
 * The two gRPC packages are pinned exactly too (spec 3.2): the provider's TLS server-name rule depends on grpc-js
 * internals, so a new version is a provider change that is measured again, never a routine bump.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const NODE_MODULES = path.join(ROOT, "node_modules");
const ROOT_MANIFEST = path.join(ROOT, "package.json");
const GENERATOR = path.join(ROOT, "scripts", "generate-etcd-descriptor.mjs");

interface Manifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function readManifest(manifestPath: string): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

/** Resolve `specifier` the way the file at `fromFile` would, with Node's algorithm. */
function resolveFrom(fromFile: string, specifier: string): string {
  return createRequire(fromFile).resolve(specifier);
}

const MANIFEST = readManifest(ROOT_MANIFEST);

describe("etcd client dependency pins", () => {
  test("@grpc/grpc-js and @grpc/proto-loader are exact runtime dependencies", () => {
    expect(MANIFEST.dependencies?.["@grpc/grpc-js"]).toBe("1.14.5");
    expect(MANIFEST.dependencies?.["@grpc/proto-loader"]).toBe("0.8.1");
  });

  test("protobufjs is an exact devDependency and no runtime dependency", () => {
    expect(MANIFEST.devDependencies?.protobufjs).toBe("7.6.6");
    expect(MANIFEST.dependencies?.protobufjs).toBeUndefined();
  });

  test.each(["@grpc/grpc-js", "@grpc/proto-loader"])("the installed %s is the pinned version", (name) => {
    expect(readManifest(resolveFrom(ROOT_MANIFEST, `${name}/package.json`)).version).toBe(
      MANIFEST.dependencies?.[name] as string,
    );
  });
});

describe("etcd descriptor protobufjs resolution", () => {
  const fromProtoLoader = () =>
    resolveFrom(resolveFrom(ROOT_MANIFEST, "@grpc/proto-loader/package.json"), "protobufjs/package.json");
  const fromGenerator = () => resolveFrom(GENERATOR, "protobufjs/package.json");

  test("@grpc/proto-loader and the generator resolve one protobufjs", () => {
    expect(fromGenerator()).toBe(fromProtoLoader());
  });

  test("that protobufjs is inside this repository's node_modules", () => {
    expect(fromProtoLoader().startsWith(NODE_MODULES + path.sep)).toBe(true);
  });

  test("that protobufjs is the version package.json pins", () => {
    expect(readManifest(fromProtoLoader()).version).toBe(MANIFEST.devDependencies?.protobufjs as string);
  });

  test("@platformatic/kafka's optional protobufjs is its own 8.x, not the etcd pin", () => {
    const kafkaManifest = resolveFrom(ROOT_MANIFEST, "@platformatic/kafka/package.json");
    const kafkaProtobuf = resolveFrom(kafkaManifest, "protobufjs/package.json");
    expect(kafkaProtobuf.startsWith(NODE_MODULES + path.sep)).toBe(true);
    expect(kafkaProtobuf).not.toBe(fromProtoLoader());
    expect(readManifest(kafkaProtobuf).version.split(".")[0]).toBe("8");
  });
});
