/**
 * The libredbkv language's MCP facet: `run_libredb_read`, one LibreDB read command read and admitted by the agent's own
 * LibreDB adapter.
 *
 * The MCP module reads it with the agent's own reader, admission and `queryReadOnly`, so every command opens the
 * connection's file on a read-only handle of its own, which takes no lock and cannot write, and every answer leaves the
 * file's reserved internal namespace out, as an agent read does. No `database` key: a LibreDB connection's database is
 * its file's path, which the seed names, so a client never names another file, and the connection declares no
 * `catalogSessions`, so `providerInDatabase` would refuse every call that named one.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const LIBREDBKV_MCP_FACET = Object.freeze({
  tool: "run_libredb_read",
  title: "Run a read-only LibreDB command",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  // A LibreDB table, collection and keyspace are relations, so inspect_schema lists them.
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only LibreDB command on a connection: one line, where get <key> reads one key, prefix <p> every key that starts with p, and range <start> <end> the keys from start up to but not including end. Every key is matched exactly, with no glob and no wildcard; quote a key that holds a space. Each row is one key and its value. put, delete and anything else are refused before the file is opened. Each command opens the connection's file read-only, on a handle of its own that takes no lock and cannot write, so the Studio editor keeps the file and keeps writing. The file's own internal catalog keys are never answered. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so narrow the read with a longer prefix or a closer range.`,
  words: {
    fewerFields: "Read keys whose values are smaller",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, read on with range <the last key returned> <end>: a range includes its start, so its first row is the last one returned again.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit: a key's value is answered whole, never cut. Read keys whose values are smaller.",
    reached: "the file",
  },
} as const satisfies AgentLanguageMcpFacet);
