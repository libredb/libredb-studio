import { editorExecutionContext } from "@/lib/api/execution-context";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { servedEngineRecord, servedEngineRefusal } from "@/lib/db/server-catalog";
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
 * A connection whose type the server's engine catalog serves no record of has no grant to read: it answers the
 * catalog's refusal (`servedEngineRefusal` in src/lib/db/server-catalog.ts) before any grant or posture is read, the
 * type id refusal's own sentence for a type that names no provider this Studio has (FND-1), and the sentence naming the
 * refusal codes for an engine only refused provider packages name (C-107). A served record, legacy or package alike, is
 * read by its grants, never by a type-id branch:
 * - its `exposable` grant first: an engine no MCP client is offered answers `MCP_ENGINE_NOT_OFFERED_TEXT`, the open's
 *   twin of the seed loader's refusal of `mcp: true` on such an engine (`refuseMcpWhereNotOffered` in
 *   src/lib/seed/types.ts), so a provider package's engine that no register row offers to MCP is refused before any
 *   word its package wrote can reach a client;
 * - then its `deniedFileAccessRefusal` grant, so only an engine that refuses a denied handle asks for a posture.
 * Neither sentence names an engine, as `list_connections` serves every engine.
 */

/** What `list_connections` lists and `inspect_schema` answers for a connection no MCP open can serve for its caller. */
export const MCP_CONNECTION_UNAVAILABLE_TEXT =
  "This connection is not available to MCP: its engine opens only with full file access, which Studio grants only to an admin on a seed limited to the admin role, so an operator limits this seed's roles to admin.";

/** What `list_connections` lists and every tool answers for a connection of an engine no MCP client is offered. */
export const MCP_ENGINE_NOT_OFFERED_TEXT =
  "This connection is not available to MCP: LibreDB Studio does not offer its engine to MCP clients, so an operator removes mcp from this seed.";

/**
 * The server catalog's refusal sentence when `connection`'s type names no served record; the exposure sentence when its
 * engine record offers it to no MCP client; the sentence when its engine refuses a handle opened with file access denied
 * and `caller`'s posture on that record denies it; otherwise null. `grantsOf`, the reader of an engine's grants,
 * defaults to the engine record's (`servedEngineRecord`) and is injectable for the tests. It throws nothing: a refusal
 * is answered as its sentence.
 */
export function mcpConnectionUnavailable(
  caller: McpCaller,
  connection: ManagedConnection,
  grantsOf: (type: DatabaseType) => Pick<EngineGrants, "exposable" | "deniedFileAccessRefusal"> = (type) =>
    servedEngineRecord(type).grants,
): string | null {
  const refusal = servedEngineRefusal(connection.type);
  if (refusal !== null) return refusal.message;
  const grants = grantsOf(connection.type);
  if (!grants.exposable) return MCP_ENGINE_NOT_OFFERED_TEXT;
  if (grants.deniedFileAccessRefusal === null) return null;
  return editorExecutionContext(caller, connection).allowExternalFileAccess ? null : MCP_CONNECTION_UNAVAILABLE_TEXT;
}
