/**
 * Admitted provider packages for the tests of the server's engine catalog (src/lib/db/server-catalog.ts and
 * src/lib/db/server-catalog-compose.ts), built in memory: a manifest is the SDK's minimal valid manifest, read by path
 * and never copied, with its engine id replaced and any member a case changes, admitted by the SDK's validator and
 * deep-frozen as admission freezes it. No file is written and no package is imported.
 *
 * Engine ids here are fixture ids of the form `acme<case>`, never one the bundled catalog serves. A package's digest is
 * generated at run time unless a case names one, and a register row a case grants it is built by `packageRow`, every
 * member it does not name at its claim's restrictive value.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RegisterGrants, RegisterRow } from "@libredb/grant-register";
import type { ProviderImpl } from "@libredb/provider-sdk/calls";
import type { ProviderManifest, StatementLanguageData } from "@libredb/provider-sdk/manifest";
import {
  type EngineGrants,
  STUDIO_GRANT_REGISTER,
  UNGRANTED_DENIED_FILE_ACCESS_SENTENCE,
  UNGRANTED_SSH_TUNNEL_SENTENCE,
} from "@/lib/db/claim-grants";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { hostManifestValidator } from "@/lib/provider-host/admission";
import {
  type EngineRecord,
  forgetServerCatalog,
  installServerCatalog,
  type ServerCatalog,
} from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..");
const SCHEMA_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const MINIMAL_MANIFEST_FILE = path.join(REPOSITORY_ROOT, "packages/provider-sdk/tests/fixtures/minimal-manifest.json");

/** The host's validator, compiled once for the file. */
export const VALIDATOR = hostManifestValidator(readFileSync(SCHEMA_FILE));

/** A manifest's engine declaration as a case edits it, every member loosely typed. */
export type EditableEngine = Record<string, Record<string, unknown>> & { id: string };

/** The SDK's minimal manifest as JSON, with one engine of id `id`, before validation. */
export function rawManifest(id: string): { engines: EditableEngine[] } & Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(MINIMAL_MANIFEST_FILE, "utf8")) as {
    engines: EditableEngine[];
    compatibility: Record<string, unknown>[];
  } & Record<string, unknown>;
  (manifest.engines[0] as EditableEngine).id = id;
  (manifest.compatibility[0] as Record<string, unknown>).engine = id;
  return manifest;
}

/** `value` frozen with every object and array it holds. */
function deepFrozen<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next !== "object" || next === null || Object.isFrozen(next)) continue;
    Object.freeze(next);
    pending.push(...Object.values(next));
  }
  return value;
}

/**
 * The minimal manifest for engine `id`, changed by `edit`, admitted by the SDK's validator and deep-frozen.
 *
 * @throws {Error} Naming the first refusal, for a manifest the validator refuses.
 */
export function admittedManifest(
  id: string,
  edit: (engine: EditableEngine) => void = () => undefined,
): ProviderManifest {
  const raw = rawManifest(id);
  edit(raw.engines[0] as EditableEngine);
  const verdict = VALIDATOR.validate(raw);
  if (!verdict.admitted) {
    throw new Error(`the fixture manifest of ${id} is refused: ${JSON.stringify(verdict.refusals.slice(0, 3))}`);
  }
  return deepFrozen(verdict.manifest);
}

/** A digest of a package's files in the lock's form, `sha256:` and 64 hex characters, generated at run time. */
export function generatedDigest(): string {
  return `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
}

/**
 * An admitted package named `name` serving `manifest`'s engines, as boot hands it to the composer: version 1.0.0 and a
 * digest generated at run time unless `options` names them.
 */
export function admittedFor(
  name: string,
  manifest: ProviderManifest,
  options: { readonly version?: string; readonly digest?: string } = {},
): AdmittedForCatalog {
  return Object.freeze({
    name,
    version: options.version ?? "1.0.0",
    digest: options.digest ?? generatedDigest(),
    directory: path.join(REPOSITORY_ROOT, "never-read", name),
    manifest,
    record: Object.freeze({ contract: "0.1", manifest, impl: Object.freeze({}) as ProviderImpl<unknown> }),
  });
}

/**
 * Every member of a register row's grants at its claim's restrictive value, the three host members at the value an
 * engine with no row reads, no reviewed grammar, `grammarSha256` null, and no reviewed statement language data,
 * `languageSha256` null: `serverLevelWithoutDatabase` false, the
 * restrictive value at the choice of database, since its two gates read it at opposite values.
 */
const RESTRICTIVE_ROW: RegisterGrants = Object.freeze({
  writeReach: "open",
  readsFileAccessPosture: true,
  deniedFileAccessRefusal: UNGRANTED_DENIED_FILE_ACCESS_SENTENCE,
  singleWriterFile: false,
  readRootsRequired: true,
  agentCredentialForm: "none",
  maskingExemptColumns: null,
  exposable: false,
  statementRead: false,
  metadataReadChangesState: true,
  agentCredentialRequired: true,
  opensLocalFile: true,
  hostPathFields: Object.freeze([]),
  serverLevelWithoutDatabase: false,
  sshTunnel: UNGRANTED_SSH_TUNNEL_SENTENCE,
  agentCredential: null,
  statementLanguage: null,
  agentReadings: Object.freeze([]),
  catalogReadCommandShaped: false,
  servesOneSession: null,
  agentExecution: false,
  ownWords: "code-only",
  redaction: Object.freeze({ kind: "none" }),
  readsSqlText: true,
  confirmExemptForms: Object.freeze([]),
  decidesAlone: false,
  grammarSha256: null,
  languageSha256: null,
});

/**
 * A register row for engine `engine` of package `pkg`, keyed by its name, version and digest, granting `grants` and
 * every other member at `RESTRICTIVE_ROW`'s value.
 */
export function packageRow(
  pkg: Pick<AdmittedForCatalog, "name" | "version" | "digest">,
  engine: string,
  grants: Partial<RegisterGrants> = {},
): RegisterRow {
  return {
    package: { name: pkg.name, version: pkg.version, digest: pkg.digest },
    engine,
    grants: { ...RESTRICTIVE_ROW, ...grants },
  };
}

/**
 * The loosest request of every claim the SDK's validator admits for an engine, each opposite its restrictive value:
 * postgres's agent segment and monitoring panels, read from its declaration, so its statement language is `sql`.
 */
export function withLoosestClaims(engine: EditableEngine): void {
  const postgres = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, "src/lib/db/engine-declarations/postgres.json"), "utf8"),
  ) as { agent: unknown; facets: Record<string, unknown> };
  engine.policy = {
    writeReach: "none",
    readsFileAccessPosture: false,
    deniedFileAccessRefusal: null,
    singleWriterFile: true,
    readRootsRequired: false,
    agentCredentialForm: "pair",
    maskingExemptColumns: { column: "^acme_id$", reason: "An opaque id no rule needs to mask." },
  };
  // Write reach is the summary of the write paths, so a request of none states every path absent.
  const absent = { reach: "absent", proof: { module: "src/read-only.ts", symbol: "readOnly" } };
  engine.safeguards = {
    ...engine.safeguards,
    writePaths: { editor: absent, objectEdit: absent, maintenance: absent, transaction: absent },
  };
  engine.mcp = {
    exposable: true,
    statementRead: true,
    metadataReadChangesState: false,
    agentCredentialRequired: false,
  };
  engine.connection.sshTunnel = { offered: true };
  engine.connection.opensLocalFile = false;
  engine.connection.serverLevelWithoutDatabase = true;
  engine.connection.agentCredential = { form: "pair", supersededBy: [] };
  engine.facets = {
    ...engine.facets,
    monitoring: postgres.facets.monitoring,
    agentReadings: ["sessions", "health"],
  };
  (engine as Record<string, unknown>).agent = postgres.agent;
}

/**
 * Statement language data a fixture package declares: `acmeql`, a request language whose statements name no operation,
 * whose reader's answer is the confirmation gate's whole answer, and with no agent part.
 */
export const ACME_LANGUAGE_DATA: NonNullable<StatementLanguageData> = Object.freeze({
  name: "acmeql",
  confirmation: Object.freeze({
    operations: Object.freeze([]),
    reader: "names-no-operation",
    decidesAlone: true,
    safetyAnalysis: false,
    maxTextBytes: 4096,
  }),
  agent: null,
});

/** `engine` declaring the statement language data `data`, a copy of it, and nothing else changed. */
export function withStatementLanguageData(
  engine: EditableEngine,
  data: NonNullable<StatementLanguageData> = ACME_LANGUAGE_DATA,
): void {
  (engine as Record<string, unknown>).statementLanguageData = structuredClone(data);
}

/**
 * The digest of the statement language data `manifest`'s first engine declares, as the server catalog's composer
 * computes it.
 *
 * @throws {Error} For a manifest whose first engine declares none.
 */
export function declaredLanguageSha256(manifest: ProviderManifest): string {
  const data = manifest.engines[0]?.statementLanguageData ?? null;
  if (data === null) throw new Error("the fixture manifest's first engine declares no statement language data");
  return languageDataSha256(data);
}

/**
 * Field rules on four fields of the minimal manifest's: a required host of a pattern, a user of 3 to 16 characters, a
 * password read by a named check, and a required database shown only while the user is `reader`, which an absent user
 * reads as.
 */
export function withFieldRules(engine: EditableEngine): void {
  engine.connection.fieldRules = [
    {
      field: "host",
      required: "Enter the host. Nothing was sent.",
      format: {
        pattern: { source: "^[a-z0-9.-]+$", flags: "" },
        sentence: "Host is letters, digits, dots and hyphens.",
      },
      charRange: null,
      check: null,
    },
    {
      field: "user",
      required: null,
      format: null,
      charRange: { min: 3, max: 16, sentence: "User is 3 to 16 characters." },
      check: null,
    },
    { field: "password", required: null, format: null, charRange: null, check: "acmepasswordcheck" },
    {
      field: "database",
      required: "Enter the database. Nothing was sent.",
      format: null,
      charRange: null,
      check: null,
    },
  ];
  (engine.connection.dialog as Record<string, unknown>).shownWhen = [
    { field: "database", when: { field: "user", equals: "reader" } },
  ];
  (engine.connection.dialog as Record<string, unknown>).absentValues = [{ field: "user", value: "reader" }];
}

/**
 * `catalog` with the record of each engine `legacyProvider` names replaced by a frozen copy whose offer of the legacy
 * provider surface is the value given: a crafted catalog, which no composition answers and `installServerCatalog`
 * refuses, for the test that holds the install to refuse a record whose offer disagrees with its id.
 *
 * @throws {Error} Naming the engine, for an engine `catalog` holds no record of.
 */
export function withLegacyProviderOffers(
  catalog: ServerCatalog,
  legacyProvider: Readonly<Record<string, boolean>>,
): ServerCatalog {
  const engines = new Map(catalog.engines);
  for (const [id, offered] of Object.entries(legacyProvider)) {
    const engine = engines.get(id);
    if (engine === undefined) throw new Error(`the catalog holds no record of ${id}`);
    engines.set(id, Object.freeze({ ...engine, offers: Object.freeze({ ...engine.offers, legacyProvider: offered }) }));
  }
  return Object.freeze({ engines, unavailable: catalog.unavailable });
}

/**
 * `catalog` with the record of engine `id` replaced by the frozen record `change` answers for it: a crafted catalog, for
 * the tests that hold a reader to the installed record rather than to Studio's tables. The install still holds each
 * record's legacy provider offer to its id, so `change` keeps the offer.
 *
 * @throws {Error} Naming the engine, for an engine `catalog` holds no record of.
 */
export function withEngineRecord(
  catalog: ServerCatalog,
  id: string,
  change: (engine: EngineRecord) => EngineRecord,
): ServerCatalog {
  const engines = new Map(catalog.engines);
  const engine = engines.get(id);
  if (engine === undefined) throw new Error(`the catalog holds no record of ${id}`);
  engines.set(id, Object.freeze(change(engine)));
  return Object.freeze({ engines, unavailable: catalog.unavailable });
}

/**
 * Studio's own catalog with the grants of each engine `changes` names replaced by its record's grants and the change,
 * and the statement grammar of each engine `statementGrammar` names replaced by the value named for it: a crafted
 * catalog, for the tests that hold a reader of a grant to the installed record rather than to Studio's tables.
 *
 * @throws {Error} Naming the engine, for an engine Studio's catalog holds no record of.
 */
export function craftedCatalog(
  changes: Readonly<Record<string, Partial<EngineGrants>>>,
  statementGrammar: Readonly<Record<string, EngineRecord["statementGrammar"]>> = {},
): ServerCatalog {
  let catalog = composeServerCatalog([], [], STUDIO_GRANT_REGISTER);
  for (const [id, change] of Object.entries(changes)) {
    catalog = withEngineRecord(catalog, id, (engine) => ({
      ...engine,
      grants: Object.freeze({ ...engine.grants, ...change }),
    }));
  }
  for (const [id, grammar] of Object.entries(statementGrammar)) {
    catalog = withEngineRecord(catalog, id, (engine) => ({ ...engine, statementGrammar: grammar }));
  }
  return catalog;
}

/** Runs `read` with `catalog` installed, and forgets it whatever `read` does. */
export async function withCatalog<T>(catalog: ServerCatalog, read: () => T | Promise<T>): Promise<T> {
  installServerCatalog(catalog);
  try {
    return await read();
  } finally {
    forgetServerCatalog();
  }
}
