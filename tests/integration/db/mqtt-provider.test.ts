/**
 * The mqtt provider, end to end over the recorded wire (#1635).
 *
 * Every capture under `tests/fixtures/mqtt/captures/` was written against a live broker in the lab: the bytes
 * in `received` are what that broker actually sent, base64 as they came off the socket. Each is replayed here
 * through the real `MqttProvider` over the session's transport seam, so the CONNECT, the SUBSCRIBE, the
 * framing, the inbound limit and the decoder all run exactly as they do in the product. The replay opens no
 * socket, so it is deterministic and needs no broker in CI. `mock.module()` is not used.
 *
 * Brokers: Mosquitto 2.1.2, HiveMQ CE and NanoMQ, each in the lab's compose fixtures.
 *
 * WHAT THE REPLAY ALSO CHECKS IS WHAT WE SENT. A recording that only replayed answers would certify nothing
 * about the read-only guarantee, so every byte the provider wrote is collected and its packet type asserted:
 * the test fails if anything but the five permitted types ever reaches the transport.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import type { MqttTransport, MqttTransportFactory } from "@/lib/db/providers/keyvalue/mqtt/session";
import type { DatabaseConnection } from "@/lib/types";

const CAPTURES = path.join(import.meta.dir, "..", "..", "fixtures", "mqtt", "captures");

interface Capture {
  readonly broker: string;
  readonly filter: string;
  readonly sent: readonly string[];
  readonly received: readonly string[];
}

function loadCaptures(): readonly Capture[] {
  const files = readdirSync(CAPTURES).filter((name) => name.endsWith(".json"));
  // A directory that lost its fixtures would make every test below iterate zero times and pass loudly.
  if (files.length === 0) throw new Error("no MQTT captures on disk, so the replay certifies nothing");
  return files.map((name) => JSON.parse(readFileSync(path.join(CAPTURES, name), "utf8")) as Capture);
}

/** Every packet type the provider wrote, in order, read from the bytes themselves. */
function writtenTypes(frames: readonly Buffer[]): number[] {
  const types: number[] = [];
  for (const frame of frames) {
    let at = 0;
    while (at + 1 < frame.length) {
      const type = (frame[at]! >> 4) & 0x0f;
      let value = 0;
      let multiplier = 1;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        const byte = frame[at + 1 + i];
        if (byte === undefined) break;
        value += (byte & 0x7f) * multiplier;
        size += 1;
        if ((byte & 0x80) === 0) break;
        multiplier *= 128;
      }
      types.push(type);
      at += 1 + size + value;
    }
  }
  return types;
}

/** The transport seam, feeding one capture's answer bytes and collecting everything written to it. */
function replay(capture: Capture, written: Buffer[]): MqttTransportFactory {
  return () => {
    const handlers = new Map<string, ((value: never) => void)[]>();
    const emit = (event: string, value?: unknown): void => {
      for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
    };
    const transport: MqttTransport = {
      write(bytes: Buffer): void {
        written.push(Buffer.from(bytes));
      },
      on(event: string, handler: (value: never) => void): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      once(event: string, handler: () => void): void {
        if (event !== "replay-ready") return;
        // The ready event fires on the next tick, as a real socket's connect does.
        queueMicrotask(() => {
          handler();
          for (const chunk of capture.received) emit("data", Buffer.from(chunk, "base64"));
          // The recorder closed the socket after its window, so the replay ends the same way.
          emit("close");
        });
      },
      destroy(): void {},
    };
    return { transport, readyEvent: "replay-ready" };
  };
}

function connection(capture: Capture): DatabaseConnection {
  return {
    id: `mqtt-${capture.broker}`,
    name: capture.broker,
    type: "mqtt",
    host: "127.0.0.1",
    port: 1883,
    database: capture.filter,
  } as unknown as DatabaseConnection;
}

/**
 * What each capture holds, spelled out so the fixtures certify a result rather than an absence.
 *
 * These are not invented: each was decoded from the capture's own bytes and read back through the real
 * provider, and they agree. NanoMQ's leading slash is the reason that capture exists: it is a legal topic
 * whose first level is empty.
 *
 * `mosquitto-rap` is the Retain As Published case and the answer is the one worth pinning: BOTH of its
 * messages arrive with the retain bit set, including the one the recording named `canli` ("live"), so both
 * are labelled `retained`. Our SUBSCRIBE clears Retain As Published, which is what a reader would expect to
 * stop this; it does not, because the bit here is the broker replaying its retained set at subscribe time.
 * A cell saying `live` for that topic would be the wrong answer, so this is what the fixture certifies.
 */
const EXPECTED: Record<string, { topics: string[]; types: Record<string, string> }> = {
  "mosquitto-2.1.2": { topics: ["fabrika/hat1/durum"], types: { "fabrika/hat1/durum": "retained" } },
  "hivemq-ce": { topics: ["yuk/bolge0/cihaz0/olcum"], types: { "yuk/bolge0/cihaz0/olcum": "retained" } },
  nanomq: { topics: ["/bastan-slash"], types: { "/bastan-slash": "retained" } },
  "mosquitto-rap": {
    topics: ["rap/canli-retain1", "rap/tutulan"],
    types: { "rap/canli-retain1": "retained", "rap/tutulan": "retained" },
  },
};

describe("the mqtt provider over each broker's recorded wire", () => {
  const captures = loadCaptures();

  test("the fixtures on disk are the brokers this file names", () => {
    expect(captures.map((capture) => capture.broker).sort()).toEqual([
      "hivemq-ce",
      "mosquitto-2.1.2",
      "mosquitto-rap",
      "nanomq",
    ]);
    for (const capture of captures) expect(capture.received.length).toBeGreaterThan(0);
  });

  for (const capture of captures) {
    describe(capture.broker, () => {
      /**
       * THE TOPICS ARE NAMED, NOT COUNTED. This asserted only `cursor === "0"`, `total === 0` and a loop over
       * `page.keys` that a zero-iteration array satisfies, so four hand-recorded broker captures certified
       * nothing beyond "it did not crash": a decoder that recorded no topic at all passed. The expectations
       * below are the topics each capture actually carries, which is what makes these files evidence.
       */
      test("the read yields the topics the capture carries, each with a type and a reason", async () => {
        const written: Buffer[] = [];
        const provider = new MqttProvider(connection(capture), {}, replay(capture, written));
        await provider.connect();
        expect(provider.isConnected()).toBe(true);

        const page = await provider.scanKeysPage!({ cursor: "0", count: 1000 });
        // The cursor always ends the walk: there is no second page to ask a broker for.
        expect(page.cursor).toBe("0");
        expect(page.total).toBe(0);

        expect([...page.keys].sort()).toEqual(EXPECTED[capture.broker]!.topics);
        for (const key of page.keys) expect(page.types[key]).toBe(EXPECTED[capture.broker]!.types[key]);

        // A read that ends because the broker hung up is `incomplete`, and it says so in its own words.
        expect(page.readOutcome?.scope).toBe("incomplete");
        expect(page.readOutcome?.endReason).toMatch(/\S/);

        await provider.disconnect();
        expect(provider.isConnected()).toBe(false);
      });

      /**
       * The claim under test is not "it did not publish this time" but "it cannot". The recorded run is one
       * witness of that, read from the bytes rather than from the provider's own account of itself.
       */
      test("every packet written is one of the five, and none is a PUBLISH", async () => {
        const written: Buffer[] = [];
        const provider = new MqttProvider(connection(capture), {}, replay(capture, written));
        await provider.connect();
        await provider.disconnect();

        const types = writtenTypes(written);
        expect(types.length).toBeGreaterThan(0);
        // 1 CONNECT, 8 SUBSCRIBE, 10 UNSUBSCRIBE, 12 PINGREQ, 14 DISCONNECT.
        for (const type of types) expect([1, 8, 10, 12, 14]).toContain(type);
        // 3 is PUBLISH. Named on its own so a failure says which packet appeared.
        expect(types).not.toContain(3);
        // The first thing on the wire is always the CONNECT.
        expect(types[0]).toBe(1);
      });

      test("the CONNECT carries no Will", async () => {
        const written: Buffer[] = [];
        const provider = new MqttProvider(connection(capture), {}, replay(capture, written));
        await provider.connect();
        await provider.disconnect();

        const connect = written[0]!;
        // After the type byte, the Remaining Length byte, the 2+4 byte protocol name and the version byte.
        const flags = connect[1 + 1 + 2 + 4 + 1]!;
        expect(flags & 0x04).toBe(0); // Will flag
        expect(flags & 0x02).toBe(0x02); // Clean Start, always
      });
    });
  }
});
