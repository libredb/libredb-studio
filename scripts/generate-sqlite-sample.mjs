#!/usr/bin/env node
/**
 * Writes seed-assets/sqlite/employee.db in WAL journal mode: the vendored Employees template (seed-assets/sqlite/
 * ATTRIBUTION.md) with bytes 18 and 19 of its file header set from 1 to 2.
 *
 * The SQLite file format defines those two bytes, the file format write and read versions: 1 for rollback journalling,
 * 2 for WAL. Setting them changes no page, so the result is the same on every platform and every SQLite version.
 * `PRAGMA journal_mode = WAL` is not: it also stamps the change counter and the version number of the library that
 * wrote it, so its output would differ between the runtimes this repository tests on.
 *
 * The output is committed and never edited by hand; a change is a rerun. tests/unit/seed/sqlite-sample-asset.test.ts
 * holds the committed file to the digest SAMPLES pins (src/lib/seed/samples.ts), holds this script to be a fixed
 * point on it, proves that only the two header bytes differ from the rollback template, and runs this command in a
 * node child process that writes only into a temporary directory.
 *
 * Run: node scripts/generate-sqlite-sample.mjs [--out <file>]
 * With no argument it rewrites the committed file in place (through a temporary file and a rename). With --out it
 * writes the same bytes to <file>, resolved against the working directory, and leaves the committed file alone.
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SQLITE_SAMPLE_FILE = path.resolve(import.meta.dirname, "../seed-assets/sqlite/employee.db");

/** The 16 bytes every SQLite 3 database file starts with. */
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/**
 * A copy of `bytes` with header bytes 18 and 19 set to 2 (WAL). Refuses, by name, a file that does not start with the
 * SQLite 3 magic string and a header whose two version bytes are not both 1 or both 2, which this script does not
 * know how to read. Idempotent on a file already in WAL mode.
 * @param {Uint8Array} bytes the database file
 * @returns {Buffer}
 */
export function walHeader(bytes) {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (input.length < 100 || !input.subarray(0, 16).equals(SQLITE_MAGIC)) {
    throw new Error("The input is not a SQLite 3 database: it does not start with the SQLite 3 magic string.");
  }
  const write = input[18];
  const read = input[19];
  if (!((write === 1 && read === 1) || (write === 2 && read === 2))) {
    throw new Error(
      `The input's header bytes 18 and 19 are ${write} and ${read}; this script knows only 1 and 1 (rollback) and 2 and 2 (WAL).`,
    );
  }
  const output = Buffer.from(input);
  output[18] = 2;
  output[19] = 2;
  return output;
}

const USAGE = "Usage: node scripts/generate-sqlite-sample.mjs [--out <file>]";

/**
 * The file the command writes: the committed file when it is given no argument, or the file `--out <file>` names,
 * resolved against the working directory. Any other argument list answers `undefined`, which the command refuses with
 * its usage line, so a mistyped flag never rewrites the committed file in its place.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
function outputFile(args) {
  if (args.length === 0) return SQLITE_SAMPLE_FILE;
  const [flag, file] = args;
  if (args.length !== 2 || flag !== "--out" || !file || file.startsWith("-")) return undefined;
  return path.resolve(file);
}

/** Whether node runs this file as its program, rather than a module that imports it (the unit test does). */
function isDirectExecution(argv1) {
  return (
    argv1 !== undefined && existsSync(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  );
}

/** @param {readonly string[]} args */
function main(args) {
  const target = outputFile(args);
  if (target === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const output = walHeader(readFileSync(SQLITE_SAMPLE_FILE));
  // Written beside the target and renamed over it, so an interrupted run never leaves a half-written template.
  const temporary = `${target}.${process.pid}.generating`;
  writeFileSync(temporary, output, { flag: "wx" });
  renameSync(temporary, target);
  console.log(`Wrote ${path.relative(process.cwd(), target).split(path.sep).join("/")}`);
}

if (isDirectExecution(process.argv[1])) main(process.argv.slice(2));
