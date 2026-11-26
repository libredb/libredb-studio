import { editorExecutionContext } from "@/lib/api/execution-context";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { legacyProviderRefusal, servedEngineRecord } from "@/lib/db/server-catalog";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseType } from "@/lib/types";
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
 * A connection whose type is not a type id has no row to read: it answers the server's engine catalog's refusal
 * (`legacyProviderRefusal` in src/lib/db/server-catalog.ts) before any grant or posture is read, the type id refusal's
 * own sentence for a type that names no provider this Studio has (FND-1), the sentence naming the refusal codes for an
 * engine only refused provider packages name, and the open's sentence for an admitted package's engine (C-107).
 * Otherwise the `deniedFileAccessRefusal` grant of the connection's engine record is read first, so only an engine that
 * refuses a denied handle asks for a posture. That sentence names no engine, as `list_connections` serves every engine.
 */

/** What `list_connections` lists and `inspect_schema` answers for a connection no MCP open can serve for its caller. */
export const MCP_CONNECTION_UNAVAILABLE_TEXT =
  "This connection is not available to MCP: its engine opens only with full file access, which Studio grants only to an admin on a seed limited to the admin role, so an operator limits this seed's roles to admin.";

/**
 * The server catalog's refusal sentence when `connection`'s type is not a type id; the sentence when its engine refuses a handle
 * opened with file access denied and `caller`'s posture on that record denies it; otherwise null. `grantsOf`, the
 * reader of an engine's grants, defaults to the engine record's (`servedEngineRecord`) and is injectable for the tests.
 * It throws nothing: a refusal is answered as its sentence.
 */
export function mcpConnectionUnavailable(
  caller: McpCaller,
  connection: ManagedConnection,
  grantsOf: (type: DatabaseType) => Pick<EngineGrants, "deniedFileAccessRefusal"> = (type) =>
    servedEngineRecord(type).grants,
): string | null {
  const refusal = legacyProviderRefusal(connection.type, "open");
  if (refusal !== null) return refusal.message;
  if (grantsOf(connection.type).deniedFileAccessRefusal === null) return null;
  return editorExecutionContext(caller, connection).allowExternalFileAccess ? null : MCP_CONNECTION_UNAVAILABLE_TEXT;
}
