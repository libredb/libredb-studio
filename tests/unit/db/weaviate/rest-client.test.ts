/**
 * The Weaviate REST client over a recording transport (#1566 spec 3.2, W7): what it hands the shared transport, the
 * nineteen routes it builds and nothing else, and every refusal it raises before the wire: an operation outside the
 * table, a path parameter that would leave its segment, an undeclared parameter or query key, a body on a GET and
 * none on a POST. A route table that is not exactly the operations of `WEAVIATE_OPS` fails when the client is built.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  WEAVIATE_OPS,
  type WeaviateOp,
  type WeaviateRequest,
  type WeaviateRouteTemplates,
} from "@/lib/db/providers/vector/weaviate/client";
import { buildWeaviateConnectionOptions } from "@/lib/db/providers/vector/weaviate/connection-options";
import { createRestWeaviateClient } from "@/lib/db/providers/vector/weaviate/rest-client";
import { WEAVIATE_CLIENT_ROUTES } from "@/lib/db/providers/vector/weaviate/routes";
import type { DatabaseConnection } from "@/lib/types";
import { expectCalls } from "../../../helpers/call-log";
import { okAnswer, type RecordedAnswer, recordingWeaviateTransport } from "../../../helpers/weaviate-wire";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const ID = "00000000-0000-0000-0000-000000000001";

const OPTIONS = buildWeaviateConnectionOptions(
  {
    id: "c1",
    name: "Weaviate",
    type: "weaviate",
    host: "127.0.0.1",
    port: 8080,
    password: TEST_PASSWORD,
    createdAt: new Date(0),
  } as unknown as DatabaseConnection,
  { executionReadOnly: false, queryTimeout: 30_000 },
);

const signal = () => new AbortController().signal;

/** Each operation's parameters and body, and the request line they make. */
const SAMPLES: Readonly<Record<WeaviateOp, { params: Record<string, string>; body?: string; line: string }>> = {
  meta: { params: {}, line: "GET /v1/meta" },
  schema: { params: {}, line: "GET /v1/schema" },
  collection: { params: { collection: "Article" }, line: "GET /v1/schema/Article" },
  shards: { params: { collection: "Article" }, line: "GET /v1/schema/Article/shards" },
  tenants: { params: { collection: "Article" }, line: "GET /v1/schema/Article/tenants" },
  tenant: { params: { collection: "Article", tenant: "tenantA" }, line: "GET /v1/schema/Article/tenants/tenantA" },
  aliases: { params: {}, line: "GET /v1/aliases" },
  alias: { params: { alias: "Docs" }, line: "GET /v1/aliases/Docs" },
  nodes: { params: {}, line: "GET /v1/nodes" },
  collection_nodes: { params: { collection: "Article" }, line: "GET /v1/nodes/Article" },
  objects: { params: {}, line: "GET /v1/objects" },
  object: { params: { collection: "Article", id: ID }, line: `GET /v1/objects/Article/${ID}` },
  search_bm25: { params: { collection: "Article" }, body: "{}", line: "POST /v1/search/Article/bm25" },
  search_hybrid: { params: { collection: "Article" }, body: "{}", line: "POST /v1/search/Article/hybrid" },
  search_near_vector: {
    params: { collection: "Article" },
    body: "{}",
    line: "POST /v1/search/Article/near-vector",
  },
  search_near_object: {
    params: { collection: "Article" },
    body: "{}",
    line: "POST /v1/search/Article/near-object",
  },
  aggregate: { params: { collection: "Article" }, body: "{}", line: "POST /v1/aggregate/Article" },
  ready: { params: {}, line: "GET /v1/.well-known/ready" },
  graphql: { params: {}, body: '{"query":"{Get{Article{title}}}"}', line: "POST /v1/graphql" },
};

function client(answer?: RecordedAnswer, routes: WeaviateRouteTemplates = WEAVIATE_CLIENT_ROUTES) {
  const wire = recordingWeaviateTransport(answer);
  return { wire, weaviate: createRestWeaviateClient(OPTIONS, routes, wire.factory) };
}

const request = (op: WeaviateOp, overrides: Partial<WeaviateRequest> = {}): WeaviateRequest => ({
  op,
  params: SAMPLES[op].params,
  query: {},
  ...(SAMPLES[op].body === undefined ? {} : { body: SAMPLES[op].body }),
  ...overrides,
});

async function refused(run: () => Promise<unknown>): Promise<QueryError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    expect(String((error as QueryError).provider)).toBe("weaviate");
    return error as QueryError;
  }
  throw new Error("the client sent a request this case must refuse");
}

describe("what the client hands the transport", () => {
  test("one transport per client, built from the connection's options, with the bearer header set once", () => {
    const { wire } = client();
    expect(wire.built).toEqual([
      {
        origin: { scheme: "http", host: "127.0.0.1", port: 8080 },
        tls: null,
        maxSockets: 4,
        headers: { authorization: `Bearer ${TEST_PASSWORD}` },
        reportsUnreachable: true,
      },
    ]);
  });

  test("a request carries the caller's signal, the response cap and the body as written", async () => {
    const { wire, weaviate } = client();
    const controller = new AbortController();
    const body = '{"query":"alpha","limit":9007199254740993}';
    await weaviate.send(request("search_bm25", { body }), controller.signal);
    expect(wire.requests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:8080/v1/search/Article/bm25",
        body,
        signal: controller.signal,
        maxResponseBytes: 16_777_216,
      },
    ]);
    expect(wire.requests[0].signal).toBe(controller.signal);
  });

  test("a GET carries no body property at all", async () => {
    const { wire, weaviate } = client();
    await weaviate.send(request("meta"), signal());
    expect(Object.hasOwn(wire.requests[0], "body")).toBe(false);
  });

  test("close closes the transport", () => {
    const { wire, weaviate } = client();
    weaviate.close();
    expect(wire.closed()).toBe(1);
  });
});

describe("the answer is data, whatever its status, and nothing is sent twice", () => {
  test.each([200, 401, 403, 404, 422, 429, 500, 503])("a %d answer is handed back as it arrived", async (status) => {
    const answer = { status, contentType: "application/json", retryAfter: status === 429 ? "7" : null, text: "{}" };
    const { wire, weaviate } = client(() => answer);
    expect(await weaviate.send(request("schema"), signal())).toEqual(answer);
    expect(wire.calls).toHaveLength(1);
  });

  test("a property the transport adds does not cross the seam", async () => {
    const { weaviate } = client(() => ({ ...okAnswer("{}"), extra: 1 }) as never);
    expect(Object.keys(await weaviate.send(request("meta"), signal())).sort()).toEqual([
      "contentType",
      "retryAfter",
      "status",
      "text",
    ]);
  });

  test.each([...WEAVIATE_OPS])("a lost answer to %s is reported as lost after exactly one request", async (op) => {
    const lost = new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)");
    const { wire, weaviate } = client(() => {
      throw lost;
    });
    await expect(weaviate.send(request(op), signal())).rejects.toBe(lost);
    expect(wire.calls).toHaveLength(1);
  });
});

describe("the client builds exactly the routes of the table (W7)", () => {
  test("the seam names nineteen operations, each once", () => {
    expect(WEAVIATE_OPS).toHaveLength(19);
    expect(new Set(WEAVIATE_OPS).size).toBe(19);
    expect(Object.keys(SAMPLES).sort()).toEqual([...WEAVIATE_OPS].sort());
  });

  test.each([...WEAVIATE_OPS])("%s is its one method and path", async (op) => {
    const { wire, weaviate } = client();
    await weaviate.send(request(op), signal());
    expectCalls(wire, [{ method: SAMPLES[op].line, args: [SAMPLES[op].body ?? null] }]);
  });

  test("only GET and POST are ever sent, and every path is under /v1/", async () => {
    const { wire, weaviate } = client();
    for (const op of WEAVIATE_OPS) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, in table order.
      await weaviate.send(request(op), signal());
    }
    expect([...new Set(wire.requests.map((sent) => sent.method))].sort()).toEqual(["GET", "POST"]);
    for (const call of wire.calls) expect(call.method.split(" ")[1]).toStartWith("/v1/");
  });

  test.each([
    ["one operation fewer", (table: Record<string, unknown>) => delete table.ready],
    [
      "one operation more",
      (table: Record<string, unknown>) => (table.backups = { method: "GET", path: "/v1/backups", query: [] }),
    ],
    [
      "another operation in place of one",
      (table: Record<string, unknown>) => {
        delete table.ready;
        table.users = { method: "GET", path: "/v1/users/db", query: [] };
      },
    ],
    [
      "a method outside GET and POST",
      (table: Record<string, unknown>) =>
        (table.collection = { method: "DELETE", path: "/v1/schema/{collection}", query: [] }),
    ],
    [
      "a path that is not absolute",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "v1/meta", query: [] }),
    ],
    [
      "a path with a dot segment",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "/v1/../users", query: [] }),
    ],
    [
      "a path with a single dot segment",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "/v1/./meta", query: [] }),
    ],
    [
      "a path with an encoded byte",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "/v1/%2e%2e", query: [] }),
    ],
    [
      "a path with a query string",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "/v1/meta?x=1", query: [] }),
    ],
    [
      "a path with an empty segment",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "/v1//meta", query: [] }),
    ],
    [
      "a query key that is not a plain word",
      (table: Record<string, unknown>) => (table.meta = { method: "GET", path: "/v1/meta", query: ["a&b"] }),
    ],
  ])("a route table with %s is refused when the client is built, before any transport", (_name, change) => {
    const table: Record<string, unknown> = { ...WEAVIATE_CLIENT_ROUTES };
    change(table);
    const wire = recordingWeaviateTransport();
    expect(() => createRestWeaviateClient(OPTIONS, table as unknown as WeaviateRouteTemplates, wire.factory)).toThrow(
      TypeError,
    );
    expect(wire.built).toHaveLength(0);
  });

  test("the table's own refusal sentences name the operation", () => {
    const build = (change: Record<string, unknown>) => () =>
      createRestWeaviateClient(
        OPTIONS,
        { ...WEAVIATE_CLIENT_ROUTES, ...change } as unknown as WeaviateRouteTemplates,
        recordingWeaviateTransport().factory,
      );
    expect(build({ meta: { method: "PUT", path: "/v1/meta", query: [] } })).toThrow(
      "The Weaviate route table gives meta a method that is neither GET nor POST",
    );
    expect(build({ meta: { method: "GET", path: "v1/meta", query: [] } })).toThrow(
      "The Weaviate route table gives meta a path that is not absolute",
    );
    expect(build({ meta: { method: "GET", path: "/v1/Meta", query: [] } })).toThrow(
      "The Weaviate route table gives meta a path segment this client cannot read",
    );
    expect(build({ meta: { method: "GET", path: "/v1/meta", query: ["Limit"] } })).toThrow(
      "The Weaviate route table gives meta a query key this client cannot read",
    );
    expect(build({ backups: { method: "GET", path: "/v1/backups", query: [] } })).toThrow(
      "The Weaviate route table must name exactly the 19 operations",
    );
  });

  test("an operation outside the table is refused with zero requests", async () => {
    const { wire, weaviate } = client();
    for (const op of ["backups", "users", "toString", "__proto__"]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
      const error = await refused(() => weaviate.send({ op: op as WeaviateOp, params: {}, query: {} }, signal()));
      expect(error.message).toBe("The request names an operation this client does not send, so nothing was sent.");
    }
    expectCalls(wire, []);
  });
});

describe("a path parameter is refused before it reaches a path, and every other character is encoded", () => {
  const INVALID =
    "A name in the request path is empty, `.` or `..`, holds `/` or a NUL character, as written or once percent-decoded, or is longer than 255 characters, so nothing was sent.";

  test.each([
    ["the empty name", ""],
    ["a single dot", "."],
    ["two dots", ".."],
    ["a slash", "a/b"],
    ["a NUL", "a\u0000b"],
    ["256 characters", "a".repeat(256)],
    ["a value that is not text", 7 as unknown as string],
    ["two percent-encoded dots", "%2e%2e"],
    ["one upper-case percent-encoded dot and a dot", "%2E."],
    ["one percent-encoded dot", "%2e"],
    ["a percent-encoded slash", "a%2fb"],
    ["a percent-encoded NUL", "a%00b"],
    ["percent-encoded dot segments toward another route", "..%2f..%2fusers"],
  ])("%s is refused with zero requests", async (_what, name) => {
    const { wire, weaviate } = client();
    const error = await refused(() => weaviate.send(request("collection", { params: { collection: name } }), signal()));
    expect(error.message).toBe(INVALID);
    expectCalls(wire, []);
  });

  test("every parameter of a two-parameter route is held to the rule", async () => {
    const { wire, weaviate } = client();
    for (const [op, params] of [
      ["object", { collection: "Article", id: ".." }],
      ["object", { collection: "..", id: ID }],
      ["tenant", { collection: "Article", tenant: "a/b" }],
    ] as const satisfies readonly (readonly [WeaviateOp, Readonly<Record<string, string>>])[]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
      expect((await refused(() => weaviate.send(request(op, { params }), signal()))).message).toBe(INVALID);
    }
    expectCalls(wire, []);
  });

  test("a parameter the request leaves out, or holds only by inheritance, is refused the same way", async () => {
    const { wire, weaviate } = client();
    await refused(() => weaviate.send({ op: "object", params: { collection: "Article" }, query: {} }, signal()));
    await refused(() =>
      weaviate.send({ op: "collection", params: Object.create({ collection: "Article" }), query: {} }, signal()),
    );
    expectCalls(wire, []);
  });

  test("a parameter the route's template does not declare is refused", async () => {
    const { wire, weaviate } = client();
    const error = await refused(() =>
      weaviate.send(request("schema", { params: { collection: "Article" } }), signal()),
    );
    expect(error.message).toBe("The request names a path parameter its route does not declare, so nothing was sent.");
    await refused(() => weaviate.send(request("collection", { params: { collection: "Article", x: "y" } }), signal()));
    expectCalls(wire, []);
  });

  test.each([
    ["a:b", "/v1/schema/a%3Ab"],
    ["%zz", "/v1/schema/%25zz"],
    ["%zz%2e", "/v1/schema/%25zz%252e"],
    ["100%", "/v1/schema/100%25"],
    ["a b", "/v1/schema/a%20b"],
    ["a?b#c", "/v1/schema/a%3Fb%23c"],
    ["a".repeat(255), `/v1/schema/${"a".repeat(255)}`],
    ["...", "/v1/schema/..."],
    ["café", "/v1/schema/caf%C3%A9"],
    ["a\\b", "/v1/schema/a%5Cb"],
  ])("the name %j reaches the server as one segment, in exactly one request", async (name, path) => {
    const { wire, weaviate } = client();
    await weaviate.send(request("collection", { params: { collection: name } }), signal());
    expectCalls(wire, [{ method: `GET ${path}`, args: [null] }]);
  });

  test("a name that is not well-formed Unicode is refused by name, never thrown as a URIError", async () => {
    const { wire, weaviate } = client();
    const error = await refused(() =>
      weaviate.send(request("collection", { params: { collection: "a\ud800b" } }), signal()),
    );
    expect(error.message).toBe("A name in the request path is not well-formed Unicode text, so nothing was sent.");
    expectCalls(wire, []);
  });

  test("the 255 is counted in characters", async () => {
    const { wire, weaviate } = client();
    await weaviate.send(request("collection", { params: { collection: "\u{1F600}".repeat(255) } }), signal());
    await refused(() =>
      weaviate.send(request("collection", { params: { collection: "\u{1F600}".repeat(256) } }), signal()),
    );
    expect(wire.calls).toHaveLength(1);
  });
});

describe("only the query keys a route declares", () => {
  test("declared keys are sent, encoded, in the order given", async () => {
    const { wire, weaviate } = client();
    await weaviate.send(
      request("objects", { query: { class: "Article", limit: "25", after: ID, include: "vector,classification" } }),
      signal(),
    );
    await weaviate.send(request("shards", { query: { tenant: "tenant A" } }), signal());
    await weaviate.send(request("nodes", { query: { output: "verbose" } }), signal());
    expectCalls(wire, [
      {
        method: `GET /v1/objects?class=Article&limit=25&after=${ID}&include=vector%2Cclassification`,
        args: [null],
      },
      { method: "GET /v1/schema/Article/shards?tenant=tenant+A", args: [null] },
      { method: "GET /v1/nodes?output=verbose", args: [null] },
    ]);
  });

  test.each([...WEAVIATE_OPS])("%s never carries an undeclared key, and the sentence never names it", async (op) => {
    const { wire, weaviate } = client();
    for (const key of ["api_key", "consistency_level", "node_name", "x-openai-api-key"]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
      const error = await refused(() => weaviate.send(request(op, { query: { [key]: "x" } }), signal()));
      expect(error.message).toBe("The request carries a query key its route does not declare, so nothing was sent.");
      expect(error.message).not.toContain(key);
    }
    expectCalls(wire, []);
  });

  test("a query value that is not text is refused", async () => {
    const { wire, weaviate } = client();
    const error = await refused(() =>
      weaviate.send(request("objects", { query: { limit: 25 as unknown as string } }), signal()),
    );
    expect(error.message).toBe("The request carries a query value that is not text, so nothing was sent.");
    expectCalls(wire, []);
  });
});

describe("a GET takes no body and a POST takes one", () => {
  test.each(WEAVIATE_OPS.filter((op) => WEAVIATE_CLIENT_ROUTES[op].method === "GET"))(
    "a body on %s is refused with zero requests",
    async (op) => {
      const { wire, weaviate } = client();
      for (const body of ["{}", ""]) {
        // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
        const error = await refused(() => weaviate.send(request(op, { body }), signal()));
        expect(error.message).toBe("The request gives a body to a route that takes none, so nothing was sent.");
      }
      expectCalls(wire, []);
    },
  );

  test.each(WEAVIATE_OPS.filter((op) => WEAVIATE_CLIENT_ROUTES[op].method === "POST"))(
    "%s with no JSON text is refused with zero requests",
    async (op) => {
      const { wire, weaviate } = client();
      const { body: _body, ...bodiless } = request(op);
      for (const sent of [bodiless, { ...bodiless, body: { query: "x" } as unknown as string }]) {
        // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
        const error = await refused(() => weaviate.send(sent, signal()));
        expect(error.message).toBe("The request gives a POST route no JSON text, so nothing was sent.");
      }
      expectCalls(wire, []);
    },
  );
});
