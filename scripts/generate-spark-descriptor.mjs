#!/usr/bin/env node
/**
 * Writes src/lib/db/providers/sql/spark/proto/descriptor.ts: Spark Connect's gRPC API at apache/spark v4.2.0 as the
 * JSON descriptor that `@grpc/proto-loader`'s `fromJSON` reads, so the Apache Spark client loads no `.proto` file at
 * run time. It has the shape of scripts/generate-milvus-descriptor.mjs, written again here because each
 * provider keeps its own files.
 *
 * The input is the vendored proto directory beside that file (its README.md records each file's SHA-256). The output
 * is committed and never edited by hand; tests/unit/db/spark/descriptor.test.ts regenerates it in memory and fails on
 * any difference from the committed bytes, and runs this command in child processes that write only into a temporary
 * directory. The capture harness tests/live/spark-evidence.ts builds its own definition from loadSparkDescriptor(), so
 * a capture never depends on the committed module.
 *
 * Run: node scripts/generate-spark-descriptor.mjs [--out <file>]
 * With no argument it rewrites the committed module. With --out it writes the same bytes to <file>, resolved against
 * the working directory, and leaves the committed module alone.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Imported first on purpose, so that the generator reads the same protobufjs copy proto-loader resolves. Spark's
// protos import only google/protobuf/any.proto and timestamp.proto from outside, which protobufjs serves from memory.
import "@grpc/proto-loader";
import protobuf from "protobufjs";

export const SPARK_PROTO_DIR = path.resolve(import.meta.dirname, "../src/lib/db/providers/sql/spark/proto");
export const SPARK_DESCRIPTOR_FILE = path.join(SPARK_PROTO_DIR, "descriptor.ts");

/**
 * spark/connect/base.proto and everything it imports, resolved, with the field names the `.proto` files spell.
 * @returns {import("protobufjs").INamespace}
 */
export function loadSparkDescriptor() {
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => {
    const vendored = path.join(SPARK_PROTO_DIR, target);
    // Anything else is a common file protobufjs serves from memory (google/protobuf/*), or missing, which loadSync
    // then refuses with the path it looked for.
    return existsSync(vendored) ? vendored : protobuf.util.path.resolve(origin, target);
  };
  root.loadSync("spark/connect/base.proto", { keepCase: true });
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
export function renderSparkDescriptor(descriptor) {
  return `// GENERATED FILE - do not edit. Run: node scripts/generate-spark-descriptor.mjs
//
// Source: the apache/spark v4.2.0 Spark Connect .proto files vendored in this directory (README.md), via
// scripts/generate-spark-descriptor.mjs. tests/unit/db/spark/descriptor.test.ts fails on drift.

import type { fromJSON } from "@grpc/proto-loader";

// Asserted, not annotated: protobufjs 7.6.6's typings omit fields its own toJSON writes (see the generator).
// biome-ignore format: generated; the literal is JSON.stringify output, so a proto upgrade diffs line by line.
export const SPARK_DESCRIPTOR = ${JSON.stringify(descriptor, null, 2)} as Parameters<typeof fromJSON>[0];
`;
}

const USAGE = "Usage: node scripts/generate-spark-descriptor.mjs [--out <file>]";

/**
 * The file the command writes: the committed module with no argument, or the file `--out <file>` names, resolved
 * against the working directory; any other argument list answers `undefined`, which the command refuses.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
export function descriptorOutputFile(args) {
  if (args.length === 0) return SPARK_DESCRIPTOR_FILE;
  const [flag, file] = args;
  if (args.length !== 2 || flag !== "--out" || !file || file.startsWith("-")) return undefined;
  return path.resolve(file);
}

/**
 * The line the command prints once it has written `outputFile`, relative to `cwd` with `/` on every platform.
 * @param {string} outputFile an absolute path
 * @param {string} cwd
 * @param {import("node:path").PlatformPath} [paths] the running platform's path functions unless given
 * @returns {string}
 */
export function wroteLine(outputFile, cwd, paths = path) {
  return `Wrote ${paths.relative(cwd, outputFile).split(paths.sep).join("/")}`;
}

/**
 * Whether node runs this file as its program rather than a module that imports it; both sides are made real, as in
 * scripts/generate-etcd-descriptor.mjs, so a symlinked checkout still writes.
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
  writeFileSync(outputFile, renderSparkDescriptor(loadSparkDescriptor()));
  console.log(wroteLine(outputFile, process.cwd()));
}

if (isDirectExecution(process.argv[1])) main(process.argv.slice(2));
