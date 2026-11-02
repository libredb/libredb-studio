import type { ConnectionStringSpec, SeedCheckedFields, SeedFieldRefusal } from "@/lib/db/connection-string/types";

/** The user etcd's auth store permits every key without a grant. */
const ROOT_USER = "root";

/**
 * Why a seed opted into MCP may not sign in as root: an MCP client reads etcd only through the agent read-only
 * profile, whose proof refuses root by name when the connection opens, so the file is refused instead of loading a
 * connection every MCP call would be refused on.
 */
export const ETCD_MCP_ROOT_REFUSAL =
  "an etcd seed with mcp: true is read by MCP clients under the agent read-only profile, which refuses etcd's root user, since root may read and write every key. Give the seed an etcd user of its own whose roles grant READ only on the prefixes it should read, outside every Kubernetes storage prefix, or remove mcp from this connection.";

/**
 * The load's check of an etcd seed: one opted into MCP that names root as its user is refused. A user written as a
 * reference, and every other condition of the proof (authentication on, no root role, READ-only roles on no
 * Kubernetes storage prefix and not on every key), are the server's to answer, so they are checked when the
 * connection opens, never read from the file.
 */
function etcdLoadRefusals(
  conn: SeedCheckedFields,
  isReference: (value: string | undefined) => boolean,
): readonly SeedFieldRefusal[] {
  if (conn.mcp !== true || isReference(conn.user) || conn.user !== ROOT_USER) return [];
  return [{ field: "user", sentence: ETCD_MCP_ROOT_REFUSAL }];
}

/** `etcd`: no connection string scheme, no TLS read from a URL query, and the MCP seed's user checked at load. */
export const ETCD_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: etcdLoadRefusals,
};
