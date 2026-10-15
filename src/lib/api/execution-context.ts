import type { EditorExecutionContext } from "@/lib/db/types";
import { governanceEnabled } from "@/lib/governance/config";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The namespace `resolveConnection` fills from the operator's seed configuration. A body that claims
 * an id in it is replaced by the operator's own record before any route sees it, so an id here is the
 * operator's, and so are the roles on the record.
 */
const SEED_NAMESPACE = "seed:";

/**
 * The pool size of each user's provider under governance (spec 9.4): the default of the runtime setting
 * `provider.poolMaxPerUser` (spec 7.8), which `tests/unit/lib/api/execution-context.test.ts` holds equal to the
 * registry's.
 */
const OWNER_POOL_MAX = 3;

// One template literal, never a concatenation across lines: bun's line coverage under-counts the continuation lines
// of a message built that way.
const SUBJECT_MISSING_MESSAGE =
  "Under governance every provider belongs to one user, named by the identity provider's subject, and this session carries none";

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
 * The owner of a governed session's providers (spec 9.4): its identity provider subject, the key grants name a user
 * by, never the username, which is a display label (spec 3.2 D2).
 */
function governedOwner(session: { idpSubject?: string }): string {
  const subject = session.idpSubject;
  // getSession() refuses a session without a subject under governance (src/lib/local-accounts.ts), and no grant names
  // one, so one that gets here is an error, never a reason to hand it the provider every user of a connection shares.
  if (typeof subject !== "string" || subject === "") throw new Error(SUBJECT_MISSING_MESSAGE);
  return subject;
}

/**
 * The server-derived execution context for an ordinary (editor) database request (non-admin DuckDB file access).
 *
 * Built from the VERIFIED session role and the RESOLVED connection, never from the request body, so a
 * caller cannot widen what the provider is allowed to do. The db routes pass the result to
 * `getOrCreateProvider` (and `createDatabaseProvider` on the routes that build their own provider),
 * which hands it to the provider and folds it into the handle cache key.
 *
 * SQLite and DuckDB read the field it sets. SQLite refuses a denied connection because its
 * drivers cannot confine statement-level file access. For DuckDB, `false` opens the handle with
 * `enable_external_access: 'false'`, so no statement reaches the network, or a file other than the
 * database's own and the handle's private temp directory, while that database stays writable; `true`
 * keeps the full editor reach. It closes statement-level reach only: the database path itself is
 * still the connection's.
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
 *
 * Under governance (`GOVERNANCE_SOURCE`, docs/GOVERNANCE.md) it also names the owner of a per-user provider
 * (spec 9.4): `owner`, the session's identity provider subject, and `ownerPoolMax`, the pool size of that user's
 * provider. The factory keys, opens and records a provider per owner, so two users of one connection never share a
 * pool, a database session state or an interactive transaction. Without governance neither field is set, and every
 * caller of a connection shares its provider exactly as before.
 */
export function editorExecutionContext(
  session: { role: string; idpSubject?: string },
  connection: DatabaseConnection,
): EditorExecutionContext {
  const allowExternalFileAccess = session.role === "admin" && !openToNonAdminRoles(connection);
  if (!governanceEnabled()) return { allowExternalFileAccess };
  return { allowExternalFileAccess, owner: governedOwner(session), ownerPoolMax: OWNER_POOL_MAX };
}
