/**
 * The Qdrant REST client's two no-op writes, the agent read-only proof's probes (`metadata-read.ts`), over a recording
 * transport: each request's full URL, method and body are fixed by the client, never by the caller, and a collection
 * name is held to the same path rule as every console request's.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { QdrantProbe } from "@/lib/db/providers/vector/qdrant/client";
import { buildQdrantConnectionOptions } from "@/lib/db/providers/vector/qdrant/connection-options";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import type { DatabaseConnection } from "@/lib/types";
import { QDRANT_FIXTURE_ROUTES } from "../../../helpers/qdrant-routes";
import { recordingQdrantTransport } from "../../../helpers/qdrant-transport";

const KEY = "not-a-real-key";

const OPTIONS = buildQdrantConnectionOptions(
  {
    id: "c1",
    name: "Qdrant",
    type: "qdrant",
    host: "127.0.0.1",
    port: 6333,
    password: KEY,
    createdAt: new Date(0),
  } as unknown as DatabaseConnection,
  { executionReadOnly: true, queryTimeout: 30_000 },
);

const signal = () => new AbortController().signal;

function client() {
  const wire = recordingQdrantTransport();
  return { wire, qdrant: createRestQdrantClient(OPTIONS, QDRANT_FIXTURE_ROUTES, wire.factory) };
}

describe("the read-only proof's probes", () => {
  test("an empty alias update: POST /collections/aliases with no action, on the connection's one api-key header", async () => {
    const { wire, qdrant } = client();
    await qdrant.probe({ kind: "empty-alias-update" }, signal());
    expect(wire.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "POST", url: "http://127.0.0.1:6333/collections/aliases", body: '{"actions":[]}' },
    ]);
    expect(wire.built).toHaveLength(1);
    expect(wire.built[0].headers).toEqual({ "api-key": KEY });
  });

  test("an empty point delete on one collection: no point, no query key, the name encoded as a console path's", async () => {
    const { wire, qdrant } = client();
    await qdrant.probe({ kind: "empty-point-delete", collection: "plain" }, signal());
    await qdrant.probe({ kind: "empty-point-delete", collection: "a:b c" }, signal());
    expect(wire.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "POST", url: "http://127.0.0.1:6333/collections/plain/points/delete", body: '{"points":[]}' },
      { method: "POST", url: "http://127.0.0.1:6333/collections/a%3Ab%20c/points/delete", body: '{"points":[]}' },
    ]);
  });

  test("a collection name that would leave its segment is refused before the wire", async () => {
    for (const collection of ["", ".", "..", "a/b", "%2e%2e", "a%2fb", "x".repeat(256)]) {
      const { wire, qdrant } = client();
      // oxlint-disable-next-line no-await-in-loop -- each name on a client of its own, refused alone.
      await expect(qdrant.probe({ kind: "empty-point-delete", collection }, signal())).rejects.toBeInstanceOf(
        QueryError,
      );
      expect(wire.calls).toEqual([]);
    }
  });

  test("a probe the client does not know is refused before the wire, as is a caller's extra field", async () => {
    const { wire, qdrant } = client();
    await expect(qdrant.probe({ kind: "drop" } as unknown as QdrantProbe, signal())).rejects.toBeInstanceOf(QueryError);
    await qdrant.probe(
      { kind: "empty-alias-update", body: '{"actions":[{"delete_alias":{}}]}' } as unknown as QdrantProbe,
      signal(),
    );
    expect(wire.requests.map(({ body }) => body)).toEqual(['{"actions":[]}']);
  });

  test("the answer is handed back whatever its status", async () => {
    const wire = recordingQdrantTransport(() => ({
      status: 403,
      contentType: "application/json",
      retryAfter: null,
      text: '{"status":{"error":"Forbidden: Global manage access is required"}}',
    }));
    const qdrant = createRestQdrantClient(OPTIONS, QDRANT_FIXTURE_ROUTES, wire.factory);
    const answer = await qdrant.probe({ kind: "empty-alias-update" }, signal());
    expect(answer.status).toBe(403);
  });
});
