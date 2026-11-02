/**
 * The Weaviate request language's MCP facet: `run_weaviate_read`, one metadata read under the agent's own boundary.
 *
 * The MCP module reads it with the agent's own reader, admission and `queryReadOnly`, so every answer is the
 * metadata-only projection agent mode reads, after the server proves the key a viewer again. The server filters the
 * schema, tenant and alias lists by the key's grants; a verbose node read, which it does not filter by tenant, names no
 * shard (docs/providers/weaviate.md, section Agent mode).
 *
 * No `database` key: a Weaviate connection reaches one server and declares no `catalogSessions`, so `providerInDatabase`
 * would refuse every call that named one, as the agent's own statement tool leaves it out. A collection is part of
 * the request.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const WEAVIATEAPI_MCP_FACET = Object.freeze({
  tool: "run_weaviate_read",
  title: "Run a read-only Weaviate metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  // A Weaviate collection is a relation kind, which inspect_schema lists.
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only Weaviate metadata read on a connection, written as a REST request line and an optional JSON body, as agent mode writes it: GET /v1/meta, /v1/schema, /v1/schema/{collection}, /v1/schema/{collection}/shards (?tenant= for a multi-tenant collection), /v1/schema/{collection}/tenants, /v1/schema/{collection}/tenants/{tenant}, /v1/aliases, /v1/aliases/{alias}, /v1/nodes or /v1/nodes/{collection} (?output=verbose for each collection's shard and object counts), or POST /v1/aggregate/{collection} with an optional {"tenant": "..."} for an object count. The answer carries names, counts and flags only, never a stored object, property or vector, and a verbose node read names no shard. Object reads, searches, GraphQL, an aggregate's where and groupBy, and every write are refused before anything is sent, and a COLD tenant is refused rather than woken. Before every read the server proves the connection's key holds the viewer role's read actions only, and it answers the collections, tenants and aliases that key may read. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so read one collection, tenant or alias rather than a whole list, and a collection with more than 1000 tenants cannot be listed.`,
  words: {
    fewerFields: "Read one collection's schema, tenants or nodes rather than the whole server's",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, read one collection, tenant or alias at a time, since a Weaviate read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read one collection, tenant or alias instead, and run it again.",
    reached: "the server",
  },
} as const satisfies AgentLanguageMcpFacet);
