/**
 * The Sparkplug agent boundary captures, replayed: what one `run.sh` recorded, one file per broker, against the fixture's Mosquitto 2.0.22 and a
 * stock EMQX 5.8.9, each with the fixture's own publisher, held to what `docs/providers/sparkplug.md` section 14 says
 * of it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const FIXTURES = path.resolve(import.meta.dir, "../../../fixtures/sparkplug");
/** One capture per broker, each in its own `<broker>-<version>/agent-boundary/` directory, written by one `run.sh`. */
const CAPTURES = ["mosquitto-2.0.22", "emqx-5.8.9"].map((directory) =>
  readFileSync(path.join(FIXTURES, directory, "agent-boundary", "boundary.json"), "utf8"),
);

interface Packet {
  readonly packet: string;
  readonly cleanStart?: boolean;
  readonly will?: boolean;
  readonly credentials?: boolean;
  readonly filters?: number;
  readonly wildcard?: boolean;
  readonly dollar?: boolean;
  readonly namespace?: boolean;
}

interface Broker {
  readonly connect: readonly Packet[];
  readonly reads: readonly {
    readonly read: string;
    readonly row: Record<string, unknown>;
    readonly completenessLast: boolean;
    readonly sent: readonly Packet[];
  }[];
  readonly refusedBeforeSend: readonly { readonly refusedBeforeSend: boolean; readonly sessionsOpened: number }[];
  readonly rawRefused: readonly {
    readonly filter: string;
    readonly messages: number;
    readonly distinctNodesNamed: number;
  }[];
  readonly rawCommand: { readonly takenByTheBroker: boolean };
  readonly retained: { readonly unchanged: boolean };
}

const BROKERS = CAPTURES.flatMap((text) =>
  Object.entries((JSON.parse(text) as { readonly brokers: Readonly<Record<string, Broker>> }).brokers),
);

describe.each(BROKERS)("%s", (_name, broker) => {
  test("connecting wrote CONNECT with Clean Start, no Will and no credential, then DISCONNECT, and nothing else", () => {
    expect(broker.connect).toEqual([
      { packet: "CONNECT", cleanStart: true, will: false, credentials: false },
      { packet: "DISCONNECT" },
    ]);
  });

  test("every read was one fresh session of Studio's own filters, with no PUBLISH and no Will", () => {
    expect(broker.reads).toHaveLength(7);
    for (const read of broker.reads) {
      expect(read.sent.map((one) => one.packet)).toEqual(["CONNECT", "SUBSCRIBE", "UNSUBSCRIBE", "DISCONNECT"]);
      expect(read.sent[0]).toMatchObject({ cleanStart: true, will: false, credentials: false });
      const subscribe = read.sent[1] as Packet;
      expect(subscribe.dollar).toBe(false);
      expect(subscribe.namespace).toBe(true);
      // The edge node and device reads name their own three topics in full, with no wildcard at all.
      if (read.read.startsWith("edge-node") || read.read.startsWith("device")) {
        expect(subscribe).toMatchObject({ filters: 3, wildcard: false });
      } else {
        expect(subscribe.filters).toBe(1);
      }
      expect(read.completenessLast).toBe(true);
      expect(read.row.scope).toBe("window");
    }
  });

  test("a seen object and a missing one answer the same columns, the miss with no last message", () => {
    const by = Object.fromEntries(broker.reads.map((read) => [read.read, read.row]));
    expect(by.window).toMatchObject({ groups_seen: 2, edge_nodes_seen: 4, devices_seen: 1, messages: 8 });
    for (const kind of ["group", "edge-node", "device"]) {
      const seen = by[`${kind}-seen`] as Record<string, unknown>;
      const missing = by[`${kind}-not-seen`] as Record<string, unknown>;
      expect(Object.keys(missing)).toEqual(Object.keys(seen));
      expect(seen).toMatchObject({ seen: true, birth_seen: true });
      expect(missing).toMatchObject({ seen: false, messages: 0, last_seen_ms: null, birth_seen: false });
    }
  });

  test("every refused request opened no session", () => {
    expect(broker.refusedBeforeSend.length).toBeGreaterThan(0);
    for (const one of broker.refusedBeforeSend)
      expect(one).toEqual({ ...one, refusedBeforeSend: true, sessionsOpened: 0 });
  });

  test("raw, the refused filters name nodes and take messages, which is why the model writes none", () => {
    const raw = Object.fromEntries(broker.rawRefused.map((one) => [one.filter, one]));
    expect(raw["wildcard-below-the-namespace"]?.distinctNodesNamed).toBeGreaterThan(0);
    expect(raw["stored-certificates"]?.messages).toBeGreaterThan(0);
    expect(raw["shared-subscription"]?.messages).toBeGreaterThan(0);
  });

  test("the broker takes a command from a client with the reader's access, and the agent reads changed no retained message", () => {
    expect(broker.rawCommand.takenByTheBroker).toBe(true);
    expect(broker.retained.unchanged).toBe(true);
  });
});

test("the capture holds no id or metric name the publisher seeded", () => {
  for (const name of ["SekoyaPlant", "AnkaraPlant", "Line1", "Press01", "Mixer1", "Temperature", "PressForce"]) {
    for (const text of CAPTURES) expect(text).not.toContain(name);
  }
  expect(BROKERS.map(([name]) => name)).toEqual(["eclipse-mosquitto:2.0.22", "emqx/emqx:5.8.9"]);
});
