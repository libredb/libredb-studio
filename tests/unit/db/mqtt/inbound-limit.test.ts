/**
 * The inbound size limit over a real byte stream (`docs/providers/mqtt.md` section 3.3).
 *
 * THESE TESTS EXIST BECAUSE THE FIRST IMPLEMENTATION PASSED EVERY OTHER TEST AND STILL BROKE. An oversized
 * packet is almost never in one chunk: a multi-megabyte body arrives over many `data` events, and the body of
 * a PUBLISH is arbitrary bytes that frame as plausible packets. The first version dropped its buffer and
 * resumed at the next byte, which read a payload as protocol and killed the whole read with an error naming a
 * PUBACK header flag, blaming the broker for a packet it had sent correctly.
 *
 * So every test here drives the real `readTopics` over the transport seam with the body split across chunks,
 * and asserts the two things that matter: a correctly sent message AFTER the skipped one still decodes, and
 * the skip is reported rather than hidden.
 */
import { describe, expect, test } from "bun:test";
import {
  MQTT_KEEP_ALIVE_SECONDS,
  MQTT_MAX_INBOUND_BYTES,
  MQTT_PING_INTERVAL_MS,
} from "@/lib/db/providers/keyvalue/mqtt/constants";
import { encodeString, encodeVariableByteInteger } from "@/lib/db/providers/keyvalue/mqtt/encoder";
import {
  readTopics,
  skipSentence,
  topicOfSkippedPublish,
  type MqttTransport,
  type MqttTransportFactory,
} from "@/lib/db/providers/keyvalue/mqtt/session";

/** A CONNACK the session accepts: reason code 0, no properties. */
const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);
/** A SUBACK granting QoS 0 for one filter. */
const SUBACK = Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00]);

/** A PUBLISH of the given topic and payload, retained, QoS 0, no properties. */
function publish(topic: string, payload: string): Buffer {
  const body = Buffer.concat([Buffer.from(encodeString(topic)), Buffer.from([0x00]), Buffer.from(payload, "utf8")]);
  return Buffer.concat([Buffer.from([0x31]), Buffer.from(encodeVariableByteInteger(body.length)), body]);
}

/**
 * The HEADER of a PUBLISH that declares a body far larger than the limit, and the body bytes separately.
 *
 * The body is deliberately a run of `0x30` bytes, which is a PUBLISH's own first byte: an implementation that
 * resumes framing inside the body will read these as packets, which is exactly the fault being pinned.
 */
function oversizePublish(topic: string, declaredBody: number): { header: Buffer; body: Buffer } {
  const topicBytes = Buffer.from(encodeString(topic));
  const remaining = topicBytes.length + 1 + declaredBody;
  const header = Buffer.concat([
    Buffer.from([0x31]),
    Buffer.from(encodeVariableByteInteger(remaining)),
    topicBytes,
    Buffer.from([0x00]),
  ]);
  return { header, body: Buffer.alloc(declaredBody, 0x30) };
}

/** A transport that hands the session a scripted sequence of chunks, one per tick. */
function scripted(chunks: readonly Buffer[]): MqttTransportFactory {
  return () => {
    const handlers = new Map<string, ((value: never) => void)[]>();
    const emit = (event: string, value?: unknown): void => {
      for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
    };
    const transport: MqttTransport = {
      write(): void {},
      on(event: string, handler: (value: never) => void): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      once(event: string, handler: () => void): void {
        if (event !== "ready") return;
        queueMicrotask(() => {
          handler();
          for (const chunk of chunks) emit("data", chunk);
          emit("close");
        });
      },
      destroy(): void {},
    };
    return { transport, readyEvent: "ready" };
  };
}

const CONNECTION = { host: "127.0.0.1", port: 1883, tls: false, filter: "#" } as const;

describe("an oversized packet whose body spans chunks", () => {
  const declared = MQTT_MAX_INBOUND_BYTES + 100;
  const big = oversizePublish("big/one", declared);

  /**
   * The regression this file was written for. The body arrives in three chunks after the header, and a
   * correctly sent PUBLISH follows it.
   */
  test("the read survives, the message after it decodes, and the skip is reported", async () => {
    const third = Math.floor(declared / 3);
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([
        CONNACK,
        SUBACK,
        Buffer.concat([big.header, big.body.subarray(0, third)]),
        big.body.subarray(third, third * 2),
        Buffer.concat([big.body.subarray(third * 2), publish("small/after", "OK")]),
      ]),
    });

    // The whole point: the message sent AFTER the skipped one is still read.
    expect([...read.topics.keys()]).toEqual(["small/after"]);
    expect(read.topics.get("small/after")?.payloadBytes).toBe(2);
    // The oversized one is never in the tree, because its body was never allocated.
    expect(read.topics.has("big/one")).toBe(false);
    // And the loss is stated, with the branch it belongs to.
    expect(read.scope).toBe("incomplete");
    expect(read.provenLoss).toHaveLength(1);
    expect(read.provenLoss[0]).toContain("big/one");
    // The number in the sentence is the packet's own Remaining Length, which carries the topic and the
    // property byte as well as the body, so it is larger than the body we declared rather than equal to it.
    const reported = Number(/([\d,]{7,})/.exec(read.provenLoss[0] as string)?.[1]?.replaceAll(",", ""));
    expect(reported).toBeGreaterThan(declared);
    expect(reported).toBeLessThan(declared + 100);
  });

  test("the body is never held: a 8 MiB skip does not grow the heap by its size", async () => {
    // Both samples are taken after a collection, because an uncollected allocation from an earlier test in
    // this file would otherwise be counted as growth here and make the one memory assertion in the suite
    // depend on timing rather than on the session.
    const collect = (): void => {
      if (typeof Bun !== "undefined") Bun.gc(true);
    };
    collect();
    const before = process.memoryUsage().heapUsed;
    await readTopics({
      ...CONNECTION,
      openTransport: scripted([
        CONNACK,
        SUBACK,
        Buffer.concat([big.header, big.body.subarray(0, 1024)]),
        big.body.subarray(1024),
        publish("small/after", "OK"),
      ]),
    });
    collect();
    const grew = process.memoryUsage().heapUsed - before;
    // The chunks themselves exist in the test, so this bounds what the SESSION retained, not what we built.
    expect(grew).toBeLessThan(declared);
  });

  test("a body arriving in one chunk with the header behaves the same way", async () => {
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([CONNACK, SUBACK, Buffer.concat([big.header, big.body, publish("small/after", "OK")])]),
    });
    expect([...read.topics.keys()]).toEqual(["small/after"]);
    expect(read.provenLoss).toHaveLength(1);
  });

  test("two oversized packets are both reported, not collapsed into one", async () => {
    const second = oversizePublish("big/two", declared);
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([
        CONNACK,
        SUBACK,
        Buffer.concat([big.header, big.body]),
        Buffer.concat([second.header, second.body, publish("small/after", "OK")]),
      ]),
    });
    expect(read.provenLoss).toHaveLength(2);
    expect(read.provenLoss.join(" ")).toContain("big/one");
    expect(read.provenLoss.join(" ")).toContain("big/two");
    expect([...read.topics.keys()]).toEqual(["small/after"]);
  });
});

describe("an ordinary read over the same seam", () => {
  test("messages decode, and a read with no loss says so by carrying none", async () => {
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([CONNACK, SUBACK, publish("a/b", "1"), publish("c/d", "22")]),
    });
    expect([...read.topics.keys()].sort()).toEqual(["a/b", "c/d"]);
    expect(read.topics.get("c/d")?.payloadBytes).toBe(2);
    expect(read.topics.get("a/b")?.retained).toBe(true);
    expect(read.provenLoss).toEqual([]);
    expect(read.messages).toBe(2);
  });

  /**
   * A PUBLISH split across two chunks is the ordinary case on any real connection, and the framer has to
   * wait rather than read half a packet.
   */
  test("a message split across chunks is assembled, not dropped", async () => {
    const whole = publish("split/topic", "0123456789");
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([CONNACK, SUBACK, whole.subarray(0, 6), whole.subarray(6)]),
    });
    expect([...read.topics.keys()]).toEqual(["split/topic"]);
    expect(read.topics.get("split/topic")?.payloadBytes).toBe(10);
  });

  test("the SUBACK's refusal ends the read, and no topic lands after it", async () => {
    const refused = Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x87]);
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([CONNACK, refused, publish("never/seen", "x")]),
    });
    expect(read.endReason).toBe("subscription-refused");
    expect(read.scope).toBe("incomplete");
    // The read ended before this arrived, so a tree that showed it would contradict its own sentence.
    expect([...read.topics.keys()]).toEqual([]);
  });

  test("a non-zero CONNACK fails the read, naming the code", async () => {
    const refused = Buffer.from([0x20, 0x03, 0x00, 0x87, 0x00]);
    await expect(readTopics({ ...CONNECTION, openTransport: scripted([refused]) })).rejects.toThrow(/135/);
  });

  test("a stream that stops being MQTT fails the read rather than looping", async () => {
    // Five continuation bytes: a Variable Byte Integer is four at most.
    const broken = Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    await expect(readTopics({ ...CONNECTION, openTransport: scripted([CONNACK, SUBACK, broken]) })).rejects.toThrow(
      /no longer MQTT/,
    );
  });
});

describe("the sentence for a skipped message", () => {
  test("a PUBLISH header gives its topic", () => {
    const big = oversizePublish("plant/line1/photo", 99);
    const bytes = Buffer.concat([big.header, big.body]);
    const verdict = { size: bytes.length, bytes: 99 + "plant/line1/photo".length + 3, packetType: 3 };
    expect(topicOfSkippedPublish(bytes, verdict)).toBe("plant/line1/photo");
  });

  test("a packet that is not a PUBLISH names no topic rather than guessing", () => {
    expect(
      topicOfSkippedPublish(Buffer.from([0x90, 0x02, 0x00, 0x01]), { size: 4, bytes: 2, packetType: 9 }),
    ).toBeUndefined();
  });

  test("a header that has not fully arrived names no topic", () => {
    const big = oversizePublish("a/b", 50);
    const verdict = { size: big.header.length + 50, bytes: 50 + 6, packetType: 3 };
    expect(topicOfSkippedPublish(big.header.subarray(0, 3), verdict)).toBeUndefined();
  });

  test("the sentence always carries the size, and says so when it cannot name the branch", () => {
    expect(skipSentence(9_437_194, "big/one")).toContain('"big/one"');
    expect(skipSentence(9_437_194, "big/one")).toContain("9,437,194");
    const nameless = skipSentence(9_437_194, undefined);
    expect(nameless).toContain("9,437,194");
    expect(nameless).toMatch(/cannot be named/);
  });
});

describe("the paths a read reaches only when something is wrong", () => {
  /**
   * A topic that is not UTF-8 text has no name a sentence could carry: decoded with replacement characters it
   * would name a DIFFERENT topic, and a loss reported against the wrong branch is worse than one reported
   * against none.
   */
  test("an oversized message on a non-text topic is reported without naming a branch", async () => {
    const declared = MQTT_MAX_INBOUND_BYTES + 10;
    // A lone continuation byte: valid as bytes, not valid as UTF-8.
    const topicBytes = Buffer.from([0x00, 0x03, 0xff, 0xfe, 0xfd]);
    const remaining = topicBytes.length + 1 + declared;
    const header = Buffer.concat([
      Buffer.from([0x31]),
      Buffer.from(encodeVariableByteInteger(remaining)),
      topicBytes,
      Buffer.from([0x00]),
    ]);
    const read = await readTopics({
      ...CONNECTION,
      openTransport: scripted([
        CONNACK,
        SUBACK,
        Buffer.concat([header, Buffer.alloc(declared, 0x30)]),
        publish("after/it", "OK"),
      ]),
    });
    expect(read.provenLoss).toHaveLength(1);
    expect(read.provenLoss[0]).toMatch(/cannot be named/);
    expect([...read.topics.keys()]).toEqual(["after/it"]);
  });

  /**
   * A packet that frames correctly and is still not readable: a PUBACK whose header flag bits are not zero,
   * which the standard forbids. The framer cannot see it, so the decoder is the only thing that can, and the
   * read has to fail rather than carry on against a stream it is misreading.
   */
  test("a packet the decoder rejects fails the read, quoting the decoder", async () => {
    const badPuback = Buffer.from([0x41, 0x02, 0x00, 0x01]);
    await expect(readTopics({ ...CONNECTION, openTransport: scripted([CONNACK, SUBACK, badPuback]) })).rejects.toThrow(
      /cannot read/,
    );
  });
});

describe("the keep-alive", () => {
  /**
   * The interval fires half a Keep Alive apart, which no three-second read reaches, so the callback is named
   * in the session and run here. A broker drops a client that has been silent for one and a half Keep Alive
   * periods, and a long read with no ping is dropped by the broker rather than ended by us.
   */
  test("it is half the declared Keep Alive, so one lost ping does not end the session", () => {
    expect(MQTT_PING_INTERVAL_MS).toBe((MQTT_KEEP_ALIVE_SECONDS * 1000) / 2);
    expect(MQTT_PING_INTERVAL_MS).toBeLessThan(MQTT_KEEP_ALIVE_SECONDS * 1000);
  });

  test("a PINGREQ goes out while a read is open, and none after it ends", async () => {
    const written: Buffer[] = [];
    const factory = (): { transport: MqttTransport; readyEvent: string } => {
      const handlers = new Map<string, ((value: never) => void)[]>();
      const emit = (event: string, value?: unknown): void => {
        for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
      };
      const transport: MqttTransport = {
        write: (bytes: Buffer) => written.push(Buffer.from(bytes)),
        on: (event: string, handler: (value: never) => void) => {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        once: (event: string, handler: () => void) => {
          if (event !== "ready") return;
          queueMicrotask(() => {
            handler();
            emit("data", CONNACK);
            emit("data", SUBACK);
            // The read stays open: no close, so the time budget ends it and the interval fires meanwhile.
          });
        },
        destroy: () => {},
      };
      return { transport, readyEvent: "ready" };
    };
    const read = await readTopics({ ...CONNECTION, openTransport: factory, pingEveryMs: 40 });
    expect(read.endReason).toBe("budget-time");

    // PINGREQ is packet type 12. A three-second read at forty milliseconds sends many.
    const pings = written.filter((frame) => (frame[0] as number) >> 4 === 12);
    expect(pings.length).toBeGreaterThan(5);
    // Each is the whole packet and nothing more: two bytes, type 12, zero remaining length.
    for (const ping of pings) expect([...ping]).toEqual([0xc0, 0x00]);

    // And none after the read ended: the last frame written is the DISCONNECT, type 14.
    expect(((written[written.length - 1] as Buffer)[0] as number) >> 4).toBe(14);
  }, 15_000);
});
