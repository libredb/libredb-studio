/**
 * The server's engine catalog (docs/providers/CONTRACT.md, clauses C-106 and C-107): the process's one answer to which
 * engine a connection's `type` names and what serves it. Studio's bundled catalog, plus the engines of the provider
 * packages boot admitted, composed once at boot by `composeServerCatalog` (./server-catalog-compose, which only the
 * boot imports) and installed here, read through `serverEngine` and `assertBundledEngine`.
 *
 * `serverEngine(type)` answers, in this order:
 * - `bundled`, for a type id of the `DatabaseType` union (`isDatabaseType`), so a package never shadows a bundled id;
 * - `package`, for an engine an admitted package serves, with Studio's composed record of it (`PackageEngine`);
 * - `unavailable`, for an engine only refused packages name in the providers lock, with the codes they were refused
 *   with, sorted, each once;
 * - `refused`, for anything else, with `typeIdRefusal`'s own answer, so an absent, malformed or unknown type gets
 *   exactly the refusal it got before any package existed.
 * Each lookup is a `Map` lookup, so a type a client sends that names an `Object.prototype` member, such as
 * `"constructor"`, is unknown and never an inherited member.
 *
 * Every server path that checks a connection's type before it reads a per-engine table checks it through
 * `assertBundledEngine`: `resolveConnection` (src/lib/seed/resolve-connection.ts), the choke point of every route, the
 * provider factory's entry points (./factory) and the open checks of MCP's connection context
 * (src/lib/mcp/context.ts); MCP's availability (src/lib/mcp/availability.ts), which `list_connections` and every MCP
 * tool answer before any open, reads `bundledEngineRefusal`'s message. A refused package's engine is refused there as
 * `ProviderUnavailableError`, an admitted one as `PackageEngineUnsupportedError` until the request serves package
 * engines, and every other value exactly as `assertDatabaseType` refuses it. Only Test Connection serves an admitted
 * engine in this Studio: it resolves its connection through `resolveConnection` with `engines` `bundled-and-package`,
 * then `testPackageConnection` (src/lib/api/test-connection.ts, over src/lib/db/package-sessions.ts) validates it
 * against the engine's field rules and opens one session through the package.
 *
 * The published `DatabaseType`, `isDatabaseType`, `typeIdRefusal` and `assertDatabaseType` (./type-id) are unchanged:
 * server code that holds an admitted engine's id holds a `PackageEngineId`, never a `DatabaseType`.
 *
 * The catalog lives in a global under a registered symbol, as the host core does (src/lib/provider-host/instance.ts),
 * because Next.js loads instrumentation, which installs it, and each route handler, which reads it, as separate module
 * instances of one process. It is plain frozen data, Maps and the field rules' compiled patterns and closures, which
 * every bundle of one realm reads alike. It is installed once: a second install is a host defect, refused by name.
 *
 * With nothing installed, the accessor answers from the bundled catalog alone. That is the documented state of every
 * process that runs no boot admission: the published library, the VS Code backend child, and a test that installs
 * nothing. It is not a fallback for a failed boot: a boot whose admission cannot compose a catalog exits before it
 * serves (src/lib/provider-host/boot.ts).
 */
import type { CredentialWarning, FieldName, ProviderManifest, TlsMode } from "@libredb/provider-sdk/manifest";
import type { ClaimGrants } from "@/lib/db/claim-grants";
import type { AdmittedProviderRecord } from "@/lib/provider-host/admission";
import type { DeclaredSession } from "@/lib/provider-host/core/contract-session";
import type { FieldRuleSpec } from "@/lib/db/connection-form";
import type { CatalogEntry, SeedOnlyTemplate } from "@/lib/db/engine-catalog/projection";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import {
  PackageEngineUnsupportedError,
  ProviderUnavailableError,
  type TypeIdRefusal,
  UnknownProviderError,
} from "./errors";
import { isDatabaseType, quoteTypeId, typeIdRefusal } from "./type-id";

declare const PACKAGE_ENGINE: unique symbol;

/** The id of an engine an admitted provider package serves: a type brand, with no value at run time. */
export type PackageEngineId = string & { readonly [PACKAGE_ENGINE]: true };

/** A connection of an engine an admitted provider package serves. */
export type PackageConnection = Omit<DatabaseConnection, "type"> & { readonly type: PackageEngineId };

/**
 * A connection of any engine the server knows, bundled or served by a provider package, its type read as text: what the
 * engine-neutral readers of a connection's fields take (the cache key's frame, the connection fingerprint), which frame
 * the type as text and read no row keyed by it.
 */
export type EngineConnection = Omit<DatabaseConnection, "type"> & { readonly type: string };

/** Studio's grant of each claim of one engine, read through the grant reader (./claim-grants): one value per member. */
export type PackageGrants = { readonly [Member in keyof ClaimGrants<string>]: ClaimGrants<string>[Member][string] };

/** The engine's own row of each data-only connection table, projected from its declaration. */
export interface PackageConnectionTables {
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

/** The admitted package that serves an engine: its name, version and directory, and Studio's frozen record of it. */
export interface ServingPackage {
  readonly name: string;
  readonly version: string;
  /** The real path of its directory in the providers directory. */
  readonly directory: string;
  /** The manifest admission validated and froze. */
  readonly manifest: ProviderManifest;
  /** Studio's record of the package, the one registered in the loader's registry, whose `impl` its sessions open on. */
  readonly record: AdmittedProviderRecord;
}

/**
 * Studio's composed record of one engine an admitted package serves: the declaration's catalog entry, its connection
 * tables, its field rules, Studio's grant of each claim and what its sessions are declared to answer, and nothing else, so no SQL writing, connection form,
 * connection string, grammar, migration DDL or generator row exists for it.
 */
export interface PackageEngine {
  readonly id: PackageEngineId;
  readonly package: ServingPackage;
  readonly catalog: CatalogEntry;
  readonly connection: PackageConnectionTables;
  readonly fieldRules: FieldRuleSpec;
  readonly grants: PackageGrants;
  /** What a session of the engine is declared to answer: the package's calls, its maintenance and monitoring panels. */
  readonly session: DeclaredSession;
}

/** The composed catalog: the engines admitted packages serve, and the codes of the refused packages naming the others. */
export interface ServerCatalog {
  readonly packages: ReadonlyMap<string, PackageEngine>;
  readonly unavailable: ReadonlyMap<string, readonly string[]>;
}

/**
 * The rules across the whole set of admitted packages and Studio's bundled catalog (`catalogConflicts` in
 * ./server-catalog-compose), each the rule of a `PROVIDER_CATALOG_CONFLICT` refusal.
 */
export const CATALOG_CONFLICT_RULES = Object.freeze([
  "engine-id",
  "fence-alias",
  "query-dialect",
  "tab-type",
  "editor-language",
] as const);

export type CatalogConflictRule = (typeof CATALOG_CONFLICT_RULES)[number];

/** What the server knows of a connection's type. */
export type ServerEngine =
  | { readonly kind: "bundled"; readonly id: DatabaseType }
  | { readonly kind: "package"; readonly engine: PackageEngine }
  | { readonly kind: "unavailable"; readonly id: string; readonly codes: readonly string[] }
  | { readonly kind: "refused"; readonly refusal: TypeIdRefusal };

/** Which server path checks the type: a route, or the open of a session. */
export type EngineNeed = "route" | "open";

const CATALOG_KEY = Symbol.for("libredb-studio.server-engine-catalog");

type CatalogHolder = { [CATALOG_KEY]?: ServerCatalog };

/** The refusal of a package engine, by the path that refused it. */
const UNSUPPORTED_SENTENCES: Readonly<Record<EngineNeed, string>> = Object.freeze({
  route:
    "This request is served for an engine of a provider package only by Test Connection in this LibreDB Studio, and this is another request.",
  open: "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
});

/** The installed catalog, or undefined. */
function installed(): ServerCatalog | undefined {
  return (globalThis as CatalogHolder)[CATALOG_KEY];
}

/** What the server knows of `value`, a connection's type as a client or a store gave it. */
export function serverEngine(value: unknown): ServerEngine {
  if (isDatabaseType(value)) return { kind: "bundled", id: value };
  const catalog = installed();
  if (typeof value === "string" && catalog !== undefined) {
    const engine = catalog.packages.get(value);
    if (engine !== undefined) return { kind: "package", engine };
    const codes = catalog.unavailable.get(value);
    if (codes !== undefined) return { kind: "unavailable", id: value, codes };
  }
  return { kind: "refused", refusal: typeIdRefusal(value) as TypeIdRefusal };
}

/** The refusal of a request for an admitted package's engine `id` on the path `need`. */
export function packageEngineRefusal(id: string, need: EngineNeed): PackageEngineUnsupportedError {
  return new PackageEngineUnsupportedError(UNSUPPORTED_SENTENCES[need], id);
}

/**
 * The refusal of a connection type that is no bundled type id, or null for a bundled one: a refused package's engine
 * as `ProviderUnavailableError`, an admitted package's engine as `PackageEngineUnsupportedError` for `need`, and every
 * other value as `UnknownProviderError`, exactly as `assertDatabaseType` refuses it. A surface that answers a refusal
 * as text, as MCP's `list_connections` and its tools do, reads its message; every other one throws it through
 * `assertBundledEngine`.
 */
export function bundledEngineRefusal(
  value: unknown,
  need: EngineNeed,
): ProviderUnavailableError | PackageEngineUnsupportedError | UnknownProviderError | null {
  const engine = serverEngine(value);
  if (engine.kind === "bundled") return null;
  if (engine.kind === "unavailable") {
    return new ProviderUnavailableError(
      `The connection type ${quoteTypeId(engine.id)} is served by a provider package this LibreDB Studio refused when it started (${engine.codes.join(", ")}), so no provider can open it; the server's log names the package and why.`,
      engine.id,
      engine.codes,
    );
  }
  if (engine.kind === "package") return packageEngineRefusal(engine.engine.id, need);
  return new UnknownProviderError(engine.refusal);
}

/**
 * Refuses a connection type that is no bundled type id with `bundledEngineRefusal`'s answer.
 *
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {PackageEngineUnsupportedError} When an admitted package serves the engine.
 * @throws {UnknownProviderError} When the type is absent, not text, or names no engine the server knows.
 */
export function assertBundledEngine(value: unknown, need: EngineNeed): asserts value is DatabaseType {
  const refusal = bundledEngineRefusal(value, need);
  if (refusal !== null) throw refusal;
}

/**
 * Installs `catalog` as the process's server catalog, once.
 *
 * @throws {Error} When a catalog is installed already: boot composes it once, and a second composition is a host defect.
 */
export function installServerCatalog(catalog: ServerCatalog): void {
  const holder = globalThis as CatalogHolder;
  if (holder[CATALOG_KEY] !== undefined) {
    throw new Error("The server's engine catalog is already installed in this process: boot composes it once.");
  }
  holder[CATALOG_KEY] = catalog;
}

/** Whether a server catalog is installed in this process. */
export function serverCatalogInstalled(): boolean {
  return installed() !== undefined;
}

/** Test seam: forgets the installed catalog, as a new process would; a process never calls it. */
export function forgetServerCatalog(): void {
  delete (globalThis as CatalogHolder)[CATALOG_KEY];
}
