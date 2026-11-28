/**
 * A provider package written into a scratch providers directory and admitted through Studio's own boot admission
 * (`bootAdmission` in src/lib/provider-host/boot.ts), for the tests of a package's sessions in the provider factory's
 * editor cache (src/lib/db/factory.ts): its manifest is the SDK's minimal manifest, read by path and never copied
 * (tests/helpers/package-catalog.ts), with its engine id, its calls and any member a case changes replaced; its entry
 * imports nothing, as admission requires, and default-exports a record whose functions each call the hook of the same
 * name a test sets on `globalThis[Symbol.for("libredb-test.<engine id>")]`, so a test decides at run time what the
 * package answers and reads what it received.
 *
 * Each package has its own name and engine id, since the loader's registry keeps every package a process admitted; a
 * test file runs in its own process. Paths are the real paths of the scratch directory (`scratchDirectory`), so the
 * same step is reached on every platform; no file mode, link or line ending is relied on.
 */
import { parseGrantRegister, type RegisterGrants } from "@libredb/grant-register";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { MANIFEST_FILE_NAME } from "@/lib/provider-host/provider-artifact";
import { MODULE_MCP_TOOLS } from "@/lib/agent/languages/mcp";
import { bootAdmission, PROVIDER_IMPORT_DEADLINE_MS } from "@/lib/provider-host/boot";
import { grammarSha256 } from "@/lib/db/grammar-digest";
import { type EngineRecord, installServerCatalog, serverEngine } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { type EditableEngine, packageRow, rawManifest, VALIDATOR } from "./package-catalog";
import { FIXTURE_ENTRY, lockEntryOf, writeArtifact, writeLock } from "./provider-artifacts";

/** The calls a package can offer, by their contract names. */
const FACETS = Object.freeze({
  console: ["cancel", "endScope", "transaction"],
  objects: ["tree", "source"],
  maintenance: ["run", "preview"],
  monitoring: ["panel", "poolStats"],
} as const);

/** A package a case writes. */
export interface SessionPackage {
  /** The package's name, unique in the file. */
  readonly name: string;
  /** Its one engine's id, unique in the file, which names its hooks. */
  readonly engine: string;
  /** The calls it offers beyond execute, by contract name (`console.cancel`); none when left out. */
  readonly offered?: readonly string[];
  /** The execute request fields it honours; none when left out. */
  readonly honours?: readonly string[];
  /** Edits the engine declaration before the manifest is written. */
  readonly edit?: (engine: EditableEngine) => void;
  /** The environment variables its manifest declares. */
  readonly env?: readonly string[];
}

/** The hooks a package's functions call, each set by the test, by the function's name. */
export type SessionHooks = Record<string, (...args: unknown[]) => unknown>;

/** The key of the hooks of `engine`. */
export function hooksKey(engine: string): symbol {
  return Symbol.for(`libredb-test.${engine}`);
}

/** Sets the hooks of `engine`'s package, replacing any it had. */
export function setHooks(engine: string, hooks: SessionHooks): void {
  (globalThis as Record<symbol, unknown>)[hooksKey(engine)] = hooks;
}

/** The manifest of `pkg` as JSON, after its edit. */
function manifestOf(pkg: SessionPackage): Record<string, unknown> {
  const manifest = rawManifest(pkg.engine);
  const offered = new Set(pkg.offered ?? []);
  const calls: Record<string, Record<string, unknown>> = {
    console: { execute: { honours: [...(pkg.honours ?? [])] } },
  };
  for (const [group, names] of Object.entries(FACETS)) {
    calls[group] ??= {};
    for (const name of names) {
      (calls[group] as Record<string, unknown>)[name] = offered.has(`${group}.${name}`) ? "offered" : "not-offered";
    }
  }
  manifest.calls = calls;
  // An engine declares a monitoring panel only where the package offers `monitoring.panel`.
  if (!offered.has("monitoring.panel")) {
    const engine = manifest.engines[0] as EditableEngine;
    const panels = engine.facets.monitoring as Record<string, unknown>;
    for (const panel of Object.keys(panels)) panels[panel] = "not-offered";
  }
  if (pkg.env !== undefined) {
    manifest.runtime = { entry: FIXTURE_ENTRY, env: pkg.env.map((name) => ({ name, purpose: "a test reads it" })) };
  }
  pkg.edit?.(manifest.engines[0] as EditableEngine);
  return manifest;
}

/**
 * The SHA-256 of the grammar `pkg`'s engine declares, read from its manifest as `admitSessionPackages` writes it and
 * admitted by the SDK's validator: the digest a register row names to review that grammar.
 *
 * @throws {Error} Naming the package, for a manifest the validator refuses and for one whose engine states no SQL
 * text, which declares no grammar.
 */
export function declaredGrammarSha256(pkg: SessionPackage): string {
  const verdict = VALIDATOR.validate(manifestOf(pkg));
  if (!verdict.admitted) throw new Error(`the fixture manifest of ${pkg.name} is refused`);
  const sqlText = verdict.manifest.engines[0]?.sqlText;
  if (sqlText === null || sqlText === undefined) {
    throw new Error(`the fixture manifest of ${pkg.name} states no SQL text, so it declares no grammar`);
  }
  return grammarSha256(sqlText.grammar);
}

/** The entry of `pkg`: a record whose every function calls its hook, offering exactly the calls `pkg` offers. */
function entryOf(pkg: SessionPackage, manifest: Record<string, unknown>): string {
  const offered = new Set(pkg.offered ?? []);
  const hook = (name: string) => `(...args) => globalThis[KEY].${name}(...args)`;
  const segment = (group: keyof typeof FACETS, extra: string[] = []) => {
    const members = [...extra, ...FACETS[group].filter((name) => offered.has(`${group}.${name}`))];
    return `{ ${members.map((name) => `${name}: ${hook(name)}`).join(", ")} }`;
  };
  return [
    `const KEY = Symbol.for(${JSON.stringify(`libredb-test.${pkg.engine}`)});`,
    `const manifest = ${JSON.stringify(manifest)};`,
    "const impl = {",
    `  open: ${hook("open")},`,
    `  close: ${hook("close")},`,
    `  health: ${hook("health")},`,
    `  console: ${segment("console", ["execute"])},`,
    `  objects: ${segment("objects")},`,
    `  maintenance: ${segment("maintenance")},`,
    `  monitoring: ${segment("monitoring")},`,
    "};",
    'export default { contract: "0.1", manifest, impl };',
    "",
  ].join("\n");
}

/**
 * Writes `packages` into the providers directory `providers`, locks them, admits them through boot admission and
 * installs the server catalog they compose; answers each package's engine as the catalog holds it. `rows` grants an
 * engine a register row (`packageRow`), keyed by its written lock entry's name, version and digest; the catalog is
 * composed against a register of those rows alone, or against Studio's own register where `rows` names no engine.
 *
 * @throws {Error} When the lock is refused or a package is not admitted, naming it.
 */
export async function admitSessionPackages(
  providers: string,
  packages: readonly SessionPackage[],
  rows: Readonly<Record<string, Partial<RegisterGrants>>> = {},
): Promise<Map<string, EngineRecord>> {
  const entries = packages.map((pkg) => {
    const manifest = manifestOf(pkg);
    const fixture = {
      name: pkg.name,
      version: "1.0.0",
      engines: [pkg.engine],
      files: {
        [MANIFEST_FILE_NAME]: `${JSON.stringify(manifest, null, 2)}\n`,
        [FIXTURE_ENTRY]: entryOf(pkg, manifest),
      },
    };
    writeArtifact(providers, fixture);
    return lockEntryOf(providers, fixture);
  });
  writeLock(providers, entries);
  const granted = entries.flatMap((entry) =>
    entry.engines
      .filter((engine) => Object.hasOwn(rows, engine))
      .map((engine) => packageRow(entry, engine, rows[engine])),
  );
  // One register, read by the catalog's set rules at admission and by the composition.
  const register = granted.length === 0 ? STUDIO_GRANT_REGISTER : parseGrantRegister(granted, LEGACY_ENGINE_IDS);
  const answer = await bootAdmission(providers, PROVIDER_IMPORT_DEADLINE_MS, register, MODULE_MCP_TOOLS);
  if (!answer.read) throw new Error(`the fixture lock is refused: ${answer.refusal.sentence}`);
  if (answer.refused.length > 0) {
    throw new Error(`fixture packages refused: ${answer.refused.map((pkg) => `${pkg.name} ${pkg.code}`).join(", ")}`);
  }
  installServerCatalog(composeServerCatalog(answer.admitted, answer.refused, register));
  const engines = new Map<string, EngineRecord>();
  for (const pkg of packages) {
    const engine = serverEngine(pkg.engine);
    if (engine.kind !== "served") throw new Error(`the engine ${pkg.engine} is not served: ${engine.kind}`);
    engines.set(pkg.engine, engine.engine);
  }
  return engines;
}
