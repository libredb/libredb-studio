/**
 * The Qdrant captures (vector-family spec 7.3), read through tests/helpers/qdrant-fixtures.ts: the directory is the
 * catalog, no capture holds a credential, and the client, the version gates and the error table are each held to
 * what Qdrant 1.19.1 answered; and the committed extract of the pinned OpenAPI document, held to its sha256, to the
 * seam's 17 operations and to the route table PR 1v derived from the same document (QE10, QE21).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AuthenticationError, QueryError, TimeoutError } from "@/lib/db/errors";
import { QDRANT_OPS, type QdrantOp } from "@/lib/db/providers/vector/qdrant/client";
import { buildQdrantConnectionOptions } from "@/lib/db/providers/vector/qdrant/connection-options";
import {
  answerFailure,
  type QdrantErrorContext,
  retryAfterSeconds,
  toProviderError,
} from "@/lib/db/providers/vector/qdrant/errors";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import {
  QDRANT_TESTED_VERSION,
  QDRANT_VERSION_GATES,
  type QdrantVersionGate,
  readQdrantVersion,
  versionGateRefusal,
} from "@/lib/db/providers/vector/qdrant/versions";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { DatabaseConnection } from "@/lib/types";
import { expectCalls } from "../../../helpers/call-log";
import {
  capturedAnswer,
  QDRANT_CAPTURE_SPECS,
  QDRANT_FIXTURE_NAMES,
  QDRANT_FIXTURES_DIR,
  qdrantCapture,
  qdrantOpenApiExtractFixture,
  replayQdrantRoutes,
} from "../../../helpers/qdrant-fixtures";
import { QDRANT_FIXTURE_ROUTES, QDRANT_ROUTE_FIXTURE } from "../../../helpers/qdrant-routes";
import { recordingQdrantTransport } from "../../../helpers/qdrant-transport";
import {
  QDRANT_OPENAPI_SHA256,
  QDRANT_OPENAPI_SOURCE,
  QDRANT_V1_OPERATION_IDS,
} from "../../../live/qdrant-openapi-extract";

const IMAGE = "ghcr.io/qdrant/qdrant/qdrant:v1.19.1";
const DIGEST = "sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822";
const NOW = new Date("2026-10-03T12:00:00Z");

const OPTIONS = buildQdrantConnectionOptions(
  {
    id: "c1",
    name: "Qdrant",
    type: "qdrant",
    host: "127.0.0.1",
    port: 6333,
    createdAt: new Date(0),
  } as unknown as DatabaseConnection,
  { executionReadOnly: false, queryTimeout: 30_000 },
);

const context = (op: QdrantOp, phase: "connect" | "request" = "request"): QdrantErrorContext => ({
  phase,
  op,
  endpoint: OPTIONS.endpoint,
  responseCapBytes: OPTIONS.responseCapBytes,
  timeoutMs: OPTIONS.callTimeoutMs,
  secretForms: [],
  now: () => NOW,
});

function filesOnDisk(): string[] {
  return readdirSync(QDRANT_FIXTURES_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(QDRANT_FIXTURES_DIR, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

const failureOf = (name: string) => answerFailure(capturedAnswer(qdrantCapture(name)));
const resultOf = (name: string) =>
  (JSON.parse(quoteUnsafeIntegers(capturedAnswer(qdrantCapture(name)).text)) as { result: unknown }).result;

describe("the captures on disk (7.3)", () => {
  test("the directory holds exactly the catalog, the OpenAPI extract and the README", () => {
    expect(filesOnDisk()).toEqual(
      [...QDRANT_FIXTURE_NAMES.map((name) => `${name}.json`), "README.md", "openapi-extract.json"].sort(),
    );
    expect(QDRANT_FIXTURE_NAMES).toHaveLength(235);
  });

  test("the README states the catalog's count and how to run the harness", () => {
    const readme = readFileSync(path.join(QDRANT_FIXTURES_DIR, "README.md"), "utf8");
    expect(readme).toContain(`lists the ${QDRANT_FIXTURE_NAMES.length} captures it writes`);
    expect(readme).toContain('bun tests/live/qdrant-evidence.ts --keys "$dir/keys" --report "$dir/report.json"');
    expect(readme).toContain("eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a");
  });

  test("every capture records the pinned image, its digest, Qdrant 1.19.1, its date, its runtime and its request", () => {
    for (const name of QDRANT_FIXTURE_NAMES) {
      const { $captured, outcome, payload } = qdrantCapture(name);
      expect({ name, image: $captured.image, digest: $captured.digest, version: $captured.version }).toEqual({
        name,
        image: IMAGE,
        digest: DIGEST,
        version: QDRANT_TESTED_VERSION,
      });
      expect($captured.service).toBe(name.split("/")[0] as typeof $captured.service);
      expect($captured.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect($captured.runtime).toMatch(/^(?:bun|node) \d/);
      expect($captured.attempts).toBeGreaterThanOrEqual(1);
      expect([...QDRANT_OPS, null] as (string | null)[]).toContain($captured.op);
      expect(["GET", "POST"]).toContain($captured.request.method);
      expect(outcome).toBe("status" in payload && payload.status >= 200 && payload.status <= 299 ? "pass" : "fail");
    }
  });

  test("no capture holds a key, a JWT or a PEM block: the credential header is a placeholder", () => {
    for (const file of filesOnDisk().filter((name) => name.endsWith(".json") && name !== "openapi-extract.json")) {
      const text = readFileSync(path.join(QDRANT_FIXTURES_DIR, file), "utf8");
      const capture = JSON.parse(text) as ReturnType<typeof qdrantCapture>;
      const headers = capture.$captured.request.headers;
      expect([{}, { "api-key": "<api-key>" }, { "api-key": "<token>" }]).toContainEqual(headers);
      expect(headers).toEqual(
        capture.$captured.credential === "none"
          ? {}
          : { "api-key": capture.$captured.credential.startsWith("jwt-") ? "<token>" : "<api-key>" },
      );
      // Each generated key is 64 hexadecimal characters; the only such run a capture may hold is the image digest.
      const withoutDigest = text.split(DIGEST).join("");
      expect({ file, key: /\b[0-9a-f]{64}\b/.test(withoutDigest) }).toEqual({ file, key: false });
      expect({ file, jwt: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(text) }).toEqual({ file, jwt: false });
      expect({ file, pem: text.includes("-----BEGIN") }).toEqual({ file, pem: false });
    }
  });
});

describe("the client builds exactly the requests the server answered (6.1, QE10)", () => {
  const templates = QDRANT_ROUTE_FIXTURE.routes.map((route) => ({
    op: route.op as QdrantOp,
    method: route.method,
    names: [...route.path.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]),
    pattern: new RegExp(`^${route.path.replace(/\{[a-z_]+\}/g, "([^/]+)")}$`),
  }));

  test.each(
    QDRANT_CAPTURE_SPECS.filter((spec) => spec.group === "routes").map((spec) => `${spec.service}/${spec.name}`),
  )("%s", async (name) => {
    const { $captured } = qdrantCapture(name);
    const template = templates.find((entry) => entry.op === $captured.op);
    const matched = template?.pattern.exec($captured.request.path);
    if (template === undefined || matched === null || matched === undefined) throw new Error(`${name} is on no route`);
    const params = Object.fromEntries(
      template.names.map((key, index) => [key, decodeURIComponent(matched[index + 1])]),
    );
    const wire = recordingQdrantTransport(replayQdrantRoutes());
    const client = createRestQdrantClient(OPTIONS, QDRANT_FIXTURE_ROUTES, wire.factory);
    const answer = await client.send(
      {
        op: template.op,
        params,
        query: {},
        ...($captured.request.body === null ? {} : { body: $captured.request.body }),
      },
      new AbortController().signal,
    );
    expectCalls(wire, [
      { method: `${$captured.request.method} ${$captured.request.path}`, args: [$captured.request.body] },
    ]);
    expect(answer).toEqual(capturedAnswer(qdrantCapture(name)));
  });

  test("the 17 routes were asked of every seeded collection: 3 without a collection and 14 on each of 7", () => {
    const routes = QDRANT_CAPTURE_SPECS.filter((spec) => spec.group === "routes");
    expect(routes).toHaveLength(3 + 14 * 7);
    expect([...new Set(routes.map((spec) => spec.op))].sort()).toEqual([...QDRANT_OPS].sort());
  });

  test("a request line no capture holds is refused by name", () => {
    expect(() => replayQdrantRoutes()({} as never, "GET /telemetry")).toThrow("no capture answers GET /telemetry");
  });
});

describe("ids and integers above 2^53 arrive with their exact digits (QE14)", () => {
  test("the scroll of docs prints 2^53 + 1 bare, and the lossless parse keeps its digits", () => {
    const text = capturedAnswer(qdrantCapture("qdrant/scroll-points-docs")).text;
    expect(text).toContain('"id":9007199254740993');
    const points = (resultOf("qdrant/scroll-points-docs") as { points: { id: unknown }[] }).points;
    expect(points.map((point) => point.id)).toEqual([0, 42, "9007199254740993"]);
    expect((JSON.parse(text) as { result: { points: { id: number }[] } }).result.points[2].id).toBe(
      9_007_199_254_740_992,
    );
  });

  test("the retrieve of docs asked for those ids as bare numbers, and the server answered all three", () => {
    const capture = qdrantCapture("qdrant/get-points-docs");
    expect(capture.$captured.request.body).toBe(
      '{"ids":[0,42,9007199254740993],"with_payload":true,"with_vector":true}',
    );
    expect((resultOf("qdrant/get-points-docs") as { id: unknown }[]).map((point) => point.id)).toEqual([
      0,
      42,
      "9007199254740993",
    ]);
  });

  test("the same id written as a string is refused by the server", () => {
    expect(failureOf("qdrant/error-id-as-string")?.detail).toContain(
      "value 9007199254740993 is not a valid point ID, valid values are either an unsigned integer or a UUID",
    );
  });
});

describe("GET / reports the tested version on every service, with or without a key (6.9, QE30)", () => {
  test.each([
    "qdrant/root",
    "qdrant-auth/none-root",
    "qdrant-auth/wrong-key-root",
    "qdrant-auth/jwt-expired-root",
    "qdrant-tls/tls-root-by-name",
    "qdrant-tls/tls-root-by-address",
    "qdrant-mtls/mtls-root-with-client-certificate",
  ])("%s", (name) => {
    const version = readQdrantVersion(capturedAnswer(qdrantCapture(name)).text);
    expect(version).toEqual({ reported: "1.19.1", release: [1, 19, 1] });
    for (const gate of Object.keys(QDRANT_VERSION_GATES) as QdrantVersionGate[]) {
      expect(versionGateRefusal(gate, version)).toBeUndefined();
    }
  });
});

describe("every answer classifies as 6.10 says (QE20)", () => {
  const CATEGORY: Readonly<Record<string, string>> = {
    "qdrant-auth/none-get-collections": "unauthenticated",
    "qdrant-auth/wrong-key-get-collections": "unauthenticated",
    "qdrant-tls/tls-wrong-key-get-collections": "unauthenticated",
    "qdrant-tls/tls-none-get-collections": "unauthenticated",
    "qdrant-auth/jwt-expired-get-collections": "jwt-expired",
    "qdrant-auth/jwt-expired-count-points-docs": "jwt-expired",
    "qdrant-auth/jwt-bad-signature-get-collections": "jwt-signature",
    "qdrant-auth/jwt-scoped-get-collection-plain": "forbidden",
    "qdrant-auth/jwt-empty-access-get-collection-docs": "forbidden",
    "qdrant-auth/alias-matrix-jwt-collection-only-get-collection-docs_alias": "forbidden",
    "qdrant-auth/alias-matrix-jwt-alias-only-get-collection-docs": "forbidden",
    "qdrant/error-collection-not-found": "collection-not-found",
    "qdrant/error-point-not-found": "not-found",
    "qdrant/get-point-scratch": "not-found",
    "qdrant/error-format": "input",
    "qdrant/error-validation": "input",
    "qdrant/error-wrong-input": "input",
    "qdrant/error-id-as-string": "input",
    "qdrant/error-post-without-body": "input",
    "qdrant/facet-plain": "input",
    "qdrant/filter-misspelled-clause": "input",
    "qdrant/timeout-zero": "input",
    "qdrant/strict-limit-exceeded": "strict-mode",
    "qdrant/strict-index-required": "strict-mode",
    "qdrant/strict-exact-disabled": "strict-mode",
    "qdrant/strict-rate-limited": "rate-limited",
    "qdrant/timeout-scroll": "timeout",
    "qdrant/timeout-count": "timeout",
    "qdrant/timeout-query": "timeout",
    "qdrant/timeout-groups-500": "timeout",
    "qdrant/timeout-groups-408": "timeout",
  };

  test.each(Object.entries(CATEGORY))("%s is %s", (name, category) => {
    expect(failureOf(name)?.category).toBe(category as never);
  });

  test("every capture with an HTTP answer is a success or a category the table reads", () => {
    for (const name of QDRANT_FIXTURE_NAMES) {
      const capture = qdrantCapture(name);
      if ("error" in capture.payload) continue;
      const failure = answerFailure(capturedAnswer(capture));
      expect({ name, passed: failure === undefined }).toEqual({ name, passed: capture.outcome === "pass" });
      expect(["server", "unavailable", "unexpected-status"]).not.toContain(failure?.category ?? "none");
    }
  });

  test("the captures that hold no HTTP answer are the three refused connections", () => {
    expect(QDRANT_FIXTURE_NAMES.filter((name) => "error" in qdrantCapture(name).payload)).toEqual([
      "qdrant-mtls/mtls-no-client-certificate",
      "qdrant-tls/tls-no-ca",
      "qdrant-tls/tls-plain-http-to-tls-port",
    ]);
    expect(() => capturedAnswer(qdrantCapture("qdrant-tls/tls-no-ca"))).toThrow("holds no HTTP answer");
  });

  test("the sentences a person reads for the measured refusals", () => {
    const worded = (name: string, op: QdrantOp, phase: "connect" | "request" = "request") =>
      toProviderError(failureOf(name), context(op, phase));
    const refused = worded("qdrant-auth/wrong-key-get-collections", "get_collections", "connect");
    expect(refused).toBeInstanceOf(AuthenticationError);
    expect(refused.message).toBe("Qdrant refused the API key or JWT. (Qdrant: Invalid API key or JWT)");
    expect(worded("qdrant-auth/none-get-collections", "get_collections", "connect").message).toBe(
      "Qdrant refused the API key or JWT. (Qdrant: Must provide an API key or an Authorization bearer token)",
    );
    expect(worded("qdrant-auth/jwt-expired-get-collections", "get_collections", "connect").message).toBe(
      "The JWT has expired.",
    );
    expect(worded("qdrant-auth/jwt-bad-signature-get-collections", "get_collections", "connect").message).toBe(
      "The JWT's signature does not match this server's key.",
    );
    expect(worded("qdrant-auth/jwt-scoped-get-collection-plain", "get_collection").message).toBe(
      "The credential is not allowed to run this request. (Qdrant: Forbidden: Access to collection plain is required)",
    );
    expect(worded("qdrant/error-collection-not-found", "get_collection").message).toBe(
      "The collection does not exist or is not visible to this credential.",
    );
    expect(worded("qdrant/strict-exact-disabled", "count_points").message).toBe(
      'This collection\'s strict mode refused the request. Send "exact": false. (Qdrant: Bad request: Exact search disabled!. Help: Set exact=false.)',
    );
    const count = worded("qdrant/timeout-count", "count_points");
    expect(count).toBeInstanceOf(TimeoutError);
    expect(count.message).toContain('send "exact": false for an approximate count.');
    for (const name of [
      "qdrant/timeout-scroll",
      "qdrant/timeout-query",
      "qdrant/timeout-groups-500",
      "qdrant/timeout-groups-408",
    ]) {
      const error = worded(name, "scroll_points");
      expect(error).toBeInstanceOf(TimeoutError);
      // The server's elapsed figure need not equal the limit that was sent, so it never reaches the sentence.
      expect(error.message).toBe("Qdrant stopped the request at its time limit.");
    }
  });

  test("the rate limit names the wait the server's Retry-After header gave", () => {
    const capture = qdrantCapture("qdrant/strict-rate-limited");
    const header = capturedAnswer(capture).retryAfter;
    expect(header).toMatch(/^\d{1,9}$/);
    const error = toProviderError(failureOf("qdrant/strict-rate-limited"), context("count_points"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toStartWith(
      `Qdrant rate-limited the request; try again in ${retryAfterSeconds(header, NOW)} s. It was not sent again.`,
    );
  });

  test("query/groups times out in both measured shapes, a 408 and a 500", () => {
    expect(capturedAnswer(qdrantCapture("qdrant/timeout-groups-408")).status).toBe(408);
    expect(failureOf("qdrant/timeout-groups-408")?.detail).toStartWith("Timeout: Timeout error: Operation 'GroupBy'");
    expect(capturedAnswer(qdrantCapture("qdrant/timeout-groups-500")).status).toBe(500);
    expect(failureOf("qdrant/timeout-groups-500")?.detail).toContain("Timeout error: Operation 'Search'");
  });
});

describe("what a credential sees (6.2, QE27, R44 QM3)", () => {
  const collections = (name: string) =>
    (resultOf(name) as { collections: { name: string }[] }).collections.map((collection) => collection.name);
  const aliases = (name: string) =>
    (resultOf(name) as { aliases: { alias_name: string }[] }).aliases.map((alias) => alias.alias_name);

  test("/ answers every credential, and /collections filters instead of refusing", () => {
    for (const credential of ["none", "wrong-key", "jwt-expired", "jwt-bad-signature"]) {
      expect(capturedAnswer(qdrantCapture(`qdrant-auth/${credential}-root`)).status).toBe(200);
    }
    expect(collections("qdrant-auth/admin-key-get-collections")).toHaveLength(7);
    expect(collections("qdrant-auth/read-only-key-get-collections")).toHaveLength(7);
    expect(collections("qdrant-auth/jwt-no-access-claim-get-collections")).toHaveLength(7);
    expect(collections("qdrant-auth/jwt-scoped-get-collections")).toEqual(["docs", "scratch"]);
    expect(collections("qdrant-auth/jwt-empty-access-get-collections")).toEqual([]);
  });

  test("an alias-only token lists nothing, yet reads through the alias", () => {
    expect(collections("qdrant-auth/alias-matrix-jwt-alias-only-get-collections")).toEqual([]);
    expect(aliases("qdrant-auth/alias-matrix-jwt-alias-only-get-collections-aliases")).toEqual([]);
    expect(qdrantCapture("qdrant-auth/alias-matrix-jwt-alias-only-scroll-points-docs_alias").outcome).toBe("pass");
    expect(qdrantCapture("qdrant-auth/alias-matrix-jwt-alias-only-scroll-points-docs").outcome).toBe("fail");
  });

  test("a collection-only token is refused the alias, and /aliases shows an alias only to a token granted both", () => {
    expect(qdrantCapture("qdrant-auth/alias-matrix-jwt-collection-only-get-collection-docs_alias").outcome).toBe(
      "fail",
    );
    expect(aliases("qdrant-auth/alias-matrix-jwt-collection-only-get-collections-aliases")).toEqual([]);
    expect(aliases("qdrant-auth/alias-matrix-jwt-alias-and-collection-get-collections-aliases")).toEqual([
      "docs_alias",
    ]);
  });
});

describe("the server's own answer to a misspelled filter key (QM12)", () => {
  const count = (name: string) => (resultOf(name) as { count: number }).count;

  test("a misspelled clause is refused by name, because Filter is closed", () => {
    expect(failureOf("qdrant/filter-misspelled-clause")?.detail).toContain("unknown field `must_nto`");
  });

  test("a misspelled key beside a valid condition is dropped in silence", () => {
    expect(count("qdrant/filter-control")).toBe(1);
    expect(count("qdrant/filter-range-control")).not.toBe(1);
    expect(count("qdrant/filter-misspelled-condition-key")).toBe(1);
    expect(count("qdrant/filter-misspelled-excluding-key")).toBe(1);
  });

  test("a misspelled top-level key is dropped in silence, and the count is unfiltered", () => {
    expect(count("qdrant/filter-misspelled-top-level-key")).toBe(300);
  });
});

describe("the committed extract", () => {
  const extract = qdrantOpenApiExtractFixture();
  const schemas = extract.schemas as Record<
    string,
    { additionalProperties?: unknown; anyOf?: { $ref?: string }[]; properties?: Record<string, unknown> }
  >;

  test("is derived from the document pinned by its sha256, the one the route table is derived from", () => {
    expect(extract.$generated).toEqual({
      by: "tests/live/qdrant-evidence.ts",
      source: QDRANT_OPENAPI_SOURCE,
      sha256: QDRANT_OPENAPI_SHA256,
    });
    expect(QDRANT_ROUTE_FIXTURE.$generated.sha256).toBe(QDRANT_OPENAPI_SHA256);
  });

  test("declares exactly the seam's 17 operations, in the seam's order", () => {
    expect(extract.operations.map((operation) => operation.op)).toEqual([...QDRANT_OPS]);
    expect([...QDRANT_V1_OPERATION_IDS]).toEqual([...QDRANT_OPS]);
  });

  test("agrees with the route table on every method, path, path parameter and query key", () => {
    for (const operation of extract.operations) {
      const route = QDRANT_ROUTE_FIXTURE.routes.find((entry) => entry.op === operation.op);
      if (route === undefined) throw new Error(`the route table has no ${operation.op}`);
      expect({
        op: operation.op,
        method: operation.method,
        path: operation.path,
        params: [...operation.pathParameters].sort(),
        query: operation.queryParameters,
      }).toEqual({
        op: operation.op,
        method: route.method,
        path: route.path,
        params: Object.keys(route.params).sort(),
        query: route.query,
      });
    }
  });

  test("only GET and POST, and the eight routes that declare timeout are the eight that read points", () => {
    expect([...new Set(extract.operations.map((operation) => operation.method))].sort()).toEqual(["GET", "POST"]);
    expect(
      extract.operations
        .filter((operation) => operation.queryParameters.includes("timeout"))
        .map((operation) => operation.op),
    ).toEqual([
      "get_points",
      "get_point",
      "scroll_points",
      "count_points",
      "facet",
      "query_points",
      "query_batch_points",
      "query_points_groups",
    ]);
  });

  test("the seven bodies reference their request schemas, each of them optional in the document", () => {
    expect(
      Object.fromEntries(
        extract.operations
          .filter((operation) => operation.requestBody !== null)
          .map((operation) => [operation.op, operation.requestBody]),
      ),
    ).toEqual({
      get_points: "PointRequest",
      scroll_points: "ScrollRequest",
      count_points: "CountRequest",
      facet: "FacetRequest",
      query_points: "QueryRequest",
      query_batch_points: "QueryRequestBatch",
      query_points_groups: "QueryGroupsRequest",
    });
    expect(extract.operations.some((operation) => operation.requestBodyRequired)).toBe(false);
  });

  test("holds every schema a body reaches, and nothing a schema references is missing", () => {
    expect(Object.keys(schemas)).toHaveLength(129);
    expect(Object.keys(schemas)).toEqual(Object.keys(schemas).sort());
    const referenced = [...JSON.stringify(schemas).matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map(
      (match) => match[1],
    );
    for (const name of referenced) expect(Object.hasOwn(schemas, name)).toBe(true);
  });

  test("the server closes Filter and the two payload selectors, and no condition variant", () => {
    expect(Object.keys(schemas).filter((name) => schemas[name].additionalProperties === false)).toEqual([
      "Filter",
      "PayloadSelectorExclude",
      "PayloadSelectorInclude",
    ]);
    expect(Object.keys(schemas.Filter.properties ?? {}).sort()).toEqual(["min_should", "must", "must_not", "should"]);
    expect((schemas.Condition.anyOf ?? []).map((variant) => variant.$ref?.split("/").pop())).toEqual([
      "FieldCondition",
      "IsEmptyCondition",
      "IsNullCondition",
      "HasIdCondition",
      "HasVectorCondition",
      "SliceCondition",
      "NestedCondition",
      "Filter",
    ]);
    expect(Object.keys(schemas.FieldCondition.properties ?? {})).toEqual([
      "key",
      "match",
      "range",
      "geo_bounding_box",
      "geo_radius",
      "geo_polygon",
      "values_count",
      "is_empty",
      "is_null",
    ]);
  });

  test("carries no prose, and keeps the one property that is named like a prose key", () => {
    const prose: string[] = [];
    const walk = (node: unknown, where: string, properties: boolean): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${where}/${index}`, false));
      } else if (typeof node === "object" && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (!properties && ["description", "example", "examples", "title", "externalDocs"].includes(key)) {
            prose.push(`${where}/${key}`);
          }
          walk(value, `${where}/${key}`, !properties && key === "properties");
        }
      }
    };
    walk(schemas, "", true);
    expect(prose).toEqual([]);
    expect(schemas.FeedbackItem.properties?.example).toEqual({ $ref: "#/components/schemas/VectorInput" });
  });
});
