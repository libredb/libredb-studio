/**
 * The Qdrant request language's MCP facet: `run_qdrant_read`, one REST request line and an optional JSON body, read
 * and admitted by the agent's own Qdrant reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so before every
 * request the server must refuse the read-only proof's two no-op writes, and every answer is the metadata-only
 * projection of names, counts and flags, never a stored payload or vector, as an agent read is.
 *
 * No `database` key: a Qdrant connection names its collection in the request's path and declares no
 * `catalogSessions`, so `providerInDatabase` would refuse every call that named one, as the agent's own Qdrant tool
 * leaves it out. A collection is a relation, so inspect_schema lists the collections and this facet holds tables.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const QDRANTAPI_MCP_FACET = Object.freeze({
  tool: "run_qdrant_read",
  title: "Run a read-only Qdrant metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only Qdrant metadata read on a connection: a REST request line and an optional JSON body, such as "GET /collections", "GET /collections/articles", "GET /collections/articles/exists", "GET /collections/articles/aliases", "GET /collections/articles/cluster", "GET /aliases", "GET /" or "POST /collections/articles/points/count" with an optional {"exact": true}. The answer carries names, counts and flags only, never a stored payload or vector. Point reads, scrolls, facets, every query, a count filter and every write are refused before the server is reached, and before every read the server must refuse an empty alias update and an empty point delete on each collection the key lists, so a key that can write is refused. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so read one collection instead of a whole list.`,
  words: {
    fewerFields:
      "Read a narrower route, one collection instead of a whole list, or a collection's count, aliases or cluster layout instead of its full description,",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, raise max_rows (at most 500) when the row limit cut the read, or read a narrower route, since a Qdrant read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read one collection on its own, and run it again.",
    reached: "the server",
  },
} as const satisfies AgentLanguageMcpFacet);
