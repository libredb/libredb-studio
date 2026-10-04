/**
 * The InfluxDB route-table client on the real shared transport, against a `node:http` server this file starts
 * (InfluxDB spec 3.3; E8, E14, review focus 3 and 12): the exact request line, headers and body of each route, and
 * that no form of the secret is in a request line or a body. The connection is built by the real
 * buildInfluxConnectionOptions, so the options, the client and the transport are held together.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInfluxClient, type InfluxClient } from "@/lib/db/providers/timeseries/influxdb/client";
import {
  buildInfluxConnectionOptions,
  type InfluxConnectionOptions,
  type InfluxType,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { INFLUXQL_ROUTES, type InfluxRouteTable, SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import type { DatabaseConnection } from "@/lib/types";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "password";

interface Seen {
  /** The request line as the server read it: method, request target and HTTP version. */
  readonly line: string;
  readonly headers: IncomingHttpHeaders;
  /** The header names as they arrived, in order, lower-cased. */
  readonly headerNames: readonly string[];
  readonly body: string;
}

interface Recorder {
  readonly port: number;
  readonly seen: Seen[];
  /** TCP connections accepted so far. */
  accepted(): number;
}

type Answer = { readonly status: number; readonly contentType?: string; readonly text: string };

const servers: Server[] = [];
const clients: InfluxClient<string>[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});

function recorder(answer: Answer = { status: 204, text: "" }): Promise<Recorder> {
  const seen: Seen[] = [];
  let accepted = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        line: `${request.method} ${request.url} HTTP/${request.httpVersion}`,
        headers: request.headers,
        headerNames: request.rawHeaders.filter((_value, index) => index % 2 === 0).map((name) => name.toLowerCase()),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(answer.status, answer.contentType === undefined ? {} : { "content-type": answer.contentType });
      response.end(answer.text);
    });
  });
  server.on("connection", () => {
    accepted += 1;
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: (server.address() as AddressInfo).port, seen, accepted: () => accepted }),
    );
  });
}

function options(type: InfluxType, port: number, overrides: Record<string, unknown> = {}): InfluxConnectionOptions {
  return buildInfluxConnectionOptions(
    {
      id: "c1",
      name: "InfluxDB",
      type,
      host: "127.0.0.1",
      port,
      password: TEST_PASSWORD,
      createdAt: new Date(0),
      ...overrides,
    } as unknown as DatabaseConnection,
    { type, queryTimeout: 30_000 },
  );
}

function influxql(connection: InfluxConnectionOptions) {
  const client = createInfluxClient(connection, INFLUXQL_ROUTES);
  clients.push(client);
  return client;
}

function sql(connection: InfluxConnectionOptions) {
  const client = createInfluxClient(connection, SQL_ROUTES);
  clients.push(client);
  return client;
}

const deadline = () => AbortSignal.timeout(5000);

/** E14: no form of the secret is in a request line or a body. */
function expectNoSecret(seen: Seen, connection: InfluxConnectionOptions): void {
  expect(connection.secretForms.length).toBeGreaterThan(0);
  for (const form of connection.secretForms) {
    expect(seen.line).not.toContain(form);
    expect(seen.body).not.toContain(form);
  }
}

describe("the InfluxQL query route on the wire (E8, R14)", () => {
  test("POST /query with no query string, a form content type and the form body of exactly four fields", async () => {
    const server = await recorder({ status: 200, contentType: "application/json", text: '{"results":[]}\n' });
    const connection = options("influxdb", server.port, { user: TEST_USER });
    const answer = await influxql(connection).send(
      { route: "query", values: { q: 'SELECT * FROM "home" LIMIT 3', db: "home" } },
      deadline(),
    );
    expect(answer).toEqual({ status: 200, contentType: "application/json", text: '{"results":[]}\n' });
    expect(server.seen).toHaveLength(1);
    const [seen] = server.seen;
    expect(seen.line).toBe("POST /query HTTP/1.1");
    expect(seen.line).not.toContain("?");
    expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen.body).toBe("db=home&q=SELECT+*+FROM+%22home%22+LIMIT+3&chunked=true&chunk_size=1000");
    expect(seen.headers["content-length"]).toBe(String(Buffer.byteLength(seen.body)));
    expect([...new URLSearchParams(seen.body)]).toEqual([
      ["db", "home"],
      ["q", 'SELECT * FROM "home" LIMIT 3'],
      ["chunked", "true"],
      ["chunk_size", "1000"],
    ]);
    expectNoSecret(seen, connection);
  });

  test("with no database the body starts at q: db is left out, never sent empty", async () => {
    const server = await recorder();
    await influxql(options("influxdb", server.port)).send(
      { route: "query", values: { q: "SHOW DATABASES" } },
      deadline(),
    );
    expect(server.seen[0].line).toBe("POST /query HTTP/1.1");
    expect(server.seen[0].body).toBe("q=SHOW+DATABASES&chunked=true&chunk_size=1000");
  });

  test("a statement that holds what a URL or a form would read as structure stays one field", async () => {
    const server = await recorder();
    const text = `SELECT "a&b" FROM "m" WHERE "k" = 'x=1;y' AND "u" =~ /é+%20/ -- chunk_size=9&u=root&p=x`;
    await influxql(options("influxdb", server.port)).send(
      { route: "query", values: { q: text, db: "a&epoch=ns" } },
      deadline(),
    );
    const [seen] = server.seen;
    expect(seen.line).toBe("POST /query HTTP/1.1");
    expect([...new URLSearchParams(seen.body)]).toEqual([
      ["db", "a&epoch=ns"],
      ["q", text],
      ["chunked", "true"],
      ["chunk_size", "1000"],
    ]);
    expect(seen.body).toContain("%C3%A9");
  });

  test("a 64 KiB quote-heavy statement travels in the body, and the request target stays /query", async () => {
    const server = await recorder();
    const text = `SELECT * FROM "home" WHERE "room" = '${"\\'\"".repeat(21_820)}'`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(65_000);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65_536);
    await influxql(options("influxdb", server.port)).send({ route: "query", values: { q: text } }, deadline());
    const [seen] = server.seen;
    expect(seen.line).toBe("POST /query HTTP/1.1");
    expect(new URLSearchParams(seen.body).get("q")).toBe(text);
    expect(seen.headers["content-length"]).toBe(String(Buffer.byteLength(seen.body)));
  });
});

describe("the SQL routes on the wire (E8, I5)", () => {
  test("POST /api/v3/query_sql with a JSON body of exactly db, q and format", async () => {
    const server = await recorder({ status: 200, contentType: "application/jsonl", text: '{"x":1}\n' });
    const connection = options("influxdb3", server.port);
    await sql(connection).send({ route: "query", values: { q: 'SELECT 1 AS "x"', db: "home" } }, deadline());
    const [seen] = server.seen;
    expect(seen.line).toBe("POST /api/v3/query_sql HTTP/1.1");
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.body).toBe('{"db":"home","q":"SELECT 1 AS \\"x\\"","format":"jsonl"}');
    expect(Object.keys(JSON.parse(seen.body) as object)).toEqual(["db", "q", "format"]);
    expectNoSecret(seen, connection);
  });

  test("GET /api/v3/configure/database?format=json with no body and no content type", async () => {
    const server = await recorder({ status: 200, contentType: "application/json", text: "[]" });
    const connection = options("influxdb3", server.port);
    await sql(connection).send({ route: "databases", values: {} }, deadline());
    const [seen] = server.seen;
    expect(seen.line).toBe("GET /api/v3/configure/database?format=json HTTP/1.1");
    expect(seen.body).toBe("");
    expect(seen.headers["content-type"]).toBeUndefined();
    expect(seen.headers["content-length"]).toBeUndefined();
    expectNoSecret(seen, connection);
  });
});

describe("the version reads on the wire (R2)", () => {
  test.each([
    ["influxdb", influxql],
    ["influxdb3", sql],
  ] as const)("%s sends GET /ping and GET /health with no query string and no body", async (type, connect) => {
    const server = await recorder();
    const connection = options(type, server.port);
    const client: InfluxClient<"ping" | "health"> = connect(connection);
    expect((await client.send({ route: "ping", values: {} }, deadline())).status).toBe(204);
    await client.send({ route: "health", values: {} }, deadline());
    expect(server.seen.map((seen) => seen.line)).toEqual(["GET /ping HTTP/1.1", "GET /health HTTP/1.1"]);
    for (const seen of server.seen) {
      expect(seen.body).toBe("");
      expectNoSecret(seen, connection);
    }
    expect(server.accepted()).toBe(1);
  });
});

describe("the credential on the wire (E14)", () => {
  test.each([
    ["influxdb", { user: TEST_USER }, `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64")}`],
    ["influxdb", {}, `Token ${TEST_PASSWORD}`],
    ["influxdb3", {}, `Bearer ${TEST_PASSWORD}`],
  ] as const)(
    "%s with %j sends exactly one authorization header and the secret nowhere else",
    async (type, extra, header) => {
      const server = await recorder();
      const connection = options(type, server.port, extra);
      // The routes both tables hold; `query-unchunked` is the InfluxQL table's alone (R53).
      const routes: InfluxRouteTable<"ping" | "health" | "query"> = type === "influxdb" ? INFLUXQL_ROUTES : SQL_ROUTES;
      const client = createInfluxClient(connection, routes);
      clients.push(client);
      await client.send({ route: "query", values: { q: "SELECT 1", db: "home" } }, deadline());
      const [seen] = server.seen;
      expect(seen.headers.authorization).toBe(header);
      expect(seen.headerNames.filter((name) => name === "authorization")).toHaveLength(1);
      expect(seen.headers["accept-encoding"]).toBe("identity");
      const carriers = Object.entries(seen.headers).filter(([, value]) =>
        connection.secretForms.some((form) => String(value).includes(form)),
      );
      expect(carriers.map(([name]) => name)).toEqual(["authorization"]);
      expectNoSecret(seen, connection);
    },
  );

  test("with no secret, no authorization header is sent at all", async () => {
    const server = await recorder();
    const connection = options("influxdb", server.port, { password: undefined });
    await influxql(connection).send({ route: "query", values: { q: "SHOW DATABASES" } }, deadline());
    expect(server.seen[0].headers.authorization).toBeUndefined();
    expect(connection.secretForms).toEqual([]);
  });
});
