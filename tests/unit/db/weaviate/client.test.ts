/**
 * The Weaviate client seam (#1566 spec 3.1): the operations, the console's routes first in table order and then the
 * two the provider writes itself, the error an answer is classified into, and the slice of the client a consumer is
 * handed, which can send only the operations it names.
 */
import { describe, expect, test } from "bun:test";
import {
  type WeaviateAnswer,
  type WeaviateClient,
  WeaviateError,
  type WeaviateSend,
  WEAVIATE_OPS,
} from "@/lib/db/providers/vector/weaviate/client";
import { WEAVIATE_CLIENT_ROUTES, WEAVIATE_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";

describe("the operations", () => {
  test("are the console's 17 routes in table order, then ready and graphql", () => {
    expect<readonly string[]>(WEAVIATE_OPS).toEqual([...WEAVIATE_ROUTES.map((route) => route.op), "ready", "graphql"]);
  });

  test("each has one method, path and query key list in the client's table", () => {
    expect(Object.keys(WEAVIATE_CLIENT_ROUTES).sort()).toEqual([...WEAVIATE_OPS].sort());
    expect(WEAVIATE_CLIENT_ROUTES.ready).toEqual({ method: "GET", path: "/v1/.well-known/ready", query: [] });
    expect(WEAVIATE_CLIENT_ROUTES.graphql).toEqual({ method: "POST", path: "/v1/graphql", query: [] });
  });

  test("hold no write", () => {
    for (const op of WEAVIATE_OPS) expect(op).not.toMatch(/batch|delete|update|create|put|patch|backup|user|role/);
  });
});

describe("WeaviateError", () => {
  test("carries the category, the server's words and the status, and names them in its message", () => {
    const error = new WeaviateError("forbidden", "permission denied: read_data", 403);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WeaviateError);
    expect({
      name: error.name,
      message: error.message,
      category: error.category,
      detail: error.detail,
      status: error.status,
      retryAfter: error.retryAfter,
    }).toEqual({
      name: "WeaviateError",
      message: "Weaviate answered HTTP 403 (forbidden)",
      category: "forbidden",
      detail: "permission denied: read_data",
      status: 403,
      retryAfter: null,
    });
  });

  test("a 429 keeps its Retry-After", () => {
    expect(new WeaviateError("rate-limited", "slow down", 429, "5").retryAfter).toBe("5");
  });
});

describe("the slice a consumer is handed", () => {
  test("sends through the client, and the type admits only the operations it names", async () => {
    const sent: string[] = [];
    const answer: WeaviateAnswer = { status: 200, contentType: "application/json", retryAfter: null, text: "{}" };
    const client: WeaviateClient = {
      send: async (request) => {
        sent.push(request.op);
        return answer;
      },
      close: () => {},
    };
    const send: WeaviateSend<"meta" | "schema"> = (request, signal) => client.send(request, signal);
    const signal = new AbortController().signal;
    expect(await send({ op: "meta", params: {}, query: {} }, signal)).toBe(answer);
    // @ts-expect-error a slice typed to meta and schema cannot send a search
    await send({ op: "search_bm25", params: { collection: "Article" }, query: {}, body: "{}" }, signal);
    expect(sent).toEqual(["meta", "search_bm25"]);
  });
});
