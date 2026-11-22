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
 * The list of engines is a test-side list: a provider whose connections pass the shared egress guard joins it
 * (docs/ADDING_A_PROVIDER.md, "Step 3: Register in the Factory"), and the later slices of FND-2 slice 2b extend it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket as TcpSocket } from "node:net";
import { egressDecision } from "@/lib/db/egress-decision";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { BLOCKED_HOST } from "@/lib/db/http/egress-policy";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { FIXTURE_COMMUNITY } from "../fixtures/snmp/identity";
import { CENSUS_CONNECTION } from "../helpers/census-connection";
import { ALLOWS_PRIVATE_HOSTS } from "../helpers/egress-decisions";
import { setEgressFlag } from "../helpers/egress-flag";
import { pathsToObject } from "../helpers/reachable-markers";

/** The engines whose guard calls take the decision as an argument since slices 2b-1 and 2b-2. */
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
];

const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;

afterEach(() => {
  setEgressFlag(original);
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
});
