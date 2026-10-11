/**
 * The MQTT session's two decisions a reader sees directly (`docs/providers/mqtt.md` sections 4.2 and 10.1).
 *
 * The client id and the CONNACK sentence are both small and both load-bearing: a colliding id disconnects
 * another client, and a refused connection with a vague sentence sends a reader to the wrong place.
 */
import { describe, expect, test } from "bun:test";
import {
  MQTT_CLIENT_ID_PREFIX,
  MQTT_CLIENT_ID_RANDOM_BYTES,
  MQTT_MAX_STRING_BYTES,
  MQTT_READ_BUDGET_MESSAGES,
} from "@/lib/db/providers/keyvalue/mqtt/constants";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  connackSentence,
  newClientId,
  readFilter,
  readTopics,
  type MqttTransport,
  type MqttTransportFactory,
} from "@/lib/db/providers/keyvalue/mqtt/session";

describe("the client id", () => {
  test("it is the prefix plus a hex suffix of the declared length", () => {
    const id = newClientId();
    expect(id.startsWith(MQTT_CLIENT_ID_PREFIX)).toBe(true);
    const suffix = id.slice(MQTT_CLIENT_ID_PREFIX.length);
    expect(suffix).toMatch(/^[0-9a-f]+$/);
    expect(suffix).toHaveLength(MQTT_CLIENT_ID_RANDOM_BYTES * 2);
  });

  /**
   * THE SUFFIX IS WHY THIS TEST EXISTS. MQTT ends the older session when a second connection arrives with the
   * same id (Session Taken Over, 0x8E, section 3.1.4), so two Studio windows sharing an id would disconnect
   * each other, and a Studio sharing one with a device would disconnect the device. The reference client uses
   * the process id, which repeats across container restarts.
   */
  test("two ids in a row are different, over a sample large enough to notice a constant", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newClientId()));
    expect(ids.size).toBe(500);
  });

  test("it is never the bare prefix, so a zero-length suffix cannot ship", () => {
    for (let i = 0; i < 50; i += 1) expect(newClientId()).not.toBe(MQTT_CLIENT_ID_PREFIX);
  });
});

describe("the sentence for a refused connection", () => {
  /**
   * EVERY CODE AGAINST TABLE 3-1'S OWN NAME FOR IT, because one of them was wrong and the suite could not see it.
   *
   * `0x83` was mapped to "the broker does not support this protocol version". In the OASIS MQTT 5.0 CONNACK
   * table that is `0x84`, Unsupported Protocol Version; `0x83` is Implementation specific error, and `0x84`
   * was absent altogether. So a broker reporting an internal fault was told it was a version mismatch, and
   * the one refusal this provider's 5.0-only policy makes likely fell through to the bare-number branch. The
   * old test asserted seven codes against loose patterns of its own invention, which is why it passed.
   *
   * The right-hand side here is the specification's name, not ours: each entry asserts that our sentence
   * carries the sense of the name the standard gives that code.
   */
  test("every mapped code carries the sense of its name in the specification's CONNACK table", () => {
    const table: readonly [number, string, RegExp][] = [
      [0x81, "Malformed Packet", /could not read the CONNECT packet/],
      [0x82, "Protocol Error", /not allowed on this connection/],
      [0x83, "Implementation specific error", /error of its own/],
      [0x84, "Unsupported Protocol Version", /does not support MQTT 5\.0/],
      [0x85, "Client Identifier not valid", /refused the client id/],
      [0x86, "Bad User Name or Password", /username or password is wrong/],
      [0x87, "Not authorized", /not authorized/],
      [0x88, "Server unavailable", /unavailable/],
      [0x89, "Server busy", /busy/],
      [0x8a, "Banned", /banned/],
      [0x8c, "Bad authentication method", /authentication method/],
      [0x97, "Quota exceeded", /quota/],
      [0x9f, "Connection rate exceeded", /rate limit/],
    ];
    for (const [code, specName, expected] of table) {
      const sentence = connackSentence(code);
      if (!expected.test(sentence)) {
        throw new Error(`0x${code.toString(16)} is "${specName}" in the specification, but we say: ${sentence}`);
      }
      expect(sentence).toContain(String(code));
      expect(sentence).toContain(`0x${code.toString(16)}`);
    }
  });

  /**
   * `0x83` and `0x84` are adjacent, mean entirely different things, and were swapped once. Asserting each
   * against the other's words is what makes a second swap fail rather than pass.
   */
  test("0x83 and 0x84 do not wear each other's words", () => {
    expect(connackSentence(0x83)).not.toMatch(/MQTT 5\.0|protocol version/);
    expect(connackSentence(0x84)).not.toMatch(/error of its own/);
  });

  /**
   * `0x01` is not a 5.0 CONNACK code. It is kept deliberately: a 3.1.1 broker answers the older CONNACK,
   * whose return code 1 means "unacceptable protocol version", and that is the broker a 5.0-only client
   * meets most often. This pins the intent so the entry is not deleted as a mistake.
   */
  test("0x01 is kept for the 3.1.1 broker that answers the older CONNACK", () => {
    expect(connackSentence(0x01)).toMatch(/does not speak MQTT 5\.0/);
  });

  test("the codes a broker actually sends are named, not numbered", () => {
    const known: readonly [number, RegExp][] = [
      [0x01, /MQTT 5\.0/],
      [0x86, /username or password/],
      [0x87, /not authorized/],
      [0x88, /unavailable/],
      [0x8a, /banned/],
      [0x97, /quota/],
      [0x9f, /rate limit/],
    ];
    expect(known).toHaveLength(7);
    for (const [code, expected] of known) {
      const sentence = connackSentence(code);
      expect(sentence).toMatch(expected);
      // The number travels too, because a reader searching for it finds the broker's own documentation.
      expect(sentence).toContain(String(code));
    }
  });

  /**
   * A code this list does not know is the normal case over time: brokers add them. The sentence then says so
   * plainly rather than guessing, which is the difference between an honest answer and a wrong one.
   */
  test("a code we do not know is reported as itself, in both bases", () => {
    const sentence = connackSentence(0xa5);
    expect(sentence).toContain("165");
    expect(sentence).toContain("0xa5");
  });

  test("the sentence for 0x01 points at the version, which is the one a reader can act on", () => {
    expect(connackSentence(0x01)).toMatch(/does not speak MQTT 5\.0/);
  });
});

/**
 * The two budgets that end a read by size, and the invariant that keeps the tree small (manual section 5).
 *
 * THESE THREE WERE WRITTEN AFTER A MUTATION RUN SURVIVED THEM. `budget-messages` and `budget-bytes` are two
 * of the six end reasons, and the suite tested only the SENTENCES they produce: deleting either budget from
 * the session left every test green, and a broker with a busy topic would then have been read until the time
 * budget ran out instead, filling the tree first. The payload invariant survived the same way - nothing
 * asserted that a tree read holds no bodies, so holding every one of them would have passed.
 */
describe("the budgets that end a read by size, and the payload the tree does not hold", () => {
  /** One QoS 0 PUBLISH, hand-encoded: our encoder cannot write one, which is the point of it. */
  function publish(topic: string, payloadBytes: number): Buffer {
    const name = Buffer.from(topic, "utf8");
    const body = Buffer.concat([
      Buffer.from([(name.length >> 8) & 0xff, name.length & 0xff]),
      name,
      Buffer.from([0x00]), // an empty property block
      Buffer.alloc(payloadBytes, 0x61),
    ]);
    const length: number[] = [];
    let left = body.length;
    do {
      const byte = left % 128;
      left = Math.floor(left / 128);
      length.push(left > 0 ? byte | 0x80 : byte);
    } while (left > 0);
    return Buffer.concat([Buffer.from([0x30, ...length]), body]);
  }

  /**
   * A transport that answers the handshake and then delivers whatever the test hands it, one chunk at a time.
   *
   * `thenClose` decides which end is under test. Left out, the socket stays open, so a read that ends has
   * ended because a BUDGET said so and not because the broker hung up - which is the whole point of the two
   * budget tests below. Set, the broker hangs up once it has delivered, which is how a small read ends.
   */
  function delivering(chunks: () => Generator<Buffer>, thenClose = false): MqttTransportFactory {
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
            emit("data", Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00])); // CONNACK, success
            emit("data", Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00])); // SUBACK, granted
            for (const chunk of chunks()) emit("data", chunk);
            if (thenClose) emit("close");
          });
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready" };
    };
  }

  const CONNECTION = { host: "127.0.0.1", port: 1883, tls: false, filter: "#" } as const;

  test("a read of more messages than the budget ends on the message budget, saying so", async () => {
    const outcome = await readTopics({
      ...CONNECTION,
      openTransport: delivering(function* () {
        for (let i = 0; i < MQTT_READ_BUDGET_MESSAGES + 10; i += 1) yield publish(`yogun/${i}`, 1);
      }),
    });

    expect(outcome.endReason).toBe("budget-messages");
    expect(outcome.messages).toBe(MQTT_READ_BUDGET_MESSAGES);
    // It stopped AT the budget, so the tree is the budget and not everything the broker offered.
    expect(outcome.topics.size).toBe(MQTT_READ_BUDGET_MESSAGES);
    expect(outcome.scope).toBe("unknown");
  });

  test("a read of more bytes than the budget ends on the byte budget, under the message budget", async () => {
    const big = 4 * 1024 * 1024;
    const outcome = await readTopics({
      ...CONNECTION,
      openTransport: delivering(function* () {
        for (let i = 0; i < 12; i += 1) yield publish(`buyuk/${i}`, big);
      }),
    });

    expect(outcome.endReason).toBe("budget-bytes");
    // Far below the message budget, which is what proves the BYTE budget is the one that fired.
    expect(outcome.messages).toBeLessThan(100);
    expect(outcome.messages).toBeGreaterThan(0);
  });

  /**
   * THE TREE HOLDS NAMES ONLY, and this is where that is enforced rather than described. Holding every
   * payload is the quickest way to become a slow reader, which is when a broker starts dropping a device's
   * messages on our behalf - the failure this provider exists to not cause.
   */
  test("a tree read keeps no payload, and asking for one topic keeps that one only", async () => {
    const script = function* (): Generator<Buffer> {
      yield publish("olcum/a", 32);
      yield publish("olcum/b", 32);
    };

    const tree = await readTopics({ ...CONNECTION, openTransport: delivering(script, true) });
    expect([...tree.topics.keys()].sort()).toEqual(["olcum/a", "olcum/b"]);
    for (const row of tree.topics.values()) {
      expect(row.payload).toBeUndefined();
      // The SIZE is kept, because the panel reports it; the bytes are not.
      expect(row.payloadBytes).toBe(32);
    }

    const one = await readTopics({
      ...CONNECTION,
      keepPayloadFor: "olcum/b",
      openTransport: delivering(script, true),
    });
    expect(one.topics.get("olcum/a")?.payload).toBeUndefined();
    expect(one.topics.get("olcum/b")?.payload).toHaveLength(32);
  });
});

/**
 * The invariants a mutation run reached past, each one assertion wide (#1635).
 *
 * EVERY TEST HERE EXISTS BECAUSE A DELIBERATE BREAK SURVIVED THE WHOLE SUITE. Twenty-one mutations were run
 * against this provider and eight lived; these are the ones whose fix is a test rather than a change. They
 * are small on purpose: an invariant nothing asserts is an invariant the next edit is free to delete.
 */
describe("the invariants a mutation run walked straight past", () => {
  const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);

  /** A SUBACK carrying the given reason codes. */
  function suback(...codes: number[]): Buffer {
    return Buffer.from([0x90, 2 + 1 + codes.length, 0x00, 0x01, 0x00, ...codes]);
  }

  /** One PUBLISH, with the retain bit and the property block the caller asks for. */
  function publish(topic: string, options: { retain: boolean; expirySeconds?: number }): Buffer {
    const name = Buffer.from(topic, "utf8");
    const properties =
      options.expirySeconds === undefined
        ? Buffer.from([0x00])
        : Buffer.concat([
            Buffer.from([0x05, 0x02]),
            (() => {
              const value = Buffer.alloc(4);
              value.writeUInt32BE(options.expirySeconds);
              return value;
            })(),
          ]);
    const body = Buffer.concat([
      Buffer.from([(name.length >> 8) & 0xff, name.length & 0xff]),
      name,
      properties,
      Buffer.from("x", "utf8"),
    ]);
    return Buffer.concat([Buffer.from([options.retain ? 0x31 : 0x30, body.length]), body]);
  }

  function replaying(chunks: readonly Buffer[]): MqttTransportFactory {
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

  /**
   * THE RETAIN BIT IS READ FROM THE WIRE, not assumed. All four recorded captures happen to carry retained
   * messages only, so hard-coding `retained: true` passed every one of them and every unit test besides:
   * the one test that produces a `live` row builds the row by hand and never goes through the decoder.
   * A broker whose topic is busy would then have had every live message labelled as a retained one.
   */
  test("a live message is not labelled retained, and a retained one is", async () => {
    const outcome = await readTopics({
      ...CONNECTION,
      openTransport: replaying([
        CONNACK,
        suback(0x00),
        publish("canli/olcum", { retain: false }),
        publish("tutulan/olcum", { retain: true }),
      ]),
    });

    expect(outcome.topics.get("canli/olcum")?.retained).toBe(false);
    expect(outcome.topics.get("tutulan/olcum")?.retained).toBe(true);
  });

  /** The server's own lifetime, read off the property block, which no capture carries. */
  test("a Message Expiry Interval is carried through to the row", async () => {
    const outcome = await readTopics({
      ...CONNECTION,
      openTransport: replaying([CONNACK, suback(0x00), publish("suresi/var", { retain: true, expirySeconds: 3_588 })]),
    });

    expect(outcome.topics.get("suresi/var")?.lifetimeSeconds).toBe(3_588);
    // And a message that carried none reports none, rather than a zero that would read as "expired".
    const without = await readTopics({
      ...CONNECTION,
      openTransport: replaying([CONNACK, suback(0x00), publish("suresi/yok", { retain: true })]),
    });
    expect(without.topics.get("suresi/yok")?.lifetimeSeconds).toBeUndefined();
  });

  /**
   * 0x80 IS THE FIRST REFUSAL, NOT THE LAST GRANT. Section 3.9.3's granted codes are 0x00, 0x01 and 0x02;
   * everything from 0x80 up is a failure. Reading the boundary as `> 0x80` would take 0x80 itself,
   * "Unspecified error", as a successful subscription and report the empty tree as an ordinary short read.
   */
  test("a SUBACK of exactly 0x80 is a refusal, not a grant", async () => {
    const outcome = await readTopics({ ...CONNECTION, openTransport: replaying([CONNACK, suback(0x80)]) });
    expect(outcome.endReason).toBe("subscription-refused");
    expect(outcome.scope).toBe("incomplete");
  });

  test("the granted codes are read as granted, and a partial refusal is still incomplete", async () => {
    const granted = await readTopics({ ...CONNECTION, openTransport: replaying([CONNACK, suback(0x00)]) });
    expect(granted.endReason).not.toBe("subscription-refused");

    const partly = await readTopics({ ...CONNECTION, openTransport: replaying([CONNACK, suback(0x00, 0x87)]) });
    expect(partly.endReason).not.toBe("subscription-refused");
    expect(partly.scope).toBe("incomplete");
  });

  /**
   * A SUBACK WITH NO REASON CODES IS NOT A REFUSAL OF EVERYTHING. `refused.length === codes.length` is true
   * of two empty arrays, so without the length guard an empty SUBACK - which a malformed or truncated one
   * produces - would end the read claiming the broker refused a subscription it never answered.
   */
  test("a SUBACK carrying no reason codes is not read as a total refusal", async () => {
    const outcome = await readTopics({ ...CONNECTION, openTransport: replaying([CONNACK, suback()]) });
    expect(outcome.endReason).not.toBe("subscription-refused");
  });

  /**
   * THE EMPTY TOPIC NAME. A broker using Topic Alias sends the name once and omits it afterwards. We
   * advertise no Topic Alias Maximum so a conforming broker never does it, but a row keyed on `""` would
   * re-read the whole broker when clicked, because an empty filter means `#`.
   */
  test("a PUBLISH with an empty topic name makes no row", async () => {
    const outcome = await readTopics({
      ...CONNECTION,
      openTransport: replaying([
        CONNACK,
        suback(0x00),
        publish("", { retain: true }),
        publish("gercek/konu", { retain: true }),
      ]),
    });
    expect([...outcome.topics.keys()]).toEqual(["gercek/konu"]);
  });
});

/**
 * The three guards added after the audits, each one a path nothing had reached (#1635).
 *
 * All three exist because a failure took a route no test had walked: a field long enough to break the
 * encoder, a write that threw inside a socket listener, and a dial that never reached the far end at all.
 */
describe("the guards the audits put in, exercised", () => {
  /**
   * BOUNDED BEFORE A SOCKET EXISTS. An MQTT string holds at most 65,535 bytes, and `encodeString` refused a
   * longer one by throwing - inside a socket listener, where under Node a throw is an uncaught exception and
   * the process exits. Refusing it here makes it what it always was: a config error, named, before the dial.
   */
  test("a topic filter over 65,535 bytes is refused as a config error, with both figures named", () => {
    const long = "a".repeat(MQTT_MAX_STRING_BYTES + 1);
    expect(() => readFilter(long)).toThrow(DatabaseConfigError);
    expect(() => readFilter(long)).toThrow(/holds at most 65,535 bytes/);
    expect(() => readFilter(long)).toThrow(/65,536/);

    // The boundary is a maximum, so exactly the limit is accepted.
    const exact = "b".repeat(MQTT_MAX_STRING_BYTES);
    expect(readFilter(exact)).toBe(exact);
  });

  /**
   * A WRITE THAT THROWS MUST REJECT THE READ, NOT THE PROCESS. Under bun a throw inside a socket listener
   * becomes a socket error event; under Node, which production runs, it is an uncaught exception and the
   * process exits 1. The write is wrapped so the throw reaches `fail()` either way. This drives it by handing
   * the session a transport whose `write` throws, which is the shape of a library or a frame retry failing.
   */
  test("a transport whose write throws rejects the read rather than escaping it", async () => {
    const broken: MqttTransportFactory = () => {
      const transport: MqttTransport = {
        write(): void {
          throw new Error("the socket refused the frame");
        },
        on(): void {},
        once(event: string, handler: () => void): void {
          if (event === "ready") queueMicrotask(handler);
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready" };
    };

    const attempt = readTopics({ host: "127.0.0.1", port: 1883, tls: false, filter: "#", openTransport: broken });
    await expect(attempt).rejects.toThrow(/refused the frame/);
  });

  /** And a non-Error thrown from the same place is still a settled rejection, not a dangling promise. */
  test("a write that throws something that is not an Error still rejects", async () => {
    const odd: MqttTransportFactory = () => {
      const transport: MqttTransport = {
        write(): void {
          // eslint-disable-next-line no-throw-literal
          throw "a string, which a library is entitled to throw";
        },
        on(): void {},
        once(event: string, handler: () => void): void {
          if (event === "ready") queueMicrotask(handler);
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready" };
    };

    await expect(
      readTopics({ host: "127.0.0.1", port: 1883, tls: false, filter: "#", openTransport: odd }),
    ).rejects.toThrow(/a string, which a library is entitled to throw/);
  });

  /**
   * THE DIAL TIMEOUT SAYS WHICH SILENCE IT WAS. It reported "accepted the connection" for both, so a dropped
   * SYN - a firewall rule or a wrong address, among the commonest failures there are - was described as a
   * broker that answered and then went quiet, pointing the reader at the broker instead of at the route.
   *
   * Driven on the seam rather than against a real unroutable address, so it costs milliseconds: a transport
   * that never fires its ready event is a connection that never completed, which is the case under test.
   */
  test("a dial that never reaches the far end does not claim the connection was accepted", async () => {
    const silent: MqttTransportFactory = () => ({
      transport: { write(): void {}, on(): void {}, once(): void {}, destroy(): void {} },
      readyEvent: "ready",
    });

    const attempt = readTopics({
      host: "10.255.255.1",
      port: 1883,
      tls: false,
      filter: "#",
      openTransport: silent,
      dialTimeoutMs: 20,
    });
    await expect(attempt).rejects.toThrow(/did not answer within/);
    await expect(
      readTopics({
        host: "10.255.255.1",
        port: 1883,
        tls: false,
        filter: "#",
        openTransport: silent,
        dialTimeoutMs: 20,
      }),
    ).rejects.toThrow(/not even a refusal/);
  });

  /** And when the transport DID open, the same timeout says so instead, which is the other half of the pair. */
  test("a dial that opened but never finished its handshake says the connection was accepted", async () => {
    const opened: MqttTransportFactory = () => {
      const transport: MqttTransport = {
        write(): void {},
        on(): void {},
        once(event: string, handler: () => void): void {
          // The TCP connection is up; the TLS handshake never completes, so `ready` never fires.
          if (event === "connect") queueMicrotask(handler);
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready", openedEvent: "connect" };
    };

    await expect(
      readTopics({
        host: "10.255.255.1",
        port: 8883,
        tls: true,
        filter: "#",
        openTransport: opened,
        dialTimeoutMs: 20,
      }),
    ).rejects.toThrow(/accepted the connection and did not finish the TLS handshake/);
  });
});

/** A broker that answers out of order, and a caller that hands the session a field no encoder can write. */
describe("a session the broker drives out of order", () => {
  const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);
  const SUBACK = Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00]);

  /** A transport that replays `chunks`, records the packet type of every frame written, and reports a throw. */
  function recording(chunks: readonly Buffer[]): {
    factory: MqttTransportFactory;
    written: number[];
    escaped: () => unknown;
  } {
    const written: number[] = [];
    let escaped: unknown;
    const factory: MqttTransportFactory = () => {
      const handlers = new Map<string, ((value: never) => void)[]>();
      const emit = (event: string, value?: unknown): void => {
        for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
      };
      const transport: MqttTransport = {
        write(bytes: Buffer): void {
          written.push(((bytes[0] as number) >> 4) & 0x0f);
        },
        on(event: string, handler: (value: never) => void): void {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        once(event: string, handler: () => void): void {
          if (event !== "ready") return;
          queueMicrotask(() => {
            try {
              handler();
              for (const chunk of chunks) emit("data", chunk);
              emit("close");
            } catch (error) {
              escaped = error;
            }
          });
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready" };
    };
    return { factory, written, escaped: () => escaped };
  }

  const BASE = { host: "127.0.0.1", port: 1883, tls: false, filter: "#" } as const;

  /**
   * The encoder refuses a string over 65,535 bytes by throwing. Called directly, `readTopics` must turn that
   * into a rejected read: a throw out of the ready listener is an uncaught exception under Node.
   */
  test("a username no CONNECT can carry rejects the read and throws nothing out of the listener", async () => {
    const { factory, escaped } = recording([]);
    const attempt = readTopics({ ...BASE, user: "u".repeat(MQTT_MAX_STRING_BYTES + 1), openTransport: factory });
    await expect(attempt).rejects.toThrow(DatabaseConfigError);
    expect(escaped()).toBeUndefined();
  });

  test("a DISCONNECT before the CONNACK is reported with the broker's own reason code", async () => {
    const disconnect = Buffer.from([0xe0, 0x02, 0x87, 0x00]);
    const { factory } = recording([disconnect]);
    await expect(readTopics({ ...BASE, openTransport: factory })).rejects.toThrow(/0x87/);
  });

  test("a second CONNACK is a protocol error, and no second SUBSCRIBE is written", async () => {
    const { factory, written } = recording([CONNACK, CONNACK, SUBACK]);
    await expect(readTopics({ ...BASE, openTransport: factory })).rejects.toThrow(/second CONNACK/);
    expect(written.filter((type) => type === 8)).toHaveLength(1);
  });

  test("a PUBLISH with no topic name is a proven loss, so the read says it is incomplete", async () => {
    const name = Buffer.alloc(2);
    const nameless = Buffer.concat([Buffer.from([0x31, 0x04]), name, Buffer.from([0x00, 0x78])]);
    const { factory } = recording([CONNACK, SUBACK, nameless]);
    const outcome = await readTopics({ ...BASE, openTransport: factory });
    expect(outcome.topics.size).toBe(0);
    expect(outcome.scope).toBe("incomplete");
    expect(outcome.provenLoss.join(" ")).toMatch(/no topic name/);
  });
});
