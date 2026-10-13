/**
 * The valve, tested structurally rather than behaviourally.
 *
 * A behavioural test would check that the provider happens not to write today. These check that no
 * frame carrying another function code can leave the valve even when one is handed to it directly,
 * which is the claim MB-S1 makes. The frames are hand built here, because our own builders cannot
 * produce them: that is the point of them, and a test that could only use our builders would
 * certify nothing about a transport retry or a later edit.
 */
import { describe, expect, test } from "bun:test";
import { assertOutboundAllowed, ModbusValveDefect } from "@/lib/db/providers/industrial/modbus/valve";
import { MBAP_HEADER_BYTES } from "@/lib/db/providers/industrial/modbus/constants";

function frame(functionCode: number, body: Buffer = Buffer.alloc(4)): Buffer {
  const pdu = Buffer.concat([Buffer.from([functionCode]), body]);
  const head = Buffer.alloc(MBAP_HEADER_BYTES);
  head.writeUInt16BE(1, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(pdu.length + 1, 4);
  head[6] = 1;
  return Buffer.concat([head, pdu]);
}

describe("the valve passes exactly five shapes", () => {
  test("all 256 function codes, and only four pass without a second byte", () => {
    const passed: number[] = [];
    for (let fc = 0; fc <= 0xff; fc += 1) {
      try {
        assertOutboundAllowed(frame(fc));
        passed.push(fc);
      } catch (error) {
        expect(error).toBeInstanceOf(ModbusValveDefect);
      }
    }
    expect(passed).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  test("under function code 43, exactly one MEI type of 256 passes", () => {
    const passed: number[] = [];
    for (let mei = 0; mei <= 0xff; mei += 1) {
      try {
        assertOutboundAllowed(frame(0x2b, Buffer.from([mei, 0x01, 0x00])));
        passed.push(mei);
      } catch (error) {
        expect(error).toBeInstanceOf(ModbusValveDefect);
      }
    }
    expect(passed).toEqual([0x0e]);
  });

  test("the write function codes are each refused by name of their code", () => {
    for (const fc of [0x05, 0x06, 0x0f, 0x10, 0x15, 0x16, 0x17]) {
      expect(() => assertOutboundAllowed(frame(fc))).toThrow(ModbusValveDefect);
    }
  });

  test("function code 23 is refused although its name begins with Read", () => {
    expect(() => assertOutboundAllowed(frame(0x17))).toThrow(ModbusValveDefect);
  });

  test("a protocol id other than zero is refused", () => {
    const f = frame(0x03);
    f.writeUInt16BE(1, 2);
    expect(() => assertOutboundAllowed(f)).toThrow(/protocol id/i);
  });

  /**
   * The range and the consistency check are tested SEPARATELY and deliberately. A frame with a
   * length field simply overwritten fails the consistency check as well, so it would stay red if
   * the range rule were deleted: the mutation harness found exactly that and the test below is the
   * fix. These frames are built so that the length field AGREES with the bytes present, which
   * leaves the range as the only rule that can refuse them.
   */
  test("an MBAP length below 3 is refused even when it agrees with the frame", () => {
    const pdu = Buffer.from([0x03]);
    const head = Buffer.alloc(MBAP_HEADER_BYTES);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(pdu.length + 1, 4);
    head[6] = 1;
    const f = Buffer.concat([head, pdu]);
    expect(f.readUInt16BE(4)).toBe(2);
    expect(f.readUInt16BE(4)).toBe(f.length - MBAP_HEADER_BYTES + 1);
    expect(() => assertOutboundAllowed(f)).toThrow(/MBAP length/);
  });

  test("an MBAP length above 254 is refused even when it agrees with the frame", () => {
    const pdu = Buffer.alloc(254, 0);
    pdu[0] = 0x03;
    const head = Buffer.alloc(MBAP_HEADER_BYTES);
    head.writeUInt16BE(1, 0);
    head.writeUInt16BE(0, 2);
    head.writeUInt16BE(pdu.length + 1, 4);
    head[6] = 1;
    const f = Buffer.concat([head, pdu]);
    expect(f.readUInt16BE(4)).toBe(255);
    expect(f.readUInt16BE(4)).toBe(f.length - MBAP_HEADER_BYTES + 1);
    expect(() => assertOutboundAllowed(f)).toThrow(/MBAP length/);
  });

  test("a length that disagrees with the frame is refused", () => {
    const f = frame(0x03);
    f.writeUInt16BE(10, 4);
    expect(() => assertOutboundAllowed(f)).toThrow(/carries/i);
  });

  test("a frame too short to hold a function code is refused", () => {
    expect(() => assertOutboundAllowed(Buffer.alloc(MBAP_HEADER_BYTES))).toThrow(ModbusValveDefect);
  });
});
