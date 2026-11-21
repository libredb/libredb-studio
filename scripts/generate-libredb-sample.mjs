#!/usr/bin/env node
/**
 * Writes seed-assets/libredb/sample.libredb: the "Sample (LibreDB)" database, one example per lens (a relational
 * table, a document collection and two key-value entries), built with the @libredb/libredb engine this repository
 * installs.
 *
 * The engine writes no time, host or process into the data file (those reach only the `.lock` sidecar it removes on
 * close), so a rebuild with the same engine gives the same bytes. The output is committed and never edited by hand; a
 * change is a rerun. tests/unit/seed/libredb-sample-asset.test.ts rebuilds it and fails on any difference from the
 * committed bytes or from the digest SAMPLES pins (src/lib/seed/samples.ts). An engine bump that changes the bytes
 * fails that test, and the fix is to rerun this script and update the pin in SAMPLES.
 *
 * Run: node scripts/generate-libredb-sample.mjs [--out <file>]
 * With no argument it rewrites the committed file. With --out it writes the same bytes to <file>, resolved against the
 * working directory, and leaves the committed file alone. Either way it builds into `<file>.<pid>.building` first
 * and renames that over the output, so an interrupted run never leaves a half-built sample.
 */
import { existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doc, kv, open, table } from "@libredb/libredb";

export const LIBREDB_SAMPLE_FILE = path.resolve(import.meta.dirname, "../seed-assets/libredb/sample.libredb");

/**
 * Build the sample into `file`, replacing it. Builds into `<file>.<pid>.building` (removed first, with its `.lock`,
 * in case a crashed run of the same pid left one), then renames that over `file`.
 * @param {string} file
 */
export function buildLibreDbSample(file) {
  const building = `${file}.${process.pid}.building`;
  rmSync(building, { force: true });
  rmSync(`${building}.lock`, { force: true });
  const db = open({ path: building });
  try {
    const users = table(db, "users", {
      primaryKey: "id",
      columns: { id: "string", name: "string", age: "number", active: "boolean" },
    });
    users.insert({ id: "1", name: "Ada", age: 36, active: true });
    users.insert({ id: "2", name: "Grace", age: 45, active: false });
    users.insert({ id: "3", name: "Edsger", age: 40, active: true });

    const articles = doc(db, "articles");
    articles.put("a1", { title: "Welcome to LibreDB", body: "One core, three lenses.", tags: ["intro"] });
    articles.put("a2", { title: "Embedded by design", body: "No server, no wire protocol.", tags: ["design"] });

    const store = kv(db);
    store.set("config:theme", "dark");
    store.set("config:locale", "en");
  } finally {
    db.close();
  }
  renameSync(building, file);
}

const USAGE = "Usage: node scripts/generate-libredb-sample.mjs [--out <file>]";

/**
 * The file the command writes: the committed file when it is given no argument, or the file `--out <file>` names,
 * resolved against the working directory. Any other argument list answers `undefined`, which the command refuses with
 * its usage line, so a mistyped flag never rewrites the committed file in its place.
 * @param {readonly string[]} args
 * @returns {string | undefined}
 */
function outputFile(args) {
  if (args.length === 0) return LIBREDB_SAMPLE_FILE;
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
  buildLibreDbSample(target);
  console.log(`Wrote ${path.relative(process.cwd(), target).split(path.sep).join("/")}`);
}

if (isDirectExecution(process.argv[1])) main(process.argv.slice(2));
