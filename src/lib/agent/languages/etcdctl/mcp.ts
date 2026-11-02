/**
 * The etcdctl command language's MCP facet: `run_etcd_read`, one etcdctl command on one line, read and admitted by the
 * agent's own etcd reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so before every
 * command the server must prove the connection's user reads only (authentication on, no root role, every permission
 * READ, and no READ range that holds every key or a key under a Kubernetes storage prefix), and every answer is the
 * metadata-only projection of names, counts and sizes, never a key name or a stored value, as an agent read is.
 *
 * No `database` key: an etcd cluster is one key space and declares no `catalogSessions`, so `providerInDatabase` would
 * refuse every call that named one, as the agent's own etcd tool leaves it out. A key prefix is a relation kind, so the
 * facet holds tables; inspect_schema lists none on etcd all the same, since key names are withheld from every
 * agent-mode handle, and the description says so.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const ETCDCTL_MCP_FACET = Object.freeze({
  tool: "run_etcd_read",
  title: "Run a read-only etcd metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only etcd metadata read on a connection: one etcdctl command on one line, such as "endpoint status", "member list", "alarm list", "auth status", "lease list", "lease timetolive 694d8147df1dc4c8" or "get /app/config" for one key you name, which answers its existence, revisions, version, lease and value size. Double-quote a key that holds a space. The answer carries names, counts and sizes only: never a key name, a stored value or a member's address. A get over a range or a prefix, a value read, a watch, a txn, every write and maintenance call, and every flag but the two of the key count are refused before the cluster is reached, and before every read the server must show the connection's user holds only READ, on no Kubernetes storage prefix and not on every key, so the count of every key is refused by the server. A key outside the user's READ ranges is refused alike whether it exists or not. inspect_schema lists no key prefix of an etcd connection, since key names are withheld. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so read one lease with lease timetolive, or the cluster with endpoint status, instead of a whole list.`,
  words: {
    fewerFields: "Read one lease with lease timetolive, or the cluster with endpoint status, instead of a whole list,",
    readPast: (shown: number, cut: "max_rows" | "result_bytes") =>
      `read past the ${shown} row${shown === 1 ? "" : "s"} returned, ${cut === "max_rows" ? "raise max_rows (at most 500), or " : ""}read one lease with lease timetolive, since an etcd read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read one lease or one key on its own, and run it again.",
    reached: "the cluster",
  },
} as const satisfies AgentLanguageMcpFacet);
