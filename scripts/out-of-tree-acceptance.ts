#!/usr/bin/env bun
/**
 * The out-of-tree provider acceptance (issue #2520, owner decision G): a provider written outside the repository,
 * built against the packed SDK alone, is admitted by a built Studio with no change to Studio's files; its engine
 * answers a statement through Studio's API with the provider's rows; and one changed byte of the installed package is
 * refused at the next boot while Studio keeps running.
 *
 * The provider is the fixture under tests/fixtures/out-of-tree-provider/, a template that is copied and never imported
 * or built in place. This script holds no knowledge of it: the engine id, the package identity, the connection, the
 * statements and the rows each statement must answer are read from the fixture's package.json, its manifest and its
 * acceptance.json, so step 7 can assert that no engine id of the fixture is named under Studio's source, this script
 * included.
 *
 * The eight steps, each asserting its own output, so a missing provider can never pass as "no rows":
 * 1. Build Studio's standalone output (`DOCKER_BUILD=true bun run build`, credentials for build-time page data drawn
 *    at run time), or take an existing one with `--standalone <dir>`; assert its server.js and .next and print its
 *    BUILD_ID.
 * 2. Pack the SDK with `bun run sdk:pack -- --out <tmp>/sdk`; assert the one absolute .tgz path it printed.
 * 3. Copy the fixture to <tmp>/provider, install the SDK tarball there with npm, and bundle the fixture's entry with
 *    esbuild into the manifest's `runtime.entry`; assert that the installed SDK is the packed one (a directory of its
 *    own whose calls entry points under dist/, at the repository SDK's version), and from esbuild's metafile that
 *    every input lies inside the build directory, that the SDK came from its packed dist/, and that the bundle imports
 *    only `node:` built-ins.
 * 4. Place package.json, the manifest and the bundle as <tmp>/providers/<name>/<version>/ and run
 *    `bun run providers:lock -- --dir <tmp>/providers`; assert the lock line of the one package.
 * 5. Start the standalone server with LIBREDB_PROVIDERS_DIR set, sign in through the API, save a connection of the
 *    fixture engine (`POST /api/db/test-connection`, what the connection dialog's Save posts), run each statement of
 *    acceptance.json (`POST /api/db/query`) and assert its rows, in order.
 * 6. Change the bundle's final byte, its newline, to a space (the module stays valid, so only the digest check can
 *    refuse it), restart, and assert that Studio boots, logs PROVIDER_DIGEST_MISMATCH for the package, and answers
 *    PROVIDER_UNAVAILABLE for the save and the statement.
 * 7. Assert `git status --porcelain` is empty and that no engine id of the fixture appears, in any letter case, in a
 *    file under src, bin, scripts or vscode-extension/src (the isolation ratchet's core roots).
 * 8. Assert that no file under the standalone's .next, the server's build output, equals a fixture file or holds the
 *    package name, an engine id as a quoted literal or an engine's display name.
 *
 * The SDK installs offline. `npm install <sdk tarball>` alone would fetch the SDK's dependency, ajv, from a registry;
 * the run instead packs the closure of the SDK's declared `dependencies` from the repository's own install, found as
 * Node finds a package directory from packages/provider-sdk, and installs those tarballs beside the SDK's, with every
 * npm call offline, on its own empty cache and configs and an empty HOME (the route of the SDK's pack test,
 * packages/provider-sdk/tests/pack.test.ts). So the run fails only for reasons inside the repository, installs no
 * unpinned code, and reproduces without a network. Whether the SDK's declared range resolves from a public registry
 * is a publishing concern this run does not prove.
 *
 * The working tree must be clean before step 1, so step 7 measures this run alone: a dirty tree is refused by name
 * before the build. The temporary root, created under the system temporary directory, must lie outside the
 * repository with no node_modules above it, so nothing resolves from Studio's install. Its layout: sdk/ (the SDK
 * tarball), deps/ (the closure's tarballs), npm/ (npm's cache, configs and HOME), provider/ (the copied fixture and
 * its build), providers/ (the installed package and its lock), server/ (each server's HOME and data directory).
 *
 * Every child gets an explicit environment, never the caller's: PATH, HOME and what its step names, never
 * NODE_OPTIONS, NODE_PATH or an npm_config variable. Each runs as the leader of its own process group, under a
 * timeout (CHILD_TIMEOUTS_MS) that sends SIGTERM to the group and SIGKILL five seconds later; an interrupted run
 * kills every group it started, and only those. The server binds 127.0.0.1 on a port the system just handed out and
 * takes a JWT secret and passwords drawn at run time. The run stops children by process group, so it is POSIX only
 * and refuses Windows by name.
 *
 * Output: one line per step, `ok   step N <title>: <evidence>` or `FAIL step N <title>: <reason>` followed by the
 * captured output, and no later step. A pass removes the temporary root and ends with
 * `out-of-tree acceptance passed: 8 of 8 steps`, exit 0; a failure keeps the root, prints its path, and exits 1.
 *
 * CI runs it in the "Out-of-tree Provider Acceptance" job of .github/workflows/ci.yml against the engine smoke
 * payload, extracted under the runner's temporary directory. Its logic is held by
 * tests/unit/scripts/out-of-tree-acceptance.test.ts.
 *
 * Local run, from a clean tree (one Next.js build and two server starts):
 *   heavy bun scripts/out-of-tree-acceptance.ts [--standalone <dir>]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { version as esbuildVersion } from "esbuild";
import { SESSION_COOKIE } from "../src/lib/auth-cookies";
import { ancestorNodeModules } from "./check-lib-load.mjs";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FIXTURE_DIRECTORY = path.join(REPO_ROOT, "tests", "fixtures", "out-of-tree-provider");
const SDK_DIRECTORY = path.join(REPO_ROOT, "packages", "provider-sdk");

const USAGE = "Usage: heavy bun scripts/out-of-tree-acceptance.ts [--standalone <dir>]";

/**
 * Studio's side of the run, every interface the run relies on in one place: the lock command and its file, the
 * manifest file a package carries, the providers directory's variable, the refusal and answer codes, the session
 * cookie, the admin's sign-in and the routes. The predicates beside it (`refusalLines`, `unavailableProblems`,
 * `rowsProblems`, `saveProblems`) read the answers.
 */
export const STUDIO = Object.freeze({
  lockScript: "providers:lock",
  lockFile: "providers.lock.json",
  manifestFile: "libredb-provider.json",
  providersDirVariable: "LIBREDB_PROVIDERS_DIR",
  digestMismatch: "PROVIDER_DIGEST_MISMATCH",
  unavailable: "PROVIDER_UNAVAILABLE",
  sessionCookie: SESSION_COOKIE,
  adminEmail: "admin@libredb.org",
  coreRoots: Object.freeze(["src", "bin", "scripts", "vscode-extension/src"]),
  routes: Object.freeze({
    health: "/health",
    signIn: "/api/auth/login",
    save: "/api/db/test-connection",
    query: "/api/db/query",
  }),
});

/** How long each kind of child, and each wait on the server, may take. */
export const CHILD_TIMEOUTS_MS = Object.freeze({
  build: 20 * 60_000,
  sdkPack: 3 * 60_000,
  npmPack: 2 * 60_000,
  npmInstall: 3 * 60_000,
  esbuild: 2 * 60_000,
  lock: 2 * 60_000,
  git: 60_000,
  serverLifetime: 5 * 60_000,
  serverReady: 90_000,
  request: 60_000,
  serverStop: 30_000,
  refusalLine: 15_000,
});

/** How long a child's process group has between SIGTERM and SIGKILL once its timeout passed. */
const KILL_GRACE_MS = 5_000;
/** The last bytes of a tool's output kept for a failure's report. */
const TOOL_OUTPUT_LIMIT = 4 * 1024 * 1024;
/** The first bytes of a server's output kept: its boot lines are the ones that matter. */
const SERVER_OUTPUT_LIMIT = 16 * 1024 * 1024;
/** The size of each read of the build scan. */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/** npm's flags for every call: offline, with its own cache and empty user and global configs, running no script. */
function npmFlags(npmDirectory: string): string[] {
  return [
    "--offline",
    "--cache",
    path.join(npmDirectory, "cache"),
    "--userconfig",
    path.join(npmDirectory, "npmrc-user"),
    "--globalconfig",
    path.join(npmDirectory, "npmrc-global"),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--loglevel=error",
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line and the platform.

/** The command line: nothing, or `--standalone <dir>`; null for anything else. */
export function parseArguments(argv: readonly string[]): { standalone: string | null } | null {
  if (argv.length === 0) return { standalone: null };
  const [flag, directory, ...rest] = argv;
  if (flag !== "--standalone" || directory === undefined || directory.startsWith("--") || rest.length > 0) return null;
  return { standalone: directory };
}

/** Why the run cannot run on `platform`, or null when it can. */
export function platformProblem(platform: string): string | null {
  return platform === "win32"
    ? "the out-of-tree acceptance stops each child by its process group, which Windows does not offer; run it on Linux or macOS"
    : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The steps and their run.

/** The issue's eight steps, in order. */
export const STEP_TITLES = Object.freeze([
  "build Studio's standalone output",
  "pack the SDK",
  "build the fixture provider outside the repository against the packed SDK",
  "place and lock the provider package",
  "query the fixture engine through Studio's API",
  "refuse the tampered package at the next boot",
  "the repository is unchanged and names no fixture engine",
  "Studio's build holds none of the fixture's source",
] as const);

/** One step: its number and title, and its run, which answers the evidence it asserted or throws. */
export interface Step {
  readonly number: number;
  readonly title: string;
  readonly run: () => Promise<string>;
}

/** A failure that carries the output it happened under, printed beneath the step's FAIL line. */
export class StepError extends Error {
  constructor(
    message: string,
    readonly output: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StepError";
  }
}

/** The problems with a step list: anything but the issue's eight steps, numbered 1 to 8, in order, with their titles. */
export function stepListProblems(steps: readonly Pick<Step, "number" | "title">[]): string[] {
  const problems: string[] = [];
  if (steps.length !== STEP_TITLES.length) {
    problems.push(`the run holds ${steps.length} steps, not the issue's ${STEP_TITLES.length}`);
  }
  steps.forEach((step, index) => {
    const title = STEP_TITLES[index];
    if (step.number !== index + 1 || step.title !== title) {
      problems.push(
        `position ${index + 1} holds step ${step.number} "${step.title}", not step ${index + 1} "${title}"`,
      );
    }
  });
  return problems;
}

/** Where a run prints, and the cleanup it always runs, told whether every step passed. */
export interface RunIo {
  readonly print: (line: string) => void;
  readonly cleanup: (passed: boolean) => Promise<void>;
}

/** The message of a thrown value and the output it carries, if any. */
function failureOf(error: unknown): { message: string; output: string } {
  if (error instanceof Error) {
    const output = (error as Error & { output?: unknown }).output;
    return { message: error.message, output: typeof output === "string" ? output : "" };
  }
  return { message: String(error), output: "" };
}

/**
 * Runs `steps` in order, stopping at the first that throws or answers no evidence, then runs the cleanup; answers
 * the exit code, 0 only when all eight passed. A list that is not the issue's eight steps runs none of them.
 */
export async function runSteps(steps: readonly Step[], io: RunIo): Promise<number> {
  const listProblems = stepListProblems(steps);
  if (listProblems.length > 0) {
    io.print(`refused: ${listProblems.join("; ")}`);
    await io.cleanup(false);
    return 1;
  }
  let failedAt: number | null = null;
  for (const step of steps) {
    let evidence: string;
    try {
      // oxlint-disable-next-line no-await-in-loop -- the steps run in order, each on what the one before it built.
      evidence = (await step.run()).trim();
    } catch (error) {
      const { message, output } = failureOf(error);
      io.print(`FAIL step ${step.number} ${step.title}: ${message}`);
      if (output.trim() !== "") io.print(output.trimEnd());
      failedAt = step.number;
      break;
    }
    if (evidence === "") {
      io.print(`FAIL step ${step.number} ${step.title}: the step asserted nothing`);
      failedAt = step.number;
      break;
    }
    io.print(`ok   step ${step.number} ${step.title}: ${evidence}`);
  }
  await io.cleanup(failedAt === null);
  io.print(
    failedAt === null
      ? `out-of-tree acceptance passed: ${steps.length} of ${steps.length} steps`
      : `out-of-tree acceptance failed at step ${failedAt} of ${steps.length}`,
  );
  return failedAt === null ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// The fixture.

/** One statement the run sends, and the columns and rows it must answer, in order. */
export interface Expectation {
  readonly statement: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/** The fixture as the run reads it: its package identity, its engines, its bundle's path and its expectations. */
export interface Fixture {
  readonly name: string;
  readonly version: string;
  readonly engines: readonly { readonly id: string; readonly displayName: string }[];
  /** The manifest's `runtime.entry`, where the bundle is written. */
  readonly entry: string;
  readonly acceptance: {
    /** The entry's source, which esbuild bundles. */
    readonly entrySource: string;
    /** The connection's own fields, beside the id and the engine's type the run adds. */
    readonly connection: Readonly<Record<string, unknown>>;
    readonly statements: readonly Expectation[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Parses `text` read from `file` as a JSON object, naming the file on failure. */
function jsonObject(text: string, file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${failureOf(error).message}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
  return value;
}

/** The statements of acceptance.json, each with at least one row of its columns' length. */
function expectations(value: unknown, file: string): Expectation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${file} holds no statement`);
  return value.map((item, index) => {
    const where = `${file} statement ${index + 1}`;
    if (!isRecord(item) || !isText(item.statement)) throw new Error(`${where} has no statement text`);
    const { columns, rows } = item;
    if (!Array.isArray(columns) || columns.length === 0 || !columns.every(isText)) {
      throw new Error(`${where} names no columns`);
    }
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${where} expects no row`);
    rows.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== columns.length) {
        throw new Error(
          `${where} row ${rowIndex + 1} does not hold one value for each of its ${columns.length} columns`,
        );
      }
    });
    return { statement: item.statement, columns, rows };
  });
}

/** Reads the fixture in `directory` through `read`; a fixture the run cannot prove anything with is refused. */
export function readFixture(directory: string, read: (file: string) => string): Fixture {
  const packageFile = path.join(directory, "package.json");
  const pkg = jsonObject(read(packageFile), packageFile);
  if (!isText(pkg.name) || !isText(pkg.version)) throw new Error(`${packageFile} names no package and version`);
  if (pkg.type !== "module") throw new Error(`${packageFile} is not an ES module package ("type": "module")`);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[field] !== undefined) {
      throw new Error(`${packageFile} declares ${field}: the fixture is built against the packed SDK alone`);
    }
  }

  const manifestFile = path.join(directory, STUDIO.manifestFile);
  const manifest = jsonObject(read(manifestFile), manifestFile);
  const engines = manifest.engines;
  if (!Array.isArray(engines) || engines.length !== 1)
    throw new Error(`${manifestFile} declares not exactly one engine`);
  const engine = engines[0] as unknown;
  if (!isRecord(engine) || !isText(engine.id) || !isText(engine.displayName)) {
    throw new Error(`${manifestFile} declares an engine with no id or display name`);
  }
  const runtime = manifest.runtime;
  if (!isRecord(runtime) || !isText(runtime.entry)) throw new Error(`${manifestFile} names no runtime.entry`);

  const acceptanceFile = path.join(directory, "acceptance.json");
  const acceptance = jsonObject(read(acceptanceFile), acceptanceFile);
  if (!isText(acceptance.entrySource)) throw new Error(`${acceptanceFile} names no entrySource`);
  if (!isRecord(acceptance.connection)) throw new Error(`${acceptanceFile} holds no connection object`);

  return {
    name: pkg.name,
    version: pkg.version,
    engines: [{ id: engine.id, displayName: engine.displayName }],
    entry: runtime.entry,
    acceptance: {
      entrySource: acceptance.entrySource,
      connection: acceptance.connection,
      statements: expectations(acceptance.statements, acceptanceFile),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks over captured output.

/** The tarball `sdk:pack` printed: its one line, an absolute .tgz path directly inside `outDirectory`. */
export function sdkTarball(stdout: string, outDirectory: string): string {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw new Error(`sdk:pack printed ${lines.length} lines on standard output, not one line`);
  const tarball = (lines[0] as string).trim();
  if (!path.isAbsolute(tarball)) throw new Error(`sdk:pack printed ${tarball}, not an absolute path`);
  if (!tarball.endsWith(".tgz")) throw new Error(`sdk:pack printed ${tarball}, not a .tgz file`);
  if (path.dirname(tarball) !== path.resolve(outDirectory)) {
    throw new Error(`sdk:pack printed ${tarball}, not a file inside ${outDirectory}`);
  }
  return tarball;
}

/** The problems with a temporary root: inside the repository, or below a directory holding node_modules. */
export function temporaryRootProblems(
  root: string,
  repoRoot: string,
  exists: (candidate: string) => boolean,
): string[] {
  const problems: string[] = [];
  const relative = path.relative(repoRoot, root);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    problems.push(`the temporary root ${root} is inside the repository ${repoRoot}`);
  }
  const ancestor = ancestorNodeModules(root, exists);
  if (ancestor !== null) {
    problems.push(
      `${ancestor} holds node_modules above the temporary root ${root}, so the fixture could resolve a package it was not given; point TMPDIR at a directory with no node_modules above it`,
    );
  }
  return problems;
}

/** The directory of package `name` as Node finds it from `from`: the nearest `node_modules/<name>` with a manifest. */
function packageDirectory(name: string, from: string, exists: (file: string) => boolean): string | null {
  let current = path.resolve(from);
  for (;;) {
    const candidate = path.join(current, "node_modules", name);
    if (exists(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The directories of `names`, found from `from`, and of every package they depend on (`dependencies` only), each
 * found from the directory of the package that depends on it; sorted, each once. A package not found is refused.
 */
export function dependencyClosure(
  names: readonly string[],
  from: string,
  exists: (file: string) => boolean,
  readManifest: (directory: string) => { readonly dependencies?: Readonly<Record<string, string>> },
): string[] {
  const found = new Set<string>();
  const pending = names.map((name) => ({ name, from }));
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const directory = packageDirectory(next.name, next.from, exists);
    if (directory === null) {
      throw new Error(`${next.name}, needed by ${next.from}, is not installed in any node_modules above it`);
    }
    if (found.has(directory)) continue;
    found.add(directory);
    for (const name of Object.keys(readManifest(directory).dependencies ?? {})) pending.push({ name, from: directory });
  }
  return [...found].sort();
}

/** The tarballs `npm pack --json` wrote, as absolute paths in `destination`. */
export function packedTarballs(npmJson: string, destination: string): string[] {
  let answer: unknown;
  try {
    answer = JSON.parse(npmJson);
  } catch {
    throw new Error(`npm pack answered no JSON: ${npmJson.slice(0, 200)}`);
  }
  if (!Array.isArray(answer) || answer.length === 0) throw new Error("npm pack answered no tarball");
  return answer.map((item) => {
    if (!isRecord(item) || !isText(item.filename)) throw new Error("npm pack answered an entry with no filename");
    if (path.basename(item.filename) !== item.filename) {
      throw new Error(`npm pack answered ${item.filename}, not a file directly in its destination ${destination}`);
    }
    return path.join(destination, item.filename);
  });
}

/** What the run read of the installed SDK. */
export interface InstalledSdk {
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly manifest: unknown;
  readonly expectedVersion: string;
}

/** The problems with the installed SDK: it must be the packed package, not a link to the repository's source. */
export function installedSdkProblems(installed: InstalledSdk): string[] {
  const problems: string[] = [];
  if (installed.isSymbolicLink) problems.push("the installed SDK is a symbolic link, not the packed package");
  if (!installed.isDirectory) problems.push("the installed SDK is not a directory");
  const manifest = isRecord(installed.manifest) ? installed.manifest : {};
  if (manifest.name !== "@libredb/provider-sdk") {
    problems.push(`the installed SDK is named ${JSON.stringify(manifest.name)}, not "@libredb/provider-sdk"`);
  }
  if (manifest.version !== installed.expectedVersion) {
    problems.push(
      `the installed SDK is version ${JSON.stringify(manifest.version)}, not the repository SDK's ${installed.expectedVersion}`,
    );
  }
  const calls = isRecord(manifest.exports) ? manifest.exports["./calls"] : undefined;
  const target = isRecord(calls) ? calls.default : calls;
  if (typeof target !== "string" || !target.startsWith("./dist/")) {
    problems.push(`the installed SDK's calls entry is ${JSON.stringify(target)}, not a file under ./dist/`);
  }
  return problems;
}

/** The packed SDK's built files, as esbuild names a bundle input taken from them. */
const PACKED_SDK_INPUT = "node_modules/@libredb/provider-sdk/dist/";

/**
 * The problems with a bundle, from esbuild's metafile: an input outside the build directory, no input from the packed
 * SDK's dist/, or an import of the output other than a `node:` built-in.
 */
export function bundleProblems(metafile: unknown, outfile: string): string[] {
  const meta = isRecord(metafile) ? metafile : {};
  const inputs = Object.keys(isRecord(meta.inputs) ? meta.inputs : {});
  const problems = inputs
    .filter((input) => path.isAbsolute(input) || input.split(/[\\/]/)[0] === "..")
    .map((input) => `the bundle read ${input}, outside the build directory`);
  if (!inputs.some((input) => input.startsWith(PACKED_SDK_INPUT))) {
    problems.push(`the bundle read nothing from the packed SDK (${PACKED_SDK_INPUT})`);
  }
  const outputs = isRecord(meta.outputs) ? meta.outputs : {};
  const output = outputs[outfile];
  if (!isRecord(output)) return [...problems, `esbuild's metafile names no output ${outfile}`];
  const imports = Array.isArray(output.imports) ? output.imports : [];
  for (const item of imports) {
    const specifier = isRecord(item) ? item.path : undefined;
    if (typeof specifier !== "string" || !specifier.startsWith("node:")) {
      problems.push(`the bundle imports ${JSON.stringify(specifier)}, not a node: built-in`);
    }
  }
  return problems;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The problems with the lock command's output: it must name the lock file, then the one package and its digest. */
export function lockOutputProblems(stdout: string, lockFile: string, name: string, version: string): string[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  const problems: string[] = [];
  if (lines[0] !== `Wrote ${lockFile}`) problems.push(`the lock command's first line is not "Wrote ${lockFile}"`);
  const entry = new RegExp(`^${escapeRegExp(name)} ${escapeRegExp(version)} sha256:[0-9a-f]{64}$`);
  if (lines.length !== 2 || !entry.test(lines[1] as string)) {
    problems.push(`the lock command did not print exactly one line "${name} ${version} sha256:<64 hex digits>"`);
  }
  return problems.length === 0 ? [] : [...problems, `it printed: ${JSON.stringify(lines)}`];
}

/** The problems with an artifact's files (paths relative to it, `/`-separated): exactly package.json, the manifest and the bundle. */
export function artifactProblems(files: readonly string[], entry: string): string[] {
  const expected = new Set(["package.json", STUDIO.manifestFile, entry]);
  return [
    ...[...expected].filter((file) => !files.includes(file)).map((file) => `the artifact holds no ${file}`),
    ...files.filter((file) => !expected.has(file)).map((file) => `the artifact holds ${file}, which it must not`),
  ];
}

/** The bundle with its final byte, a newline, changed to a space; a bundle not ending in a newline is refused. */
export function tamperedBundle(bytes: Uint8Array): Uint8Array {
  if (bytes.at(-1) !== 0x0a) throw new Error("the bundle does not end in a newline, so its final byte cannot change");
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 1] = 0x20;
  return tampered;
}

/** The session cookie, `name=value`, a sign-in set; a sign-in that did not answer 200 with it is refused. */
export function sessionCookie(status: number, setCookies: readonly string[]): string {
  const cookie = setCookies
    .map((header) => header.split(";")[0]?.trim() ?? "")
    .find((pair) => pair.startsWith(`${STUDIO.sessionCookie}=`));
  if (status !== 200 || cookie === undefined) {
    throw new Error(`the admin sign-in answered ${status} with no ${STUDIO.sessionCookie} cookie`);
  }
  return cookie;
}

/** An answer of Studio's API: its status and JSON body. */
export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** The problems with a statement's answer: it must be 200 with exactly the expected rows, in order. */
export function rowsProblems(answer: Answer, expected: Expectation): string[] {
  if (answer.status !== 200) {
    return [`"${expected.statement}" answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 500)}`];
  }
  const rows = expected.rows.map((row) => Object.fromEntries(expected.columns.map((column, i) => [column, row[i]])));
  return isDeepStrictEqual(answer.body.rows, rows)
    ? []
    : [`"${expected.statement}" answered rows ${JSON.stringify(answer.body.rows)}, not ${JSON.stringify(rows)}`];
}

/** The problems with a save's answer: it must be 200, a success, and not degraded (the engine's health answered). */
export function saveProblems(answer: Answer): string[] {
  return answer.status === 200 && answer.body.success === true && answer.body.degraded !== true
    ? []
    : [`the save answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 500)}`];
}

/**
 * The problems with an answer for a refused package: a status of 400 or more, the code PROVIDER_UNAVAILABLE exactly
 * (a substring test would take IDENTITY_PROVIDER_UNAVAILABLE), and a body naming `refusalCode`.
 */
export function unavailableProblems(answer: Answer, refusalCode: string): string[] {
  const body = JSON.stringify(answer.body).slice(0, 500);
  const problems: string[] = [];
  if (answer.status < 400) problems.push(`answered ${answer.status}, not an error status`);
  if (answer.body.code !== STUDIO.unavailable) {
    problems.push(`answered code ${JSON.stringify(answer.body.code)}, not ${STUDIO.unavailable}`);
  }
  if (!JSON.stringify(answer.body).includes(refusalCode)) problems.push(`answered a body naming no ${refusalCode}`);
  return problems.length === 0 ? [] : [...problems, `body: ${body}`];
}

/** The lines of `output` refusing package `name` `version` with `code`, or with any PROVIDER_ code when null. */
export function refusalLines(output: string, code: string | null, name: string, version: string): string[] {
  const pattern = new RegExp(
    `(?<![A-Z_])(${code === null ? "PROVIDER_[A-Z_]+" : escapeRegExp(code)}): ${escapeRegExp(name)} ${escapeRegExp(version)}:`,
  );
  return output.split("\n").filter((line) => pattern.test(line));
}

/** The problems with `git status --porcelain`: any line at all. */
export function porcelainProblems(stdout: string): string[] {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? [] : [`the working tree is not clean: ${lines.join(" | ")}`];
}

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

/** The files of `files` whose text names any of `ids`, in any letter case. */
export function filesNaming(
  files: readonly string[],
  ids: readonly string[],
  read: (file: string) => string,
): string[] {
  const lowered = ids.map((id) => id.toLowerCase());
  return files.filter((file) => {
    const text = read(file).toLowerCase();
    return lowered.some((id) => text.includes(id));
  });
}

/** The literals any compiled copy of the fixture carries: its package name, each engine id quoted, each display name. */
export function buildNeedles(fixture: Pick<Fixture, "name" | "engines">): string[] {
  return [
    fixture.name,
    ...fixture.engines.flatMap((engine) => [
      `"${engine.id}"`,
      `'${engine.id}'`,
      `\`${engine.id}\``,
      engine.displayName,
    ]),
  ];
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
 * The problems of the build scan: each file of `files` that equals a fixture file (its SHA-256 is in `digests`) or
 * holds a needle; a scan of no file fails, since it would assert nothing.
 */
export function buildScanProblems(
  files: readonly string[],
  needles: readonly string[],
  digests: ReadonlySet<string>,
  chunkSize: number = SCAN_CHUNK_BYTES,
): string[] {
  if (files.length === 0) return ["the build scan found no file to read"];
  const needleBytes = needles.map((needle) => Buffer.from(needle, "utf8"));
  return files.flatMap((file) => {
    const { digest, found } = scanFile(file, needleBytes, chunkSize);
    return [
      ...(digests.has(digest) ? [`${file} is a copy of a fixture file`] : []),
      ...found.map((needle) => `${file} holds ${needle.toString("utf8")}`),
    ];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Children.

/** One child: what it runs, where, with which environment and under which timeout. */
export interface ChildSpec {
  readonly label: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

const INHERITED_CONFIGURATION = /^(NODE_OPTIONS|NODE_PATH|NPM_CONFIG_.*)$/i;

/** A child, refused when it has no command, no PATH, configuration a caller could leak in, or no finite timeout. */
export function childSpec(
  label: string,
  command: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): ChildSpec {
  if (command.length === 0) throw new Error(`${label} has no command`);
  if (!isText(env.PATH)) throw new Error(`${label} has no PATH in its environment`);
  const leaked = Object.keys(env).filter((name) => INHERITED_CONFIGURATION.test(name));
  if (leaked.length > 0) throw new Error(`${label}'s environment holds ${leaked.join(", ")}`);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${label} has no finite timeout`);
  return { label, command, cwd, env, timeoutMs };
}

/** A child as the run prints it: its command, directory and timeout, never an environment value. */
export function describeChild(spec: ChildSpec): string {
  return `${spec.label}: ${spec.command.join(" ")} (in ${spec.cwd}, timeout ${Math.round(spec.timeoutMs / 1000)} s)`;
}

/** What the server is given. */
export interface ServerInput {
  readonly path: string;
  readonly home: string;
  readonly dataDirectory: string;
  readonly port: number;
  readonly providersDirectory: string;
  readonly credentials: { readonly jwtSecret: string; readonly adminPassword: string; readonly userPassword: string };
}

/**
 * The server's environment: bound to 127.0.0.1 on `port`, the providers directory by its absolute path (the standalone
 * server changes into its own directory before boot reads it), the run's credentials, its own HOME and data directory,
 * both samples off, no seed configuration and no storage provider.
 */
export function serverEnvironment(input: ServerInput): Record<string, string> {
  if (!path.isAbsolute(input.providersDirectory)) {
    throw new Error(`the providers directory ${input.providersDirectory} is not an absolute path`);
  }
  return {
    PATH: input.path,
    HOME: input.home,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    LIBREDB_NO_BANNER: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(input.port),
    [STUDIO.providersDirVariable]: input.providersDirectory,
    STORAGE_SQLITE_PATH: path.join(input.dataDirectory, "libredb-storage.db"),
    SEED_CONFIG_PATH: "",
    SQLITE_EMBEDDED_SAMPLE: "false",
    LIBREDB_EMBEDDED_SAMPLE: "false",
    JWT_SECRET: input.credentials.jwtSecret,
    ADMIN_EMAIL: STUDIO.adminEmail,
    ADMIN_PASSWORD: input.credentials.adminPassword,
    USER_PASSWORD: input.credentials.userPassword,
  };
}

/** Output kept up to `limit` bytes: the first bytes, or the last. */
class CappedOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = 0;

  constructor(
    private readonly limit: number,
    private readonly keep: "head" | "tail",
  ) {}

  add(chunk: Buffer): void {
    if (this.keep === "head") {
      const kept = chunk.subarray(0, Math.max(0, this.limit - this.size));
      if (kept.length > 0) this.chunks.push(kept);
      this.size += kept.length;
      this.dropped += chunk.length - kept.length;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const first = this.chunks.shift() as Buffer;
      this.size -= first.length;
      this.dropped += first.length;
    }
  }

  text(): string {
    const note = this.dropped > 0 ? `[${this.dropped} bytes of output not kept]\n` : "";
    return this.keep === "head"
      ? `${Buffer.concat(this.chunks).toString("utf8")}${note}`
      : `${note}${Buffer.concat(this.chunks).toString("utf8")}`;
  }
}

/** The process groups this run started and has not seen end, killed when the run is interrupted or exits. */
const liveGroups = new Set<number>();

/** Sends `signal` to the process group led by `pid`; a group already gone is not an error. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Kills every process group the run started and has not seen end. */
function killLiveGroups(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
  liveGroups.clear();
}

/** Spawns `spec` as the leader of its own process group, registered until it ends. */
function spawnGroup(spec: ChildSpec): ChildProcess {
  const [command, ...args] = spec.command as [string, ...string[]];
  const child = spawn(command, args, {
    cwd: spec.cwd,
    // The environment is the spec's alone; Studio's ProcessEnv type declares NODE_ENV, which a tool child leaves unset.
    env: { ...spec.env } as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid !== undefined) liveGroups.add(child.pid);
  return child;
}

/** What a finished child printed and how it ended. */
interface ChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly output: string;
}

/** Runs `spec` to its end, its group stopped at its timeout, and answers what it printed and how it ended. */
function runChild(spec: ChildSpec): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawnGroup(spec);
    const stdout = new CappedOutput(TOOL_OUTPUT_LIMIT, "tail");
    const output = new CappedOutput(TOOL_OUTPUT_LIMIT, "tail");
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.add(chunk);
      output.add(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => output.add(chunk));
    let timedOut = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGTERM");
      kill = setTimeout(() => {
        if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
    }, spec.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(kill);
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      reject(new Error(`${describeChild(spec)} could not start: ${error.message}`));
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      resolve({ exitCode, signal, timedOut, stdout: stdout.text(), output: output.text() });
    });
  });
}

/** The result of a child that must exit 0; any other end is a failure naming the child and how it ended. */
function succeeded(spec: ChildSpec, result: ChildResult): ChildResult {
  if (result.exitCode === 0 && !result.timedOut) return result;
  const end = result.timedOut
    ? `did not finish within its timeout of ${Math.round(spec.timeoutMs / 1000)} s`
    : `exited ${result.exitCode}${result.signal === null ? "" : ` on ${result.signal}`}`;
  throw new StepError(`${describeChild(spec)} ${end}`, result.output);
}

/** Runs `spec` and answers its result once it exited 0. */
async function runOk(spec: ChildSpec): Promise<ChildResult> {
  return succeeded(spec, await runChild(spec));
}

// ---------------------------------------------------------------------------------------------------------------------
// The server.

interface Server {
  readonly port: number;
  readonly child: ChildProcess;
  output(): string;
  hasExited(): boolean;
  readonly exited: Promise<void>;
  readonly lifetime: ReturnType<typeof setTimeout>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing listens on now; the server binds it a moment later, and a collision fails the start by name. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("the port probe has no address"));
      });
    });
  });
}

/** Starts `node server.js` in `standalone`, its group killed when its lifetime passes. */
function startServer(standalone: string, env: Record<string, string>, port: number): Server {
  const spec = childSpec("node server.js", ["node", "server.js"], standalone, env, CHILD_TIMEOUTS_MS.serverLifetime);
  const child = spawnGroup(spec);
  const output = new CappedOutput(SERVER_OUTPUT_LIMIT, "head");
  child.stdout?.on("data", (chunk: Buffer) => output.add(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.add(chunk));
  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      if (child.pid !== undefined) liveGroups.delete(child.pid);
      resolve();
    });
    child.once("error", (error) => {
      output.add(Buffer.from(`the server could not start: ${error.message}\n`));
      exited = true;
      resolve();
    });
  });
  const lifetime = setTimeout(() => {
    output.add(Buffer.from(`the server outlived its ${spec.timeoutMs / 1000} s lifetime and was killed\n`));
    if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
  }, spec.timeoutMs);
  return { port, child, output: () => output.text(), hasExited: () => exited, exited: done, lifetime };
}

/** Answers once `GET /health` is 200; throws when the server exits first or misses its deadline. */
async function ready(server: Server): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < CHILD_TIMEOUTS_MS.serverReady) {
    if (server.hasExited()) throw new Error(`the server exited before it answered GET ${STUDIO.routes.health}`);
    try {
      // oxlint-disable-next-line no-await-in-loop -- each probe waits for the one before it: the server is polled until it answers.
      const response = await fetch(`http://127.0.0.1:${server.port}${STUDIO.routes.health}`, {
        signal: AbortSignal.timeout(2000),
      });
      // oxlint-disable-next-line no-await-in-loop -- the probe's body is read to its end before the next one.
      await response.text();
      if (response.status === 200) return;
    } catch {
      // Not listening yet: the next probe asks again until the deadline.
    }
    // oxlint-disable-next-line no-await-in-loop -- the pause between two probes of the server.
    await delay(100);
  }
  throw new Error(`the server did not answer GET ${STUDIO.routes.health} with 200 within the ready deadline`);
}

/** Stops the server's group with SIGTERM, killing it past the stop deadline. */
async function stopServer(server: Server): Promise<void> {
  clearTimeout(server.lifetime);
  const pid = server.child.pid;
  if (server.hasExited() || pid === undefined) return;
  signalGroup(pid, "SIGTERM");
  const late = delay(CHILD_TIMEOUTS_MS.serverStop).then(() => "late" as const);
  if ((await Promise.race([server.exited, late])) === "late") {
    signalGroup(pid, "SIGKILL");
    await server.exited;
  }
}

/** Posts `body` as JSON to `route`, with the session cookie when given, and answers the status, body and cookies set. */
async function postJson(
  server: Server,
  route: string,
  body: unknown,
  cookie: string | null,
): Promise<Answer & { readonly setCookies: string[] }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === null ? {} : { cookie }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHILD_TIMEOUTS_MS.request),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`POST ${route} answered ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`);
  }
  if (!isRecord(parsed)) throw new Error(`POST ${route} answered ${response.status} with a body that is not an object`);
  return { status: response.status, body: parsed, setCookies: response.headers.getSetCookie() };
}

/** Signs in as the admin and answers the session cookie. */
async function signIn(server: Server, adminPassword: string): Promise<string> {
  const answer = await postJson(
    server,
    STUDIO.routes.signIn,
    { email: STUDIO.adminEmail, password: adminPassword },
    null,
  );
  return sessionCookie(answer.status, answer.setCookies);
}

/** Runs `work` on a server started with `env`, always stopping it; a failure carries the server's output. */
async function withServer<T>(
  standalone: string,
  env: Record<string, string>,
  port: number,
  work: (server: Server) => Promise<T>,
): Promise<T> {
  const server = startServer(standalone, env, port);
  try {
    await ready(server);
    return await work(server);
  } catch (error) {
    const { message, output } = failureOf(error);
    throw new StepError(
      message,
      [output, `server output:\n${server.output()}`].filter((part) => part !== "").join("\n"),
      { cause: error },
    );
  } finally {
    await stopServer(server);
  }
}

/** Throws a step failure listing `problems`, when there are any. */
function assertNone(problems: readonly string[], output = ""): void {
  if (problems.length > 0) throw new StepError(problems.join("; "), output);
}

// ---------------------------------------------------------------------------------------------------------------------
// The eight steps.

/** What the steps share: where the run works, what the caller gave and what each step leaves for the next. */
interface Context {
  readonly fixture: Fixture;
  readonly standaloneArgument: string | null;
  readonly temp: string;
  readonly callerPath: string;
  readonly callerHome: string;
  readonly credentials: ServerInput["credentials"];
  standalone?: string;
  tarball?: string;
  artifact?: string;
  providers?: string;
}

/** A value an earlier step left, refused by name when it did not. */
function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no earlier step left ${what}`);
  return value;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** An empty directory npm, esbuild and the server use as HOME, so no user configuration reaches them. */
const emptyHome = (ctx: Context): string => path.join(ctx.temp, "npm", "home");

async function buildStandalone(ctx: Context): Promise<string> {
  let standalone: string;
  if (ctx.standaloneArgument !== null) {
    standalone = path.resolve(ctx.standaloneArgument);
  } else {
    // The credentials only satisfy build-time page data collection (scripts/build-standalone-payload.sh); the server
    // takes the run's own at start.
    const env = {
      PATH: ctx.callerPath,
      HOME: ctx.callerHome,
      DOCKER_BUILD: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      JWT_SECRET: randomBytes(32).toString("hex"),
      ADMIN_PASSWORD: randomUUID(),
      USER_PASSWORD: randomUUID(),
    };
    await runOk(
      childSpec("bun run build", [process.execPath, "run", "build"], REPO_ROOT, env, CHILD_TIMEOUTS_MS.build),
    );
    standalone = path.join(REPO_ROOT, ".next", "standalone");
  }
  if (!existsSync(path.join(standalone, "server.js")) || !statSync(path.join(standalone, "server.js")).isFile()) {
    throw new Error(`${standalone} holds no server.js`);
  }
  if (!existsSync(path.join(standalone, ".next")) || !statSync(path.join(standalone, ".next")).isDirectory()) {
    throw new Error(`${standalone} holds no .next directory`);
  }
  const buildId = readFileSync(path.join(standalone, ".next", "BUILD_ID"), "utf8").trim();
  ctx.standalone = standalone;
  return `${standalone}, build ${buildId}`;
}

async function packSdk(ctx: Context): Promise<string> {
  const out = path.join(ctx.temp, "sdk");
  mkdirSync(out);
  const spec = childSpec(
    "bun run sdk:pack",
    [process.execPath, "run", "sdk:pack", "--", "--out", out],
    REPO_ROOT,
    { PATH: ctx.callerPath, HOME: emptyHome(ctx) },
    CHILD_TIMEOUTS_MS.sdkPack,
  );
  const tarball = sdkTarball((await runOk(spec)).stdout, out);
  if (!statSync(tarball).isFile()) throw new Error(`${tarball} is not a file`);
  ctx.tarball = tarball;
  return `${path.basename(tarball)}, ${statSync(tarball).size} bytes, in ${out}`;
}

/** The npm on PATH. */
function npmCommand(ctx: Context): string {
  const npm = Bun.which("npm", { PATH: ctx.callerPath });
  if (npm === null) throw new Error("no npm on PATH: the run installs the SDK tarball with npm");
  return npm;
}

async function buildProvider(ctx: Context): Promise<string> {
  const tarball = earlier(ctx.tarball, "the SDK tarball");
  const npmDirectory = path.join(ctx.temp, "npm");
  const deps = path.join(ctx.temp, "deps");
  const provider = path.join(ctx.temp, "provider");
  mkdirSync(deps);
  cpSync(FIXTURE_DIRECTORY, provider, { recursive: true });
  const env = { PATH: ctx.callerPath, HOME: emptyHome(ctx) };
  const npm = npmCommand(ctx);

  const sdkManifest = JSON.parse(readFileSync(path.join(SDK_DIRECTORY, "package.json"), "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };
  const closure = dependencyClosure(
    Object.keys(sdkManifest.dependencies ?? {}),
    SDK_DIRECTORY,
    existsSync,
    (directory) => JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")),
  );
  const closureTarballs =
    closure.length === 0
      ? []
      : packedTarballs(
          (
            await runOk(
              childSpec(
                "npm pack",
                [npm, "pack", ...closure, "--json", "--pack-destination", deps, ...npmFlags(npmDirectory)],
                deps,
                env,
                CHILD_TIMEOUTS_MS.npmPack,
              ),
            )
          ).stdout,
          deps,
        );
  await runOk(
    childSpec(
      "npm install",
      [npm, "install", tarball, ...closureTarballs, "--no-save", ...npmFlags(npmDirectory)],
      provider,
      env,
      CHILD_TIMEOUTS_MS.npmInstall,
    ),
  );

  const installed = path.join(provider, "node_modules", "@libredb", "provider-sdk");
  const link = lstatSync(installed);
  assertNone(
    installedSdkProblems({
      isSymbolicLink: link.isSymbolicLink(),
      isDirectory: link.isDirectory(),
      manifest: JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")),
      expectedVersion: sdkManifest.version,
    }),
  );

  const metafile = path.join(ctx.temp, "bundle-meta.json");
  const esbuild = createRequire(import.meta.url).resolve("esbuild/bin/esbuild");
  const bundle = await runOk(
    childSpec(
      "esbuild",
      [
        esbuild,
        ctx.fixture.acceptance.entrySource,
        "--bundle",
        "--format=esm",
        "--platform=node",
        "--target=node24",
        `--outfile=${ctx.fixture.entry}`,
        `--metafile=${metafile}`,
        "--log-level=warning",
      ],
      provider,
      env,
      CHILD_TIMEOUTS_MS.esbuild,
    ),
  );
  const meta = JSON.parse(readFileSync(metafile, "utf8")) as unknown;
  assertNone(bundleProblems(meta, ctx.fixture.entry), bundle.output);
  const inputs = Object.keys((meta as { inputs: object }).inputs).length;
  const size = statSync(path.join(provider, ctx.fixture.entry)).size;
  const packed = closureTarballs.map((file) => path.basename(file, ".tgz")).join(", ");
  return `SDK ${sdkManifest.version} installed offline with ${packed}; esbuild ${esbuildVersion} bundled ${inputs} inputs into ${ctx.fixture.entry}, ${size} bytes, importing only node: built-ins`;
}

async function placeAndLock(ctx: Context): Promise<string> {
  const { fixture } = ctx;
  const provider = path.join(ctx.temp, "provider");
  const providers = path.join(ctx.temp, "providers");
  const artifact = path.join(providers, ...fixture.name.split("/"), fixture.version);
  for (const file of ["package.json", STUDIO.manifestFile, fixture.entry]) {
    mkdirSync(path.dirname(path.join(artifact, file)), { recursive: true });
    copyFileSync(path.join(provider, file), path.join(artifact, file));
  }
  const files = regularFiles(artifact).map((file) => path.relative(artifact, file).split(path.sep).join("/"));
  assertNone(artifactProblems(files, fixture.entry));

  const lockFile = path.join(providers, STUDIO.lockFile);
  const lock = await runOk(
    childSpec(
      `bun run ${STUDIO.lockScript}`,
      [process.execPath, "run", STUDIO.lockScript, "--", "--dir", providers],
      REPO_ROOT,
      { PATH: ctx.callerPath, HOME: emptyHome(ctx) },
      CHILD_TIMEOUTS_MS.lock,
    ),
  );
  assertNone(lockOutputProblems(lock.stdout, lockFile, fixture.name, fixture.version), lock.output);
  if (!statSync(lockFile).isFile()) throw new Error(`${lockFile} is not a regular file`);
  ctx.artifact = artifact;
  ctx.providers = providers;
  return `${path.relative(ctx.temp, artifact)} locked: ${lock.stdout.trim().split("\n").at(-1)}`;
}

/** The server's environment for one boot of this run, with its own data directory. */
function bootEnvironment(ctx: Context, boot: string, port: number): Record<string, string> {
  const home = path.join(ctx.temp, "server", "home");
  const dataDirectory = path.join(ctx.temp, "server", boot);
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  return serverEnvironment({
    path: ctx.callerPath,
    home,
    dataDirectory,
    port,
    providersDirectory: earlier(ctx.providers, "the providers directory"),
    credentials: ctx.credentials,
  });
}

/** The connection the run saves: the fixture's own fields, an id and the engine's type. */
function connectionOf(ctx: Context): Record<string, unknown> {
  const engine = ctx.fixture.engines[0] as Fixture["engines"][number];
  return { ...ctx.fixture.acceptance.connection, id: randomUUID(), type: engine.id };
}

async function queryEngine(ctx: Context): Promise<string> {
  const { fixture } = ctx;
  const standalone = earlier(ctx.standalone, "a standalone build");
  const port = await freePort();
  return withServer(standalone, bootEnvironment(ctx, "first-boot", port), port, async (server) => {
    assertNone(
      refusalLines(server.output(), null, fixture.name, fixture.version).map(
        (line) => `the first boot refused the package: ${line}`,
      ),
    );
    const cookie = await signIn(server, ctx.credentials.adminPassword);
    const connection = connectionOf(ctx);
    const save = await postJson(server, STUDIO.routes.save, { connection }, cookie);
    assertNone(saveProblems(save));
    const answered: string[] = [];
    for (const expected of fixture.acceptance.statements) {
      // oxlint-disable-next-line no-await-in-loop -- the statements run one after another on the one connection.
      const answer = await postJson(server, STUDIO.routes.query, { connection, sql: expected.statement }, cookie);
      assertNone(rowsProblems(answer, expected));
      answered.push(`${expected.statement} -> ${JSON.stringify(answer.body.rows)}`);
    }
    return `engine ${connection.type} on 127.0.0.1:${port}, saved (${save.status} ${JSON.stringify(save.body)}) and answered: ${answered.join("; ")}`;
  });
}

async function refuseTampered(ctx: Context): Promise<string> {
  const { fixture } = ctx;
  const standalone = earlier(ctx.standalone, "a standalone build");
  const bundle = path.join(earlier(ctx.artifact, "an installed package"), fixture.entry);
  const before = readFileSync(bundle);
  writeFileSync(bundle, tamperedBundle(before));
  if (sha256(readFileSync(bundle)) === sha256(before)) throw new Error(`${bundle}'s digest did not change`);

  const port = await freePort();
  return withServer(standalone, bootEnvironment(ctx, "second-boot", port), port, async (server) => {
    const started = Date.now();
    let lines = refusalLines(server.output(), STUDIO.digestMismatch, fixture.name, fixture.version);
    while (lines.length === 0 && Date.now() - started < CHILD_TIMEOUTS_MS.refusalLine) {
      // oxlint-disable-next-line no-await-in-loop -- the pause between two reads of the server's output.
      await delay(100);
      lines = refusalLines(server.output(), STUDIO.digestMismatch, fixture.name, fixture.version);
    }
    if (lines.length === 0) {
      throw new Error(
        `the server booted but logged no ${STUDIO.digestMismatch} for ${fixture.name} ${fixture.version}`,
      );
    }
    const cookie = await signIn(server, ctx.credentials.adminPassword);
    const connection = connectionOf(ctx);
    const save = await postJson(server, STUDIO.routes.save, { connection }, cookie);
    assertNone(unavailableProblems(save, STUDIO.digestMismatch).map((problem) => `the save ${problem}`));
    const statement = (fixture.acceptance.statements[0] as Expectation).statement;
    const query = await postJson(server, STUDIO.routes.query, { connection, sql: statement }, cookie);
    assertNone(unavailableProblems(query, STUDIO.digestMismatch).map((problem) => `the statement ${problem}`));
    return `booted and logged "${(lines[0] as string).trim()}"; the save answered ${save.status} ${JSON.stringify(save.body)} and the statement ${query.status} ${JSON.stringify(query.body)}`;
  });
}

async function repositoryUnchanged(ctx: Context): Promise<string> {
  const status = await runOk(
    childSpec(
      "git status",
      ["git", "status", "--porcelain"],
      REPO_ROOT,
      { PATH: ctx.callerPath, HOME: ctx.callerHome },
      CHILD_TIMEOUTS_MS.git,
    ),
  );
  assertNone(porcelainProblems(status.stdout));
  const ids = ctx.fixture.engines.map((engine) => engine.id);
  const files = STUDIO.coreRoots.flatMap((root) => regularFiles(path.join(REPO_ROOT, root)));
  if (files.length === 0) throw new Error(`no file under ${STUDIO.coreRoots.join(", ")}`);
  const naming = filesNaming(files, ids, (file) => readFileSync(file, "utf8"));
  assertNone(naming.map((file) => `${path.relative(REPO_ROOT, file)} names ${ids.join(" or ")}`));
  return `git status --porcelain is empty; none of ${files.length} files under ${STUDIO.coreRoots.join(", ")} names ${ids.join(", ")}`;
}

async function buildHoldsNoFixture(ctx: Context): Promise<string> {
  const build = path.join(earlier(ctx.standalone, "a standalone build"), ".next");
  const needles = buildNeedles(ctx.fixture);
  const digests = new Set(regularFiles(FIXTURE_DIRECTORY).map((file) => sha256(readFileSync(file))));
  const files = regularFiles(build);
  assertNone(buildScanProblems(files, needles, digests));
  return `none of ${files.length} files under ${build} equals a fixture file or holds ${needles.join(", ")}`;
}

/** The issue's eight steps over `ctx`. */
function buildSteps(ctx: Context): Step[] {
  const runs = [
    buildStandalone,
    packSdk,
    buildProvider,
    placeAndLock,
    queryEngine,
    refuseTampered,
    repositoryUnchanged,
    buildHoldsNoFixture,
  ];
  return runs.map((run, index) => ({
    number: index + 1,
    title: STEP_TITLES[index] as string,
    run: () => run(ctx),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The run.

/** Runs the acceptance with `argv` and answers its exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  if (args === null) {
    console.error(USAGE);
    return 2;
  }
  const platform = platformProblem(process.platform);
  if (platform !== null) {
    console.error(`refused: ${platform}`);
    return 1;
  }
  const callerPath = process.env.PATH ?? "";
  const callerHome = process.env.HOME ?? "";
  if (callerPath === "" || callerHome === "") {
    console.error("refused: the run needs PATH and HOME to start its children");
    return 1;
  }

  const status = await runChild(
    childSpec(
      "git status",
      ["git", "status", "--porcelain"],
      REPO_ROOT,
      { PATH: callerPath, HOME: callerHome },
      60_000,
    ),
  );
  const dirty = status.exitCode === 0 ? porcelainProblems(status.stdout) : [`git status exited ${status.exitCode}`];
  if (dirty.length > 0) {
    console.error(`refused before the build: ${dirty.join("; ")}; step 7 asserts the run changes nothing`);
    return 1;
  }

  const fixture = readFixture(FIXTURE_DIRECTORY, (file) => readFileSync(file, "utf8"));
  const temp = mkdtempSync(path.join(realpathSync(tmpdir()), "libredb-out-of-tree-"));
  const rootProblems = temporaryRootProblems(temp, REPO_ROOT, existsSync);
  if (rootProblems.length > 0) {
    rmSync(temp, { recursive: true, force: true });
    console.error(`refused: ${rootProblems.join("; ")}`);
    return 1;
  }
  for (const directory of ["npm/home", "npm/cache"]) mkdirSync(path.join(temp, directory), { recursive: true });
  writeFileSync(path.join(temp, "npm", "npmrc-user"), "");
  writeFileSync(path.join(temp, "npm", "npmrc-global"), "");

  process.on("exit", killLiveGroups);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      killLiveGroups();
      console.error(`interrupted by ${signal}; the temporary root ${temp} is kept`);
      process.exit(code);
    });
  }

  const ctx: Context = {
    fixture,
    standaloneArgument: args.standalone,
    temp,
    callerPath,
    callerHome,
    credentials: {
      jwtSecret: randomBytes(32).toString("hex"),
      adminPassword: randomUUID(),
      userPassword: randomUUID(),
    },
  };
  console.log(`out-of-tree acceptance of ${fixture.name} ${fixture.version}, temporary root ${temp}`);
  return runSteps(buildSteps(ctx), {
    print: (line) => console.log(line),
    cleanup: async (passed) => {
      killLiveGroups();
      if (passed) rmSync(temp, { recursive: true, force: true });
      else console.log(`kept the temporary root ${temp} for inspection`);
    },
  });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
