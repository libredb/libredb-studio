/**
 * The Qdrant console's dialect and route table (vector-family spec 6.4): the dialect's values, the 17 routes equal
 * route for route to PR 1v's committed fixture, the documentation corpus's tally against the real table, and the
 * sentence each route v1 does not run is refused with.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConsoleRefusal, parseConsole } from "@/lib/db/console/parser";
import {
  QDRANT_BOUNDS,
  QDRANT_CONSOLE,
  QDRANT_ROUTE_PATHS,
  QDRANT_ROUTES,
  QDRANT_RUNS,
  refusedRouteSentence,
} from "@/lib/db/providers/vector/qdrant/routes";
import type { RouteTableJson } from "../../../helpers/console-stand-ins";

const VECTOR = join(import.meta.dir, "..", "..", "..", "fixtures", "vector");
const v1 = JSON.parse(readFileSync(join(VECTOR, "routes", "qdrant-v1.json"), "utf8")) as RouteTableJson;
const full = JSON.parse(readFileSync(join(VECTOR, "routes", "qdrant-full.json"), "utf8")) as RouteTableJson;
const docs = (
  JSON.parse(readFileSync(join(VECTOR, "corpus", "qdrant-docs.json"), "utf8")) as {
    readonly blocks: readonly { readonly file: string; readonly text: string }[];
  }
).blocks;

describe("QDRANT_CONSOLE", () => {
  test("is the dialect of spec 6.4, exactly", () => {
    expect({ ...QDRANT_CONSOLE }).toEqual({
      id: "qdrant",
      methods: ["GET", "POST"],
      pathPrefix: "/",
      shortForm: true,
      commentMarkers: ["//", "#"],
      bodyComments: true,
      maxTextBytes: 1_048_576,
      maxDepth: 32,
      maxNodes: 4_096,
      maxNumericLeaves: 262_144,
      maxScalarLeaves: 32_768,
    });
    expect(Object.isFrozen(QDRANT_CONSOLE)).toBe(true);
  });
});

describe("QDRANT_ROUTES", () => {
  test("equals PR 1v's v1 route fixture route for route: method, path, operation, parameters, query keys and body", () => {
    const table = QDRANT_ROUTES.map((route) => ({
      method: route.method,
      path: `/${route.template}`,
      op: route.op,
      params: route.params,
      query: Object.keys(route.query),
      body: route.body,
    }));
    const fixture: { op: string; body: string }[] = v1.routes.map((route) => ({
      method: route.method,
      path: route.path,
      op: route.op,
      params: route.params,
      // The fixture records what the OpenAPI marks: no body there is `required`. The table reads a non-empty
      // required array as `required` (routes-drift.test.ts holds that rule against the document).
      query: route.query,
      body: route.body,
    }));
    const byOp = (rows: readonly { readonly op: string }[]) => [...rows].sort((a, b) => (a.op < b.op ? -1 : 1));
    const required = new Set(["get_points", "facet", "query_batch_points", "query_points_groups"]);
    for (const route of fixture) if (required.has(route.op)) route.body = "required";
    expect(byOp(table)).toEqual(byOp(fixture));
  });

  test("is 17 routes, every one a read with GET or POST, in the order of spec 6.4", () => {
    expect(QDRANT_ROUTES.map((route) => `${route.method} /${route.template}`)).toEqual([
      "GET /",
      "GET /collections",
      "GET /collections/{collection_name}",
      "GET /collections/{collection_name}/exists",
      "GET /aliases",
      "GET /collections/{collection_name}/aliases",
      "POST /collections/{collection_name}/points",
      "GET /collections/{collection_name}/points/{id}",
      "POST /collections/{collection_name}/points/scroll",
      "POST /collections/{collection_name}/points/count",
      "POST /collections/{collection_name}/facet",
      "POST /collections/{collection_name}/points/query",
      "POST /collections/{collection_name}/points/query/batch",
      "POST /collections/{collection_name}/points/query/groups",
      "GET /collections/{collection_name}/optimizations",
      "GET /collections/{collection_name}/snapshots",
      "GET /collections/{collection_name}/cluster",
    ]);
    for (const route of QDRANT_ROUTES) expect(route.class).toBe("read");
  });

  test("the eight point reads take consistency and timeout, optimizations takes with and completed_limit, and no route takes wait or ordering", () => {
    const keys = Object.fromEntries(QDRANT_ROUTES.map((route) => [route.op, Object.keys(route.query)]));
    expect(keys).toEqual({
      root: [],
      get_collections: [],
      get_collection: [],
      collection_exists: [],
      get_collections_aliases: [],
      get_collection_aliases: [],
      get_points: ["consistency", "timeout"],
      get_point: ["consistency", "timeout"],
      scroll_points: ["consistency", "timeout"],
      count_points: ["consistency", "timeout"],
      facet: ["consistency", "timeout"],
      query_points: ["consistency", "timeout"],
      query_batch_points: ["consistency", "timeout"],
      query_points_groups: ["consistency", "timeout"],
      get_optimizations: ["with", "completed_limit"],
      list_snapshots: [],
      collection_cluster_info: [],
    });
  });

  test("QDRANT_ROUTE_PATHS gives each operation its method and its path with the prefix, and no other", () => {
    expect(Object.keys(QDRANT_ROUTE_PATHS).sort()).toEqual(QDRANT_ROUTES.map((route) => route.op).sort());
    expect(QDRANT_ROUTE_PATHS.root).toEqual({ method: "GET", path: "/" });
    expect(QDRANT_ROUTE_PATHS.query_points).toEqual({
      method: "POST",
      path: "/collections/{collection_name}/points/query",
    });
  });
});

describe("the documentation corpus against the real table", () => {
  test("257 blocks: 82 accepted, 155 refused as routes v1 does not run, 20 refused by the grammar", () => {
    const methods = new Set(full.routes.map((route) => route.method));
    const firstToken = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "" && !QDRANT_CONSOLE.commentMarkers.some((marker) => line.startsWith(marker)))
        ?.split(/\s+/)[0] ?? "";
    const buckets = { accepted: 0, notRun: 0, grammar: 0 };
    for (const block of docs) {
      try {
        parseConsole(QDRANT_CONSOLE, QDRANT_ROUTES, block.text);
        buckets.accepted += 1;
      } catch (error) {
        const { reason } = error as ConsoleRefusal;
        if (reason === "unknown-route" || (reason === "unknown-method" && methods.has(firstToken(block.text)))) {
          buckets.notRun += 1;
        } else buckets.grammar += 1;
      }
    }
    expect(docs).toHaveLength(257);
    expect(buckets).toEqual({ accepted: 82, notRun: 155, grammar: 20 });
  });
});

describe("refusedRouteSentence", () => {
  const v1Ops = new Set<string>(QDRANT_ROUTES.map((route) => route.op));
  const filled = (path: string) =>
    path
      .replace("{collection_name}", "docs")
      .replace("{snapshot_name}", "s.snapshot")
      .replace("{shard_id}", "0")
      .replace("{peer_id}", "7")
      .replace("{field_name}", "city")
      .replace("{vector_name}", "image");

  test("names what each of the 52 OpenAPI operations v1 does not run is, and what the console runs", () => {
    const refused = full.routes.filter((route) => !v1Ops.has(route.op));
    expect(refused).toHaveLength(52);
    for (const route of refused) {
      const sentence = refusedRouteSentence(route.method, filled(route.path));
      expect(sentence, `${route.method} ${route.path}`).toMatch(/ is a .+, which this console does not run\. /);
      expect(sentence.endsWith(QDRANT_RUNS)).toBe(true);
    }
  });

  test("names each class by its route", () => {
    const sentence = (method: string, path: string) =>
      refusedRouteSentence(method, path).replace(` ${QDRANT_RUNS}`, "");
    expect(sentence("PUT", "/collections/docs/points")).toBe(
      "PUT /collections/docs/points is a point or payload write, which this console does not run.",
    );
    expect(sentence("POST", "/collections/docs/points/delete")).toBe(
      "POST /collections/docs/points/delete is a point or payload write, which this console does not run.",
    );
    expect(sentence("DELETE", "/collections/docs")).toBe(
      "DELETE /collections/docs is a collection or alias change, which this console does not run.",
    );
    expect(sentence("POST", "collections/aliases")).toBe(
      "POST /collections/aliases is a collection or alias change, which this console does not run.",
    );
    expect(sentence("PUT", "/collections/docs/snapshots/recover")).toBe(
      "PUT /collections/docs/snapshots/recover is a snapshot create, delete, download, upload or recover route, which this console does not run.",
    );
    expect(sentence("GET", "/telemetry?details_level=3")).toBe(
      "GET /telemetry is a service route (telemetry, metrics, issues, quotas, health or diagnostics), which this console does not run.",
    );
    expect(sentence("GET", "/healthz")).toBe(
      "GET /healthz is a service route (telemetry, metrics, issues, quotas, health or diagnostics), which this console does not run.",
    );
    expect(sentence("POST", "/collections/docs/points/search/matrix/pairs")).toBe(
      "POST /collections/docs/points/search/matrix/pairs is a distance matrix route, which this console does not run.",
    );
    expect(sentence("POST", "/collections/docs/points/search")).toBe(
      "POST /collections/docs/points/search is a legacy search, recommend or discover route, which POST /collections/{collection_name}/points/query replaces, which this console does not run.",
    );
    expect(sentence("PUT", "/collections/docs/index")).toBe(
      "PUT /collections/docs/index is a vector or index change, which this console does not run.",
    );
    expect(sentence("GET", "/collections/docs/memory")).toBe(
      "GET /collections/docs/memory is a service route (telemetry, metrics, issues, quotas, health or diagnostics), which this console does not run.",
    );
    expect(sentence("POST", "/collections/docs/shards/0/points")).toBe(
      "POST /collections/docs/shards/0/points is a shard, peer or cluster route, which this console does not run.",
    );
  });

  test("a route no class names is refused by the method set or as no route the console runs", () => {
    expect(refusedRouteSentence("HEAD", "/collections")).toBe(
      `HEAD /collections is not a request this console runs: it sends GET and POST only. ${QDRANT_RUNS}`,
    );
    expect(refusedRouteSentence("GET", "/nowhere")).toBe(
      `GET /nowhere is not a route this console runs. ${QDRANT_RUNS}`,
    );
  });

  test("the served routes outside the OpenAPI that v1 refuses are each named", () => {
    for (const [method, path] of [
      ["POST", "/collections/docs/points/recommend"],
      ["POST", "/collections/docs/points/discover/batch"],
      ["POST", "/collections/docs/points/search/groups"],
      ["GET", "/debugger"],
      ["GET", "/logger"],
      ["GET", "/stacktrace"],
      ["GET", "/profiler/slow_requests"],
      ["POST", "/audit/logs"],
      ["GET", "/cluster/metadata/keys"],
      ["POST", "/collections/docs/debug"],
      ["POST", "/collections/docs/truncate_unapplied_wal"],
    ]) {
      expect(refusedRouteSentence(method, path), `${method} ${path}`).toMatch(/, which this console does not run\. /);
    }
  });
});

describe("QDRANT_BOUNDS", () => {
  test("holds the values of spec 6.6", () => {
    expect(QDRANT_BOUNDS).toMatchObject({
      defaultLimit: 10,
      defaultGroupSize: 3,
      maxRows: 1_000,
      maxBatchSearches: 10,
      maxPrefetchDepth: 2,
      maxPrefetchPerList: 4,
      maxPrefetchNodes: 10,
      maxCandidates: 10_000,
      maxHnswEf: 1_024,
      maxOversampling: 8,
      maxMmrCandidates: 1_024,
      maxFacetLimit: 1_000,
      maxFilterBytes: 65_536,
      maxFilterConditions: 256,
      maxNestedLevels: 4,
      maxFilterListEntries: 10_000,
      maxFormulaDepth: 12,
      maxFormulaNodes: 128,
      maxDenseSize: 65_536,
      maxMultivectorElements: 1_048_575,
      transportCapBytes: 16_777_216,
      resultBudgetBytes: 8_388_608,
      stringCellUnits: 65_536,
      payloadSamplePoints: 1_000,
      metadataDeadlineMs: 10_000,
      pointReadDeadlineMs: 30_000,
      perProvider: 4,
      perEngine: 16,
      queueDepth: 64,
      describeConcurrency: 4,
      tablesPanelCollections: 200,
    });
  });
});
