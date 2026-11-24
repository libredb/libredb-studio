/**
 * Every guarded provider the factory builds with a context is handed the egress decision core took (FND-2 slice 2b,
 * docs/SECURITY.md row 0.6), never a caller's.
 *
 * Core reads DB_HTTP_BLOCK_PRIVATE_HOSTS once per process (`src/lib/db/egress-decision.ts`), and
 * `createDatabaseProvider`, the function the routes, the agent, MCP, the VS Code backend and an embedder of
 * `@libredb/studio/providers` call, hands that decision to every provider that takes a context; the provider hands it
 * to the guard as an argument. This census builds each engine whose guard calls take the decision through the real
 * factory, from `tests/helpers/census-connection.ts`, and finds the very decision object the process keeps inside the
 * provider, by identity. Building connects nothing. The cases that connect go through the same factory and show the
 * composed path refuses a private destination before anything is sent.
 *
 * The list of engines is a test-side list: it holds every engine whose connections pass the shared egress guard, and a
 * new provider that passes it joins it (docs/ADDING_A_PROVIDER.md, "Step 3: Register in the Factory"). Since FND-2 slice
 * 2b-4 the node transports take the decision too, so the composed cases cover the fetch (ClickHouse), the socket dial
 * (MQTT), the name lookup (SNMP) and the node transport (Qdrant).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket as TcpSocket } from "node:net";
import { egressDecision } from "@/lib/db/egress-decision";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { BLOCKED_HOST, LINK_LOCAL_HOST } from "@/lib/db/http/egress-policy";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { FIXTURE_COMMUNITY } from "../fixtures/snmp/identity";
import { CENSUS_CONNECTION } from "../helpers/census-connection";
import { ALLOWS_PRIVATE_HOSTS } from "../helpers/egress-decisions";
import { setEgressFlag } from "../helpers/egress-flag";
import { pathsToObject } from "../helpers/reachable-markers";

/** The engines whose guard calls take the decision as an argument since slices 2b-1, 2b-2, 2b-3a, 2b-3b and 2b-4. */
const GUARDED_ENGINES: readonly DatabaseType[] = [
  "clickhouse",
  "druid",
  "trino",
  "libsql",
  "elasticsearch",
  "opensearch",
  "couchbase",
  "prometheus",
  "snmp",
  "mqtt",
  "sparkplug",
  "netconf",
  "modbus",
  "rabbitmq",
  "mtconnect",
  "qdrant",
  "weaviate",
  "s3",
  "databend",
  "bigquery",
  "snowflake",
  "influxdb",
  "influxdb3",
  "kubernetes",
  "firestore",
];

const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
const originalEmulator = process.env.FIRESTORE_EMULATOR_HOST;

afterEach(() => {
  setEgressFlag(original);
  if (originalEmulator === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
  else process.env.FIRESTORE_EMULATOR_HOST = originalEmulator;
});

describe("a guarded provider is built with the egress decision core took (FND-2 slice 2b)", () => {
  test.each(GUARDED_ENGINES)(
    "%s built by createDatabaseProvider holds the decision the process took, with DB_HTTP_BLOCK_PRIVATE_HOSTS unset",
    async (type) => {
      setEgressFlag(undefined);
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const decision = egressDecision();
      expect(decision.blocksPrivateHosts).toBe(false);
      expect(pathsToObject(provider, decision)).not.toEqual([]);
    },
  );

  test.each(GUARDED_ENGINES)(
    "%s built by createDatabaseProvider holds the decision the process took, with DB_HTTP_BLOCK_PRIVATE_HOSTS set to true",
    async (type) => {
      setEgressFlag("true");
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const decision = egressDecision();
      expect(decision.blocksPrivateHosts).toBe(true);
      expect(pathsToObject(provider, decision)).not.toEqual([]);
    },
  );

  /**
   * An execution context that carries an allowing `egress`, as plain JavaScript or a value typed through a variable can
   * pass it: the type has no such field, so only the excess-property check of a literal would catch it.
   */
  const callerContext = { readOnly: false, egress: ALLOWS_PRIVATE_HOSTS } as ProviderExecutionContext;

  test.each(GUARDED_ENGINES)(
    "%s built by createDatabaseProvider with a caller's allowing egress holds core's blocking decision, never the caller's",
    async (type) => {
      setEgressFlag("true");
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type], {}, callerContext);
      const decision = egressDecision();
      expect(decision.blocksPrivateHosts).toBe(true);
      expect(pathsToObject(provider, decision)).not.toEqual([]);
      expect(pathsToObject(provider, ALLOWS_PRIVATE_HOSTS)).toEqual([]);
    },
  );

  test("a ClickHouse connection to localhost built with a caller's allowing egress is refused, with DB_HTTP_BLOCK_PRIVATE_HOSTS true, and sends nothing", async () => {
    setEgressFlag("true");
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const connection: DatabaseConnection = {
        id: "egress-census-clickhouse-caller",
        name: "egress census clickhouse caller",
        type: "clickhouse",
        host: "localhost",
        port: (server.address() as AddressInfo).port,
        createdAt: new Date(),
      };
      const failure = await createDatabaseProvider(connection, {}, callerContext)
        .then((provider) => provider.connect())
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("a ClickHouse connection built by createDatabaseProvider with DB_HTTP_BLOCK_PRIVATE_HOSTS true is refused at 127.0.0.1 and sends nothing", async () => {
    setEgressFlag("true");
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const connection: DatabaseConnection = {
        id: "egress-census-clickhouse",
        name: "egress census clickhouse",
        type: "clickhouse",
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        createdAt: new Date(),
      };
      const failure = await createDatabaseProvider(connection)
        .then((provider) => provider.connect())
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("an MQTT connection built by createDatabaseProvider with DB_HTTP_BLOCK_PRIVATE_HOSTS true is refused at 127.0.0.1 and the listener accepts nothing", async () => {
    setEgressFlag("true");
    let accepted = 0;
    const sockets: TcpSocket[] = [];
    const listener = createTcpServer((socket) => {
      accepted += 1;
      sockets.push(socket);
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const connection: DatabaseConnection = {
        id: "egress-census-mqtt",
        name: "egress census mqtt",
        type: "mqtt",
        host: "127.0.0.1",
        port: (listener.address() as AddressInfo).port,
        createdAt: new Date(),
      };
      const failure = await createDatabaseProvider(connection)
        .then((provider) => provider.connect())
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(accepted).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("an SNMP connection built by createDatabaseProvider with DB_HTTP_BLOCK_PRIVATE_HOSTS true is refused at 127.0.0.1 and sends no datagram", async () => {
    setEgressFlag("true");
    let received = 0;
    const agent: Socket = createSocket("udp4");
    agent.on("message", () => {
      received += 1;
    });
    await new Promise<void>((resolve) => agent.bind(0, "127.0.0.1", () => resolve()));
    try {
      const connection = {
        id: "egress-census-snmp",
        name: "egress census snmp",
        type: "snmp",
        host: "127.0.0.1",
        port: (agent.address() as AddressInfo).port,
        password: FIXTURE_COMMUNITY,
        createdAt: new Date(),
      } as DatabaseConnection;
      const failure = await createDatabaseProvider(connection)
        .then((provider) => provider.connect())
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(received).toBe(0);
    } finally {
      agent.close();
    }
  });

  test("a Qdrant connection to localhost built by createDatabaseProvider with DB_HTTP_BLOCK_PRIVATE_HOSTS true is refused at its node transport's lookup and the listener accepts no connection", async () => {
    setEgressFlag("true");
    let accepted = 0;
    const server: Server = createServer((_request, response) => {
      response.end("unexpected request");
    });
    server.on("connection", () => {
      accepted += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      // `localhost` is a name, which the origin lets through, so the refusal is the node transport's lookup.
      const connection: DatabaseConnection = {
        id: "egress-census-qdrant",
        name: "egress census qdrant",
        type: "qdrant",
        host: "localhost",
        port: (server.address() as AddressInfo).port,
        createdAt: new Date(),
      };
      const provider = await createDatabaseProvider(connection);
      const failure = await provider.connect().then(
        () => null,
        (error: unknown) => error,
      );
      await provider.disconnect();
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(accepted).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

/**
 * A local HTTP server on 127.0.0.1 that counts the requests it receives, with a twin on ::1 at the same port counting
 * into the same record, so a request to the name localhost reaches it whichever family the name resolves to first.
 */
async function countingServer(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const handler = (_request: unknown, response: { end: (body: string) => void }) => {
    hits += 1;
    response.end("unexpected request");
  };
  const listen = (server: Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  const close = (server: Server) =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  for (let attempt = 1; ; attempt += 1) {
    const v4 = createServer(handler);
    // oxlint-disable-next-line no-await-in-loop -- each attempt needs the previous one's port to be closed or kept
    const port = await listen(v4, 0, "127.0.0.1");
    const v6 = createServer(handler);
    // oxlint-disable-next-line no-await-in-loop -- the twin takes the port the line above was given
    const refused = await listen(v6, port, "::1").then(
      () => null,
      (error: NodeJS.ErrnoException) => error,
    );
    if (refused === null) {
      return { port, hits: () => hits, close: () => Promise.all([close(v4), close(v6)]).then(() => undefined) };
    }
    // oxlint-disable-next-line no-await-in-loop -- the next attempt starts after this port is released
    await close(v4);
    if (refused.code !== "EADDRINUSE" || attempt === 10) throw refused;
  }
}

/** Builds `type` at `host` through the factory and connects, resolving to the error connect() rejected with, or null. */
async function factoryConnect(type: DatabaseType, host: string, port: number): Promise<unknown> {
  const connection: DatabaseConnection = {
    id: `egress-n4-${type}`,
    name: `egress n4 ${type}`,
    type,
    host,
    port,
    // A short deadline, so a refusal that regressed fails inside the test's time budget instead of waiting out the
    // default one.
    queryTimeout: 1500,
    createdAt: new Date(),
    // Kubernetes over TLS, so its own refusal of plain HTTP to a loopback host never comes first and no
    // KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT is written; MTConnect over TLS too, so each engine has one connection shape.
    ...(type === "kubernetes" || type === "mtconnect" ? { ssl: { mode: "verify-full" as const } } : {}),
    // Databend with a user and Firestore with a valid project id, so the guard is the first refusal on both.
    ...(type === "databend" ? { user: "tester" } : {}),
    ...(type === "firestore" ? { database: "demo-project" } : {}),
  };
  return createDatabaseProvider(connection)
    .then((provider) => provider.connect())
    .then(
      () => null,
      (error: unknown) => error,
    );
}

/** The engines whose provider docs say how an address is refused (their "Where the connection may connect" subsection). */
const N4_ENGINES: readonly DatabaseType[] = ["mtconnect", "influxdb", "influxdb3", "kubernetes", "weaviate"];

describe("what the provider docs of MTConnect, InfluxDB, InfluxDB 3, Kubernetes and Weaviate say about egress (FND-2 slice 2b-3a)", () => {
  test.each(N4_ENGINES.flatMap((type) => ["127.0.0.1", "localhost"].map((host) => [type, host] as const)))(
    "%s built by createDatabaseProvider with DB_HTTP_BLOCK_PRIVATE_HOSTS true refuses %s before any request with the guard's sentence",
    async (type, host) => {
      setEgressFlag("true");
      const server = await countingServer();
      try {
        const failure = await factoryConnect(type, host, server.port);
        expect(failure).toBeInstanceOf(DatabaseConfigError);
        expect((failure as Error).message).toBe(BLOCKED_HOST);
        expect(server.hits()).toBe(0);
      } finally {
        await server.close();
      }
    },
  );

  // Unset, the link-local rule refuses with its own sentence; true, the blocking decision refuses first with the guard's.
  test.each(
    (["mtconnect", "kubernetes"] as const).flatMap((type) =>
      ["169.254.169.254", "[fe80::1]", "[fd00:ec2::254]"].flatMap((host) => [
        [type, host, "unset", undefined, LINK_LOCAL_HOST] as const,
        [type, host, "true", "true", BLOCKED_HOST] as const,
      ]),
    ),
  )(
    "%s built by createDatabaseProvider never reaches the link-local literal %s with DB_HTTP_BLOCK_PRIVATE_HOSTS %s",
    async (type, host, _label, flag, sentence) => {
      setEgressFlag(flag);
      const failure = await factoryConnect(type, host, 6443);
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(sentence);
    },
  );
});

/** The engines whose provider docs say how DB_HTTP_BLOCK_PRIVATE_HOSTS=true refuses a loopback destination. */
const LOOPBACK_DOC_ENGINES: readonly DatabaseType[] = ["databend", "firestore"];

describe("what the provider docs of Databend and Firestore say about egress (FND-2 slice 2b-3b)", () => {
  // Firestore reaches its emulator through FIRESTORE_EMULATOR_HOST, which the factory-built provider reads when it is
  // built, so the case writes it first and afterEach restores it; Databend dials the connection's host.
  test.each(LOOPBACK_DOC_ENGINES.flatMap((type) => ["127.0.0.1", "localhost"].map((host) => [type, host] as const)))(
    "%s built by createDatabaseProvider with DB_HTTP_BLOCK_PRIVATE_HOSTS true refuses the loopback address %s before any request",
    async (type, host) => {
      setEgressFlag("true");
      const server = await countingServer();
      try {
        if (type === "firestore") process.env.FIRESTORE_EMULATOR_HOST = `${host}:${server.port}`;
        const failure = await factoryConnect(type, host, server.port);
        expect(failure).toBeInstanceOf(DatabaseConfigError);
        expect((failure as Error).message).toBe(BLOCKED_HOST);
        expect(server.hits()).toBe(0);
      } finally {
        await server.close();
      }
    },
  );
});
