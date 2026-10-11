/**
 * What this provider actually puts on the wire (`docs/providers/mqtt.md` sections 3.1, 3.2, 3.5 and 3.6).
 *
 * THESE TESTS WERE WRITTEN AFTER AN AUDIT FOUND THEM MISSING. Three broken implementations passed the whole
 * suite before this file existed: one with the valve deleted from the write path, one that ignored the
 * reader's topic filter and subscribed to everything, and one that subscribed at QoS 1, which this provider
 * can never acknowledge, so every read would stall. All three are on-wire facts, so they are asserted from
 * the bytes the session wrote rather than from the provider's account of itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { QueryError } from "@/lib/db/errors";
import { MQTT_KEEP_ALIVE_SECONDS } from "@/lib/db/providers/keyvalue/mqtt/constants";
import {
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodeSubscribe,
  encodeUnsubscribe,
} from "@/lib/db/providers/keyvalue/mqtt/encoder";
import {
  readTopics,
  writeToTransport,
  type MqttTransport,
  type MqttTransportFactory,
} from "@/lib/db/providers/keyvalue/mqtt/session";

const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);
const SUBACK = Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00]);

/** A transport that answers a fixed script and keeps every byte written to it. */
function recording(written: Buffer[]): MqttTransportFactory {
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
        if (event !== "ready") return;
        queueMicrotask(() => {
          handler();
          emit("data", CONNACK);
          emit("data", SUBACK);
          emit("close");
        });
      },
      destroy(): void {},
    };
    return { transport, readyEvent: "ready" };
  };
}

/** The first SUBSCRIBE among the written frames, split into its filters and their options byte. */
function subscriptions(written: readonly Buffer[]): { filters: string[]; options: number[] } {
  const filters: string[] = [];
  const options: number[] = [];
  for (const frame of written) {
    if (((frame[0] as number) >> 4) & 0x0f) {
      // Walk the frame's packets; a SUBSCRIBE is type 8.
      let at = 0;
      while (at + 1 < frame.length) {
        const type = ((frame[at] as number) >> 4) & 0x0f;
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
        const body = frame.subarray(at + 1 + size, at + 1 + size + value);
        if (type === 8) {
          // Packet identifier (2), then the property length (a Variable Byte Integer, 0 here), then pairs.
          let p = 2;
          p += 1; // the empty property block
          while (p + 1 < body.length) {
            const length = ((body[p] as number) << 8) | (body[p + 1] as number);
            filters.push(body.subarray(p + 2, p + 2 + length).toString("utf8"));
            options.push(body[p + 2 + length] as number);
            p += 2 + length + 1;
          }
        }
        at += 1 + size + value;
      }
    }
  }
  return { filters, options };
}

const CONNECTION = { host: "127.0.0.1", port: 1883, tls: false } as const;

describe("the SUBSCRIBE carries the reader's own filter", () => {
  /**
   * An implementation that ignored the filter and sent `#` would read the whole broker: every device's
   * topics, on a connection the reader scoped to one branch. It is also the one mistake that cannot be seen
   * on screen, because a wider read looks like a fuller tree.
   */
  test("the filter the connection names is the filter sent", async () => {
    for (const filter of ["plant/line1/#", "sensors/+/temperature", "one/exact/topic"]) {
      const written: Buffer[] = [];
      await readTopics({ ...CONNECTION, filter, openTransport: recording(written) });
      expect(subscriptions(written).filters).toEqual([filter]);
    }
  });

  test("an empty filter sends `#`, and nothing wider exists to send", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "", openTransport: recording(written) });
    expect(subscriptions(written).filters).toEqual(["#"]);
  });

  test("exactly one SUBSCRIBE is sent per read", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "a/#", openTransport: recording(written) });
    expect(subscriptions(written).filters).toHaveLength(1);
  });
});

describe("the subscription options byte", () => {
  /**
   * QoS 0 IS A REQUIREMENT, NOT A PREFERENCE. At QoS 1 the receiver MUST answer each message with a PUBACK,
   * and at QoS 2 with PUBREC and PUBCOMP (section 4.3). This provider's encoder cannot write any of those, so
   * a higher QoS would stall the read rather than fail visibly: the broker would wait for an acknowledgement
   * that can never come.
   */
  test("it is exactly 0x04: QoS 0, No Local set, Retain As Published clear, Retain Handling 0", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "#", openTransport: recording(written) });
    const { options } = subscriptions(written);
    expect(options).toEqual([0x04]);
    const byte = options[0] as number;
    expect(byte & 0x03).toBe(0); // Maximum QoS
    expect((byte >> 2) & 0x01).toBe(1); // No Local
    expect((byte >> 3) & 0x01).toBe(0); // Retain As Published
    expect((byte >> 4) & 0x03).toBe(0); // Retain Handling: send the retained set at subscribe time
  });
});

describe("the valve cannot be bypassed", () => {
  /**
   * The valve being present is not the same as the valve being in the write path. An implementation that
   * kept `guardOutboundPacket` and simply stopped calling it passed every other test, because the session
   * only ever produces legal packets anyway. These two tests pin the wiring itself.
   */
  test("the one write function guards before it writes", () => {
    const written: Buffer[] = [];
    const transport: MqttTransport = {
      write: (bytes: Buffer) => written.push(Buffer.from(bytes)),
      on: () => {},
      once: () => {},
      destroy: () => {},
    };
    // A PUBLISH, type 3, hand-encoded because our encoder cannot produce one.
    const publish = Uint8Array.from([0x30, 0x04, 0x00, 0x01, 0x61, 0x62]);
    expect(() => writeToTransport(transport, publish)).toThrow(QueryError);
    expect(() => writeToTransport(transport, publish)).toThrow(/read only/);
    // Refused before the transport saw it, not after.
    expect(written).toHaveLength(0);
  });

  test("the provider's own source has no write of its own beside that function", () => {
    // THE SWEEP IS THE WHOLE DIRECTORY, NOT ONE FILE. It read `session.ts` alone until an audit pointed out
    // that a `.write(` added in `key-scan.ts`, `index.ts` or anywhere else beside it would pass unseen.
    const dir = path.join(import.meta.dir, "..", "..", "..", "..", "src", "lib", "db", "providers", "keyvalue", "mqtt");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(4);

    let sites = 0;
    for (const name of files) {
      // Comments are stripped first: a doc comment naming the rule is not a call site, and counting one
      // would make this test pass or fail on prose.
      const code = readFileSync(path.join(dir, name), "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        .replaceAll(/\/\/.*$/gm, "");
      sites += (code.match(/\.write\(/g) ?? []).length;
    }
    expect(sites).toBe(1);

    // And the guard is the line above the one that exists.
    const session = readFileSync(path.join(dir, "session.ts"), "utf8");
    const guarded = /guardOutboundPacket\(bytes\);\s*\n\s*transport\.write\(/.test(session);
    expect(guarded).toBe(true);
  });
});

/**
 * The decoder dependency, asserted from the module the provider actually loads.
 *
 * THIS FILE'S DOCBLOCK ONCE CLAIMED THE WRITER WAS ABSENT WHILE THE CODE IMPORTED IT. `session.ts` read
 * `import("mqtt-packet")`, whose root re-exports `generate` and `writeToStream`, so a PUBLISH was one call
 * away in an already-evaluated module, and three separate audits had to load the package by hand to see it.
 * A sentence in a comment is not a guarantee; this is.
 */
describe("the decoder is loaded by a specifier that carries no writer", () => {
  test("the parser subpath exports a parser and neither writer", async () => {
    const loaded = (await import("mqtt-packet/parser.js")) as unknown as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const member = (name: string): unknown => loaded[name] ?? loaded.default?.[name];

    expect(typeof member("parser")).toBe("function");
    expect(member("generate")).toBeUndefined();
    expect(member("writeToStream")).toBeUndefined();
  });

  /**
   * The control, and the reason the specifier matters: the ROOT does carry both, so this is a real
   * difference between two import paths rather than a property of the package as a whole.
   */
  test("the package root carries both writers, which is what the subpath avoids", async () => {
    const root = (await import("mqtt-packet")) as unknown as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const member = (name: string): unknown => root[name] ?? root.default?.[name];

    expect(typeof member("generate")).toBe("function");
    expect(typeof member("writeToStream")).toBe("function");
  });

  test("the session imports the subpath and never the root", () => {
    const source = readFileSync(
      path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "src",
        "lib",
        "db",
        "providers",
        "keyvalue",
        "mqtt",
        "session.ts",
      ),
      "utf8",
    );
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
    expect(code).toContain('import("mqtt-packet/parser.js")');
    expect(code.match(/import\("mqtt-packet"\)/g)).toBeNull();
  });
});

/**
 * The CONNECT, decoded field by field from the bytes the session wrote.
 *
 * THREE OF THESE BYTES WERE UNGUARDED UNTIL A MUTATION RUN FOUND THEM. The suite asserted the flags byte and
 * nothing else of the packet, so the protocol version could go 5 to 4, and the Session Expiry Interval 0 to
 * 60, with all forty-eight thousand tests green - while a real broker answered CONNACK 0x01 to the first and
 * silently queued messages for a session that is never coming back on the second. Neither is reachable from
 * a replayed capture, because a capture records what a correct CONNECT produced.
 */
describe("the CONNECT, field by field", () => {
  /** The first CONNECT among the written frames, split into the fields section 3.1 defines. */
  function connectPacket(written: readonly Buffer[]): {
    protocolName: string;
    protocolVersion: number;
    flags: number;
    keepAlive: number;
    properties: Buffer;
    clientId: string;
  } {
    const frame = written.find((bytes) => (((bytes[0] as number) >> 4) & 0x0f) === 1);
    if (frame === undefined) throw new Error("no CONNECT was written");

    let value = 0;
    let multiplier = 1;
    let size = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = frame[1 + i] as number;
      value += (byte & 0x7f) * multiplier;
      size += 1;
      if ((byte & 0x80) === 0) break;
      multiplier *= 128;
    }
    const body = frame.subarray(1 + size, 1 + size + value);
    // The whole packet is exactly its header plus its declared length, with nothing trailing.
    expect(frame).toHaveLength(1 + size + value);

    const nameLength = ((body[0] as number) << 8) | (body[1] as number);
    let at = 2 + nameLength;
    const protocolName = body.subarray(2, at).toString("utf8");
    const protocolVersion = body[at] as number;
    const flags = body[at + 1] as number;
    const keepAlive = ((body[at + 2] as number) << 8) | (body[at + 3] as number);
    at += 4;

    let properties = 0;
    let propertyMultiplier = 1;
    let propertySize = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = body[at + i] as number;
      properties += (byte & 0x7f) * propertyMultiplier;
      propertySize += 1;
      if ((byte & 0x80) === 0) break;
      propertyMultiplier *= 128;
    }
    at += propertySize;
    const propertyBlock = body.subarray(at, at + properties);
    at += properties;

    const idLength = ((body[at] as number) << 8) | (body[at + 1] as number);
    const clientId = body.subarray(at + 2, at + 2 + idLength).toString("utf8");

    return { protocolName, protocolVersion, flags, keepAlive, properties: propertyBlock, clientId };
  }

  /**
   * VERSION 5 IS NOT A PREFERENCE EITHER. The parser is built with `protocolVersion: 5`, and a version-4
   * CONNECT answered by a version-4 broker would be decoded as version 5: the property blocks this provider
   * reads (Message Expiry, the CONNACK reason code's own properties) do not exist in 3.1.1, so every packet
   * after the handshake would be misframed.
   */
  test("it declares MQTT version 5 and the protocol name the specification fixes", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "#", openTransport: recording(written) });
    const connect = connectPacket(written);
    expect(connect.protocolName).toBe("MQTT");
    expect(connect.protocolVersion).toBe(5);
  });

  /**
   * CLEAN START SET AND WILL CLEAR, read as bits rather than as the byte, so a failure names which one moved.
   * A Will is the one way a CONNECT can make a broker publish on our behalf, and `encodeConnect` has no
   * parameter that could set one - this asserts the result of that on the wire.
   */
  test("Clean Start is set, and every flag that would make the broker write for us is clear", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "#", openTransport: recording(written) });
    const { flags } = connectPacket(written);
    expect((flags >> 1) & 0x01).toBe(1); // Clean Start
    expect((flags >> 2) & 0x01).toBe(0); // Will Flag
    expect((flags >> 3) & 0x03).toBe(0); // Will QoS
    expect((flags >> 5) & 0x01).toBe(0); // Will Retain
    expect(flags & 0x01).toBe(0); // Reserved, which a broker MUST reject if set
  });

  /**
   * SESSION EXPIRY ZERO IS A SAFETY PROPERTY, NOT A DEFAULT. A session left behind makes the broker hold a
   * subscription and queue messages for a client that is not coming back, and on a broker with a message
   * limit that queue is where a device's messages go instead of to the device. Property 0x11, four bytes.
   */
  test("it declares a Session Expiry Interval of zero, so nothing is left behind", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "#", openTransport: recording(written) });
    const { properties } = connectPacket(written);
    expect(properties[0]).toBe(0x11);
    expect(properties.readUInt32BE(1)).toBe(0);
    // And it is the only property declared, so nothing else rides along unread.
    expect(properties).toHaveLength(5);
  });

  test("the client id is the one this session generated, carried whole", async () => {
    const written: Buffer[] = [];
    await readTopics({ ...CONNECTION, filter: "#", openTransport: recording(written) });
    const { clientId, keepAlive } = connectPacket(written);
    expect(clientId).toMatch(/^libredb-[0-9a-f]{16}$/);
    expect(keepAlive).toBe(MQTT_KEEP_ALIVE_SECONDS);
  });
});

/**
 * The fixed-header reserved bits, which the specification does not treat as decoration.
 *
 * [MQTT-3.8.1-1] and [MQTT-3.10.1-1]: the SUBSCRIBE and UNSUBSCRIBE fixed headers reserve the low nibble and
 * a server "MUST close the Network Connection" on any other value. Zeroing it passed the whole suite, because
 * every test fed our bytes back through our own reader, which has no reason to look. A real broker would have
 * hung up on the first subscription with no sentence either side could explain.
 */
describe("the reserved bits of the fixed header", () => {
  test("SUBSCRIBE is 0x82, not 0x80", () => {
    const bytes = encodeSubscribe(1, ["sensors/#"]);
    expect(bytes[0]).toBe(0x82);
    expect((bytes[0] as number) & 0x0f).toBe(0x02);
  });

  test("UNSUBSCRIBE is 0xa2, not 0xa0", () => {
    const bytes = encodeUnsubscribe(1, ["sensors/#"]);
    expect(bytes[0]).toBe(0xa2);
    expect((bytes[0] as number) & 0x0f).toBe(0x02);
  });

  /** The three that reserve zero, asserted together so the rule is visible as a rule. */
  test("CONNECT, PINGREQ and DISCONNECT reserve zero", () => {
    expect(encodeConnect({ clientId: "libredb-test", keepAliveSeconds: 60 })[0]).toBe(0x10);
    expect(encodePingReq()[0]).toBe(0xc0);
    expect(encodeDisconnect()[0]).toBe(0xe0);
  });
});
