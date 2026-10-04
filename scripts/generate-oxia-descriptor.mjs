#!/usr/bin/env node
/**
 * Writes src/lib/db/providers/keyvalue/oxia/proto/descriptor.ts: Oxia's client API at v0.16.10 and the gRPC health
 * service as the JSON descriptor that `@grpc/proto-loader`'s `fromJSON` reads, so the Oxia client loads no `.proto`
 * file at run time (SB1-1.2). It has the shape of scripts/generate-milvus-descriptor.mjs, written again here because
 * each provider keeps its own files.
 *
 * The input is the vendored proto directory beside that file (its README.md records each file's SHA-256). The output
 * is committed and never edited by hand; tests/unit/db/oxia/descriptor.test.ts regenerates it in memory and fails on
 * any difference from the committed bytes, and runs this command in child processes that write only into a
 * temporary directory.
 *
 * Run: node scripts/generate-oxia-descriptor.mjs [--out <file>]
 * With no argument it rewrites the committed module. With --out it writes the same bytes to <file>, resolved against
 * the working directory, and leaves the committed module alone.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Imported first on purpose, although neither vendored file imports google/protobuf/*: the generator then loads the
// one protobufjs copy proto-loader resolves, the copy the etcd and Milvus generators load. package.json's exact
// protobufjs pin keeps it there, which the etcd and Milvus dependency-resolution tests hold; there is no Oxia
// dependency-resolution test (consistency ruling 18).
import "@grpc/proto-loader";
import protobuf from "protobufjs";

export const OXIA_PROTO_DIR = path.resolve(import.meta.dirname, "../src/lib/db/providers/keyvalue/oxia/proto");
export const OXIA_DESCRIPTOR_FILE = path.join(OXIA_PROTO_DIR, "descriptor.ts");

/**
 * client.proto and grpc/health/v1/health.proto, resolved, with the field names the `.proto` files spell.
 * @returns {import("protobufjs").INamespace}
 */
export function loadOxiaDescriptor() {
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    const vendored = path.join(OXIA_PROTO_DIR, target);
    // Anything else is a common file protobufjs serves from memory (google/protobuf/*), or missing, which loadSync
    // then refuses with the path it looked for.
    return existsSync(vendored) ? vendored : protobuf.util.path.resolve(origin, target);
  };
  root.loadSync(["client.proto", "grpc/health/v1/health.proto"], { keepCase: true });
  root.resolveAll();
  return root.toJSON({ keepComments: false });
}

/**
 * The committed module's text for `descriptor`. The literal is asserted to `fromJSON`'s parameter type rather than
 * annotated with it, because protobufjs 7.6.6's typings omit fields its own toJSON writes; the descriptor test proves
 * the runtime reading by loading it through `fromJSON`.
 * @param {import("protobufjs").INamespace} descriptor
 * @returns {string}
 */
export function renderOxiaDescriptor(descriptor) {
  return `// GENERATED FILE - do not edit. Run: node scripts/generate-oxia-descriptor.mjs
//
// Source: Oxia's client.proto at v0.16.10 and grpc/health/v1/health.proto, vendored in this directory (README.md),
// via scripts/generate-oxia-descriptor.mjs. tests/unit/db/oxia/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const OXIA_DESCRIPTOR = ${JSON.stringify(descriptor, null, 2)} as Parameters<typeof fromJSON>[0];
`;
}

const USAGE = "Usage: node scripts/generate-oxia-descriptor.mjs [--out <file>]";

/**
 * The file the command writes: the committed module with no argument, or the file `--out <file>` names, resolved
 * against the working directory; any other argument list answers `undefined`, which the command refuses.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
export function descriptorOutputFile(args) {
  if (args.length === 0) return OXIA_DESCRIPTOR_FILE;
  const [flag, file] = args;
  if (args.length !== 2 || flag !== "--out" || !file || file.startsWith("-")) return undefined;
  return path.resolve(file);
}

/**
 * The line printed once `outputFile` is written: relative to `cwd`, with `/` between segments on every platform.
 * @param {string} outputFile
 * @param {string} cwd
 * @param {import("node:path").PlatformPath} [paths]
 * @returns {string}
 */
export function wroteLine(outputFile, cwd, paths = path) {
  return `Wrote ${paths.relative(cwd, outputFile).split(paths.sep).join("/")}`;
}

/**
 * Whether node runs this file as its program rather than a module that imports it; both sides are made real, so a
 * symlinked checkout still writes.
 * @param {string | undefined} argv1
 * @returns {boolean}
 */
function isDirectExecution(argv1) {
  return (
    argv1 !== undefined && existsSync(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  );
}

/** @param {readonly string[]} args */
function main(args) {
  const outputFile = descriptorOutputFile(args);
  if (outputFile === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  writeFileSync(outputFile, renderOxiaDescriptor(loadOxiaDescriptor()));
  console.log(wroteLine(outputFile, process.cwd()));
}

if (isDirectExecution(process.argv[1])) main(process.argv.slice(2));
