/**
 * The build output check (scripts/check-build-output.ts): no file under a standalone build's `.next` or traced
 * `node_modules` equals a file of a provider package's source or of a driver it declares, or holds the package's name;
 * a driver a core module still imports is excepted only by a closed list naming its importer.
 *
 * Every planted root and standalone lives under the system's temporary directory, never under the repository's
 * packages/, where the isolation ratchet would count a planted `packages/provider-<id>/` as an engine. A link in a
 * planted package is a directory junction, which Windows creates without a privilege and POSIX treats as a symbolic
 * link, so that case runs on all three platforms; no file mode is asserted, and a child's lines are split on `\r?\n`,
 * since a Windows child ends them with CRLF.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as check from "../../../scripts/check-build-output";
import { providerPackageDirectories } from "../../../scripts/workspace-packages.mjs";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "check-build-output.ts");
const PACKAGE_NAME = "@libredb/provider-alpha";
const SOURCE_TEXT = 'export const source = "the alpha package\'s own source";\n';
const DRIVER_TEXT = 'exports.driver = "the alpha driver";\n';
const BETA_TEXT = 'exports.driver = "the beta driver";\n';

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "libredb-check-build-output-")));
let counter = 0;

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Writes `files` (relative path to text) under a new directory of the scratch root, and answers that directory. */
function planted(label: string, files: Readonly<Record<string, string>>): string {
  counter += 1;
  const directory = path.join(scratch, `${label}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return directory;
}

/**
 * A repository root holding packages/provider-alpha (its package.json declaring alpha-driver, and beta-driver too when
 * asked; its manifest; its source; an empty file; a file in its own node_modules) and alpha-driver and beta-driver in
 * the root's node_modules, alpha-driver with a nested node_modules of its own; plus `extra` files.
 */
function repository(options: { beta?: boolean; extra?: Readonly<Record<string, string>> } = {}): string {
  const dependencies: Record<string, string> = { "alpha-driver": "1.0.0" };
  if (options.beta === true) dependencies["beta-driver"] = "1.0.0";
  return planted("repository", {
    "package.json": `${JSON.stringify({ name: "planted-studio", private: true, workspaces: ["packages/*"] })}\n`,
    "packages/provider-alpha/package.json": `${JSON.stringify({ name: PACKAGE_NAME, version: "1.0.0", dependencies })}\n`,
    "packages/provider-alpha/libredb-provider.json": '{ "runtime": { "entry": "dist/index.mjs" } }\n',
    "packages/provider-alpha/src/index.ts": SOURCE_TEXT,
    "packages/provider-alpha/src/empty.ts": "",
    "packages/provider-alpha/node_modules/local-tool/index.js": "the package's own install\n",
    "node_modules/alpha-driver/package.json": `${JSON.stringify({ name: "alpha-driver", version: "1.0.0" })}\n`,
    "node_modules/alpha-driver/index.js": DRIVER_TEXT,
    "node_modules/alpha-driver/node_modules/nested-dep/index.js": "the driver's own dependency\n",
    "node_modules/beta-driver/package.json": `${JSON.stringify({ name: "beta-driver", version: "1.0.0" })}\n`,
    "node_modules/beta-driver/index.js": BETA_TEXT,
    ...options.extra,
  });
}

/** A standalone holding `.next` and `node_modules` with a clean file each, plus `files`. */
function standalone(files: Readonly<Record<string, string>> = {}): string {
  return planted("standalone", {
    ".next/server/chunks/core.js": "export const core = 1;\n",
    "node_modules/pg/index.js": "module.exports = {};\n",
    ...files,
  });
}

/** Runs the check over `repositoryRoot` and `standaloneDirectory`. */
function run(
  repositoryRoot: string,
  standaloneDirectory: string,
  options: { packageDirectories?: string[]; exceptions?: readonly check.CoreImportedDriver[]; chunkSize?: number } = {},
): check.CheckResult {
  return check.checkBuildOutput({
    repositoryRoot,
    standalone: standaloneDirectory,
    packageDirectories: options.packageDirectories ?? [],
    exceptions: options.exceptions ?? [],
    chunkSize: options.chunkSize,
  });
}

describe("the build output check", () => {
  test("a payload holding a file of a provider package or its driver fails by file", () => {
    const root = repository();
    const clean = run(root, standalone());
    expect(clean.problems).toEqual([]);

    const copied = standalone({ ".next/server/app/page.js": SOURCE_TEXT });
    expect(run(root, copied).problems).toEqual([
      `${path.join(copied, ".next", "server", "app", "page.js")} equals ${PACKAGE_NAME}'s src/index.ts`,
    ]);

    const traced = standalone({ "node_modules/alpha-driver/index.js": DRIVER_TEXT });
    expect(run(root, traced).problems).toEqual([
      `${path.join(traced, "node_modules", "alpha-driver", "index.js")} equals alpha-driver index.js, a driver ${PACKAGE_NAME} declares`,
    ]);

    // An empty file equals every empty file and identifies nothing; a file of the package's own node_modules or of the
    // driver's nested node_modules is no part of what the package declares.
    const unrelated = standalone({
      ".next/empty.js": "",
      "node_modules/local-tool/index.js": "the package's own install\n",
      "node_modules/nested-dep/index.js": "the driver's own dependency\n",
    });
    expect(run(root, unrelated).problems).toEqual([]);
  });

  test("a driver a core module still imports is excepted only by its listed importer", () => {
    const importer = "src/lib/uses-alpha.ts";
    const root = repository({
      beta: true,
      extra: {
        [importer]: 'import { driver } from "alpha-driver/sub";\nexport default driver;\n',
        "src/lib/other.ts": 'import { other } from "gamma";\nexport default other;\n',
        "tests/uses-alpha.ts": 'import { driver } from "alpha-driver";\nexport default driver;\n',
      },
    });
    const payload = standalone({ "node_modules/alpha-driver/index.js": DRIVER_TEXT });
    const copy = `${path.join(payload, "node_modules", "alpha-driver", "index.js")} equals alpha-driver index.js, a driver ${PACKAGE_NAME} declares`;

    expect(run(root, payload).problems).toEqual([copy]);
    const excepted = run(root, payload, { exceptions: [{ driver: "alpha-driver", importer }] });
    expect(excepted.problems).toEqual([]);
    expect(excepted.lines).toContain(`${PACKAGE_NAME}: alpha-driver not compared, since ${importer} imports it`);

    // A stale or misplaced entry is refused naming it, and nothing is compared.
    for (const [entry, why] of [
      [{ driver: "alpha-driver", importer: "src/lib/other.ts" }, "imports no module of alpha-driver"],
      [{ driver: "alpha-driver", importer: "src/lib/missing.ts" }, "does not exist"],
      [
        { driver: "alpha-driver", importer: "tests/uses-alpha.ts" },
        "is not under src/, bin/, scripts/ or vscode-extension/src/",
      ],
    ] as const) {
      expect(run(root, payload, { exceptions: [entry] }).problems).toEqual([
        `check-build-output: the exception for ${entry.driver} imported by ${entry.importer}: the importer ${why}`,
      ]);
    }

    // An entry for alpha-driver excepts no file of beta-driver.
    const both = standalone({
      "node_modules/alpha-driver/index.js": DRIVER_TEXT,
      "node_modules/beta-driver/index.js": BETA_TEXT,
    });
    expect(run(root, both, { exceptions: [{ driver: "alpha-driver", importer }] }).problems).toEqual([
      `${path.join(both, "node_modules", "beta-driver", "index.js")} equals beta-driver index.js, a driver ${PACKAGE_NAME} declares`,
    ]);
  });

  test("a payload file holding a provider package's name fails by file, across a chunk boundary, and a clean payload passes naming each package and its counts", () => {
    const root = repository();
    const across = standalone({ ".next/server/chunks/named.js": `${"a".repeat(6)}${PACKAGE_NAME}${"b".repeat(9)}` });
    expect(run(root, across, { chunkSize: 4 }).problems).toEqual([
      `${path.join(across, ".next", "server", "chunks", "named.js")} holds ${PACKAGE_NAME}`,
    ]);

    const clean = standalone();
    const passed = run(root, clean, { chunkSize: 4 });
    expect(passed.problems).toEqual([]);
    // Two payload files; the package's source holds three files that are not empty (package.json, the manifest and
    // src/index.ts); alpha-driver holds two outside its nested node_modules.
    expect(passed.lines).toEqual([
      `${PACKAGE_NAME}: none of 2 files under ${path.join(clean, ".next")} and node_modules equals one of its 3 source files or 2 files of its drivers (alpha-driver), or holds its name`,
    ]);

    // The scan itself: a file is named by the label of the file it equals and by each needle it holds, every regular
    // file under a directory is read, and a scan of no file fails, since it would assert nothing.
    const files = check.regularFiles(across);
    expect(files.map((file) => path.relative(across, file).split(path.sep).join("/"))).toEqual([
      ".next/server/chunks/core.js",
      ".next/server/chunks/named.js",
      "node_modules/pg/index.js",
    ]);
    const labelled = new Map([
      [new Bun.CryptoHasher("sha256").update("module.exports = {};\n").digest("hex"), "a label"],
    ]);
    expect(check.scanProblems(files, ["'quoted'", "core ="], labelled, 4)).toEqual([
      `${files[0]} holds core =`,
      `${files[2]} equals a label`,
    ]);
    expect(check.scanProblems([], [PACKAGE_NAME], new Map(), 4)).toEqual(["the build scan found no file to read"]);
  });

  test("the packages are every provider package of the repository and each one named, each once, and none at all is refused", () => {
    const root = repository();
    const named = planted("named", {
      "package.json": `${JSON.stringify({ name: "named-provider", version: "1.0.0" })}\n`,
      "src/index.ts": "export const named = 1;\n",
    });
    const payload = standalone();
    const result = run(root, payload, {
      packageDirectories: [named, path.join(root, "packages", "provider-alpha"), named],
    });
    expect(result.problems).toEqual([]);
    expect(result.lines.map((line) => line.split(":")[0])).toEqual([PACKAGE_NAME, "named-provider"]);
    expect(result.lines[1]).toContain("one of its 2 source files or 0 files of its drivers (none)");

    const empty = planted("empty-repository", { "package.json": "{}\n", "packages/provider-sdk/package.json": "{}\n" });
    expect(run(empty, payload).problems).toEqual([
      "check-build-output: no provider package to compare: the repository holds none and none was named",
    ]);
    expect(run(empty, payload, { packageDirectories: [path.join(scratch, "absent")] }).problems).toEqual([
      `check-build-output: ${path.join(scratch, "absent")}: the package directory does not exist`,
    ]);
  });

  test("the command line takes --standalone with absolute directories, and a standalone without .next or node_modules, a link in a package, an undeclared name or a driver not installed is refused by name", () => {
    const spawn = (args: readonly string[]) => {
      const child = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      const split = (text: string) => text.split(/\r?\n/).filter((line) => line !== "");
      return { exitCode: child.exitCode, out: split(child.stdout.toString()), err: split(child.stderr.toString()) };
    };
    const usage =
      "Usage: bun scripts/check-build-output.ts --standalone <absolute directory> [<absolute package directory> ...]";
    const payload = standalone();
    const named = planted("cli-package", {
      "package.json": `${JSON.stringify({ name: "cli-provider", version: "1.0.0" })}\n`,
      "src/index.ts": "export const cli = 1;\n",
    });

    for (const args of [
      [],
      ["--standalone"],
      ["--standalone", "relative/standalone"],
      ["--standalone", payload, "relative/package"],
      ["--standalone", payload, "--bogus"],
      ["--other", payload],
    ]) {
      expect([args, spawn(args)]).toEqual([args, { exitCode: 2, out: [], err: [usage] }]);
    }
    const passed = spawn(["--standalone", payload, named]);
    expect(passed.exitCode).toBe(0);
    expect(passed.err).toEqual([]);
    expect(passed.out).toEqual([
      `cli-provider: none of 2 files under ${path.join(payload, ".next")} and node_modules equals one of its 2 source files or 0 files of its drivers (none), or holds its name`,
    ]);
    const copied = standalone({ ".next/copy.js": "export const cli = 1;\n" });
    expect(spawn(["--standalone", copied, named])).toEqual({
      exitCode: 1,
      out: [],
      err: [`${path.join(copied, ".next", "copy.js")} equals cli-provider's src/index.ts`],
    });

    const noNext = planted("no-next", { "node_modules/pg/index.js": "module.exports = {};\n" });
    expect(spawn(["--standalone", noNext, named]).err).toEqual([
      `check-build-output: ${noNext} holds no .next directory`,
    ]);
    const noModules = planted("no-modules", { ".next/BUILD_ID": "x\n" });
    expect(run(repository(), noModules).problems).toEqual([
      `check-build-output: ${noModules} holds no node_modules directory`,
    ]);

    const linked = planted("linked", {
      "package.json": `${JSON.stringify({ name: "linked-provider", version: "1.0.0" })}\n`,
    });
    fs.symlinkSync(path.join(named, "src"), path.join(linked, "src"), "junction");
    expect(run(repository(), payload, { packageDirectories: [linked] }).problems).toEqual([
      `check-build-output: ${path.join(linked, "src")} is a symbolic link or junction inside linked-provider's directory, so the check would not compare its target`,
    ]);

    const unnamed = planted("unnamed", { "package.json": `${JSON.stringify({ version: "1.0.0" })}\n` });
    expect(run(repository(), payload, { packageDirectories: [unnamed] }).problems).toEqual([
      `check-build-output: ${path.join(unnamed, "package.json")} is not a JSON object with a package name`,
    ]);

    const missingDriver = planted("missing-driver", {
      "package.json": `${JSON.stringify({ name: "missing-driver-provider", optionalDependencies: { "absent-driver": "1.0.0" } })}\n`,
    });
    expect(run(repository(), payload, { packageDirectories: [missingDriver] }).problems).toEqual([
      `check-build-output: absent-driver, a driver missing-driver-provider declares, is not installed in any node_modules above ${missingDriver}`,
    ]);
  });

  test("a package's drivers are its dependencies, optionalDependencies and peerDependencies, never its devDependencies", () => {
    const declaringRoot = planted("declaring", {
      "node_modules/alpha-driver/package.json": `${JSON.stringify({ name: "alpha-driver", version: "1.0.0" })}\n`,
      "node_modules/alpha-driver/index.js": DRIVER_TEXT,
      "node_modules/beta-driver/package.json": `${JSON.stringify({ name: "beta-driver", version: "1.0.0" })}\n`,
      "node_modules/beta-driver/index.js": BETA_TEXT,
      "provider/package.json": `${JSON.stringify({
        name: "declaring-provider",
        peerDependencies: { "alpha-driver": "1.0.0" },
        devDependencies: { "beta-driver": "1.0.0" },
      })}\n`,
    });
    const payload = standalone({
      "node_modules/alpha-driver/index.js": DRIVER_TEXT,
      "node_modules/beta-driver/index.js": BETA_TEXT,
    });
    // The drivers are found from the named package's directory, in the node_modules above it.
    const result = run(planted("bare-repository", { "package.json": "{}\n" }), payload, {
      packageDirectories: [path.join(declaringRoot, "provider")],
    });
    expect(result.problems).toEqual([
      `${path.join(payload, "node_modules", "alpha-driver", "index.js")} equals alpha-driver index.js, a driver declaring-provider declares`,
    ]);
  });

  test("the exception list is empty while the repository holds no provider package", () => {
    // Fails on purpose when the first provider package lands: its change decides whether a core module still imports
    // one of its drivers, and lists the importer if so.
    expect({ packages: providerPackageDirectories(ROOT), exceptions: check.CORE_IMPORTED_DRIVERS }).toEqual({
      packages: [],
      exceptions: [],
    });
  });
});
