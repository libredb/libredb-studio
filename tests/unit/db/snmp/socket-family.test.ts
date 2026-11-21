/**
 * The provider's socket follows the address the host resolved to, and a connect that fails closes the socket it
 * opened.
 *
 * An agent on IPv6 is reached over a udp6 socket: a udp4 socket cannot be connected to an IPv6 address, so before
 * this the connect failed for `::1`, `[::1]` and every name that resolves to IPv6. The agent here listens on `::1`,
 * which a udp4 socket cannot reach, so an answer read back is the proof that the socket was udp6.
 *
 * Its own file, because `node:dns` and `node:dgram` are replaced for the whole process here (`mock.module`), and the
 * runner gives each file a process of its own. The DNS stub answers one test name with `::1`, so the name case does
 * not depend on what a host's resolver says about `ip6-localhost` or `localhost`. The dgram stub hands out real
 * sockets and records each one, its type and whether it was closed; a case that needs a socket to fail sets `fault`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { Socket, SocketType } from "node:dgram";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const realDns = { ...(await import("node:dns")) };
const realDgram = { ...(await import("node:dgram")) };

const SIX = "agent-six.test";
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 400, maxResultRows: 5, maxResultBytes: 10_000 };
const COMMUNITY = "socket-family-community";

mock.module("node:dns", () => ({
  ...realDns,
  lookup(
    hostname: string,
    options: { all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ) {
    if (hostname === SIX) callback(null, [{ address: "::1", family: 6 }]);
    else realDns.lookup(hostname, { ...options, all: true }, callback);
  },
}));

interface Opened {
  readonly type: SocketType;
  closed: boolean;
}
const opened: Opened[] = [];
/** When set, makes the sockets handed out, so a case can give the provider one that fails. Set after the agent starts. */
let fault: ((type: SocketType) => Socket) | undefined;

mock.module("node:dgram", () => ({
  ...realDgram,
  createSocket: (type: SocketType) => {
    const socket = fault?.(type) ?? realDgram.createSocket(type);
    const entry: Opened = { type, closed: false };
    const close = socket.close.bind(socket);
    socket.close = ((callback?: () => void) => {
      entry.closed = true;
      return close(callback);
    }) as Socket["close"];
    opened.push(entry);
    return socket;
  },
}));

const { SnmpProvider } = await import("@/lib/db/providers/network/snmp");
const { SnmpTransportError } = await import("@/lib/db/providers/network/snmp/client");
const { startFakeAgent, text } = await import("../../../helpers/snmp-fake-agent");
type FakeAgent = Awaited<ReturnType<typeof startFakeAgent>>;

const TREE = new Map([
  ["1.3.6.1.2.1.1.1.0", text("an agent on IPv6")],
  ["1.3.6.1.2.1.1.3.0", text("uptime")],
]);

let agent: FakeAgent | undefined;
let provider: InstanceType<typeof SnmpProvider> | undefined;

afterEach(async () => {
  fault = undefined;
  await provider?.disconnect();
  provider = undefined;
  agent?.close();
  agent = undefined;
});

const connection = (host: string, port: number, allowInsecureAuth?: boolean): DatabaseConnection =>
  ({
    id: "socket-family",
    name: "socket family",
    type: "snmp",
    host,
    port,
    password: COMMUNITY,
    allowInsecureAuth,
    createdAt: new Date(),
  }) as unknown as DatabaseConnection;

/** The sockets the provider asked for since `from`, the agent's own socket being made before it. */
const since = (from: number): Opened[] => opened.slice(from);

describe("an agent on IPv6 is reached over a udp6 socket", () => {
  for (const [host, consent] of [
    ["::1", undefined],
    ["[::1]", undefined],
    // This name is not loopback to the cleartext check, so it needs the consent any other agent needs.
    [SIX, true],
  ] as const) {
    test(`${host} answers a get`, async () => {
      agent = await startFakeAgent(TREE, { address: "::1" });
      const from = opened.length;
      provider = new SnmpProvider(
        connection(host, agent.port, consent),
        { queryTimeout: 2000 },
        { egress: ALLOWS_PRIVATE_HOSTS },
      );
      await provider.connect();
      const result = await provider.query("get sysDescr.0");
      expect(result.rows).toEqual([{ object: "1.3.6.1.2.1.1.1.0", value: "an agent on IPv6", type: "text" }]);
      // The connect probe and the get, both received on ::1.
      expect(agent.requests).toHaveLength(2);
      expect(since(from).map((socket) => socket.type)).toEqual(["udp6"]);
    });
  }

  test("an agent on IPv4 is still reached over a udp4 socket", async () => {
    agent = await startFakeAgent(TREE);
    const from = opened.length;
    provider = new SnmpProvider(
      connection("127.0.0.1", agent.port),
      { queryTimeout: 2000 },
      { egress: ALLOWS_PRIVATE_HOSTS },
    );
    await provider.connect();
    expect((await provider.query("get sysDescr.0")).rowCount).toBe(1);
    expect(since(from).map((socket) => socket.type)).toEqual(["udp4"]);
  });
});

describe("a connect that fails closes the socket it opened", () => {
  test("a socket that cannot be connected to the agent's address fails the connect by name", async () => {
    // A udp4 socket handed out for an IPv6 agent: the runtime reports the failed connect to the connect callback,
    // which the provider now reads instead of going on to send on a socket that is not connected.
    agent = await startFakeAgent(TREE, { address: "::1" });
    fault = () => realDgram.createSocket("udp4");
    const from = opened.length;
    provider = new SnmpProvider(
      connection("::1", agent.port),
      { queryTimeout: 2000 },
      { egress: ALLOWS_PRIVATE_HOSTS },
    );
    const error = await provider.connect().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SnmpTransportError);
    expect(String((error as Error).message)).toContain(`could not connect a udp6 socket to ::1 port ${agent.port}`);
    expect(agent.requests).toHaveLength(0);
    expect(since(from)).toEqual([{ type: "udp6", closed: true }]);
  });

  test("a socket whose bind fails reports it as an error event, and the connect fails by name", async () => {
    // A host without IPv6 answers a udp6 socket's implicit bind with EAFNOSUPPORT (a process out of descriptors, any
    // socket with EMFILE). The runtime reports that only as an `error` event and never calls the connect callback.
    fault = (type) => {
      const socket = realDgram.createSocket(type);
      socket.connect = (() => {
        setImmediate(() =>
          socket.emit(
            "error",
            Object.assign(new Error("bind EAFNOSUPPORT ::"), { code: "EAFNOSUPPORT", syscall: "bind" }),
          ),
        );
      }) as unknown as Socket["connect"];
      return socket;
    };
    const from = opened.length;
    provider = new SnmpProvider(
      connection("::1", 161),
      { queryTimeout: 2000 },
      { ...READ_ONLY, egress: ALLOWS_PRIVATE_HOSTS },
    );
    const error = await provider.connect().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SnmpTransportError);
    expect((error as Error).message).toBe("could not connect a udp6 socket to ::1 port 161: EAFNOSUPPORT");
    expect(since(from)).toEqual([{ type: "udp6", closed: true }]);
    // A connect that failed leaves the provider closed: a statement is refused rather than dialled again.
    await expect(provider.queryReadOnly("get sysDescr.0", BUDGET)).rejects.toThrow(/This connection is not open/);
    expect(since(from)).toHaveLength(1);
  });

  test("a probe the socket fails to send fails the connect and closes the socket", async () => {
    agent = await startFakeAgent(TREE);
    fault = (type) => {
      const socket = realDgram.createSocket(type);
      socket.send = (() => {
        throw Object.assign(new Error("the socket refused the send"), { code: "EFAKE" });
      }) as Socket["send"];
      return socket;
    };
    const from = opened.length;
    provider = new SnmpProvider(
      connection("127.0.0.1", agent.port),
      { queryTimeout: 2000 },
      { ...READ_ONLY, egress: ALLOWS_PRIVATE_HOSTS },
    );
    const error = await provider.connect().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(String((error as Error).message)).toContain("the socket refused the send");
    expect(since(from)).toEqual([{ type: "udp4", closed: true }]);
    await expect(provider.queryReadOnly("get sysDescr.0", BUDGET)).rejects.toThrow(/This connection is not open/);
  });

  test("a probe nobody answers fails the connect and closes the socket", async () => {
    agent = await startFakeAgent(TREE, { silentOn: () => true });
    const from = opened.length;
    provider = new SnmpProvider(
      connection("127.0.0.1", agent.port),
      { queryTimeout: 200 },
      { egress: ALLOWS_PRIVATE_HOSTS },
    );
    const error = await provider.connect().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(String((error as Error).message)).toContain("No SNMP agent answered");
    expect(since(from)).toEqual([{ type: "udp4", closed: true }]);
  });
});
