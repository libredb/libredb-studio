import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server as TcpServer, type Socket } from "node:net";
import path from "node:path";
import { Server as SshServer, utils, type Connection, type ServerChannel } from "ssh2";
import { DatabaseConfigError } from "@/lib/db/errors";
import { NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import { NETCONF_SESSION_LIMITS, openNetconfReader } from "@/lib/db/providers/network/netconf/open";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import type { SocketPort, SshPort } from "@/lib/db/providers/network/netconf/dial";
import type { Transport } from "@/lib/db/providers/network/netconf/session";
import { fingerprintOf } from "@/lib/db/providers/network/netconf/hostkey";
import type { DatabaseConnection } from "@/lib/types";
import type { EgressDecision } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS } from "../../helpers/egress-decisions";

/**
 * The NETCONF provider end to end over bytes a real device sent, and without Docker.
 *
 * WHAT RUNS. Everything but the socket: the dial, the host key check against the key the device
 * actually presented, the session's hello and chunked framing, the reader's YANG scan and path
 * handling, and the provider's own rules. The replies are `tests/fixtures/netconf/session.json`,
 * recorded from Netopeer2 2.8.7 by `tests/live/netconf-evidence.ts`, chunk for chunk as the
 * transport received them - 13 of the 14 exchanges arrive in more than one chunk, up to nine, so
 * the framing is reached rather than stepped over.
 *
 * WHAT THE UNIT TESTS DO INSTEAD. `tests/unit/db/netconf/` drives each module against
 * hand-written replies. That proves the rules and says nothing about what a device sends; this
 * says what one sent. The one thing it does not reach is the UTF-8 boundary inside `transportOf`,
 * because a capture taken above that decoder is already whole characters - and the house holds
 * that case where it belongs, in `netconf.test.ts`.
 *
 * WHY THE REPLAY IS ORDERED rather than matched by request. The session requires a reply's
 * `message-id` to equal its request's, and that rule is there because of a measured bug: a probe
 * that ignored the id read notifications as replies and reported 13 answers to 12 requests. So a
 * replay matched by request text would have to rewrite the id inside the reply, and the declared
 * chunk length with it, which means feeding the parser bytes the device never sent. Replaying in
 * order costs an ordering constraint and invents nothing.
 */

interface Exchange {
  readonly request: string;
  readonly chunks: string[];
}
interface Capture {
  readonly target: string;
  readonly hello: string[];
  readonly exchanges: Exchange[];
}

/**
 * The key the replay's device presents, and the pin it is checked against.
 *
 * Built here rather than recorded, and that is a decision about what may be committed: a real
 * host key is public material, but a 372-byte base64 blob is what a secret looks like to a
 * scanner, and the repository's own pre-commit scan refuses it. Every line of `hostkey.ts` runs
 * on these just the same - the hash, the comparison and the refusal - and whether a REAL device's
 * key matches a REAL pin is the live check's question, where neither is committed.
 */
const DEVICE_KEY = Buffer.from("the netconf fixture's host key, as the replay presents it");
const PIN = fingerprintOf(DEVICE_KEY);

const CAPTURE = JSON.parse(
  readFileSync(path.resolve(import.meta.dir, "../../fixtures/netconf/session.json"), "utf8"),
) as Capture;

/** The id counts up per session, as the capture script strips it. */
const withoutMessageId = (rpc: string): string => rpc.replace(/message-id="[^"]*"/g, 'message-id=""');

interface Replay {
  readonly ports: { xml: typeof netconfXmlPort; ssh: SshPort; socket: SocketPort; egress: EgressDecision };
  /** Every request the code under test wrote, so a test can say what it asked. */
  readonly wrote: string[];
  readonly closes: { count: number };
}

function replay(capture: Capture = CAPTURE): Replay {
  const wrote: string[] = [];
  const closes = { count: 0 };
  let onData: ((chunk: string) => void) | null = null;
  let at = 0;

  const transport: Transport = {
    write: (text) => {
      wrote.push(text);
      const expected = capture.exchanges[at];
      if (expected === undefined) {
        throw new Error(`the capture holds ${capture.exchanges.length} exchanges and this is request ${at + 1}`);
      }
      // Ordered, and checked: a test that asks for something else than what was recorded fails
      // here by name rather than being answered with the next thing in the file.
      if (withoutMessageId(text) !== expected.request) {
        throw new Error(
          `request ${at + 1} is not the one recorded.\n  asked:    ${withoutMessageId(text).slice(0, 160)}\n` +
            `  recorded: ${expected.request.slice(0, 160)}`,
        );
      }
      at += 1;
      for (const chunk of expected.chunks) queueMicrotask(() => onData?.(chunk));
    },
    onData: (handler) => {
      onData = handler;
      // The device speaks first: Netopeer2 sends its hello as the channel opens, and the session
      // reads it before sending its own.
      for (const chunk of capture.hello) queueMicrotask(() => onData?.(chunk));
    },
    onClose: () => {},
    onError: () => {},
    close: () => void (closes.count += 1),
  };

  return {
    wrote,
    closes,
    ports: {
      xml: netconfXmlPort,
      // The decision a factory-built provider holds while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset.
      egress: ALLOWS_PRIVATE_HOSTS,
      socket: { connect: async () => ({ socket: true }) as never },
      ssh: {
        connect: (options) => {
          let ready: (() => void) | null = null;
          queueMicrotask(() => {
            // The pin check runs for real: `hostkey.ts` hashes this key and compares it.
            if (options.hostVerifier(DEVICE_KEY)) ready?.();
          });
          return {
            onReady: (handler) => {
              ready = handler;
            },
            onError: () => {},
            subsystem: (_name, handler) => handler(null, transport),
            end: () => {},
          };
        },
      },
    },
  };
}

const connection = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: "replay",
    name: "fixture",
    type: "netconf",
    host: "127.0.0.1",
    port: 1830,
    user: "ro-pass",
    // Not a credential and not the fixture's: the replay's SSH port never authenticates, so this
    // field is only here because the connection shape has it. A real password in a committed file
    // is a published credential whatever it unlocks.
    password: "unused-by-the-replay",
    hostKeyFingerprint: PIN,
    ...over,
  }) as unknown as DatabaseConnection;

const MODULE = "ietf-interfaces";
const MONITORING = "ietf-netconf-monitoring";

describe("the session opens against what the device really said", () => {
  test("the hello is read, and its datastores and modules are the device's", async () => {
    const { ports } = replay();
    const reader = await openNetconfReader(connection(), ports);
    // Netopeer2 2.8.7 with NMDA: the datastores are the ones its RFC 8525 datastore list names, which
    // holds no `intended`, and the device refuses `<get-data>` on it.
    expect(reader.facts.datastores).toEqual(["running", "candidate", "startup", "operational"]);
    expect(reader.facts.nmda).toBe(true);
    // The count is the device's, not a number chosen here: 52 modules were advertised.
    expect(reader.facts.modules).toContain(MODULE);
    expect(reader.facts.modules.length).toBe(52);
  });

  test("a wrong pin is refused before the subsystem is opened", async () => {
    const { ports, wrote } = replay();
    const wrong = "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(openNetconfReader(connection({ hostKeyFingerprint: wrong }), ports)).rejects.toThrow(
      /host key|fingerprint/i,
    );
    // Nothing was written: the pin is checked during the handshake, so a device that fails it is
    // never asked anything.
    expect(wrote).toEqual([]);
  });
});

describe("the reads, through the framing the device chunked", () => {
  test("the interface list is read, and the first row is the fixture's first interface", async () => {
    const { ports } = replay();
    const reader = await openNetconfReader(connection(), ports);
    await reader.topLevelNodes("running", MODULE);
    await reader.children("running", [{ name: "interfaces", module: MODULE }]);
    const result = await reader.rows("running", [{ name: "interfaces", module: MODULE }], 5);
    expect(result.rows.length).toBeGreaterThan(0);
    // `ge-0/0/0` with `port 0` is what the fixture's own setup writes first, and the description
    // carries a four-byte character on purpose.
    expect(JSON.stringify(result.rows[0])).toContain("ge-0/0/0");
  });

  test("a limit is a limit: five rows asked for, five rows answered", async () => {
    const { ports } = replay();
    const reader = await openNetconfReader(connection(), ports);
    await reader.topLevelNodes("running", MODULE);
    await reader.children("running", [{ name: "interfaces", module: MODULE }]);
    const five = await reader.rows("running", [{ name: "interfaces", module: MODULE }], 5);
    expect(five.rows.length).toBe(5);
  });

  test("the source tab gets XML the device sent, not a reconstruction", async () => {
    const { ports } = replay();
    const reader = await openNetconfReader(connection(), ports);
    await reader.topLevelNodes("running", MODULE);
    await reader.children("running", [{ name: "interfaces", module: MODULE }]);
    await reader.rows("running", [{ name: "interfaces", module: MODULE }], 5);
    await reader.rows("running", [{ name: "interfaces", module: MODULE }], 50);
    const xml = await reader.sourceXml("running", [{ name: "interfaces", module: MODULE }]);
    expect(xml).toContain("<interfaces");
    expect(xml).toContain("ge-0/0/0");
  });

  test("the monitoring module has no top-level nodes, which is the device's answer and not a miss", async () => {
    const { ports } = replay();
    const reader = await openNetconfReader(connection(), ports);
    await reader.topLevelNodes("running", MODULE);
    await reader.children("running", [{ name: "interfaces", module: MODULE }]);
    await reader.rows("running", [{ name: "interfaces", module: MODULE }], 5);
    await reader.rows("running", [{ name: "interfaces", module: MODULE }], 50);
    await reader.sourceXml("running", [{ name: "interfaces", module: MODULE }]);
    await reader.moduleText(MODULE);
    /*
     * This case was written expecting nodes, and the replay said zero. MEASURED against the live
     * fixture through the real socket, which is what settled it: zero for this module on
     * `operational` AND on `running`, and zero for `ietf-interfaces` on `operational` too. So the
     * replay was faithful and the expectation was wrong.
     *
     * Why zero, and why it is not a miss: everything `ietf-netconf-monitoring` publishes is
     * `config false` state data, and this listing is of a module's top-level CONFIG nodes. A
     * direct path read of the same module does answer - `netconf-state/sessions` and
     * `/schemas` both return rows on this device - so the data is reachable, just not from this
     * listing. `ietf-interfaces` on `operational` is zero for the server's own reason, recorded
     * by the session that built this fixture: sysrepo does not mirror config into `operational`
     * without a subscriber.
     */
    const nodes = await reader.topLevelNodes("operational", MONITORING);
    expect(nodes.length).toBe(0);
  });
});

describe("what the provider refuses, with the device on the other end", () => {
  test("a write is refused by this provider, and nothing reaches the device", async () => {
    const { ports, wrote } = replay();
    const provider = new NetconfProvider(connection(), {}, {}, async (config) => openNetconfReader(config, ports));
    await provider.connect();
    const asked = wrote.length;
    await expect(provider.query("<edit-config><target><running/></target></edit-config>")).rejects.toThrow(
      /reads a device and does not write to it/,
    );
    // The refusal is this provider's own and costs no request: the count of writes is unchanged.
    expect(wrote.length).toBe(asked);
  });

  test("an SQL statement is refused by the same sentence", async () => {
    const { ports } = replay();
    const provider = new NetconfProvider(connection(), {}, {}, async (config) => openNetconfReader(config, ports));
    await provider.connect();
    await expect(provider.query("UPDATE interfaces SET enabled = false")).rejects.toThrow(
      /reads a device and does not write to it/,
    );
  });
});

/**
 * A session that ends closes its connection to the device, over a real SSH connection.
 *
 * The device is `ssh2`'s own `Server` on loopback, and Studio's side is the provider as it runs:
 * the real socket, the real SSH client and the real channel. The device counts its open SSH
 * connections, so each case reads the answer where it matters, on the device. A connection a case
 * leaves open is ended after it, so a failure is reported by the case that caused it and not by
 * every case after it.
 */
type DeviceMode =
  | "normal"
  | "no-session-id"
  | "bad-base"
  | "no-hello"
  | "close-before-hello"
  | "hello-then-close"
  | "framing-fault-after-open"
  | "channel-close-after-open"
  | "error-stream-fails-before-hello"
  | "error-stream-fails-with-the-subsystem";

const NC = 'xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"';
const DEVICE_HELLOS: Partial<Record<DeviceMode, string>> = {
  "no-session-id": `<hello ${NC}><capabilities><capability>urn:ietf:params:netconf:base:1.1</capability></capabilities></hello>]]>]]>`,
  "bad-base": `<hello ${NC}><capabilities><capability>urn:ietf:params:netconf:base:9.9</capability></capabilities><session-id>7</session-id></hello>]]>]]>`,
};
/** Not a credential: the device accepts any, and the connection shape needs one. */
const DEVICE_LOGIN = "SEED-CANARY-netconf-device";

let mode: DeviceMode = "normal";
let device: SshServer;
let devicePort = 0;
let devicePin = "";
let openConnections = 0;
const deviceClients = new Set<Connection>();
const channels: ServerChannel[] = [];
let allClosed: (() => void)[] = [];

/** The device's open SSH connections once they have all closed, or after `ms` if some did not. */
const openAfter = (ms: number): Promise<number> =>
  new Promise((resolve) => {
    if (openConnections === 0) {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => resolve(openConnections), ms);
    allClosed.push(() => {
      clearTimeout(timer);
      resolve(0);
    });
  });

/** ssh2's own wire, which a device uses to send what its public channel API does not. */
interface ChannelWire {
  readonly outgoing: { readonly id: number };
  readonly _client: { readonly _protocol: { channelExtData(id: number, data: Buffer, type: number): void } };
}
const STDERR_DATA = 1;

/**
 * The channel's end, and then data on its error stream, which fails the client's error stream: a
 * stream that has ended cannot take more data.
 */
function failErrorStream(channel: ServerChannel): void {
  channel.eof();
  const wire = channel as unknown as ChannelWire;
  wire._client._protocol.channelExtData(wire.outgoing.id, Buffer.from("after the end"), STDERR_DATA);
}

function serve(channel: ServerChannel): void {
  channels.push(channel);
  if (mode === "no-hello") return;
  if (mode === "error-stream-fails-before-hello") {
    failErrorStream(channel);
    return;
  }
  if (mode === "close-before-hello") {
    channel.exit(0);
    channel.end();
    channel.close();
    return;
  }
  channel.write(DEVICE_HELLOS[mode] ?? CAPTURE.hello.join(""));
  if (mode === "hello-then-close") {
    // The hello and the end of the channel in one burst, as an OpenSSH subsystem that exits.
    channel.exit(0);
    channel.end();
    channel.close();
    return;
  }
  let inbound = "";
  let helloSeen = false;
  let requests = 0;
  channel.on("data", (chunk: Buffer) => {
    inbound += chunk.toString("utf8");
    if (!helloSeen) {
      const end = inbound.indexOf("]]>]]>");
      if (end < 0) return;
      helloSeen = true;
      inbound = inbound.slice(end + "]]>]]>".length);
    }
    for (let end = inbound.indexOf("\n##\n"); end >= 0; end = inbound.indexOf("\n##\n")) {
      const request = inbound.slice(0, end);
      inbound = inbound.slice(end + "\n##\n".length);
      requests += 1;
      const id = /message-id="([^"]*)"/.exec(request)?.[1] ?? "";
      if (request.includes("<close-session/>")) {
        const ok = `<rpc-reply ${NC} message-id="${id}"><ok/></rpc-reply>`;
        channel.write(`\n#${Buffer.byteLength(ok)}\n${ok}\n##\n`);
      } else if (mode === "framing-fault-after-open" && requests > 2) {
        channel.write("\n#zz\n");
      } else {
        // The open's two requests, answered with the device's recorded replies, ids and all.
        channel.write((CAPTURE.exchanges[requests]?.chunks ?? []).join(""));
      }
    }
  });
}

beforeAll(async () => {
  // ECDSA for the reason `netconf-node-ports.test.ts` gives: ssh2's own ed25519 keys fail its own
  // parser a few times in a thousand.
  const key = utils.generateKeyPairSync("ecdsa", { bits: 256 });
  devicePin = fingerprintOf((utils.parseKey(key.public) as { getPublicSSH(): Buffer }).getPublicSSH());
  device = new SshServer({ hostKeys: [key.private] }, (client) => {
    openConnections += 1;
    deviceClients.add(client);
    client.on("error", () => {});
    client.on("close", () => {
      deviceClients.delete(client);
      openConnections -= 1;
      if (openConnections > 0) return;
      const waiting = allClosed;
      allClosed = [];
      for (const wake of waiting) wake();
    });
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("subsystem", (acceptSubsystem) => {
          if (mode !== "error-stream-fails-with-the-subsystem") {
            serve(acceptSubsystem());
            return;
          }
          // The subsystem's confirmation, the channel's end and the error stream's data in one
          // write, so the client reads all three before the dial has handed the channel on.
          const sock = (client as unknown as { _sock: Socket })._sock;
          sock.cork();
          failErrorStream(acceptSubsystem());
          process.nextTick(() => sock.uncork());
        });
      });
    });
  });
  await new Promise<void>((resolve) => device.listen(0, "127.0.0.1", resolve));
  devicePort = (device.address() as { port: number }).port;
});

afterEach(async () => {
  for (const client of deviceClients) client.end();
  await openAfter(2000);
});

afterAll(() => {
  (device as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  device.close();
});

function deviceProvider(helloMs = NETCONF_SESSION_LIMITS.helloMs): NetconfProvider {
  const config = connection({ port: devicePort, hostKeyFingerprint: devicePin, password: DEVICE_LOGIN });
  return new NetconfProvider(config, {}, {}, async (c) =>
    openNetconfReader(c, {
      xml: netconfXmlPort,
      limits: { ...NETCONF_SESSION_LIMITS, helloMs },
      egress: ALLOWS_PRIVATE_HOSTS,
    }),
  );
}

describe("a session that ends closes its connection to the device", () => {
  test("the control: an open session holds one connection, and disconnect() closes it", async () => {
    mode = "normal";
    const provider = deviceProvider();
    await provider.connect();
    expect(openConnections).toBe(1);
    await provider.disconnect();
    expect(await openAfter(2000)).toBe(0);
  });

  const failedOpens: { mode: DeviceMode; sentence: RegExp; helloMs?: number }[] = [
    { mode: "no-session-id", sentence: /carried no session-id/ },
    { mode: "bad-base", sentence: /offered no NETCONF base version this client speaks/ },
    { mode: "no-hello", sentence: /no hello within the deadline/, helloMs: 300 },
    { mode: "close-before-hello", sentence: /the device closed this session/ },
    { mode: "hello-then-close", sentence: /the device closed this session/ },
    {
      mode: "error-stream-fails-before-hello",
      sentence: /the channel to the device failed \(stream\.push\(\) after EOF\), so the session was ended/,
      helloMs: 3000,
    },
    {
      mode: "error-stream-fails-with-the-subsystem",
      sentence: /the channel to the device failed \(stream\.push\(\) after EOF\), so the session was ended/,
      helloMs: 3000,
    },
  ];
  for (const failed of failedOpens) {
    test(`${failed.mode}: the open fails by name and the connection is closed before disconnect()`, async () => {
      mode = failed.mode;
      const provider = deviceProvider(failed.helloMs);
      const failure = await provider.connect().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(failed.sentence);
      expect(await openAfter(2000)).toBe(0);
      await provider.disconnect();
      expect(openConnections).toBe(0);
    }, 10_000);
  }

  test("a framing fault after the open ends the session, and its connection is closed with it", async () => {
    mode = "framing-fault-after-open";
    const provider = deviceProvider();
    await provider.connect();
    const failure = await provider
      .query(JSON.stringify({ datastore: "running", path: "/ietf-interfaces:interfaces" }))
      .catch((e: unknown) => e);
    expect((failure as Error).message).toMatch(/broke the NETCONF framing rules \(chunk-header-malformed\)/);
    expect(await openAfter(2000)).toBe(0);
    await provider.disconnect();
    expect(openConnections).toBe(0);
  }, 10_000);

  test("a channel the device closes after the open ends the session, and its connection is closed with it", async () => {
    mode = "channel-close-after-open";
    const provider = deviceProvider();
    await provider.connect();
    expect(openConnections).toBe(1);
    channels.at(-1)?.close();
    expect(await openAfter(2000)).toBe(0);
    await provider.disconnect();
    expect(openConnections).toBe(0);
  }, 10_000);

  test("an error stream that fails after the open ends the session by name, and its connection is closed with it", async () => {
    mode = "normal";
    const provider = deviceProvider();
    await provider.connect();
    expect(openConnections).toBe(1);
    const channel = channels.at(-1);
    if (channel === undefined) throw new Error("the device opened no channel");
    failErrorStream(channel);
    expect(await openAfter(2000)).toBe(0);
    const failure = await provider
      .query(JSON.stringify({ datastore: "running", path: "/ietf-interfaces:interfaces" }))
      .catch((e: unknown) => e);
    expect((failure as Error).message).toMatch(/the channel to the device failed \(stream\.push\(\) after EOF\)/);
    await provider.disconnect();
    expect(openConnections).toBe(0);
  }, 10_000);
});

/**
 * A private key ssh2 cannot read fails the connect as a configuration error, and the socket dialled
 * for it is closed. ssh2 throws that failure from `connect()` before it takes the socket, so the
 * socket is the port's to close. The peer is a plain TCP listener that counts its open sockets:
 * nothing past the socket is reached.
 */
describe("a key that cannot be read", () => {
  const KEY_CANARY = "SEED-CANARY-not-a-private-key";
  let listener: TcpServer;
  let listenerPort = 0;
  const sockets = new Set<Socket>();
  let socketClosed: (() => void) | null = null;

  beforeAll(async () => {
    listener = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        socketClosed?.();
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    listenerPort = (listener.address() as { port: number }).port;
  });

  afterAll(() => {
    for (const socket of sockets) socket.destroy();
    listener.close();
  });

  /** The listener's open sockets once they have all closed, or after `ms` if some did not. */
  const socketsAfter = (ms: number): Promise<number> =>
    new Promise((resolve) => {
      if (sockets.size === 0) {
        resolve(0);
        return;
      }
      const timer = setTimeout(() => resolve(sockets.size), ms);
      socketClosed = () => {
        if (sockets.size > 0) return;
        clearTimeout(timer);
        resolve(0);
      };
    });

  test("the connect fails as a configuration error, and the socket dialled for it is closed", async () => {
    const config = connection({
      port: listenerPort,
      hostKeyFingerprint: devicePin,
      password: undefined,
      privateKey: KEY_CANARY,
    });
    const provider = new NetconfProvider(config, {}, {}, async (c) =>
      openNetconfReader(c, { xml: netconfXmlPort, limits: NETCONF_SESSION_LIMITS, egress: ALLOWS_PRIVATE_HOSTS }),
    );
    const failure = await provider.connect().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toMatch(/this private key cannot be read/);
    expect(await socketsAfter(2000)).toBe(0);
    await provider.disconnect();
  }, 10_000);
});
