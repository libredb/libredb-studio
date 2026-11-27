#!/usr/bin/env bun
/**
 * The build output check (issue #2606): no provider package's code, nor a driver it declares, passes through Studio's
 * Next.js build. It reads a standalone build, never runs it, and fails when a file under its `.next` (the server's
 * build output) or its `node_modules` (the packages Next.js traced and the payload script copied) equals a file of a
 * provider package's source or of a driver the package declares, or holds the package's name.
 *
 * The packages are every provider package of the repository (`providerPackageDirectories` in
 * scripts/workspace-packages.mjs) and each package directory named on the command line, each once by real path; with
 * none at all the check is refused, since a check that compares nothing asserts nothing. For each package:
 * - its package.json must be a JSON object with a string `name`, refused naming the file;
 * - its source files are every regular file of its directory outside any directory named `node_modules` (its own
 *   install is no part of its source); a symbolic link or junction in it is refused by name, since the check would
 *   not compare its target;
 * - its drivers are the names of its package.json `dependencies`, `optionalDependencies` and `peerDependencies`, what
 *   it may load at run time, never its `devDependencies`, which are build tools. Each is found as Node.js finds a
 *   package directory from the package's directory: the nearest `node_modules/<name>/package.json` above it, its real
 *   path taken, so a workspace link reaches the package itself. A declared driver that is not installed is refused by
 *   name. A driver's files are every regular file of its directory outside its own nested `node_modules` (its
 *   dependencies are not the package's declaration), links not followed;
 * - an empty file is left out of the compared files: it equals every other empty file and identifies nothing;
 * - its name, as UTF-8 bytes, is searched in every payload file, across the boundaries of the chunks it is read in.
 *
 * The scanned files are every regular file under the standalone's `.next` and `node_modules`, links not followed; the
 * standalone must hold both directories, each refused by name when missing.
 *
 * A driver some core module still imports, which Next.js then traces into the payload, is excepted by
 * `CORE_IMPORTED_DRIVERS`, a closed list naming the importer: a declared driver listed there is not compared. Every
 * run checks every entry: its importer must be a repository path under one of the isolation ratchet's core roots
 * (src, bin, scripts, vscode-extension/src), exist, and import a module of the driver, read by the TypeScript
 * compiler's public `preProcessFile` (static and dynamic imports, `require` and re-exports alike); a stale entry is
 * refused naming it. The list is empty while no core module imports a provider package's driver.
 *
 * Output: every problem on standard error, one per line, exit 1; or, on a pass, one line per package on standard
 * output naming its counts and its drivers, plus one line per exception used, exit 0. Any command line but
 * `--standalone <absolute directory>` followed by absolute package directories prints the usage, exit 2.
 *
 * CI runs it in the "Engine Smoke - Build Payload" job of .github/workflows/ci.yml over the extracted payload, naming
 * the out-of-tree fixture (tests/fixtures/out-of-tree-provider), and the out-of-tree acceptance's step 8 runs it over
 * the fixture it packed (scripts/out-of-tree-acceptance.ts). Its logic is held by
 * tests/unit/scripts/check-build-output.test.ts.
 *
 * Run: bun scripts/check-build-output.ts --standalone <absolute directory> [<absolute package directory> ...]
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { packageNameOf } from "./check-lib-load.mjs";
import { providerPackageDirectories } from "./workspace-packages.mjs";

const USAGE =
  "Usage: bun scripts/check-build-output.ts --standalone <absolute directory> [<absolute package directory> ...]";
const PREFIX = "check-build-output";

/** The size of each read of the scan. */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** The roots a core module lives under, relative to the repository: the isolation ratchet's core roots. */
const CORE_ROOTS: readonly string[] = Object.freeze(["src", "bin", "scripts", "vscode-extension/src"]);

/** The package.json members whose names are a package's drivers. */
const DRIVER_FIELDS: readonly string[] = Object.freeze(["dependencies", "optionalDependencies", "peerDependencies"]);

/** A driver of a provider package that a core module still imports, and that module, relative to the repository. */
export interface CoreImportedDriver {
  readonly driver: string;
  readonly importer: string;
}

/** The closed exception list: empty while no core module imports a provider package's driver. */
export const CORE_IMPORTED_DRIVERS: readonly CoreImportedDriver[] = Object.freeze([]);

/** What the check reads. */
export interface CheckOptions {
  /** The repository's real path: its provider packages are compared, and its core modules hold the exceptions. */
  readonly repositoryRoot: string;
  /** The standalone build, holding `.next` and `node_modules`. */
  readonly standalone: string;
  /** Absolute package directories compared besides the repository's provider packages. */
  readonly packageDirectories: readonly string[];
  /** The exception list; `CORE_IMPORTED_DRIVERS` when the command runs. */
  readonly exceptions: readonly CoreImportedDriver[];
  /** The size of each read of the scan. */
  readonly chunkSize?: number;
}

/** What the check found: its problems, and on a pass the lines naming what it compared. */
export interface CheckResult {
  readonly problems: string[];
  readonly lines: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A path relative to `directory`, `/`-separated. */
const relativeOf = (directory: string, file: string): string =>
  path.relative(directory, file).split(path.sep).join("/");

/** Every regular file under `directory`, recursively, sorted; symbolic links are not followed. */
export function regularFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [directory];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const child = path.join(next, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

/** A file's SHA-256 and the needles it holds, read in chunks of `chunkSize` bytes with an overlap. */
function scanFile(file: string, needles: readonly Buffer[], chunkSize: number): { digest: string; found: Buffer[] } {
  const overlap = Math.max(0, ...needles.map((needle) => needle.length - 1));
  const hash = createHash("sha256");
  const found = new Set<Buffer>();
  const descriptor = openSync(file, "r");
  try {
    const chunk = Buffer.alloc(chunkSize);
    let tail = Buffer.alloc(0);
    for (let read = readSync(descriptor, chunk); read > 0; read = readSync(descriptor, chunk)) {
      const bytes = chunk.subarray(0, read);
      hash.update(bytes);
      const window = Buffer.concat([tail, bytes]);
      for (const needle of needles) if (window.includes(needle)) found.add(needle);
      tail = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    }
  } finally {
    closeSync(descriptor);
  }
  return { digest: hash.digest("hex"), found: [...found] };
}

/**
 * The problems of a scan: each file of `files` that equals a compared file (its SHA-256 is a key of `digests`, whose
 * value labels it) or holds a needle; a scan of no file fails, since it would assert nothing.
 */
export function scanProblems(
  files: readonly string[],
  needles: readonly string[],
  digests: ReadonlyMap<string, string>,
  chunkSize: number = SCAN_CHUNK_BYTES,
): string[] {
  if (files.length === 0) return ["the build scan found no file to read"];
  const needleBytes = needles.map((needle) => Buffer.from(needle, "utf8"));
  return files.flatMap((file) => {
    const { digest, found } = scanFile(file, needleBytes, chunkSize);
    const label = digests.get(digest);
    return [
      ...(label === undefined ? [] : [`${file} equals ${label}`]),
      ...found.map((needle) => `${file} holds ${needle.toString("utf8")}`),
    ];
  });
}

/** Whether `inner` is `outer` or lies under it, both relative `/`-separated paths. */
const under = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

/** The problem with an exception, or null when its importer is a core module that imports a module of its driver. */
function exceptionProblem(entry: CoreImportedDriver, repositoryRoot: string): string | null {
  const refuse = (why: string) => `${PREFIX}: the exception for ${entry.driver} imported by ${entry.importer}: ${why}`;
  const normal = path.posix.normalize(entry.importer);
  if (normal !== entry.importer || !CORE_ROOTS.some((root) => under(normal, root))) {
    return refuse(
      `the importer is not under ${CORE_ROOTS.slice(0, -1)
        .map((root) => `${root}/`)
        .join(", ")} or ${CORE_ROOTS.at(-1)}/`,
    );
  }
  const file = path.join(repositoryRoot, ...normal.split("/"));
  if (lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) return refuse("the importer does not exist");
  const specifiers = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((ref) => ref.fileName);
  const imports = specifiers.some(
    (specifier) => !specifier.startsWith(".") && packageNameOf(specifier) === entry.driver,
  );
  return imports ? null : refuse(`the importer imports no module of ${entry.driver}`);
}

/** The directory of package `name` as Node.js finds it from `from`, its real path; null when none holds it. */
function installedPackage(name: string, from: string): string | null {
  let current = path.resolve(from);
  for (;;) {
    const candidate = path.join(current, "node_modules", ...name.split("/"));
    if (lstatSync(path.join(candidate, "package.json"), { throwIfNoEntry: false }) !== undefined) {
      return realpathSync.native(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Every regular file under `directory` outside any directory named `node_modules`; `onLink` sees each link found. */
function filesOutsideNodeModules(directory: string, onLink: (link: string) => void): string[] {
  const files: string[] = [];
  const pending = [directory];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const name of readdirSync(next)) {
      if (name === "node_modules") continue;
      const child = path.join(next, name);
      // lstat rather than the directory listing's type: it names a Windows junction a link as well.
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) onLink(child);
      else if (stats.isDirectory()) pending.push(child);
      else if (stats.isFile()) files.push(child);
    }
  }
  return files.sort();
}

/** One package as the check compares it. */
interface ComparedPackage {
  readonly name: string;
  readonly sourceFiles: number;
  readonly driverFiles: number;
  readonly drivers: readonly string[];
  readonly excepted: readonly CoreImportedDriver[];
}

/** Reads the package at `directory` into `digests`; its summary, or its refusals. */
function comparedPackage(
  directory: string,
  exceptions: readonly CoreImportedDriver[],
  digests: Map<string, string>,
): ComparedPackage | string[] {
  const packageFile = path.join(directory, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packageFile, "utf8"));
  } catch {
    manifest = undefined;
  }
  if (!isRecord(manifest) || typeof manifest.name !== "string" || manifest.name === "") {
    return [`${PREFIX}: ${packageFile} is not a JSON object with a package name`];
  }
  const name = manifest.name;
  const refusals: string[] = [];
  const record = (file: string, label: string): boolean => {
    const bytes = readFileSync(file);
    if (bytes.length === 0) return false;
    const digest = sha256(bytes);
    if (!digests.has(digest)) digests.set(digest, label);
    return true;
  };
  const sources = filesOutsideNodeModules(directory, (link) =>
    refusals.push(
      `${PREFIX}: ${link} is a symbolic link or junction inside ${name}'s directory, so the check would not compare its target`,
    ),
  ).filter((file) => record(file, `${name}'s ${relativeOf(directory, file)}`));

  const declared = [
    ...new Set(DRIVER_FIELDS.flatMap((field) => Object.keys(isRecord(manifest[field]) ? manifest[field] : {}))),
  ].sort();
  const excepted = exceptions.filter((entry) => declared.includes(entry.driver));
  const drivers = declared.filter((driver) => !excepted.some((entry) => entry.driver === driver));
  let driverFiles = 0;
  for (const driver of drivers) {
    const installed = installedPackage(driver, directory);
    if (installed === null) {
      refusals.push(
        `${PREFIX}: ${driver}, a driver ${name} declares, is not installed in any node_modules above ${directory}`,
      );
      continue;
    }
    driverFiles += filesOutsideNodeModules(installed, () => {}).filter((file) =>
      record(file, `${driver} ${relativeOf(installed, file)}, a driver ${name} declares`),
    ).length;
  }
  if (refusals.length > 0) return refusals;
  return { name, sourceFiles: sources.length, driverFiles, drivers, excepted };
}

/** The refusal of a standalone missing `directory`, or null. */
function missingDirectory(standalone: string, directory: string): string | null {
  return lstatSync(path.join(standalone, directory), { throwIfNoEntry: false })?.isDirectory() === true
    ? null
    : `${PREFIX}: ${standalone} holds no ${directory} directory`;
}

/** Checks the standalone `options` names against its packages; see the module's docblock. */
export function checkBuildOutput(options: CheckOptions): CheckResult {
  const { repositoryRoot, standalone } = options;
  const refusals: string[] = [];
  for (const directory of [".next", "node_modules"]) {
    const missing = missingDirectory(standalone, directory);
    if (missing !== null) refusals.push(missing);
  }
  for (const entry of options.exceptions) {
    const problem = exceptionProblem(entry, repositoryRoot);
    if (problem !== null) refusals.push(problem);
  }

  const directories: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...providerPackageDirectories(repositoryRoot).map((directory: string) =>
      path.join(repositoryRoot, ...directory.split("/")),
    ),
    ...options.packageDirectories,
  ];
  for (const directory of candidates) {
    const stats = lstatSync(directory, { throwIfNoEntry: false });
    if (stats?.isDirectory() !== true) {
      refusals.push(`${PREFIX}: ${directory}: the package directory does not exist`);
      continue;
    }
    const real = realpathSync.native(directory);
    if (seen.has(real)) continue;
    seen.add(real);
    directories.push(directory);
  }
  if (candidates.length === 0) {
    refusals.push(`${PREFIX}: no provider package to compare: the repository holds none and none was named`);
  }

  const digests = new Map<string, string>();
  const packages: ComparedPackage[] = [];
  for (const directory of directories) {
    const compared = comparedPackage(directory, options.exceptions, digests);
    if (Array.isArray(compared)) refusals.push(...compared);
    else packages.push(compared);
  }
  if (refusals.length > 0) return { problems: refusals, lines: [] };

  const files = [
    ...regularFiles(path.join(standalone, ".next")),
    ...regularFiles(path.join(standalone, "node_modules")),
  ];
  const needles = packages.map((pkg) => pkg.name);
  const problems = scanProblems(files, needles, digests, options.chunkSize);
  if (problems.length > 0) return { problems, lines: [] };
  return {
    problems: [],
    lines: packages.flatMap((pkg) =>
      [
        `${pkg.name}: none of ${files.length} files under ${path.join(standalone, ".next")} and node_modules equals one of its ${pkg.sourceFiles} source files or ${pkg.driverFiles} files of its drivers (${pkg.drivers.length === 0 ? "none" : pkg.drivers.join(", ")}), or holds its name`,
      ].concat(
        pkg.excepted.map((entry) => `${pkg.name}: ${entry.driver} not compared, since ${entry.importer} imports it`),
      ),
    ),
  };
}

/** The standalone and package directories the arguments name, or null when the command line is not the usage. */
function commandLine(argv: readonly string[]): { standalone: string; packageDirectories: string[] } | null {
  const [flag, standalone, ...packageDirectories] = argv;
  if (flag !== "--standalone" || standalone === undefined) return null;
  if (![standalone, ...packageDirectories].every((value) => path.isAbsolute(value))) return null;
  return { standalone, packageDirectories };
}

export function main(argv: readonly string[]): number {
  const line = commandLine(argv);
  if (line === null) {
    console.error(USAGE);
    return 2;
  }
  const { problems, lines } = checkBuildOutput({
    repositoryRoot: realpathSync.native(path.resolve(import.meta.dir, "..")),
    standalone: line.standalone,
    packageDirectories: line.packageDirectories,
    exceptions: CORE_IMPORTED_DRIVERS,
  });
  for (const problem of problems) console.error(problem);
  for (const passed of lines) console.log(passed);
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
