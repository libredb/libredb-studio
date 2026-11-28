/**
 * The server's engine catalog (docs/providers/CONTRACT.md, clauses C-106 and C-107): the process's one answer to which
 * engine a connection's `type` names and what serves it. One record shape for every engine, `EngineRecord`, in one Map:
 * the legacy adapter's records of the engines Studio still serves through its own legacy providers
 * (src/lib/provider-host/legacy-adapter/records.ts), beside the records of the engines the provider packages boot
 * admitted, composed once at boot by `composeServerCatalog` (./server-catalog-compose, which only the boot imports) and
 * installed here, read through `serverEngine` and `assertLegacyProvider`.
 *
 * `serverEngine(type)` answers, in this order:
 * - `served`, for an engine the catalog's Map holds a record of, legacy or package alike, told apart by no kind: what
 *   a caller may do with the engine is what its record offers (`offers`), and who serves it is its `source`;
 * - `unavailable`, for an engine only refused packages name in the providers lock, with the codes they were refused
 *   with, sorted, each once;
 * - `refused`, for anything else, with `typeIdRefusal`'s own answer, so an absent, malformed or unknown type gets
 *   exactly the refusal it got before any package existed.
 * The legacy ids and the admitted packages' ids are disjoint, since admission and the composer's `engine-id` rule refuse
 * a package serving a legacy id, so a package never shadows a bundled engine. Each lookup is a `Map` lookup, so a type
 * a client sends that names an `Object.prototype` member, such as `"constructor"`, is unknown and never an inherited
 * member. No lookup asks whether the type is a `DatabaseType`: the Map is the one answer.
 *
 * An engine record holds:
 * - `id`, an `EngineId`, a type brand with no value at run time: server code that holds an engine's id from the
 *   catalog holds one, never a `DatabaseType`;
 * - `displayName`: the name the server's texts give the engine, a legacy engine's connection form label
 *   (`CONNECTION_FORM`, whose label is its declaration's `displayName`) and a package engine's declared `displayName`;
 * - `source`: the name and version the engine is served under, and for a package's engine the digest its lock entry
 *   pins and the admitted package (`ServedPackage`, its digest, directory, validated manifest, Studio's record of it
 *   and the session its declaration states), both null for a legacy engine, whose name is `@libredb/studio` at the
 *   root package.json's version (src/lib/provider-host/legacy-adapter/identity.ts); `servedPackage` reads the package
 *   and raises a host defect for a legacy record;
 * - `catalog`, `connection`, `fieldRules` and `statementGrammar`: the engine's catalog entry, its data-only connection
 *   tables, its field rules and the grammar its statements are confirmed under, composed for a package from its
 *   declaration with the projections Studio's generator projects its own declarations with, the grammar null where
 *   the declaration states no SQL text, and for a legacy engine from Studio's committed tables, never from a
 *   declaration read at run time;
 * - `grants`: Studio's grant of each claim, the agent overlay's claim that its catalog read is a command among them,
 *   and of the four host facts it reads from no declaration, `grantEngineClaims` (./claim-grants) against the
 *   engine's row of the grant register: a legacy engine's legacy row, a package engine's row keyed by its
 *   package's name, version and digest, or, where the register holds none, each claim at its restrictive value; its
 *   SQL text claims only for the grammar the row reviewed, and whether it did, and its statement language,
 *   decides-alone and text-not-SQL claims also only for the statement language data the row reviewed, the last two
 *   under that data alone for an engine that states no SQL text;
 * - `statementLanguageRow`: the engine's statement language row, the one the confirmation gate, the console text bound
 *   and the editor's refusal read (`statementLanguageRow` in ./statement-language-row), composed for a package from
 *   the statement language data its declaration states and for a legacy engine from Studio's code row of its id, once,
 *   when the record is composed; null where the engine's statements are SQL, or where it states no SQL text and no
 *   statement language data;
 * - `explainReading`: how the gate reads the statement grammar's explain claim, `"declared"` for a legacy engine and
 *   `"either"` for a package's (`StatementReading` in src/lib/sql/dangerous-query.ts);
 * - `offers`: what the engine offers each server path that tells a legacy engine from a package's today, one member
 *   per difference, each true for a legacy engine and false for a package's (`EngineOffers`).
 *
 * Every server path that needs a legacy `DatabaseProvider` for a connection checks its type through
 * `assertLegacyProvider`, or reads its record through `legacyProviderEngine`, both of which read the record's
 * `legacyProvider` offer: `resolveConnection` (src/lib/seed/resolve-connection.ts), the choke point of every route, the
 * provider factory's entry points (./factory), which read the record's grants and connection tables where they once
 * read Studio's tables keyed by type, and the open checks of MCP's connection context (src/lib/mcp/context.ts); MCP's
 * availability (src/lib/mcp/availability.ts), which `list_connections` and every MCP tool answer before any open, reads
 * `legacyProviderRefusal`'s message. A refused package's engine is refused there as `ProviderUnavailableError`, an
 * engine whose record offers no legacy provider as `PackageEngineUnsupportedError` until the request serves package
 * engines, and every other value exactly as `assertDatabaseType` refuses it. Only Test Connection, the query route and
 * the object tree's reads serve an engine whose record offers no legacy provider in this Studio: each resolves its
 * connection with its record through `resolveServedConnection` (src/lib/seed/resolve-connection.ts), which reads the
 * type through `servedEngineRecord`; Test Connection then runs one test for every record, which reads what differs from
 * the record's offers and grants (`testConnection` in src/lib/api/test-connection.ts), the query route opens every
 * record's cached editor session and runs a statement on it with one run (`editorTarget` in
 * src/lib/api/editor-provider.ts, `runEditorQuery` in src/lib/api/editor-query.ts), and the six tree routes read every
 * record's metadata session through one tree facade (`metadataTreeTarget` in src/lib/api/editor-provider.ts,
 * `objectTree` in src/lib/api/object-tree.ts), all over the provider factory's opens of any record (`openEngineOnce`,
 * `getOrCreateEditorSession` and `getOrCreateMetadataSession` in ./factory). The object edit and key scan requests
 * resolve through it too and refuse a package's engine by the record's offer (`objectEdit`, `keyScan`).
 *
 * The published `DatabaseType`, `isDatabaseType`, `typeIdRefusal` and `assertDatabaseType` (./type-id) are unchanged.
 *
 * The installed catalog lives in a global under a registered symbol, as the host core does
 * (src/lib/provider-host/instance.ts), because Next.js loads instrumentation, which installs it, and each route
 * handler, which reads it, as separate module instances of one process. It is plain frozen data, Maps and the field
 * rules' compiled patterns and bound checks, which every bundle of one realm reads alike. It is installed once: a second
 * install is a host defect, refused by name, and so is a catalog that lacks a legacy engine's record or holds a record
 * whose `legacyProvider` offer disagrees with its id, because `assertLegacyProvider` narrows a type to `DatabaseType`
 * from that offer: a record offers a legacy provider exactly when the legacy adapter serves its id.
 *
 * With nothing installed, the accessor answers from the legacy adapter's records alone. That is the documented state of
 * every process that runs no boot admission: the published library, the VS Code backend child, and a test that installs
 * nothing. It is not a fallback for a failed boot: a boot whose admission cannot compose a catalog exits before it
 * serves (src/lib/provider-host/boot.ts).
 *
 * A boot that has begun and not yet installed its catalog is a state of its own (`beginServerCatalogBoot`,
 * `serverCatalogBooting`), held under a second registered symbol beside the catalog: boot admission begins it before it
 * reads the providers directory, and the install ends it. A boot that ended by an error before its install is recorded
 * as unfinished (`endServerCatalogBootUnfinished`, `serverCatalogBootUnfinished`) under the same symbol, and stays so for
 * the life of the process. Every lookup above answers from the legacy records while a boot is pending or unfinished, as
 * with nothing installed; a reader whose answer is composed once per installed catalog reads the state and refuses a
 * read made while it is pending as a defect of Studio's own composition order, and one made after an unfinished boot as
 * that boot's, since a composition made then would be the bundled set (MCP's statement tools, `mcpStatementSurface` in
 * src/lib/mcp/tools/statement-arms.ts).
 * `servedEngines` answers the Map of every served record, in catalog order, for such a composition.
 */
import type { CredentialWarning, FieldName, ProviderManifest, TlsMode } from "@libredb/provider-sdk/manifest";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import type { EngineGrants } from "@/lib/db/claim-grants";
import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import type { StatementReading } from "@/lib/sql/dangerous-query";
import type { AdmittedProviderRecord } from "@/lib/provider-host/admission";
import type { DeclaredSession } from "@/lib/provider-host/core/contract-session";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import type { FieldRuleSpec } from "@/lib/db/connection-form";
import type { CatalogEntry, SeedOnlyTemplate } from "@/lib/db/engine-catalog/projection";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import {
  PackageEngineUnsupportedError,
  ProviderUnavailableError,
  type TypeIdRefusal,
  UnknownProviderError,
} from "./errors";
import { quoteTypeId, typeIdRefusal } from "./type-id";

declare const ENGINE: unique symbol;

/** The id of an engine the server's catalog serves, legacy or package alike: a type brand, with no value at run time. */
export type EngineId = string & { readonly [ENGINE]: true };

/**
 * A connection of any engine the server knows, its type read as text: what the engine-neutral readers of a connection's
 * fields take (the cache key's frame, the connection fingerprint), which frame the type as text and read no row keyed
 * by it, and what the factory's opens of any record take (`getOrCreateEditorSession`, `openEngineOnce` in ./factory).
 */
export type EngineConnection = Omit<DatabaseConnection, "type"> & { readonly type: string };

/** The engine's own row of each data-only connection table. */
export interface EngineConnectionTables {
  readonly fields: readonly FieldName[];
  readonly seedOnly: SeedOnlyTemplate | null;
  readonly refused: Readonly<Partial<Record<FieldName, string>>>;
  readonly credentialWarnings: readonly CredentialWarning[];
  /** The TLS modes the engine takes, the declaration's `connection.tls.modes`, which its open context reads. */
  readonly tlsModes: readonly TlsMode[];
  readonly readsTrustMaterial: boolean;
  readonly connectionStringAccepted: boolean;
  readonly dialogOffersUri: boolean;
}

/**
 * The admitted package that serves an engine: its name, version, digest and directory, and Studio's frozen record of
 * it.
 */
export interface ServingPackage {
  readonly name: string;
  readonly version: string;
  /** The digest its providers lock entry pins, which the lock's read verified against its files. */
  readonly digest: string;
  /** The real path of its directory in the providers directory. */
  readonly directory: string;
  /** The manifest admission validated and froze. */
  readonly manifest: ProviderManifest;
  /** Studio's record of the package, the one registered in the loader's registry, whose `impl` its sessions open on. */
  readonly record: AdmittedProviderRecord;
}

/** The admitted package that serves an engine, with what a session of that engine is declared to answer. */
export interface ServedPackage extends ServingPackage {
  /** What a session of the engine is declared to answer: the package's calls, its maintenance and monitoring panels. */
  readonly session: DeclaredSession;
}

/**
 * Who serves an engine: the name, version and digest it is served under, and the package; the digest and the package
 * are null for a legacy engine.
 */
export interface EngineSource {
  readonly name: string;
  readonly version: string;
  readonly digest: string | null;
  readonly package: ServedPackage | null;
}

/**
 * What an engine offers the server paths that tell a legacy engine from a package's engine today, one member per
 * difference, each true for a legacy engine, served by a legacy `DatabaseProvider`, and false for a package's engine,
 * served through the provider contract.
 */
export interface EngineOffers {
  /**
   * A legacy `DatabaseProvider` the provider factory builds (./factory): every request other than Test Connection, the
   * query route and the object tree's reads reads one, through `assertLegacyProvider`.
   */
  readonly legacyProvider: boolean;
  /** A plan of a statement (`explain`), built by the connected provider's strategy. */
  readonly explain: boolean;
  /** A key-space `database` on a query, read from a legacy provider's declarations. */
  readonly database: boolean;
  /** A server-level `catalog` on a query, a legacy catalog session. */
  readonly catalog: boolean;
  /** An unbounded page (`options.unlimited`); the provider contract always pumps a bounded one. */
  readonly unboundedPage: boolean;
  /** An SSH tunnel core opens for the connection. */
  readonly sshTunnel: boolean;
  /** Host files: the host path fields and the local file core admits for the connection. */
  readonly hostFiles: boolean;
  /** Test Connection's connect warnings and test-only cautions. */
  readonly testCautions: boolean;
  /**
   * A provider the execution-profile acquisition opens (`acquireExecutionProfileProvider` in ./factory): the agent's and
   * MCP's profiles, with the seed's agent credential, its read roots and a read-only statement session. A package's
   * session is opened through its package, with none of them (C-109), until Studio opens a read-only statement session
   * through a package. MCP's statement tools serve only an engine whose record offers it
   * (src/lib/mcp/tools/served-engines.ts).
   */
  readonly executionProfiles: boolean;
  /**
   * The object edit plan and the edit apply (`POST /api/db/objects/edit-plan` and `/edit-apply`), built by a legacy
   * provider's edit builder; the provider contract has no edit call yet, so a package's engine is refused them by this
   * offer before any open (`handleObjectRequest` in src/lib/api/object-route.ts).
   */
  readonly objectEdit: boolean;
  /**
   * The key scan (`POST /api/db/keys/scan`), read by a legacy provider's key walk; the provider contract has no key scan
   * call yet, so a package's engine is refused it by this offer before any open.
   */
  readonly keyScan: boolean;
}

/**
 * Studio's record of one engine the server serves, legacy or package alike; see the module's docblock for each
 * member. It holds no SQL writing, connection form, connection string, migration DDL or generator row.
 */
export interface EngineRecord {
  readonly id: EngineId;
  readonly displayName: string;
  readonly source: EngineSource;
  readonly catalog: CatalogEntry;
  readonly connection: EngineConnectionTables;
  readonly fieldRules: FieldRuleSpec;
  readonly grants: EngineGrants;
  /**
   * The grammar the engine's statements are confirmed under: for a package, the grammar its declaration states
   * (`sqlText.grammar`), composed once by `grammarFromFacts` (./sql-grammar), which the confirmation gate reads with
   * the claims that loosen it its record grants for the grammar its register row reviewed, every statement asked where
   * no row reviewed it (`statementAsks` in src/lib/sql/dangerous-query.ts); null for a package whose
   * declaration states `sqlText` as null, which no register row can review, so the gate asks about every statement,
   * unless its grants grant `readsSqlText: false` and its statement language row decides alone, which its row alone
   * then answers, and the query event log keeps none of its text; for a legacy engine, its row of Studio's grammar
   * table (`sqlGrammarFor`), never null. The query event builder reads a statement and its error text under it too
   * (`buildQueryEvent` in src/lib/query-events/build.ts).
   */
  readonly statementGrammar: SqlGrammar | null;
  /**
   * The engine's statement language row, or null where its statements are SQL, or where it states no SQL text and no
   * statement language data: what the confirmation gate reads beside the statement grammar, through the reading of the
   * record (`readingOfRecord` in src/lib/sql/dangerous-query.ts), and what the console text bound and the editor's
   * refusal are read from (`rowTextByteLimit` and `rowRefusal` in ./statement-language-row). The row's claims count
   * only as `grants` grant them.
   */
  readonly statementLanguageRow: DestructiveVocabulary | null;
  /** How the confirmation gate reads the statement grammar's explain claim (`StatementReading.explainReading`). */
  readonly explainReading: StatementReading["explainReading"];
  readonly offers: EngineOffers;
}

/** The composed catalog: every engine's record, and the codes of the refused packages naming the others. */
export interface ServerCatalog {
  readonly engines: ReadonlyMap<string, EngineRecord>;
  readonly unavailable: ReadonlyMap<string, readonly string[]>;
}

/** What the server knows of a connection's type. */
export type ServerEngine =
  | { readonly kind: "served"; readonly engine: EngineRecord }
  | { readonly kind: "unavailable"; readonly id: string; readonly codes: readonly string[] }
  | { readonly kind: "refused"; readonly refusal: TypeIdRefusal };

/** Which server path checks the type: a route, or the open of a session. */
export type EngineNeed = "route" | "open";

const CATALOG_KEY = Symbol.for("libredb-studio.server-engine-catalog");

/**
 * The key of the boot that has not installed its catalog, beside the catalog's: `begun` while it runs, `unfinished` once
 * it ended by an error.
 */
const BOOT_KEY = Symbol.for("libredb-studio.server-engine-catalog-boot");

type CatalogHolder = { [CATALOG_KEY]?: ServerCatalog; [BOOT_KEY]?: "begun" | "unfinished" };

/** The refusal of an engine whose record offers no legacy provider, by the path that refused it. */
const UNSUPPORTED_SENTENCES: Readonly<Record<EngineNeed, string>> = Object.freeze({
  route:
    "This request is served for an engine of a provider package only by Test Connection, the query route and the object tree's reads in this LibreDB Studio, and this is another request.",
  open: "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
});

/** The installed catalog, or undefined. */
function installed(): ServerCatalog | undefined {
  return (globalThis as CatalogHolder)[CATALOG_KEY];
}

/**
 * Every record the server serves, in catalog order: the installed catalog's Map, or the legacy adapter's records with
 * nothing installed, each by reference, so its identity is the installed catalog's and keys a composition made once per
 * catalog.
 */
export function servedEngines(): ReadonlyMap<string, EngineRecord> {
  return installed()?.engines ?? LEGACY_ENGINES;
}

/** What the server knows of `value`, a connection's type as a client or a store gave it. */
export function serverEngine(value: unknown): ServerEngine {
  const catalog = installed();
  if (typeof value === "string") {
    const engine = (catalog?.engines ?? LEGACY_ENGINES).get(value);
    if (engine !== undefined) return { kind: "served", engine };
    const codes = catalog?.unavailable.get(value);
    if (codes !== undefined) return { kind: "unavailable", id: value, codes };
  }
  // Every legacy id is in the Map, installed or not (`installServerCatalog`), so the value names no engine and the
  // type id check refuses it.
  return { kind: "refused", refusal: typeIdRefusal(value) as TypeIdRefusal };
}

/** What a legacy provider path reads of a connection's type: the served record that offers one, or its refusal. */
type LegacyProviderReading =
  | { readonly engine: EngineRecord; readonly refusal: null }
  | {
      readonly engine: null;
      readonly refusal: ProviderUnavailableError | PackageEngineUnsupportedError | UnknownProviderError;
    };

/**
 * The refusal of a type the catalog serves no record of: a refused package's engine as `ProviderUnavailableError`
 * naming its codes, every other value as `UnknownProviderError`, exactly as `assertDatabaseType` refuses it.
 */
function notServedRefusal(
  engine: Exclude<ServerEngine, { readonly kind: "served" }>,
): ProviderUnavailableError | UnknownProviderError {
  if (engine.kind === "unavailable") {
    return new ProviderUnavailableError(
      `The connection type ${quoteTypeId(engine.id)} is served by a provider package this LibreDB Studio refused when it started (${engine.codes.join(", ")}), so no provider can open it; the server's log names the package and why.`,
      engine.id,
      engine.codes,
    );
  }
  return new UnknownProviderError(engine.refusal);
}

/** `legacyProviderRefusal`'s and `legacyProviderEngine`'s one reading of `value` for `need`. */
function legacyProviderReading(value: unknown, need: EngineNeed): LegacyProviderReading {
  const engine = serverEngine(value);
  if (engine.kind !== "served") return { engine: null, refusal: notServedRefusal(engine) };
  return engine.engine.offers.legacyProvider
    ? { engine: engine.engine, refusal: null }
    : { engine: null, refusal: new PackageEngineUnsupportedError(UNSUPPORTED_SENTENCES[need], engine.engine.id) };
}

/**
 * The record of the engine a connection's type names, legacy or package alike, for a path that serves every engine the
 * catalog serves (`resolveServedConnection` in src/lib/seed/resolve-connection.ts). Every other value is refused as
 * `legacyProviderRefusal` refuses it.
 *
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {UnknownProviderError} When the type is absent, not text, or names no engine the server knows.
 */
export function servedEngineRecord(value: unknown): EngineRecord {
  const engine = serverEngine(value);
  if (engine.kind !== "served") throw notServedRefusal(engine);
  return engine.engine;
}

/**
 * Whether `engine`'s record offers a legacy provider, so `connection`, of its engine, is a connection the legacy entry
 * points take: a record offers one exactly when the legacy adapter serves its id (`installServerCatalog`), whose type is
 * a `DatabaseType`.
 */
export function offersLegacyProvider(
  engine: EngineRecord,
  connection: EngineConnection,
): connection is DatabaseConnection {
  return engine.offers.legacyProvider;
}

/**
 * `connection`, of `engine`, as the connection the legacy entry points take, for a caller that read the record's
 * `legacyProvider` offer first.
 *
 * @throws {Error} A host defect: when `engine`'s record offers no legacy provider.
 */
export function legacyConnection(engine: EngineRecord, connection: EngineConnection): DatabaseConnection {
  if (!offersLegacyProvider(engine, connection)) {
    throw new Error(
      `The engine ${quoteTypeId(engine.id)} offers no legacy provider, and this caller reads its connection as a legacy provider's: a host defect.`,
    );
  }
  return connection;
}

/**
 * The refusal of a connection type whose engine offers no legacy provider, or null for one whose record offers it: a
 * refused package's engine as `ProviderUnavailableError`, an engine whose record offers no legacy provider as
 * `PackageEngineUnsupportedError` for `need`, and every other value as `UnknownProviderError`, exactly as
 * `assertDatabaseType` refuses it. A surface that answers a refusal as text, as MCP's `list_connections` and its tools
 * do, reads its message; every other one throws it through `assertLegacyProvider` or `legacyProviderEngine`.
 */
export function legacyProviderRefusal(
  value: unknown,
  need: EngineNeed,
): ProviderUnavailableError | PackageEngineUnsupportedError | UnknownProviderError | null {
  return legacyProviderReading(value, need).refusal;
}

/**
 * Refuses a connection type whose engine offers no legacy provider with `legacyProviderRefusal`'s answer.
 *
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {PackageEngineUnsupportedError} When the engine's record offers no legacy provider.
 * @throws {UnknownProviderError} When the type is absent, not text, or names no engine the server knows.
 */
export function assertLegacyProvider(value: unknown, need: EngineNeed): asserts value is DatabaseType {
  const refusal = legacyProviderRefusal(value, need);
  if (refusal !== null) throw refusal;
}

/**
 * The record of the engine a connection's type names, when that record offers a legacy provider: what the provider
 * factory (./factory) reads of a legacy engine, its grants and its connection tables, in place of Studio's tables keyed
 * by type. Every other value is refused with `legacyProviderRefusal`'s answer, as `assertLegacyProvider` refuses it.
 *
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {PackageEngineUnsupportedError} When the engine's record offers no legacy provider.
 * @throws {UnknownProviderError} When the type is absent, not text, or names no engine the server knows.
 */
export function legacyProviderEngine(value: unknown, need: EngineNeed): EngineRecord {
  const reading = legacyProviderReading(value, need);
  if (reading.refusal !== null) throw reading.refusal;
  return reading.engine;
}

/**
 * The id of `engine` as the published `DatabaseType`, the type a `DatabaseError` names its provider by, when its record
 * offers a legacy provider, and undefined for every other record. The assertion holds because `installServerCatalog`
 * refuses a record whose `legacyProvider` offer disagrees with its id, the same offer `assertLegacyProvider` narrows on:
 * a record that offers a legacy provider has a legacy engine's id.
 */
export function legacyProviderType(engine: EngineRecord): DatabaseType | undefined {
  return engine.offers.legacyProvider ? (engine.id as string as DatabaseType) : undefined;
}

/**
 * The admitted package that serves `engine`.
 *
 * @throws {Error} A host defect: when `engine` is a legacy engine's record, which no package serves; only the package
 * session path reads it, after the record's `legacyProvider` offer sent the request there.
 */
export function servedPackage(engine: EngineRecord): ServedPackage {
  if (engine.source.package === null) {
    throw new Error(
      `The engine ${quoteTypeId(engine.id)} is served by LibreDB Studio's legacy adapter, which serves no provider package: a caller that reads a package of it is a host defect.`,
    );
  }
  return engine.source.package;
}

/**
 * Installs `catalog` as the process's server catalog, once.
 *
 * @throws {Error} When a catalog is installed already: boot composes it once, and a second composition is a host defect;
 * when `catalog` lacks a record of a legacy engine, which every composed catalog holds; or when a record's
 * `legacyProvider` offer disagrees with its id, since `assertLegacyProvider` narrows a type to `DatabaseType` from that
 * offer: a record offers a legacy provider exactly when the legacy adapter serves its id.
 */
export function installServerCatalog(catalog: ServerCatalog): void {
  const holder = globalThis as CatalogHolder;
  if (holder[CATALOG_KEY] !== undefined) {
    throw new Error("The server's engine catalog is already installed in this process: boot composes it once.");
  }
  for (const id of LEGACY_ENGINES.keys()) {
    if (!catalog.engines.has(id)) {
      throw new Error(
        `The server's engine catalog holds no record of the legacy engine ${quoteTypeId(id)}: every composed catalog holds every legacy record.`,
      );
    }
  }
  for (const [id, engine] of catalog.engines) {
    const legacy = LEGACY_ENGINES.has(id);
    if (engine.offers.legacyProvider === legacy) continue;
    throw new Error(
      legacy
        ? `The server's engine catalog's record of the legacy engine ${quoteTypeId(id)} offers no legacy provider: a record offers a legacy provider exactly when its engine is a legacy engine.`
        : `The server's engine catalog's record of ${quoteTypeId(id)} offers a legacy provider, and the legacy adapter serves no engine of that id: a record offers a legacy provider exactly when its engine is a legacy engine.`,
    );
  }
  holder[CATALOG_KEY] = catalog;
  delete holder[BOOT_KEY];
}

/** Whether a server catalog is installed in this process. */
export function serverCatalogInstalled(): boolean {
  return installed() !== undefined;
}

/**
 * Begins the boot that composes and installs the server's catalog: `serverCatalogBooting` answers true until the
 * install, or until `endServerCatalogBootUnfinished` records the boot as ended by an error. A boot that exits before it
 * installs leaves it begun, which no request observes.
 *
 * @throws {Error} When a catalog is installed already, a boot has begun already, or a boot ended unfinished: boot
 *   composes the catalog once.
 */
export function beginServerCatalogBoot(): void {
  const holder = globalThis as CatalogHolder;
  if (holder[CATALOG_KEY] !== undefined) {
    throw new Error("The server's engine catalog is already installed in this process: boot composes it once.");
  }
  if (holder[BOOT_KEY] === "begun") {
    throw new Error(
      "The server's engine catalog's boot has begun in this process already: boot composes the catalog once.",
    );
  }
  if (holder[BOOT_KEY] === "unfinished") {
    throw new Error(
      "The server's engine catalog's boot began in this process and ended by an error before it installed the catalog: boot composes the catalog once.",
    );
  }
  holder[BOOT_KEY] = "begun";
}

/**
 * Records the begun boot as ended by an error before it installed the catalog: `serverCatalogBooting` answers false and
 * `serverCatalogBootUnfinished` true from then on. Boot admission calls it before it throws the error on.
 *
 * @throws {Error} When no boot has begun: only a begun boot can end unfinished.
 */
export function endServerCatalogBootUnfinished(): void {
  const holder = globalThis as CatalogHolder;
  if (holder[BOOT_KEY] !== "begun") {
    throw new Error("The server's engine catalog's boot was ended unfinished while no boot had begun in this process.");
  }
  holder[BOOT_KEY] = "unfinished";
}

/** Whether a boot has begun and not yet installed the server's catalog, nor ended by an error. */
export function serverCatalogBooting(): boolean {
  return (globalThis as CatalogHolder)[BOOT_KEY] === "begun";
}

/** Whether a boot began and ended by an error before it installed the server's catalog. */
export function serverCatalogBootUnfinished(): boolean {
  return (globalThis as CatalogHolder)[BOOT_KEY] === "unfinished";
}

/**
 * Test seam: forgets the installed catalog and a begun or unfinished boot, as a new process would; a process never calls
 * it.
 */
export function forgetServerCatalog(): void {
  const holder = globalThis as CatalogHolder;
  delete holder[CATALOG_KEY];
  delete holder[BOOT_KEY];
}
