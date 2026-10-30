/**
 * The agent's reader of one Weaviate request (`agent-statement.ts`): the console's own grammar and phase 0 under it,
 * the metadata operations an agent may name, every operation that answers stored objects, properties or vectors
 * refused by name, and an aggregate that counts by stored values refused by the key that would.
 */
import { describe, expect, test } from "bun:test";
import {
  readWeaviateAgentStatement,
  WEAVIATE_AGENT_OPS,
  WEAVIATE_AGENT_SENTENCES,
} from "@/lib/db/providers/vector/weaviate/agent-statement";
import { WEAVIATE_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";

const ID = "00000000-0000-4000-8000-000000000001";

describe("the operations an agent request may name", () => {
  test("are the meta, schema, shard, tenant, alias and node reads and the aggregate, nothing else", () => {
    expect([...WEAVIATE_AGENT_OPS]).toEqual([
      "meta",
      "schema",
      "collection",
      "shards",
      "tenants",
      "tenant",
      "aliases",
      "alias",
      "nodes",
      "collection_nodes",
      "aggregate",
    ]);
    const refused = WEAVIATE_ROUTES.map((route) => route.op).filter((op) => !WEAVIATE_AGENT_OPS.has(op));
    expect(refused).toEqual([
      "objects",
      "object",
      "search_bm25",
      "search_hybrid",
      "search_near_vector",
      "search_near_object",
    ]);
  });

  const admitted = [
    "GET /v1/meta",
    "GET /v1/schema",
    "GET /v1/schema/Note",
    "GET /v1/schema/Note/shards",
    "GET /v1/schema/Tenanted/shards?tenant=hot",
    "GET /v1/schema/Tenanted/tenants",
    "GET /v1/schema/Tenanted/tenants/hot",
    "GET /v1/aliases",
    "GET /v1/aliases/NotesAlias",
    "GET /v1/nodes",
    "GET /v1/nodes?output=verbose",
    "GET /v1/nodes/Note?output=minimal",
    "POST /v1/aggregate/Note",
    "POST /v1/aggregate/Note {}",
    'POST /v1/aggregate/Tenanted {"tenant": "hot", "returnMetrics": ["count"]}',
    "// a comment the console strips\nGET /v1/meta",
  ];
  for (const text of admitted) {
    test(`admits ${JSON.stringify(text)}`, () => {
      const reading = readWeaviateAgentStatement(text);
      expect(reading.ok).toBe(true);
    });
  }
});

describe("refused before anything is sent", () => {
  const metadataOnly: readonly [string, string][] = [
    ["GET /v1/objects?class=Note", "GET /v1/objects"],
    [`GET /v1/objects/Note/${ID}?include=vector`, "GET /v1/objects/{collection}/{id}"],
    ['POST /v1/search/Note/bm25 {"query": "x"}', "POST /v1/search/{collection}/bm25"],
    ['POST /v1/search/Note/hybrid {"query": "x", "alpha": 0}', "POST /v1/search/{collection}/hybrid"],
    ['POST /v1/search/Note/near-vector {"vector": [0.1, 0.2]}', "POST /v1/search/{collection}/near-vector"],
    [`POST /v1/search/Note/near-object {"id": "${ID}"}`, "POST /v1/search/{collection}/near-object"],
  ];
  for (const [text, line] of metadataOnly) {
    test(`${line} answers stored values: refused as metadata-only`, () => {
      expect(readWeaviateAgentStatement(text)).toEqual({
        ok: false,
        code: "metadata-only",
        message: WEAVIATE_AGENT_SENTENCES.metadataOnly(line),
      });
    });
  }

  test("the metadata-only sentence names what an agent reads, and that nothing was sent", () => {
    expect(WEAVIATE_AGENT_SENTENCES.metadataOnly("GET /v1/objects")).toBe(
      "GET /v1/objects answers stored objects, their properties or their vectors, which agent mode does not read. Agent mode on Weaviate reads metadata only: GET /v1/meta, /v1/schema, /v1/schema/{collection}, its shards, tenants and one tenant, /v1/aliases and one alias, /v1/nodes and /v1/nodes/{collection}, and POST /v1/aggregate/{collection} for a count. Nothing was sent.",
    );
  });

  const aggregates: readonly [string, string][] = [
    ['POST /v1/aggregate/Note {"where": {"operator": "Equal", "path": ["body"], "valueText": "x"}}', "where"],
    ['POST /v1/aggregate/Note {"groupBy": "body"}', "groupBy"],
    ['POST /v1/aggregate/Note {"groupBy": "body", "limit": 2}', "groupBy"],
  ];
  for (const [text, key] of aggregates) {
    test(`an aggregate with ${key} counts by stored values: refused by that key`, () => {
      expect(readWeaviateAgentStatement(text)).toEqual({
        ok: false,
        code: "aggregate-shape",
        message: WEAVIATE_AGENT_SENTENCES.aggregateShape(key),
      });
    });
  }

  test("the aggregate sentence names the key and the two an agent's aggregate takes", () => {
    expect(WEAVIATE_AGENT_SENTENCES.aggregateShape("where")).toBe(
      'An agent\'s aggregate counts a whole collection or tenant, so it takes "tenant" and "returnMetrics" only; "where" counts by stored values. Nothing was sent.',
    );
  });

  const console: readonly [string, string][] = [
    ["POST /v1/graphql {}", "a GraphQL request"],
    ['POST /v1/search/Note/near-text {"query": ["x"]}', "a search that sends its text or media to a model provider"],
    ['POST /v1/search/Note/hybrid {"query": "x", "alpha": 0.5}', "alpha must be 0"],
    ['POST /v1/search/Note/bm25 {"query": "x", "singlePrompt": "say"}', "singlePrompt"],
    ["POST /v1/objects {}", "an object write"],
    ["DELETE /v1/schema/Note", "a schema, tenant, index or alias change"],
    ["GET /v1/users/own-info", "a user, role or permission route"],
    ["GET /v1/backups/filesystem", "a backup route"],
    ["GET /v1/replication/replicate", "a replication route"],
    ["GET /v1/.well-known/ready", "a health or readiness route"],
    ['POST /v1/aggregate/Note {"over": 1}', "over"],
    ['POST /v1/aggregate/Note {"unknown": 1}', "unknown"],
    ["GET /v1/meta\nGET /v1/schema", ""],
  ];
  for (const [text, words] of console) {
    test(`the console's own reading refuses ${JSON.stringify(text.split("\n")[0])}`, () => {
      const reading = readWeaviateAgentStatement(text);
      expect(reading.ok).toBe(false);
      if (reading.ok) return;
      expect(reading.code).toBe("request");
      expect(reading.message).toContain(words);
    });
  }

  test("a text past the console's byte bound is refused by the console's own reading", () => {
    const reading = readWeaviateAgentStatement(`GET /v1/meta ${"x".repeat(1_048_577)}`);
    expect(reading.ok).toBe(false);
  });
});
