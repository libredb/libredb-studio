import { GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE } from "@/lib/db/claim-grants";
import { DatabaseConfigError } from "@/lib/db/errors";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/** Whether Studio honours the catalog sessions a provider declares on one connection, and if not, why. */
type CatalogChoice = "honoured" | "not-declared" | "engine-not-recorded" | "names-database";

/**
 * Whether Studio honours a caller's choice of database on `connection` (M-57). A provider answers `catalogSessions`
 * per connection, so no record replaces its answer; Studio bounds it instead. The answer is honoured only where the
 * provider declares it, Studio's grant at the choice of database, `GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE`, holds
 * the engine, and the connection names no database and no connection string, the claim's own condition. Read by
 * `scopeToCatalog` (so by every editor route, the VS Code backend and MCP through it), by `providerInDatabase` and by
 * the agent runs route; `assertNotWholeServer` reads the provider's own answer, since there it refuses more
 * (docs/providers/CONTRACT.md, clause M-57).
 *
 * @throws {UnknownProviderError} When the provider declares catalog sessions and `connection.type` is not a type id.
 */
export function catalogChoice(connection: DatabaseConnection, capabilities: ProviderCapabilities): CatalogChoice {
  if (capabilities.catalogSessions !== true) return "not-declared";
  if (!typeIdRow(GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE, connection.type)) return "engine-not-recorded";
  if (connection.database || connection.connectionString) return "names-database";
  return "honoured";
}

/** The two verdicts where the provider declares catalog sessions that Studio does not honour. */
type CatalogChoiceBound = Exclude<CatalogChoice, "honoured" | "not-declared">;

/**
 * Why Studio honours no catalog session on a connection whose provider declares them: the clause each place that
 * refuses a caller's choice of database appends to its own sentence (M-57).
 */
export function catalogChoiceBound(choice: CatalogChoiceBound, type: string): string {
  if (choice === "engine-not-recorded") {
    return `its provider declares a session per database, which Studio grants no ${type} connection`;
  }
  return "it names its own database, so Studio honours no session per database its provider declares";
}

/** The connection a session in `catalog` amounts to, for identities and labels (#1530). */
export function catalogSessionConnection<C extends DatabaseConnection>(connection: C, catalog: string): C {
  return { ...connection, database: catalog };
}

/**
 * The body's `catalog`: the database a request runs in on a server-level connection (#1530). Beside
 * the connection, since a managed one's fields are discarded, and not `database`, which is Redis's.
 */
export function requestCatalog(body: Record<string, unknown>): string | undefined {
  const catalog = body.catalog;
  if (catalog === undefined) return undefined;
  if (typeof catalog !== "string" || catalog.trim() === "") {
    throw new DatabaseConfigError(`"catalog" must be a non-empty string naming a database`);
  }
  return catalog;
}

/**
 * The provider a request runs on (#1530): `provider` itself without a catalog, else its session in
 * that catalog. A catalog is refused wherever `catalogChoice` does not honour the connection the
 * provider was built from (M-57), the refusal saying why when the provider declares catalog sessions.
 */
export async function scopeToCatalog(
  provider: DatabaseProvider,
  catalog: string | undefined,
): Promise<DatabaseProvider> {
  if (catalog === undefined) return provider;
  const choice = catalogChoice(provider.config, provider.getCapabilities());
  const refusal = `This ${provider.type} connection runs every request in its own database and cannot run one in "${catalog}"`;
  if (choice === "engine-not-recorded" || choice === "names-database") {
    throw new DatabaseConfigError(`${refusal}: ${catalogChoiceBound(choice, provider.type)}`, provider.type);
  }
  if (choice === "not-declared" || provider.forCatalog === undefined) {
    throw new DatabaseConfigError(refusal, provider.type);
  }
  return provider.forCatalog(catalog);
}

/**
 * Refuses a walk over every container of a server-level connection (#1530): it would open every database. It reads
 * the provider's own `catalogSessions`, not `catalogChoice`, since here a declaration only refuses more (M-57).
 */
export function assertNotWholeServer(provider: DatabaseProvider): void {
  if (provider.getCapabilities().catalogSessions === true) {
    throw new DatabaseConfigError(
      `This ${provider.type} connection reaches every database on its server: name the containers to read`,
      provider.type,
    );
  }
}
