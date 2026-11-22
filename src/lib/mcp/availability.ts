import { editorExecutionContext } from "@/lib/api/execution-context";
import { REFUSES_DENIED_FILE_ACCESS } from "@/lib/db/compatibility";
import { typeIdRefusal } from "@/lib/db/type-id";
import type { ManagedConnection } from "@/lib/seed";
import type { McpCaller } from "./context";

/**
 * Whether any MCP open of a listed connection can succeed for its caller (#2252, part 2).
 *
 * The file-access posture is the one load-time rule decided per caller: the seed schema refuses the others (a read
 * credential where one is required, read roots) when the file loads, so a listed connection already meets them. This
 * asks `editorExecutionContext` for the posture of the caller's own listed copy, the call `McpConnectionContext.acquire`
 * makes, and Vault resolution never rewrites the id, type, roles or `sharedWithNonAdminRoles` it reads, so the listing
 * and the open agree. It builds no provider and reads no Vault reference.
 *
 * A connection whose type is not a type id (FND-1), such as a seed entry whose type names no provider this Studio has,
 * has no row to read: it answers the refusal's own sentence (`typeIdRefusal`) before any table or posture is read.
 * Otherwise the engine's row is read first, so only an engine that refuses a denied handle asks for a posture. That
 * sentence names no engine, as `list_connections` serves every engine.
 */

/** What `list_connections` lists and `inspect_schema` answers for a connection no MCP open can serve for its caller. */
export const MCP_CONNECTION_UNAVAILABLE_TEXT =
  "This connection is not available to MCP: its engine opens only with full file access, which Studio grants only to an admin on a seed limited to the admin role, so an operator limits this seed's roles to admin.";

/**
 * The refusal's sentence when `connection`'s type is not a type id; the sentence when its engine refuses a handle
 * opened with file access denied and `caller`'s posture on that record denies it; otherwise null. `refuses` is
 * injectable for the tests.
 */
export function mcpConnectionUnavailable(
  caller: McpCaller,
  connection: ManagedConnection,
  refuses: Readonly<Record<ManagedConnection["type"], string | null>> = REFUSES_DENIED_FILE_ACCESS,
): string | null {
  const refusal = typeIdRefusal(connection.type);
  if (refusal !== null) return refusal.sentence;
  if (refuses[connection.type] === null) return null;
  return editorExecutionContext(caller, connection).allowExternalFileAccess ? null : MCP_CONNECTION_UNAVAILABLE_TEXT;
}
