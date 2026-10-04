/**
 * The InfluxDB route-table client over a recording transport (InfluxDB spec 3.3; E8, I5): what it hands the shared
 * transport for each route of both tables, and everything it refuses before the transport is called. The real
 * transport is driven in client-wire.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  createInfluxClient,
  type InfluxClientFactory,
  type InfluxSend,
  type InfluxTransportFactory,
} from "@/lib/db/providers/timeseries/influxdb/client";
import {
  buildInfluxConnectionOptions,
  INFLUX_MAX_IN_FLIGHT,
  INFLUX_RESPONSE_CAP_BYTES,
  type InfluxConnectionOptions,
  type InfluxType,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import {
  INFLUXQL_ROUTES,
  type InfluxqlRouteId,
  type InfluxRoute,
  type InfluxRouteTable,
  SQL_ROUTES,
} from "@/lib/db/providers/timeseries/influxdb/routes";
import type { DatabaseConnection } from "@/lib/types";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "password";

function options(type: InfluxType, overrides: Record<string, unknown> = {}): InfluxConnectionOptions {
  return buildInfluxConnectionOptions(
    {
      id: "c1",
      name: "InfluxDB",
      type,
      host: "127.0.0.1",
      password: TEST_PASSWORD,
      createdAt: new Date(0),
      ...overrides,
    } as unknown as DatabaseConnection,
    { type, queryTimeout: 30_000 },
  );
}

const INFLUXQL = options("influxdb", { user: TEST_USER });
const SQL = options("influxdb3");

interface Recording {
  readonly factory: InfluxTransportFactory;
  /** The options of every transport the factory built: one per client. */
  readonly built: NodeTransportOptions[];
  /** Every request as the client handed it to the transport. */
  readonly requests: NodeRequest[];
  closed(): number;
}

const NO_CONTENT: NodeResponse = { status: 204, contentType: null, retryAfter: null, text: "" };

function recording(answer: (request: NodeRequest) => NodeResponse | Promise<NodeResponse> = () => NO_CONTENT) {
  const built: NodeTransportOptions[] = [];
  const requests: NodeRequest[] = [];
  let closed = 0;
  const wire: Recording = {
    built,
    requests,
    closed: () => closed,
    factory: (transportOptions) => {
      built.push(transportOptions);
      return {
        async request(request) {
          requests.push(request);
          return answer(request);
        },
        close() {
          closed += 1;
        },
      };
    },
  };
  return wire;
}

const signal = () => new AbortController().signal;

async function refused(run: () => Promise<unknown>, type: InfluxType): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(String((error as DatabaseConfigError).provider)).toBe(type);
    return (error as DatabaseConfigError).message;
  }
  throw new Error("the client sent a request this case must refuse");
}

describe("what the client hands the transport", () => {
  test("one transport per client, built from the connection's origin, TLS, socket bound and headers", () => {
    const wire = recording();
    createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory);
    expect(wire.built).toEqual([
      {
        origin: { scheme: "http", host: "127.0.0.1", port: 8086 },
        tls: null,
        maxSockets: INFLUX_MAX_IN_FLIGHT,
        headers: { authorization: `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64")}` },
      },
    ]);
    expect(wire.built[0].headers).toBe(INFLUXQL.headers);
    expect(wire.requests).toEqual([]);
  });

  test("a TLS connection hands its material and its https origin through", () => {
    const tls = options("influxdb3", { host: "influx.test", ssl: { mode: "require" } });
    const wire = recording();
    createInfluxClient(tls, SQL_ROUTES, wire.factory);
    expect(wire.built[0].origin).toEqual({ scheme: "https", host: "influx.test", port: 8181 });
    expect(wire.built[0].tls).toBe(tls.tls);
    expect(wire.built[0].tls?.rejectUnauthorized).toBe(false);
    expect(wire.built[0].headers).toEqual({ authorization: `Bearer ${TEST_PASSWORD}` });
  });

  test("the query route hands form fields in the table's order, never a body, and no URL query string (R14)", async () => {
    const wire = recording();
    const client = createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory);
    const controller = new AbortController();
    await client.send({ route: "query", values: { q: 'SELECT * FROM "home"', db: "home" } }, controller.signal);
    expect(wire.requests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:8086/query",
        form: { db: "home", q: 'SELECT * FROM "home"', chunked: "true", chunk_size: "1000" },
        signal: controller.signal,
        maxResponseBytes: INFLUX_RESPONSE_CAP_BYTES,
      },
    ]);
    expect(wire.requests[0].signal).toBe(controller.signal);
    expect(Object.keys(wire.requests[0].form ?? {})).toEqual(["db", "q", "chunked", "chunk_size"]);
    expect("body" in wire.requests[0]).toBe(false);
  });

  test("an optional key that is not given is left out, never sent empty", async () => {
    const wire = recording();
    await createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory).send(
      { route: "query", values: { q: "SHOW DATABASES" } },
      signal(),
    );
    expect(wire.requests[0].form).toEqual({ q: "SHOW DATABASES", chunked: "true", chunk_size: "1000" });
  });

  test("the SQL query route hands a JSON body of exactly its three declared keys, never form fields", async () => {
    const wire = recording();
    await createInfluxClient(SQL, SQL_ROUTES, wire.factory).send(
      { route: "query", values: { q: "SELECT 1", db: "home" } },
      signal(),
    );
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0].method).toBe("POST");
    expect(wire.requests[0].url).toBe("http://127.0.0.1:8181/api/v3/query_sql");
    expect(wire.requests[0].body).toBe('{"db":"home","q":"SELECT 1","format":"jsonl"}');
    expect("form" in wire.requests[0]).toBe(false);
  });

  test("the database listing is a GET with its one fixed query key and no body", async () => {
    const wire = recording();
    await createInfluxClient(SQL, SQL_ROUTES, wire.factory).send({ route: "databases", values: {} }, signal());
    expect(wire.requests[0].method).toBe("GET");
    expect(wire.requests[0].url).toBe("http://127.0.0.1:8181/api/v3/configure/database?format=json");
    expect("body" in wire.requests[0]).toBe(false);
    expect("form" in wire.requests[0]).toBe(false);
  });

  test.each([
    ["influxdb", INFLUXQL_ROUTES, INFLUXQL, 8086],
    ["influxdb3", SQL_ROUTES, SQL, 8181],
  ] as const)("%s reads /ping and /health as bare GETs", async (_type, routes, connection, port) => {
    const wire = recording();
    const client = createInfluxClient<"ping" | "health">(connection, routes, wire.factory);
    await client.send({ route: "ping", values: {} }, signal());
    await client.send({ route: "health", values: {} }, signal());
    expect(wire.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET http://127.0.0.1:${port}/ping`,
      `GET http://127.0.0.1:${port}/health`,
    ]);
    for (const request of wire.requests) {
      expect(Object.keys(request).sort()).toEqual(["maxResponseBytes", "method", "signal", "url"]);
    }
  });

  test("every request carries the connection's response cap", async () => {
    const wire = recording();
    const capped: InfluxConnectionOptions = { ...SQL, responseCapBytes: 4096 };
    await createInfluxClient(capped, SQL_ROUTES, wire.factory).send({ route: "ping", values: {} }, signal());
    expect(wire.requests[0].maxResponseBytes).toBe(4096);
  });

  test("the answer is the status, the content type and the text, whatever the status, and no header", async () => {
    const wire = recording(() => ({
      status: 401,
      contentType: "application/json",
      retryAfter: "3",
      text: '{"error":"authorization failed"}',
    }));
    const answer = await createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory).send(
      { route: "query", values: { q: "SHOW DATABASES" } },
      signal(),
    );
    expect(answer).toEqual({ status: 401, contentType: "application/json", text: '{"error":"authorization failed"}' });
  });

  test("a transport failure reaches the caller as it was thrown", async () => {
    const lost = new TransportError("network", "The server ended the response before it was complete", {
      truncated: true,
    });
    const wire = recording(() => {
      throw lost;
    });
    const client = createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory);
    await expect(client.send({ route: "ping", values: {} }, signal())).rejects.toBe(lost);
  });

  test("close() closes the transport", () => {
    const wire = recording();
    const client = createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory);
    expect(wire.closed()).toBe(0);
    client.close();
    expect(wire.closed()).toBe(1);
  });

  // This only proves a client builds and closes on the default factory without opening a socket; that the default is
  // the shared node transport is proved in client-wire.test.ts, which sends through it to a live server.
  test("with no factory, a client is built on the default transport and closed without opening a socket", () => {
    const client = createInfluxClient(INFLUXQL, INFLUXQL_ROUTES);
    expect(typeof client.send).toBe("function");
    client.close();
  });

  test("the factory type and the send type are the client's own", async () => {
    const wire = recording();
    const factory: InfluxClientFactory = createInfluxClient;
    const client = factory(INFLUXQL, INFLUXQL_ROUTES, wire.factory);
    const send: InfluxSend<InfluxqlRouteId> = (request, abort) => client.send(request, abort);
    expect((await send({ route: "ping", values: {} }, signal())).status).toBe(204);
  });
});

describe("what the client refuses before the transport is called (E8)", () => {
  function influxql() {
    const wire = recording();
    return { wire, client: createInfluxClient(INFLUXQL, INFLUXQL_ROUTES, wire.factory) };
  }

  test.each(["u", "p", "params", "epoch", "rp", "pretty", "async", "time_format", "verbose", "chunk"])(
    "the key %s, which the query route does not declare, names the key and never a value",
    async (key) => {
      const { wire, client } = influxql();
      const message = await refused(
        () => client.send({ route: "query", values: { q: "SHOW DATABASES", [key]: TEST_PASSWORD } }, signal()),
        "influxdb",
      );
      expect(message).toBe(
        `The request fills the key "${key}", which its route does not let a request fill, so nothing was sent.`,
      );
      expect(message).not.toContain(TEST_PASSWORD);
      expect(wire.requests).toEqual([]);
    },
  );

  test.each(["chunked", "chunk_size"])("the key %s is fixed by the table, so a request cannot fill it", async (key) => {
    const { wire, client } = influxql();
    const message = await refused(
      () => client.send({ route: "query", values: { q: "SHOW DATABASES", [key]: "10000" } }, signal()),
      "influxdb",
    );
    expect(message).toBe(
      `The request fills the key "${key}", which its route does not let a request fill, so nothing was sent.`,
    );
    expect(wire.requests).toEqual([]);
  });

  test("a key an object inherits is not a declared key", async () => {
    const { wire, client } = influxql();
    const message = await refused(
      () => client.send({ route: "query", values: { q: "SHOW DATABASES", toString: "x" } }, signal()),
      "influxdb",
    );
    expect(message).toContain('"toString"');
    expect(wire.requests).toEqual([]);
  });

  test("a GET route takes no key at all", async () => {
    const { wire, client } = influxql();
    const message = await refused(
      () => client.send({ route: "ping", values: { verbose: "true" } }, signal()),
      "influxdb",
    );
    expect(message).toContain('"verbose"');
    expect(wire.requests).toEqual([]);
  });

  test("the fixed format key of the database listing cannot be filled", async () => {
    const wire = recording();
    const client = createInfluxClient(SQL, SQL_ROUTES, wire.factory);
    const message = await refused(
      () => client.send({ route: "databases", values: { format: "csv" } }, signal()),
      "influxdb3",
    );
    expect(message).toContain('"format"');
    expect(wire.requests).toEqual([]);
  });

  test("a missing required form key is refused, naming the key", async () => {
    const { wire, client } = influxql();
    const message = await refused(() => client.send({ route: "query", values: { db: "home" } }, signal()), "influxdb");
    expect(message).toBe('The request is missing the key "q", which its route requires, so nothing was sent.');
    expect(wire.requests).toEqual([]);
  });

  test.each(["db", "q"])("a missing required body key, %s, is refused, naming the key", async (key) => {
    const wire = recording();
    const client = createInfluxClient(SQL, SQL_ROUTES, wire.factory);
    const values = Object.fromEntries(Object.entries({ db: "home", q: "SELECT 1" }).filter(([name]) => name !== key));
    const message = await refused(() => client.send({ route: "query", values }, signal()), "influxdb3");
    expect(message).toBe(`The request is missing the key "${key}", which its route requires, so nothing was sent.`);
    expect(wire.requests).toEqual([]);
  });

  test("a value that is not text is refused, naming the key and never the value", async () => {
    const { wire, client } = influxql();
    const values = { q: ["SHOW DATABASES", TEST_PASSWORD] } as unknown as Record<string, string>;
    const message = await refused(() => client.send({ route: "query", values }, signal()), "influxdb");
    expect(message).toBe('The request gives the key "q" a value that is not text, so nothing was sent.');
    expect(wire.requests).toEqual([]);
  });

  test.each(["write", "toString", "__proto__", ""])("the route %j is not in the table", async (route) => {
    const { wire, client } = influxql();
    const message = await refused(
      () => client.send({ route: route as InfluxqlRouteId, values: { q: "x" } }, signal()),
      "influxdb",
    );
    expect(message).toBe("The request names a route this client does not send, so nothing was sent.");
    expect(wire.requests).toEqual([]);
  });

  test("a route of the other table is not sent: the InfluxQL client has no database listing", async () => {
    const { wire, client } = influxql();
    await refused(() => client.send({ route: "databases" as InfluxqlRouteId, values: {} }, signal()), "influxdb");
    expect(wire.requests).toEqual([]);
  });

  const FILL = { q: { fill: "required" } } as const;
  const MALFORMED: readonly (readonly [string, InfluxRoute, string])[] = [
    [
      "both a JSON body and form fields",
      { method: "POST", path: "/query", query: {}, body: FILL, form: FILL },
      'The route "query" declares both a JSON body and form fields, so nothing was sent.',
    ],
    [
      "a GET with a JSON body",
      { method: "GET", path: "/query", query: {}, body: FILL },
      'The route "query" is a GET that declares a body, so nothing was sent.',
    ],
    [
      "a GET with form fields",
      { method: "GET", path: "/query", query: {}, form: FILL },
      'The route "query" is a GET that declares a body, so nothing was sent.',
    ],
    [
      "a POST with a URL query key",
      { method: "POST", path: "/query", query: FILL, form: {} },
      'The route "query" is a POST that declares a URL query key, so nothing was sent.',
    ],
  ];

  test.each(MALFORMED)("a table whose route declares %s is refused", async (_name, route, sentence) => {
    const wire = recording();
    const table: InfluxRouteTable<"query"> = { query: route };
    const client = createInfluxClient(INFLUXQL, table, wire.factory);
    const message = await refused(
      () => client.send({ route: "query", values: { q: "SHOW DATABASES" } }, signal()),
      "influxdb",
    );
    expect(message).toBe(sentence);
    expect(wire.requests).toEqual([]);
  });

  test("a POST route with no body at all sends none", async () => {
    const wire = recording();
    const table: InfluxRouteTable<"query"> = { query: { method: "POST", path: "/query", query: {} } };
    await createInfluxClient(INFLUXQL, table, wire.factory).send({ route: "query", values: {} }, signal());
    expect(Object.keys(wire.requests[0]).sort()).toEqual(["maxResponseBytes", "method", "signal", "url"]);
  });

  test("a GET route's filled query key reaches the URL through URLSearchParams, declared keys only", async () => {
    const wire = recording();
    const table: InfluxRouteTable<"databases"> = {
      databases: {
        method: "GET",
        path: "/api/v3/configure/database",
        query: { format: { fixed: "json" }, show: { fill: "optional" }, name: { fill: "required" } },
      },
    };
    const client = createInfluxClient(SQL, table, wire.factory);
    await client.send({ route: "databases", values: { name: "a&b=c d" } }, signal());
    expect(wire.requests[0].url).toBe("http://127.0.0.1:8181/api/v3/configure/database?format=json&name=a%26b%3Dc+d");
    await refused(() => client.send({ route: "databases", values: {} }, signal()), "influxdb3");
    expect(wire.requests).toHaveLength(1);
  });
});
