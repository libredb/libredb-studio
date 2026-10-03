/**
 * The live check of the Qdrant transport (vector-family spec 6.1, 6.2; QE1 to QE6, QE13 to QE15, QE20, QE30): the
 * real connection options, REST client, error table and version gates against the services of
 * docker/qdrant/README.md, one PASS or FAIL line per check, exit 1 on any FAIL.
 *
 *   T1  a tree-open's 25 requests arrive through a local forwarder on at most 4 connections, reused (QE2, R44 QM1)
 *   T2  proxy variables naming a counting listener carry nothing of the client's, and are live for the control (QE2)
 *   T3  TLS by name, by address, without verification, with a client certificate, and the refusals (QE6)
 *   T4  each credential reads as 6.2 says: accepted, refused, expired, wrongly signed, not allowed (QE4, QE20)
 *   T5  a lost answer leaves exactly one request on the wire for each of the 17 routes, and reads as lost (QE3)
 *   T6  a server timeout, a client deadline and a cancel each read as themselves (QE15, QE20)
 *   T7  GET / reads 1.19.1 and passes every gate (QE30)
 *   T8  the largest uint64 id is asked for and answered with its exact digits (QE14)
 *   T9  an answer past the response cap is refused naming the cap (QE13)
 *   T10 a dot-segment name is refused before the wire, and a pre-1.5 name reaches the server as one segment (QE1)
 *   T11 with DB_HTTP_BLOCK_PRIVATE_HOSTS on, a loopback literal and a name that resolves to loopback are refused (QE1)
 *
 * Run by hand, never by `bun run test`, with the proxy variables set before the runtime starts, because Node reads
 * NODE_USE_ENV_PROXY only then:
 *   P=http://127.0.0.1:18999; env HTTP_PROXY=$P HTTPS_PROXY=$P http_proxy=$P https_proxy=$P NODE_USE_ENV_PROXY=1 \
 *     bun tests/live/qdrant-transport-check.ts --keys <dir> --proxy-port 18999
 *   bun build tests/live/qdrant-transport-check.ts --target=node --outfile <file>, then the same with `node <file>`
 * <dir> is a copy of the keys volume outside the repository. The route table is read from
 * tests/fixtures/vector/routes/qdrant-v1.json, the file the provider's routes.ts is held equal to.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import {
  QDRANT_OPS,
  type QdrantClient,
  type QdrantOp,
  type QdrantRequest,
  type QdrantRouteTemplate,
  type QdrantRouteTemplates,
} from "@/lib/db/providers/vector/qdrant/client";
import {
  buildQdrantConnectionOptions,
  type QdrantConnectionOptions,
} from "@/lib/db/providers/vector/qdrant/connection-options";
import { answerFailure, expectOk, toProviderError } from "@/lib/db/providers/vector/qdrant/errors";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import {
  QDRANT_VERSION_GATES,
  type QdrantVersionGate,
  readQdrantVersion,
  versionGateRefusal,
} from "@/lib/db/providers/vector/qdrant/versions";
import { TUNNEL_FAR_END } from "@/lib/types";
import routeTable from "../fixtures/vector/routes/qdrant-v1.json";
import { JWT_CLAIMS, mintJwt, QDRANT_SERVICES, slowFilter } from "./qdrant-evidence-catalog";

const RUNTIME = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`;
/** Stand-ins, never realistic values: the key no server holds, and the secret the wrongly signed JWT is signed with. */
const TEST_PASSWORD = "password";
const TEST_PASSWORD_SECOND = "password-second";
const ROUTES = Object.fromEntries(
  routeTable.routes.map((route): [string, QdrantRouteTemplate] => [
    route.op,
    { method: route.method as "GET" | "POST", path: route.path, query: route.query },
  ]),
) as QdrantRouteTemplates;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let failures = 0;

function report(id: string, what: string, ok: boolean, seen: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${what} :: ${JSON.stringify(seen)}`);
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`${name} <value> is required`);
  return value;
}

const keysDir = argument("--keys");
const proxyPort = Number(argument("--proxy-port"));
const key = (file: string) => readFileSync(path.join(keysDir, file), "utf8").trim();

function options(overrides: Record<string, unknown>, queryTimeout = 30_000): QdrantConnectionOptions {
  return buildQdrantConnectionOptions(
    {
      id: "check",
      name: "check",
      type: "qdrant",
      createdAt: new Date(0),
      host: "127.0.0.1",
      port: QDRANT_SERVICES.qdrant.port,
      ...overrides,
    } as never,
    { executionReadOnly: false, queryTimeout },
  );
}

const request = (
  op: QdrantOp,
  params: Record<string, string> = {},
  body?: string,
  query: Record<string, string> = {},
): QdrantRequest => ({
  op,
  params,
  query,
  ...(body === undefined ? {} : { body }),
});

const deadline = (ms = 15_000) => AbortSignal.timeout(ms);

/** What the factory's SSH tunnel leaves of itself: the local forward as the host, and the far end beside it. */
const tunnelShape = (farHost: string) => ({
  host: "127.0.0.1",
  sshTunnel: { enabled: true },
  [TUNNEL_FAR_END]: { host: farHost, port: 6333 },
});

/** What a call ends as: its result text, or the name and sentence of the provider's error. */
async function outcome(
  connection: QdrantConnectionOptions,
  client: QdrantClient,
  sent: QdrantRequest,
  signal: AbortSignal = deadline(),
  phase: "connect" | "request" = "request",
): Promise<
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly name: string; readonly message: string }
> {
  const context = {
    phase,
    op: sent.op,
    endpoint: connection.endpoint,
    responseCapBytes: connection.responseCapBytes,
    timeoutMs: connection.callTimeoutMs,
    secretForms: connection.secretForms,
  };
  try {
    return { ok: true, text: expectOk(await client.send(sent, signal), context).text };
  } catch (error) {
    const worded = toProviderError(error, context);
    return { ok: false, name: worded.name, message: worded.message };
  }
}

/** A local forwarder to `port`: counts connections; with `cut`, swallows each answer and drops the client. */
async function forwarder(port: number, cut = false) {
  const open = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    const upstream = net.connect(port, "127.0.0.1");
    for (const end of [socket, upstream]) {
      open.add(end);
      end.on("error", () => undefined);
      end.on("close", () => open.delete(end));
    }
    socket.on("data", (chunk) => upstream.write(chunk));
    socket.on("close", () => upstream.destroy());
    upstream.on("data", (chunk) => {
      if (cut) socket.destroy();
      else socket.write(chunk);
    });
    upstream.on("close", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    accepted: () => accepted,
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}

async function main(): Promise<void> {
  console.log(`START ${RUNTIME}`);
  let proxied = 0;
  const proxy = net.createServer((socket) => {
    proxied++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));

  // T1
  {
    const relay = await forwarder(QDRANT_SERVICES.qdrant.port);
    const connection = options({ port: relay.port });
    const client = createRestQdrantClient(connection, ROUTES);
    const root = await outcome(connection, client, request("root"));
    const listed = await outcome(connection, client, request("get_collections"));
    const names = listed.ok
      ? (JSON.parse(listed.text) as { result: { collections: { name: string }[] } }).result.collections.map(
          (entry) => entry.name,
        )
      : [];
    const described = await Promise.all(
      [...names, ...names, ...names]
        .slice(0, 20)
        .map((name) => outcome(connection, client, request("get_collection", { collection_name: name }))),
    );
    const rest = [
      await outcome(
        connection,
        client,
        request("scroll_points", { collection_name: "docs" }, '{"limit":100,"with_payload":true}'),
      ),
      await outcome(
        connection,
        client,
        request("query_points", { collection_name: "plain" }, '{"query":[0.1,0.2,0.3,0.4],"limit":10}'),
      ),
      await outcome(connection, client, request("count_points", { collection_name: "docs" }, '{"exact":true}')),
    ];
    client.close();
    relay.close();
    const all = [root, listed, ...described, ...rest];
    report(
      "T1",
      "25 requests through a forwarder on at most 4 connections",
      all.length === 25 && all.every((one) => one.ok) && relay.accepted() >= 1 && relay.accepted() <= 4,
      {
        requests: all.length,
        connections: relay.accepted(),
      },
    );
  }

  // T2
  {
    const before = proxied;
    const connection = options({});
    const client = createRestQdrantClient(connection, ROUTES);
    const listed = await outcome(connection, client, request("get_collections"));
    client.close();
    const tlsConnection = options({
      host: "localhost",
      port: QDRANT_SERVICES["qdrant-tls"].port,
      ssl: { mode: "verify-full", caCert: key("ca.pem") },
    });
    const tlsClient = createRestQdrantClient(tlsConnection, ROUTES);
    const secure = await outcome(tlsConnection, tlsClient, request("root"));
    tlsClient.close();
    const duringClient = proxied - before;
    // The control: one request through the runtime's global agent, which the variables must catch.
    await new Promise<void>((resolve) => {
      const control = http.get(`http://127.0.0.1:${QDRANT_SERVICES.qdrant.port}/`, (response) => {
        response.resume();
        response.on("end", resolve);
      });
      control.setTimeout(2000, () => control.destroy());
      control.on("error", () => resolve());
      control.on("close", () => resolve());
    });
    await sleep(200);
    report(
      "T2",
      "proxy variables carry nothing of the client's, and are live for the control",
      listed.ok && secure.ok && duringClient === 0 && proxied - before >= 1,
      {
        duringClient,
        withControl: proxied - before,
      },
    );
  }

  // T3
  {
    const ca = key("ca.pem");
    const tlsPort = QDRANT_SERVICES["qdrant-tls"].port;
    const mtlsPort = QDRANT_SERVICES["qdrant-mtls"].port;
    const client = { clientCert: key("client.pem"), clientKey: key("client.key") };
    const accepted: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["by name", { host: "localhost", port: tlsPort, ssl: { mode: "verify-full", caCert: ca } }],
      [
        "by address, checked against the IP SAN",
        { host: "127.0.0.1", port: tlsPort, ssl: { mode: "verify-full", caCert: ca } },
      ],
      ["without verification (require)", { host: "localhost", port: tlsPort, ssl: { mode: "require" } }],
      [
        "with a client certificate",
        { host: "localhost", port: mtlsPort, ssl: { mode: "verify-full", caCert: ca, ...client } },
      ],
      // A tunnel-shaped connection: the local forward is dialled, and the certificate is checked against the far end.
      [
        "through a tunnel shape, by the far end's name",
        { ...tunnelShape("qdrant-tls"), port: tlsPort, ssl: { mode: "verify-full", caCert: ca } },
      ],
    ];
    for (const [what, overrides] of accepted) {
      const connection = options({
        ...overrides,
        password: key(overrides.port === mtlsPort ? "mtls/admin.key" : "tls/admin.key"),
      });
      const qdrant = createRestQdrantClient(connection, ROUTES);
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time.
      const listed = await outcome(connection, qdrant, request("get_collections"));
      qdrant.close();
      report("T3", `TLS ${what} lists collections with the admin key`, listed.ok, listed.ok ? "ok" : listed);
    }
    const refused: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["with no CA for a private certificate", { host: "localhost", port: tlsPort, ssl: { mode: "verify-full" } }],
      [
        "through a tunnel shape whose far end the certificate does not name",
        { ...tunnelShape("other.example"), port: tlsPort, ssl: { mode: "verify-full", caCert: ca } },
      ],
      [
        "with no client certificate where the server verifies one",
        { host: "localhost", port: mtlsPort, ssl: { mode: "verify-full", caCert: ca } },
      ],
      ["as plain HTTP to the TLS port", { host: "127.0.0.1", port: tlsPort }],
    ];
    for (const [what, overrides] of refused) {
      const connection = options(overrides);
      const qdrant = createRestQdrantClient(connection, ROUTES);
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time.
      const root = await outcome(connection, qdrant, request("root"));
      qdrant.close();
      report(
        "T3",
        `TLS ${what} is a connection error`,
        !root.ok && root.name === "ConnectionError",
        root.ok ? "answered" : root,
      );
    }
  }

  // T4
  {
    const admin = key("auth/admin.key");
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const jwt = (name: keyof typeof JWT_CLAIMS, secret = admin) =>
      mintJwt({ exp: expires, ...JWT_CLAIMS[name] }, secret);
    const port = QDRANT_SERVICES["qdrant-auth"].port;
    const cases: ReadonlyArray<readonly [string, string | undefined, string, string]> = [
      ["the admin key", admin, "ok", ""],
      ["the read-only key", key("auth/read-only.key"), "ok", ""],
      ["a global read JWT", jwt("jwt-global-read"), "ok", ""],
      ["an alias-only JWT, which lists nothing", jwt("jwt-alias-only"), "ok", ""],
      [
        "no key",
        undefined,
        "AuthenticationError",
        "Qdrant refused the API key or JWT. (Qdrant: Must provide an API key or an Authorization bearer token)",
      ],
      [
        "a wrong key",
        TEST_PASSWORD,
        "AuthenticationError",
        "Qdrant refused the API key or JWT. (Qdrant: Invalid API key or JWT)",
      ],
      ["an expired JWT", jwt("jwt-expired"), "AuthenticationError", "The JWT has expired."],
      [
        "a wrongly signed JWT",
        jwt("jwt-bad-signature", TEST_PASSWORD_SECOND),
        "AuthenticationError",
        "The JWT's signature does not match this server's key.",
      ],
    ];
    for (const [what, password, name, message] of cases) {
      const connection = options({ port, ...(password === undefined ? {} : { password }) });
      const qdrant = createRestQdrantClient(connection, ROUTES);
      // The provider's connect is these two requests: the version, then the authenticated read.
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time.
      const root = await outcome(connection, qdrant, request("root"), deadline(), "connect");
      // oxlint-disable-next-line no-await-in-loop -- the second request of connect.
      const listed = await outcome(connection, qdrant, request("get_collections"), deadline(), "connect");
      qdrant.close();
      const good =
        root.ok && (name === "ok" ? listed.ok : !listed.ok && listed.name === name && listed.message === message);
      report("T4", `${what}: / answers, and /collections reads as ${name}`, good, listed.ok ? "ok" : listed);
    }
    const scoped = options({ port, password: jwt("jwt-scoped") });
    const qdrant = createRestQdrantClient(scoped, ROUTES);
    const plain = await outcome(scoped, qdrant, request("get_collection", { collection_name: "plain" }));
    qdrant.close();
    report(
      "T4",
      "a scoped JWT is not allowed a collection outside its grant",
      !plain.ok &&
        plain.name === "QueryError" &&
        plain.message ===
          "The credential is not allowed to run this request. (Qdrant: Forbidden: Access to collection plain is required)",
      plain,
    );
  }

  // T5
  {
    const sample: Readonly<Record<string, string>> = { collection_name: "plain", id: "1" };
    const lost: string[] = [];
    for (const op of QDRANT_OPS) {
      // oxlint-disable-next-line no-await-in-loop -- one cut connection at a time.
      const relay = await forwarder(QDRANT_SERVICES.qdrant.port, true);
      const connection = options({ port: relay.port });
      const qdrant = createRestQdrantClient(connection, ROUTES);
      const names = [...ROUTES[op].path.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
      const sent = request(
        op,
        Object.fromEntries(names.map((name) => [name, sample[name]])),
        ROUTES[op].method === "POST" ? "{}" : undefined,
      );
      // oxlint-disable-next-line no-await-in-loop -- the connection's one request.
      const ended = await outcome(connection, qdrant, sent);
      // oxlint-disable-next-line no-await-in-loop -- long enough for a resend to arrive, had one been made.
      await sleep(150);
      qdrant.close();
      relay.close();
      if (
        ended.ok ||
        ended.name !== "ConnectionError" ||
        !ended.message.includes("was not sent again") ||
        relay.accepted() !== 1
      ) {
        lost.push(`${op}: ${JSON.stringify(ended)} over ${relay.accepted()} connections`);
      }
    }
    report("T5", "a lost answer leaves one request on the wire for each of the 17 routes", lost.length === 0, lost);
  }

  // T6
  {
    const connection = options({});
    const qdrant = createRestQdrantClient(connection, ROUTES);
    const slow = `{"filter":${slowFilter(400, "sku")},"limit":1,"with_payload":false}`;
    const scroll = (query: Record<string, string>) =>
      request("scroll_points", { collection_name: "payload_spread" }, slow, query);
    const server = await outcome(connection, qdrant, scroll({ timeout: "1" }));
    report(
      "T6",
      "a server timeout reads as the timeout, without the server's figure",
      !server.ok &&
        server.name === "TimeoutError" &&
        server.message === "Qdrant stopped the request at its time limit.",
      server,
    );
    await sleep(2000);
    const started = Date.now();
    const local = await outcome(connection, qdrant, scroll({ timeout: "2" }), AbortSignal.timeout(300));
    report(
      "T6",
      "a client deadline reads as a timeout within its limit",
      !local.ok && local.name === "TimeoutError" && Date.now() - started < 1300,
      { local, ms: Date.now() - started },
    );
    await sleep(3000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const cancelled = await outcome(connection, qdrant, scroll({ timeout: "2" }), controller.signal);
    report(
      "T6",
      "a cancel reads as a cancellation",
      !cancelled.ok && cancelled.name === "QueryCancelledError",
      cancelled,
    );
    await sleep(3000);
    const after = await outcome(connection, qdrant, request("get_collections"));
    qdrant.close();
    report(
      "T6",
      "the connection serves the next request after a timeout and a cancel",
      after.ok,
      after.ok ? "ok" : after,
    );
  }

  // T7
  {
    const connection = options({});
    const qdrant = createRestQdrantClient(connection, ROUTES);
    const root = await outcome(connection, qdrant, request("root"), deadline(), "connect");
    qdrant.close();
    const version = readQdrantVersion(root.ok ? root.text : "");
    const refusals = (Object.keys(QDRANT_VERSION_GATES) as QdrantVersionGate[]).filter(
      (gate) => versionGateRefusal(gate, version) !== undefined,
    );
    report("T7", "GET / reads 1.19.1 and passes every gate", version.reported === "1.19.1" && refusals.length === 0, {
      version,
      refusals,
    });
  }

  // T8
  {
    const connection = options({});
    const qdrant = createRestQdrantClient(connection, ROUTES);
    const point = await outcome(
      connection,
      qdrant,
      request("get_point", { collection_name: "docs", id: "18446744073709551615" }),
    );
    const many = await outcome(
      connection,
      qdrant,
      request(
        "get_points",
        { collection_name: "docs" },
        '{"ids":[9007199254740993,9223372036854775808,18446744073709551615]}',
      ),
    );
    qdrant.close();
    report(
      "T8",
      "ids above 2^53 are asked for and answered with their exact digits",
      point.ok &&
        point.text.includes('"id":18446744073709551615') &&
        many.ok &&
        ["9007199254740993", "9223372036854775808", "18446744073709551615"].every((id) =>
          many.text.includes(`"id":${id}`),
        ),
      point.ok ? "ok" : point,
    );
  }

  // T9
  {
    const body = '{"limit":300,"with_payload":true,"with_vector":true}';
    const whole = options({});
    const qdrant = createRestQdrantClient(whole, ROUTES);
    const read = await outcome(whole, qdrant, request("scroll_points", { collection_name: "docs" }, body));
    qdrant.close();
    const capped = { ...options({}), responseCapBytes: 65_536 };
    const small = createRestQdrantClient(capped, ROUTES);
    const refused = await outcome(capped, small, request("scroll_points", { collection_name: "docs" }, body));
    small.close();
    report(
      "T9",
      "an answer under the cap is read whole, and one past a 64 KiB cap is refused naming it",
      read.ok &&
        read.text.length > 65_536 &&
        !refused.ok &&
        refused.name === "QueryError" &&
        refused.message.includes("larger than the 64 KiB Studio reads for one response"),
      { bytes: read.ok ? read.text.length : read, refused },
    );
  }

  // T10
  {
    const relay = await forwarder(QDRANT_SERVICES.qdrant.port);
    const connection = options({ port: relay.port });
    const qdrant = createRestQdrantClient(connection, ROUTES);
    const dots = await outcome(connection, qdrant, request("get_collection", { collection_name: ".." }));
    const before = relay.accepted();
    const legacy = await outcome(connection, qdrant, request("get_collection", { collection_name: "a:b" }));
    const encoded = await outcome(connection, qdrant, request("get_collection", { collection_name: "%2e%2e" }));
    qdrant.close();
    relay.close();
    const missing = "The collection does not exist or is not visible to this credential.";
    report(
      "T10",
      "`..` is refused before the wire; `a:b` and `%2e%2e` reach the server as collection names",
      !dots.ok &&
        dots.name === "QueryError" &&
        before === 0 &&
        !legacy.ok &&
        legacy.message === missing &&
        !encoded.ok &&
        encoded.message === missing,
      { dots, before, legacy, encoded },
    );
  }

  // T11
  {
    const relay = await forwarder(QDRANT_SERVICES.qdrant.port);
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
    let literal: unknown;
    try {
      options({ port: relay.port });
    } catch (error) {
      literal = error;
    }
    const connection = options({ host: "localhost", port: relay.port });
    const qdrant = createRestQdrantClient(connection, ROUTES);
    const named = await outcome(connection, qdrant, request("get_collections"));
    qdrant.close();
    delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
    relay.close();
    report(
      "T11",
      "with the egress guard on, a loopback literal and a name resolving to loopback are refused with no connection",
      literal instanceof DatabaseConfigError &&
        !named.ok &&
        named.name === "DatabaseConfigError" &&
        named.message.includes("blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS") &&
        relay.accepted() === 0,
      { literal: (literal as Error | undefined)?.message, named, connections: relay.accepted() },
    );
  }

  proxy.close();
  // The classes are named so a bundler keeps them: each PASS line above compares an error's name with one of these.
  void [AuthenticationError, ConnectionError, QueryCancelledError, QueryError, TimeoutError, answerFailure];
  console.log(`END ${RUNTIME} failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(2);
});
