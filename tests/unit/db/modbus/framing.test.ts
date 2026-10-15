/**
 * MB-S5: every inbound frame is bounded before it is buffered, and checked against its request.
 *
 * The hostile frames here are the ones the issue author staged against the two npm clients, so the
 * cases are not invented: a length of 0, 2, 255 and 0xFFFF, a protocol id of 1, short and long byte
 * counts, a wrong function code, another unit id, a stray transaction id before the real answer,
 * one answer split over two writes, and two answers in one write. The memory assertion is the one
 * that matters most: a 0xFFFF length must not cause bytes to be held.
 */
import { describe, expect, test } from "bun:test";
import {
  createFrameReader,
  MAX_ADU_BYTES,
  matchToRequest,
  ModbusFramingError,
  type InboundFrame,
} from "@/lib/db/providers/industrial/modbus/framing";

function answer(tid: number, unit: number, fc: number, body: Buffer): Buffer {
  const pdu = Buffer.concat([Buffer.from([fc]), body]);
  const head = Buffer.alloc(7);
  head.writeUInt16BE(tid, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head[6] = unit;
  return Buffer.concat([head, pdu]);
}
const readOf = (quantity: number) =>
  answer(1, 1, 3, Buffer.concat([Buffer.from([quantity * 2]), Buffer.alloc(quantity * 2)]));
const expect3 = { transactionId: 1, unitId: 1, functionCode: 3, quantity: 2 };

describe("the bound is applied at the header", () => {
  for (const length of [0, 1, 2, 255, 0x1000, 0xffff]) {
    test(`an MBAP length of ${length} is refused and nothing is held`, () => {
      const reader = createFrameReader();
      const head = Buffer.alloc(7);
      head.writeUInt16BE(1, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(length, 4);
      head[6] = 1;
      expect(() => reader.push(Buffer.concat([head, Buffer.alloc(4)]))).toThrow(/MBAP length/);
      // The name of this test claims the bytes are dropped, so the test has to measure it.
      // Asserting only the throw left the drop unbound: a reader that KEPT the refused header
      // passed this test unchanged (measured, round 7).
      expect(reader.buffered).toBe(0);
    });
  }

  test("a well formed answer after a refused header is still read", () => {
    const reader = createFrameReader();
    const head = Buffer.alloc(7);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(0xffff, 4);
    head[6] = 1;
    expect(() => reader.push(head)).toThrow(/MBAP length/);
    // Had the refused header been kept, this push would read ITS length again and throw a
    // second time, and a device that recovers would never be heard.
    expect(reader.push(readOf(2))).toEqual([
      {
        transactionId: 1,
        unitId: 1,
        functionCode: 3,
        body: Buffer.concat([Buffer.from([4]), Buffer.alloc(4)]),
        isException: false,
        exceptionCode: undefined,
      },
    ]);
  });

  test("memory does not grow with what a peer sends under a huge length", () => {
    const reader = createFrameReader();
    const head = Buffer.alloc(7);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(0xffff, 4);
    head[6] = 1;
    expect(() => reader.push(head)).toThrow(ModbusFramingError);
    expect(reader.buffered).toBeLessThanOrEqual(7);
  });

  test("a protocol id other than zero is refused", () => {
    const reader = createFrameReader();
    const f = readOf(2);
    f.writeUInt16BE(1, 2);
    expect(() => reader.push(f)).toThrow(/protocol id/);
    expect(reader.buffered).toBe(0);
    expect(reader.push(readOf(2))).toHaveLength(1);
  });

  test("a partial header is held and nothing is produced", () => {
    const reader = createFrameReader();
    expect(reader.push(Buffer.alloc(6))).toEqual([]);
    expect(reader.buffered).toBe(6);
  });
});

describe("reassembly", () => {
  test("one answer split over two writes produces one frame", () => {
    const reader = createFrameReader();
    const f = readOf(2);
    expect(reader.push(f.subarray(0, 5))).toEqual([]);
    const frames = reader.push(f.subarray(5));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.functionCode).toBe(3);
  });

  test("two answers in one write produce two frames and leave nothing held", () => {
    const reader = createFrameReader();
    const frames = reader.push(Buffer.concat([readOf(1), readOf(1)]));
    expect(frames).toHaveLength(2);
    expect(reader.buffered).toBe(0);
  });

  test("an exception answer is recognised and its code read", () => {
    const reader = createFrameReader();
    const frames = reader.push(answer(1, 1, 0x83, Buffer.from([0x02])));
    expect(frames[0]?.isException).toBe(true);
    expect(frames[0]?.functionCode).toBe(3);
    expect(frames[0]?.exceptionCode).toBe(0x02);
  });
});

/**
 * A REGISTER VALUE CAN LOOK LIKE A HEADER, and the reader must not care.
 *
 * Every byte of a register is data the device chose, so a payload can carry bytes that read as a
 * perfectly good MBAP header: a transaction id, protocol id 0x0000, a plausible length. A reader
 * that SEARCHED for a header would cut the frame in the middle of a value and the pieces would
 * still look like frames, which is the worst shape of this fault: the result is not an error, it
 * is a wrong number.
 *
 * This reader advances by the length the header declares and never looks inside a body. These
 * tests are here to hold that, because the alternative passes every test written with payloads
 * that happen to contain no header-shaped bytes.
 */
describe("a payload that looks like a header is still payload", () => {
  test("a register value carrying a whole MBAP header is read as data", () => {
    // Four registers whose bytes spell out tid 1, protocol 0, length 6, unit 1, FC 3: a header a
    // searching reader would lock onto.
    const payload = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x03]);
    const frame = answer(7, 1, 3, Buffer.concat([Buffer.from([payload.length]), payload]));
    const reader = createFrameReader();
    const frames = reader.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.transactionId).toBe(7);
    expect(frames[0]?.body.subarray(1)).toEqual(payload);
    expect(reader.buffered).toBe(0);
  });

  test("two frames in one write, where the second's header also appears inside the first's body", () => {
    const second = answer(2, 1, 3, Buffer.from([2, 0x12, 0x34]));
    // The first frame's payload CONTAINS the second frame's header bytes, verbatim.
    const first = answer(1, 1, 3, Buffer.concat([Buffer.from([second.length]), second]));
    const reader = createFrameReader();
    const frames = reader.push(Buffer.concat([first, second]));
    expect(frames.map((f) => f.transactionId)).toEqual([1, 2]);
    expect(reader.buffered).toBe(0);
  });

  test("the same two frames split byte by byte still arrive as two, in order", () => {
    const second = answer(2, 1, 3, Buffer.from([2, 0x12, 0x34]));
    const first = answer(1, 1, 3, Buffer.concat([Buffer.from([second.length]), second]));
    const both = Buffer.concat([first, second]);
    const reader = createFrameReader();
    const seen: number[] = [];
    for (const byte of both) seen.push(...reader.push(Buffer.from([byte])).map((f) => f.transactionId));
    expect(seen).toEqual([1, 2]);
    expect(reader.buffered).toBe(0);
  });
});

describe("a frame is checked against the request", () => {
  const one = (buf: Buffer): InboundFrame => createFrameReader().push(buf)[0] as InboundFrame;

  test("a stray transaction id is DISCARDED, not failed", () => {
    const match = matchToRequest(one(answer(999, 1, 3, Buffer.from([4, 0, 0, 0, 0]))), expect3);
    expect(match.kind).toBe("discard");
  });

  test("the real answer after a stray one is still matched", () => {
    const reader = createFrameReader();
    const frames = reader.push(Buffer.concat([answer(999, 1, 3, Buffer.from([2, 0, 0])), readOf(2)]));
    expect(matchToRequest(frames[0] as InboundFrame, expect3).kind).toBe("discard");
    expect(matchToRequest(frames[1] as InboundFrame, expect3).kind).toBe("answer");
  });

  test("another unit id is a failure, not a discard", () => {
    expect(() => matchToRequest(one(answer(1, 9, 3, Buffer.from([4, 0, 0, 0, 0]))), expect3)).toThrow(/unit id 9/);
  });

  test("a wrong function code is a failure", () => {
    expect(() => matchToRequest(one(answer(1, 1, 4, Buffer.from([4, 0, 0, 0, 0]))), expect3)).toThrow(
      /function code 4/,
    );
  });

  test("a byte count short of the request is a failure", () => {
    expect(() => matchToRequest(one(readOf(1)), expect3)).toThrow(/must answer 4/);
  });

  test("a byte count longer than the request is a failure", () => {
    expect(() => matchToRequest(one(readOf(3)), expect3)).toThrow(/must answer 4/);
  });

  test("a declared count that disagrees with the bytes carried is a failure", () => {
    const f = answer(1, 1, 3, Buffer.concat([Buffer.from([4]), Buffer.alloc(2)]));
    expect(() => matchToRequest(one(f), expect3)).toThrow(/carried 2/);
  });

  test("a bit read is measured in bytes of ceil(quantity / 8)", () => {
    const f = answer(1, 1, 1, Buffer.from([2, 0xff, 0x01]));
    const match = matchToRequest(one(f), { transactionId: 1, unitId: 1, functionCode: 1, quantity: 9, isBits: true });
    expect(match.kind).toBe("answer");
  });

  test("a matching answer is returned", () => {
    expect(matchToRequest(one(readOf(2)), expect3).kind).toBe("answer");
  });

  test("an exception for this request is reported as an exception", () => {
    const match = matchToRequest(one(answer(1, 1, 0x83, Buffer.from([0x0b]))), expect3);
    expect(match).toEqual({ kind: "exception", code: 0x0b });
  });
});

/**
 * Fragmentation, and the bound while the buffer GROWS.
 *
 * TCP knows nothing of frame boundaries, so a reader is only correct if it is correct for every
 * split. These cases are the ones a sibling session's reader lost data on: byte-at-a-time delivery,
 * a split inside the seven byte header, one frame followed by the first byte of the next, and chunk
 * sizes chosen NOT to align with frames. All four passed on the first run, which is worth recording
 * because it was not luck: the reader keeps its partial frame in an instance field rather than a
 * local, which is the fault that loses data.
 *
 * The last two did NOT pass, and they are the reason this block exists. The reader used to join the
 * whole chunk to its buffer and check the header afterwards, so five megabytes in one write were
 * held before any rule ran, and stayed held after the refusal. That is the exact fault measured in
 * the two npm clients and the reason this module is ours. A bound that only runs after the body is
 * buffered is not a bound.
 */

/** A read answer of `regs` registers, used by the fragmentation block below. Separate from
 * `answer` above because that one takes a hand built body and this one builds its own. */
function regAnswer(tid: number, regs: number): Buffer {
  const body = Buffer.alloc(regs * 2);
  for (let i = 0; i < regs; i++) body.writeUInt16BE((i + 1) & 0xffff, i * 2);
  const pdu = Buffer.concat([Buffer.from([3, body.length]), body]);
  const head = Buffer.alloc(7);
  head.writeUInt16BE(tid, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head[6] = 1;
  return Buffer.concat([head, pdu]);
}

describe("fragmentation and the growing bound", () => {
  test("byte at a time: no frame is lost and nothing is left held", () => {
    const r = createFrameReader();
    const wire = Buffer.concat([regAnswer(1, 10), regAnswer(2, 10), regAnswer(3, 10)]);
    const got: InboundFrame[] = [];
    for (const byte of wire) got.push(...r.push(Buffer.from([byte])));
    expect(got.map((f) => f.transactionId)).toEqual([1, 2, 3]);
    expect(r.buffered).toBe(0);
  });

  test("split at every point inside the seven byte header", () => {
    for (let cut = 1; cut <= 7; cut++) {
      const r = createFrameReader();
      const w = regAnswer(9, 5);
      const a = r.push(w.subarray(0, cut));
      const b = r.push(w.subarray(cut));
      expect([...a, ...b].map((f) => f.transactionId)).toEqual([9]);
    }
  });

  test("one frame plus the first byte of the next", () => {
    const r = createFrameReader();
    const w = Buffer.concat([regAnswer(1, 4), regAnswer(2, 4)]);
    const first = regAnswer(1, 4).length;
    const a = r.push(w.subarray(0, first + 1));
    expect(a.map((f) => f.transactionId)).toEqual([1]);
    expect(r.buffered).toBe(1);
    const b = r.push(w.subarray(first + 1));
    expect(b.map((f) => f.transactionId)).toEqual([2]);
    expect(r.buffered).toBe(0);
  });

  test("chunk sizes that do not align with frame boundaries", () => {
    for (const size of [1, 3, 7, 13, 64, 100, 127, 128, 129, 255, 256, 257]) {
      const r = createFrameReader();
      const wire = Buffer.concat(Array.from({ length: 6 }, (_, i) => regAnswer(i + 1, 20)));
      const got: InboundFrame[] = [];
      for (let o = 0; o < wire.length; o += size) got.push(...r.push(wire.subarray(o, o + size)));
      expect(got.map((f) => f.transactionId)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.buffered).toBe(0);
    }
  });

  test("the bound holds while the buffer GROWS, not only at the end", () => {
    const r = createFrameReader();
    const head = Buffer.alloc(7);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(0xffff, 4);
    head[6] = 1;
    expect(() => r.push(Buffer.concat([head, Buffer.alloc(5_000_000)]))).toThrow(/MBAP length/);
    expect(r.buffered).toBeLessThan(300);
  });

  test("a stream with no valid header does not grow the buffer without limit", () => {
    const r = createFrameReader();
    let threw = false;
    try {
      for (let i = 0; i < 200; i++) r.push(Buffer.alloc(1024, 0xaa));
    } catch {
      threw = true;
    }
    expect(threw || r.buffered < 1024 * 200).toBe(true);
    expect(r.buffered).toBeLessThan(400);
  });
});

/** The figure the bound rests on, written out: 7 header bytes plus 254 less the unit id. */
describe("the retained maximum", () => {
  test("one complete ADU is 260 bytes, and that is all the reader ever holds", () => {
    expect(MAX_ADU_BYTES).toBe(260);
  });
});
