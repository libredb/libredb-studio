import { describe, expect, test } from "bun:test";

import { dialAndRead } from "@/lib/db/providers/industrial/sparkplug/index";
import type { Transport, TransportFactory } from "@/lib/db/providers/industrial/sparkplug/session";

/*
 * THE WHOLE PATH, FROM BYTES ON A WIRE TO THE STATE A PANEL ANSWERS FROM.
 *
 * It is one test file because it is one claim, and the claim is the one this provider could not make
 * until today: that a read actually reads. Every layer under it was tested on its own and the join
 * between them did not exist, so `ReadState` was built thirty-four times in this suite and never once
 * in production. A suite of green unit tests over a path nothing walks is the failure mode this file
 * is here to close.
 *
 * No socket: the session's own `openTransport` seam is filled with a script of bytes, so nothing is
 * dialled and no address is resolved.
 */

function varint(value: number): number[] {
  const out: number[] = [];
  let left = value;
  do {
    let digit = left % 128;
    left = Math.floor(left / 128);
    if (left > 0) digit |= 0x80;
    out.push(digit);
  } while (left > 0);
  return out;
}

const CONNACK = [0x20, 0x03, 0x00, 0x00, 0x00];

function publish(topic: string, payload: number[]): number[] {
  const topicBytes = [...new TextEncoder().encode(topic)];
  const body = [(topicBytes.length >> 8) & 0xff, topicBytes.length & 0xff, ...topicBytes, 0x00, ...payload];
  return [0x30, ...varint(body.length), ...body];
}

function metric(name: string, alias: number, datatype: number, longValue?: number): number[] {
  const nameBytes = [...new TextEncoder().encode(name)];
  const body = [
    0x0a,
    ...varint(nameBytes.length),
    ...nameBytes,
    0x10,
    ...varint(alias),
    0x20,
    ...varint(datatype),
    ...(longValue === undefined ? [] : [0x58, ...varint(longValue)]),
  ];
  return [0x12, ...varint(body.length), ...body];
}

/** A transport that plays a script of bytes and records what was written to it. */
function scripted(script: number[], chunkSize: number): { factory: TransportFactory; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  const handlers = new Map<string, ((value?: unknown) => void)[]>();
  const add = (event: string, handler: unknown) => {
    const list = handlers.get(event) ?? [];
    list.push(handler as (value?: unknown) => void);
    handlers.set(event, list);
  };
  const transport: Transport = {
    write(bytes) {
      written.push(Uint8Array.from(bytes));
    },
    on: (event, handler) => add(event, handler),
    once: (event, handler) => {
      add(event, handler);
      // The session writes CONNECT and SUBSCRIBE on the ready event, then the broker answers.
      queueMicrotask(() => {
        for (const one of handlers.get(event) ?? []) one();
        for (let at = 0; at < script.length; at += chunkSize) {
          const chunk = Buffer.from(Uint8Array.from(script.slice(at, at + chunkSize)));
          for (const one of handlers.get("data") ?? []) one(chunk);
        }
        for (const one of handlers.get("close") ?? []) one();
      });
    },
    destroy() {},
  };
  return { factory: () => ({ transport, readyEvent: "connect" }), written };
}

const INT64 = 4;

describe("one read, end to end, with no socket", () => {
  // Every chunk size, because a broker writes on its own boundaries and the whole path has to hold
  // when a packet's length prefix is split across two of them (KURAL 73).
  for (const chunkSize of [1, 3, 7, 64, 4096]) {
    test(`a birth and the data that follows it, fed ${chunkSize} bytes at a time`, async () => {
      const script = [
        ...CONNACK,
        ...publish("spBv1.0/G1/NBIRTH/E1", [
          0x08,
          ...varint(500),
          ...metric("bdSeq", 0, INT64, 3),
          ...metric("Temp", 11, INT64),
        ]),
        ...publish("spBv1.0/G1/NDATA/E1", [0x18, ...varint(1), ...metric("", 11, INT64, 42)]),
      ];
      const { factory, written } = scripted(script, chunkSize);

      const outcome = await dialAndRead(
        {
          host: "broker.example",
          port: 1883,
          groupId: "G1",
          filters: ["spBv1.0/G1/#"],
          windowSeconds: 1,
        },
        factory,
      );

      // The state the panels answer from was built from bytes, which is the claim.
      const nodes = outcome.state.all();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.groupId).toBe("G1");
      expect(nodes[0]?.birth?.bdSeq).toBe("3");
      expect(nodes[0]?.birth?.metrics.map((one) => one.name)).toEqual(["bdSeq", "Temp"]);
      expect(outcome.messagesSeen).toBe(2);
      // The broker closed the script, so that is the reason, and it is not a dial failure.
      expect(outcome.endReason).toBe("broker-closed");
      // And the read left nothing behind: it subscribed, unsubscribed and disconnected.
      expect(written.length).toBeGreaterThanOrEqual(4);
    });
  }

  test("a broker that REFUSES EVERY SUBSCRIPTION is not a quiet plant", async () => {
    /*
     * THE CONFLATION THIS TEST EXISTS FOR, and it was the default rather than an edge case. Nothing
     * read SUBACK at all: every packet that was not a publish was dropped, so a broker that refused
     * every filter produced the same outcome as a broker with nothing to say - zero rows, ended on
     * the time budget. The shipped MQTT guide measured a stock EMQX 5.8.9 refusing `#`, `+/#` and
     * `$SYS/#` out of the box with SUBACK 135, and `#` is the filter a Sparkplug read uses when no
     * group is named. So this reader reported a quiet plant where the truth was "you were refused".
     */
    // SUBACK: packet id 1, no properties, one reason code of 0x87 (not authorized).
    const SUBACK_REFUSED = [0x90, 0x04, 0x00, 0x01, 0x00, 0x87];
    const { factory } = scripted([...CONNACK, ...SUBACK_REFUSED], 4096);

    const outcome = await dialAndRead(
      { host: "broker.example", port: 1883, groupId: "G1", filters: ["spBv1.0/G1/#"], windowSeconds: 1 },
      factory,
    );
    expect(outcome.endReason).toBe("subscription-refused");
    expect(outcome.refusalCode).toBe(0x87);
  });

  test("ONE filter refused out of several is a thinner read, not a refused one", async () => {
    // The other side of the threshold, and it is the common case: a broker with no `$sparkplug` tree
    // refuses the stored-certificate filter and grants the ordinary one. That read still happens.
    const SUBACK_MIXED = [0x90, 0x05, 0x00, 0x01, 0x00, 0x00, 0x87];
    const { factory } = scripted([...CONNACK, ...SUBACK_MIXED], 4096);

    const outcome = await dialAndRead(
      {
        host: "broker.example",
        port: 1883,
        groupId: "G1",
        filters: ["spBv1.0/G1/#", "$sparkplug/certificates/spBv1.0/G1/#"],
        windowSeconds: 1,
      },
      factory,
    );
    expect(outcome.endReason).not.toBe("subscription-refused");
    expect(outcome.refusalCode).toBeUndefined();
  });

  test("a broker that announces NO WILDCARDS is refused at CONNACK, before the SUBACK says it", async () => {
    /*
     * The one CONNACK property that can decide a Sparkplug read, and the other three are measured
     * out rather than skipped: `maximumQoS` cannot bite because every subscription here is QoS 0,
     * a granted QoS below the requested one is impossible for the same reason, and `retainAvailable`
     * is about retained messages while a Sparkplug birth is published at QoS 0 and not retained.
     */
    // CONNACK with reason 0 and property 0x28 (Wildcard Subscription Available) set to 0.
    const CONNACK_NO_WILDCARD = [0x20, 0x05, 0x00, 0x00, 0x02, 0x28, 0x00];
    const { factory } = scripted(CONNACK_NO_WILDCARD, 4096);

    const outcome = await dialAndRead(
      { host: "broker.example", port: 1883, groupId: "", filters: ["spBv1.0/#"], windowSeconds: 1 },
      factory,
    );
    expect(outcome.endReason).toBe("wildcards-unavailable");
  });

  test("a broker that says wildcards ARE available reads normally", async () => {
    // The other side: the property present and true must not be read as a refusal.
    const CONNACK_WILDCARD_OK = [0x20, 0x05, 0x00, 0x00, 0x02, 0x28, 0x01];
    const { factory } = scripted(
      [...CONNACK_WILDCARD_OK, ...publish("spBv1.0/G1/NBIRTH/E1", [...metric("Temp", 1, INT64)])],
      4096,
    );
    const outcome = await dialAndRead(
      { host: "broker.example", port: 1883, groupId: "", filters: ["spBv1.0/#"], windowSeconds: 1 },
      factory,
    );
    expect(outcome.endReason).not.toBe("wildcards-unavailable");
    expect(outcome.state.all()).toHaveLength(1);
  });

  test("the refusal threshold is held from BOTH sides, at 0x80 and at 0x02", async () => {
    /*
     * A MUTATION ESCAPED AND THIS IS WHY IT EXISTS. Moving the threshold from `>= 0x80` to `>= 0x81`
     * broke nothing, because every test used 0x87. MQTT 5.0 3.9.3 makes 0x80 "Unspecified error" a
     * refusal and anything below 0x80 the QoS the broker granted, so a broker answering 0x80 would
     * have been read as a granted subscription and its silence reported as a quiet plant.
     */
    for (const [code, refused] of [
      [0x80, true],
      [0x02, false],
    ] as const) {
      const { factory } = scripted([...CONNACK, 0x90, 0x04, 0x00, 0x01, 0x00, code], 4096);
      const outcome = await dialAndRead(
        { host: "broker.example", port: 1883, groupId: "G1", filters: ["spBv1.0/G1/#"], windowSeconds: 1 },
        factory,
      );
      expect(outcome.endReason === "subscription-refused", `reason code ${code}`).toBe(refused);
    }
  });

  test("a broker that REFUSES THE CONNECTION says so, rather than closing quietly", async () => {
    // A refused CONNECT closes the socket afterwards, so this used to arrive as `broker-closed`:
    // the same value a broker that accepted the read and then went away produces.
    const CONNACK_REFUSED = [0x20, 0x03, 0x00, 0x87, 0x00];
    const { factory } = scripted(CONNACK_REFUSED, 4096);

    const outcome = await dialAndRead(
      { host: "broker.example", port: 1883, groupId: "", filters: ["spBv1.0/#"], windowSeconds: 1 },
      factory,
    );
    expect(outcome.endReason).toBe("connect-refused");
    expect(outcome.refusalCode).toBe(0x87);
  });

  test("a frame this reader cannot parse is FRAME-REFUSED, not a dial failure", async () => {
    /*
     * THE OTHER HALF OF THE SPLIT, AND IT HAD NO TEST. Separating `dial-failed` from `frame-refused`
     * was only asserted from the dial side: swapping the parser's error to `dial-failed` left every
     * test green, so nothing held the frame side of the distinction it exists for. The connection
     * worked here and one frame in it did not, which is a different thing from a socket that never
     * opened, and the two send a reader to different places.
     */
    // Packet type 0 is reserved (MQTT 5.0 2.1.2), so the parser refuses the frame rather than the
    // connection. The CONNACK before it proves the connection itself was fine.
    const { factory } = scripted([...CONNACK, 0x00, 0x00], 4096);

    const outcome = await dialAndRead(
      { host: "broker.example", port: 1883, groupId: "", filters: ["spBv1.0/#"], windowSeconds: 1 },
      factory,
    );
    expect(outcome.endReason).toBe("frame-refused");
  });

  test("a socket that errors is a DIAL FAILURE and not an empty read", async () => {
    const handlers = new Map<string, ((value?: unknown) => void)[]>();
    const add = (event: string, handler: unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler as (value?: unknown) => void);
      handlers.set(event, list);
    };
    const transport: Transport = {
      write() {},
      on: (event, handler) => add(event, handler),
      once: (event, handler) => {
        add(event, handler);
        queueMicrotask(() => {
          for (const one of handlers.get("error") ?? []) one(new Error("ECONNREFUSED"));
        });
      },
      destroy() {},
    };

    const outcome = await dialAndRead(
      { host: "broker.example", port: 1883, groupId: "", filters: ["spBv1.0/#"], windowSeconds: 1 },
      () => ({ transport, readyEvent: "connect" }),
    );
    expect(outcome.endReason).toBe("dial-failed");
    expect(outcome.messagesSeen).toBe(0);
  });
});
