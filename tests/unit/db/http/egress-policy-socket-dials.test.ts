/**
 * The socket dials take the egress decision their provider was built with (FND-2 slice 2b-2, docs/SECURITY.md row
 * 0.6).
 *
 * MQTT, Sparkplug B, NETCONF, Modbus and RabbitMQ's AMQP each open their own socket through the shared rule,
 * `socketEgress` in `src/lib/db/http/egress-policy.ts`, which decides by the decision it is handed and reads no
 * setting. Each provider here is built directly, as a test or a live script builds it outside Studio's factory, with a
 * decision the test hands it, and dials a TCP listener on 127.0.0.1 that counts and closes every connection. Where the
 * variable is written, it is written to the opposite of the decision handed, so a dial that read it would fail the case.
 *
 * The agent read of an agent-mode handle dials through the same rule with the same decision, by a path of its own in
 * every provider but RabbitMQ, whose stream read is the one above: a fresh session per read for MQTT, Sparkplug B and
 * NETCONF, and a socket per read for Modbus. Those reads are driven here too, and the last cases pin what the rule
 * refuses whatever decision is handed (a link-local literal), and that a name is checked at the lookup the socket dials
 * through.
 *
 * RabbitMQ dials AMQP only for a stream read, so its operation is `connect()` over a recorded management API, then the
 * stream read. Its allowing case dials `localhost`, a name: until slice 2b-3 the management origin is built by the
 * interim `httpOrigin`, which applies the process's decision to an IP literal at `connect()`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  BLOCKED_HOST,
  EGRESS_DECISION_MISSING,
  EGRESS_REFUSAL_SENTENCES,
  LINK_LOCAL_HOST,
} from "@/lib/db/http/egress-policy";
import { MODBUS_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/industrial/modbus/agent-read";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug/index";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { NETCONF_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/network/netconf/agent-read";
import { type DeviceReader, NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { routeTarget } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { DatabaseConnection, DatabaseProvider, EgressDecision, ReadOnlyStatementBudget } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";
import { type ManagementStub, createManagementStub } from "../../../helpers/rabbitmq-management-stub";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;

/**
 * A TCP listener on 127.0.0.1 that counts and closes every connection, and says when a given number have arrived.
 *
 * It also holds the same port on ::1, with a twin counting into the same record, so a dial to "localhost" reaches it
 * whichever family the name resolves to first: `listen`'s docblock in `tests/unit/db/rabbitmq/amqp/dial.test.ts` says
 * why a runner can resolve ::1 first, and what another file's ::1 socket on the same port number would do to the dial.
 */
interface CountingListener {
  readonly port: number;
  accepted(): number;
  /** Resolves when the listener has accepted `count` connections. */
  arrivals(count: number): Promise<void>;
  close(): Promise<void>;
}

/** What the listener writes to the first connection before it holds it open for its peer to close: an MQTT CONNACK. */
interface ListenerOptions {
  readonly greetFirst?: Buffer;
}

const listeners: CountingListener[] = [];

afterEach(async () => {
  setEgressFlag(original);
  for (const listener of listeners.splice(0)) await listener.close();
});

function bind(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

async function countingListener(options: ListenerOptions = {}): Promise<CountingListener> {
  let count = 0;
  const waiting: { count: number; resolve: () => void }[] = [];
  const sockets = new Set<Socket>();
  const accept = (socket: Socket): void => {
    count += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    const greeting = count === 1 ? options.greetFirst : undefined;
    // The greeting answers the peer's first packet; every other connection is closed at once.
    if (greeting === undefined) socket.destroy();
    else socket.once("data", () => socket.write(greeting));
    for (const waiter of waiting.filter((entry) => entry.count <= count)) {
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  for (let attempt = 1; ; attempt += 1) {
    const server = createServer(accept);
    // oxlint-disable-next-line no-await-in-loop -- each attempt needs the previous one's port to be closed or kept
    const port = await bind(server, 0, "127.0.0.1");
    const twin = createServer(accept);
    // oxlint-disable-next-line no-await-in-loop -- the twin takes the port the line above was given
    const refused = await bind(twin, port, "::1").then(
      () => null,
      (error: NodeJS.ErrnoException) => error,
    );
    if (refused) {
      // oxlint-disable-next-line no-await-in-loop -- the next attempt starts after this port is released
      await closeServer(server);
      if (refused.code !== "EADDRINUSE" || attempt === 10) throw refused;
      continue;
    }
    const listener: CountingListener = {
      port,
      accepted: () => count,
      arrivals: (wanted) =>
        wanted <= count
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiting.push({ count: wanted, resolve });
            }),
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await Promise.all([closeServer(server), closeServer(twin)]);
      },
    };
    listeners.push(listener);
    return listener;
  }
}

function stubKey(target: ReturnType<typeof routeTarget>): string {
  const query = [...(target.params ?? new URLSearchParams())]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return query === "" ? `GET ${target.pathname}` : `GET ${target.pathname}?${query}`;
}

/** whoami and the version overview, which connect() reads, then the type check of `/` `orders` as a stream. */
function connectedStub(): ManagementStub {
  const stub = createManagementStub();
  stub.answer(stubKey(routeTarget("whoami", {}, "")), {
    status: 200,
    body: '{"name":"studio-reader","tags":["management"]}',
  });
  stub.answer(stubKey(routeTarget("overview-version", {}, "")), {
    status: 200,
    body: '{"rabbitmq_version":"4.3.6","product_name":"RabbitMQ"}',
  });
  stub.answer(stubKey(routeTarget("stream-type", { vhost: "/", name: "orders" }, "")), {
    status: 200,
    body: JSON.stringify({ type: "stream", online: ["rabbit@a"], members: ["rabbit@a"] }),
  });
  return stub;
}

/** The build context a case hands: a decision, or none at all. */
type Context = { readonly egress?: EgressDecision };

/** A provider of one of the five, built directly with `context`, and the operation of it that dials. */
interface Built {
  readonly provider: DatabaseProvider;
  readonly dial: () => Promise<unknown>;
}

type Build = (host: string, port: number, context: Context) => Built;

function connection(type: DatabaseConnection["type"], host: string, port: number): DatabaseConnection {
  return { id: `socket-dial-${type}`, name: `socket dial ${type}`, type, host, port, createdAt: new Date() };
}

const BUILDS: readonly [string, Build, string][] = [
  [
    "MQTT",
    (host, port, context) => {
      const provider = new MqttProvider(connection("mqtt", host, port), {}, context);
      return { provider, dial: () => provider.connect() };
    },
    "127.0.0.1",
  ],
  [
    "Sparkplug B",
    (host, port, context) => {
      const provider = new SparkplugProvider(connection("sparkplug", host, port), {}, context);
      return { provider, dial: () => provider.connect() };
    },
    "127.0.0.1",
  ],
  [
    "NETCONF",
    (host, port, context) => {
      // A pin readPin accepts: SHA256 and the unpadded base64 of 32 bytes, generated per run.
      const pin = `SHA256:${randomBytes(32).toString("base64").replace(/=+$/, "")}`;
      const config = {
        ...connection("netconf", host, port),
        user: "reader",
        password: crypto.randomUUID(),
        hostKeyFingerprint: pin,
      };
      const provider = new NetconfProvider(config, {}, context);
      return { provider, dial: () => provider.connect() };
    },
    "127.0.0.1",
  ],
  [
    "Modbus",
    (host, port, context) => {
      const provider = new ModbusProvider(connection("modbus", host, port), {}, context);
      return { provider, dial: () => provider.connect() };
    },
    "127.0.0.1",
  ],
  [
    "RabbitMQ",
    (host, port, context) => {
      const config = rabbitmqConnection({ host, amqpPort: String(port), password: crypto.randomUUID() });
      const provider = new RabbitMQProvider(config, {}, context, { managementTransport: connectedStub().factory });
      const read = JSON.stringify({ vhost: "/", stream: "orders" });
      return { provider, dial: () => provider.connect().then(() => provider.query(read)) };
    },
    // A name until slice 2b-3: see the module comment.
    "localhost",
  ],
];

/** Runs the dialling operation and disconnects, resolving to the operation's error, or null when it succeeded. */
async function dialled({ provider, dial }: Built): Promise<unknown> {
  const outcome = await dial().then(
    () => null,
    (error: unknown) => error,
  );
  await provider.disconnect();
  return outcome;
}

describe("a socket-dial provider dials by the egress decision it was built with (FND-2 slice 2b-2)", () => {
  test.each(BUILDS)(
    "%s handed a blocking decision refuses 127.0.0.1 before any socket opens while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset",
    async (_name, build) => {
      setEgressFlag(undefined);
      const listener = await countingListener();
      const failure = await dialled(build("127.0.0.1", listener.port, { egress: BLOCKS_PRIVATE_HOSTS }));
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(listener.accepted()).toBe(0);
    },
  );

  test.each(BUILDS)(
    "%s handed an allowing decision reaches a local listener while DB_HTTP_BLOCK_PRIVATE_HOSTS is true",
    async (_name, build, allowedHost) => {
      setEgressFlag("true");
      const listener = await countingListener();
      const outcome = await dialled(build(allowedHost, listener.port, { egress: ALLOWS_PRIVATE_HOSTS }));
      // The engine's own outcome against a listener that closes at once, never an egress refusal.
      const message = outcome instanceof Error ? outcome.message : "";
      expect(EGRESS_REFUSAL_SENTENCES.has(message)).toBe(false);
      expect(message).not.toBe(EGRESS_DECISION_MISSING);
      await listener.arrivals(1);
      expect(listener.accepted()).toBeGreaterThan(0);
    },
  );

  test.each(BUILDS)(
    "%s built without an egress decision is built, and refuses to dial by name before any socket opens",
    async (_name, build) => {
      setEgressFlag(undefined);
      const listener = await countingListener();
      const built = build("127.0.0.1", listener.port, {});
      expect(built.provider.getCapabilities().defaultPort).not.toBeUndefined();
      const failure = await dialled(built);
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
      expect(listener.accepted()).toBe(0);
    },
  );
});

/** The agent read-only profile, under which a handle answers `queryReadOnly`. */
const AGENT = { readOnly: true, sendsStatements: true } as const;

/** An MQTT 5.0 CONNACK that accepts: the answer an agent-mode handle's `connect()` handshake waits for. */
const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);

/** The device layer `connect()` opens on a NETCONF handle; the agent read never uses it, so it reads nothing. */
const NETCONF_READER: DeviceReader = {
  facts: { datastores: ["running"], modules: ["ex-if"], nmda: false, capabilities: [], sessionId: "1" },
  topLevelNodes: async () => [],
  children: async () => [],
  rows: async () => ({ fields: [], rows: [], rowCount: 0, executionTime: 0 }),
  moduleText: async () => "module ex-if { }",
  sourceXml: async () => "<data/>",
  close: async () => {},
};

function netconfConfig(host: string, port: number): DatabaseConnection {
  // A pin readPin accepts: SHA256 and the unpadded base64 of 32 bytes, generated per run.
  const pin = `SHA256:${randomBytes(32).toString("base64").replace(/=+$/, "")}`;
  return {
    ...connection("netconf", host, port),
    user: "reader",
    password: crypto.randomUUID(),
    hostKeyFingerprint: pin,
  };
}

function modbusConfig(host: string, port: number): DatabaseConnection {
  const registerMap = JSON.stringify([
    { name: "volts", unitId: 1, table: "holding_register", address: 0, type: "uint16" },
  ]);
  return { ...connection("modbus", host, port), registerMap };
}

const budget = (): ReadOnlyStatementBudget => ({
  statementTimeoutMs: 10_000,
  maxResultRows: 100,
  maxResultBytes: 1_000_000,
  readAllowance: new RunReadAllowance(10_000),
});

/**
 * An agent-mode handle of one of the four whose agent read dials a socket of its own, and that read. `opens` is how many
 * connections `connect()` makes to the listener first: one handshake for MQTT and Sparkplug B, none for NETCONF, whose
 * device layer is the seam above, and none for Modbus, whose agent read needs no `connect()`, which is not called.
 */
interface AgentHandle {
  readonly provider: DatabaseProvider;
  readonly connects: boolean;
  readonly read: () => Promise<unknown>;
}

type AgentBuild = (port: number, context: Context) => AgentHandle;

const AGENT_READS: readonly [string, number, AgentBuild][] = [
  [
    "MQTT",
    1,
    (port, context) => {
      const provider = new MqttProvider(connection("mqtt", "127.0.0.1", port), {}, { ...AGENT, ...context });
      return { provider, connects: true, read: () => provider.queryReadOnly('{"read": "window"}', budget()) };
    },
  ],
  [
    "Sparkplug B",
    1,
    (port, context) => {
      const provider = new SparkplugProvider(connection("sparkplug", "127.0.0.1", port), {}, { ...AGENT, ...context });
      return { provider, connects: true, read: () => provider.queryReadOnly('{"read": "window"}', budget()) };
    },
  ],
  [
    "NETCONF",
    0,
    (port, context) => {
      const provider = new NetconfProvider(
        netconfConfig("127.0.0.1", port),
        {},
        { ...AGENT, ...context },
        async () => NETCONF_READER,
      );
      const read = '{"datastore": "running", "path": "ex-if:interfaces"}';
      return { provider, connects: true, read: () => provider.queryReadOnly(read, budget()) };
    },
  ],
  [
    "Modbus",
    0,
    (port, context) => {
      const provider = new ModbusProvider(modbusConfig("127.0.0.1", port), {}, { ...AGENT, ...context });
      return { provider, connects: false, read: () => provider.queryReadOnly('{"read": ["volts"]}', budget()) };
    },
  ],
];

/** Connects the handle where its read needs it, runs the read, and disconnects; resolves to the read's error or null. */
async function agentRead(handle: AgentHandle): Promise<unknown> {
  if (handle.connects) await handle.provider.connect();
  const outcome = await handle.read().then(
    () => null,
    (error: unknown) => error,
  );
  await handle.provider.disconnect();
  return outcome;
}

describe("an agent read dials by the egress decision its handle was built with (FND-2 slice 2b-2)", () => {
  test.each(AGENT_READS)(
    "%s's agent read handed an allowing decision reaches a local listener while DB_HTTP_BLOCK_PRIVATE_HOSTS is true",
    async (_name, opens, build) => {
      setEgressFlag("true");
      // A handle whose connect() dials gets its handshake answered; the read's own connection is closed at once.
      const listener = await countingListener(opens === 0 ? {} : { greetFirst: CONNACK });
      const handle = build(listener.port, { egress: ALLOWS_PRIVATE_HOSTS });
      const outcome = await agentRead(handle);
      // The engine's own outcome against a listener that closes the read's connection at once, never a refusal of
      // the destination and never the settings sentence an agent read words a refused destination with.
      const message = outcome instanceof Error ? outcome.message : "";
      expect(EGRESS_REFUSAL_SENTENCES.has(message)).toBe(false);
      expect(message).not.toBe(EGRESS_DECISION_MISSING);
      expect(message).not.toBe(NETCONF_AGENT_FAILURE_SENTENCES.settings);
      expect(message).not.toBe(MODBUS_AGENT_FAILURE_SENTENCES.settings);
      await listener.arrivals(opens + 1);
      expect(listener.accepted()).toBe(opens + 1);
    },
  );

  // MQTT's and Sparkplug B's connect() dials through the same rule first, so the cases above already hold their refusal.
  test.each(AGENT_READS.filter(([, opens]) => opens === 0))(
    "%s's agent read on a handle built without an egress decision is refused by name before any socket opens",
    async (_name, _opens, build) => {
      setEgressFlag(undefined);
      const listener = await countingListener();
      const failure = await agentRead(build(listener.port, {}));
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
      expect(listener.accepted()).toBe(0);
    },
  );

  test.each(AGENT_READS.filter(([, opens]) => opens === 0))(
    "%s's agent read handed a blocking decision opens no socket while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset",
    async (_name, _opens, build) => {
      setEgressFlag(undefined);
      const listener = await countingListener();
      const failure = await agentRead(build(listener.port, { egress: BLOCKS_PRIVATE_HOSTS }));
      expect(failure).toBeInstanceOf(Error);
      expect(listener.accepted()).toBe(0);
    },
  );
});

describe("where a socket dial may connect, whatever the decision allows or blocks", () => {
  test("Sparkplug B refuses a link-local literal under an allowing decision, before any socket opens", async () => {
    setEgressFlag(undefined);
    const provider = new SparkplugProvider(
      connection("sparkplug", "169.254.169.254", 1883),
      {},
      { egress: ALLOWS_PRIVATE_HOSTS },
    );
    const failure = await dialled({ provider, dial: () => provider.connect() });
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toBe(LINK_LOCAL_HOST);
  });

  test.each([
    [
      "Sparkplug B",
      (port: number) => {
        const provider = new SparkplugProvider(
          connection("sparkplug", "localhost", port),
          {},
          { egress: BLOCKS_PRIVATE_HOSTS },
        );
        return { provider, dial: () => provider.connect() };
      },
    ],
    [
      "Modbus",
      (port: number) => {
        const provider = new ModbusProvider(
          connection("modbus", "localhost", port),
          {},
          { egress: BLOCKS_PRIVATE_HOSTS },
        );
        return { provider, dial: () => provider.connect() };
      },
    ],
  ] as const)(
    "%s handed a blocking decision refuses the name localhost at the lookup the socket dials through, so no socket reaches the listener",
    async (_name, build) => {
      setEgressFlag(undefined);
      const listener = await countingListener();
      const failure = await dialled(build(listener.port));
      // Sparkplug B words a refusal at the lookup as a dial that never opened (ledger note L1), so the count decides.
      expect(failure).toBeInstanceOf(Error);
      expect(listener.accepted()).toBe(0);
    },
  );
});
