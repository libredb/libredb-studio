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
