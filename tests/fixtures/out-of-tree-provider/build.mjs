#!/usr/bin/env node
/**
 * The fixture's own build, the `build` script of its package.json, as every provider package has one: Studio's pack
 * step (scripts/providers-pack.ts) runs it as `bun run --shell=bun build -- --outdir <absolute directory>` and holds
 * no bundler configuration of the package.
 *
 * It bundles src/index.ts, with the SDK it is installed with, into the manifest's `runtime.entry` under `--outdir`
 * (read from libredb-provider.json beside this file, so it names no output of its own), and writes nothing else there.
 * With `--metafile <absolute file>` it also writes esbuild's metafile to that file, outside the artifact: the
 * out-of-tree acceptance's evidence build asks for it to see what the bundle read. Any other argument, or a relative
 * path, prints the usage on standard error and exits 2.
 *
 * esbuild comes from PATH: the fixture declares no dependency but the SDK it is installed with (the acceptance's
 * `readFixture` refuses every dependency field), so the acceptance puts one directory holding only esbuild's launcher
 * on the build's PATH. A spawn error, ENOENT when no esbuild is on PATH, is thrown, and the exit code is esbuild's.
 * It runs on Linux and macOS only, as its acceptance does: Windows finds no extension-less launcher on PATH.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = "Usage: node build.mjs --outdir <absolute directory> [--metafile <absolute file>]";
const here = path.dirname(fileURLToPath(import.meta.url));

let values;
try {
  ({ values } = parseArgs({ options: { outdir: { type: "string" }, metafile: { type: "string" } }, strict: true }));
} catch {
  values = undefined;
}
if (
  values === undefined ||
  values.outdir === undefined ||
  !path.isAbsolute(values.outdir) ||
  (values.metafile !== undefined && !path.isAbsolute(values.metafile))
) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  const manifest = JSON.parse(readFileSync(path.join(here, "libredb-provider.json"), "utf8"));
  const args = [
    "src/index.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    "--target=node24",
    `--outfile=${path.join(values.outdir, manifest.runtime.entry)}`,
    "--log-level=warning",
  ];
  if (values.metafile !== undefined) args.push(`--metafile=${values.metafile}`);
  const result = spawnSync("esbuild", args, { cwd: here, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
}
