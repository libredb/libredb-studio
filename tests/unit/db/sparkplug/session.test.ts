/**
 * The read session, fed the way a broker actually writes.
 *
 * A BROKER DOES NOT WRITE ONE PACKET PER CHUNK, and a test that pretends it does cannot see a
 * reassembly fault. A sibling session measured the cost of that assumption against real hardware:
 * its reader held the accumulated chunk in a local variable, a 39,348-byte answer arrived as four
 * frames across nine TCP chunks, the reader produced ONE message, and nothing raised an error. No
 * test caught it, because every test wrote its input as a single buffer.
 *
 * So the same packet is fed here at many chunk sizes, including sizes chosen to land INSIDE the
 * variable-length prefix, which is the one place a split changes the meaning of the bytes rather
 * than only their arrival. Two packets in one chunk and one payload across several chunks are
 * tested too, because those are the other two shapes a broker produces.
 *
 * THE PUBLISH BYTES IN THIS FILE ARE THE BROKER'S, NOT THIS PROVIDER'S. They are assembled here
 * because a test has to play the broker; the provider has no code that writes one, which
 * `encoder.test.ts` holds from two sides.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  newClientId,
  readOnce,
  type SessionOptions,
  type Transport,
} from "@/lib/db/providers/industrial/sparkplug/session";
import { CLIENT_ID_PREFIX } from "@/lib/db/providers/industrial/sparkplug/constants";

/** A base-128 variable byte integer, the length prefix a split can land inside. */
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

/** A PUBLISH at QoS 0, as a broker would write it. MQTT 5.0, so a property length is present. */
/** Any byte array, whatever buffer backs it: these helpers only read through theirs. */
type Bytes = Uint8Array<ArrayBufferLike>;

function publish(topic: string, payload: Bytes): Bytes {
  const topicBytes = new TextEncoder().encode(topic);
  const body = [
    (topicBytes.length >> 8) & 0xff,
    topicBytes.length & 0xff,
    ...topicBytes,
    0x00, // property length
    ...payload,
  ];
  return Uint8Array.from([0x30, ...varint(body.length), ...body]);
}

/** CONNACK, which the session needs before anything else is meaningful. */
const CONNACK = Uint8Array.of(0x20, 0x03, 0x00, 0x00, 0x00);

function bytes(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A transport that replays a script in chunks of a chosen size.
 *
 * `chunkSize` is the whole point: 0 means one chunk, and any other number slices the script into
 * pieces of that size regardless of where packets begin and end.
 */
function fakeTransport(script: Uint8Array, chunkSize = 0) {
  const written: Uint8Array[] = [];
  const handlers = new Map<string, ((value?: unknown) => void)[]>();
  const transport: Transport = {
    write(value) {
      written.push(Uint8Array.from(value));
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as (value?: unknown) => void);
      handlers.set(event, list);
    },
    once(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as (value?: unknown) => void);
      handlers.set(event, list);
    },
    destroy() {},
  };
  const emit = (event: string, value?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(value);
  };
  const deliver = () => {
    if (chunkSize <= 0) {
      emit("data", Buffer.from(script));
      return;
    }
    for (let at = 0; at < script.length; at += chunkSize) {
      emit("data", Buffer.from(script.subarray(at, Math.min(at + chunkSize, script.length))));
    }
  };
  return { transport, written, emit, deliver };
}

function options(over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    host: "broker.invalid",
    port: 1883,
    filters: ["spBv1.0/#"],
    windowMs: 50,
    maxMessages: 1_000,
    maxBytes: 1024 * 1024,
    ...over,
  };
}

/** Run a read against a script, delivered at `chunkSize`. */
async function read(script: Uint8Array, over: Partial<SessionOptions> = {}, chunkSize = 0) {
  const fake = fakeTransport(script, chunkSize);
  const promise = readOnce(
    options({
      ...over,
      openTransport: () => {
        // Deliver on the next tick so the session has written its CONNECT and SUBSCRIBE first.
        setTimeout(() => {
          fake.emit("connect");
          fake.deliver();
        }, 0);
        return { transport: fake.transport, readyEvent: "connect" };
      },
    }),
  );
  return { outcome: await promise, written: fake.written };
}

describe("the keep-alive ping", () => {
  /*
    The ping goes out every 30 s by default, half the keep-alive the CONNECT declares, and no unit
    run is alive that long: the line was in the uncovered set the house's 100 percent gate reports,
    not because nothing drives it but because nothing could wait for it. `pingIntervalMs` exists for
    that and the product never passes it.
  */
  test("a PINGREQ is written while the window is open, and it is the only kind added", async () => {
    const { written } = await read(bytes(CONNACK), { windowMs: 60, pingIntervalMs: 5 });
    const kinds = written.map((packet) => (packet[0] as number) >> 4);
    // 12 is PINGREQ. At least one went out, which is the line this case exists for.
    expect(kinds.filter((kind) => kind === 12).length).toBeGreaterThan(0);
    // And the control: the ping did not bring anything else with it. The four kinds a read writes
    // are CONNECT (1), SUBSCRIBE (8), UNSUBSCRIBE (10) and DISCONNECT (14); a PUBLISH from this
    // side (3) would be the failure the suite already holds elsewhere. The first version of this
    // list left UNSUBSCRIBE out and the case failed on the product doing the right thing, which is
    // the criterion being wrong rather than the code.
    expect([...new Set(kinds)].sort((a, b) => a - b).filter((kind) => ![1, 8, 10, 12, 14].includes(kind))).toEqual([]);
  });
});

describe("the session writes a connect and a subscribe, and never a publish", () => {
  test("the first two writes are CONNECT and SUBSCRIBE", async () => {
    const { written } = await read(bytes(CONNACK));
    expect(written[0]?.[0]).toBe(0x10);
    expect(written[1]?.[0]).toBe(0x82);
  });

  test("NOTHING written is a PUBLISH, whatever the broker sent", async () => {
    const script = bytes(CONNACK, publish("spBv1.0/G1/NDATA/E1", Uint8Array.of(1, 2, 3)));
    const { written } = await read(script);
    for (const packet of written) {
      // 0x30 is PUBLISH. Its first nibble is 3 at any QoS, so the type is checked, not the byte.
      expect((packet[0] >> 4) & 0x0f).not.toBe(3);
    }
  });

  test("the read withdraws its subscription and disconnects", async () => {
    const { written } = await read(bytes(CONNACK));
    const types = written.map((packet) => packet[0]);
    expect(types).toContain(0xa2);
    expect(types).toContain(0xe0);
  });

  test("a read with no filter is refused before anything is opened", async () => {
    await expect(readOnce(options({ filters: [] }))).rejects.toThrow(QueryError);
  });
});

describe("A BROKER WRITES ON ITS OWN BOUNDARIES, so the same packet is fed at many chunk sizes", () => {
  const topic = "spBv1.0/G1/NDATA/E1";
  const payload = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  const script = bytes(CONNACK, publish(topic, payload));

  test("one chunk", async () => {
    const { outcome } = await read(script);
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0].topic).toBe(topic);
    expect(outcome.messages[0].payload).toEqual(payload);
  });

  test.each([[1], [2], [3], [5], [7], [16], [64], [128], [256], [1024]])(
    "chunks of %i bytes give the same one message with the same payload",
    async (size) => {
      const { outcome } = await read(script, {}, size);
      expect(outcome.messages).toHaveLength(1);
      expect(outcome.messages[0].topic).toBe(topic);
      expect(outcome.messages[0].payload).toEqual(payload);
    },
  );

  test("A SPLIT INSIDE THE LENGTH PREFIX, which is where a split changes meaning", async () => {
    /*
     * The payload is 300 bytes, so the remaining length needs TWO bytes of variable byte integer
     * and the continuation bit matters. The script is delivered as two chunks with the boundary
     * placed between those two bytes: the first chunk ends mid-prefix, which is the case a reader
     * that treats each chunk as a frame gets wrong.
     */
    const prefix = varint(publish(topic, payload).length - 1 - varint(300 + topic.length + 3).length);
    expect(prefix.length).toBeGreaterThan(1);

    const fake = fakeTransport(script);
    const promise = readOnce(
      options({
        openTransport: () => {
          setTimeout(() => {
            fake.emit("connect");
            // CONNACK, then the publish's first byte and the FIRST byte of its length only.
            fake.emit("data", Buffer.from(script.subarray(0, CONNACK.length + 2)));
            // The rest, starting inside the length prefix.
            fake.emit("data", Buffer.from(script.subarray(CONNACK.length + 2)));
          }, 0);
          return { transport: fake.transport, readyEvent: "connect" };
        },
      }),
    );
    const outcome = await promise;
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0].payload).toEqual(payload);
  });

  test("TWO publishes in ONE chunk are two messages", async () => {
    const two = bytes(CONNACK, publish(topic, Uint8Array.of(1)), publish(topic, Uint8Array.of(2)));
    const { outcome } = await read(two);
    expect(outcome.messages).toHaveLength(2);
    expect(outcome.messages[0].payload).toEqual(Uint8Array.of(1));
    expect(outcome.messages[1].payload).toEqual(Uint8Array.of(2));
  });

  test("ONE payload spread across many chunks is still one message", async () => {
    const big = Uint8Array.from({ length: 5_000 }, (_, i) => i % 251);
    const { outcome } = await read(bytes(CONNACK, publish(topic, big)), {}, 97);
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0].payload).toEqual(big);
  });
});

describe("the sequence is a sequence, which is why this module exists", () => {
  test("fifty messages on ONE topic stay fifty entries, in order", async () => {
    const topic = "spBv1.0/G1/NDATA/E1";
    const parts: Bytes[] = [CONNACK];
    for (let i = 0; i < 50; i++) parts.push(publish(topic, Uint8Array.of(i)));
    const { outcome } = await read(bytes(...parts), { maxMessages: 1_000 });
    expect(outcome.messages).toHaveLength(50);
    expect(outcome.messages.map((m) => m.payload?.[0])).toEqual([...Array(50).keys()]);
  });
});

describe("the budget that ended the read is reported as a value, and the test does not race", () => {
  test("the MESSAGE budget, saturated deterministically", async () => {
    /*
     * The message count is filled in one chunk and the window is long, so time cannot win. A test
     * that let two budgets race would be green by luck: measured on this machine, a busy broker
     * reaches the 50,000-message budget in 648 to 749 ms, a quarter of the way through the time
     * budget, so which one ends a real read depends on load. A test must not.
     */
    const topic = "spBv1.0/G1/NDATA/E1";
    const parts: Bytes[] = [CONNACK];
    for (let i = 0; i < 12; i++) parts.push(publish(topic, Uint8Array.of(i)));
    const { outcome } = await read(bytes(...parts), { maxMessages: 10, windowMs: 10_000 });
    expect(outcome.endReason).toBe("message-budget");
    expect(outcome.messages).toHaveLength(10);
  });

  test("the TIME budget, with nothing arriving at all", async () => {
    const { outcome } = await read(bytes(CONNACK), { windowMs: 30, maxMessages: 1_000 });
    expect(outcome.endReason).toBe("time-budget");
    expect(outcome.messages).toHaveLength(0);
  });

  test("the BYTE budget, saturated deterministically", async () => {
    const topic = "spBv1.0/G1/NDATA/E1";
    // Filled with 7 and not zero, so a reader that handed back a zeroed buffer would show up.
    const big = new Uint8Array(2_000).fill(7);
    const parts: Bytes[] = [CONNACK];
    for (let i = 0; i < 20; i++) parts.push(publish(topic, big));
    const { outcome } = await read(bytes(...parts), { maxBytes: 1_000, maxMessages: 10_000, windowMs: 10_000 });
    expect(outcome.endReason).toBe("byte-budget");
  });

  test("a broker that closes the socket is its own reason", async () => {
    const fake = fakeTransport(bytes(CONNACK));
    const outcome = await readOnce(
      options({
        windowMs: 10_000,
        openTransport: () => {
          setTimeout(() => {
            fake.emit("connect");
            fake.deliver();
            fake.emit("close");
          }, 0);
          return { transport: fake.transport, readyEvent: "connect" };
        },
      }),
    );
    expect(outcome.endReason).toBe("broker-closed");
  });
});

describe("the payload cap drops bytes while keeping the entry", () => {
  test("a message past the cap is still counted, with its size and no payload", async () => {
    const topic = "spBv1.0/G1/NDATA/E1";
    const big = Uint8Array.from({ length: 600 }, () => 3);
    const { outcome } = await read(bytes(CONNACK, publish(topic, big), publish(topic, big)), {
      maxBytes: 700,
      maxMessages: 100,
      // SHORT ON PURPOSE. A ten second window was the first attempt, to keep the message budget
      // from racing it, but nothing else ends this read: the two payloads together stay under the
      // hard byte stop and under the message count, so the WINDOW is the ending, and ten seconds
      // outlived the test runner's own five second timeout. Same lesson as the budget tests: know
      // which budget a test expects to end the read.
      windowMs: 40,
    });
    expect(outcome.messages.length).toBeGreaterThanOrEqual(1);
    expect(outcome.payloadsDropped).toBeGreaterThanOrEqual(1);
    const dropped = outcome.messages.find((m) => m.payload === undefined);
    expect(dropped?.payloadBytes).toBe(600);
  });
});

describe("the client identifier cannot take an edge node's session", () => {
  test("it carries the shipped prefix and random bytes", () => {
    const id = newClientId();
    expect(id.startsWith(CLIENT_ID_PREFIX)).toBe(true);
    expect(id.length).toBe(CLIENT_ID_PREFIX.length + 16);
  });

  test("two identifiers differ, which a fixed one would not", () => {
    expect(newClientId()).not.toBe(newClientId());
  });
});

describe("what an agent read needs of the session", () => {
  test("a read records when it subscribed, on its own clock, and a handshake-only read records none", async () => {
    const { outcome } = await read(bytes(CONNACK), { windowMs: 30 });
    expect(outcome.subscribedAtMs).toBeGreaterThanOrEqual(0);
    expect(outcome.subscribedAtMs).toBeLessThanOrEqual(outcome.elapsedMs);
    expect(outcome.startedAt).toBeLessThanOrEqual(Date.now() - outcome.elapsedMs);

    const { outcome: handshake } = await read(bytes(CONNACK), { filters: [], handshakeOnly: true });
    expect(handshake.subscribedAtMs).toBeUndefined();
  });

  test("a handshake-only read writes CONNECT and DISCONNECT and nothing else, and ends on the handshake", async () => {
    const { outcome, written } = await read(bytes(CONNACK), { filters: [], handshakeOnly: true, windowMs: 5_000 });
    expect(written.map((packet) => packet[0])).toEqual([0x10, 0xe0]);
    expect(outcome.endReason).toBe("handshake");
    expect(outcome.handshook).toBe(true);
    // It ended on the CONNACK, not on the window.
    expect(outcome.elapsedMs).toBeLessThan(5_000);
  });

  test("a handshake-only read the broker refuses is a refused connection, not a handshake", async () => {
    const refused = Uint8Array.of(0x20, 0x03, 0x00, 0x87, 0x00);
    const { outcome } = await read(refused, { filters: [], handshakeOnly: true });
    expect(outcome.endReason).toBe("connect-refused");
    expect(outcome.handshook).toBe(false);
  });

  test("a SUBACK that refuses some filters and grants others is counted, and the read goes on", async () => {
    // Packet id 1, no properties, three reason codes: granted QoS 0, not authorized, granted QoS 0.
    const suback = Uint8Array.of(0x90, 0x06, 0x00, 0x01, 0x00, 0x00, 0x87, 0x00);
    const { outcome } = await read(bytes(CONNACK, suback), { filters: ["a", "b", "c"], windowMs: 20 });
    expect(outcome.subscriptionsRefused).toBe(1);
    expect(outcome.endReason).toBe("time-budget");
    const { outcome: granted } = await read(bytes(CONNACK), { windowMs: 20 });
    expect(granted.subscriptionsRefused).toBe(0);
  });
});
