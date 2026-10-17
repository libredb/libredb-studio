import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NetconfProvider } from "@/lib/db/providers/network/netconf/index";
import { openNetconfReader } from "@/lib/db/providers/network/netconf/open";
import { netconfXmlPort } from "@/lib/db/providers/network/netconf/xml";
import type { SocketPort, SshPort } from "@/lib/db/providers/network/netconf/dial";
import type { Transport } from "@/lib/db/providers/network/netconf/session";
import { fingerprintOf } from "@/lib/db/providers/network/netconf/hostkey";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The NETCONF provider end to end over bytes a real device sent, and without Docker.
 *
 * WHAT RUNS. Everything but the socket: the dial, the host key check against the key the device
 * actually presented, the session's hello and chunked framing, the reader's YANG scan and path
 * handling, and the provider's own rules. The replies are `tests/fixtures/netconf/session.json`,
 * recorded from Netopeer2 2.8.7 by `tests/live/netconf-evidence.ts`, chunk for chunk as the
 * transport received them - 12 of the 13 exchanges arrive in more than one chunk, up to nine, so
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
  readonly ports: { xml: typeof netconfXmlPort; ssh: SshPort; socket: SocketPort };
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
    close: () => void (closes.count += 1),
  };

  return {
    wrote,
    closes,
    ports: {
      xml: netconfXmlPort,
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
    // Netopeer2 2.8.7 with NMDA: the writable-running, candidate and startup datastores come from
    // its capabilities, and `operational` and `intended` from the NMDA ones.
    expect(reader.facts.datastores).toEqual(["running", "candidate", "startup", "operational", "intended"]);
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
    const provider = new NetconfProvider(connection(), {}, async (config) => openNetconfReader(config, ports));
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
    const provider = new NetconfProvider(connection(), {}, async (config) => openNetconfReader(config, ports));
    await provider.connect();
    await expect(provider.query("UPDATE interfaces SET enabled = false")).rejects.toThrow(
      /reads a device and does not write to it/,
    );
  });
});
