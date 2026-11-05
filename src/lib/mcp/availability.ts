import { editorExecutionContext } from "@/lib/api/execution-context";
import { REFUSES_DENIED_FILE_ACCESS } from "@/lib/db/compatibility";
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
 * The engine's row is read first, so only an engine that refuses a denied handle asks for a posture. The sentence names
 * no engine, as `list_connections` serves every engine.
 */

/** What `list_connections` lists and `inspect_schema` answers for a connection no MCP open can serve for its caller. */
export const MCP_CONNECTION_UNAVAILABLE_TEXT =
  "This connection is not available to MCP: its engine opens only with full file access, which Studio grants only to an admin on a seed limited to the admin role, so an operator limits this seed's roles to admin.";

/**
 * The sentence when `connection`'s engine refuses a handle opened with file access denied and `caller`'s posture on
 * that record denies it, otherwise null. `refuses` is injectable for the tests.
 */
export function mcpConnectionUnavailable(
  caller: McpCaller,
  connection: ManagedConnection,
  refuses: Readonly<Record<ManagedConnection["type"], boolean>> = REFUSES_DENIED_FILE_ACCESS,
): string | null {
  if (!refuses[connection.type]) return null;
  return editorExecutionContext(caller, connection).allowExternalFileAccess ? null : MCP_CONNECTION_UNAVAILABLE_TEXT;
}
