/**
 * The Milvus request language's MCP facet: `run_milvus_read`, one Milvus REST v2 request line and an optional JSON
 * body, read and admitted by the agent's own Milvus reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so before every
 * request the server must prove the connection's user read-only, every call naming a collection is sent only when the
 * user's own collection list holds that name, and every answer is the metadata-only projection of names, counts and
 * flags, never a stored field value or vector, as an agent read is.
 *
 * No `database` key: a Milvus connection reads the database it names and declares no `catalogSessions`, so
 * `providerInDatabase` would refuse every call that named one, as the agent's own Milvus tool leaves it out. A
 * collection is a relation, so inspect_schema lists the collections and this facet holds tables.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const MILVUSRPC_MCP_FACET = Object.freeze({
  tool: "run_milvus_read",
  title: "Run a read-only Milvus metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only Milvus metadata read on a connection's own database: a Milvus REST v2 request line and an optional JSON body, such as "POST /v2/vectordb/databases/list", "POST /v2/vectordb/collections/list", or with {"collectionName": "articles"} collections/describe, collections/get_stats, collections/get_load_state, partitions/list, indexes/list or aliases/list, indexes/describe with an indexName, or aliases/describe with an aliasName. The answer carries names, counts and flags only, never a stored field value or vector, and only of the collections collections/list lists the connection's user: a collection outside its grants, an alias where a collection's name stands and a name no collection has are refused alike, and aliases/list names a collection. Queries, gets, searches, every write, Load and Release, and a dbName naming another database are refused before the server is reached, and before every read the server must prove the user read-only. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so read one collection instead of a whole list.`,
  words: {
    fewerFields:
      "Read a narrower route, one collection instead of the whole list, or a collection's indexes, row count or load state instead of its full description,",
    readPast: (shown: number) =>
      `read past the ${shown} row${shown === 1 ? "" : "s"} returned, read a narrower route, one collection instead of a whole list, since a Milvus read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read one collection's indexes, row count or load state on its own, and run it again.",
    reached: "the server",
  },
} as const satisfies AgentLanguageMcpFacet);
