/**
 * The Qdrant REST client over a recording transport (vector-family spec 6.1; QE1, QE3, QE4, QE10, QE16): what it
 * hands the shared transport, the paths it builds, and everything it refuses before the wire. The real transport is
 * driven in rest-client-wire.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  QDRANT_OPS,
  type QdrantOp,
  type QdrantRequest,
  type QdrantRouteTemplates,
} from "@/lib/db/providers/vector/qdrant/client";
import { buildQdrantConnectionOptions } from "@/lib/db/providers/vector/qdrant/connection-options";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import type { DatabaseConnection } from "@/lib/types";
import { expectCalls } from "../../../helpers/call-log";
import { QDRANT_FIXTURE_ROUTES, QDRANT_ROUTE_FIXTURE, QDRANT_SAMPLE_REQUESTS } from "../../../helpers/qdrant-routes";
import { okAnswer, type RecordedAnswer, recordingQdrantTransport } from "../../../helpers/qdrant-transport";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";

const OPTIONS = buildQdrantConnectionOptions(
  {
    id: "c1",
    name: "Qdrant",
    type: "qdrant",
    host: "127.0.0.1",
    port: 6333,
    password: TEST_PASSWORD,
    createdAt: new Date(0),
  } as unknown as DatabaseConnection,
  { executionReadOnly: false, queryTimeout: 30_000 },
);

const signal = () => new AbortController().signal;

function client(answer?: RecordedAnswer, routes: QdrantRouteTemplates = QDRANT_FIXTURE_ROUTES) {
  const wire = recordingQdrantTransport(answer);
  return { wire, qdrant: createRestQdrantClient(OPTIONS, routes, wire.factory) };
}

const request = (op: QdrantOp, overrides: Partial<QdrantRequest> = {}): QdrantRequest => ({
  op,
  params: QDRANT_SAMPLE_REQUESTS[op].params,
  query: {},
  ...(QDRANT_SAMPLE_REQUESTS[op].body === undefined ? {} : { body: QDRANT_SAMPLE_REQUESTS[op].body }),
  ...overrides,
});

async function refused(run: () => Promise<unknown>): Promise<QueryError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    expect(String((error as QueryError).provider)).toBe("qdrant");
    return error as QueryError;
  }
  throw new Error("the client sent a request this case must refuse");
}

describe("what the client hands the transport", () => {
  test("one transport per client, built from the connection's options, with the api-key header set once", () => {
    const { wire } = client();
    expect(wire.built).toEqual([
      {
        origin: { scheme: "http", host: "127.0.0.1", port: 6333 },
        tls: null,
        maxSockets: 4,
        headers: { "api-key": TEST_PASSWORD },
      },
    ]);
  });

  test("a request carries the caller's signal, the response cap and the body as written", async () => {
    const { wire, qdrant } = client();
    const controller = new AbortController();
    const body = '{"ids":[9007199254740993,18446744073709551615]}';
    await qdrant.send(request("get_points", { body }), controller.signal);
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]).toEqual({
      method: "POST",
      url: "http://127.0.0.1:6333/collections/docs/points",
      body,
      signal: controller.signal,
      maxResponseBytes: 16_777_216,
    });
    expect(wire.requests[0].signal).toBe(controller.signal);
  });

  test("a GET carries no body property at all", async () => {
    const { wire, qdrant } = client();
    await qdrant.send(request("root"), signal());
    expect(Object.hasOwn(wire.requests[0], "body")).toBe(false);
    expect(wire.requests[0].url).toBe("http://127.0.0.1:6333/");
  });

  test("a POST with no body is sent with none, as the OpenAPI document declares its bodies optional", async () => {
    const { wire, qdrant } = client();
    await qdrant.send({ op: "scroll_points", params: { collection_name: "docs" }, query: {} }, signal());
    expectCalls(wire, [{ method: "POST /collections/docs/points/scroll", args: [null] }]);
  });

  test("close closes the transport", () => {
    const { wire, qdrant } = client();
    qdrant.close();
    expect(wire.closed()).toBe(1);
  });
});

describe("the answer is data, whatever its status, and nothing is sent twice (QE3)", () => {
  test.each([200, 401, 403, 404, 429, 500])("a %d answer is handed back as it arrived", async (status) => {
    const answer = { status, contentType: "text/plain", retryAfter: status === 429 ? "10" : null, text: "body" };
    const { wire, qdrant } = client(() => answer);
    expect(await qdrant.send(request("get_collections"), signal())).toEqual(answer);
    expect(wire.calls).toHaveLength(1);
  });

  test("a property the transport adds does not cross the seam", async () => {
    const { qdrant } = client(() => ({ ...okAnswer("{}"), extra: 1 }) as never);
    expect(Object.keys(await qdrant.send(request("root"), signal())).sort()).toEqual([
      "contentType",
      "retryAfter",
      "status",
      "text",
    ]);
  });

  test.each([...QDRANT_OPS])("a lost answer to %s is reported as lost after exactly one request", async (op) => {
    const lost = new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)");
    const { wire, qdrant } = client(() => {
      throw lost;
    });
    await expect(qdrant.send(request(op), signal())).rejects.toBe(lost);
    expect(wire.calls).toHaveLength(1);
  });
});

describe("the client builds exactly the 17 routes of the pinned OpenAPI document (QE10, QE16, QE21)", () => {
  test("the route fixture is the one derived from the document pinned by its sha256", () => {
    expect(QDRANT_ROUTE_FIXTURE.$generated.sha256).toBe(
      "eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a",
    );
    expect(QDRANT_ROUTE_FIXTURE.$generated.scope).toBe("v1");
  });

  test("the seam's operation list is the fixture's, one for one", () => {
    expect([...QDRANT_OPS].sort() as string[]).toEqual(QDRANT_ROUTE_FIXTURE.routes.map((route) => route.op).sort());
    expect(QDRANT_OPS).toHaveLength(17);
    expect(new Set(QDRANT_OPS).size).toBe(17);
  });

  test.each([...QDRANT_ROUTE_FIXTURE.routes])("$op is $method $path", async (route) => {
    const { wire, qdrant } = client();
    await qdrant.send(request(route.op as QdrantOp), signal());
    const expected = route.path.replace("{collection_name}", "docs").replace("{id}", "42");
    expectCalls(wire, [{ method: `${route.method} ${expected}`, args: [route.method === "POST" ? "{}" : null] }]);
  });

  test("only GET and POST are ever sent", async () => {
    const { wire, qdrant } = client();
    for (const op of QDRANT_OPS) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in table order.
      await qdrant.send(request(op), signal());
    }
    expect([...new Set<string>(wire.requests.map((sent) => sent.method))].sort()).toEqual(["GET", "POST"]);
  });

  test("no operation, with any parameter the path rule lets through, reaches a path outside the table", async () => {
    const templates = QDRANT_ROUTE_FIXTURE.routes.map(
      (route) => new RegExp(`^${route.method} ${route.path.replace(/\{[a-z_]+\}/g, "[^/?#]+").replace(/\//g, "\\/")}$`),
    );
    const forbidden = [
      "healthz",
      "readyz",
      "livez",
      "telemetry",
      "metrics",
      "logger",
      "issues",
      "debugger",
      "stacktrace",
      "profiler",
      "audit",
      "cluster",
      "snapshots",
      "locks",
    ];
    const values = [
      "healthz",
      "telemetry",
      "%2e%2e",
      "..%2f..%2ftelemetry",
      "a?b",
      "a#b",
      "a b",
      "a:b",
      "a\\b",
      "été",
      "x;y",
    ];
    const { wire, qdrant } = client();
    for (const op of QDRANT_OPS) {
      for (const value of values) {
        const params = Object.fromEntries(Object.keys(QDRANT_SAMPLE_REQUESTS[op].params).map((name) => [name, value]));
        // oxlint-disable-next-line no-await-in-loop -- one request at a time.
        await qdrant.send(request(op, { params }), signal());
      }
    }
    expect(wire.calls).toHaveLength(QDRANT_OPS.length * values.length);
    for (const call of wire.calls) {
      expect({ line: call.method, known: templates.some((template) => template.test(call.method)) }).toEqual({
        line: call.method,
        known: true,
      });
      // A root-level path names only the two the table holds, never a health, telemetry or metrics path.
      const first = call.method.split(" ")[1].split("/")[1];
      expect(["", "collections", "aliases"]).toContain(first);
      expect(forbidden).not.toContain(first);
    }
  });

  test.each([
    ["one operation fewer", (table: Record<string, unknown>) => delete table.root],
    [
      "one operation more",
      (table: Record<string, unknown>) => (table.telemetry = { method: "GET", path: "/telemetry", query: [] }),
    ],
    [
      "another operation in place of one",
      (table: Record<string, unknown>) => {
        delete table.root;
        table.healthz = { method: "GET", path: "/healthz", query: [] };
      },
    ],
    [
      "a method outside GET and POST",
      (table: Record<string, unknown>) =>
        (table.get_collection = { method: "PUT", path: "/collections/{collection_name}", query: [] }),
    ],
    [
      "a path that is not absolute",
      (table: Record<string, unknown>) => (table.root = { method: "GET", path: "", query: [] }),
    ],
    [
      "a path with a dot segment",
      (table: Record<string, unknown>) =>
        (table.root = { method: "GET", path: "/collections/../telemetry", query: [] }),
    ],
    [
      "a path with an encoded byte",
      (table: Record<string, unknown>) => (table.root = { method: "GET", path: "/%2e%2e", query: [] }),
    ],
    [
      "a path with a query string",
      (table: Record<string, unknown>) => (table.root = { method: "GET", path: "/collections?api_key=x", query: [] }),
    ],
    [
      "a query key that is not a plain word",
      (table: Record<string, unknown>) => (table.root = { method: "GET", path: "/", query: ["a&b"] }),
    ],
  ])("a route table with %s is refused when the client is built, before any transport", (_name, change) => {
    const table: Record<string, unknown> = { ...QDRANT_FIXTURE_ROUTES };
    change(table);
    const wire = recordingQdrantTransport();
    expect(() => createRestQdrantClient(OPTIONS, table as unknown as QdrantRouteTemplates, wire.factory)).toThrow(
      TypeError,
    );
    expect(wire.built).toHaveLength(0);
  });

  test("an operation outside the table is refused with zero requests", async () => {
    const { wire, qdrant } = client();
    const error = await refused(() => qdrant.send({ op: "telemetry" as QdrantOp, params: {}, query: {} }, signal()));
    expect(error.message).toBe("The request names an operation this client does not send, so nothing was sent.");
    await refused(() => qdrant.send({ op: "toString" as QdrantOp, params: {}, query: {} }, signal()));
    expectCalls(wire, []);
  });
});

describe("QE1: a name is refused before it reaches a path, and every other character is encoded", () => {
  test.each([
    ["the empty name", ""],
    ["a single dot", "."],
    ["two dots", ".."],
    ["a slash", "a/b"],
    ["a NUL", "a\u0000b"],
    ["256 characters", "a".repeat(256)],
    ["a value that is not text", 7 as unknown as string],
  ])("%s is refused with zero requests", async (_what, name) => {
    const { wire, qdrant } = client();
    const error = await refused(() =>
      qdrant.send(request("get_collection", { params: { collection_name: name } }), signal()),
    );
    expect(error.message).toBe(
      "A collection name or point id in the request path is empty, `.` or `..`, holds `/` or a NUL character, or is longer than 255 characters, so nothing was sent.",
    );
    expectCalls(wire, []);
  });

  test("a parameter the request leaves out is refused the same way", async () => {
    const { wire, qdrant } = client();
    await refused(() => qdrant.send({ op: "get_point", params: { collection_name: "docs" }, query: {} }, signal()));
    await refused(() =>
      qdrant.send({ op: "get_collection", params: Object.create({ collection_name: "docs" }), query: {} }, signal()),
    );
    expectCalls(wire, []);
  });

  test("the rule holds for the point id of get_point too", async () => {
    const { wire, qdrant } = client();
    for (const id of ["..", "1/2", ""]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
      await refused(() => qdrant.send(request("get_point", { params: { collection_name: "docs", id } }), signal()));
    }
    expectCalls(wire, []);
  });

  test.each([
    ["a:b", "/collections/a%3Ab"],
    ["%2e%2e", "/collections/%252e%252e"],
    ["a b", "/collections/a%20b"],
    ["a?b#c", "/collections/a%3Fb%23c"],
    ["a".repeat(255), `/collections/${"a".repeat(255)}`],
    ["...", "/collections/..."],
    ["café", "/collections/caf%C3%A9"],
    ["a\\b", "/collections/a%5Cb"],
  ])("the name %j reaches the server as one segment, in exactly one request", async (name, path) => {
    const { wire, qdrant } = client();
    await qdrant.send(request("get_collection", { params: { collection_name: name } }), signal());
    expectCalls(wire, [{ method: `GET ${path}`, args: [null] }]);
  });

  test("a name that is not well-formed Unicode is refused by name, never thrown as a URIError", async () => {
    const { wire, qdrant } = client();
    const error = await refused(() =>
      qdrant.send(request("get_collection", { params: { collection_name: "a\ud800b" } }), signal()),
    );
    expect(error.message).toBe(
      "A collection name or point id in the request path is not well-formed Unicode text, so nothing was sent.",
    );
    expectCalls(wire, []);
  });

  test("the 255 is counted in characters, as the server counts it", async () => {
    const { wire, qdrant } = client();
    await qdrant.send(request("get_collection", { params: { collection_name: "\u{1F600}".repeat(255) } }), signal());
    await refused(() =>
      qdrant.send(request("get_collection", { params: { collection_name: "\u{1F600}".repeat(256) } }), signal()),
    );
    expect(wire.calls).toHaveLength(1);
  });

  test("a point id above 2^53 is written with exactly its digits", async () => {
    const { wire, qdrant } = client();
    await qdrant.send(
      request("get_point", { params: { collection_name: "docs", id: "18446744073709551615" } }),
      signal(),
    );
    expectCalls(wire, [{ method: "GET /collections/docs/points/18446744073709551615", args: [null] }]);
  });

  test("a parameter the route's template does not declare is refused", async () => {
    const { wire, qdrant } = client();
    const error = await refused(() =>
      qdrant.send(request("get_collections", { params: { collection_name: "docs" } }), signal()),
    );
    expect(error.message).toBe("The request names a path parameter its route does not declare, so nothing was sent.");
    expectCalls(wire, []);
  });
});

describe("only the query keys a route declares, and never a key in a URL (QE4, QE10)", () => {
  test("a declared key is sent, encoded", async () => {
    const { wire, qdrant } = client();
    await qdrant.send(request("scroll_points", { query: { timeout: "3" } }), signal());
    await qdrant.send(
      request("get_optimizations", { query: { with: "queued,completed", completed_limit: "16" } }),
      signal(),
    );
    expectCalls(wire, [
      { method: "POST /collections/docs/points/scroll?timeout=3", args: ["{}"] },
      { method: "GET /collections/docs/optimizations?with=queued%2Ccompleted&completed_limit=16", args: [null] },
    ]);
  });

  test.each([...QDRANT_OPS])("%s never carries api_key, api-key or an undeclared key", async (op) => {
    const { wire, qdrant } = client();
    for (const key of ["api_key", "api-key", "wait", "ordering", "anonymize"]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
      const error = await refused(() => qdrant.send(request(op, { query: { [key]: "x" } }), signal()));
      expect(error.message).toBe("The request carries a query key its route does not declare, so nothing was sent.");
      expect(error.message).not.toContain(key);
    }
    expectCalls(wire, []);
  });

  test("timeout on a route that does not declare it is refused", async () => {
    const { wire, qdrant } = client();
    await refused(() => qdrant.send(request("get_collections", { query: { timeout: "5" } }), signal()));
    await refused(() => qdrant.send(request("get_collection", { query: { timeout: "5" } }), signal()));
    expectCalls(wire, []);
  });

  test("a query value that is not text is refused", async () => {
    const { wire, qdrant } = client();
    const error = await refused(() =>
      qdrant.send(request("scroll_points", { query: { timeout: 3 as unknown as string } }), signal()),
    );
    expect(error.message).toBe("The request carries a query value that is not text, so nothing was sent.");
    expectCalls(wire, []);
  });

  test("no built URL ever holds the secret", async () => {
    const { wire, qdrant } = client();
    for (const op of QDRANT_OPS) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      await qdrant.send(request(op), signal());
    }
    for (const sent of wire.requests) expect(sent.url).not.toContain(TEST_PASSWORD);
  });
});

describe("bodies", () => {
  test("a GET with a body is refused", async () => {
    const { wire, qdrant } = client();
    const error = await refused(() => qdrant.send(request("get_collection", { body: "{}" }), signal()));
    expect(error.message).toBe("The request gives a body to a route that takes none, so nothing was sent.");
    expectCalls(wire, []);
  });

  test("a body that is not text is refused", async () => {
    const { wire, qdrant } = client();
    const error = await refused(() =>
      qdrant.send(request("scroll_points", { body: { limit: 1 } as unknown as string }), signal()),
    );
    expect(error.message).toBe("The request gives a body that is not JSON text, so nothing was sent.");
    expectCalls(wire, []);
  });
});
