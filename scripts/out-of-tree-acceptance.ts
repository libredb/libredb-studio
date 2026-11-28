#!/usr/bin/env bun
/**
 * The out-of-tree provider acceptance (issues #2520 and #2622, owner decision G): a provider written outside the
 * repository, built against the packed SDK alone, is admitted by a built Studio with no change to Studio's files; its
 * engine answers a statement through Studio's API with the provider's rows; the text bound of the statement language
 * the provider states as data refuses a longer statement before it is sent; and one changed byte of the installed
 * package is refused at the next boot while Studio keeps running.
 *
 * The provider is the fixture under tests/fixtures/out-of-tree-provider/, a template that is copied and never imported
 * or built in place. This script holds no knowledge of it: the engine id, the package identity, the connection, the
 * statements and the rows each statement must answer, the statement language's name and text bound, and the
 * statements at and over that bound are read from the fixture's package.json, its manifest and its acceptance.json, so
 * step 8 can assert that neither an engine id of the fixture nor its language's name is named under Studio's source,
 * this script included.
 *
 * The nine steps, each asserting its own output, so a missing provider can never pass as "no rows":
 * 1. Build Studio's standalone output (`DOCKER_BUILD=true bun run build`, credentials for build-time page data drawn
 *    at run time), or take an existing one with `--standalone <dir>`; assert its server.js and .next and print its
 *    BUILD_ID.
 * 2. Pack the SDK with `bun run sdk:pack -- --out <tmp>/sdk`; assert the one absolute .tgz path it printed.
 * 3. Copy the fixture to <tmp>/provider and install the SDK tarball there with npm; assert that the installed SDK is
 *    the packed one (a directory of its own whose calls entry points under dist/, at the repository SDK's version).
 *    Run the fixture's own build once for evidence, `bun run --shell=bun build -- --outdir <tmp>/evidence --metafile
 *    <tmp>/bundle-meta.json`, and assert from the metafile that the build read the entry's source acceptance.json
 *    names, that every input lies inside the package's directory, that the SDK came from its packed dist/, and that
 *    the bundle imports only `node:` built-ins. Then run Studio's pack step over <tmp>/provider, `bun
 *    scripts/providers-pack.ts --out <tmp>/providers <tmp>/provider`, which runs the same build and places the
 *    artifact as <tmp>/providers/<name>/<version>/; assert its one line and digest, that the artifact holds exactly
 *    package.json, the manifest and the bundle, and that the bundle equals the evidence build's byte for byte, so the
 *    metafile describes what the pack placed. The metafile stays outside the artifact: written into `--outdir` it
 *    would carry the pack's temporary directory name and change the artifact's digest on every pack.
 * 4. Build the lock command's Node.js module as `build:lib` and each image's builder build it (`buildLockModule` in
 *    scripts/build-lock-module.mjs) into <tmp>/lock, copy the image's `libredb-studio` wrapper
 *    (docker/libredb-studio.mjs) beside it, and run `node <tmp>/lock/libredb-studio.mjs providers lock --dir
 *    <tmp>/providers` under the Node.js on PATH; assert the lock line of the one package, with the digest the pack
 *    step printed.
 * 5. Start the standalone server with LIBREDB_PROVIDERS_DIR set, sign in through the API, save a connection of the
 *    fixture engine (`POST /api/db/test-connection`, what the connection dialog's Save posts), run each statement of
 *    acceptance.json (`POST /api/db/query`) and assert its rows, in order, each answer marked unconfirmed, and that an
 *    explain request is refused by name, 400 FACET_NOT_OFFERED, not-sent. The fixture states no SQL text, so no
 *    register row reviews a grammar of its engine, the confirmation gate asks about every statement of its engine, and
 *    the default advisory mode runs a request that sends no confirmation field and marks its answer unconfirmed. The
 *    statement acceptance.json lists as refused, which the fixture refuses in its own words, is answered with Studio's
 *    sentence naming its code and holds none of the package's words (clause C-112).
 * 6. Start the server again on a data directory of its own, sign in, save the connection, and send the two statements
 *    of acceptance.json's `textBound`: first one a byte over the text bound the fixture's own statement language
 *    states (`confirmation.maxTextBytes` of the engine's `statementLanguageData`), then one at the bound. No register
 *    row names the fixture, so its language is granted nothing, but the query route reads the bound from the engine
 *    record's language row whatever its grants. Assert that the statement over the bound is answered 413 with the
 *    sentence acceptance.json names, which names the bound and the size, with no rows and none of the statement's
 *    words, and that the statement at the bound answers its rows marked unconfirmed. Then, once the server stopped and
 *    its output is complete, assert that it logged the confirmation gate's line for a statement run unconfirmed
 *    (`STUDIO.unconfirmedRunLine`) exactly once for the engine, the statement at the bound's: the statement over it
 *    never reached the gate, so it never reached the package.
 * 7. Change the bundle's final byte, its newline, to a space (the module stays valid, so only the digest check can
 *    refuse it), restart, and assert that Studio boots, logs PROVIDER_DIGEST_MISMATCH for the package, and answers
 *    PROVIDER_UNAVAILABLE for the save and the statement. It runs after every step that needs the admitted package.
 * 8. Assert `git status --porcelain` is empty and that neither an engine id of the fixture nor its statement
 *    language's name appears, in any letter case, in a file under src, bin, scripts or vscode-extension/src (the
 *    isolation ratchet's core roots) or packages.
 * 9. Run the build output check (scripts/check-build-output.ts) over the standalone and <tmp>/provider, the package
 *    the pack step packed: no file under the standalone's .next or node_modules equals a file of the package's source
 *    or of a driver it declares, or holds its name. Then assert that no file under .next, the server's build output,
 *    equals a fixture file or holds the package name, an engine id as a quoted literal or an engine's display name.
 *
 * The SDK installs offline. `npm install <sdk tarball>` alone would fetch the SDK's dependency, ajv, from a registry;
 * the run instead packs the closure of the SDK's declared `dependencies` from the repository's own install, found as
 * Node finds a package directory from packages/provider-sdk, and installs those tarballs beside the SDK's, with every
 * npm call offline, on its own empty cache and configs and an empty HOME (the route of the SDK's pack test,
 * packages/provider-sdk/tests/pack.test.ts). So the run fails only for reasons inside the repository, installs no
 * unpinned code, and reproduces without a network. Whether the SDK's declared range resolves from a public registry
 * is a publishing concern this run does not prove.
 *
 * The working tree must be clean before step 1, so step 8 measures this run alone: a dirty tree is refused by name
 * before the build. The temporary root, created under the system temporary directory, must lie outside the
 * repository with no node_modules above it, so nothing resolves from Studio's install. Its layout: sdk/ (the SDK
 * tarball), deps/ (the closure's tarballs), npm/ (npm's cache, configs and HOME), provider/ (the copied fixture and
 * its install), evidence/ (the evidence build's output, beside bundle-meta.json, its metafile), pack/ (the pack
 * step's temporary directories), providers/ (the packed package and its lock), lock/ (the built lock module and the
 * wrapper), server/ (each server's HOME and data directory).
 *
 * Every child gets an explicit environment, never the caller's: PATH, HOME and what its step names, never
 * NODE_OPTIONS, NODE_PATH or an npm_config variable. The fixture's build takes esbuild from PATH, so the evidence
 * build and the pack step get the caller's PATH with one directory before it, the directory of the repository's
 * esbuild launcher, which must hold the launcher alone. The pack step runs as its script file, never as `bun run
 * providers:pack`, which would put the repository's node_modules/.bin, every tool of Studio's install, on the build's
 * PATH unseen. Every child runs as the leader of its own process group, under a timeout (CHILD_TIMEOUTS_MS) that
 * sends SIGTERM to the group and SIGKILL five seconds later; an interrupted run kills every group it started, and only
 * those. The server binds 127.0.0.1 on a port the system just handed out and
 * takes a JWT secret and passwords drawn at run time. The run stops children by process group, so it is POSIX only
 * and refuses Windows by name.
 *
 * Output: one line per step, `ok   step N <title>: <evidence>` or `FAIL step N <title>: <reason>` followed by the
 * captured output, and no later step. A pass removes the temporary root and ends with
 * `out-of-tree acceptance passed: 9 of 9 steps`, exit 0; a failure keeps the root, prints its path, and exits 1.
 *
 * CI runs it in the "Out-of-tree Provider Acceptance" job of .github/workflows/ci.yml against the engine smoke
 * payload, extracted under the runner's temporary directory. Its logic is held by
 * tests/unit/scripts/out-of-tree-acceptance.test.ts.
 *
 * Local run, from a clean tree (one Next.js build and three server starts):
 *   heavy bun scripts/out-of-tree-acceptance.ts [--standalone <dir>]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { SESSION_COOKIE } from "../src/lib/auth-cookies";
import { buildLockModule } from "./build-lock-module.mjs";
import { regularFiles, scanProblems, standaloneTrees } from "./check-build-output";
import { ancestorNodeModules } from "./check-lib-load.mjs";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const FIXTURE_DIRECTORY = path.join(REPO_ROOT, "tests", "fixtures", "out-of-tree-provider");
const SDK_DIRECTORY = path.join(REPO_ROOT, "packages", "provider-sdk");

const USAGE = "Usage: heavy bun scripts/out-of-tree-acceptance.ts [--standalone <dir>]";

/**
 * Studio's side of the run, every interface the run relies on in one place: the pack step, the lock command's wrapper
 * and module and the lock file, the build output check, the manifest file a package carries, the providers directory's
 * variable, the refusal and answer codes, the session cookie, the admin's sign-in, the routes, and the line the
 * confirmation gate logs for each statement it lets run unconfirmed. The predicates beside it (`refusalLines`,
 * `unavailableProblems`, `notOfferedProblems`, `rowsProblems`, `unconfirmedProblems`, `saveProblems`,
 * `textBoundProblems`, `gateLineProblems`) read the answers and the server's output.
 */
export const STUDIO = Object.freeze({
  packScript: "scripts/providers-pack.ts",
  lockWrapper: "docker/libredb-studio.mjs",
  lockModule: "providers-lock.mjs",
  buildCheckScript: "scripts/check-build-output.ts",
  lockFile: "providers.lock.json",
  manifestFile: "libredb-provider.json",
  providersDirVariable: "LIBREDB_PROVIDERS_DIR",
  digestMismatch: "PROVIDER_DIGEST_MISMATCH",
  unavailable: "PROVIDER_UNAVAILABLE",
  notOffered: "FACET_NOT_OFFERED",
  sessionCookie: SESSION_COOKIE,
  adminEmail: "admin@libredb.org",
  unconfirmedRunLine: "A statement that needs a confirmation ran without one",
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
  providerBuild: 2 * 60_000,
  pack: 3 * 60_000,
  lock: 2 * 60_000,
  buildCheck: 5 * 60_000,
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

/** The acceptance's nine steps, in order. */
export const STEP_TITLES = Object.freeze([
  "build Studio's standalone output",
  "pack the SDK",
  "pack the fixture provider outside the repository against the packed SDK",
  "lock the provider package with the Node.js lock module",
  "query the fixture engine through Studio's API",
  "refuse a statement over the text bound of the fixture's own statement language",
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

/** The problems with a step list: anything but the acceptance's steps, numbered from 1, in order, with their titles. */
export function stepListProblems(steps: readonly Pick<Step, "number" | "title">[]): string[] {
  const problems: string[] = [];
  if (steps.length !== STEP_TITLES.length) {
    problems.push(`the run holds ${steps.length} steps, not the acceptance's ${STEP_TITLES.length}`);
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
 * the exit code, 0 only when every step passed. A list that is not the acceptance's steps runs none of them.
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

/**
 * A statement the fixture's provider refuses in its own words, `packageWords`, and what Studio answers for it: the
 * error `code` and Studio's `sentence` naming it.
 */
export interface Refusal {
  readonly statement: string;
  readonly packageWords: string;
  readonly code: string;
  readonly sentence: string;
}

/** The statement one byte over the language's text bound, and the sentence Studio refuses it with. */
export interface OverBound {
  readonly statement: string;
  readonly sentence: string;
}

/**
 * The fixture as the run reads it: its package identity, its engines, its statement language's name and text bound,
 * its bundle's path and its expectations.
 */
export interface Fixture {
  readonly name: string;
  readonly version: string;
  readonly engines: readonly { readonly id: string; readonly displayName: string }[];
  /** The engine's own statement language: its `statementLanguageData` name and `confirmation.maxTextBytes`. */
  readonly language: { readonly name: string; readonly maxTextBytes: number };
  /** The manifest's `runtime.entry`, where the bundle is written. */
  readonly entry: string;
  readonly acceptance: {
    /** The entry's source, which the fixture's build bundles; step 3 asserts the build read it. */
    readonly entrySource: string;
    /** The connection's own fields, beside the id and the engine's type the run adds. */
    readonly connection: Readonly<Record<string, unknown>>;
    readonly statements: readonly Expectation[];
    readonly refused: Refusal;
    /** Step 6's statements: one at the language's text bound, which answers, and one a byte over it, refused. */
    readonly textBound: { readonly atBound: Expectation; readonly overBound: OverBound };
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

/** One statement of acceptance.json, `where` naming it, with at least one row of its columns' length. */
function expectation(item: unknown, where: string): Expectation {
  if (!isRecord(item) || !isText(item.statement)) throw new Error(`${where} has no statement text`);
  const { columns, rows } = item;
  if (!Array.isArray(columns) || columns.length === 0 || !columns.every(isText)) {
    throw new Error(`${where} names no columns`);
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${where} expects no row`);
  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new Error(`${where} row ${rowIndex + 1} does not hold one value for each of its ${columns.length} columns`);
    }
  });
  return { statement: item.statement, columns, rows };
}

/** The statements of acceptance.json, each with at least one row of its columns' length. */
function expectations(value: unknown, file: string): Expectation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${file} holds no statement`);
  return value.map((item, index) => expectation(item, `${file} statement ${index + 1}`));
}

/** The size of `text` in UTF-8 bytes, as the query route counts a statement against its language's text bound. */
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Step 6's statements of acceptance.json, refused when step 6 could prove nothing with them: an at-bound statement
 * that is no expectation or whose UTF-8 size is not `bound`; an over-bound statement with no statement or sentence
 * text, whose UTF-8 size is not one more than `bound`, whose UTF-16 length is over `bound` (a route counting UTF-16
 * units would refuse it alike, so it could not tell bytes from units), or whose sentence does not name the size and
 * the bound as whole numbers.
 */
function textBound(value: unknown, bound: number, file: string): Fixture["acceptance"]["textBound"] {
  if (!isRecord(value)) throw new Error(`${file} holds no textBound object`);
  const atBound = expectation(value.atBound, `${file} textBound.atBound`);
  const atBytes = utf8Bytes(atBound.statement);
  if (atBytes !== bound) {
    throw new Error(`${file} textBound.atBound is ${atBytes} bytes in UTF-8, not the language's bound of ${bound}`);
  }
  const over = value.overBound;
  const where = `${file} textBound.overBound`;
  if (!isRecord(over) || !isText(over.statement)) throw new Error(`${where} has no statement text`);
  if (!isText(over.sentence)) throw new Error(`${where} has no sentence text`);
  const overBytes = utf8Bytes(over.statement);
  if (overBytes !== bound + 1) {
    throw new Error(`${where} is ${overBytes} bytes in UTF-8, not one more than the language's bound of ${bound}`);
  }
  if (over.statement.length > bound) {
    throw new Error(
      `${where} is ${over.statement.length} UTF-16 units, over the bound of ${bound}, so it cannot tell UTF-8 bytes from UTF-16 units`,
    );
  }
  const words = wordsOf(over.sentence);
  if (!words.includes(String(bound + 1)) || !words.includes(String(bound))) {
    throw new Error(`${where}'s sentence does not name ${bound + 1} and ${bound} as whole numbers`);
  }
  return { atBound, overBound: { statement: over.statement, sentence: over.sentence } };
}

/**
 * The engine's own statement language: its `statementLanguageData` name and the text bound its confirmation part
 * states, refused when there is none, since step 6 proves nothing without them.
 */
function languageOf(engine: Record<string, unknown>, manifestFile: string): Fixture["language"] {
  const data = engine.statementLanguageData;
  if (!isRecord(data) || !isText(data.name)) {
    throw new Error(`${manifestFile} states no statement language data with a name, so step 6 proves nothing`);
  }
  const confirmation = data.confirmation;
  const maxTextBytes = isRecord(confirmation) ? confirmation.maxTextBytes : undefined;
  if (typeof maxTextBytes !== "number" || !Number.isInteger(maxTextBytes) || maxTextBytes <= 0) {
    throw new Error(`${manifestFile}'s statement language ${data.name} states no text bound, so step 6 proves nothing`);
  }
  return { name: data.name, maxTextBytes };
}

/**
 * The refused statement of acceptance.json, refused when step 5 could prove nothing with it: a member that is no
 * non-empty text, a sentence that does not name its code as a whole word, package words sharing a word with Studio's
 * sentence (the words check could never pass), or a statement that is one of `statements`, which answer rows.
 */
function refusal(value: unknown, statements: readonly Expectation[], file: string): Refusal {
  if (!isRecord(value)) throw new Error(`${file} holds no refused statement object`);
  const text = (member: keyof Refusal): string => {
    const found = value[member];
    if (!isText(found)) throw new Error(`${file} refused statement has no ${member} text`);
    return found;
  };
  const refused: Refusal = {
    statement: text("statement"),
    packageWords: text("packageWords"),
    code: text("code"),
    sentence: text("sentence"),
  };
  const studioWords = wordsOf(refused.sentence);
  if (!studioWords.includes(refused.code.toLowerCase())) {
    throw new Error(`${file} refused statement's sentence does not name its code ${refused.code}`);
  }
  const shared = [...new Set(wordsOf(refused.packageWords))].filter((word) => studioWords.includes(word)).sort();
  if (shared.length > 0) {
    throw new Error(
      `${file} refused statement's package words share words with Studio's sentence: ${shared.join(", ")}`,
    );
  }
  if (statements.some((expected) => expected.statement === refused.statement)) {
    throw new Error(`${file} refused statement "${refused.statement}" is one of its statements, which answer rows`);
  }
  return refused;
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
  const language = languageOf(engine, manifestFile);

  const acceptanceFile = path.join(directory, "acceptance.json");
  const acceptance = jsonObject(read(acceptanceFile), acceptanceFile);
  if (!isText(acceptance.entrySource)) throw new Error(`${acceptanceFile} names no entrySource`);
  if (!isRecord(acceptance.connection)) throw new Error(`${acceptanceFile} holds no connection object`);
  const statements = expectations(acceptance.statements, acceptanceFile);

  return {
    name: pkg.name,
    version: pkg.version,
    engines: [{ id: engine.id, displayName: engine.displayName }],
    language,
    entry: runtime.entry,
    acceptance: {
      entrySource: acceptance.entrySource,
      connection: acceptance.connection,
      statements,
      refused: refusal(acceptance.refused, statements, acceptanceFile),
      textBound: textBound(acceptance.textBound, language.maxTextBytes, acceptanceFile),
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
 * The problems with a bundle, from esbuild's metafile, whose paths are relative to the package's directory: an input
 * outside that directory, no input from the packed SDK's dist/, no read of `entrySource`, or an import of the output
 * `outfile` other than a `node:` built-in.
 */
export function bundleProblems(metafile: unknown, outfile: string, entrySource: string): string[] {
  const meta = isRecord(metafile) ? metafile : {};
  const inputs = Object.keys(isRecord(meta.inputs) ? meta.inputs : {});
  const problems = inputs
    .filter((input) => path.isAbsolute(input) || input.split(/[\\/]/)[0] === "..")
    .map((input) => `the bundle read ${input}, outside the build directory`);
  if (!inputs.includes(entrySource)) {
    problems.push(`the bundle did not read ${entrySource}, the entry's source acceptance.json names`);
  }
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

/** The non-empty lines of a child's standard output, each with its line end trimmed. */
const outputLines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

/** The line a lock or pack prints for package `name` `version`: the two, then `sha256:` and 64 hex digits. */
const packageLine = (name: string, version: string): RegExp =>
  new RegExp(`^${escapeRegExp(name)} ${escapeRegExp(version)} sha256:[0-9a-f]{64}$`);

/**
 * The problems with the lock command's output: it must name the lock file, then the one package and its digest, which
 * must be `digest`, the one the pack step printed.
 */
export function lockOutputProblems(
  stdout: string,
  lockFile: string,
  name: string,
  version: string,
  digest: string,
): string[] {
  const lines = outputLines(stdout);
  const problems: string[] = [];
  if (lines[0] !== `Wrote ${lockFile}`) problems.push(`the lock command's first line is not "Wrote ${lockFile}"`);
  const line = lines[1] as string;
  if (lines.length !== 2 || !packageLine(name, version).test(line)) {
    problems.push(`the lock command did not print exactly one line "${name} ${version} sha256:<64 hex digits>"`);
  } else if (line !== `${name} ${version} ${digest}`) {
    problems.push(
      `the lock command locked ${name} ${version} as ${line.split(" ").at(-1)}, not as ${digest}, the digest the pack step printed`,
    );
  }
  return problems.length === 0 ? [] : [...problems, `it printed: ${JSON.stringify(lines)}`];
}

/** The problems with the pack step's output: exactly one line, the package and its digest. */
export function packOutputProblems(stdout: string, name: string, version: string): string[] {
  const lines = outputLines(stdout);
  return lines.length === 1 && packageLine(name, version).test(lines[0] as string)
    ? []
    : [
        `the pack step did not print exactly one line "${name} ${version} sha256:<64 hex digits>"; it printed: ${JSON.stringify(lines)}`,
      ];
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

/**
 * The problems with a statement's answer on the fixture's engine: it must be marked `confirmation: "unconfirmed"`, the
 * mark the advisory mode puts on a request the confirmation gate asked about and that sent no confirmation field.
 */
export function unconfirmedProblems(answer: Answer, expected: Expectation): string[] {
  return answer.body.confirmation === "unconfirmed"
    ? []
    : [
        `"${expected.statement}" answered without the mark confirmation: "unconfirmed", so the gate did not ask about it`,
      ];
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

/**
 * The problems with an answer to a request field the engine's record does not offer: the status 400, the code
 * FACET_NOT_OFFERED exactly, the outcome `not-sent`, and a sentence naming `field` as a whole word, so the refusal is
 * the one read from the record and no other.
 */
export function notOfferedProblems(answer: Answer, field: string): string[] {
  const problems: string[] = [];
  if (answer.status !== 400) problems.push(`answered ${answer.status}, not 400`);
  if (answer.body.code !== STUDIO.notOffered) {
    problems.push(`answered code ${JSON.stringify(answer.body.code)}, not ${STUDIO.notOffered}`);
  }
  if (answer.body.outcome !== "not-sent") {
    problems.push(`answered outcome ${JSON.stringify(answer.body.outcome)}, not not-sent`);
  }
  if (!new RegExp(`\\b${escapeRegExp(field)}\\b`).test(String(answer.body.error))) {
    problems.push(`answered a sentence naming no ${field}`);
  }
  return problems.length === 0 ? [] : [...problems, `body: ${JSON.stringify(answer.body).slice(0, 500)}`];
}

/**
 * The words of `text`: its maximal runs of letters, digits, underscores and apostrophes, lower-cased, so `package's`
 * and `INTERNAL_ERROR` are one word each.
 */
export function wordsOf(text: string): string[] {
  return (text.match(/[\p{L}\p{N}_']+/gu) ?? []).map((word) => word.toLowerCase());
}

/** Every key and every scalar value of `value`, a JSON value, as text, so a word is read where it stands. */
function textsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (isRecord(value)) return Object.entries(value).flatMap(([key, member]) => [key].concat(textsOf(member)));
  return [String(value)];
}

/**
 * The problems with the answer to the refused statement, which the fixture's provider refuses in its own words (clause
 * C-112): an error status, the code acceptance.json names exactly, Studio's sentence naming it exactly, and none of the
 * package's words anywhere in the body, each key and value read word by word.
 */
export function refusedProblems(answer: Answer, refused: Refusal): string[] {
  const quoted = `"${refused.statement}" answered`;
  const problems: string[] = [];
  if (answer.status < 400) problems.push(`${quoted} ${answer.status}, not an error status`);
  if (answer.body.code !== refused.code) {
    problems.push(`${quoted} code ${JSON.stringify(answer.body.code)}, not ${refused.code}`);
  }
  if (answer.body.error !== refused.sentence) {
    problems.push(
      `${quoted} the sentence ${JSON.stringify(answer.body.error)}, not Studio's sentence naming ${refused.code}`,
    );
  }
  const answered = new Set(textsOf(answer.body).flatMap(wordsOf));
  const own = [...new Set(wordsOf(refused.packageWords))].filter((word) => answered.has(word));
  if (own.length > 0) problems.push(`${quoted} the package's own words: ${own.join(", ")}`);
  return problems.length === 0 ? [] : [...problems, `body: ${JSON.stringify(answer.body).slice(0, 500)}`];
}

/**
 * The problems with the answer to the statement one byte over the language's text bound, refused before it is sent:
 * the status 413, the sentence acceptance.json names exactly, a sentence naming the bound as a whole word, no rows,
 * and none of the statement's own words anywhere in the body, each key and value read word by word.
 */
export function textBoundProblems(answer: Answer, overBound: OverBound, bound: number): string[] {
  const quoted = "the statement over the bound answered";
  const problems: string[] = [];
  if (answer.status !== 413) problems.push(`${quoted} ${answer.status}, not 413`);
  if (answer.body.error !== overBound.sentence) {
    problems.push(
      `${quoted} the sentence ${JSON.stringify(answer.body.error)}, not Studio's sentence naming the bound`,
    );
  }
  if (!wordsOf(String(answer.body.error ?? "")).includes(String(bound))) {
    problems.push(`${quoted} a sentence naming no bound of ${bound} bytes`);
  }
  if (answer.body.rows !== undefined) problems.push(`${quoted} rows`);
  const answered = new Set(textsOf(answer.body).flatMap(wordsOf));
  const own = [...new Set(wordsOf(overBound.statement))].filter((word) => answered.has(word));
  if (own.length > 0) problems.push(`${quoted} its own words: ${own.join(", ")}`);
  return problems.length === 0 ? [] : [...problems, `body: ${JSON.stringify(answer.body).slice(0, 500)}`];
}

/**
 * The problems with step 6's server output, read complete once the server stopped: the confirmation gate's line for a
 * statement run unconfirmed (`STUDIO.unconfirmedRunLine`), logged with the context key `type=<engine id>`, must appear
 * exactly once for `engineId`, the statement at the bound's. A second line means the statement over the bound reached
 * the gate, and so the package; none means the statement at the bound never did.
 */
export function gateLineProblems(output: string, engineId: string): string[] {
  const engine = new RegExp(`[{,\\s]type=${escapeRegExp(engineId)}[,}]`);
  const count = output
    .split("\n")
    .filter((line) => line.includes(STUDIO.unconfirmedRunLine) && engine.test(line)).length;
  if (count === 1) return [];
  return [
    count === 0
      ? `the statement at the bound never reached the confirmation gate: the server logged no "${STUDIO.unconfirmedRunLine}" for ${engineId}`
      : `the statement over the bound reached the confirmation gate: the server logged "${STUDIO.unconfirmedRunLine}" ${count} times for ${engineId}, not once for the statement at the bound`,
  ];
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

/**
 * The files step 9's own scan reads: every regular file under the standalone's .next. A link there is judged by the
 * build output check's rule over the trees that check reads, the standalone's .next and node_modules: Turbopack's
 * hashed alias of an external package, `.next/node_modules/<package>-<hash>`, points into node_modules, which the build
 * output check run first in the same step reads, so it is accepted and not followed; a link leaving both, or dangling,
 * raises an error naming the link and its target.
 */
export function buildScanFiles(standalone: string): string[] {
  return regularFiles(path.join(standalone, ".next"), { within: standaloneTrees(standalone) });
}

/** The roots step 8 scans for the fixture's engine ids and its statement language's name, relative to the repository root. */
export const NAMING_SCAN_ROOTS: readonly string[] = Object.freeze([...STUDIO.coreRoots, "packages"]);

/** Every regular file under each of `NAMING_SCAN_ROOTS` in `repositoryRoot`, as `regularFiles` lists them. */
export function namingScanFiles(repositoryRoot: string): string[] {
  return NAMING_SCAN_ROOTS.flatMap((root) => regularFiles(path.join(repositoryRoot, root)));
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

/**
 * The directory of the repository's esbuild launcher, `launcher`, which the fixture's build finds on PATH; refused
 * when the directory holds anything but the launcher, so the build's PATH gains exactly one tool.
 */
export function esbuildLauncherDirectory(
  launcher: string,
  list: (directory: string) => readonly string[] = (directory) => readdirSync(directory),
): string {
  const directory = path.dirname(launcher);
  const entries = [...list(directory)].sort();
  if (entries.length !== 1 || entries[0] !== path.basename(launcher)) {
    throw new Error(`${directory} holds ${entries.join(", ")}, not ${path.basename(launcher)} alone`);
  }
  return directory;
}

/** What the fixture's build and the pack step are given: the launcher's directory before the caller's PATH, and HOME. */
interface ToolInput {
  readonly launcherDirectory: string;
  readonly callerPath: string;
  readonly home: string;
}

/** The caller's PATH with the launcher's directory before it. */
const toolPath = (input: ToolInput): string => `${input.launcherDirectory}${path.delimiter}${input.callerPath}`;

/** Step 3's evidence build: the fixture's own build in `provider`, writing into `evidence` and its metafile. */
export function evidenceBuildSpec(
  input: ToolInput & { readonly provider: string; readonly evidence: string; readonly metafile: string },
): ChildSpec {
  return childSpec(
    "the fixture's build",
    [process.execPath, "run", "--shell=bun", "build", "--", "--outdir", input.evidence, "--metafile", input.metafile],
    input.provider,
    { PATH: toolPath(input), HOME: input.home },
    CHILD_TIMEOUTS_MS.providerBuild,
  );
}

/**
 * Step 3's pack: Studio's pack step run as its script file over `provider` into `providers`, its temporary
 * directories under `packTemporary` (TMPDIR, which it takes as its temporary root).
 */
export function packSpec(
  input: ToolInput & { readonly provider: string; readonly providers: string; readonly packTemporary: string },
): ChildSpec {
  return childSpec(
    "the pack step",
    [process.execPath, path.join(REPO_ROOT, STUDIO.packScript), "--out", input.providers, input.provider],
    REPO_ROOT,
    { PATH: toolPath(input), HOME: input.home, TMPDIR: input.packTemporary },
    CHILD_TIMEOUTS_MS.pack,
  );
}

/** What `placeLockModule` placed. */
export interface PlacedLockModule {
  readonly wrapper: string;
  readonly module: string;
  readonly inputs: number;
  readonly bytes: number;
}

/**
 * Builds the lock command's Node.js module into `lockDirectory` with `buildLockModule`, the function `build:lib` and
 * each image's builder run, and copies the image's wrapper beside it, the image's layout: the wrapper imports
 * `./providers-lock.mjs`. Nothing is written into the repository.
 */
export async function placeLockModule(lockDirectory: string): Promise<PlacedLockModule> {
  mkdirSync(lockDirectory, { recursive: true });
  const built = await buildLockModule({ outfile: path.join(lockDirectory, STUDIO.lockModule) });
  const wrapper = path.join(lockDirectory, path.basename(STUDIO.lockWrapper));
  copyFileSync(path.join(REPO_ROOT, STUDIO.lockWrapper), wrapper);
  return { wrapper, module: built.outfile, inputs: built.inputs.length, bytes: statSync(built.outfile).size };
}

/** Step 4's lock: the wrapper beside the built module, run by `node` over `providers`. */
export function lockSpec(input: {
  readonly node: string;
  readonly lockDirectory: string;
  readonly providers: string;
  readonly callerPath: string;
  readonly home: string;
}): ChildSpec {
  const wrapper = path.join(input.lockDirectory, path.basename(STUDIO.lockWrapper));
  return childSpec(
    "the lock module",
    [input.node, "--max-old-space-size=512", wrapper, "providers", "lock", "--dir", input.providers],
    input.lockDirectory,
    { PATH: input.callerPath, HOME: input.home },
    CHILD_TIMEOUTS_MS.lock,
  );
}

/** Step 9's build output check over `standalone` and `provider`, the package the pack step packed. */
export function buildCheckSpec(input: {
  readonly standalone: string;
  readonly provider: string;
  readonly callerPath: string;
  readonly home: string;
}): ChildSpec {
  return childSpec(
    "the build output check",
    [process.execPath, path.join(REPO_ROOT, STUDIO.buildCheckScript), "--standalone", input.standalone, input.provider],
    REPO_ROOT,
    { PATH: input.callerPath, HOME: input.home },
    CHILD_TIMEOUTS_MS.buildCheck,
  );
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
async function signIn(server: Server, secret: string): Promise<string> {
  const answer = await postJson(server, STUDIO.routes.signIn, { email: STUDIO.adminEmail, password: secret }, null);
  return sessionCookie(answer.status, answer.setCookies);
}

/**
 * Runs `work` on a server started with `env`, always stopping it. When `stopped` is given, it then judges the work's
 * answer and the server's output, complete once the server exited, and answers in its place. A failure of either
 * carries the server's output.
 */
async function withServer<T>(
  standalone: string,
  env: Record<string, string>,
  port: number,
  work: (server: Server) => Promise<T>,
  stopped?: (answer: T, output: string) => T,
): Promise<T> {
  const server = startServer(standalone, env, port);
  try {
    await ready(server);
    const answer = await work(server);
    if (stopped === undefined) return answer;
    await stopServer(server);
    return stopped(answer, server.output());
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
// The nine steps.

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
  digest?: string;
}

/** A value an earlier step left, refused by name when it did not. */
function earlier<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no earlier step left ${what}`);
  return value;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * An empty directory npm, the fixture's build, the pack step and the lock module use as HOME, so no user configuration
 * reaches them.
 */
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

async function packProvider(ctx: Context): Promise<string> {
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

  const { fixture } = ctx;
  const tools = {
    launcherDirectory: esbuildLauncherDirectory(createRequire(import.meta.url).resolve("esbuild/bin/esbuild")),
    callerPath: ctx.callerPath,
    home: emptyHome(ctx),
  };
  const evidence = path.join(ctx.temp, "evidence");
  const metafile = path.join(ctx.temp, "bundle-meta.json");
  const built = await runOk(evidenceBuildSpec({ ...tools, provider, evidence, metafile }));
  const meta = JSON.parse(readFileSync(metafile, "utf8")) as unknown;
  const outputKey = path.relative(provider, path.join(evidence, fixture.entry)).split(path.sep).join("/");
  assertNone(bundleProblems(meta, outputKey, fixture.acceptance.entrySource), built.output);
  const inputs = Object.keys((meta as { inputs: object }).inputs).length;

  const providers = path.join(ctx.temp, "providers");
  const packTemporary = path.join(ctx.temp, "pack");
  mkdirSync(providers);
  mkdirSync(packTemporary);
  const packed = await runOk(packSpec({ ...tools, provider, providers, packTemporary }));
  assertNone(packOutputProblems(packed.stdout, fixture.name, fixture.version), packed.output);
  const digest = outputLines(packed.stdout)[0]?.split(" ").at(-1) as string;
  const artifact = path.join(providers, ...fixture.name.split("/"), fixture.version);
  const files = regularFiles(artifact).map((file) => path.relative(artifact, file).split(path.sep).join("/"));
  assertNone(artifactProblems(files, fixture.entry));
  const bundle = readFileSync(path.join(artifact, fixture.entry));
  if (!bundle.equals(readFileSync(path.join(evidence, fixture.entry)))) {
    throw new Error(
      `the packed ${fixture.entry} differs from the evidence build's, so the metafile does not describe it`,
    );
  }
  ctx.artifact = artifact;
  ctx.providers = providers;
  ctx.digest = digest;
  const closureNames = closureTarballs.map((file) => path.basename(file, ".tgz")).join(", ");
  return `SDK ${sdkManifest.version} installed offline with ${closureNames}; the fixture's build read ${inputs} inputs, the SDK from its packed dist/, into a bundle importing only node: built-ins; the pack step placed ${path.relative(ctx.temp, artifact)} as ${digest}, its ${fixture.entry} of ${bundle.length} bytes equal to the evidence build's`;
}

async function lockProvider(ctx: Context): Promise<string> {
  const { fixture } = ctx;
  const providers = earlier(ctx.providers, "the providers directory");
  const digest = earlier(ctx.digest, "the pack step's digest");
  const lockDirectory = path.join(ctx.temp, "lock");
  const placed = await placeLockModule(lockDirectory);
  const node = Bun.which("node", { PATH: ctx.callerPath });
  if (node === null) throw new Error("no node on PATH: step 4 runs the lock module under Node.js");
  const env = { PATH: ctx.callerPath, HOME: emptyHome(ctx) };
  const version = await runOk(
    childSpec("node --version", [node, "--version"], lockDirectory, env, CHILD_TIMEOUTS_MS.lock),
  );
  const lock = await runOk(
    lockSpec({ node, lockDirectory, providers, callerPath: ctx.callerPath, home: emptyHome(ctx) }),
  );
  const lockFile = path.join(providers, STUDIO.lockFile);
  assertNone(lockOutputProblems(lock.stdout, lockFile, fixture.name, fixture.version, digest), lock.output);
  if (!lstatSync(lockFile).isFile()) throw new Error(`${lockFile} is not a regular file`);
  return `Node.js ${version.stdout.trim()} ran ${path.basename(placed.wrapper)} beside ${path.relative(ctx.temp, placed.module)} (${placed.bytes} bytes from ${placed.inputs} inputs): ${outputLines(lock.stdout).at(-1)}`;
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
      assertNone(unconfirmedProblems(answer, expected));
      answered.push(
        `${expected.statement} -> ${JSON.stringify(answer.body.rows)}, ${String(answer.body.confirmation)}`,
      );
    }
    // A statement the package refuses in its own words is answered with Studio's sentence naming its code.
    const { refused } = fixture.acceptance;
    const refusedAnswer = await postJson(server, STUDIO.routes.query, { connection, sql: refused.statement }, cookie);
    assertNone(refusedProblems(refusedAnswer, refused));
    answered.push(
      `"${refused.statement}" refused -> ${refusedAnswer.status} ${String(refusedAnswer.body.code)} ${JSON.stringify(refusedAnswer.body)}`,
    );
    // A field the engine's record does not offer is refused by name, read from the record.
    const first = (fixture.acceptance.statements[0] as Expectation).statement;
    const explain = { connection, sql: first, explain: { mode: "estimate" } };
    const explained = await postJson(server, STUDIO.routes.query, explain, cookie);
    assertNone(notOfferedProblems(explained, "explain").map((problem) => `the explain request ${problem}`));
    answered.push(`an explain request -> ${explained.status} ${JSON.stringify(explained.body)}`);
    return `engine ${connection.type} on 127.0.0.1:${port}, saved (${save.status} ${JSON.stringify(save.body)}) and answered: ${answered.join("; ")}`;
  });
}

/** A statement as step 6's evidence prints it: its text trimmed, and its size in UTF-8 bytes and UTF-16 units. */
const sizeOf = (statement: string): string =>
  `"${statement.trim()}" padded to ${utf8Bytes(statement)} UTF-8 bytes (${statement.length} UTF-16 units)`;

async function refuseOverBound(ctx: Context): Promise<string> {
  const { fixture } = ctx;
  const { language } = fixture;
  const { atBound, overBound } = fixture.acceptance.textBound;
  const engine = (fixture.engines[0] as Fixture["engines"][number]).id;
  const standalone = earlier(ctx.standalone, "a standalone build");
  const port = await freePort();
  return withServer(
    standalone,
    bootEnvironment(ctx, "language-boot", port),
    port,
    async (server) => {
      const cookie = await signIn(server, ctx.credentials.adminPassword);
      const connection = connectionOf(ctx);
      assertNone(saveProblems(await postJson(server, STUDIO.routes.save, { connection }, cookie)));
      // Over the bound first: the statement at the bound then shows the connection still answers after the refusal.
      const over = await postJson(server, STUDIO.routes.query, { connection, sql: overBound.statement }, cookie);
      assertNone(textBoundProblems(over, overBound, language.maxTextBytes));
      const at = await postJson(server, STUDIO.routes.query, { connection, sql: atBound.statement }, cookie);
      assertNone(rowsProblems(at, atBound));
      assertNone(unconfirmedProblems(at, atBound));
      return `language ${language.name} bounds a statement at ${language.maxTextBytes} UTF-8 bytes on engine ${engine}: ${sizeOf(overBound.statement)} -> ${over.status} ${JSON.stringify(over.body)}; ${sizeOf(atBound.statement)} -> ${JSON.stringify(at.body.rows)}, ${String(at.body.confirmation)}`;
    },
    (evidence, output) => {
      assertNone(gateLineProblems(output, engine));
      return `${evidence}; once the server stopped, its output held 1 "${STUDIO.unconfirmedRunLine}" line for ${engine}, the statement at the bound's`;
    },
  );
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
  const names = [...ctx.fixture.engines.map((engine) => engine.id), ctx.fixture.language.name];
  const files = namingScanFiles(REPO_ROOT);
  if (files.length === 0) throw new Error(`no file under ${NAMING_SCAN_ROOTS.join(", ")}`);
  const naming = filesNaming(files, names, (file) => readFileSync(file, "utf8"));
  assertNone(naming.map((file) => `${path.relative(REPO_ROOT, file)} names ${names.join(" or ")}`));
  return `git status --porcelain is empty; none of ${files.length} files under ${NAMING_SCAN_ROOTS.join(", ")} names ${names.join(", ")}`;
}

async function buildHoldsNoFixture(ctx: Context): Promise<string> {
  const standalone = earlier(ctx.standalone, "a standalone build");
  const checked = await runOk(
    buildCheckSpec({
      standalone,
      provider: path.join(ctx.temp, "provider"),
      callerPath: ctx.callerPath,
      home: emptyHome(ctx),
    }),
  );
  const build = path.join(standalone, ".next");
  const needles = buildNeedles(ctx.fixture);
  const digests = new Map(
    regularFiles(FIXTURE_DIRECTORY).map((file) => [
      sha256(readFileSync(file)),
      `the fixture's ${path.relative(FIXTURE_DIRECTORY, file).split(path.sep).join("/")}`,
    ]),
  );
  const files = buildScanFiles(standalone);
  assertNone(scanProblems(files, needles, digests));
  return `${outputLines(checked.stdout).join("; ")}; and none of ${files.length} files under ${build} equals a fixture file or holds ${needles.join(", ")}`;
}

/** The acceptance's nine steps over `ctx`. */
function buildSteps(ctx: Context): Step[] {
  const runs = [
    buildStandalone,
    packSdk,
    packProvider,
    lockProvider,
    queryEngine,
    refuseOverBound,
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
    console.error(`refused before the build: ${dirty.join("; ")}; step 8 asserts the run changes nothing`);
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
