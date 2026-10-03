/**
 * Qdrant provider, end to end (vector-family spec 6.1, 6.3, 6.8).
 *
 * The real REST client (`rest-client.ts`), the real connect sequence, object surface, Source, monitoring reads,
 * console run and error table all run; only the server is fake. The fake is the recording transport of
 * `tests/helpers/qdrant-transport.ts`, handed to `createRestQdrantClient` through the provider constructor's client
 * factory, so every request the composition makes goes through the client's path building and the shared
 * transport's seam, and is answered from what the seeded server answered. `mock.module()` is not used.
 *
 * The answers were captured from `ghcr.io/qdrant/qdrant/qdrant:v1.19.1`
 * (`sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822`), the `qdrant` service of
 * `database-compose.yml` seeded by docker/qdrant/seed.py: the descriptions, `GET /` and `GET /aliases` by
 * tests/live/vector-evidence.ts into tests/fixtures/vector/qdrant/, and the surface reads by
 * tests/live/qdrant-surface-evidence.ts into tests/fixtures/qdrant-surface/.
 * Live check (tests/live/qdrant-live-check.ts) against ghcr.io/qdrant/qdrant/qdrant:v1.19.1@sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822,
 * 2026-10-03: Bun 1.4.2 19/19 passed, Node v24.14.0 19/19, Node v26.10.0 19/19.
 *
 * What is BUILT rather than captured: the 404 for a collection the seed does not hold, in the shape Qdrant
 * writes it (`collectionNotFound` in tests/helpers/qdrant-surface-fixtures.ts).
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { type QdrantClientFactory, QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { QDRANT_ROUTE_FIXTURE } from "../../helpers/qdrant-routes";
import { recordedLineAnswer, SEEDED_COLLECTIONS, surfaceCapture } from "../../helpers/qdrant-surface-fixtures";
import { recordingQdrantTransport } from "../../helpers/qdrant-transport";

const CONNECTION: DatabaseConnection = {
  id: "qdrant-integration",
  name: "Qdrant",
  type: "qdrant",
  host: "127.0.0.1",
  port: 6333,
  createdAt: new Date(0),
};

function recordedServer(execution: ProviderExecutionContext = {}) {
  const wire = recordingQdrantTransport((request, line) => recordedLineAnswer(line, request.body ?? null));
  const factory: QdrantClientFactory = (options, routes) => createRestQdrantClient(options, routes, wire.factory);
  return { provider: new QdrantProvider(CONNECTION, {}, execution, factory), wire };
}

/** The 17 routes as `METHOD /path` patterns, each parameter matching one encoded segment. */
const ROUTE_PATTERNS = QDRANT_ROUTE_FIXTURE.routes.map(
  (route) => new RegExp(`^${route.method} ${route.path.replace(/\{[a-z_]+\}/g, "[^/?]+")}(\\?.*)?$`),
);

describe("the recorded server", () => {
  test("connect sends GET / and GET /collections through the real client, and nothing else", async () => {
    const { provider, wire } = recordedServer();
    await provider.connect();
    expect(wire.calls.map((call) => call.method)).toEqual(["GET /", "GET /collections"]);
    expect(wire.built).toHaveLength(1);
    expect(wire.built[0].headers).toEqual({});
    await provider.disconnect();
    expect(wire.closed()).toBe(1);
  });

  test("the object surface meets the fleet's contract", async () => {
    const { provider } = recordedServer();
    await provider.connect();
    await assertObjectSurface(provider, {
      containers: [],
      kinds: { collection: SEEDED_COLLECTIONS.length },
      sampleObject: { path: ["docs"], kind: "collection" },
      absentSource: { path: ["no_such_collection"], kind: "collection" },
      noAbstainingKinds: true,
    });
    await provider.disconnect();
  });

  test("docs: describeObject sends the recorded sample request, and its sampled columns are marked", async () => {
    const { provider, wire } = recordedServer();
    await provider.connect();
    wire.calls.length = 0;
    const detail = await provider.describeObject(["docs"], "collection");
    expect(wire.calls).toEqual([
      { method: "GET /collections/docs", args: [null] },
      {
        method: "POST /collections/docs/points/scroll",
        args: [surfaceCapture("sample-docs").$captured.request.body],
      },
    ]);
    expect(detail.columns.filter((column) => column.provenance === "sampled").length).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("docs: the Source is six reads, and its State names the aliases and the sample", async () => {
    const { provider, wire } = recordedServer();
    await provider.connect();
    wire.calls.length = 0;
    const document = await provider.readObjectSource(["docs"], "collection");
    expect(wire.calls.map((call) => call.method)).toEqual([
      "GET /collections/docs",
      "GET /collections/docs/aliases",
      "GET /collections/docs/snapshots",
      "GET /collections/docs/optimizations",
      "GET /collections/docs/cluster",
      "POST /collections/docs/points/scroll",
    ]);
    const state = JSON.parse((document.parts[1] as { text: string }).text);
    expect(state.aliases).toEqual(["docs_alias"]);
    expect(state.payloadSample.method).toBe("slice 0 of 2, uniform by id");
    await provider.disconnect();
  });

  test("a collection the server does not hold reads errors.ts's sentence", async () => {
    const { provider } = recordedServer();
    await provider.connect();
    await expect(provider.describeObject(["no_such_collection"], "collection")).rejects.toThrow(QueryError);
    await expect(provider.describeObject(["no_such_collection"], "collection")).rejects.toThrow(
      "does not exist or is not visible to this credential",
    );
    await provider.disconnect();
  });

  test("the panels: the overview, the Tables and the indexes from GET /, the listing and the descriptions", async () => {
    const { provider, wire } = recordedServer();
    await provider.connect();
    wire.calls.length = 0;
    const overview = await provider.getOverview();
    expect(overview).toMatchObject({ version: "1.19.1", tableCount: 7, indexCount: 29 });
    const tables = await provider.getTableStats();
    expect(tables.find((row) => row.tableName === "payload_spread")?.rowCount).toBe(20000);
    const indexes = await provider.getIndexStats();
    expect(indexes.filter((row) => row.tableName === "docs")).toHaveLength(15);
    const lines = new Set(wire.calls.map((call) => call.method.replace(/\/collections\/[^/]+$/, "/collections/{c}")));
    expect(lines).toEqual(new Set(["GET /", "GET /collections", "GET /collections/{c}"]));
    await provider.disconnect();
  });

  test("a console request runs through execute.ts and the real client", async () => {
    const { provider, wire } = recordedServer();
    await provider.connect();
    wire.calls.length = 0;
    await provider.query("GET /collections");
    expect(wire.calls.map((call) => call.method)).toEqual(["GET /collections"]);
    await provider.disconnect();
  });

  test("read-only from the execution profile: every surface still reads, and only the 17 routes are sent", async () => {
    const { provider, wire } = recordedServer({ readOnly: true });
    await provider.connect();
    await provider.countObjects([]);
    await provider.describeObjects([], "collection");
    await provider.readObjectSource(["plain"], "collection");
    await provider.getOverview();
    await provider.getHealth();
    for (const call of wire.calls) {
      expect(ROUTE_PATTERNS.some((pattern) => pattern.test(call.method))).toBe(true);
      expect(call.method).not.toMatch(/telemetry|metrics|healthz|readyz|livez/);
      expect(call.method).not.toMatch(/snapshots\/[^/]+$/);
    }
    await provider.disconnect();
  });
});
