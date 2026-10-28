/**
 * The mongo language's MCP facet: `run_mongo_command`, one JSON command envelope read and admitted by the agent's own
 * MongoDB adapter.
 *
 * No `database` key: a MongoDB connection reads the database it is bound to and declares no `catalogSessions`, so
 * `providerInDatabase` would refuse every call that named one, as the agent's own MongoDB tool leaves it out.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const MONGO_MCP_FACET = Object.freeze({
  tool: "run_mongo_command",
  title: "Run a read-only MongoDB command",
  statementInput: z.record(z.string(), z.unknown()),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only MongoDB command on a connection: a JSON command envelope with the keys its operation takes and no others. find takes "filter" and "options" ("projection", "sort", "skip", "limit"); findOne takes "filter" and "options" ("projection" only); aggregate takes "pipeline" only; count takes "filter"; distinct takes "field" and "filter". For example {"collection": "orders", "operation": "find", "filter": {"status": "paid"}}. Write the collection by its bare name, a date as {"$date": "2026-03-01T00:00:00Z"} and an ObjectId as {"$oid": "<24 hex digits>"}. Writes and the write stages of a pipeline ($out, $merge) are refused before the database is reached. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so page inside the command with a find's "skip" or a $skip stage.`,
  words: {
    fewerFields: "Project fewer fields",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, skip them with a find's "skip" or a $skip stage.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Narrow the read to fewer or smaller fields, and run it again.",
    reached: "the database",
  },
} as const satisfies AgentLanguageMcpFacet);
