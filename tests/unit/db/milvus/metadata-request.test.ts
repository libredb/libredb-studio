/**
 * The agent's reader of one Milvus request: the console's own grammar and phase 0, then two refusals of its own, made
 * before anything is sent. It is pure: it takes no client.
 */
import { describe, expect, test } from "bun:test";
import {
  MILVUS_AGENT_OPS,
  MILVUS_AGENT_SENTENCES,
  readMilvusAgentStatement,
} from "@/lib/db/providers/vector/milvus/metadata-request";
import { MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";

const request = (route: string, body?: unknown) =>
  body === undefined ? `POST /v2/vectordb/${route}` : `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;

describe("the routes an agent request may name", () => {
  test("are every console route that answers metadata, and no entity route", () => {
    expect([...MILVUS_AGENT_OPS].sort()).toEqual(
      MILVUS_ROUTES.map((route) => route.op)
        .filter((op) => !op.startsWith("entities/"))
        .sort(),
    );
  });

  test.each([
    [request("databases/list"), { op: "databases/list", db: "analytics" }],
    [request("databases/describe", { dbName: "analytics" }), { op: "databases/describe" }],
    [request("collections/list", { dbName: "analytics" }), { op: "collections/list" }],
    [request("collections/list"), { op: "collections/list", db: "analytics" }],
    [request("collections/describe", { collectionName: "docs" }), { op: "collections/describe", collection: "docs" }],
    [request("collections/get_stats", { collectionName: "docs" }), { op: "collections/get_stats", collection: "docs" }],
    [
      request("collections/get_load_state", { collectionName: "docs", partitionNames: ["part_a"] }),
      { op: "collections/get_load_state", collection: "docs", partitionNames: ["part_a"] },
    ],
    [request("partitions/list", { collectionName: "docs" }), { op: "partitions/list", collection: "docs" }],
    [request("indexes/list", { collectionName: "docs" }), { op: "indexes/list", collection: "docs" }],
    [
      request("indexes/describe", { collectionName: "docs", indexName: "vec_idx" }),
      { op: "indexes/describe", collection: "docs", indexName: "vec_idx" },
    ],
    [request("aliases/list"), { op: "aliases/list", collection: undefined }],
    [request("aliases/list", { collectionName: "docs" }), { op: "aliases/list", collection: "docs" }],
    [request("aliases/describe", { aliasName: "docs_alias" }), { op: "aliases/describe", alias: "docs_alias" }],
  ])("%s is admitted, in the connection's database", (text, expected) => {
    const reading = readMilvusAgentStatement(text, "analytics");
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.plan).toMatchObject({ ...expected, db: "analytics" });
  });

  test("read without the connection, as the agent's admission reads it, a dbName is left to the provider", () => {
    const reading = readMilvusAgentStatement(request("databases/describe", { dbName: "probe_db" }));
    expect(reading.ok && reading.plan.db).toBe("probe_db");
    const plain = readMilvusAgentStatement(request("collections/list"));
    expect(plain.ok && plain.plan.db).toBe("default");
  });
});

describe("what an agent request may not be", () => {
  test.each([
    [
      request("entities/query", { collectionName: "docs", filter: "id > 0", outputFields: ["title"] }),
      "entities/query",
    ],
    [request("entities/get", { collectionName: "docs", id: 1 }), "entities/get"],
    [
      request("entities/search", { collectionName: "docs", annsField: "vec", data: [[0.1, 0.2, 0.3, 0.4]] }),
      "entities/search",
    ],
    [request("entities/search", { collectionName: "docs", annsField: "sparse", data: ["vectors"] }), "entities/search"],
    [
      request("entities/hybrid_search", {
        collectionName: "docs",
        search: [{ annsField: "vec", data: [[0.1, 0.2, 0.3, 0.4]], limit: 3 }],
        rerank: { strategy: "rrf", params: { k: 60 } },
      }),
      "entities/hybrid_search",
    ],
  ])("%s answers stored values, or runs a function on the server, and is refused", (text, route) => {
    expect(readMilvusAgentStatement(text)).toEqual({
      ok: false,
      code: "metadata-only",
      message: MILVUS_AGENT_SENTENCES.metadataOnly(route),
    });
  });

  test.each([
    request("collections/list", { dbName: "other" }),
    request("collections/list", { dbName: "default" }),
    request("databases/describe", { dbName: "probe_db" }),
    request("collections/describe", { dbName: "Analytics", collectionName: "docs" }),
  ])("%s names another database and is refused: the agent reads the connection's own", (text) => {
    const reading = readMilvusAgentStatement(text, "analytics");
    expect(reading).toEqual({ ok: false, code: "database", message: MILVUS_AGENT_SENTENCES.database });
  });

  test.each([
    [request("entities/insert", { collectionName: "docs", data: [] }), "entities/insert"],
    [request("collections/load", { collectionName: "docs" }), "collections/load"],
    [request("collections/release", { collectionName: "docs" }), "collections/release"],
    [request("collections/drop", { collectionName: "docs" }), "collections/drop"],
    [request("collections/flush", { collectionName: "docs" }), "collections/flush"],
    [request("collections/compact", { collectionName: "docs" }), "collections/compact"],
    [request("jobs/import/create", { collectionName: "docs", files: [] }), "jobs/import/create"],
    [request("users/create", { userName: "u", password: "not-a-real-password" }), "users/create"],
  ])("%s is no console route, and is refused by the console's own reading", (text, route) => {
    const reading = readMilvusAgentStatement(text);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.code).toBe("request");
    expect(reading.message).toContain(route);
  });

  test("a key the route does not take is refused by name, never dropped", () => {
    const reading = readMilvusAgentStatement(request("collections/describe", { collectionName: "docs", extra: 1 }));
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.code).toBe("request");
    expect(reading.message).toContain("extra");
  });

  test("a body that is not a request, and a name the console does not take, are refused", () => {
    for (const text of [
      "",
      "GET /v2/vectordb/collections/list",
      request("collections/describe", { collectionName: "a b" }),
    ]) {
      const reading = readMilvusAgentStatement(text);
      expect(reading.ok).toBe(false);
    }
  });
});
