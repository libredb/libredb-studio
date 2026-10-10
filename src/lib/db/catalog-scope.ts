import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/** The connection a session in `catalog` amounts to, for identities and labels (#1530). */
export function catalogSessionConnection<C extends DatabaseConnection>(connection: C, catalog: string): C {
  return { ...connection, database: catalog };
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
