import { createDatabaseProvider, getOrCreateProvider } from "@/lib/db";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

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

/** The editor provider for a request, in its `catalog`; refused from the declaration before any socket. */
export async function editorProvider(
  connection: DatabaseConnection,
  session: { role: string },
  catalog: string | undefined,
): Promise<DatabaseProvider> {
  if (catalog !== undefined && (await createDatabaseProvider(connection)).getCapabilities().catalogSessions !== true) {
    throw new DatabaseConfigError(
      `This ${connection.type} connection runs every request in its own database, so it takes no "catalog"`,
      connection.type,
    );
  }
  const provider = await getOrCreateProvider(connection, {}, editorExecutionContext(session, connection));
  return scopeToCatalog(provider, catalog);
}
