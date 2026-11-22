/**
 * The dial's address rule (`docs/providers/mqtt.md` section 4.8): the shared `socketEgress` rule, with no address check
 * of the provider's own.
 *
 * The dial decides by the egress decision it is handed, the one the provider was built with (FND-2 slice 2b-2). A
 * link-local or metadata address is refused whatever that decision says, as a literal before any socket and as a DNS
 * answer inside the lookup the socket dials through; with a blocking decision a loopback, private or special-use
 * address is refused too. Both refusals reach the caller as the shared sentences, unchanged.
 *
 * Through an SSH tunnel the socket dials the local forward, a loopback address, and the rule is checked against that
 * address, as the shared node transport checks it: refused with a blocking decision, reached with an allowing one.
 *
 * The resolver is mocked, because no real name answers a link-local or a private address, and `node:net`'s `connect`
 * is wrapped to record what the dial asked for. Every dial still opens a real socket, except the one to the public
 * answer, which runs the installed lookup and stops there, so no test sends a packet off this machine. The test runner
 * starts a process per file, so these module mocks reach no other file.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import type { TcpNetConnectOpts, Server, Socket } from "node:net";
import type { EgressDecision } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const realDns = { ...(await import("node:dns")) };
const realNet = { ...(await import("node:net")) };

const ANSWERS: ReadonlyMap<string, readonly LookupAddress[]> = new Map([
  ["metadata.test", [{ address: "169.254.169.254", family: 4 }]],
  ["private.test", [{ address: "10.0.0.5", family: 4 }]],
  ["public.test", [{ address: "8.8.8.8", family: 4 }]],
  ["loopback.test", [{ address: "127.0.0.1", family: 4 }]],
]);
const lookups: string[] = [];

mock.module("node:dns", () => ({
  ...realDns,
  lookup(
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, addresses: LookupAddress[]) => void,
  ) {
    lookups.push(hostname);
    const answer = ANSWERS.get(hostname);
    if (answer === undefined) callback(new Error("DNS failure"), []);
    else callback(null, [...answer]);
  },
}));

/** What each dial asked `net.connect` for, and the address the public answer's lookup handed back. */
const dials: TcpNetConnectOpts[] = [];
const handedBack: string[] = [];

/** Runs the installed lookup the way a socket does and stops before connecting: no packet leaves for a public address. */
function lookupOnly(options: TcpNetConnectOpts & { host: string }): Socket {
  const socket = Object.assign(new EventEmitter(), { write: () => true, destroy: () => socket });
  options.lookup?.(options.host, {}, (error, address) => {
    queueMicrotask(() => {
      if (error) socket.emit("error", error);
      else {
        handedBack.push(String(address));
        socket.emit("error", new Error("stopped before connecting"));
      }
    });
  });
  return socket as unknown as Socket;
}

mock.module("node:net", () => ({
  ...realNet,
  connect(...args: unknown[]) {
    const options = args[0] as TcpNetConnectOpts & { host: string };
    dials.push(options);
    if (options.host === "public.test") return lookupOnly(options);
    return (realNet.connect as (...a: unknown[]) => Socket)(...args);
  },
}));

const { DatabaseConfigError } = await import("@/lib/db/errors");
const { BLOCKED_HOST, LINK_LOCAL_HOST } = await import("@/lib/db/http/egress-policy");
const { readTopics } = await import("@/lib/db/providers/keyvalue/mqtt/session");
const { MqttProvider } = await import("@/lib/db/providers/keyvalue/mqtt/index");
const { TUNNEL_FAR_END } = await import("@/lib/types");
type DatabaseConnection = import("@/lib/types").DatabaseConnection;

const servers: Server[] = [];

afterEach(() => {
  dials.length = 0;
  lookups.length = 0;
  handedBack.length = 0;
});
afterAll(() => {
  for (const server of servers) server.close();
});

/** The decision the next dial is handed: "blocking" blocks private destinations, as an operator's `true` does. */
let egress: EgressDecision = ALLOWS_PRIVATE_HOSTS;
function decide(state: "blocking" | "allowing"): void {
  egress = state === "blocking" ? BLOCKS_PRIVATE_HOSTS : ALLOWS_PRIVATE_HOSTS;
}

/** A loopback listener that accepts and says nothing, counting what it accepted. */
async function listener(): Promise<{ port: number; accepted: () => number }> {
  let accepted = 0;
  const server = realNet.createServer((socket) => {
    accepted += 1;
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, accepted: () => accepted };
}

/** What a read settles as: the error it rejected with. */
async function readError(host: string, port: number, tls = false): Promise<Error> {
  try {
    await readTopics({ host, port, tls, dialTimeoutMs: 300, egress });
  } catch (error) {
    return error as Error;
  }
  throw new Error(`the read of ${host} resolved`);
}

describe("with an allowing decision", () => {
  test("a link-local literal is refused before any socket, with the shared sentence", async () => {
    decide("allowing");
    const errors = await Promise.all(["169.254.169.254", "fe80::1", "[fe80::1]"].map((host) => readError(host, 1883)));
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(LINK_LOCAL_HOST);
    }
    expect(dials).toHaveLength(0);
  });

  test("a name answering a link-local address is refused by the lookup the socket dials through", async () => {
    decide("allowing");
    const errors = await Promise.all([false, true].map((tls) => readError("metadata.test", 1883, tls)));
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(LINK_LOCAL_HOST);
    }
    expect(lookups).toEqual(["metadata.test", "metadata.test"]);
  });

  test("a name answering a loopback address is dialled at the address checked", async () => {
    decide("allowing");
    const broker = await listener();
    const error = await readError("loopback.test", broker.port);
    // A listener that says nothing is not a broker, so the read fails on the handshake, after the dial.
    expect(error).not.toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toMatch(/accepted the connection/);
    expect(lookups).toEqual(["loopback.test"]);
    expect(broker.accepted()).toBe(1);
  });
});

describe("with a blocking decision", () => {
  test("a private literal is refused before any socket, with the guard's sentence", async () => {
    decide("blocking");
    const errors = await Promise.all(["10.0.0.5", "127.0.0.1", "169.254.169.254"].map((host) => readError(host, 1883)));
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(BLOCKED_HOST);
    }
    expect(dials).toHaveLength(0);
  });

  test("a name answering a private or a link-local address is refused, with the guard's sentence", async () => {
    decide("blocking");
    const errors = await Promise.all(
      ["private.test", "loopback.test", "metadata.test"].map((host) => readError(host, 1883)),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(BLOCKED_HOST);
    }
  });

  test("a name answering a public address is handed that address to dial", async () => {
    decide("blocking");
    const error = await readError("public.test", 1883);
    expect(error).not.toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toContain("stopped before connecting");
    expect(handedBack).toEqual(["8.8.8.8"]);
  });
});

describe("through an SSH tunnel, the rule is checked against the local forward the socket dials", () => {
  function tunnelled(port: number): DatabaseConnection {
    return {
      id: "mqtt-tunnel",
      name: "mqtt-tunnel",
      type: "mqtt",
      host: "127.0.0.1",
      port,
      sshTunnel: { enabled: true, host: "bastion.test", port: 22, username: "not-a-real-user" },
      [TUNNEL_FAR_END]: { host: "broker.test", port: 1883 },
    } as unknown as DatabaseConnection;
  }

  test("with a blocking decision, a tunnelled connection is refused, because the forward is a loopback address", async () => {
    decide("blocking");
    const forward = await listener();
    const error = await new MqttProvider(tunnelled(forward.port), {}, { egress }).connect().then(
      () => new Error("connected"),
      (failure: Error) => failure,
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(BLOCKED_HOST);
    expect(forward.accepted()).toBe(0);
  });

  test("with an allowing decision, a tunnelled connection dials the forward", async () => {
    decide("allowing");
    const forward = await listener();
    const error = await new MqttProvider(tunnelled(forward.port), {}, { egress }).connect().then(
      () => new Error("connected"),
      (failure: Error) => failure,
    );
    expect(error).not.toBeInstanceOf(DatabaseConfigError);
    expect(forward.accepted()).toBe(1);
    expect(dials[0]?.lookup).toBeDefined();
  }, 30_000);
});
