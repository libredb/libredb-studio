#!/usr/bin/env bun
/**
 * Whether the packed npm package's lock command writes, with no checkout of Studio and no download, a lock Studio's
 * reader admits: `bun run lib:lock`, after `bun run build:lib` (docs/TOOLCHAIN.md, "The lock command module
 * (`lib:lock`)").
 *
 * The build test (tests/unit/scripts/build-lock-module.test.ts) runs the module from a temporary file; this check runs
 * it the way an operator does, `npx @libredb/studio providers lock --dir <absolute directory>`, from the package as it
 * is published:
 *
 * 1. It refuses when `dist/providers-lock.mjs` is missing, and when the temporary root has an ancestor directory
 *    holding `node_modules`, since the launcher would then resolve what the package does not ship.
 * 2. It packs the repository with `bun pm pack` and extracts it to `<os.tmpdir()>/lib-lock-<random>/node_modules/<name>/`
 *    (scripts/check-lib-load.mjs's `packPackage`), and fails when the packed package lacks the launcher, its helper
 *    module, its package.json or the lock module, or when the lock module does not begin with acorn's license notice.
 * 3. It writes a probe providers directory under the temporary root: an unscoped and a scoped package, each importing a
 *    `node:` built-in and a relative module, with engine ids that name no engine.
 * 4. It runs `node <package>/bin/studio.js providers lock --dir <probe>` with a 512 MB heap and a 120 s timeout, without
 *    `NODE_PATH` and `NODE_OPTIONS` and with `HOME` and `USERPROFILE` set to an empty directory, and expects exit 0 and
 *    `Wrote <probe>/providers.lock.json` as the first line printed.
 * 5. Studio's reader (`readProvidersLock`) reads the lock and verifies both packages.
 * 6. The home directory is still empty: no download and no cache.
 * 7. It removes the lock, runs `bun scripts/providers-lock.ts --dir <probe>` from the repository, and expects the same
 *    bytes.
 * 8. The packed command refuses a `--dir` naming a regular file with exit 1 and its sentence, and answers `providers`
 *    alone with the usage and exit 2.
 * 9. It writes a second probe providers directory holding one package whose entry calls `import()` with something
 *    other than a string, a runtime load C-114 refuses, and expects the packed command to exit 1, print nothing on
 *    stdout, print the load's sentence and `providers:lock wrote nothing` on stderr, and write no lock.
 *
 * It prints one failure per line and a summary line, exits 1 on any failure, and always removes its temporary root.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE_NAME } from "../src/lib/provider-host/provider-artifact";
import { readProvidersLock } from "../src/lib/provider-host/providers-lock";
import { LOCK_FILE_NAME } from "../src/lib/provider-host/providers-lock-format";
import { ancestorNodeModules, childEnvironment, packPackage } from "./check-lib-load.mjs";
import { USAGE } from "./providers-lock";

const PREFIX = "lib:lock";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The lock module, relative to a package root. */
const LOCK_MODULE = path.join("dist", "providers-lock.mjs");

/** The files the packed package must hold for its launcher to run the lock command. */
const PACKED_FILES = ["bin/studio.js", "bin/lib/launcher-utils.mjs", "bin/package.json", "dist/providers-lock.mjs"];

/** The probe packages: name, version and engine id, each naming no engine. */
const PROBE_PACKAGES = [
  { name: "acme-probe", version: "1.0.0", engine: "acmeprobe" },
  { name: "@acme/scoped", version: "2.0.0", engine: "acmescoped" },
] as const;

/** The package of the refusal probe, naming no engine: its entry makes one runtime load (C-114). */
const LOAD_PROBE = { name: "acme-loads", version: "1.0.0", engine: "acmeloads" } as const;

/** What the packed command prints on stderr for the refusal probe. */
const LOAD_REFUSAL = [
  `providers:lock: ${LOAD_PROBE.name} ${LOAD_PROBE.version}: dist/index.mjs line 1 calls import() with something other than a string`,
  "providers:lock wrote nothing",
];

/** Writes `pkg` under the providers directory `directory`, with a manifest whose entry is `dist/index.mjs`, and `files`. */
function writeProbePackage(
  directory: string,
  pkg: { readonly name: string; readonly version: string; readonly engine: string },
  files: Readonly<Record<string, string>>,
): void {
  const all: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" })}\n`,
    [MANIFEST_FILE_NAME]: `${JSON.stringify({ engines: [{ id: pkg.engine }], runtime: { entry: "dist/index.mjs" } })}\n`,
    ...files,
  };
  for (const [relative, text] of Object.entries(all)) {
    const file = path.join(directory, ...pkg.name.split("/"), pkg.version, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** The probe providers directory: each package with a manifest, an entry importing `node:fs` and a relative module. */
function writeProbeProviders(directory: string): void {
  for (const pkg of PROBE_PACKAGES) {
    writeProbePackage(directory, pkg, {
      "dist/index.mjs": 'import "node:fs";\nimport { helper } from "./helper.mjs";\nexport default { helper };\n',
      "dist/helper.mjs": "export const helper = 1;\n",
    });
  }
}

/** How a spawned command ended: its exit code and its output lines, split on CRLF or LF. */
interface Run {
  readonly status: number | null;
  readonly out: string[];
  readonly err: string[];
}

function spawn(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Run {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw new Error(`${command} ${args.join(" ")} could not run: ${result.error.message}`);
  const lines = (text: string) => text.split(/\r?\n/).filter((line) => line !== "");
  return { status: result.status, out: lines(result.stdout), err: lines(result.stderr) };
}

/** What the check found: one sentence per failure, and the packages the reader verified. */
export interface LibLockResult {
  readonly failures: string[];
  readonly packages: string[];
}

/**
 * Runs steps 2 to 9 over the package root `root`, packed into `temp`, with `repository` the checkout whose
 * `scripts/providers-lock.ts` writes the bytes to compare with. Stops at the first step whose failure leaves nothing
 * for the next to read.
 */
export function checkLibLock({
  root,
  temp,
  repository = REPOSITORY_ROOT,
  tar = "tar",
}: {
  root: string;
  temp: string;
  repository?: string;
  tar?: string;
}): LibLockResult {
  const failures: string[] = [];
  const packages: string[] = [];
  const ancestor = ancestorNodeModules(temp, fs.existsSync);
  if (ancestor !== null) {
    failures.push(
      `${ancestor} holds node_modules above the temporary root ${temp}, so the launcher could resolve what the package does not ship. Point TMPDIR (TEMP on Windows) at a directory with no node_modules above it.`,
    );
    return { failures, packages };
  }

  const { packageDir } = packPackage(root, temp, tar);
  const missing = PACKED_FILES.filter((file) => !fs.existsSync(path.join(packageDir, ...file.split("/"))));
  if (missing.length > 0) {
    failures.push(...missing.map((file) => `${file} is not in the packed package, so its lock command cannot run.`));
    return { failures, packages };
  }
  if (!fs.readFileSync(path.join(packageDir, LOCK_MODULE), "utf8").startsWith("/*\nThis module bundles acorn ")) {
    failures.push(
      "dist/providers-lock.mjs of the packed package does not begin with acorn's license notice, which the build writes.",
    );
  }

  // Its real path as the command prints it: realpathSync.native, which also expands a Windows 8.3 short name in TEMP.
  const probe = path.join(fs.realpathSync.native(temp), "providers");
  writeProbeProviders(probe);
  const home = path.join(temp, "home");
  fs.mkdirSync(home);
  const env = childEnvironment(process.env, home) as NodeJS.ProcessEnv;
  const launcher = path.join(packageDir, "bin", "studio.js");
  const packed = (...args: string[]) =>
    spawn("node", ["--max-old-space-size=512", launcher, "providers", ...args], { cwd: temp, env });
  const lockFile = path.join(probe, LOCK_FILE_NAME);
  const command = `node ${launcher} providers lock --dir ${probe}`;

  const locked = packed("lock", "--dir", probe);
  if (locked.status !== 0 || locked.out[0] !== `Wrote ${lockFile}` || !fs.existsSync(lockFile)) {
    failures.push(
      `${command} exited ${locked.status} and printed ${locked.out[0] ?? "nothing"} first, not Wrote ${lockFile}, and ${fs.existsSync(lockFile) ? "wrote" : "wrote no"} lock: ${locked.err.join(" ")}`,
    );
    return { failures, packages };
  }

  const read = readProvidersLock(probe);
  if (!read.read) {
    failures.push(`Studio's reader refused the lock the packed command wrote: ${read.refusal.sentence}`);
    return { failures, packages };
  }
  for (const pkg of read.packages) {
    if (pkg.verified) packages.push(`${pkg.name} ${pkg.version}`);
    else
      failures.push(
        `Studio's reader refused ${pkg.name} ${pkg.version} of the packed command's lock: ${pkg.refusal.sentence}`,
      );
  }
  if (read.packages.length !== PROBE_PACKAGES.length) {
    failures.push(`the packed command's lock holds ${read.packages.length} packages, not ${PROBE_PACKAGES.length}.`);
  }

  const leftInHome = fs.readdirSync(home);
  if (leftInHome.length > 0) {
    failures.push(`${command} wrote ${leftInHome.join(", ")} into the home directory, so it downloaded or cached.`);
  }

  const packedBytes = fs.readFileSync(lockFile);
  fs.rmSync(lockFile);
  const repositoryRun = spawn(process.execPath, ["scripts/providers-lock.ts", "--dir", probe], { cwd: repository });
  if (repositoryRun.status !== 0 || !fs.existsSync(lockFile)) {
    failures.push(
      `bun scripts/providers-lock.ts --dir ${probe} exited ${repositoryRun.status}: ${repositoryRun.err.join(" ")}`,
    );
  } else if (!fs.readFileSync(lockFile).equals(packedBytes)) {
    failures.push("the packed command and bun scripts/providers-lock.ts wrote different bytes for the same directory.");
  }

  const regularFile = path.join(probe, "acme-probe", "1.0.0", "package.json");
  const notADirectory = packed("lock", "--dir", regularFile);
  if (
    notADirectory.status !== 1 ||
    !notADirectory.err.includes(`providers:lock: ${regularFile}: the providers directory is not a directory`)
  ) {
    failures.push(
      `the packed command over a regular file exited ${notADirectory.status} and printed ${notADirectory.err.join(" ")}, not its refusal and exit 1.`,
    );
  }
  const usage = packed();
  if (usage.status !== 2 || usage.err.join("\n") !== USAGE) {
    failures.push(
      `the packed command's providers alone exited ${usage.status} and printed ${usage.err.join(" ")}, not the usage and exit 2.`,
    );
  }

  const loadProbe = path.join(fs.realpathSync.native(temp), "loads");
  writeProbePackage(loadProbe, LOAD_PROBE, { "dist/index.mjs": "export default import(globalThis.probe);\n" });
  const loads = packed("lock", "--dir", loadProbe);
  const loadLock = fs.existsSync(path.join(loadProbe, LOCK_FILE_NAME));
  if (loads.status !== 1 || loads.out.length > 0 || loads.err.join("\n") !== LOAD_REFUSAL.join("\n") || loadLock) {
    failures.push(
      `the packed command over a package making a runtime load exited ${loads.status}, printed ${loads.out.join(" ") || "nothing"} on stdout and ${loads.err.join(" ") || "nothing"} on stderr, and ${loadLock ? "wrote" : "wrote no"} lock, not its refusal, exit 1 and no lock.`,
    );
  }
  return { failures, packages };
}

function main(): number {
  const started = performance.now();
  const root = process.cwd();
  const lockModule = path.join(root, LOCK_MODULE);
  if (!fs.existsSync(lockModule)) {
    console.error(
      `${PREFIX}: ${lockModule} is missing, so there is no lock command to pack. Run bun run build:lib first.`,
    );
    return 1;
  }
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lib-lock-"));
  let result: LibLockResult;
  try {
    result = checkLibLock({ root, temp });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const failure of result.failures) console.error(`${PREFIX}: ${failure}`);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (result.failures.length === 0) {
    console.log(
      `${PREFIX}: the packed providers lock wrote and Studio read ${result.packages.join(", ")} under Node ${spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim()}`,
    );
  }
  console.log(`${PREFIX}: ${result.failures.length} failures in ${seconds} s`);
  return result.failures.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
