/**
 * The Qdrant labels (vector-family spec 6.7): the generated `statementLanguage`, held word for word to the sentence
 * the design prints, its route list parsed back out and held to the route table and to the v1 route fixture, its
 * example run through the real console parser, its refused classes held to the routes the console refuses, and the
 * panel captions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConsole } from "@/lib/db/console/parser";
import {
  QDRANT_LABELS,
  QDRANT_REFUSED_CLASSES,
  QDRANT_STATEMENT_EXAMPLE,
  qdrantReadRoutes,
  qdrantStatementLanguage,
} from "@/lib/db/providers/vector/qdrant/labels";
import { QDRANT_CONSOLE, QDRANT_ROUTES, refusedRouteSentence } from "@/lib/db/providers/vector/qdrant/routes";

const GOLDEN =
  'A Qdrant request, one per run: optional comment lines starting with // or #, then a line METHOD /path naming one of GET /, GET /collections, GET /collections/{collection_name}, GET /collections/{collection_name}/exists, GET /aliases, GET /collections/{collection_name}/aliases, POST /collections/{collection_name}/points, GET /collections/{collection_name}/points/{id}, POST /collections/{collection_name}/points/scroll, POST /collections/{collection_name}/points/count, POST /collections/{collection_name}/facet, POST /collections/{collection_name}/points/query, POST /collections/{collection_name}/points/query/batch, POST /collections/{collection_name}/points/query/groups, GET /collections/{collection_name}/optimizations, GET /collections/{collection_name}/snapshots and GET /collections/{collection_name}/cluster, with every brace-enclosed segment replaced by a real name or id. GET routes take no body; POST routes take one JSON object with that route\'s Qdrant REST body, for example POST /collections/docs/points/query {"query": [0.1, 0.2], "using": "text", "filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "limit": 5}. Filters are Qdrant must, should and must_not trees. Ids are unsigned integers written as plain numbers, or UUID strings. Not requests: point and payload writes, vector and index changes, collection and alias changes, snapshot create, download, upload and recover, shard, peer and cluster changes, search/matrix, /telemetry and /metrics.';

/** The `METHOD /path` pairs of the sentence's route list, read back out of the sentence. */
function pairsOf(sentence: string): string[] {
  const list = /naming one of (.*), with every brace-enclosed segment/.exec(sentence)?.[1] ?? "";
  return list.split(/, | and (?=(?:GET|POST) )/);
}

interface FixtureRoute {
  readonly method: string;
  readonly path: string;
  readonly op: string;
}
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/vector/routes/qdrant-v1.json"), "utf8"),
) as { readonly routes: readonly FixtureRoute[] };

/** One request line of each refused class, in the clause's order. */
const REFUSED_EXAMPLES: readonly (readonly [string, string, string])[] = [
  ["point and payload writes", "PUT", "/collections/docs/points"],
  ["vector and index changes", "PUT", "/collections/docs/index"],
  ["collection and alias changes", "PUT", "/collections/docs"],
  ["snapshot create, download, upload and recover", "POST", "/collections/docs/snapshots"],
  ["shard, peer and cluster changes", "POST", "/collections/docs/cluster"],
  ["search/matrix", "POST", "/collections/docs/points/search/matrix/pairs"],
  ["/telemetry", "GET", "/telemetry"],
  ["/metrics", "GET", "/metrics"],
];

describe("statementLanguage", () => {
  test("the generated sentence is the design's, word for word", () => {
    expect(QDRANT_LABELS.statementLanguage).toBe(GOLDEN);
  });

  test("the route list read back out equals the table's read routes, in table order", () => {
    expect(pairsOf(GOLDEN)).toEqual([...qdrantReadRoutes(QDRANT_CONSOLE, QDRANT_ROUTES)]);
    expect(pairsOf(GOLDEN)).toHaveLength(17);
  });

  test("the pairs are the 17 operations of the pinned OpenAPI's v1 fixture", () => {
    expect([...pairsOf(GOLDEN)].sort()).toEqual(FIXTURE.routes.map((route) => `${route.method} ${route.path}`).sort());
  });

  test("the example is accepted by the real parser as a query", () => {
    expect(parseConsole(QDRANT_CONSOLE, QDRANT_ROUTES, QDRANT_STATEMENT_EXAMPLE).route.op).toBe("query_points");
  });

  test("GET routes take no body and POST routes take one, as the sentence says", () => {
    for (const route of QDRANT_ROUTES) {
      expect(route.method === "GET" ? route.body === "none" : route.body !== "none").toBe(true);
    }
  });

  test("a route of another class is never listed as a request", () => {
    const write = {
      ...QDRANT_ROUTES[0],
      method: "PUT",
      template: "collections/{collection_name}",
      class: "write" as const,
    };
    const sentence = qdrantStatementLanguage(QDRANT_CONSOLE, [...QDRANT_ROUTES, write], QDRANT_REFUSED_CLASSES);
    expect(pairsOf(sentence)).not.toContain("PUT /collections/{collection_name}");
  });

  test.each(["/healthz", "/readyz", "/livez", "/telemetry", "/metrics"])("%s is never offered as a request", (path) => {
    expect(pairsOf(GOLDEN).some((pair) => pair.endsWith(` ${path}`))).toBe(false);
  });

  test("the refusal clause names the refused classes, in order", () => {
    expect(QDRANT_REFUSED_CLASSES).toEqual(REFUSED_EXAMPLES.map(([label]) => label));
  });

  test.each(REFUSED_EXAMPLES)("%s: %s %s is a route the console refuses by what it is", (_label, method, path) => {
    expect(refusedRouteSentence(method, path)).toContain("which this console does not run");
  });
});

describe("the other labels", () => {
  test("the entity words, the panel captions and the empty states", () => {
    expect(QDRANT_LABELS).toMatchObject({
      entityName: "Collection",
      entityNamePlural: "Collections",
      generateAction: "Generate Command",
      tableStatsCaption:
        'The first 200 collections. Point counts are Qdrant\'s approximate points_count; POST /collections/{collection_name}/points/count with "exact": true is exact.',
    });
    expect(QDRANT_LABELS.slowQueriesEmptyState).toContain(
      "manage-only route that returns other clients' request bodies",
    );
    expect(QDRANT_LABELS.sessionsEmptyState).toContain("Prometheus server that scrapes Qdrant's /metrics");
  });
});
