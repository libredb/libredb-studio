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
 * The load's check of an etcd seed: one opted into MCP whose effective MCP principal is root is refused, at the field
 * it read. That principal is the seed's agent user when it sets one, since MCP then signs in as it, and the seed's
 * own user otherwise, so a seed whose user is root loads beside an agent user of its own. A principal written as a
 * reference, and every other condition of the proof (authentication on, no root role, READ-only roles on no
 * Kubernetes storage prefix and not on every key), are the server's to answer, so they are checked when the
 * connection opens, never read from the file. Case-sensitive, as etcd user names are.
 */
function etcdLoadRefusals(
  conn: SeedCheckedFields,
  isReference: (value: string | undefined) => boolean,
): readonly SeedFieldRefusal[] {
  const field = conn.agentUser !== undefined && conn.agentUser !== "" ? "agentUser" : "user";
  const principal = conn[field];
  if (conn.mcp !== true || isReference(principal) || principal !== ROOT_USER) return [];
  return [{ field, sentence: ETCD_MCP_ROOT_REFUSAL }];
}

/** `etcd`: no connection string scheme, no TLS read from a URL query, and the MCP seed's principal checked at load. */
export const ETCD_CONNECTION_STRING: ConnectionStringSpec = {
  scheme: null,
  readTls: null,
  paste: null,
  validateSeed: etcdLoadRefusals,
};
