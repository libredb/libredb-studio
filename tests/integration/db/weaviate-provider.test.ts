/**
 * The Weaviate provider over what live servers answered (#1566 spec 7.3). Each capture under
 * tests/fixtures/weaviate/ is one scenario of tests/live/weaviate-scenarios.ts, written by
 * tests/live/weaviate-evidence.ts against the servers of docker/weaviate/README.md: every request the provider sent,
 * the answer it got, and what each call returned or threw.
 *
 * Here the same provider is built over a transport that answers from the capture (tests/helpers/weaviate-scenario.ts)
 * and makes the same calls. Three things are held: every request it sends is one the capture holds, every request
 * the capture holds is sent, and every outcome is the one recorded. So a module change that alters a request, a
 * path decision, a column, a sentence or a refusal fails here by scenario and step, with no socket and no
 * `mock.module()`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPLAY_SECRETS,
  replayTransport,
  runScenario,
  scenarioConnection,
  scenarioProvider,
  type WeaviateExchange,
  type WeaviateOutcome,
} from "../../helpers/weaviate-scenario";
import { scenarioFile, WEAVIATE_SCENARIOS, WEAVIATE_SERVICES } from "../../live/weaviate-scenarios";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "weaviate");

interface Capture {
  readonly $captured: { readonly service: string; readonly scenario: string; readonly version: string };
  readonly transport: readonly { readonly origin: string; readonly headers: Record<string, string> }[];
  readonly exchanges: readonly WeaviateExchange[];
  readonly outcomes: readonly WeaviateOutcome[];
}

function captureOf(file: string): Capture {
  return JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Capture;
}

describe("the Weaviate provider over the captures", () => {
  for (const scenario of WEAVIATE_SCENARIOS) {
    const file = scenarioFile(scenario);
    test(`${file}: the same requests and the same outcomes`, async () => {
      const capture = captureOf(file);
      expect(capture.$captured.service).toBe(scenario.service);
      expect(capture.$captured.scenario).toBe(scenario.name);
      expect(capture.$captured.version).toBe(WEAVIATE_SERVICES[scenario.service].version);
      const replay = replayTransport(capture.exchanges);
      const provider = scenarioProvider(scenarioConnection(scenario, REPLAY_SECRETS), replay.factory);
      const outcomes = await runScenario(provider, scenario.steps);
      expect(outcomes).toEqual(JSON.parse(JSON.stringify(capture.outcomes)));
      expect(replay.unused()).toEqual([]);
      // One transport per connect, built with the recorded origin and header names.
      expect(
        replay.built.map((options) => `${options.origin.scheme}://${options.origin.host}:${options.origin.port}`),
      ).toEqual(capture.transport.map((entry) => entry.origin));
      expect(replay.built.map((options) => Object.keys(options.headers).sort())).toEqual(
        capture.transport.map((entry) => Object.keys(entry.headers).sort()),
      );
    });
  }
});

describe("what the captures show", () => {
  const outcome = (file: string, step: string): WeaviateOutcome => {
    const found = captureOf(file).outcomes.find((entry) => entry.step === step);
    if (found === undefined) throw new Error(`${file} has no step ${step}`);
    return found;
  };
  const lines = (file: string): string[] =>
    captureOf(file).exchanges.map((exchange) => `${exchange.method} ${exchange.path}`);

  test("a search runs over REST on 1.40 and over GraphQL on 1.38 and 1.37", () => {
    expect(lines("weaviate/searches.json")).toContain("POST /v1/search/Article/bm25");
    expect(lines("weaviate/searches.json")).not.toContain("POST /v1/graphql");
    for (const file of ["weaviate-1-38/searches.json", "weaviate-1-37/searches.json"]) {
      expect(lines(file)).toContain("POST /v1/graphql");
      expect(lines(file).some((line) => line.startsWith("POST /v1/search/"))).toBe(false);
    }
  });

  test("a value list filter answers the same rows over GraphQL as over REST", () => {
    const step =
      'query POST /v1/search/Article/bm25 {"query": "vector", "where": {"path": ["tags"], "operator": "ContainsAny", "valueTextArray": ["graph", "shard"]}, "limit": 50, "returnProperties": ["title"]}';
    const ids = (file: string) =>
      ((outcome(file, step) as { value: { rows: { $id: string }[] } }).value.rows.map((row) => row.$id) ?? []).sort();
    expect(ids("weaviate-1-37/searches.json")).toEqual(ids("weaviate/searches.json"));
    expect(ids("weaviate-1-38/searches.json")).toEqual(ids("weaviate/searches.json"));
    expect(ids("weaviate/searches.json")).toHaveLength(50);
  });

  test("a WithinGeoRange aggregate on 1.37 carries the server's 0 with a note; 1.38 and 1.40 count the objects", () => {
    const step =
      'query POST /v1/aggregate/Article {"where": {"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": 41, "longitude": 29}, "distance": {"max": 3000000}}}}';
    const value = (file: string) =>
      (outcome(file, step) as { value: { rows: { count: number }[]; warnings: { message: string }[] } }).value;
    expect(value("weaviate-1-37/searches.json").rows[0]?.count).toBe(0);
    expect(value("weaviate-1-37/searches.json").warnings.map((w) => w.message)).toContain(
      "Weaviate 1.37.4 counts an aggregate filtered by WithinGeoRange as 0 even where objects match (measured on 1.37.4); read the objects with a search, or count on 1.38 or later.",
    );
    for (const file of ["weaviate/searches.json", "weaviate-1-38/searches.json"]) {
      expect(value(file).rows[0]?.count).toBe(500);
      expect(value(file).warnings.some((w) => w.message.includes("WithinGeoRange"))).toBe(false);
    }
  });

  test("a BM25 score is a number over GraphQL as it is over REST", () => {
    const step =
      'query POST /v1/search/Article/bm25 {"query": "vector", "limit": 3, "returnProperties": ["title", "wordCount"], "returnMetadata": ["score"]}';
    for (const file of ["weaviate/searches.json", "weaviate-1-37/searches.json"]) {
      const found = outcome(file, step) as { value: { rows: { $score: unknown }[] } };
      expect(found.value.rows.every((row) => typeof row.$score === "number")).toBe(true);
    }
  });

  test("with GraphQL disabled on 1.40 every search still runs, over REST", () => {
    expect(lines("weaviate-nographql/searches.json")).not.toContain("POST /v1/graphql");
    expect(
      "value" in
        outcome("weaviate-nographql/searches.json", 'query POST /v1/aggregate/Article {"groupBy": "category"}'),
    ).toBe(true);
  });

  test("a COLD tenant is refused after one read of its own record, and no data read names it", () => {
    for (const file of ["weaviate/reads.json", "weaviate-1-37/reads.json"]) {
      const named = lines(file).filter((line) => line.includes("initech") || line.includes("umbrella"));
      expect(named.every((line) => line.startsWith("GET /v1/schema/"))).toBe(true);
      expect(named.some((line) => line.includes("/shards"))).toBe(false);
    }
  });

  test("a refused request sends nothing past the connect read; an unknown tenant is looked up, never read", () => {
    expect(lines("weaviate/refusals.json").filter((line) => line !== "GET /v1/meta")).toEqual([
      "GET /v1/schema/TenantNotes",
      "GET /v1/schema/TenantNotes/tenants/nobody",
    ]);
  });

  test("the key travels as a bearer header and is never recorded", () => {
    const reader = captureOf("weaviate-auth/reader.json");
    expect(reader.transport.every((entry) => entry.headers.authorization === "Bearer <key>")).toBe(true);
    expect(captureOf("weaviate/surface.json").transport.every((entry) => !("authorization" in entry.headers))).toBe(
      true,
    );
    expect(outcome("weaviate-auth/no-key.json", "connect")).toMatchObject({ error: { name: "AuthenticationError" } });
    expect(outcome("weaviate-auth/wrong-key.json", "connect")).toMatchObject({
      error: { name: "AuthenticationError" },
    });
  });

  test("plain HTTP to the TLS port asks for an SSL mode", () => {
    expect(outcome("weaviate-tls/plain-to-tls.json", "connect")).toMatchObject({
      error: { name: "ConnectionError", message: expect.stringContaining("choose an SSL mode") },
    });
  });
});
