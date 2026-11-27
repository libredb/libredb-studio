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
 *   install is no part of its source); a symbolic link or junction in it is refused by name wherever it points, since
 *   the check would not compare its target;
 * - its drivers are the names of its package.json `dependencies`, `optionalDependencies` and `peerDependencies`, what
 *   it may load at run time, never its `devDependencies`, which are build tools. Each is found as Node.js finds a
 *   package directory from the package's directory: the nearest `node_modules/<name>/package.json` above it, its real
 *   path taken, so a workspace link reaches the package itself. A declared driver that is not installed is refused by
 *   name. A driver's files are every regular file of its directory outside its own nested `node_modules` (its
 *   dependencies are not the package's declaration); a link in it is judged by the rule below, its tree being that
 *   directory without its nested `node_modules`;
 * - an empty file is left out of the compared files: it equals every other empty file and identifies nothing;
 * - its name, as UTF-8 bytes, is searched in every payload file, across the boundaries of the chunks it is read in.
 *
 * The scanned files are every regular file under the standalone's `.next` and `node_modules`, the tree it walks. The
 * standalone must hold both directories, each refused by name when missing.
 *
 * A symbolic link or junction met in a walked tree (the standalone's, or a driver's directory) is never followed and
 * never skipped silently. Its target is read with readlink (which answers a Windows junction's target too), resolved
 * from the link's own directory, and judged by its real path, so a target reached through another link is judged by
 * where it really is. A target inside the tree is accepted, since the walk reads it where it lives; a target outside
 * the tree, or one that does not exist, is a problem naming the link and its target. Turbopack writes such a link for
 * every external package: `.next/node_modules/<package>-<hash>` to `../../node_modules/<package>` (one level deeper
 * for a scoped package), inside the standalone, so the package's files are read once, under `node_modules`.
 *
 * A driver some core module still imports, which Next.js then traces into the payload, is excepted by
 * `CORE_IMPORTED_DRIVERS`, a closed list naming the importer: a declared driver listed there is not compared. Every
 * run checks every entry: its importer must be a repository path under one of the isolation ratchet's core roots
 * (src, bin, scripts, vscode-extension/src), exist, and import a module of the driver, read by the TypeScript
 * compiler's public `preProcessFile` (static and dynamic imports, `require` and re-exports alike); a stale entry is
 * refused naming it, and so is an entry whose driver no checked package declares, since it would except nothing. The
 * list is empty while no core module imports a provider package's driver.
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
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
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

/**
 * A link a walk cannot accept: its path, its target resolved from the link's own directory, and why: the target lies
 * outside the walked trees, or does not exist.
 */
export interface RefusedLink {
  readonly link: string;
  readonly target: string;
  readonly exists: boolean;
}

/** What a walk reads: its trees, every directory named in `skipped` left out of each. */
interface WalkedTrees {
  readonly roots: readonly string[];
  readonly skipped: readonly string[];
}

/** The real path of `target`, or null when it does not exist. */
function realTarget(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** Whether real path `real` lies in one of the real `roots`, outside every directory named in `skipped`. */
function insideTrees(real: string, roots: readonly string[], skipped: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    return !relative.split(path.sep).some((segment) => skipped.includes(segment));
  });
}

/**
 * Every regular file under `directory`, recursively, sorted, outside any directory named in `trees.skipped`. A symbolic
 * link or junction (Windows junctions included: lstat names them links and readlink answers their target) is never
 * followed and never skipped silently: its target, read with readlink and resolved from the link's own directory, is
 * judged by its real path, so a target reached through another link is judged by where it really is. A target inside
 * one of `trees.roots` (outside its skipped directories) is accepted, since a walk of those trees reads it where it
 * lives; every other link, its target outside them or missing, is handed to `onLink`, sorted by path. With no root,
 * every link is handed over.
 */
function walk(directory: string, trees: WalkedTrees, onLink: (refused: RefusedLink) => void): string[] {
  const roots = trees.roots.map((root) => realpathSync.native(root));
  const files: string[] = [];
  const refused: RefusedLink[] = [];
  const pending = [directory];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const name of readdirSync(next)) {
      if (trees.skipped.includes(name)) continue;
      const child = path.join(next, name);
      // lstat rather than the directory listing's type: it names a Windows junction a link as well.
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) {
        const target = path.resolve(path.dirname(child), readlinkSync(child));
        const real = realTarget(target);
        if (real === null || !insideTrees(real, roots, trees.skipped)) {
          refused.push({ link: child, target, exists: real !== null });
        }
      } else if (stats.isDirectory()) pending.push(child);
      else if (stats.isFile()) files.push(child);
    }
  }
  for (const link of refused.sort((a, b) => (a.link < b.link ? -1 : 1))) onLink(link);
  return files.sort();
}

/** Why a refused link is refused: its target and, unless it does not exist, the trees it lies outside of. */
const linkReason = (refused: RefusedLink, outside: string): string =>
  refused.exists ? `to ${refused.target}, which lies outside ${outside}` : `to ${refused.target}, which does not exist`;

/**
 * Every regular file under `directory`, recursively, sorted. A link whose target lies inside `within` (by default
 * `directory` itself) is accepted and not followed, since the walk of those trees reads its target where it lives; a
 * link whose target lies outside them or does not exist is handed to `onLink`, which by default raises an error naming
 * the link and its target.
 */
export function regularFiles(
  directory: string,
  options: { within?: readonly string[]; onLink?: (refused: RefusedLink) => void } = {},
): string[] {
  const within = options.within ?? [directory];
  const onLink =
    options.onLink ??
    ((refused: RefusedLink) => {
      const reason = linkReason(refused, within.join(" and "));
      throw new Error(
        `${refused.link} is a symbolic link or junction ${reason}${refused.exists ? ", so the scan would not read it" : ""}`,
      );
    });
  return walk(directory, { roots: within, skipped: [] }, onLink);
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

/** The refusal of exception `entry`, giving `why`. */
const exceptionRefusal = (entry: CoreImportedDriver, why: string): string =>
  `${PREFIX}: the exception for ${entry.driver} imported by ${entry.importer}: ${why}`;

/** The problem with an exception, or null when its importer is a core module that imports a module of its driver. */
function exceptionProblem(entry: CoreImportedDriver, repositoryRoot: string): string | null {
  const refuse = (why: string) => exceptionRefusal(entry, why);
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

/**
 * Every regular file under `directory` outside any directory named `node_modules`. A link whose target lies inside
 * `within` (outside its `node_modules` directories) is accepted; `onLink` sees every other.
 */
const filesOutsideNodeModules = (
  directory: string,
  within: readonly string[],
  onLink: (refused: RefusedLink) => void,
): string[] => walk(directory, { roots: within, skipped: ["node_modules"] }, onLink);

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
  // A package's source holds no link at all: every link there is refused, wherever it points.
  const sources = filesOutsideNodeModules(directory, [], ({ link }) =>
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
    const onLink = (refused: RefusedLink) =>
      refusals.push(
        `${PREFIX}: ${refused.link} is a symbolic link or junction inside ${driver}'s directory, a driver ${name} declares, ${linkReason(refused, "that directory or in its nested node_modules")}${refused.exists ? ", so the check would not compare it" : ""}`,
      );
    driverFiles += filesOutsideNodeModules(installed, [installed], onLink).filter((file) =>
      record(file, `${driver} ${relativeOf(installed, file)}, a driver ${name} declares`),
    ).length;
  }
  if (refusals.length > 0) return refusals;
  return { name, sourceFiles: sources.length, driverFiles, drivers, excepted };
}

/** The trees of a standalone the check reads: its `.next` and its `node_modules`. */
export const standaloneTrees = (standalone: string): string[] =>
  [".next", "node_modules"].map((directory) => path.join(standalone, directory));

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
    if (stats === undefined) {
      refusals.push(`${PREFIX}: ${directory}: the package directory does not exist`);
      continue;
    }
    if (!stats.isDirectory()) {
      refusals.push(`${PREFIX}: ${directory} is not a directory`);
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
  // Read only once every package is: a refused package's declarations are not known.
  if (packages.length === directories.length) {
    for (const entry of options.exceptions) {
      if (!packages.some((pkg) => pkg.excepted.includes(entry))) {
        refusals.push(exceptionRefusal(entry, `no checked package declares ${entry.driver}`));
      }
    }
  }
  if (refusals.length > 0) return { problems: refusals, lines: [] };

  const links: string[] = [];
  const onLink = (refused: RefusedLink) =>
    links.push(
      `${PREFIX}: ${refused.link} is a symbolic link or junction in the standalone ${linkReason(refused, "its .next and node_modules")}${refused.exists ? ", so the check would not read it" : ""}`,
    );
  const within = standaloneTrees(standalone);
  const files = within.flatMap((tree) => regularFiles(tree, { within, onLink }));
  const needles = packages.map((pkg) => pkg.name);
  const problems = [...links, ...scanProblems(files, needles, digests, options.chunkSize)];
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
