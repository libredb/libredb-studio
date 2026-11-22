/**
 * The socket dials take the egress decision their provider was built with (FND-2 slice 2b-2, docs/SECURITY.md row
 * 0.6).
 *
 * MQTT, Sparkplug B, NETCONF, Modbus and RabbitMQ's AMQP each open their own socket through the shared rule,
 * `socketEgress` in `src/lib/db/http/egress-policy.ts`, which decides by the decision it is handed and reads no
 * setting. Each provider here is built directly, as an embedder outside Studio's factory could build it, with a decision
 * the test hands it, and dials a TCP listener on 127.0.0.1 that counts and closes every connection. Where the variable
 * is written, it is written to the opposite of the decision handed, so a dial that read it would fail the case.
 *
 * RabbitMQ dials AMQP only for a stream read, so its operation is `connect()` over a recorded management API, then the
 * stream read. Its allowing case dials `localhost`, a name: until slice 2b-3 the management origin is built by the
 * interim `httpOrigin`, which applies the process's decision to an IP literal at `connect()`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST, EGRESS_DECISION_MISSING, EGRESS_REFUSAL_SENTENCES } from "@/lib/db/http/egress-policy";
import { ModbusProvider } from "@/lib/db/providers/industrial/modbus/index";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug/index";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { routeTarget } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import type { DatabaseConnection, DatabaseProvider, EgressDecision } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";
import { type ManagementStub, createManagementStub } from "../../../helpers/rabbitmq-management-stub";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;

/** A TCP listener on 127.0.0.1 that counts and closes every connection, and says when the first one arrives. */
interface CountingListener {
  readonly port: number;
  accepted(): number;
  /** Resolves when the listener accepts its first connection. */
  readonly reached: Promise<void>;
  close(): Promise<void>;
}

const listeners: CountingListener[] = [];

afterEach(async () => {
  setEgressFlag(original);
  for (const listener of listeners.splice(0)) await listener.close();
});

async function countingListener(): Promise<CountingListener> {
  let count = 0;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.destroy();
    arrived();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const listener: CountingListener = {
    port: (server.address() as AddressInfo).port,
    accepted: () => count,
    reached,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  listeners.push(listener);
  return listener;
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
      await listener.reached;
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
