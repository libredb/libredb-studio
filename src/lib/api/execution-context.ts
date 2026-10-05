import type { EditorExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The namespace `resolveConnection` fills from the operator's seed configuration. A body that claims
 * an id in it is replaced by the operator's own record before any route sees it, so an id here is the
 * operator's, and so are the roles on the record.
 */
const SEED_NAMESPACE = "seed:";

/**
 * Whether a role other than admin can resolve this record: a seed the operator's configuration offers
 * to `user` or to every role (`*`). Every role it is offered to resolves the SAME record, so whatever
 * posture its handle opens under is the posture all of them share.
 *
 * An inline connection is never shared this way, whatever roles its body carries: it is one
 * requester's own record, so the requester decides it.
 */
function openToNonAdminRoles(connection: DatabaseConnection): boolean {
  if (connection.id?.startsWith(SEED_NAMESPACE) !== true) return false;
  const roles: unknown = (connection as { roles?: unknown }).roles;
  return Array.isArray(roles) && roles.some((role) => role !== "admin");
}

/**
 * The server-derived execution context for an ordinary (editor) database request (non-admin DuckDB file access).
 *
 * Built from the VERIFIED session role and the RESOLVED connection, never from the request body, so a
 * caller cannot widen what the provider is allowed to do. The db routes pass the result to
 * `getOrCreateProvider` (and `createDatabaseProvider` on the routes that build their own provider),
 * which hands it to the provider and folds it into the handle cache key.
 *
 * Only DuckDB reads the one field it sets. `false` opens the handle with
 * `enable_external_access: 'false'`, so no statement reaches a file or the network outside the
 * database the connection names, while that database stays writable; `true` keeps the full editor
 * reach. It closes statement-level reach only: the database path itself is still the connection's.
 *
 * The rule, decided here and nowhere else:
 *
 * - On a connection only its requester uses (an inline connection, or a seed only admins can use),
 *   the requester decides: an admin keeps the full reach and every other role is denied.
 * - On a seed a non-admin role can use, every requester, admin included, is denied. DuckDB serves one
 *   file through one read-write handle per process: a second read-write handle beside the first opens
 *   on Linux and macOS, keeps its own copy of the catalog, and whichever closes last checkpoints over
 *   the other's committed rows, while Windows refuses it. Two postures on one record would be two
 *   cache keys and so two handles, so the record keeps one posture, the narrower one.
 *
 * It is deliberately NOT the agent read-only profile: this closes file access without making the
 * database read-only, which is the owner-scoped change.
 */
export function editorExecutionContext(
  session: { role: string },
  connection: DatabaseConnection,
): EditorExecutionContext {
  return { allowExternalFileAccess: session.role === "admin" && !openToNonAdminRoles(connection) };
}
