/**
 * The out-of-tree acceptance (scripts/out-of-tree-acceptance.ts) without a server: its command line, its run of the
 * issue's eight steps, its checks over captured output, the children it starts, the fixture provider it builds
 * (tests/fixtures/out-of-tree-provider/) and the CI job that runs it.
 *
 * The script's IO (spawning, fetching) is exercised by the "Out-of-tree Provider Acceptance" job itself; scripts/ is
 * outside the merged coverage gate, so these tests are what hold the script's logic. The fixture's engine id is read
 * from its manifest and never spelled here.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { compileManifestValidator } from "@libredb/provider-sdk/manifest";
import {
  type Answer,
  artifactProblems,
  buildNeedles,
  buildScanProblems,
  CHILD_TIMEOUTS_MS,
  childSpec,
  dependencyClosure,
  describeChild,
  type Expectation,
  type Fixture,
  filesNaming,
  installedSdkProblems,
  lockOutputProblems,
  NAMING_SCAN_ROOTS,
  namingScanFiles,
  packedTarballs,
  parseArguments,
  platformProblem,
  porcelainProblems,
  readFixture,
  refusalLines,
  refusedProblems,
  regularFiles,
  rowsProblems,
  runSteps,
  saveProblems,
  sdkTarball,
  serverEnvironment,
  sessionCookie,
  STEP_TITLES,
  type Step,
  STUDIO,
  stepListProblems,
  tamperedBundle,
  temporaryRootProblems,
  unavailableProblems,
  unconfirmedProblems,
  unsupportedProblems,
  bundleProblems,
  wordsOf,
} from "../../../scripts/out-of-tree-acceptance";
import { moduleSpecifiers } from "../lib/db/provider-imports/scan";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "out-of-tree-provider");
const SCRIPT = path.join(ROOT, "scripts", "out-of-tree-acceptance.ts");
const readText = (file: string): string => readFileSync(file, "utf8");

/** The fixture as the script reads it. */
const fixture: Fixture = readFixture(FIXTURE, readText);
const manifestText = readText(path.join(FIXTURE, "libredb-provider.json"));
const engineId = (fixture.engines[0] as Fixture["engines"][number]).id;

/**
 * Studio's answers as the acceptance met them, one real sample of each, captured from a green local run of the script
 * and a probe against the same build and providers directory on 2026-11-25 (main at the package session's head);
 * `listBody`'s `confirmation: "unconfirmed"` mark is the one a green local run of the script asserted on 2026-11-27,
 * once the gate asked about every statement of an engine no register row reviews. The package name, version and engine id come from the fixture, so a sample stays true when the fixture is renamed; the
 * session cookie's value is drawn at run time.
 */
const SAMPLES = {
  lockStdout: (lockFile: string): string =>
    `Wrote ${lockFile}\n${fixture.name} ${fixture.version} sha256:1c128d8147d1717382b8b42371ef2daeadb5eb2c44b6b571724e337acfaff542\n`,
  signInSetCookie: (value: string): string =>
    `${STUDIO.sessionCookie}=${value}; Path=/; Expires=Thu, 26 Nov 2026 18:02:03 GMT; Max-Age=86400; HttpOnly; SameSite=lax`,
  saveBody: { success: true, message: "Connection successful", latency: 0 },
  listBody: {
    rows: [
      { name: "alpha", value: "first" },
      { name: "beta", value: "second" },
    ],
    fields: ["name", "value"],
    columnTypes: { name: "text", value: "text" },
    rowCount: 2,
    executionTime: 0,
    pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
    confirmation: "unconfirmed",
  },
  admittedLine: `[INFO ] [2026-11-25T18:02:02.835Z] {route=provider-boot, package=${fixture.name} ${fixture.version}, engines=${engineId}} A provider package was admitted`,
  refusalLine: `[WARN ] [2026-11-25T18:00:30.243Z] {route=provider-boot} PROVIDER_DIGEST_MISMATCH: ${fixture.name} ${fixture.version}: its files differ from the digest its lock entry pins`,
  unavailableBody: {
    error: `The connection type "${engineId}" is served by a provider package this LibreDB Studio refused when it started (PROVIDER_DIGEST_MISMATCH), so no provider can open it; the server's log names the package and why.`,
    code: "PROVIDER_UNAVAILABLE",
    statusCode: 503,
    kind: "provider-unavailable",
    outcome: "unknown",
  },
  unknownBody: {
    error: `No provider for the connection type "${engineId}" is installed in this LibreDB Studio.`,
    code: "PROVIDER_UNKNOWN",
    statusCode: 400,
    kind: "unknown-provider",
    outcome: "unknown",
  },
} as const;

/** Eight steps that each answer `evidence(n)`, recording the order they ran in. */
function fakeSteps(ran: number[], answer: (n: number) => Promise<string> = async (n) => `evidence ${n}`): Step[] {
  return STEP_TITLES.map((title, index) => ({
    number: index + 1,
    title,
    run: async () => {
      ran.push(index + 1);
      return answer(index + 1);
    },
  }));
}

/** A run of `steps` with its printed lines and its cleanup's calls. */
async function run(steps: readonly Step[]): Promise<{ code: number; lines: string[]; cleanups: boolean[] }> {
  const lines: string[] = [];
  const cleanups: boolean[] = [];
  const code = await runSteps(steps, {
    print: (line) => lines.push(line),
    cleanup: async (passed) => {
      cleanups.push(passed);
    },
  });
  return { code, lines, cleanups };
}

describe("the out-of-tree acceptance's command line", () => {
  test("takes no argument or --standalone with one directory, and refuses anything else", () => {
    expect(parseArguments([])).toEqual({ standalone: null });
    expect(parseArguments(["--standalone", "/opt/standalone"])).toEqual({ standalone: "/opt/standalone" });
    expect(parseArguments(["--standalone"])).toBeNull();
    expect(parseArguments(["--standalone", "--bogus"])).toBeNull();
    expect(parseArguments(["--standalone", "/a", "/b"])).toBeNull();
    expect(parseArguments(["--bogus"])).toBeNull();
    expect(parseArguments(["/opt/standalone"])).toBeNull();
  });

  test("the script refuses an unknown argument with its usage and exit 2 before any step runs", async () => {
    const child = Bun.spawn([process.execPath, SCRIPT, "--bogus"], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage: heavy bun scripts/out-of-tree-acceptance.ts [--standalone <dir>]");
    expect(stdout).not.toContain("step 1");
  });

  test("the run is refused on Windows by name, since it stops each child by its process group", () => {
    expect(platformProblem("linux")).toBeNull();
    expect(platformProblem("darwin")).toBeNull();
    expect(platformProblem("win32")).toContain("process group");
  });
});

describe("the out-of-tree acceptance's run", () => {
  test("runs the eight steps in order, printing each step's evidence, and passes only when all eight passed", async () => {
    const ran: number[] = [];
    const { code, lines } = await run(fakeSteps(ran));
    expect(code).toBe(0);
    expect(ran).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lines).toEqual([
      ...STEP_TITLES.map((title, index) => `ok   step ${index + 1} ${title}: evidence ${index + 1}`),
      "out-of-tree acceptance passed: 8 of 8 steps",
    ]);
  });

  test("stops at the first failing step, naming its number and title and printing its output, and runs no later step", async () => {
    const ran: number[] = [];
    const steps = fakeSteps(ran, async (n) => {
      if (n === 4) throw Object.assign(new Error("the lock command exited 1"), { output: "Script not found" });
      return `evidence ${n}`;
    });
    const { code, lines } = await run(steps);
    expect(code).toBe(1);
    expect(ran).toEqual([1, 2, 3, 4]);
    expect(lines).toContain(`FAIL step 4 ${STEP_TITLES[3]}: the lock command exited 1`);
    expect(lines.join("\n")).toContain("Script not found");
    expect(lines.some((line) => line.includes("step 5"))).toBe(false);
    expect(lines.at(-1)).toBe("out-of-tree acceptance failed at step 4 of 8");
  });

  test("fails a step that answers no evidence, so no step passes without asserting something", async () => {
    const ran: number[] = [];
    const { code, lines } = await run(fakeSteps(ran, async (n) => (n === 2 ? "  " : `evidence ${n}`)));
    expect(code).toBe(1);
    expect(ran).toEqual([1, 2]);
    expect(lines).toContain(`FAIL step 2 ${STEP_TITLES[1]}: the step asserted nothing`);
  });

  test("runs the cleanup after a pass, after a failure and after a step that throws", async () => {
    expect((await run(fakeSteps([]))).cleanups).toEqual([true]);
    const failing = fakeSteps([], async (n) => (n === 3 ? "" : "seen"));
    expect((await run(failing)).cleanups).toEqual([false]);
    const throwing = fakeSteps([], async (n) => {
      if (n === 6) throw new Error("boom");
      return "seen";
    });
    const thrown = await run(throwing);
    expect(thrown.cleanups).toEqual([false]);
    expect(thrown.lines).toContain(`FAIL step 6 ${STEP_TITLES[5]}: boom`);
  });

  test("is the issue's eight steps, numbered 1 to 8 in order, and a list that is not is refused before any step runs", async () => {
    expect(STEP_TITLES).toHaveLength(8);
    expect(stepListProblems(fakeSteps([]))).toEqual([]);

    const ran: number[] = [];
    const missing = fakeSteps(ran).filter((step) => step.number !== 4);
    expect(stepListProblems(missing)).not.toEqual([]);
    const { code, lines } = await run(missing);
    expect(code).toBe(1);
    expect(ran).toEqual([]);
    expect(lines[0]).toStartWith("refused: ");

    const swapped = fakeSteps([]);
    [swapped[1], swapped[2]] = [swapped[2] as Step, swapped[1] as Step];
    expect(stepListProblems(swapped)).not.toEqual([]);
    const retitled = fakeSteps([]);
    retitled[6] = { number: 7, title: "anything", run: (retitled[6] as Step).run };
    expect(stepListProblems(retitled)).not.toEqual([]);
    const extra = [...fakeSteps([]), { number: 9, title: "a ninth step", run: async () => "seen" }];
    expect(stepListProblems(extra).join(" ")).toContain("9 steps");
  });
});

describe("the out-of-tree fixture", () => {
  test("is read from its package.json, manifest and expectations, one engine and no dependency, and an expectation with no statement or no row is refused", () => {
    expect(regularFiles(FIXTURE).map((file) => path.relative(FIXTURE, file).split(path.sep).join("/"))).toEqual([
      "acceptance.json",
      "libredb-provider.json",
      "package.json",
      "src/index.ts",
    ]);
    expect(fixture.engines).toHaveLength(1);
    expect(fixture.entry).toBe("dist/index.mjs");
    expect(fixture.acceptance.entrySource).toBe("src/index.ts");
    expect(fixture.acceptance.statements.length).toBeGreaterThan(0);
    const packageJson = JSON.parse(readText(path.join(FIXTURE, "package.json"))) as Record<string, unknown>;
    expect(packageJson.type).toBe("module");
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      expect(packageJson[field]).toBeUndefined();
    }

    const files: Record<string, string> = {
      "package.json": readText(path.join(FIXTURE, "package.json")),
      "libredb-provider.json": manifestText,
      "acceptance.json": readText(path.join(FIXTURE, "acceptance.json")),
    };
    const reading = (overrides: Record<string, string>) => () =>
      readFixture("/fixture", (file) => {
        const text = { ...files, ...overrides }[path.basename(file)];
        if (text === undefined) throw new Error(`no ${file}`);
        return text;
      });
    const acceptance = JSON.parse(files["acceptance.json"] as string) as {
      statements: { statement: string; columns: string[]; rows: string[][] }[];
    };
    expect(reading({ "acceptance.json": JSON.stringify({ ...acceptance, statements: [] }) })).toThrow("no statement");
    const noRow = acceptance.statements.map((s, i) => (i === 0 ? { ...s, rows: [] } : s));
    expect(reading({ "acceptance.json": JSON.stringify({ ...acceptance, statements: noRow }) })).toThrow("no row");
    const shortRow = acceptance.statements.map((s, i) => (i === 0 ? { ...s, rows: [["only"]] } : s));
    expect(reading({ "acceptance.json": JSON.stringify({ ...acceptance, statements: shortRow }) })).toThrow("columns");
    const withDependency = { ...packageJson, dependencies: { anything: "1.0.0" } };
    expect(reading({ "package.json": JSON.stringify(withDependency) })).toThrow("dependencies");
    const manifest = JSON.parse(manifestText) as { engines: unknown[] };
    const twoEngines = { ...manifest, engines: [manifest.engines[0], manifest.engines[0]] };
    expect(reading({ "libredb-provider.json": JSON.stringify(twoEngines) })).toThrow("one engine");
  });

  test("its manifest is admitted by the SDK's validator for the contract this repository serves", () => {
    const schema = readFileSync(path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json"));
    const validator = compileManifestValidator(schema);
    const manifest = JSON.parse(manifestText) as { contract: string };
    expect(manifest.contract).toBe(validator.contract);
    expect(validator.validate(manifest)).toMatchObject({ admitted: true });
  });

  test("its manifest requests every claim at its restrictive value but the two the SDK refuses at it for an engine with no agent credential and no seed-only field", () => {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const at = (pointer: string): unknown =>
      pointer
        .split("/")
        .slice(1)
        .reduce<unknown>((value, segment) => (value as Record<string, unknown>)[segment], manifest);
    const claims: Record<string, unknown> = {
      "/engines/0/policy/writeReach": "open",
      "/engines/0/policy/readsFileAccessPosture": true,
      "/engines/0/policy/singleWriterFile": false,
      "/engines/0/policy/agentCredentialForm": "none",
      "/engines/0/policy/maskingExemptColumns": null,
      "/engines/0/mcp/exposable": false,
      "/engines/0/mcp/statementRead": false,
      "/engines/0/mcp/metadataReadChangesState": true,
      "/engines/0/connection/opensLocalFile": true,
      "/engines/0/connection/hostPathFields": [],
      "/engines/0/connection/serverLevelWithoutDatabase": true,
      "/engines/0/connection/sshTunnel/offered": false,
      "/engines/0/connection/agentCredential": null,
      "/engines/0/connection/seedOnly": null,
      "/engines/0/facets/agentReadings": [],
      "/engines/0/agent/statementLanguage": null,
      "/engines/0/agent/overlay": null,
      "/engines/0/sqlText/readsSqlText": true,
      "/engines/0/sqlText/grammar/confirmExemptForms": [],
      "/engines/0/sqlText/redaction/kind": "none",
      "/engines/0/safeguards/writePaths/editor/reach": "open",
      "/engines/0/safeguards/writePaths/objectEdit/reach": "open",
      "/engines/0/safeguards/writePaths/maintenance/reach": "open",
      "/engines/0/safeguards/writePaths/transaction/reach": "open",
      "/engines/0/policy/readRootsRequired": false,
      "/engines/0/mcp/agentCredentialRequired": false,
    };
    for (const [pointer, value] of Object.entries(claims)) expect([pointer, at(pointer)]).toEqual([pointer, value]);
    expect(typeof at("/engines/0/policy/deniedFileAccessRefusal")).toBe("string");
    expect(typeof at("/engines/0/connection/sshTunnel/refusal")).toBe("string");

    // The two exceptions are forced: the restrictive value is refused for this engine.
    const validator = compileManifestValidator(
      readFileSync(path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json")),
    );
    const forced = (section: string, member: string, rule: string, pointer: string) => {
      const changed = JSON.parse(manifestText) as { engines: Record<string, Record<string, unknown>>[] };
      (changed.engines[0] as Record<string, Record<string, unknown>>)[section] = {
        ...(changed.engines[0] as Record<string, Record<string, unknown>>)[section],
        [member]: true,
      };
      const verdict = validator.validate(changed);
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.refusals).toContainEqual(expect.objectContaining({ rule, pointer }));
    };
    forced("policy", "readRootsRequired", "read-roots-field-undeclared", "/engines/0/policy/readRootsRequired");
    forced("mcp", "agentCredentialRequired", "agent-credential-form-missing", "/engines/0/mcp/agentCredentialRequired");
  });

  test("its engine id is named in no file under src, bin, scripts, vscode-extension/src or packages", () => {
    const ids = fixture.engines.map((engine) => engine.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(NAMING_SCAN_ROOTS).toEqual([...STUDIO.coreRoots, "packages"]);
    const files = namingScanFiles(ROOT);
    expect(files.length).toBeGreaterThan(1000);
    expect(filesNaming(files, ids, readText)).toEqual([]);
  });

  test("its entry imports only the SDK's calls subpath and its own manifest", () => {
    const entry = readText(path.join(FIXTURE, fixture.acceptance.entrySource));
    expect(moduleSpecifiers(entry).sort()).toEqual(["../libredb-provider.json", "@libredb/provider-sdk/calls"]);
  });

  test("nothing in the repository imports a file of the fixture", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(listed.exitCode).toBe(0);
    const code = new TextDecoder()
      .decode(listed.stdout)
      .split("\0")
      .filter((file) => /\.(c|m)?(t|j)sx?$/.test(file) && !file.startsWith("tests/fixtures/out-of-tree-provider/"));
    expect(code.length).toBeGreaterThan(1000);
    const importing = code.filter((file) => {
      const text = readText(path.join(ROOT, file));
      return (
        text.includes("out-of-tree-provider") &&
        moduleSpecifiers(text).some((specifier) => specifier.includes("out-of-tree-provider"))
      );
    });
    expect(importing).toEqual([]);
  });

  test("a refused statement is read from acceptance.json with its code, Studio's sentence and the package's words, and one step 5 cannot prove anything with is refused", () => {
    const { refused } = fixture.acceptance;
    expect(refused.statement).not.toBe("");
    expect(refused.code).not.toBe("");
    expect(wordsOf(refused.sentence)).toContain(refused.code.toLowerCase());
    expect(wordsOf(refused.packageWords).length).toBeGreaterThan(0);

    const files: Record<string, string> = {
      "package.json": readText(path.join(FIXTURE, "package.json")),
      "libredb-provider.json": manifestText,
    };
    const acceptance = JSON.parse(readText(path.join(FIXTURE, "acceptance.json"))) as Record<string, unknown>;
    const reading = (changed: Record<string, unknown>) => () =>
      readFixture("/fixture", (file) => {
        const text = { ...files, "acceptance.json": JSON.stringify(changed) }[path.basename(file)];
        if (text === undefined) throw new Error(`no ${file}`);
        return text;
      });
    const withRefused = (members: Record<string, unknown>) =>
      reading({ ...acceptance, refused: { ...refused, ...members } });

    expect(reading(acceptance)().acceptance.refused).toEqual(refused);
    const withoutRefused = { ...acceptance };
    delete withoutRefused.refused;
    expect(reading(withoutRefused)).toThrow("acceptance.json holds no refused statement object");
    expect(reading({ ...acceptance, refused: "count" })).toThrow("acceptance.json holds no refused statement object");
    for (const member of ["statement", "packageWords", "code", "sentence"]) {
      expect(withRefused({ [member]: "" })).toThrow(`acceptance.json refused statement has no ${member} text`);
      expect(withRefused({ [member]: 7 })).toThrow(`acceptance.json refused statement has no ${member} text`);
    }
    expect(
      withRefused({ sentence: "The provider package's execute failed; the server's log holds its words." }),
    ).toThrow(`acceptance.json refused statement's sentence does not name its code ${refused.code}`);
    // A code inside a longer word is not named: the sentence must name it as a whole word.
    expect(withRefused({ code: "INTERNAL" })).toThrow("does not name its code INTERNAL");
    expect(withRefused({ packageWords: "The package failed in its own words." })).toThrow(
      "acceptance.json refused statement's package words share words with Studio's sentence: failed, its, the, words",
    );
    const first = (fixture.acceptance.statements[0] as Expectation).statement;
    expect(withRefused({ statement: first })).toThrow(
      `acceptance.json refused statement "${first}" is one of its statements, which answer rows`,
    );
  });

  test("the fixture's provider refuses in the words acceptance.json names", () => {
    const { refused, statements } = fixture.acceptance;
    // The words step 5 looks for are the words the package really answers, so a reworded error cannot pass vacuously.
    expect(readText(path.join(FIXTURE, fixture.acceptance.entrySource))).toContain(refused.packageWords);
    // The refused statement is none of the statements the fixture answers with rows.
    expect(statements.map((expected) => expected.statement)).not.toContain(refused.statement);
    expect(statements.length).toBeGreaterThan(0);
  });
});

describe("the out-of-tree acceptance's checks over captured output", () => {
  test("the SDK tarball is the one absolute .tgz path sdk:pack printed, inside its out directory", () => {
    const out = path.join(tmpdir(), "acceptance", "sdk");
    const tarball = path.join(out, "libredb-provider-sdk-0.1.0.tgz");
    expect(sdkTarball(`${tarball}\n`, out)).toBe(tarball);
    expect(() => sdkTarball("", out)).toThrow("one line");
    expect(() => sdkTarball(`${tarball}\n${tarball}\n`, out)).toThrow("one line");
    expect(() => sdkTarball("libredb-provider-sdk-0.1.0.tgz\n", out)).toThrow("absolute");
    expect(() => sdkTarball(`${path.join(out, "sdk.tar")}\n`, out)).toThrow(".tgz");
    expect(() => sdkTarball(`${path.join(tmpdir(), "elsewhere.tgz")}\n`, out)).toThrow("inside");
  });

  test("a temporary root inside the repository, or with node_modules above it, is refused naming why", () => {
    const none = () => false;
    const root = path.join(path.parse(ROOT).root, "scratch", "acceptance-run");
    expect(temporaryRootProblems(root, ROOT, none)).toEqual([]);
    expect(temporaryRootProblems(path.join(ROOT, "tmp", "run"), ROOT, none).join(" ")).toContain(
      "inside the repository",
    );
    const above = (candidate: string) => candidate === path.join(path.dirname(root), "node_modules");
    expect(temporaryRootProblems(root, ROOT, above).join(" ")).toContain("node_modules");
  });

  test("the dependency closure lists each named package and every package it depends on, found as Node finds a package directory, and names a missing one", () => {
    const top = path.join(path.parse(ROOT).root, "repo");
    const from = path.join(top, "packages", "sdk");
    const manifests: Record<string, Record<string, string>> = {
      [path.join(top, "node_modules", "a")]: { b: "1", c: "1" },
      [path.join(top, "node_modules", "b")]: {},
      [path.join(top, "node_modules", "a", "node_modules", "c")]: { b: "1" },
    };
    const exists = (file: string) => path.dirname(file) in manifests && path.basename(file) === "package.json";
    const read = (directory: string) => ({ dependencies: manifests[directory] });
    expect(dependencyClosure(["a"], from, exists, read)).toEqual(
      [
        path.join(top, "node_modules", "a"),
        path.join(top, "node_modules", "a", "node_modules", "c"),
        path.join(top, "node_modules", "b"),
      ].sort(),
    );
    expect(() => dependencyClosure(["missing"], from, exists, read)).toThrow("missing");
  });

  test("npm's packed tarballs are read from its JSON answer, each one in the destination", () => {
    const destination = path.join(tmpdir(), "deps");
    const answer = JSON.stringify([{ filename: "ajv-8.20.0.tgz" }, { filename: "fast-uri-3.1.0.tgz" }]);
    expect(packedTarballs(answer, destination)).toEqual([
      path.join(destination, "ajv-8.20.0.tgz"),
      path.join(destination, "fast-uri-3.1.0.tgz"),
    ]);
    expect(() => packedTarballs("[]", destination)).toThrow("no tarball");
    expect(() => packedTarballs("not json", destination)).toThrow("JSON");
    expect(() => packedTarballs(JSON.stringify([{ filename: "../ajv.tgz" }]), destination)).toThrow("destination");
    expect(() => packedTarballs(JSON.stringify([{ name: "ajv" }]), destination)).toThrow("filename");
  });

  test("the installed SDK must be the packed one: a directory of its own whose calls entry points under dist, at the repository SDK's version", () => {
    const manifest = {
      name: "@libredb/provider-sdk",
      version: "0.1.0",
      exports: { "./calls": { types: "./dist/calls/index.d.ts", default: "./dist/calls/index.js" } },
    };
    const installed = { isSymbolicLink: false, isDirectory: true, manifest, expectedVersion: "0.1.0" };
    expect(installedSdkProblems(installed)).toEqual([]);
    expect(installedSdkProblems({ ...installed, isSymbolicLink: true }).join(" ")).toContain("symbolic link");
    expect(installedSdkProblems({ ...installed, expectedVersion: "0.2.0" }).join(" ")).toContain("0.2.0");
    const source = { ...manifest, exports: { "./calls": "./src/calls/index.ts" } };
    expect(installedSdkProblems({ ...installed, manifest: source }).join(" ")).toContain("dist");
  });

  test("a bundle with an input outside the build directory, no input from the packed SDK's dist, or an import other than a node built-in is refused", () => {
    const sdkInput = "node_modules/@libredb/provider-sdk/dist/calls/index.js";
    const metafile = (inputs: string[], imports: { path: string }[]) => ({
      inputs: Object.fromEntries(inputs.map((input) => [input, {}])),
      outputs: { "dist/index.mjs": { imports } },
    });
    const good = metafile(["src/index.ts", "libredb-provider.json", sdkInput], [{ path: "node:crypto" }]);
    expect(bundleProblems(good, "dist/index.mjs")).toEqual([]);
    const outside = metafile(["src/index.ts", sdkInput, "../../repo/packages/provider-sdk/src/calls/index.ts"], []);
    expect(bundleProblems(outside, "dist/index.mjs").join(" ")).toContain("outside");
    expect(bundleProblems(metafile(["/abs/x.ts", sdkInput], []), "dist/index.mjs").join(" ")).toContain("outside");
    expect(bundleProblems(metafile(["src/index.ts"], []), "dist/index.mjs").join(" ")).toContain("packed SDK");
    const importing = metafile(["src/index.ts", sdkInput], [{ path: "ajv" }]);
    expect(bundleProblems(importing, "dist/index.mjs").join(" ")).toContain("ajv");
    expect(bundleProblems({ inputs: {}, outputs: {} }, "dist/index.mjs").join(" ")).toContain("dist/index.mjs");
  });

  test("the lock command's output must name the lock file and the one package with its sha256 digest", () => {
    const lock = path.join(tmpdir(), "providers", STUDIO.lockFile);
    const digest = "a".repeat(64);
    const good = `Wrote ${lock}\nfixture-provider 1.0.0 sha256:${digest}\n`;
    expect(lockOutputProblems(good, lock, "fixture-provider", "1.0.0")).toEqual([]);
    expect(lockOutputProblems("", lock, "fixture-provider", "1.0.0")).not.toEqual([]);
    expect(lockOutputProblems(good, lock, "other-provider", "1.0.0").join(" ")).toContain("other-provider");
    const shortDigest = `Wrote ${lock}\nfixture-provider 1.0.0 sha256:abc\n`;
    expect(lockOutputProblems(shortDigest, lock, "fixture-provider", "1.0.0")).not.toEqual([]);
    const twoPackages = `${good}another 2.0.0 sha256:${digest}\n`;
    expect(lockOutputProblems(twoPackages, lock, "fixture-provider", "1.0.0")).not.toEqual([]);
    expect(lockOutputProblems(SAMPLES.lockStdout(lock), lock, fixture.name, fixture.version)).toEqual([]);
  });

  test("the artifact must hold exactly the package.json, the manifest and the bundle at the manifest's entry", () => {
    const files = ["dist/index.mjs", "libredb-provider.json", "package.json"];
    expect(artifactProblems(files, "dist/index.mjs")).toEqual([]);
    expect(artifactProblems([...files, "src/index.ts"], "dist/index.mjs").join(" ")).toContain("src/index.ts");
    expect(artifactProblems(["package.json", "libredb-provider.json"], "dist/index.mjs").join(" ")).toContain(
      "dist/index.mjs",
    );
  });

  test("one byte of the bundle changes, its final newline, and a bundle not ending in a newline is refused", () => {
    const original = new TextEncoder().encode("export default 1;\n");
    const tampered = tamperedBundle(original);
    expect(tampered).toHaveLength(original.length);
    expect(tampered.filter((byte, index) => byte !== original[index])).toHaveLength(1);
    expect(tampered.at(-1)).toBe(0x20);
    expect(original.at(-1)).toBe(0x0a);
    expect(() => tamperedBundle(new TextEncoder().encode("export default 1;"))).toThrow("newline");
  });

  test("the session cookie is the one the sign-in set, and a sign-in without it is refused", () => {
    const value = randomUUID();
    const headers = ["theme=dark; Path=/", `${STUDIO.sessionCookie}=${value}; Path=/; HttpOnly`];
    expect(sessionCookie(200, headers)).toBe(`${STUDIO.sessionCookie}=${value}`);
    expect(() => sessionCookie(200, ["theme=dark; Path=/"])).toThrow(STUDIO.sessionCookie);
    expect(() => sessionCookie(401, headers)).toThrow("401");
    const sampled = randomUUID();
    expect(sessionCookie(200, [SAMPLES.signInSetCookie(sampled)])).toBe(`${STUDIO.sessionCookie}=${sampled}`);
  });

  test("the rows must equal the expected rows in order, so an error answer, no rows, other rows or a degraded save fail", () => {
    const expected = {
      statement: "list",
      columns: ["name", "value"],
      rows: [
        ["a", "1"],
        ["b", "2"],
      ],
    };
    const rows = [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ];
    const ok: Answer = { status: 200, body: { rows } };
    expect(rowsProblems(ok, expected)).toEqual([]);
    expect(rowsProblems({ status: 400, body: { code: "QUERY_ERROR" } }, expected)).not.toEqual([]);
    expect(rowsProblems({ status: 200, body: { rows: [] } }, expected)).not.toEqual([]);
    expect(rowsProblems({ status: 200, body: {} }, expected)).not.toEqual([]);
    expect(rowsProblems({ status: 200, body: { rows: [...rows].reverse() } }, expected)).not.toEqual([]);
    expect(rowsProblems({ status: 200, body: { rows: rows.slice(0, 1) } }, expected)).not.toEqual([]);

    expect(saveProblems({ status: 200, body: { success: true, latencyMs: 3 } })).toEqual([]);
    expect(saveProblems({ status: 200, body: { success: true, degraded: true, message: "x" } })).not.toEqual([]);
    expect(saveProblems({ status: 400, body: { success: false } })).not.toEqual([]);
    expect(saveProblems({ status: 200, body: { success: false } })).not.toEqual([]);

    const list = fixture.acceptance.statements[0] as (typeof fixture.acceptance.statements)[number];
    expect(rowsProblems({ status: 200, body: SAMPLES.listBody }, list)).toEqual([]);
    expect(saveProblems({ status: 200, body: SAMPLES.saveBody })).toEqual([]);
  });

  test("an answer to a fixture statement must be marked unconfirmed: no register row reviews the fixture's grammar, so the gate asks about every statement, and the default advisory mode runs a request that sends no confirmation field", () => {
    const list = fixture.acceptance.statements[0] as (typeof fixture.acceptance.statements)[number];
    expect(unconfirmedProblems({ status: 200, body: SAMPLES.listBody }, list)).toEqual([]);
    const unmarked: Record<string, unknown> = { ...SAMPLES.listBody };
    delete unmarked.confirmation;
    expect(unconfirmedProblems({ status: 200, body: unmarked }, list)).toEqual([
      `"${list.statement}" answered without the mark confirmation: "unconfirmed", so the gate did not ask about it`,
    ]);
    expect(unconfirmedProblems({ status: 200, body: { ...unmarked, confirmation: "confirmed" } }, list)).not.toEqual(
      [],
    );
  });

  test("an unavailable answer must carry the code PROVIDER_UNAVAILABLE exactly and name the refusal code, so IDENTITY_PROVIDER_UNAVAILABLE fails", () => {
    const refusal = STUDIO.digestMismatch;
    const body = { code: STUDIO.unavailable, error: `${refusal}: fixture-provider 1.0.0: its files differ` };
    expect(unavailableProblems({ status: 503, body }, refusal)).toEqual([]);
    expect(unavailableProblems({ status: 200, body }, refusal)).not.toEqual([]);
    const identity = { ...body, code: "IDENTITY_PROVIDER_UNAVAILABLE" };
    expect(unavailableProblems({ status: 503, body: identity }, refusal)).not.toEqual([]);
    expect(unavailableProblems({ status: 503, body: { code: STUDIO.unavailable } }, refusal).join(" ")).toContain(
      refusal,
    );
    expect(unavailableProblems({ status: 400, body: { code: "PROVIDER_UNKNOWN" } }, refusal)).not.toEqual([]);
    expect(unavailableProblems({ status: 503, body: SAMPLES.unavailableBody }, refusal)).toEqual([]);
    expect(unavailableProblems({ status: 400, body: SAMPLES.unknownBody }, refusal)).not.toEqual([]);
  });

  test("an explain answer must be 501 PACKAGE_ENGINE_UNSUPPORTED naming explain, so a 200 or another code fails", () => {
    const body = {
      error: "This LibreDB Studio does not serve explain in a query on an engine of a provider package yet.",
      code: STUDIO.unsupported,
      statusCode: 501,
      kind: "package-engine-unsupported",
      outcome: "unknown",
    };
    expect(STUDIO.unsupported).toBe("PACKAGE_ENGINE_UNSUPPORTED");
    expect(unsupportedProblems({ status: 501, body }, "explain")).toEqual([]);
    expect(unsupportedProblems({ status: 200, body: SAMPLES.listBody }, "explain")).not.toEqual([]);
    expect(unsupportedProblems({ status: 200, body }, "explain").join(" ")).toContain("200");
    for (const code of ["PROVIDER_UNAVAILABLE", "PACKAGE_ENGINE_UNSUPPORTED_X"]) {
      expect(unsupportedProblems({ status: 501, body: { ...body, code } }, "explain").join(" ")).toContain(code);
    }
    const database = { ...body, error: body.error.replace("explain", "database") };
    expect(unsupportedProblems({ status: 501, body: database }, "explain").join(" ")).toContain("explain");
    // The field is named as a whole word, so a sentence naming only `explainer` does not name it.
    const explainer = { ...body, error: body.error.replace("explain", "explainer") };
    expect(unsupportedProblems({ status: 501, body: explainer }, "explain")).not.toEqual([]);
    // Each problem list ends with the body, so the step's failure shows what Studio answered.
    expect(unsupportedProblems({ status: 400, body: SAMPLES.unknownBody }, "explain").at(-1)).toContain(
      "PROVIDER_UNKNOWN",
    );
  });

  test("step 5 fails when a refused statement's answer holds the package's own words or lacks Studio's code", () => {
    const { refused } = fixture.acceptance;
    const body = {
      error: refused.sentence,
      code: refused.code,
      statusCode: 500,
      kind: "internal",
      outcome: "unknown",
    };
    const quoted = `"${refused.statement}" answered`;
    expect(refusedProblems({ status: 500, body }, refused)).toEqual([]);

    // The package's own sentence in place of Studio's: the sentence and the words are named.
    const own = refusedProblems({ status: 500, body: { ...body, error: refused.packageWords } }, refused);
    expect(own[0]).toBe(
      `${quoted} the sentence ${JSON.stringify(refused.packageWords)}, not Studio's sentence naming ${refused.code}`,
    );
    expect(own[1]).toBe(`${quoted} the package's own words: ${[...new Set(wordsOf(refused.packageWords))].join(", ")}`);
    expect(own).toHaveLength(3);
    expect(own[2]).toStartWith("body: ");

    // The words are read over the whole body, not only its sentence.
    const detail = refusedProblems({ status: 500, body: { ...body, detail: "followed by a name" } }, refused);
    expect(detail).toEqual([
      `${quoted} the package's own words: followed, by, a, name`,
      expect.stringMatching(/^body: /),
    ]);

    // No code, and a sentence naming none.
    const uncoded: Record<string, unknown> = { ...body };
    delete uncoded.code;
    const codeless = refusedProblems({ status: 500, body: { ...uncoded, error: "Something failed." } }, refused);
    expect(codeless.slice(0, 2)).toEqual([
      `${quoted} code undefined, not ${refused.code}`,
      `${quoted} the sentence "Something failed.", not Studio's sentence naming ${refused.code}`,
    ]);
    expect(codeless).toHaveLength(3);

    // A success is no refusal.
    expect(refusedProblems({ status: 200, body }, refused)).toEqual([
      `${quoted} 200, not an error status`,
      expect.stringMatching(/^body: /),
    ]);
  });

  test("words are runs of letters, digits, underscores and apostrophes, lower-cased", () => {
    expect(wordsOf("The provider package's execute failed (INTERNAL_ERROR); log 2.")).toEqual([
      "the",
      "provider",
      "package's",
      "execute",
      "failed",
      "internal_error",
      "log",
      "2",
    ]);
    expect(wordsOf("")).toEqual([]);
  });

  test("the refusal line is found only for the code, name and version asked, and the first boot's output must name no refusal of the package", () => {
    const line = `${STUDIO.digestMismatch}: fixture-provider 1.0.0: its files differ from the digest its lock entry pins`;
    const output = `boot\n[warn] ${line}\nready\n`;
    expect(refusalLines(output, STUDIO.digestMismatch, "fixture-provider", "1.0.0")).toEqual([`[warn] ${line}`]);
    expect(refusalLines(output, STUDIO.digestMismatch, "fixture-provider", "1.0.1")).toEqual([]);
    expect(refusalLines(output, STUDIO.digestMismatch, "other-provider", "1.0.0")).toEqual([]);
    expect(refusalLines(output, "PROVIDER_LOCK_MISSING", "fixture-provider", "1.0.0")).toEqual([]);
    expect(refusalLines(output, null, "fixture-provider", "1.0.0")).toHaveLength(1);
    const other = "PROVIDER_ENTRY_INVALID: fixture-provider 1.0.0: no default export";
    expect(refusalLines(other, null, "fixture-provider", "1.0.0")).toEqual([other]);
    expect(refusalLines("boot\nready\n", null, "fixture-provider", "1.0.0")).toEqual([]);
    const boot = `${SAMPLES.admittedLine}\n${SAMPLES.refusalLine}\n`;
    expect(refusalLines(boot, STUDIO.digestMismatch, fixture.name, fixture.version)).toEqual([SAMPLES.refusalLine]);
    expect(refusalLines(`${SAMPLES.admittedLine}\n`, null, fixture.name, fixture.version)).toEqual([]);
  });

  test("a porcelain status with any line fails, naming the lines", () => {
    expect(porcelainProblems("")).toEqual([]);
    expect(porcelainProblems("?? stray.txt\n").join(" ")).toContain("?? stray.txt");
    expect(porcelainProblems(" M package.json\n").join(" ")).toContain(" M package.json");
  });

  test("the id scan finds a file naming the id in any letter case and passes over the others", () => {
    const texts: Record<string, string> = {
      "/a.ts": 'const engine = "FixtureEngine";',
      "/b.ts": "nothing here",
      "/c.md": "the fixtureengine is mentioned",
    };
    const read = (file: string) => texts[file] as string;
    expect(filesNaming(Object.keys(texts), ["fixtureEngine"], read)).toEqual(["/a.ts", "/c.md"]);
    expect(filesNaming(Object.keys(texts), ["absent"], read)).toEqual([]);
  });

  // Plain writes, reads and a directory walk: both sides are built with path.join and no realpath is taken, so the
  // Windows separator and the macOS /var to /private/var link change nothing, and no mode or line ending is read.
  test("step 7's scan reports a fixture engine id named in a file under packages/", () => {
    const root = mkdtempSync(path.join(tmpdir(), "out-of-tree-naming-"));
    try {
      const write = (parts: readonly string[], text: string): string => {
        const file = path.join(root, ...parts);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
        return file;
      };
      const clean = [
        write(["src", "a.ts"], "export {};\n"),
        write(["bin", "a.mjs"], "export {};\n"),
        write(["scripts", "a.ts"], "export {};\n"),
        write(["vscode-extension", "src", "a.ts"], "export {};\n"),
        write(["packages", "README.md"], "The packages.\n"),
      ];
      const planted = write(
        ["packages", "provider-sdk", "src", "enums.ts"],
        `export type Engine = "${engineId.toUpperCase()}";\n`,
      );
      const ids = fixture.engines.map((engine) => engine.id);

      expect(namingScanFiles(root).sort()).toEqual([...clean, planted].sort());
      expect(filesNaming(namingScanFiles(root), ids, readText)).toEqual([planted]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the build scan finds a file equal to a fixture file or holding a needle across a chunk boundary, and a scan of no file fails", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "out-of-tree-scan-"));
    try {
      const write = (name: string, text: string): string => {
        const file = path.join(directory, name);
        writeFileSync(file, text);
        return file;
      };
      const needles = buildNeedles({ ...fixture, name: "fixture-pkg", engines: [{ id: "fx", displayName: "Fx db" }] });
      expect(needles).toEqual(["fixture-pkg", '"fx"', "'fx'", "`fx`", "Fx db"]);
      const clean = write("clean.js", "a".repeat(40));
      const across = write("across.js", `${"a".repeat(6)}fixture-pkg${"b".repeat(9)}`);
      const quoted = write("quoted.js", `x=${"c".repeat(5)}'fx';`);
      const copy = write("copy.ts", "the fixture's source");
      const digests = new Set([new Bun.CryptoHasher("sha256").update("the fixture's source").digest("hex")]);
      expect(buildScanProblems([clean], needles, digests, 4)).toEqual([]);
      expect(buildScanProblems([across], needles, digests, 4).join(" ")).toContain("fixture-pkg");
      expect(buildScanProblems([quoted], needles, digests, 4).join(" ")).toContain("'fx'");
      expect(buildScanProblems([copy], needles, digests, 4).join(" ")).toContain("copy.ts");
      expect(buildScanProblems([], needles, digests, 4).join(" ")).toContain("no file");
      mkdirSync(path.join(directory, "nested"));
      write(path.join("nested", "deep.js"), "x");
      expect(regularFiles(directory).map((file) => path.basename(file))).toEqual([
        "across.js",
        "clean.js",
        "copy.ts",
        "deep.js",
        "quoted.js",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the out-of-tree acceptance's children", () => {
  test("every child the run starts has a timeout and an environment of its own, without NODE_OPTIONS, NODE_PATH or npm_config variables, and its printed command carries no environment value", () => {
    for (const [kind, timeout] of Object.entries(CHILD_TIMEOUTS_MS)) {
      expect([kind, Number.isFinite(timeout) && timeout > 0]).toEqual([kind, true]);
    }
    const marker = randomUUID();
    const env = { PATH: "/usr/bin", HOME: "/tmp/home", JWT_SECRET: marker };
    const spec = childSpec("npm install", ["npm", "install", "sdk.tgz"], "/tmp/provider", env, 1000);
    expect(spec).toEqual({
      label: "npm install",
      command: ["npm", "install", "sdk.tgz"],
      cwd: "/tmp/provider",
      env,
      timeoutMs: 1000,
    });
    expect(describeChild(spec)).toContain("npm install sdk.tgz");
    expect(describeChild(spec)).not.toContain(marker);
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "npm_config_registry", "NPM_CONFIG_CACHE"]) {
      expect(() => childSpec("x", ["x"], "/", { ...env, [name]: "y" }, 1000)).toThrow(name);
    }
    expect(() => childSpec("x", ["x"], "/", env, 0)).toThrow("timeout");
    expect(() => childSpec("x", ["x"], "/", env, Number.POSITIVE_INFINITY)).toThrow("timeout");
    expect(() => childSpec("x", ["x"], "/", { HOME: "/h" }, 1000)).toThrow("PATH");
    expect(() => childSpec("x", [], "/", env, 1000)).toThrow("command");
  });

  test("the server binds 127.0.0.1 on its port, reads the providers directory by its absolute path, and takes the credentials generated for the run", () => {
    const credentials = { jwtSecret: randomUUID(), adminPassword: randomUUID(), userPassword: randomUUID() };
    const input = {
      path: "/usr/bin",
      home: path.join(tmpdir(), "server", "home"),
      dataDirectory: path.join(tmpdir(), "server", "data"),
      port: 43_210,
      providersDirectory: path.join(tmpdir(), "providers"),
      credentials,
    };
    const env = serverEnvironment(input);
    expect(env.HOSTNAME).toBe("127.0.0.1");
    expect(env.PORT).toBe("43210");
    expect(env[STUDIO.providersDirVariable]).toBe(input.providersDirectory);
    expect(env.JWT_SECRET).toBe(credentials.jwtSecret);
    expect(env.ADMIN_PASSWORD).toBe(credentials.adminPassword);
    expect(env.USER_PASSWORD).toBe(credentials.userPassword);
    expect(env.HOME).toBe(input.home);
    expect(env.SEED_CONFIG_PATH).toBe("");
    expect(env.STORAGE_PROVIDER).toBeUndefined();
    expect(path.dirname(env.STORAGE_SQLITE_PATH as string)).toBe(input.dataDirectory);
    expect(Object.keys(env).some((name) => /^(NODE_OPTIONS|NODE_PATH|npm_config_)/i.test(name))).toBe(false);
    expect(() => serverEnvironment({ ...input, providersDirectory: "providers" })).toThrow("absolute");
  });
});

describe("the Out-of-tree Provider Acceptance job", () => {
  test("runs after the payload job, downloads and extracts the payload under the runner's temporary directory, runs the script with --standalone, and has a timeout", () => {
    const workflow = parseYaml(readText(path.join(ROOT, ".github/workflows/ci.yml"))) as {
      jobs: Record<
        string,
        {
          name?: string;
          needs?: string[];
          "timeout-minutes"?: number;
          steps: { name?: string; uses?: string; run?: string; with?: Record<string, string> }[];
        }
      >;
    };
    const job = workflow.jobs["out-of-tree-acceptance"];
    expect(job).toBeDefined();
    if (job === undefined) return;
    expect(job.name).toBe("Out-of-tree Provider Acceptance");
    expect(job.needs).toEqual(["engine-payload"]);
    expect(job["timeout-minutes"]).toBe(15);
    const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with?.name).toBe("engine-smoke-payload");
    expect(download?.with?.path).toStartWith("${{ runner.temp }}/");
    const extract = job.steps.find((step) => step.run?.includes("tar -xzf"));
    expect(extract?.run).toContain('"$RUNNER_TEMP"/dist-payload/');
    expect(extract?.run).toContain('-C "$RUNNER_TEMP/standalone"');
    const runs = job.steps.filter((step) => step.run?.includes("scripts/out-of-tree-acceptance.ts"));
    expect(runs.map((step) => step.run?.trim())).toEqual([
      'bun scripts/out-of-tree-acceptance.ts --standalone "$RUNNER_TEMP/standalone"',
    ]);
    expect(readdirSync(path.join(ROOT, "scripts"))).toContain("out-of-tree-acceptance.ts");
  });
});
