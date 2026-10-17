/**
 * The five builders and the check that runs before any byte exists.
 *
 * The point of these tests is not that the builders work. It is that there IS no sixth builder and
 * that no builder takes a function code, which is the structural half of MB-S1: the valve covers
 * everything that is not our code, and this file covers ours.
 */
import { describe, expect, test } from "bun:test";
import * as pdu from "@/lib/db/providers/industrial/modbus/pdu";
import {
  buildIdentification,
  buildRead,
  checkRead,
  ModbusRequestError,
} from "@/lib/db/providers/industrial/modbus/pdu";

describe("the module exports no way to send another function code", () => {
  test("every exported function is one of the known surfaces, the expectation reader included", () => {
    const callable = Object.entries(pdu)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(callable).toEqual(["ModbusRequestError", "buildIdentification", "buildRead", "checkRead", "expectationOf"]);
  });

  test("buildRead picks the function code from the table, so a caller cannot choose one", () => {
    const codes = (["coil", "discrete_input", "holding_register", "input_register"] as const).map(
      (table) => buildRead(1, 1, table, 0, 1)[7],
    );
    expect(codes).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  test("buildIdentification can only produce function code 43 with MEI type 14", () => {
    for (const code of ["basic", "regular", "extended"] as const) {
      const frame = buildIdentification(1, 1, code);
      expect(frame[7]).toBe(0x2b);
      expect(frame[8]).toBe(0x0e);
    }
  });
});

describe("the frame a builder produces", () => {
  test("carries the transaction id, protocol id 0, the length and the unit id", () => {
    const frame = buildRead(0x1234, 9, "holding_register", 100, 5);
    expect(frame.readUInt16BE(0)).toBe(0x1234);
    expect(frame.readUInt16BE(2)).toBe(0);
    expect(frame.readUInt16BE(4)).toBe(frame.length - 7 + 1);
    expect(frame[6]).toBe(9);
  });

  test("sends the PDU address as given, counted from zero", () => {
    expect(buildRead(1, 1, "holding_register", 107, 3).readUInt16BE(8)).toBe(107);
  });
});

describe("a read is checked before a byte exists", () => {
  test("unit 0 is refused, with the broadcast named as the reason", () => {
    expect(() => checkRead(0, "holding_register", 0, 1)).toThrow(/broadcast/);
  });

  test("units 1 to 255 are accepted and 256 is not", () => {
    expect(() => checkRead(1, "holding_register", 0, 1)).not.toThrow();
    expect(() => checkRead(255, "holding_register", 0, 1)).not.toThrow();
    expect(() => checkRead(256, "holding_register", 0, 1)).toThrow(ModbusRequestError);
  });

  test("the register limit is 125 and the bit limit is 2000", () => {
    expect(() => checkRead(1, "holding_register", 0, 125)).not.toThrow();
    expect(() => checkRead(1, "holding_register", 0, 126)).toThrow(/1 to 125/);
    expect(() => checkRead(1, "coil", 0, 2000)).not.toThrow();
    expect(() => checkRead(1, "coil", 0, 2001)).toThrow(/1 to 2000/);
  });

  test("quantity zero is refused", () => {
    expect(() => checkRead(1, "holding_register", 0, 0)).toThrow(ModbusRequestError);
  });

  test("address plus quantity may not pass the end of the table", () => {
    expect(() => checkRead(1, "holding_register", 65535, 1)).not.toThrow();
    expect(() => checkRead(1, "holding_register", 65535, 2)).toThrow(/passes the end/);
  });

  test("a non integer address or quantity is refused", () => {
    expect(() => checkRead(1, "holding_register", 1.5, 1)).toThrow(ModbusRequestError);
    expect(() => checkRead(1, "holding_register", 0, 1.5)).toThrow(ModbusRequestError);
  });

  test("buildRead refuses the same requests, so the check cannot be bypassed", () => {
    expect(() => buildRead(1, 0, "holding_register", 0, 1)).toThrow(ModbusRequestError);
    expect(() => buildRead(1, 1, "holding_register", 0, 126)).toThrow(ModbusRequestError);
  });
});

describe("the exception table", () => {
  test("covers exactly the codes the text defines", () => {
    expect(
      Object.keys(pdu.EXCEPTION_SENTENCES)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 11]);
  });

  test("02 and 04 both name a wrong unit id as a likely cause", () => {
    expect(pdu.EXCEPTION_SENTENCES[0x02]).toContain("unit id");
    expect(pdu.EXCEPTION_SENTENCES[0x04]).toContain("unit");
  });

  test("01 says the role may have been refused, because mbaps maps that to 01", () => {
    expect(pdu.EXCEPTION_SENTENCES[0x01]).toContain("role");
  });
});
