/**
 * The Qdrant REST client on the real shared transport, against listeners this file starts (vector-family spec 6.1;
 * QE2, QE3, QE4, QE6, QE13, QE20): what reaches the wire, what never does, and what a person reads when a request
 * does not complete. The connection is built by the real buildQdrantConnectionOptions, so the options, the client
 * and the transport are held together.
 *
 * The certificates are made with openssl when this file starts and never committed (makeCertificates in
 * tests/helpers/node-transport-fixtures.ts). A tunnel-shaped connection is the local forward, 127.0.0.1, dialled
 * with the far end as its identity, which is all the factory's SSH tunnel leaves of itself.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddressInfo,
  connect as tcpConnect,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  QDRANT_OPS,
  type QdrantClient,
  type QdrantOp,
  type QdrantRequest,
} from "@/lib/db/providers/vector/qdrant/client";
import {
  buildQdrantConnectionOptions,
  type QdrantConnectionOptions,
} from "@/lib/db/providers/vector/qdrant/connection-options";
import { answerFailure, type QdrantErrorContext, toProviderError } from "@/lib/db/providers/vector/qdrant/errors";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import { type DatabaseConnection, TUNNEL_FAR_END } from "@/lib/types";
import {
  closeAll,
  countingListener,
  eventually,
  httpListener,
  httpsListener,
  jsonAnswer,
  type Listener,
  makeCertificates,
  streamingAnswer,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";
import { QDRANT_FIXTURE_ROUTES, QDRANT_SAMPLE_REQUESTS } from "../../../helpers/qdrant-routes";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"];

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

const clients: QdrantClient[] = [];
const servers: Server[] = [];
const environment = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string): void {
  if (!environment.has(name)) environment.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.close();
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  environment.clear();
  await closeAll();
});

const ok = jsonAnswer(200, '{"result":{"collections":[]},"status":"ok","time":0}');

function options(port: number, overrides: Record<string, unknown> = {}): QdrantConnectionOptions {
  return buildQdrantConnectionOptions(
    {
      id: "c1",
      name: "Qdrant",
      type: "qdrant",
      host: "127.0.0.1",
      port,
      password: TEST_PASSWORD,
      createdAt: new Date(0),
      ...overrides,
    } as unknown as DatabaseConnection,
    { executionReadOnly: false, queryTimeout: 30_000 },
  );
}

function connect(connection: QdrantConnectionOptions): QdrantClient {
  const client = createRestQdrantClient(connection, QDRANT_FIXTURE_ROUTES);
  clients.push(client);
  return client;
}

const request = (op: QdrantOp, overrides: Partial<QdrantRequest> = {}): QdrantRequest => ({
  op,
  params: QDRANT_SAMPLE_REQUESTS[op].params,
  query: {},
  ...(QDRANT_SAMPLE_REQUESTS[op].body === undefined ? {} : { body: QDRANT_SAMPLE_REQUESTS[op].body }),
  ...overrides,
});

const context = (connection: QdrantConnectionOptions, op: QdrantOp = "get_collections"): QdrantErrorContext => ({
  phase: "request",
  op,
  endpoint: connection.endpoint,
  responseCapBytes: connection.responseCapBytes,
  timeoutMs: connection.callTimeoutMs,
  secretForms: connection.secretForms,
});

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

const deadline = () => AbortSignal.timeout(5000);

describe("what reaches the wire (QE2, QE4)", () => {
  test("a request carries exactly one credential header, the api-key, and asks for identity encoding", async () => {
    const listener = await httpListener(ok);
    const client = connect(options(listener.port));
    const answer = await client.send(
      request("scroll_points", { body: '{"limit":3}', query: { timeout: "3" } }),
      deadline(),
    );
    expect(answer.status).toBe(200);
    expect(listener.seen).toHaveLength(1);
    const [seen] = listener.seen;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/collections/docs/points/scroll?timeout=3");
    expect(seen.body).toBe('{"limit":3}');
    expect(seen.headers["api-key"]).toBe(TEST_PASSWORD);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["accept-encoding"]).toBe("identity");
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(Object.entries(seen.headers).filter(([, value]) => String(value).includes(TEST_PASSWORD))).toHaveLength(1);
  });

  test("with no secret, no credential header is sent at all", async () => {
    const listener = await httpListener(ok);
    await connect(options(listener.port, { password: undefined })).send(request("get_collections"), deadline());
    expect(listener.seen[0].headers["api-key"]).toBeUndefined();
    expect(listener.seen[0].headers.authorization).toBeUndefined();
  });

  test("a session's requests share one connection", async () => {
    const listener = await httpListener(ok);
    const client = connect(options(listener.port));
    for (const op of QDRANT_OPS) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a tree open issues them.
      await client.send(request(op), deadline());
    }
    expect(listener.seen).toHaveLength(17);
    expect(listener.accepted()).toBe(1);
  });

  test("a redirect is refused, naming only the target's origin, and the other server sees nothing", async () => {
    const other = await httpListener(ok);
    const redirecting = await httpListener((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${other.port}/collections?token=${TEST_PASSWORD}` });
      response.end();
    });
    const connection = options(redirecting.port);
    const error = await failure(() => connect(connection).send(request("get_collections"), deadline()));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("redirect");
    expect(other.seen).toHaveLength(0);
    const worded = toProviderError(error, context(connection));
    expect(worded).toBeInstanceOf(ConnectionError);
    expect(worded.message).toContain(`a redirect to http://127.0.0.1:${other.port},`);
    expect(worded.message).not.toContain(TEST_PASSWORD);
  });

  test("a redirect whose target's host holds the key is worded without the key", async () => {
    const redirecting = await httpListener((_request, response) => {
      response.writeHead(307, { location: `http://${TEST_PASSWORD}.example.test/x` });
      response.end();
    });
    const connection = options(redirecting.port);
    const error = await failure(() => connect(connection).send(request("get_collections"), deadline()));
    expect((error as TransportError).kind).toBe("redirect");
    const worded = toProviderError(error, context(connection));
    expect(worded).toBeInstanceOf(ConnectionError);
    expect(worded.message).not.toContain(TEST_PASSWORD);
    expect(worded.message).toContain(WITHHELD);
  });

  test("a content-encoding that holds the key is worded without the key", async () => {
    const encoding = await httpListener((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": TEST_PASSWORD });
      response.end("{}");
    });
    const connection = options(encoding.port);
    const error = await failure(() => connect(connection).send(request("get_collections"), deadline()));
    expect((error as TransportError).kind).toBe("encoding");
    const worded = toProviderError(error, context(connection));
    expect(worded).toBeInstanceOf(ConnectionError);
    expect(worded.message).not.toContain(TEST_PASSWORD);
    expect(worded.message).toContain(WITHHELD);
  });

  test("proxy variables naming a listener carry nothing to it", async () => {
    const proxy = await countingListener();
    for (const name of PROXY_VARIABLES) setEnvironment(name, `http://127.0.0.1:${proxy.port}`);
    setEnvironment("NODE_USE_ENV_PROXY", "1");
    const listener = await httpListener(ok);
    const answer = await connect(options(listener.port)).send(request("get_collections"), deadline());
    expect(answer.status).toBe(200);
    expect(listener.seen).toHaveLength(1);
    expect(proxy.accepted()).toBe(0);
  });

  test("with the egress guard on, a name that resolves to this machine is refused before any socket", async () => {
    const listener = await httpListener(ok);
    setEnvironment(FLAG, "true");
    const connection = options(listener.port, { host: "localhost" });
    const error = await failure(() => connect(connection).send(request("get_collections"), deadline()));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as Error).message).toContain("blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS");
    expect(toProviderError(error, context(connection))).toBe(error as Error);
    expect(listener.accepted()).toBe(0);
  });
});

/** A TCP proxy that forwards each connection to `port` and, once the server starts to answer, drops the client. */
async function cutProxy(port: number): Promise<number> {
  const server = createTcpServer((socket: Socket) => {
    const upstream = tcpConnect(port, "127.0.0.1");
    socket.on("data", (chunk) => upstream.write(chunk));
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    // The server applied the request and answered; the answer is swallowed and the client's socket destroyed.
    upstream.on("data", () => socket.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("nothing is sent twice (QE3)", () => {
  test.each([...QDRANT_OPS])(
    "a lost answer to %s leaves exactly one request on the server, and reads as lost",
    async (op) => {
      const listener = await httpListener(ok);
      const connection = options(await cutProxy(listener.port));
      const client = connect(connection);
      const error = await failure(() => client.send(request(op), deadline()));
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).kind).toBe("network");
      await eventually(() => listener.seen.length === 1, "the request to reach the server");
      // Long enough for a resend to arrive, had one been made.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(listener.seen).toHaveLength(1);
      const worded = toProviderError(error, context(connection, op));
      expect(worded).toBeInstanceOf(ConnectionError);
      expect(worded.message).toContain("and the request was not sent again.");
    },
  );

  test("the next request after a lost answer opens a new connection and is sent once", async () => {
    const listener = await httpListener(ok);
    const client = connect(options(await cutProxy(listener.port)));
    await failure(() => client.send(request("get_collections"), deadline()));
    await failure(() => client.send(request("root"), deadline()));
    await eventually(() => listener.seen.length === 2, "both requests to reach the server");
    expect(listener.seen.map((seen) => seen.url)).toEqual(["/collections", "/"]);
  });
});

describe("answers and failures as a person reads them (QE13, QE15, QE20)", () => {
  test("a server that echoes the key in a 401, a 403, a 400, a 500 and a 503 gives no sentence holding it", async () => {
    for (const [status, type, wrap] of [
      [401, "text/plain", (key: string) => `Invalid API key or JWT: ${key}`],
      [403, "application/json", (key: string) => JSON.stringify({ status: { error: `Forbidden: ${key}` } })],
      [
        400,
        "application/json",
        (key: string) => JSON.stringify({ status: { error: `Bad request: Limit exceeded for ${key}` } }),
      ],
      [
        500,
        "application/json",
        (key: string) => JSON.stringify({ status: { error: `Service internal error: ${key}` } }),
      ],
      [503, "text/plain", (key: string) => `unavailable ${key}`],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one listener at a time.
      const listener = await httpListener((incoming, response) => {
        response.writeHead(status, { "content-type": type });
        response.end(wrap(String(incoming.headers["api-key"])));
      });
      const connection = options(listener.port);
      // oxlint-disable-next-line no-await-in-loop -- the listener's one request.
      const answer = await connect(connection).send(request("get_collections"), deadline());
      expect(answer.text).toContain(TEST_PASSWORD);
      const worded = toProviderError(answerFailure(answer), context(connection));
      expect({ status, message: worded.message.includes(WITHHELD) }).toEqual({ status, message: true });
      expect(worded.message).not.toContain(TEST_PASSWORD);
      expect(listener.seen).toHaveLength(1);
    }
  });

  test("a 429 with Retry-After names the wait, and the request is on the wire exactly once", async () => {
    const listener = await httpListener(
      jsonAnswer(429, '{"status":{"error":"Rate limiting exceeded: Read rate limit exceeded"},"time":0}', {
        "retry-after": "10",
      }),
    );
    const connection = options(listener.port);
    const answer = await connect(connection).send(request("count_points"), deadline());
    expect(answer.retryAfter).toBe("10");
    const worded = toProviderError(answerFailure(answer), context(connection, "count_points"));
    expect(worded).toBeInstanceOf(QueryError);
    expect(worded.message).toStartWith("Qdrant rate-limited the request; try again in 10 s. It was not sent again.");
    expect(listener.seen).toHaveLength(1);
  });

  test("a wrong key reads as refused, with the server's text", async () => {
    const listener = await httpListener((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid API key or JWT");
    });
    const connection = options(listener.port);
    const answer = await connect(connection).send(request("get_collections"), deadline());
    const worded = toProviderError(answerFailure(answer), context(connection));
    expect(worded).toBeInstanceOf(AuthenticationError);
    expect(worded.message).toBe("Qdrant refused the API key or JWT. (Qdrant: Invalid API key or JWT)");
  });

  test("an answer past the response cap is refused naming the cap, with the socket closed", async () => {
    const listener = await httpListener(streamingAnswer(2 * 1024 * 1024));
    const connection = { ...options(listener.port), responseCapBytes: 1024 * 1024 };
    const error = await failure(() => connect(connection).send(request("scroll_points"), deadline()));
    expect((error as TransportError).kind).toBe("too-large");
    const worded = toProviderError(error, context(connection, "scroll_points"));
    expect(worded).toBeInstanceOf(QueryError);
    expect(worded.message).toContain("larger than the 1 MiB Studio reads for one response");
    await eventually(() => listener.open() === 0, "the socket to close");
  });

  test("a deadline stops the wait and reads as a timeout; a cancel reads as a cancellation", async () => {
    const holding = await httpListener(() => {});
    const connection = options(holding.port);
    const client = connect(connection);
    const timedOut = await failure(() => client.send(request("query_points"), AbortSignal.timeout(100)));
    expect(toProviderError(timedOut, context(connection, "query_points"))).toBeInstanceOf(TimeoutError);
    const controller = new AbortController();
    const pending = failure(() => client.send(request("query_points"), controller.signal));
    setTimeout(() => controller.abort(), 50);
    expect(toProviderError(await pending, context(connection, "query_points"))).toBeInstanceOf(QueryCancelledError);
    await eventually(() => holding.open() === 0, "both sockets to close");
  });

  test("a request sent after close is refused, and reads as cancelled", async () => {
    const listener = await httpListener(ok);
    const connection = options(listener.port);
    const client = connect(connection);
    client.close();
    const error = await failure(() => client.send(request("get_collections"), deadline()));
    expect(toProviderError(error, context(connection))).toBeInstanceOf(QueryCancelledError);
    expect(listener.seen).toHaveLength(0);
  });
});

describe("TLS through the connection's SSL / TLS panel (QE6)", () => {
  const tls = (listener: Listener, overrides: Record<string, unknown>) => options(listener.port, overrides);
  const get = (connection: QdrantConnectionOptions) => connect(connection).send(request("get_collections"), deadline());

  test("localhost, verified against the pasted CA, carries the key over https", async () => {
    const listener = await httpsListener(certificates.local, ok);
    const answer = await get(
      tls(listener, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.ca } }),
    );
    expect(answer.status).toBe(200);
    expect(listener.seen[0].servername).toBe("localhost");
    expect(listener.seen[0].headers["api-key"]).toBe(TEST_PASSWORD);
  });

  test("an IP literal is checked against the certificate's IP SAN, with no SNI", async () => {
    const listener = await httpsListener(certificates.local, ok);
    const answer = await get(tls(listener, { ssl: { mode: "verify-ca", caCert: certificates.ca } }));
    expect(answer.status).toBe(200);
    expect(listener.seen[0].servername).toBe(false);
  });

  test("a CA that did not sign the certificate is refused, and nothing reaches the handler", async () => {
    const listener = await httpsListener(certificates.local, ok);
    const connection = tls(listener, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.rogueCa } });
    const error = await failure(() => get(connection));
    expect((error as TransportError).kind).toBe("tls");
    const worded = toProviderError(error, context(connection));
    expect(worded).toBeInstanceOf(ConnectionError);
    expect(worded.message).toContain("The TLS connection to Qdrant at localhost:");
    expect(listener.seen).toHaveLength(0);
  });

  test("a certificate for another name is refused", async () => {
    const listener = await httpsListener(certificates.farName, ok);
    const error = await failure(() =>
      get(tls(listener, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.ca } })),
    );
    expect((error as TransportError).kind).toBe("tls");
    expect(listener.seen).toHaveLength(0);
  });

  test("require encrypts without verifying, and is never a fallback for a verifying mode", async () => {
    const listener = await httpsListener(certificates.local, ok);
    expect((await get(tls(listener, { host: "localhost", ssl: { mode: "require" } }))).status).toBe(200);
    const error = await failure(() => get(tls(listener, { host: "localhost", ssl: { mode: "verify-full" } })));
    expect((error as TransportError).kind).toBe("tls");
    expect(listener.seen).toHaveLength(1);
  });

  test("two connections with different CAs in one process stay apart", async () => {
    const first = await httpsListener(certificates.local, ok);
    const second = await httpsListener(certificates.second, ok);
    expect(
      (await get(tls(first, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.ca } }))).status,
    ).toBe(200);
    expect(
      (await get(tls(second, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.secondCa } })))
        .status,
    ).toBe(200);
    const crossed = await failure(() =>
      get(tls(second, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.ca } })),
    );
    expect((crossed as TransportError).kind).toBe("tls");
  });

  test("a server that verifies the client's certificate accepts the panel's, and refuses a connection without one", async () => {
    const listener = await httpsListener({ ...certificates.local, clientCa: certificates.ca }, ok);
    const withCertificate = tls(listener, {
      host: "localhost",
      ssl: {
        mode: "verify-full",
        caCert: certificates.ca,
        clientCert: certificates.client.cert,
        clientKey: certificates.client.key,
      },
    });
    expect((await get(withCertificate)).status).toBe(200);
    const without = tls(listener, { host: "localhost", ssl: { mode: "verify-full", caCert: certificates.ca } });
    const error = await failure(() => get(without));
    expect(["tls", "network"]).toContain((error as TransportError).kind);
    expect(toProviderError(error, context(without))).toBeInstanceOf(ConnectionError);
    expect(listener.seen).toHaveLength(1);
  });

  test("through a tunnel the certificate is checked against the far end, by name and by address", async () => {
    for (const [pair, farHost, servername] of [
      [certificates.farName, "qdrant.test", "qdrant.test"],
      [certificates.farAddress, "10.0.0.5", false],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one listener at a time.
      const listener = await httpsListener(pair, ok);
      const connection = buildQdrantConnectionOptions(
        {
          id: "c1",
          name: "Qdrant",
          type: "qdrant",
          host: "127.0.0.1",
          port: listener.port,
          password: TEST_PASSWORD,
          ssl: { mode: "verify-full", caCert: certificates.ca },
          sshTunnel: { enabled: true },
          createdAt: new Date(0),
          [TUNNEL_FAR_END]: { host: farHost, port: 6333 },
        } as unknown as DatabaseConnection,
        { executionReadOnly: false, queryTimeout: 30_000 },
      );
      // oxlint-disable-next-line no-await-in-loop -- the listener's one request.
      expect((await get(connection)).status).toBe(200);
      expect(listener.seen[0].servername).toBe(servername);
      expect(connection.endpoint).toEqual({ host: farHost, port: 6333 });
    }
  });
});
