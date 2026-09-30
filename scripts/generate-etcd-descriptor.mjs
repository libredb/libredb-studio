#!/usr/bin/env node
/**
 * Writes src/lib/db/providers/keyvalue/etcd/proto/descriptor.ts: the etcd v3.7.2 gRPC API as the JSON descriptor that
 * `@grpc/proto-loader`'s `fromJSON` reads, so the etcd client loads no `.proto` file at run time (spec 3.2).
 *
 * The input is the vendored proto directory beside that file (its README.md says what is vendored, what is stubbed
 * and why). The output is committed and never edited by hand; tests/unit/db/etcd/descriptor.test.ts imports the two
 * functions below, regenerates the module in memory and fails on any difference from the committed bytes.
 *
 * Run: node scripts/generate-etcd-descriptor.mjs
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Imported first on purpose: loading proto-loader registers google/protobuf/descriptor.proto, which versionpb's
// version.proto imports and protobufjs does not bundle, as a common file of the protobufjs copy proto-loader
// resolves. The generator loads the protos only while the protobufjs below is that same copy, which package.json's
// exact devDependency pin and tests/unit/db/etcd/dependency-resolution.test.ts keep true.
import "@grpc/proto-loader";
import protobuf from "protobufjs";

export const ETCD_PROTO_DIR = path.resolve(import.meta.dirname, "../src/lib/db/providers/keyvalue/etcd/proto");
export const ETCD_DESCRIPTOR_FILE = path.join(ETCD_PROTO_DIR, "descriptor.ts");

/** The vendored upstream files first, then the stubs that stand in for grpc-gateway's two annotation imports. */
const INCLUDE_DIRS = [ETCD_PROTO_DIR, path.join(ETCD_PROTO_DIR, "stubs")];

/**
 * rpc.proto and everything it imports, resolved, with the field names the `.proto` files spell.
 * @returns {import("protobufjs").INamespace}
 */
export function loadEtcdDescriptor() {
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    const vendored = INCLUDE_DIRS.map((dir) => path.join(dir, target)).find((candidate) => existsSync(candidate));
    // Anything else is either a common file protobufjs serves from memory (google/protobuf/*) or missing, which
    // loadSync then refuses with the path it looked for.
    return vendored ?? protobuf.util.path.resolve(origin, target);
  };
  root.loadSync("etcd/api/etcdserverpb/rpc.proto", { keepCase: true });
  root.resolveAll();
  return root.toJSON({ keepComments: false });
}

/**
 * The committed module's text for `descriptor`.
 *
 * The literal is asserted to `fromJSON`'s parameter type rather than annotated with it, because protobufjs 7.6.6's
 * typings disagree with its own `toJSON`: they require a `comment` on every method (absent without keepComments)
 * and declare neither `edition` nor `valuesOptions`, which it writes for descriptor.proto's proto2 types and for
 * enum value options. The descriptor test proves the runtime reading instead, by loading it through `fromJSON`.
 * @param {import("protobufjs").INamespace} descriptor
 * @returns {string}
 */
export function renderEtcdDescriptor(descriptor) {
  return `// GENERATED FILE - do not edit. Run: node scripts/generate-etcd-descriptor.mjs
//
// Source: the etcd v3.7.2 .proto files vendored in this directory (README.md), via
// scripts/generate-etcd-descriptor.mjs. tests/unit/db/etcd/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const ETCD_DESCRIPTOR = ${JSON.stringify(descriptor, null, 2)} as Parameters<typeof fromJSON>[0];
`;
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(ETCD_DESCRIPTOR_FILE, renderEtcdDescriptor(loadEtcdDescriptor()));
  console.log(`Wrote ${path.relative(process.cwd(), ETCD_DESCRIPTOR_FILE)}`);
}
