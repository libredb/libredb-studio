/**
 * Admission (src/lib/provider-host/admission.ts): a package that passed its lock is imported only after its manifest
 * (read as bytes, bound to the lock's listing, for Studio's contract, by the SDK's validator), its engine ids, its
 * entry's module format, its import closure and its native addons pass; after the import its record must be the
 * manifest it declared and pass the SDK's check, and only then is Studio's own record of it answered, which
 * `registerAdmission` registers through the loader's `registerAdmitted` once boot's set rules keep it.
 *
 * Every fixture is written by the test into a scratch directory under the system's temporary directory, never under
 * packages/. Each case uses package names and engine ids of its own, because the loader's registry has no reset; this
 * file runs in its own process (tests/run-tests.ts). A refused case whose package must not run proves it with a
 * sentinel: the entry, or a module it plants, writes a file synchronously at its top level, and the file must not
 * exist. No planted module can hang (each only writes a file), and the deadline case is settled by the loader's own
 * timer through a plain `await`, so no case needs a bounded child.
 *
 * Paths are joined with `path.join` and files are written with LF line endings; no case depends on file modes or links
 * except the unreadable-manifest case, which runs only where POSIX file modes exist and the user is not root.
 */
// oxlint-disable no-await-in-loop -- each admission runs after the one before, on purpose: every case reads the process's one registry.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { admitted, type LoadRefusalReason, loadPackage } from "@libredb/provider-loader";
import { PROVIDER_CONTRACT, type ProviderImpl } from "@libredb/provider-sdk/calls";
import { type ManifestValidator, ManifestSchemaDigestError } from "@libredb/provider-sdk/manifest";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import {
  admitPackage,
  HOST_CONTRACT,
  hostManifestValidator,
  type PackageAdmission,
  registerAdmission,
} from "@/lib/provider-host/admission";
import { MANIFEST_FILE_NAME, walkArtifact } from "@/lib/provider-host/provider-artifact";
import {
  LOADER_REFUSAL_REASONS,
  type PackageRefusal,
  PROVIDER_REFUSAL_CODES,
  PROVIDER_REFUSAL_RULES,
} from "@/lib/provider-host/provider-refusals";
import { readProvidersLock, type VerifiedPackage } from "@/lib/provider-host/providers-lock";
import { describeIf, MISSING_POSIX_FILE_MODES } from "../../../helpers/posix-tools";
import {
  lockEntryOf,
  removeScratch,
  scratchDirectory,
  writeArtifact,
  writeLock,
} from "../../../helpers/provider-artifacts";
import { valueImportClosure } from "../../../helpers/value-import-closure";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const SCHEMA_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const MINIMAL_MANIFEST_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/tests/fixtures/minimal-manifest.json");
const SCHEMA_BYTES = fs.readFileSync(SCHEMA_FILE);
const VALIDATOR = hostManifestValidator(SCHEMA_BYTES);
const DEADLINE_MS = 10_000;

const scratch = scratchDirectory("libredb-admission-");
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
});

type Manifest = Record<string, unknown> & {
  engines: Record<string, unknown>[];
  compatibility: Record<string, unknown>[];
  runtime: Record<string, unknown>;
};

/** The SDK's minimal valid manifest, for engine `id` and entry `entry`. */
function manifestFor(id: string, entry = "dist/index.mjs"): Manifest {
  const manifest = JSON.parse(fs.readFileSync(MINIMAL_MANIFEST_FILE, "utf8")) as Manifest;
  (manifest.engines[0] as Record<string, unknown>).id = id;
  (manifest.compatibility[0] as Record<string, unknown>).engine = id;
  manifest.runtime.entry = entry;
  return manifest;
}

/** A case's own names, and the sentinel file its package writes when it runs. */
function names(): { name: string; id: string; sentinel: string } {
  counter += 1;
  return {
    name: `acme-admit-${counter}`,
    id: `acmeadmit${counter}`,
    sentinel: path.join(scratch, `ran-${counter}-${randomUUID()}`),
  };
}

/** The implementation every fixture record carries unless a case says otherwise: the minimal manifest's calls. */
const IMPL = "{ open: f, close: f, health: f, console: { execute: f }, monitoring: { panel: f } }";

/**
 * The text of an entry module that writes `sentinel` at its top level and default-exports a record of `manifest`,
 * changed by `edit` (statements run on `manifest` and `record` before the export), with `impl` as its implementation.
 */
function entrySource(manifest: unknown, sentinel: string, options: { edit?: string; impl?: string } = {}): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
    "const f = () => {};",
    `const manifest = ${JSON.stringify(manifest)};`,
    `const record = { contract: "0.1", manifest, impl: ${options.impl ?? IMPL} };`,
    options.edit ?? "",
    "export default record;",
    "",
  ].join("\n");
}

interface CaseSpec {
  readonly manifest?: Manifest;
  /** The manifest file's text, when it is not `manifest` as JSON. */
  readonly manifestText?: string;
  readonly entry?: string;
  readonly source?: string;
  readonly edit?: string;
  readonly impl?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly id?: string;
}

interface Written {
  readonly name: string;
  readonly id: string;
  readonly sentinel: string;
  readonly providers: string;
  readonly directory: string;
  readonly manifest: Manifest;
}

/** Writes a package of its own names into a fresh providers directory with a lock pinning it, and answers it. */
function write(spec: CaseSpec = {}): Written {
  const own = names();
  const name = spec.name ?? own.name;
  const id = spec.id ?? own.id;
  const entry = spec.entry ?? "dist/index.mjs";
  const manifest = spec.manifest ?? manifestFor(id, entry);
  const providers = path.join(scratch, `providers-${counter}`);
  fs.mkdirSync(providers, { recursive: true });
  const pkg = {
    name,
    version: "1.0.0",
    engines: [id],
    entry,
    files: {
      [MANIFEST_FILE_NAME]: spec.manifestText ?? `${JSON.stringify(manifest, null, 2)}\n`,
      [entry]: spec.source ?? entrySource(manifest, own.sentinel, { edit: spec.edit, impl: spec.impl }),
      ...spec.files,
    },
  };
  const directory = writeArtifact(providers, pkg);
  writeLock(providers, [lockEntryOf(providers, pkg)]);
  return { name, id, sentinel: own.sentinel, providers, directory, manifest };
}

/** The verified package of a written case's lock. */
function verified(written: Written): VerifiedPackage {
  const read = readProvidersLock(written.providers);
  if (!read.read) throw new Error(`the lock was refused: ${read.refusal.sentence}`);
  const [only] = read.packages;
  if (only === undefined || !only.verified) throw new Error(`the lock refused the package: ${JSON.stringify(only)}`);
  return only;
}

/** A verified package built from a walk of `directory`, bypassing the lock's read, for a check the read makes first. */
function verifiedFromWalk(written: Written, overrides: Partial<VerifiedPackage> = {}): VerifiedPackage {
  const walked = walkArtifact(written.directory);
  if (!walked.ok) throw new Error(`the walk refused ${written.directory}`);
  return {
    verified: true,
    name: written.name,
    version: "1.0.0",
    engines: [written.id],
    source: "local",
    digest: "",
    directory: written.directory,
    entryFile: path.join(written.directory, "dist", "index.mjs"),
    files: walked.files,
    imports: [],
    ...overrides,
  };
}

/** Admits `pkg` with the host validator, or `validator`. */
function admit(pkg: VerifiedPackage, validator: ManifestValidator = VALIDATOR): Promise<PackageAdmission> {
  return admitPackage(pkg, { validator, deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });
}

/** The refusal of an admission that must refuse. */
function refusalOf(answer: PackageAdmission): PackageRefusal {
  if (answer.admitted) throw new Error(`${answer.name} was admitted`);
  return answer.refusal;
}

/** `code rule` of an admission, or of the registration of an admitted package, or `registered`. */
async function registered(pkg: VerifiedPackage): Promise<string> {
  const answer = await admit(pkg);
  if (!answer.admitted) return `${answer.refusal.code} ${answer.refusal.rule}`;
  const refusal = registerAdmission(answer);
  return refusal === undefined ? "registered" : `${refusal.code} ${refusal.rule}`;
}

/** `code rule` of an admission that must refuse. */
async function outcome(pkg: VerifiedPackage, validator?: ManifestValidator): Promise<string> {
  const answer = await admit(pkg, validator);
  return answer.admitted ? "admitted" : `${answer.refusal.code} ${answer.refusal.rule}`;
}

/** A validator of the host contract whose every call throws: a case that reaches it fails. */
const UNREACHABLE_VALIDATOR: ManifestValidator = {
  contract: HOST_CONTRACT,
  validate() {
    throw new Error("the schema validator ran");
  },
  validateEngine() {
    throw new Error("the engine validator ran");
  },
};

describe("before the import", () => {
  test("a manifest for another contract major is refused before the schema validator runs", async () => {
    /** A package whose manifest file is the minimal one with `contract` in place of its own, or without one. */
    const withContract = (contract: string | undefined): Written => {
      const own = names();
      const manifest = Object.fromEntries(
        Object.entries(manifestFor(own.id)).filter(([key]) => key !== "contract"),
      ) as Manifest;
      return write({
        name: own.name,
        id: own.id,
        manifestText: JSON.stringify(contract === undefined ? manifest : { ...manifest, contract }),
      });
    };
    for (const contract of ["1.0", "0.2", "10.0"]) {
      const written = withContract(contract);
      const refusal = refusalOf(await admit(verified(written), UNREACHABLE_VALIDATOR));
      expect([contract, refusal.code, refusal.rule]).toEqual([
        contract,
        "PROVIDER_CONTRACT_UNSUPPORTED",
        "contract-not-served",
      ]);
      expect(refusal.sentence).toBe(
        `PROVIDER_CONTRACT_UNSUPPORTED: ${written.name} 1.0.0: its manifest was built against another provider contract than this Studio's, 0.1`,
      );
      expect(fs.existsSync(written.sentinel)).toBe(false);
    }
    // A contract outside the envelope's form, or none, is the validator's to refuse, as a schema refusal.
    for (const contract of ["x", undefined]) {
      const written = withContract(contract);
      const pkg = verified(written);
      await expect(admit(pkg, UNREACHABLE_VALIDATOR)).rejects.toThrow("the schema validator ran");
      const refusal = refusalOf(await admit(pkg));
      expect([refusal.code, refusal.pointer]).toEqual([
        "PROVIDER_SCHEMA_INVALID",
        contract === undefined ? "" : "/contract",
      ]);
      expect(fs.existsSync(written.sentinel)).toBe(false);
    }
  });

  test("a CommonJS entry is refused as PROVIDER_MODULE_FORMAT and its top level never runs", async () => {
    const cases: [string, Record<string, unknown> | null, Record<string, string>][] = [
      ["no type", {}, {}],
      ["type commonjs", { type: "commonjs" }, {}],
      [
        "a nested commonjs scope under a module root",
        { type: "module" },
        { "dist/package.json": '{"type":"commonjs"}\n' },
      ],
      ["a nested scope with no type under a module root", { type: "module" }, { "dist/package.json": "{}\n" }],
      ["a type that is not a string", { type: ["module"] }, {}],
    ];
    for (const [label, root, files] of cases) {
      const own = names();
      const written = write({
        name: own.name,
        id: own.id,
        entry: "dist/index.js",
        files: {
          "package.json": JSON.stringify({ name: own.name, version: "1.0.0", ...root }),
          ...files,
        },
      });
      const refusal = refusalOf(await admit(verified(written)));
      expect([label, refusal.code, refusal.rule]).toEqual([label, "PROVIDER_MODULE_FORMAT", "entry-commonjs"]);
      expect([label, fs.existsSync(written.sentinel)]).toEqual([label, false]);
    }
    const own = names();
    const untyped = write({
      name: own.name,
      id: own.id,
      entry: "dist/index.js",
      files: { "package.json": JSON.stringify({ name: own.name, version: "1.0.0" }) },
    });
    expect(refusalOf(await admit(verified(untyped))).sentence).toBe(
      `PROVIDER_MODULE_FORMAT: ${own.name} 1.0.0: its entry is a .js file whose nearest package.json does not declare "type": "module"`,
    );

    // A nearest package.json over its byte limit, or not a JSON object, is refused as package-scope-unreadable.
    for (const nested of [`{"pad":"${"x".repeat(1024 * 1024)}"}`, "[]", "{"]) {
      const written = write({ entry: "dist/index.js", files: { "dist/package.json": nested } });
      const refusal = refusalOf(await admit(verified(written)));
      expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_MODULE_FORMAT", "package-scope-unreadable"]);
      expect(fs.existsSync(written.sentinel)).toBe(false);
    }
    // A listing without any package.json on the way up, which the lock's read never hands over, declares no type.
    const bare = write({ entry: "dist/index.js" });
    const pkg = verifiedFromWalk(bare, {
      entryFile: path.join(bare.directory, "dist", "index.js"),
      files: verifiedFromWalk(bare).files.filter((file) => file.path !== "package.json"),
    });
    expect(await outcome(pkg)).toBe("PROVIDER_MODULE_FORMAT entry-commonjs");

    // Node.js stops its package scope lookup at a directory named node_modules, on every platform, so a .js entry below
    // one is CommonJS unless a package.json under that directory declares the module type, whatever the root declares.
    const vendored = names();
    const underNodeModules = write({
      name: vendored.name,
      id: vendored.id,
      entry: "node_modules/acme-vendored/index.js",
      files: { "package.json": JSON.stringify({ name: vendored.name, version: "1.0.0", type: "module" }) },
    });
    const vendoredRefusal = refusalOf(await admit(verified(underNodeModules)));
    expect([vendoredRefusal.code, vendoredRefusal.rule]).toEqual(["PROVIDER_MODULE_FORMAT", "entry-commonjs"]);
    expect(fs.existsSync(underNodeModules.sentinel)).toBe(false);
  });

  test("a dependency only an ancestor node_modules holds is refused as closure-outside and its top level never runs", async () => {
    const own = names();
    const planted = `acme-planted-${counter}`;
    const plantedSentinel = path.join(scratch, `planted-${counter}-${randomUUID()}`);
    const plantedDirectory = path.join(scratch, "node_modules", planted);
    fs.mkdirSync(plantedDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(plantedDirectory, "package.json"),
      JSON.stringify({ name: planted, version: "1.0.0", type: "module", main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(plantedDirectory, "index.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(plantedSentinel)}, "ran");\n`,
    );
    const manifest = manifestFor(own.id);
    const written = write({
      name: own.name,
      id: own.id,
      manifest,
      source: `import ${JSON.stringify(planted)};\n${entrySource(manifest, own.sentinel)}`,
    });
    const pkg = verified(written);
    expect(pkg.imports).toContainEqual({ from: "dist/index.mjs", specifier: planted, kind: "import" });

    const refusal = refusalOf(await admit(pkg));
    expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_LOAD_FAILED", "closure-outside"]);
    expect(refusal.sentence).toBe(
      `PROVIDER_LOAD_FAILED: ${own.name} 1.0.0: a module of it imports what its directory does not hold, or in a form admission does not resolve inside it`,
    );
    expect(fs.existsSync(plantedSentinel)).toBe(false);
    expect(fs.existsSync(written.sentinel)).toBe(false);

    // The control: the loader alone, on the same artifact, reaches the planted module, so the fixture would have run it.
    const loaded = await loadPackage(pkg.entryFile, { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });
    expect(loaded.loaded).toBe(true);
    expect(fs.existsSync(plantedSentinel)).toBe(true);
  });

  test("a bare require is refused as closure-outside even when the package's own node_modules holds the folder, since the resolver moves on past it", async () => {
    // The package holds node_modules/<dep>/ without the subpath its CommonJS module requires; Node.js's resolver, and
    // Bun's, then move on to the next node_modules directory up, outside the package, where a planted subpath runs.
    const own = names();
    const dep = `acme-fallthrough-${counter}`;
    const outsideSentinel = path.join(scratch, `fallthrough-${counter}-${randomUUID()}`);
    const outsideDirectory = path.join(scratch, "node_modules", dep);
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDirectory, "sub.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(outsideSentinel)}, "ran");\n`,
    );
    const manifest = manifestFor(own.id);
    const written = write({
      name: own.name,
      id: own.id,
      manifest,
      source: `import "./helper.cjs";\n${entrySource(manifest, own.sentinel)}`,
      files: {
        "dist/helper.cjs": `require(${JSON.stringify(`${dep}/sub`)});\n`,
        [`node_modules/${dep}/package.json`]: JSON.stringify({ name: dep, version: "1.0.0" }),
        [`node_modules/${dep}/index.js`]: "module.exports = {};\n",
      },
    });
    const pkg = verified(written);
    expect(pkg.imports).toContainEqual({ from: "dist/helper.cjs", specifier: `${dep}/sub`, kind: "require" });

    const refusal = refusalOf(await admit(pkg));
    expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_LOAD_FAILED", "closure-outside"]);
    expect(fs.existsSync(outsideSentinel)).toBe(false);
    expect(fs.existsSync(written.sentinel)).toBe(false);

    // The control: the loader alone, on the same artifact, runs the module outside the package.
    const loaded = await loadPackage(pkg.entryFile, { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });
    expect(loaded.loaded).toBe(true);
    expect(fs.existsSync(outsideSentinel)).toBe(true);
  });

  test("a bare import is refused as closure-outside even when the package's own node_modules holds the folder, since Bun's resolver moves on past it", async () => {
    // The package holds node_modules/<dep>/ without the subpath its entry imports. Bun's ES module resolver then moves on
    // to the next node_modules directory up, outside the package, where a planted subpath runs; Node.js's fails at the
    // folder found first. Admission refuses every bare specifier, whichever runtime imports the package.
    const own = names();
    const dep = `acme-esm-fallthrough-${counter}`;
    const outsideSentinel = path.join(scratch, `esm-fallthrough-${counter}-${randomUUID()}`);
    const outsideDirectory = path.join(scratch, "node_modules", dep);
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDirectory, "sub.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(outsideSentinel)}, "ran");\n`,
    );
    const manifest = manifestFor(own.id);
    const written = write({
      name: own.name,
      id: own.id,
      manifest,
      source: `import ${JSON.stringify(`${dep}/sub.mjs`)};\n${entrySource(manifest, own.sentinel)}`,
      files: {
        [`node_modules/${dep}/package.json`]: JSON.stringify({ name: dep, version: "1.0.0", type: "module" }),
        [`node_modules/${dep}/index.mjs`]: "export default {};\n",
      },
    });
    const pkg = verified(written);
    expect(pkg.imports).toContainEqual({ from: "dist/index.mjs", specifier: `${dep}/sub.mjs`, kind: "import" });

    const refusal = refusalOf(await admit(pkg));
    expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_LOAD_FAILED", "closure-outside"]);
    expect(fs.existsSync(outsideSentinel)).toBe(false);
    expect(fs.existsSync(written.sentinel)).toBe(false);

    // The control: the loader alone, on the same artifact and under Bun, runs the module outside the package.
    const loaded = await loadPackage(pkg.entryFile, { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });
    expect(loaded.loaded).toBe(true);
    expect(fs.existsSync(outsideSentinel)).toBe(true);
  });

  test("a package holding a TypeScript file of any kind, a declaration file among them, is refused as PROVIDER_MODULE_FORMAT", async () => {
    // A package of this contract is a JavaScript bundle. Bun maps an extensionless, a .d and a .js specifier onto a
    // TypeScript file, and Node.js's type stripping loads a type-only import Bun's scanner drops, so a TypeScript file
    // in the package could run unseen on either runtime; the listing alone decides, before any import.
    const files = [
      "dist/mod.ts",
      "dist/mod.mts",
      "dist/mod.cts",
      "dist/view.tsx",
      "dist/MOD.TS",
      "lib/deep/mod.Mts",
      "dist/types.d.ts",
      "types/esm.d.mts",
      "types/cjs.D.CTS",
      "types/VIEW.TSX",
    ];
    for (const file of files) {
      const written = write({ files: { [file]: "export declare const x: number;\n" } });
      const refusal = refusalOf(await admit(verified(written)));
      expect([file, refusal.code, refusal.rule]).toEqual([file, "PROVIDER_MODULE_FORMAT", "typescript-module"]);
      expect(refusal.sentence).toBe(
        `PROVIDER_MODULE_FORMAT: ${written.name} 1.0.0: its directory holds a TypeScript file, which a package of this contract, a JavaScript bundle, does not hold`,
      );
      expect(fs.existsSync(written.sentinel)).toBe(false);
    }
  });

  test("an entry importing ./types.d beside a types.d.ts is refused before the import, so the declaration file's import never runs", async () => {
    // Under Bun, `import "./types.d"` resolves to types.d.ts by its extension search and runs it, its runtime imports
    // included; the lock records only the specifier ./types.d, a relative path inside the package. Node.js fails the
    // same import as not found. The outside module is named by its file URL, the same form on every platform.
    const own = names();
    const outsideSentinel = path.join(scratch, `declaration-outside-${counter}-${randomUUID()}`);
    const outsideModule = path.join(scratch, `declaration-outside-${counter}.mjs`);
    fs.writeFileSync(
      outsideModule,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(outsideSentinel)}, "ran");\n`,
    );
    const manifest = manifestFor(own.id);
    const written = write({
      name: own.name,
      id: own.id,
      manifest,
      source: `import "./types.d";\n${entrySource(manifest, own.sentinel)}`,
      files: { "dist/types.d.ts": `import ${JSON.stringify(pathToFileURL(outsideModule).href)};\nexport {};\n` },
    });
    const pkg = verified(written);
    expect(pkg.imports.filter((found) => found.from === "dist/types.d.ts")).toEqual([]);

    const refusal = refusalOf(await admit(pkg));
    expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_MODULE_FORMAT", "typescript-module"]);
    expect(fs.existsSync(outsideSentinel)).toBe(false);
    expect(fs.existsSync(written.sentinel)).toBe(false);

    // The control: the loader alone, on the same artifact and under Bun, runs the module outside the package.
    const loaded = await loadPackage(pkg.entryFile, { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });
    expect(loaded.loaded).toBe(true);
    expect(fs.existsSync(outsideSentinel)).toBe(true);
  });

  test("a .node file in the artifact is refused as PROVIDER_NATIVE_UNSUPPORTED", async () => {
    for (const addon of ["build/Release/addon.node", "lib/ADDON.NODE"]) {
      const written = write({ files: { [addon]: "not really an addon" } });
      const refusal = refusalOf(await admit(verified(written)));
      expect([addon, refusal.code, refusal.rule]).toEqual([addon, "PROVIDER_NATIVE_UNSUPPORTED", "native-file"]);
      expect(refusal.sentence).toBe(
        `PROVIDER_NATIVE_UNSUPPORTED: ${written.name} 1.0.0: its directory holds a native addon, a .node file, which this Studio does not admit yet`,
      );
      expect(fs.existsSync(written.sentinel)).toBe(false);
    }
  });

  test("a manifest declaring native packages is refused as PROVIDER_NATIVE_UNSUPPORTED", async () => {
    const own = names();
    const manifest = manifestFor(own.id);
    manifest.runtime.native = [
      { package: "acme-native", version: "1.0.0", targets: [{ os: "linux", cpu: "x64" }], nodeApi: 8 },
    ];
    const written = write({ name: own.name, id: own.id, manifest });
    const refusal = refusalOf(await admit(verified(written)));
    expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_NATIVE_UNSUPPORTED", "native-declared"]);
    expect(refusal.sentence).toBe(
      `PROVIDER_NATIVE_UNSUPPORTED: ${own.name} 1.0.0: its manifest declares native packages, which this Studio does not admit yet`,
    );
    expect(fs.existsSync(written.sentinel)).toBe(false);
  });

  test("an engine id already served is refused", async () => {
    // A bundled engine id: the lock's read refuses it first, so the package is built from a walk.
    const bundledId = SHIPPED_DATABASE_TYPES[0] as string;
    const bundled = write({ id: bundledId });
    expect(await outcome(verifiedFromWalk(bundled, { engines: [bundledId] }))).toBe(
      "PROVIDER_ID_COLLISION bundled-engine",
    );
    expect(fs.existsSync(bundled.sentinel)).toBe(false);

    // A member every object inherits.
    const inherited = write({ id: "constructor" });
    const inheritedRefusal = refusalOf(await admit(verified(inherited)));
    expect([inheritedRefusal.code, inheritedRefusal.rule]).toEqual(["PROVIDER_ID_COLLISION", "inherited-name"]);
    expect(inheritedRefusal.sentence).toBe(
      `PROVIDER_ID_COLLISION: ${inherited.name} 1.0.0: it serves an engine id that names a member every JavaScript object inherits`,
    );

    // An engine id, then a package name, a package admitted earlier in this process serves.
    const first = write();
    expect(await registered(verified(first))).toBe("registered");
    const sameEngine = write({ id: first.id });
    expect(await outcome(verified(sameEngine))).toBe("PROVIDER_ID_COLLISION registered-engine");
    expect(fs.existsSync(sameEngine.sentinel)).toBe(false);
    const sameName = write({ name: first.name });
    const sameNameRefusal = refusalOf(await admit(verified(sameName)));
    expect([sameNameRefusal.code, sameNameRefusal.rule]).toEqual(["PROVIDER_ID_COLLISION", "registered-package"]);
    expect(sameNameRefusal.sentence).toBe(
      `PROVIDER_ID_COLLISION: ${first.name} 1.0.0: a package of its name was admitted earlier in this process`,
    );
    expect(fs.existsSync(sameName.sentinel)).toBe(false);
  });

  test("two admissions that overlap never register two packages serving one engine id, or one name twice", async () => {
    // Both pass every check of admission; the check registerAdmission makes right before it registers refuses the second.
    const shared = names();
    const pair = [write({ id: shared.id }), write({ id: shared.id })];
    const outcomes = await Promise.all(pair.map((written) => registered(verified(written))));
    expect(outcomes.toSorted()).toEqual(["PROVIDER_ID_COLLISION registered-engine", "registered"]);
    const servingShared = admitted().filter((entry) =>
      (entry.record as { manifest: { engines: { id: string }[] } }).manifest.engines.some((e) => e.id === shared.id),
    );
    expect(servingShared.length).toBe(1);

    const sameName = names();
    const twins = [write({ name: sameName.name }), write({ name: sameName.name })];
    const twinOutcomes = await Promise.all(twins.map((written) => registered(verified(written))));
    expect(twinOutcomes.toSorted()).toEqual(["PROVIDER_ID_COLLISION registered-package", "registered"]);
    expect(admitted().filter((entry) => entry.name === sameName.name).length).toBe(1);
  });

  test("a manifest the schema refuses is refused as PROVIDER_SCHEMA_INVALID, naming the first rule and its pointer and never a key", async () => {
    const own = names();
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const manifest = { ...manifestFor(own.id), [key]: 1 } as Manifest;
    (manifest.engines[0] as Record<string, unknown>)[`${key}x`] = 2;
    const written = write({ name: own.name, id: own.id, manifest });
    const refusal = refusalOf(await admit(verified(written)));
    expect(refusal).toEqual({
      code: "PROVIDER_SCHEMA_INVALID",
      rule: "unknown-key",
      name: own.name,
      version: "1.0.0",
      pointer: "",
      more: 1,
      sentence: `PROVIDER_SCHEMA_INVALID: ${own.name} 1.0.0: its manifest is not one the provider contract admits: unknown-key at the top level, and 1 more`,
    });
    expect(JSON.stringify(refusal).includes(key)).toBe(false);
    expect(fs.existsSync(written.sentinel)).toBe(false);

    const deeper = names();
    const wrongType = manifestFor(deeper.id);
    (wrongType.engines[0] as Record<string, unknown>).displayName = 7;
    const nested = refusalOf(await admit(verified(write({ name: deeper.name, id: deeper.id, manifest: wrongType }))));
    expect([nested.rule, nested.pointer, nested.more]).toEqual(["wrong-type", "/engines/0/displayName", 0]);
    expect(nested.sentence.endsWith("wrong-type at /engines/0/displayName")).toBe(true);

    // A validator's answer of another contract, which the host's pre-check already refuses, is the same refusal; a
    // refusal without a refusal record is a host defect.
    const plain = verified(write());
    const otherContract: ManifestValidator = {
      ...UNREACHABLE_VALIDATOR,
      validate: () => ({ admitted: false, refusals: [{ code: "PROVIDER_CONTRACT_UNSUPPORTED", contract: "0.1" }] }),
    };
    expect(await outcome(plain, otherContract)).toBe("PROVIDER_CONTRACT_UNSUPPORTED contract-not-served");
    const silent: ManifestValidator = { ...UNREACHABLE_VALIDATOR, validate: () => ({ admitted: false, refusals: [] }) };
    await expect(admit(plain, silent)).rejects.toThrow(
      "admitPackage: the manifest validator refused a manifest without a refusal",
    );
  });

  test("a manifest or package.json changed after the lock read is refused as PROVIDER_DIGEST_MISMATCH before any import", async () => {
    const edits: [string, (directory: string) => void][] = [
      ["a byte appended", (d) => fs.appendFileSync(path.join(d, MANIFEST_FILE_NAME), " ")],
      ["removed", (d) => fs.rmSync(path.join(d, MANIFEST_FILE_NAME))],
      [
        "replaced by a directory",
        (d) => {
          fs.rmSync(path.join(d, MANIFEST_FILE_NAME));
          fs.mkdirSync(path.join(d, MANIFEST_FILE_NAME));
        },
      ],
      [
        "grown over its byte limit",
        (d) => fs.appendFileSync(path.join(d, MANIFEST_FILE_NAME), " ".repeat(2 * 1024 * 1024)),
      ],
    ];
    for (const [label, edit] of edits) {
      const written = write();
      const pkg = verified(written);
      edit(written.directory);
      expect([label, await outcome(pkg, UNREACHABLE_VALIDATOR)]).toEqual([
        label,
        "PROVIDER_DIGEST_MISMATCH digest-differs",
      ]);
      expect(fs.existsSync(written.sentinel)).toBe(false);
    }
    // The package.json nearest a .js entry, changed after the lock read.
    const scoped = write({ entry: "dist/index.js", files: { "dist/package.json": '{"type":"module"}\n' } });
    const scopedPkg = verified(scoped);
    fs.writeFileSync(path.join(scoped.directory, "dist", "package.json"), '{"type":"commonjs"}\n');
    expect(await outcome(scopedPkg)).toBe("PROVIDER_DIGEST_MISMATCH digest-differs");
    expect(fs.existsSync(scoped.sentinel)).toBe(false);

    // A listing without the manifest, or one whose manifest is JSON but no object, never comes from the lock's read.
    const unlisted = write();
    expect(
      await outcome(
        verifiedFromWalk(unlisted, {
          files: verifiedFromWalk(unlisted).files.filter((file) => file.path !== MANIFEST_FILE_NAME),
        }),
        UNREACHABLE_VALIDATOR,
      ),
    ).toBe("PROVIDER_DIGEST_MISMATCH digest-differs");
    for (const text of ["[]", "{", "null"]) {
      const notObject = write();
      fs.writeFileSync(path.join(notObject.directory, MANIFEST_FILE_NAME), text);
      const refusal = refusalOf(await admit(verifiedFromWalk(notObject), UNREACHABLE_VALIDATOR));
      expect([text, refusal.code, refusal.rule, refusal.pointer]).toEqual([
        text,
        "PROVIDER_SCHEMA_INVALID",
        "wrong-type",
        "",
      ]);
    }
  });

  test("an unreadable manifest is refused naming its errno, and an error without one is raised", async () => {
    const written = write();
    const pkg = verified(written);
    const plain = new Error("plain");
    const open = spyOn(fs, "openSync").mockImplementation(() => {
      throw plain;
    });
    try {
      await expect(admit(pkg)).rejects.toBe(plain);
    } finally {
      open.mockRestore();
    }
    const coded = Object.assign(new Error("coded"), { code: "EIO" });
    const failing = spyOn(fs, "openSync").mockImplementation(() => {
      throw coded;
    });
    try {
      const refusal = refusalOf(await admit(pkg));
      expect([refusal.code, refusal.rule, refusal.errno]).toEqual([
        "PROVIDER_DIGEST_MISMATCH",
        "artifact-unreadable",
        "EIO",
      ]);
      expect(refusal.sentence).toBe(
        `PROVIDER_DIGEST_MISMATCH: ${written.name} 1.0.0: its directory could not be read (EIO)`,
      );
    } finally {
      failing.mockRestore();
    }
    expect(fs.existsSync(written.sentinel)).toBe(false);
  });

  describeIf(MISSING_POSIX_FILE_MODES, "file modes", () => {
    test("a manifest without read permission is refused as artifact-unreadable, EACCES", async () => {
      if (process.getuid?.() === 0) return;
      const written = write();
      const pkg = verified(written);
      const manifest = path.join(written.directory, MANIFEST_FILE_NAME);
      fs.chmodSync(manifest, 0o000);
      try {
        const refusal = refusalOf(await admit(pkg));
        expect([refusal.rule, refusal.errno]).toEqual(["artifact-unreadable", "EACCES"]);
      } finally {
        fs.chmodSync(manifest, 0o644);
      }
    });
  });
});

describe("the host contract", () => {
  test("HOST_CONTRACT is the contract the schema serves and the SDK's PROVIDER_CONTRACT", () => {
    const schema = JSON.parse(SCHEMA_BYTES.toString("utf8"));
    expect(HOST_CONTRACT).toBe("0.1");
    expect(schema.properties.contract.const).toBe(HOST_CONTRACT);
    expect(VALIDATOR.contract).toBe(HOST_CONTRACT);
    expect(PROVIDER_CONTRACT).toBe(HOST_CONTRACT);
  });

  test("a validator for another contract is a host defect, refused before any file is read", async () => {
    const pkg = verifiedFromWalk(write(), { directory: path.join(scratch, "absent"), files: [] });
    await expect(admit(pkg, { ...UNREACHABLE_VALIDATOR, contract: "0.2" })).rejects.toThrow(
      new TypeError("admitPackage: the validator serves provider contract 0.2, and this Studio serves 0.1"),
    );
    expect(() => hostManifestValidator(new TextEncoder().encode("{}"))).toThrow(ManifestSchemaDigestError);
  });
});

describe("the import and the record", () => {
  test("an .mjs entry and a .js entry under a package.json of type module are admitted", async () => {
    const mjs = write();
    expect(await outcome(verified(mjs))).toBe("admitted");
    expect(fs.existsSync(mjs.sentinel)).toBe(true);
    const js = write({ entry: "lib/index.js" });
    expect(await outcome(verified(js))).toBe("admitted");
    const own = names();
    const nestedScope = write({
      name: own.name,
      id: own.id,
      entry: "dist/esm/index.js",
      files: {
        "package.json": JSON.stringify({ name: own.name, version: "1.0.0" }),
        "dist/package.json": '{"type":"module"}\n',
      },
    });
    expect(await outcome(verified(nestedScope))).toBe("admitted");
    // A package.json under the node_modules directory is the scope of an entry below it.
    const vendored = names();
    const vendoredScope = write({
      name: vendored.name,
      id: vendored.id,
      entry: "node_modules/acme-vendored/index.js",
      files: {
        "package.json": JSON.stringify({ name: vendored.name, version: "1.0.0" }),
        "node_modules/acme-vendored/package.json": '{"type":"module"}\n',
      },
    });
    expect(await outcome(verified(vendoredScope))).toBe("admitted");
  });

  test("a record whose manifest differs from its file is refused", async () => {
    const marker = (): string => path.join(scratch, `trap-${randomUUID()}`);
    const traps: string[] = [];
    const trapped = (statement: (file: string) => string): string => {
      const file = marker();
      traps.push(file);
      return statement(JSON.stringify(file));
    };
    const edits: [string, string][] = [
      [
        "a changed value",
        'record.manifest = { ...manifest, engines: [{ ...manifest.engines[0], displayName: "Other" }] };',
      ],
      ["an extra key", "record.manifest = { ...manifest, vendor: { acme: true } };"],
      ["a missing key", "const { compatibility, ...rest } = manifest; record.manifest = rest;"],
      ["a symbol key", 'manifest[Symbol("extra")] = 1;'],
      ["a renamed key", "const { calls, ...rest } = manifest; record.manifest = { ...rest, callz: calls };"],
      ["a list in place of a record", "record.manifest = { ...manifest, runtime: [manifest.runtime] };"],
      ["a record in place of a list", "record.manifest = { ...manifest, engines: { ...manifest.engines } };"],
      ["a string in place of a record", 'record.manifest = { ...manifest, calls: "calls" };'],
      [
        "an array with a trailing hole",
        "record.manifest = { ...manifest, engines: Object.assign([...manifest.engines], { length: manifest.engines.length + 1 }) };",
      ],
      [
        "an array-like record",
        "record.manifest = { ...manifest, engines: Object.assign(Object.create(Array.prototype), manifest.engines, { length: 1 }) };",
      ],
      ["a class instance", "record.manifest = Object.assign(new (class Manifest {})(), manifest);"],
      [
        "an accessor whose getter writes a file",
        trapped(
          (file) =>
            `const runtime = manifest.runtime; Object.defineProperty(manifest, "runtime", { enumerable: true, get() { writeFileSync(${file}, "ran"); return runtime; } });`,
        ),
      ],
      [
        "an accessor in place of the record's manifest",
        trapped(
          (file) =>
            `Object.defineProperty(record, "manifest", { enumerable: true, get() { writeFileSync(${file}, "ran"); return manifest; } });`,
        ),
      ],
      [
        "a Proxy whose traps write a file",
        trapped(
          (file) =>
            `record.manifest = new Proxy(manifest, Object.fromEntries(["get", "has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"].map((trap) => [trap, (...args) => { writeFileSync(${file}, trap); return Reflect[trap](...args); }])));`,
        ),
      ],
    ];
    for (const [label, edit] of edits) {
      const written = write({ edit });
      const refusal = refusalOf(await admit(verified(written)));
      expect([label, refusal.code, refusal.rule]).toEqual([label, "PROVIDER_RECORD_INVALID", "manifest-differs"]);
      expect(refusal.sentence).toBe(
        `PROVIDER_RECORD_INVALID: ${written.name} 1.0.0: its record's manifest differs from its libredb-provider.json`,
      );
    }
    for (const trap of traps) expect([trap, fs.existsSync(trap)]).toEqual([trap, false]);

    // Key order, and a record without a prototype, are no difference.
    const reordered = write({
      edit: "record.manifest = Object.assign(Object.create(null), Object.fromEntries(Object.entries(manifest).reverse()));",
    });
    expect(await outcome(verified(reordered))).toBe("admitted");
  });

  test("a record the SDK's check refuses is refused as PROVIDER_RECORD_INVALID, naming the rule", async () => {
    const missing = write({ impl: "{ open: f, close: f, health: f, console: {}, monitoring: {} }" });
    const refusal = refusalOf(await admit(verified(missing)));
    expect([refusal.code, refusal.rule, refusal.more]).toEqual(["PROVIDER_RECORD_INVALID", "call-missing", 1]);
    expect(refusal.sentence).toBe(
      `PROVIDER_RECORD_INVALID: ${missing.name} 1.0.0: its record is not one the provider contract admits: call-missing, and 1 more`,
    );
    const notARecord = write({ impl: "5" });
    expect(await outcome(verified(notARecord))).toBe("PROVIDER_RECORD_INVALID call-missing");
    const contract = write({ edit: 'record.contract = "0.2";' });
    const contractRefusal = refusalOf(await admit(verified(contract)));
    expect([contractRefusal.rule, contractRefusal.more]).toEqual(["contract-not-served", 0]);
    expect(contractRefusal.sentence.endsWith("contract-not-served")).toBe(true);
  });

  test("an implementation or a segment that is a Proxy is refused, and none of its traps runs", async () => {
    const traps: string[] = [];
    const proxy = (target: string): string => {
      const file = path.join(scratch, `trap-${randomUUID()}`);
      traps.push(file);
      return `new Proxy(${target}, Object.fromEntries(["get", "has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "isExtensible", "preventExtensions"].map((trap) => [trap, (...args) => { writeFileSync(${JSON.stringify(file)}, trap); return Reflect[trap](...args); }])))`;
    };
    for (const impl of [
      proxy("{ open: f, close: f, health: f, console: { execute: f }, monitoring: { panel: f } }"),
      `{ open: f, close: f, health: f, console: ${proxy("{ execute: f }")}, monitoring: { panel: f } }`,
      `{ open: f, close: f, health: f, console: { execute: f }, monitoring: ${proxy("{ panel: f }")} }`,
    ]) {
      const written = write({ impl });
      const refusal = refusalOf(await admit(verified(written)));
      expect([refusal.code, refusal.rule]).toEqual(["PROVIDER_RECORD_INVALID", "record-proxy"]);
      expect(refusal.sentence).toBe(
        `PROVIDER_RECORD_INVALID: ${written.name} 1.0.0: its record's implementation is a Proxy`,
      );
    }
    for (const trap of traps) expect([trap, fs.existsSync(trap)]).toEqual([trap, false]);
  });

  test("a loader refusal is the package's PROVIDER_LOAD_FAILED with the loader's reason, its cause kept out of the sentence", async () => {
    const message = randomUUID();
    const throwing = write({ source: `throw new Error(${JSON.stringify(message)});\n` });
    const answer = await admit(verified(throwing));
    expect(answer.admitted).toBe(false);
    if (answer.admitted) return;
    expect([answer.refusal.code, answer.refusal.rule]).toEqual(["PROVIDER_LOAD_FAILED", "import-threw"]);
    expect(answer.refusal.sentence).toBe(
      `PROVIDER_LOAD_FAILED: ${throwing.name} 1.0.0: its entry threw while it was imported`,
    );
    expect(answer.cause).toBeInstanceOf(Error);
    expect((answer.cause as Error).message).toBe(message);
    expect(JSON.stringify(answer.refusal).includes(message)).toBe(false);

    // An entry that has not finished importing by its deadline: the loader's own timer settles it.
    const gate = Symbol.for(`acme-admission-gate-${randomUUID()}`);
    let open: () => void = () => undefined;
    (globalThis as Record<symbol, unknown>)[gate] = new Promise<void>((resolve) => {
      open = resolve;
    });
    const late = write({
      source: `await globalThis[Symbol.for(${JSON.stringify(gate.description)})];\nexport default {};\n`,
    });
    let settled: () => void = () => undefined;
    const lateSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const lateAnswer = await admitPackage(verified(late), {
      validator: VALIDATOR,
      deadlineMs: 50,
      onLateSettle: () => settled(),
    });
    expect(lateAnswer.admitted || [lateAnswer.refusal.code, lateAnswer.refusal.rule, "cause" in lateAnswer]).toEqual([
      "PROVIDER_LOAD_FAILED",
      "deadline-passed",
      false,
    ]);
    open();
    await lateSettled;
    expect(admitted().some((record) => record.name === late.name)).toBe(false);

    const noDefault = write({ source: "export const named = 1;\n" });
    expect(await outcome(verified(noDefault))).toBe("PROVIDER_LOAD_FAILED default-missing");
  });

  test("a package passing admission is answered with Studio's record of its implementation and its file's manifest, which registerAdmission registers through registerAdmitted", async () => {
    const written = write({ edit: "globalThis[Symbol.for(manifest.engines[0].id)] = record;" });
    const answer = await admit(verified(written));
    expect(answer.admitted).toBe(true);
    if (!answer.admitted) return;
    // Admission registers nothing: boot registers only the packages the catalog's set rules keep.
    expect(admitted().some((entry) => entry.name === written.name)).toBe(false);
    expect(registerAdmission(answer)).toBeUndefined();
    const packageRecord = (globalThis as Record<symbol, unknown>)[Symbol.for(written.id)] as Record<string, unknown>;
    const registeredRecord = admitted().find((entry) => entry.name === written.name);
    expect(registeredRecord?.record).toBe(answer.record);
    expect(answer.record).not.toBe(packageRecord);
    expect(answer.record.manifest).toBe(answer.manifest);
    expect(answer.record.manifest).not.toBe(packageRecord.manifest);
    expect(answer.record.impl).toBe(packageRecord.impl as ProviderImpl<unknown>);
    expect(answer.record.contract).toBe("0.1");
    expect(Object.isFrozen(answer.record)).toBe(true);
    expect(Object.isFrozen(answer.record.impl)).toBe(true);
    const impl = answer.record.impl as unknown as Record<string, object>;
    expect([Object.isFrozen(impl.console), Object.isFrozen(impl.monitoring)]).toEqual([true, true]);
    expect(answer).toMatchObject({ admitted: true, name: written.name, version: "1.0.0", engines: [written.id] });
    expect(Object.isFrozen(answer)).toBe(true);
  });

  test("the admitted manifest is deep-frozen", async () => {
    const own = names();
    const manifest = manifestFor(own.id);
    manifest.vendor = { acme: { nested: [{ deeper: { list: [1, 2, { last: true }] } }] } };
    const written = write({ name: own.name, id: own.id, manifest });
    const answer = await admit(verified(written));
    expect(answer.admitted).toBe(true);
    if (!answer.admitted) return;
    expect(answer.manifest).toEqual(
      JSON.parse(fs.readFileSync(path.join(written.directory, MANIFEST_FILE_NAME), "utf8")),
    );
    const pending: unknown[] = [answer.manifest];
    let objects = 0;
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null) continue;
      objects += 1;
      expect(Object.isFrozen(value)).toBe(true);
      pending.push(...Object.values(value));
    }
    expect(objects).toBeGreaterThan(50);
  });

  test("a package naming functions in every slot, none of which Studio's tables hold, is admitted", async () => {
    const own = names();
    const manifest = manifestFor(own.id);
    const engine = manifest.engines[0] as Record<string, Record<string, unknown>>;
    const fresh = (slot: string): string => `acme${slot}${counter}`;
    const writing = engine.sqlWriting as Record<string, unknown>;
    for (const slot of ["escapeLiteral", "unescapeLiteral", "quoteIdentifier"]) writing[slot] = fresh(slot);
    (writing.export as Record<string, unknown>).binaryLiteral = fresh("binaryLiteral");
    const ddl = engine.migrationDdl as Record<string, unknown>;
    for (const slot of ["columnDef", "createIndex", "dropIndex", "addColumn", "dropTable"]) ddl[slot] = fresh(slot);
    const generators = engine.sqlGenerators as Record<string, unknown>;
    generators.quote = fresh("quote");
    generators.selectList = fresh("selectList");
    const written = write({ name: own.name, id: own.id, manifest });
    expect(await outcome(verified(written))).toBe("admitted");
  });

  test("admission refuses no claim request and grants none", async () => {
    const own = names();
    const manifest = manifestFor(own.id);
    const engine = manifest.engines[0] as Record<string, Record<string, unknown>>;
    // The minimal manifest requests looser claims than their restrictive values.
    expect([
      engine.policy?.readsFileAccessPosture,
      engine.policy?.agentCredentialForm,
      engine.mcp?.metadataReadChangesState,
    ]).toEqual([false, "pair", false]);
    const answer = await admit(verified(write({ name: own.name, id: own.id, manifest })));
    expect(answer.admitted).toBe(true);
    if (!answer.admitted) return;
    expect<unknown>(answer.manifest.engines[0]?.policy).toEqual(engine.policy);
    expect(Object.keys(answer).sort()).toEqual(["admitted", "engines", "manifest", "name", "record", "version"]);
    expect(Object.keys(answer.record).sort()).toEqual(["contract", "impl", "manifest"]);
  });
});

describe("what admission carries and reaches", () => {
  test("no refusal carries a value read from the package beyond its name and version", async () => {
    const markers = Array.from({ length: 6 }, () => randomUUID().replaceAll("-", ""));
    const refusals: PackageRefusal[] = [];
    const answers: unknown[] = [];
    const refuse = async (pkg: VerifiedPackage): Promise<void> => {
      const answer = await admit(pkg);
      answers.push(answer.admitted ? answer : { ...answer, cause: undefined });
      refusals.push(refusalOf(answer));
    };

    const top = names();
    await refuse(
      verified(
        write({ name: top.name, id: top.id, manifest: { ...manifestFor(top.id), [`k${markers[0]}`]: 1 } as Manifest }),
      ),
    );
    await refuse(
      verified(
        write({
          impl: `{ open: f, close: f, health: f, console: { execute: f }, monitoring: { panel: f }, k${markers[1]}: f }`,
        }),
      ),
    );
    const contract = names();
    await refuse(
      verified(
        write({ name: contract.name, id: contract.id, manifest: { ...manifestFor(contract.id), contract: "0.31337" } }),
      ),
    );
    await refuse(
      verified(write({ edit: `record.manifest = { ...manifest, vendor: { v${markers[2]}: "${markers[2]}" } };` })),
    );
    await refuse(verified(write({ source: `throw new Error("${markers[3]}");\n` })));
    await refuse(verified(write({ files: { [`dist/m${markers[4]}.mjs`]: `import "p${markers[4]}";\n` } })));
    const engine = names();
    const engineId = `e${markers[5]?.slice(0, 31)}`;
    await refuse(verified(write({ name: engine.name, id: engineId, files: { "addon.node": "" } })));

    const text = JSON.stringify(answers);
    for (const marker of [...markers, engineId, "31337"])
      expect([marker, text.includes(marker)]).toEqual([marker, false]);
    for (const refusal of refusals) {
      expect(refusal.sentence.startsWith(`${refusal.code}: ${refusal.name} 1.0.0: `)).toBe(true);
      expect(refusal.sentence.includes("\n")).toBe(false);
    }
  });

  test("the admission codes join the closed list, each with its closed rules, and the loader's reasons are the loader's", () => {
    expect(PROVIDER_REFUSAL_CODES).toEqual([
      "PROVIDER_LOCK_INVALID",
      "PROVIDER_PATH_OUTSIDE",
      "PROVIDER_DIGEST_MISMATCH",
      "PROVIDER_IDENTITY_MISMATCH",
      "PROVIDER_ID_COLLISION",
      "PROVIDER_CONTRACT_UNSUPPORTED",
      "PROVIDER_SCHEMA_INVALID",
      "PROVIDER_MODULE_FORMAT",
      "PROVIDER_LOAD_FAILED",
      "PROVIDER_NATIVE_UNSUPPORTED",
      "PROVIDER_RECORD_INVALID",
      "PROVIDER_CATALOG_CONFLICT",
    ]);
    expect(Object.keys(PROVIDER_REFUSAL_RULES).sort()).toEqual([...PROVIDER_REFUSAL_CODES].sort());
    for (const rules of Object.values(PROVIDER_REFUSAL_RULES)) {
      expect(Object.isFrozen(rules)).toBe(true);
      expect(new Set(rules).size).toBe(rules.length);
    }
    expect(PROVIDER_REFUSAL_RULES.PROVIDER_ID_COLLISION).toEqual([
      "bundled-engine",
      "shared-engine",
      "registered-engine",
      "registered-package",
      "inherited-name",
    ]);
    expect(PROVIDER_REFUSAL_RULES.PROVIDER_MODULE_FORMAT).toEqual([
      "entry-commonjs",
      "package-scope-unreadable",
      "typescript-module",
    ]);
    expect(PROVIDER_REFUSAL_RULES.PROVIDER_LOAD_FAILED).toEqual(["closure-outside", ...LOADER_REFUSAL_REASONS]);
    // The loader's declared reasons and this list are the same set, held both ways by the type checker.
    const fromLoader: readonly (typeof LOADER_REFUSAL_REASONS)[number][] = [] as LoadRefusalReason[];
    const toLoader: readonly LoadRefusalReason[] = LOADER_REFUSAL_REASONS;
    expect([fromLoader, toLoader.length]).toEqual([[], 5]);
  });

  test("only src/lib/provider-host/admission.ts imports the loader's loadPackage and registerAdmitted", () => {
    const sources = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "bin", "scripts", "vscode-extension/src"],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && fs.existsSync(path.join(REPOSITORY_ROOT, file)));
    const importers = sources
      .filter((file) => {
        const text = fs.readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");
        return /["']@libredb\/provider-loader["']/.test(text) && /\b(?:loadPackage|registerAdmitted)\b/.test(text);
      })
      .sort();
    expect(importers).toEqual(["src/lib/provider-host/admission.ts"]);
  });

  test("admission reads no table of Studio's keyed by engine id", () => {
    const closure = valueImportClosure("src/lib/provider-host/admission.ts");
    const forbidden = [
      "src/lib/db/sql-writing/",
      "src/lib/db/connection-form.ts",
      "src/lib/db/connection-string/",
      "src/lib/db/migration-ddl/",
      "src/lib/db/query-generators/",
      "src/lib/db/sql-grammar/",
      "src/lib/db/claim-grants.ts",
      "src/lib/agent/",
    ];
    expect(closure.modules.filter((module) => forbidden.some((prefix) => module.startsWith(prefix)))).toEqual([]);
    // The engine catalog's modules admission reaches are only those `isDatabaseType` reaches, the bundled-id check.
    const catalog = (modules: readonly string[]): string[] =>
      modules.filter((module) => module.startsWith("src/lib/db/engine-catalog/")).sort();
    expect(catalog(closure.modules)).toEqual(catalog(valueImportClosure("src/lib/db/type-id.ts").modules));
    // A control on the walk: admission reaches the closure check and the lock's format.
    expect(closure.modules).toContain("src/lib/provider-host/provider-closure.ts");
  });
});
