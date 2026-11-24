/**
 * The HTTP origins take the egress decision their provider was built with (FND-2 slices 2b-3a and 2b-3b,
 * docs/SECURITY.md row 0.6).
 *
 * MTConnect, Qdrant, Weaviate, S3-compatible object storage, RabbitMQ's management API, Databend, InfluxDB, InfluxDB 3,
 * Kubernetes and Firestore's emulator each build their origin through `httpOrigin` in `src/lib/db/http/endpoint.ts`,
 * which checks an address literal against the decision it is handed and reads no setting. Each provider here is built
 * directly, as a test or a live script builds it outside Studio's factory, with a decision the test hands it, and
 * connects to a local HTTP server on 127.0.0.1 that counts the connections it accepts and the requests it receives.
 * The variable is left unset, so a refusal shows the handed decision decided. The accepted connections are the count
 * that matters for Kubernetes: over TLS it opens a socket to a plain HTTP server and never sends a request.
 *
 * Each of the ten also builds its node transport with the same decision (FND-2 slice 2b-4): handed a blocking decision
 * and connected to `localhost`, a name `httpOrigin` lets through, it is refused by the node transport's lookup before
 * any connection; handed an allowing decision while the variable is `true`, it reaches 127.0.0.1. BigQuery's API
 * transport, built under BIGQUERY_EMULATOR_HOST, is held the same way here, since its own unit test replaces the node
 * transport module. The fetch kind's inverse is in `egress-policy-providers.test.ts`, and RabbitMQ's management
 * origin's in `egress-policy-socket-dials.test.ts`, over a recorded management API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST, EGRESS_DECISION_MISSING } from "@/lib/db/http/egress-policy";
import { createBigQueryTransport } from "@/lib/db/providers/sql/bigquery/transport";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore/index";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { DatabendProvider } from "@/lib/db/providers/sql/databend/index";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { InfluxDB3Provider, InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/index";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { WeaviateProvider } from "@/lib/db/providers/vector/weaviate/index";
import type { DatabaseConnection, DatabaseProvider, EgressDecision } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;

/** A local HTTP server on 127.0.0.1 that counts the connections it accepts and the requests it receives. */
interface CountingServer {
  readonly port: number;
  connections(): number;
  hits(): number;
  close(): Promise<void>;
}

const servers: CountingServer[] = [];

afterEach(async () => {
  setEgressFlag(original);
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function countingServer(): Promise<CountingServer> {
  let connections = 0;
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.statusCode = 500;
    response.end("unexpected request");
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const counting: CountingServer = {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(counting);
  return counting;
}

/** The build context a case hands: a decision, or none at all. */
type Context = { readonly egress?: EgressDecision };

type Build = (host: string, port: number, context: Context) => DatabaseProvider;

/**
 * A short deadline, so a case whose refusal regressed fails inside the test's time budget instead of waiting out the
 * default one.
 */
const OPTIONS = { queryTimeout: 1500 };

function connection(type: DatabaseConnection["type"], host: string, port: number): DatabaseConnection {
  return { id: `origin-${type}`, name: `origin ${type}`, type, host, port, createdAt: new Date() };
}

const BUILDS: readonly [string, Build][] = [
  ["MTConnect", (host, port, context) => new MTConnectProvider(connection("mtconnect", host, port), OPTIONS, context)],
  ["Qdrant", (host, port, context) => new QdrantProvider(connection("qdrant", host, port), OPTIONS, context)],
  ["Weaviate", (host, port, context) => new WeaviateProvider(connection("weaviate", host, port), OPTIONS, context)],
  [
    "S3-compatible object storage",
    // A pinned bucket, so connect() makes one request; no key pair, so the half-pair refusal does not fire first.
    (host, port, context) => new S3Provider({ ...connection("s3", host, port), database: "test" }, OPTIONS, context),
  ],
  [
    "RabbitMQ",
    // The default management transport, a real node transport: "no request" is the server's own count.
    (host, port, context) =>
      new RabbitMQProvider(rabbitmqConnection({ host, port, password: crypto.randomUUID() }), OPTIONS, context),
  ],
  [
    "Databend",
    // A user and no password, so neither the missing-user refusal nor the plaintext-password refusal fires first.
    (host, port, context) =>
      new DatabendProvider({ ...connection("databend", host, port), user: "tester" }, OPTIONS, context),
  ],
  // Neither user nor password: InfluxDB 3 refuses a user, InfluxDB a user without a password.
  ["InfluxDB", (host, port, context) => new InfluxDBProvider(connection("influxdb", host, port), OPTIONS, context)],
  ["InfluxDB 3", (host, port, context) => new InfluxDB3Provider(connection("influxdb3", host, port), OPTIONS, context)],
  [
    "Kubernetes",
    // Over TLS, so its own refusal of plain HTTP to a loopback host never comes first.
    (host, port, context) =>
      new KubernetesProvider(
        { ...connection("kubernetes", host, port), ssl: { mode: "verify-full" } },
        OPTIONS,
        {},
        context,
      ),
  ],
  [
    "Firestore's emulator",
    // The emulator address comes through the seams' env, never process.env; an emulator connection carries no
    // credential, and the project id is a valid one.
    (host, port, context) =>
      new FirestoreProvider({ ...connection("firestore", host, port), database: "demo-project" }, OPTIONS, context, {
        env: { FIRESTORE_EMULATOR_HOST: `${host}:${port}` },
      }),
  ],
];

/** Runs `connect()` and disconnects, resolving to the error `connect()` rejected with, or null when it succeeded. */
async function connected(provider: DatabaseProvider): Promise<unknown> {
  const outcome = await provider.connect().then(
    () => null,
    (error: unknown) => error,
  );
  await provider.disconnect();
  return outcome;
}

describe("a provider builds its origin by the egress decision it was built with (FND-2 slices 2b-3a and 2b-3b)", () => {
  test.each(BUILDS)(
    "%s handed a blocking decision refuses 127.0.0.1 when connect() builds its origin, before any request, while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset",
    async (_name, build) => {
      setEgressFlag(undefined);
      const server = await countingServer();
      const failure = await connected(build("127.0.0.1", server.port, { egress: BLOCKS_PRIVATE_HOSTS }));
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(server.connections()).toBe(0);
      expect(server.hits()).toBe(0);
    },
  );

  test.each(BUILDS)(
    "%s built without an egress decision is built, and refuses to connect by name before any request",
    async (_name, build) => {
      setEgressFlag(undefined);
      const server = await countingServer();
      const provider = build("127.0.0.1", server.port, {});
      expect(provider.getCapabilities().defaultPort).not.toBeUndefined();
      const failure = await connected(provider);
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
      expect(server.connections()).toBe(0);
      expect(server.hits()).toBe(0);
    },
  );
});

describe("a provider builds its node transport by the egress decision it was built with (FND-2 slice 2b-4)", () => {
  test.each(BUILDS)(
    "%s handed a blocking decision refuses localhost at its node transport's lookup, before any connection, while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset",
    async (_name, build) => {
      setEgressFlag(undefined);
      const server = await countingServer();
      const failure = await connected(build("localhost", server.port, { egress: BLOCKS_PRIVATE_HOSTS }));
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(server.connections()).toBe(0);
    },
  );

  test.each(BUILDS)(
    "%s handed an allowing decision reaches 127.0.0.1 while DB_HTTP_BLOCK_PRIVATE_HOSTS is true",
    async (_name, build) => {
      setEgressFlag("true");
      const server = await countingServer();
      const failure = await connected(build("127.0.0.1", server.port, { egress: ALLOWS_PRIVATE_HOSTS }));
      // The engine's own error against a server that answers 500, or Kubernetes' TLS failure against a plain one.
      expect((failure as Error | null)?.message).not.toBe(BLOCKED_HOST);
      expect(server.connections()).toBeGreaterThan(0);
    },
  );

  test("BigQuery's API transport under BIGQUERY_EMULATOR_HOST naming localhost, handed a blocking decision, refuses at the lookup before any connection while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset", async () => {
    setEgressFlag(undefined);
    const server = await countingServer();
    const bigquery = createBigQueryTransport(
      "demo-project",
      { type: "access_token", token: crypto.randomUUID() },
      BLOCKS_PRIVATE_HOSTS,
      { BIGQUERY_EMULATOR_HOST: `localhost:${server.port}` },
    );
    const failure = await bigquery.listDatasets(AbortSignal.timeout(5000)).then(
      () => null,
      (error: unknown) => error,
    );
    bigquery.close();
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toBe(BLOCKED_HOST);
    expect(server.connections()).toBe(0);
  });
});
