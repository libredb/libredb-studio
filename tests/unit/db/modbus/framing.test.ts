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
  FrameReader,
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
      const reader = new FrameReader();
      const head = Buffer.alloc(7);
      head.writeUInt16BE(1, 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(length, 4);
      head[6] = 1;
      expect(() => reader.push(Buffer.concat([head, Buffer.alloc(4)]))).toThrow(/MBAP length/);
    });
  }

  test("memory does not grow with what a peer sends under a huge length", () => {
    const reader = new FrameReader();
    const head = Buffer.alloc(7);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(0xffff, 4);
    head[6] = 1;
    expect(() => reader.push(head)).toThrow(ModbusFramingError);
    expect(reader.buffered).toBeLessThanOrEqual(7);
  });

  test("a protocol id other than zero is refused", () => {
    const reader = new FrameReader();
    const f = readOf(2);
    f.writeUInt16BE(1, 2);
    expect(() => reader.push(f)).toThrow(/protocol id/);
  });

  test("a partial header is held and nothing is produced", () => {
    const reader = new FrameReader();
    expect(reader.push(Buffer.alloc(6))).toEqual([]);
    expect(reader.buffered).toBe(6);
  });
});

describe("reassembly", () => {
  test("one answer split over two writes produces one frame", () => {
    const reader = new FrameReader();
    const f = readOf(2);
    expect(reader.push(f.subarray(0, 5))).toEqual([]);
    const frames = reader.push(f.subarray(5));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.functionCode).toBe(3);
  });

  test("two answers in one write produce two frames and leave nothing held", () => {
    const reader = new FrameReader();
    const frames = reader.push(Buffer.concat([readOf(1), readOf(1)]));
    expect(frames).toHaveLength(2);
    expect(reader.buffered).toBe(0);
  });

  test("an exception answer is recognised and its code read", () => {
    const reader = new FrameReader();
    const frames = reader.push(answer(1, 1, 0x83, Buffer.from([0x02])));
    expect(frames[0]?.isException).toBe(true);
    expect(frames[0]?.functionCode).toBe(3);
    expect(frames[0]?.exceptionCode).toBe(0x02);
  });
});

describe("a frame is checked against the request", () => {
  const one = (buf: Buffer): InboundFrame => new FrameReader().push(buf)[0] as InboundFrame;

  test("a stray transaction id is DISCARDED, not failed", () => {
    const match = matchToRequest(one(answer(999, 1, 3, Buffer.from([4, 0, 0, 0, 0]))), expect3);
    expect(match.kind).toBe("discard");
  });

  test("the real answer after a stray one is still matched", () => {
    const reader = new FrameReader();
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
    const r = new FrameReader();
    const wire = Buffer.concat([regAnswer(1, 10), regAnswer(2, 10), regAnswer(3, 10)]);
    const got: InboundFrame[] = [];
    for (const byte of wire) got.push(...r.push(Buffer.from([byte])));
    expect(got.map((f) => f.transactionId)).toEqual([1, 2, 3]);
    expect(r.buffered).toBe(0);
  });

  test("split at every point inside the seven byte header", () => {
    for (let cut = 1; cut <= 7; cut++) {
      const r = new FrameReader();
      const w = regAnswer(9, 5);
      const a = r.push(w.subarray(0, cut));
      const b = r.push(w.subarray(cut));
      expect([...a, ...b].map((f) => f.transactionId)).toEqual([9]);
    }
  });

  test("one frame plus the first byte of the next", () => {
    const r = new FrameReader();
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
      const r = new FrameReader();
      const wire = Buffer.concat(Array.from({ length: 6 }, (_, i) => regAnswer(i + 1, 20)));
      const got: InboundFrame[] = [];
      for (let o = 0; o < wire.length; o += size) got.push(...r.push(wire.subarray(o, o + size)));
      expect(got.map((f) => f.transactionId)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.buffered).toBe(0);
    }
  });

  test("the bound holds while the buffer GROWS, not only at the end", () => {
    const r = new FrameReader();
    const head = Buffer.alloc(7);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(0xffff, 4);
    head[6] = 1;
    expect(() => r.push(Buffer.concat([head, Buffer.alloc(5_000_000)]))).toThrow(/MBAP length/);
    expect(r.buffered).toBeLessThan(300);
  });

  test("a stream with no valid header does not grow the buffer without limit", () => {
    const r = new FrameReader();
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
