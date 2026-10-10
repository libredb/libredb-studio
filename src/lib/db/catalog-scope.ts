import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

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
 * that catalog. A catalog on a connection that declares no `catalogSessions` is refused.
 */
export async function scopeToCatalog(
  provider: DatabaseProvider,
  catalog: string | undefined,
): Promise<DatabaseProvider> {
  if (catalog === undefined) return provider;
  if (provider.getCapabilities().catalogSessions !== true || provider.forCatalog === undefined) {
    throw new DatabaseConfigError(
      `This ${provider.type} connection runs every request in its own database and cannot run one in "${catalog}"`,
      provider.type,
    );
  }
  return provider.forCatalog(catalog);
}

/** Refuses a walk over every container of a server-level connection (#1530): it would open every database. */
export function assertNotWholeServer(provider: DatabaseProvider): void {
  if (provider.getCapabilities().catalogSessions === true) {
    throw new DatabaseConfigError(
      `This ${provider.type} connection reaches every database on its server: name the containers to read`,
      provider.type,
    );
  }
}
