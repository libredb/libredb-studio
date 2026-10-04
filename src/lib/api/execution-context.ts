import type { ProviderExecutionContext } from "@/lib/db/types";

/**
 * The server-derived execution context for an ordinary (editor) database request (B1 / K1).
 *
 * Built from the VERIFIED session role, never from the request body, so a caller cannot widen
 * what the provider is allowed to do. The db routes pass the result to `getOrCreateProvider`
 * (and `createDatabaseProvider` on the routes that build their own provider), which hands it to
 * the provider and folds it into the handle cache key.
 *
 * Only DuckDB reads the one field it sets: an admin editor keeps full filesystem reach, every
 * other role opens the handle with `enable_external_access: 'false'` so no statement reaches a
 * file while the database stays writable. The policy lives here, in one place, rather than being
 * recomputed at each route. It is deliberately NOT the agent read-only profile: this closes file
 * access without making the database read-only, which is the owner-scoped change.
 */
export function editorExecutionContext(session: { role: string }): ProviderExecutionContext {
  return { allowExternalFileAccess: session.role === "admin" };
}
