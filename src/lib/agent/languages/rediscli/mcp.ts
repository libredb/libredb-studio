/**
 * The Redis command language's MCP facet: `run_redis_read`, one metadata read of the agent's closed command table, read
 * and admitted by the agent's own Redis adapter.
 *
 * The MCP module runs it with the agent's own reader, admission and `queryReadOnly`, so an MCP client gets what an
 * agent run gets: the ACL user proved read-only by the server before every command, on that command's own connection,
 * and an answer projected to counts, types and sizes that never repeats the key it was asked about.
 *
 * No `database` key: a Redis connection reads the database it names and declares no `catalogSessions`, so
 * `providerInDatabase` would refuse every call that named one, as the agent's own Redis tool leaves it out. A key
 * grouping is a `keyspace` relation, which inspect_schema lists, so the tool does not hold that inspect_schema has
 * nothing there.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const REDISCLI_MCP_FACET = Object.freeze({
  tool: "run_redis_read",
  title: "Run a read-only Redis metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only Redis metadata read on a connection: one command on one line, either DBSIZE, or, for one key the command names, TYPE, EXISTS, TTL, PTTL, STRLEN, LLEN, HLEN, SCARD, ZCARD, XLEN, OBJECT ENCODING or MEMORY USAGE (with SAMPLES 1 to 5), such as "TYPE user:42" or "MEMORY USAGE session:9 SAMPLES 5". Key names count as stored values, so the answer is one row of counts, types and sizes that never repeats the key: no command lists keys (SCAN, KEYS, RANDOMKEY) or reads a value, a hash field, a set or sorted-set member or a stream entry, and INFO is not read. Any other command, a second command and every write are refused before the server is reached. The connection's ACL user is proved read-only by the server before every command, and a key outside that user's key patterns is refused by the server. A read has two effects of the server's own: a read of a key whose time to live has passed deletes it, and on a server whose notify-keyspace-events holds the key-miss class, every key read but OBJECT ENCODING and MEMORY USAGE publishes a keymiss event naming a missing key to the server's own subscribers. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, since every read answers one row.`,
  words: {
    fewerFields: "Read one key at a time",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, read one key at a time, since a Redis read answers one row and is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read one key at a time, and run it again.",
    reached: "the server",
  },
} as const satisfies AgentLanguageMcpFacet);
