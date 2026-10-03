/**
 * The Qdrant client seam (vector-family spec 6.1): the 17 operations, the error a failed answer is classified into,
 * and the slice of the client a consumer is handed, which can send only the operations it names.
 */
import { describe, expect, test } from "bun:test";
import {
  QDRANT_OPS,
  type QdrantAnswer,
  type QdrantClient,
  QdrantError,
  type QdrantSend,
} from "@/lib/db/providers/vector/qdrant/client";

describe("the operations (decision QD3)", () => {
  test("are the 17 OpenAPI operation ids of the v1 console, each once", () => {
    expect(QDRANT_OPS).toEqual([
      "root",
      "get_collections",
      "get_collection",
      "collection_exists",
      "get_collections_aliases",
      "get_collection_aliases",
      "get_points",
      "get_point",
      "scroll_points",
      "count_points",
      "facet",
      "query_points",
      "query_batch_points",
      "query_points_groups",
      "get_optimizations",
      "list_snapshots",
      "collection_cluster_info",
    ]);
  });

  test("hold no health, telemetry, metrics, write or snapshot-download operation", () => {
    for (const op of QDRANT_OPS) {
      expect(op).not.toMatch(
        /health|ready|live|telemetry|metric|logger|issue|debug|profil|audit|upsert|delete|update|create|recover|upload|download/,
      );
    }
  });
});

describe("QdrantError", () => {
  test("carries its category, the server's text, the status and a 429's Retry-After", () => {
    const error = new QdrantError("rate-limited", "Rate limiting exceeded", 429, "10");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(QdrantError);
    expect(error.name).toBe("QdrantError");
    expect(error.category).toBe("rate-limited");
    expect(error.detail).toBe("Rate limiting exceeded");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe("10");
  });

  test("its message names the status and the category, never the server's text", () => {
    const error = new QdrantError("forbidden", "Forbidden: Access to collection docs is required", 403);
    expect(error.message).toBe("Qdrant answered HTTP 403 (forbidden)");
    expect(error.retryAfter).toBeNull();
  });
});

describe("QdrantSend, the slice a consumer is handed (3.13)", () => {
  const answer: QdrantAnswer = { status: 200, contentType: "application/json", retryAfter: null, text: "{}" };

  test("a consumer typed to two operations sends them through the whole client, and the compiler refuses a third", async () => {
    const sent: string[] = [];
    const client: QdrantClient = {
      async send(request) {
        sent.push(request.op);
        return answer;
      },
      close() {},
    };
    const listing: QdrantSend<"get_collections" | "get_collections_aliases"> = client.send.bind(client);
    const signal = new AbortController().signal;
    await listing({ op: "get_collections", params: {}, query: {} }, signal);
    await listing({ op: "get_collections_aliases", params: {}, query: {} }, signal);
    // @ts-expect-error -- the slice cannot send an operation it does not name.
    await listing({ op: "query_points", params: {}, query: {} }, signal);
    expect(sent).toEqual(["get_collections", "get_collections_aliases", "query_points"]);
  });
});
