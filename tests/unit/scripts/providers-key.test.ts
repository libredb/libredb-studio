/**
 * The key command (scripts/providers-key.ts, `bun run providers:key -- --dir <artifact directory>`): it prints the keys
 * a grant register row names a provider package and its engines by, the package's name, version and digest and each
 * engine's `grammarSha256` and `languageSha256`, computed with the lock command's own artifact sequence and the digest
 * functions the server catalog's composer calls, so a row author never hashes by hand; it refuses what the lock refuses
 * and what the SDK's manifest validator refuses, by one sentence, and prints nothing on standard output then.
 *
 * Each case spawns the command from the repository root, as a row author runs it, under a timeout, with `--silent` so
 * that `bun run` adds no line of its own to what the command prints. One case also calls the command's `packageKeys` in
 * process, as the in-repo register row census (tests/unit/db/register-package-row-census.test.ts) does, and holds it
 * to what the command prints. Engine ids are fixture ids, or read from the out-of-tree fixture's manifest.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { PROVIDER_CONTRACT } from "@libredb/provider-sdk/calls";
import type { ProviderManifest } from "@libredb/provider-sdk/manifest";
import { build } from "esbuild";
import { declaredLanguageDataRequest, declaredSqlTextRequest } from "@/lib/db/server-catalog-compose";
import { MANIFEST_FILE_NAME } from "@/lib/provider-host/provider-artifact";
import { contractRefusal, schemaRefusal } from "@/lib/provider-host/provider-refusals";
import { LOCK_FILE_NAME } from "@/lib/provider-host/providers-lock-format";
import {
  ACME_LANGUAGE_DATA,
  type EditableEngine,
  rawManifest,
  VALIDATOR,
  withStatementLanguageData,
} from "../../helpers/package-catalog";
import { artifactDirectoryOf, removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";
import { readFixture } from "../../../scripts/out-of-tree-acceptance";
import { packageKeys } from "../../../scripts/providers-key";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "providers-key.ts");
const FIXTURE = path.join(REPOSITORY_ROOT, "tests", "fixtures", "out-of-tree-provider");
const USAGE = "Usage: bun run providers:key -- --dir <absolute artifact directory>";
const scratch = scratchDirectory("libredb-providers-key-command-");
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
});

/** A new empty providers directory under the scratch root. */
function freshProviders(): string {
  counter += 1;
  const directory = path.join(scratch, `providers-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

interface Run {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `bun run --silent <script> -- <args>` from the repository root, and answers how it ended. */
function runScript(script: string, args: readonly string[]): Run {
  const run = Bun.spawnSync([process.execPath, "run", "--silent", script, "--", ...args], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const runKey = (...args: string[]): Run => runScript("providers:key", args);

/** The digest the lock command writes for the one package of `providers`. */
function lockedDigest(providers: string): string {
  const run = runScript("providers:lock", ["--dir", providers]);
  expect([run.exitCode, run.stderr]).toEqual([0, ""]);
  const lock = JSON.parse(fs.readFileSync(path.join(providers, LOCK_FILE_NAME), "utf8"));
  expect(lock.entries).toHaveLength(1);
  return lock.entries[0].digest;
}

/** The sentence the lock command refuses the one package of `providers` with, its `providers:lock` prefix removed. */
function lockRefusal(providers: string): string {
  const run = runScript("providers:lock", ["--dir", providers]);
  expect([run.exitCode, run.stdout]).toEqual([1, ""]);
  const [line, last, end] = run.stderr.split("\n");
  expect([last, end]).toEqual(["providers:lock wrote nothing", ""]);
  return (line as string).replace(/^providers:lock: /, "");
}

/** A planted package as a test writes it: its package.json, its manifest as JSON, and its files. */
interface Planted {
  readonly name: string;
  readonly version: string;
  readonly manifest: Record<string, unknown>;
  readonly files?: Readonly<Record<string, string>>;
}

/** Writes `pkg` as `<providers>/<name>/<version>/`, with its entry `dist/index.mjs`, and answers its directory. */
function plant(providers: string, pkg: Planted): string {
  const directory = artifactDirectoryOf(providers, pkg);
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module" }, null, 2)}\n`,
    [MANIFEST_FILE_NAME]: `${JSON.stringify(pkg.manifest, null, 2)}\n`,
    "dist/index.mjs": "export default {};\n",
    ...pkg.files,
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(directory, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return directory;
}

/** The manifest the SDK's validator admits for `raw`, or a thrown error naming its first refusal. */
function admitted(raw: unknown): ProviderManifest {
  const verdict = VALIDATOR.validate(raw);
  if (!verdict.admitted) throw new Error(`the planted manifest is refused: ${JSON.stringify(verdict.refusals[0])}`);
  return verdict.manifest;
}

/** The keys the composer computes for each engine of `manifest`, in engine id order. */
function composerKeys(manifest: ProviderManifest) {
  return [...manifest.engines]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((engine) => ({
      engine: engine.id,
      grammarSha256: declaredSqlTextRequest(engine).grammarSha256,
      languageSha256: declaredLanguageDataRequest(engine).languageSha256,
    }));
}

/** The key command's standard output for `pkg` and `engines`. */
function keyOutput(pkg: { name: string; version: string; digest: string }, engines: readonly object[]): string {
  return `${JSON.stringify({ package: pkg, engines }, null, 2)}\n`;
}

describe("the key command", () => {
  test("the key command prints the package's digest and each engine's grammar and language digests", () => {
    // Two engines, listed in the manifest against their id order, whose grammars differ by one fact.
    const raw = rawManifest("acmekeyb");
    const second = structuredClone(raw.engines[0]) as EditableEngine;
    second.id = "acmekeya";
    const grammar = (second.sqlText as Record<string, unknown>).grammar as Record<string, unknown>;
    grammar.dollarTags = false;
    raw.engines.push(second);
    const compatibility = raw.compatibility as Record<string, unknown>[];
    compatibility.push({ ...structuredClone(compatibility[0]), engine: "acmekeya" });
    for (const engine of raw.engines) withStatementLanguageData(engine, ACME_LANGUAGE_DATA);
    const manifest = admitted(raw);
    const expected = composerKeys(manifest);
    expect(expected.map((engine) => engine.engine)).toEqual(["acmekeya", "acmekeyb"]);
    expect(expected[0]?.grammarSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(expected[0]?.grammarSha256).not.toBe(expected[1]?.grammarSha256);
    expect(expected[0]?.languageSha256).toMatch(/^[0-9a-f]{64}$/);

    const providers = freshProviders();
    const pkg = { name: "@acme/keys", version: "1.2.3", manifest: raw };
    const directory = plant(providers, pkg);
    const digest = lockedDigest(providers);

    const run = runKey("--dir", directory);
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(run.stdout).toBe(keyOutput({ name: pkg.name, version: pkg.version, digest }, expected));
    expect(runKey(`--dir=${directory}`).stdout).toBe(run.stdout);
  });

  test("a null sqlText or statementLanguageData prints null for its digest", async () => {
    // The out-of-tree fixture, built with the options of its own build (tests/fixtures/out-of-tree-provider/build.mjs),
    // against the workspace's SDK rather than a packed one, and placed as the pack step places it: its sqlText and
    // statementLanguageData are both null.
    const fixture = readFixture(FIXTURE, (file) => fs.readFileSync(file, "utf8"));
    const providers = freshProviders();
    const artifact = artifactDirectoryOf(providers, fixture);
    fs.mkdirSync(artifact, { recursive: true });
    for (const file of ["package.json", MANIFEST_FILE_NAME]) {
      fs.copyFileSync(path.join(FIXTURE, file), path.join(artifact, file));
    }
    await build({
      entryPoints: [path.join(FIXTURE, fixture.acceptance.entrySource)],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      outfile: path.join(artifact, fixture.entry),
      logLevel: "silent",
    });
    const fixtureManifest = admitted(JSON.parse(fs.readFileSync(path.join(FIXTURE, MANIFEST_FILE_NAME), "utf8")));
    const fixtureKeys = composerKeys(fixtureManifest);
    expect(fixtureKeys).toEqual([
      { engine: (fixture.engines[0] as { id: string }).id, grammarSha256: null, languageSha256: null },
    ]);
    const digest = lockedDigest(providers);
    const run = runKey("--dir", artifact);
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(run.stdout).toBe(keyOutput({ name: fixture.name, version: fixture.version, digest }, fixtureKeys));

    // The SDK's minimal manifest declares a grammar and no statement language data.
    const minimal = rawManifest("acmekeyc");
    const minimalKeys = composerKeys(admitted(minimal));
    expect(minimalKeys).toEqual([
      { engine: "acmekeyc", grammarSha256: expect.stringMatching(/^[0-9a-f]{64}$/), languageSha256: null },
    ]);
    const planted = freshProviders();
    const pkg = { name: "acme-minimal", version: "0.1.0", manifest: minimal };
    const directory = plant(planted, pkg);
    const minimalRun = runKey("--dir", directory);
    expect([minimalRun.exitCode, minimalRun.stderr]).toEqual([0, ""]);
    expect(minimalRun.stdout).toBe(
      keyOutput({ name: pkg.name, version: pkg.version, digest: lockedDigest(planted) }, minimalKeys),
    );
  });

  test("the key command refuses a directory the lock refuses and a manifest the validator refuses, writing nothing to standard output", () => {
    const refusedWith = (directory: string, sentence: string): void => {
      const run = runKey("--dir", directory);
      expect([directory, run.exitCode, run.stdout, run.stderr]).toEqual([directory, 1, "", `${sentence}\n`]);
    };
    const providers = freshProviders();
    const absent = path.join(providers, "absent");
    refusedWith(absent, `providers:key: ${absent}: the artifact directory does not exist`);
    const file = path.join(providers, "notes.txt");
    fs.writeFileSync(file, "not an artifact\n");
    refusedWith(file, `providers:key: ${file}: the artifact directory is not a directory`);

    const minimal = (id: string): Record<string, unknown> => rawManifest(id);
    const noPackageJson = plant(freshProviders(), {
      name: "acme-nopkg",
      version: "1.0.0",
      manifest: minimal("acmenopkg"),
    });
    fs.rmSync(path.join(noPackageJson, "package.json"));
    refusedWith(
      noPackageJson,
      `providers:key: ${noPackageJson}: PROVIDER_IDENTITY_MISMATCH: its package.json is missing, over its byte limit, or not a JSON object`,
    );
    const badName = plant(freshProviders(), {
      name: "acme-badname",
      version: "1.0.0",
      manifest: minimal("acmebadname"),
    });
    fs.writeFileSync(path.join(badName, "package.json"), JSON.stringify({ name: "Acme Bad", version: "1.0.0" }));
    refusedWith(
      badName,
      `providers:key: ${badName}: its package.json names no package name and version in the lock's forms`,
    );

    // Each refused by the lock command too, with the same sentence after its own command's prefix.
    const lockRefused: [Planted, (directory: string) => void][] = [
      [
        { name: "acme-spaced", version: "1.0.0", manifest: minimal("acmespaced"), files: { "with space.txt": "x\n" } },
        () => undefined,
      ],
      [
        { name: "acme-noentry", version: "1.0.0", manifest: minimal("acmenoentry") },
        (directory) => fs.rmSync(path.join(directory, "dist", "index.mjs")),
      ],
      [
        {
          name: "acme-broken",
          version: "1.0.0",
          manifest: minimal("acmebroken"),
          files: { "dist/broken.mjs": "import {\n" },
        },
        () => undefined,
      ],
    ];
    for (const [pkg, edit] of lockRefused) {
      const own = freshProviders();
      const directory = plant(own, pkg);
      edit(directory);
      const sentence = lockRefusal(own);
      expect(sentence).toContain(`${pkg.name} ${pkg.version}: `);
      refusedWith(directory, sentence.startsWith("PROVIDER_") ? sentence : `providers:key: ${sentence}`);
    }

    // A manifest the lock accepts and the validator refuses: a key the schema does not define, and another contract.
    const unknownKey = { ...minimal("acmeunknown"), unknownMember: 1 };
    const verdict = VALIDATOR.validate(unknownKey);
    if (verdict.admitted) throw new Error("the validator admitted a manifest with an unknown key");
    const [first] = verdict.refusals;
    expect(first).toMatchObject({ code: "PROVIDER_SCHEMA_INVALID", rule: "unknown-key" });
    const unknownPackage = { name: "acme-unknown", version: "1.0.0" };
    const unknownProviders = freshProviders();
    const unknownDirectory = plant(unknownProviders, { ...unknownPackage, manifest: unknownKey });
    expect(lockedDigest(unknownProviders)).toMatch(/^sha256:[0-9a-f]{64}$/);
    if (first?.code !== "PROVIDER_SCHEMA_INVALID") throw new Error("the first refusal is not a schema refusal");
    refusedWith(
      unknownDirectory,
      schemaRefusal(unknownPackage, first.rule, first.pointer, verdict.refusals.length - 1).sentence,
    );

    const otherContract = { ...minimal("acmecontract"), contract: "0.2" };
    expect(VALIDATOR.validate(otherContract)).toMatchObject({
      admitted: false,
      refusals: [{ code: "PROVIDER_CONTRACT_UNSUPPORTED" }],
    });
    const contractPackage = { name: "acme-contract", version: "1.0.0" };
    const contractDirectory = plant(freshProviders(), { ...contractPackage, manifest: otherContract });
    refusedWith(contractDirectory, contractRefusal(contractPackage, PROVIDER_CONTRACT).sentence);
  });

  test("packageKeys answers in process what the key command prints", () => {
    // Two engines, as the first case plants them, so the order of the engines is part of what is compared.
    const raw = rawManifest("acmeprocb");
    const second = structuredClone(raw.engines[0]) as EditableEngine;
    second.id = "acmeproca";
    raw.engines.push(second);
    const compatibility = raw.compatibility as Record<string, unknown>[];
    compatibility.push({ ...structuredClone(compatibility[0]), engine: "acmeproca" });
    for (const engine of raw.engines) withStatementLanguageData(engine, ACME_LANGUAGE_DATA);
    const directory = plant(freshProviders(), { name: "@acme/in-process", version: "2.0.0", manifest: raw });

    const run = runKey("--dir", directory);
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(packageKeys(directory)).toEqual(JSON.parse(run.stdout));

    const missing = path.join(freshProviders(), "absent");
    const refused = runKey("--dir", missing);
    expect([refused.exitCode, refused.stdout]).toEqual([1, ""]);
    expect(`${packageKeys(missing)}\n`).toBe(refused.stderr);
  });

  test("a wrong command line prints the key command's usage and exits 2, writing nothing to standard output", () => {
    const directory = freshProviders();
    for (const args of [
      [],
      ["--dir"],
      ["--dir", "relative"],
      ["--dir=relative"],
      ["--dir", directory, "--extra"],
      ["--other"],
      ["--dir="],
    ]) {
      const run = runKey(...args);
      expect([args, run.exitCode, run.stdout, run.stderr]).toEqual([args, 2, "", `${USAGE}\n`]);
    }
  });

  test("the key command runs from the repository only, as providers:key, and imports no engine catalog module", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    expect(manifest.scripts["providers:key"]).toBe("bun scripts/providers-key.ts");
    // The published package holds only these; no path of scripts/ is among them.
    expect(manifest.files).toEqual(["dist", "bin"]);
    const shipped = [
      ...fs
        .readdirSync(path.join(REPOSITORY_ROOT, "bin"), { recursive: true, encoding: "utf8" })
        .map((name) => path.join(REPOSITORY_ROOT, "bin", name)),
      ...fs
        .readdirSync(REPOSITORY_ROOT)
        .filter((name) => name.startsWith("Dockerfile"))
        .map((name) => path.join(REPOSITORY_ROOT, name)),
    ].filter((file) => fs.statSync(file).isFile());
    expect(shipped.length).toBeGreaterThan(3);
    expect(shipped.filter((file) => /providers[-:]key/.test(fs.readFileSync(file, "utf8")))).toEqual([]);

    // The script's own imports, read with Bun's scanner after its `#!` line, which the scanner refuses.
    const source = fs.readFileSync(SCRIPT, "utf8").replace(/^#![^\n]*/, "");
    const specifiers = [
      ...new Set(new Bun.Transpiler({ loader: "ts" }).scanImports(source).map((found) => found.path)),
    ];
    expect(specifiers.sort()).toEqual(
      [
        "../src/lib/db/grammar-digest",
        "../src/lib/db/language-digest",
        "../src/lib/provider-host/lock-refusals",
        "../src/lib/provider-host/provider-artifact",
        "../src/lib/provider-host/provider-refusals",
        "../src/lib/provider-host/providers-lock-format",
        "./providers-lock",
        "@libredb/provider-sdk/calls",
        "@libredb/provider-sdk/manifest",
        "@libredb/provider-sdk/manifest-schema",
        "node:fs",
        "node:path",
      ].sort(),
    );
    expect(
      specifiers.filter((specifier) =>
        /engine-catalog|engine-declarations|server-catalog|studio-held-names|provider-host\/admission/.test(specifier),
      ),
    ).toEqual([]);
  });
});
