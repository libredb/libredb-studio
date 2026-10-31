/**
 * The agent's reader of one Qdrant request (`metadata-request.ts`): the console's own grammar and phase 0 under it,
 * the metadata routes an agent may name, every route that answers stored payloads or vectors, or that is outside the
 * metadata projections, refused by name, and a count that counts by stored values refused by the key that would.
 */
import { describe, expect, test } from "bun:test";
import {
  QDRANT_AGENT_OPS,
  QDRANT_AGENT_SENTENCES,
  readQdrantAgentStatement,
} from "@/lib/db/providers/vector/qdrant/metadata-request";
import { QDRANT_ROUTES } from "@/lib/db/providers/vector/qdrant/routes";

describe("the routes an agent request may name", () => {
  test("are the version, collection, alias, count and cluster reads, nothing else", () => {
    expect([...QDRANT_AGENT_OPS]).toEqual([
      "root",
      "get_collections",
      "get_collection",
      "collection_exists",
      "get_collections_aliases",
      "get_collection_aliases",
      "count_points",
      "collection_cluster_info",
    ]);
    const refused = QDRANT_ROUTES.map((route) => route.op).filter((op) => !QDRANT_AGENT_OPS.has(op));
    expect(refused).toEqual([
      "get_points",
      "get_point",
      "scroll_points",
      "facet",
      "query_points",
      "query_batch_points",
      "query_points_groups",
      "get_optimizations",
      "list_snapshots",
    ]);
  });

  const admitted = [
    "GET /",
    "GET /collections",
    "GET collections",
    "GET /collections/plain",
    "GET /collections/plain/exists",
    "GET /aliases",
    "GET /collections/plain/aliases",
    "POST /collections/plain/points/count",
    "POST /collections/plain/points/count {}",
    'POST /collections/plain/points/count {"exact": false}',
    "POST /collections/plain/points/count?consistency=majority",
    "GET /collections/plain/cluster",
    "// a comment the console strips\nGET /collections",
  ];
  for (const text of admitted) {
    test(`${JSON.stringify(text)} is admitted`, () => {
      const reading = readQdrantAgentStatement(text);
      expect(reading.ok).toBe(true);
    });
  }

  test("the reading is the console's own: the route, the path parameters and the body with its defaults", () => {
    const reading = readQdrantAgentStatement("POST /collections/plain/points/count");
    if (!reading.ok) throw new Error(reading.message);
    expect(reading.plan.route.op).toBe("count_points");
    expect(reading.plan.request.params).toEqual({ collection_name: "plain" });
    expect(reading.plan.body).toEqual({ exact: true });
  });
});

describe("what is refused before anything is sent", () => {
  const valueRoutes: readonly [string, string][] = [
    ['POST /collections/plain/points {"ids": [1]}', "POST /collections/{collection_name}/points"],
    ["GET /collections/plain/points/1", "GET /collections/{collection_name}/points/{id}"],
    [
      'POST /collections/plain/points/scroll {"with_payload": false}',
      "POST /collections/{collection_name}/points/scroll",
    ],
    ['POST /collections/plain/facet {"key": "city"}', "POST /collections/{collection_name}/facet"],
    ['POST /collections/plain/points/query {"query": [0.1, 0.2]}', "POST /collections/{collection_name}/points/query"],
    [
      'POST /collections/plain/points/query/batch {"searches": [{"query": [0.1]}]}',
      "POST /collections/{collection_name}/points/query/batch",
    ],
    [
      'POST /collections/plain/points/query/groups {"query": [0.1], "group_by": "city"}',
      "POST /collections/{collection_name}/points/query/groups",
    ],
    ["GET /collections/plain/optimizations", "GET /collections/{collection_name}/optimizations"],
    ["GET /collections/plain/snapshots", "GET /collections/{collection_name}/snapshots"],
  ];
  for (const [text, line] of valueRoutes) {
    test(`${text.split(" {")[0]} is refused by its route template, never the request's own words`, () => {
      expect(readQdrantAgentStatement(text)).toEqual({
        ok: false,
        code: "metadata-only",
        message: QDRANT_AGENT_SENTENCES.metadataOnly(line),
      });
    });
  }

  test("a query with an inference object is refused by its route before its body is read for what it would call", () => {
    for (const body of [
      '{"query": {"text": "hello", "model": "m"}}',
      '{"query": {"image": "http://example.invalid/x.png", "model": "m"}}',
      '{"query": {"object": {"a": 1}, "model": "m"}}',
      '{"prefetch": [{"query": {"text": "hello", "model": "m"}}], "query": [0.1]}',
    ]) {
      const reading = readQdrantAgentStatement(`POST /collections/plain/points/query ${body}`);
      expect(reading.ok).toBe(false);
      if (!reading.ok) expect(["metadata-only", "request"]).toContain(reading.code);
    }
  });

  for (const key of ["filter", "shard_key"]) {
    test(`a count's ${key} is refused by its key: it counts by stored values or by a key's value`, () => {
      const body =
        key === "filter" ? '{"filter": {"must": [{"key": "city", "match": {"value": "x"}}]}}' : '{"shard_key": "a"}';
      expect(readQdrantAgentStatement(`POST /collections/plain/points/count ${body}`)).toEqual({
        ok: false,
        code: "count-shape",
        message: QDRANT_AGENT_SENTENCES.countShape(key),
      });
    });
  }

  const grammar = [
    "PUT /collections/plain/points",
    "DELETE /collections/plain",
    "POST /collections/aliases",
    "POST /collections/plain/points/delete",
    "POST /collections/plain/snapshots",
    "GET /cluster",
    "GET /telemetry",
    "GET /collections/plain/points/count",
    'POST /collections/plain/points/count {"exakt": true}',
    "GET /collections/..",
    "GET /collections/plain\nGET /collections/other",
    "",
  ];
  for (const text of grammar) {
    test(`${JSON.stringify(text)}: the console's own grammar refuses it`, () => {
      const reading = readQdrantAgentStatement(text);
      expect(reading.ok).toBe(false);
      if (!reading.ok) expect(reading.code).toBe("request");
    });
  }

  test("a refusal's sentence never repeats the request's own text", () => {
    const reading = readQdrantAgentStatement('POST /collections/stored-secret-name/facet {"key": "stored-secret-key"}');
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.message).not.toContain("stored-secret");
  });

  test("an error that is not a refusal is not swallowed", () => {
    expect(() => readQdrantAgentStatement(undefined as unknown as string)).toThrow();
  });
});
