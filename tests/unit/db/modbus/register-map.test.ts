/**
 * The register map. Two rules carry this file.
 *
 * The address is the PDU address, counted from zero, because PI-MBUS-300 Rev. J printed page 18
 * says "Holding register 40001 is addressed as register 0000 in the data address field". A number
 * copied from a manual is usually counted from one, so a map that accepted either would read a
 * neighbouring register with no error.
 *
 * A point wider than one register MUST state both orders, because a wrong order reads as a
 * plausible number and raises nothing.
 */
import { describe, expect, test } from "bun:test";
import { ModbusMapError, parseRegisterMap } from "@/lib/db/providers/industrial/modbus/register-map";

const one = (extra: Record<string, unknown> = {}) =>
  JSON.stringify([{ name: "v", unitId: 1, table: "holding_register", address: 10, type: "uint16", ...extra }]);

describe("an absent or empty map is not an error", () => {
  for (const absent of [undefined, null, "", "  \n ", "[]", '{"points":[]}']) {
    test(`${JSON.stringify(absent)} parses as empty`, () => {
      const parsed = parseRegisterMap(absent);
      expect(parsed.isEmpty).toBe(true);
      expect(parsed.points).toEqual([]);
      expect(parsed.warnings).toEqual([]);
    });
  }
});

describe("a map that is present is checked", () => {
  test("a list and an object with a points list are both accepted", () => {
    expect(parseRegisterMap(one()).points).toHaveLength(1);
    expect(parseRegisterMap(`{"points":${one()}}`).points).toHaveLength(1);
  });
  test("text that is not JSON is refused by name", () => {
    expect(() => parseRegisterMap("{not json")).toThrow(/not valid JSON/);
  });
  test("a document that is neither shape is refused", () => {
    expect(() => parseRegisterMap('"a string"')).toThrow(/list of points/);
    expect(() => parseRegisterMap("42")).toThrow(/list of points/);
  });
  test("an unknown key is refused rather than ignored", () => {
    expect(() => parseRegisterMap(one({ scaleFactor: 2 }))).toThrow(/unknown key "scaleFactor"/);
  });
  test("two points with one name are refused", () => {
    const two = JSON.stringify([
      { name: "v", unitId: 1, table: "coil", address: 0, type: "bool" },
      { name: "v", unitId: 1, table: "coil", address: 1, type: "bool" },
    ]);
    expect(() => parseRegisterMap(two)).toThrow(/named "v"/);
  });
});

describe("the address is zero based and the user is told so", () => {
  test("address 0 is valid", () => {
    expect(parseRegisterMap(one({ address: 0 })).points[0]?.address).toBe(0);
  });
  test("the last address of the table is valid and one past it is not", () => {
    expect(() => parseRegisterMap(one({ address: 65535 }))).not.toThrow();
    expect(() => parseRegisterMap(one({ address: 65536 }))).toThrow(/counted from zero/);
  });
  test("a negative address is refused", () => {
    expect(() => parseRegisterMap(one({ address: -1 }))).toThrow(ModbusMapError);
  });
  test("the refusal says a manual number is usually counted from one", () => {
    expect(() => parseRegisterMap(one({ address: 70000 }))).toThrow(/counted from one/);
  });
});

describe("unit ids", () => {
  test("unit 0 is refused, with the broadcast as the reason", () => {
    expect(() => parseRegisterMap(one({ unitId: 0 }))).toThrow(/broadcast/);
  });
  test("248 to 255 are accepted with a warning that a serial line reserves them", () => {
    const parsed = parseRegisterMap(one({ unitId: 250 }));
    expect(parsed.points).toHaveLength(1);
    expect(parsed.warnings.join(" ")).toContain("serial line reserves");
  });
  test("a unit inside 1 to 247 raises no warning", () => {
    expect(parseRegisterMap(one({ unitId: 7 })).warnings).toEqual([]);
  });
});

describe("a point wider than one register must state both orders", () => {
  test("a uint32 without a word order is refused, and the reason is said", () => {
    expect(() => parseRegisterMap(one({ type: "uint32" }))).toThrow(/word order/);
    expect(() => parseRegisterMap(one({ type: "uint32" }))).toThrow(/no default/);
  });
  test("a uint32 without a byte order is refused", () => {
    expect(() => parseRegisterMap(one({ type: "uint32", wordOrder: "high_first" }))).toThrow(/byte order/);
  });
  test("with both orders it is accepted", () => {
    const parsed = parseRegisterMap(one({ type: "float32", wordOrder: "low_first", byteOrder: "high_first" }));
    expect(parsed.points[0]).toMatchObject({ type: "float32", wordOrder: "low_first" });
  });
  test("a one register type needs no order", () => {
    expect(() => parseRegisterMap(one({ type: "int16" }))).not.toThrow();
  });
  test("an order that is not one of the two names is refused", () => {
    expect(() => parseRegisterMap(one({ type: "uint32", wordOrder: "abcd", byteOrder: "high_first" }))).toThrow(
      /word order/,
    );
  });
});

describe("type and table have to agree", () => {
  test("a bit table takes bool and nothing else", () => {
    expect(() =>
      parseRegisterMap(JSON.stringify([{ name: "c", unitId: 1, table: "coil", address: 0, type: "uint16" }])),
    ).toThrow(/must be "bool"/);
  });
  test("a register table does not take bool", () => {
    expect(() => parseRegisterMap(one({ type: "bool" }))).toThrow(/cannot be "bool"/);
  });
  test("a type without a fixed width must give a register count", () => {
    expect(() => parseRegisterMap(one({ type: "string" }))).toThrow(/register count/);
    expect(() =>
      parseRegisterMap(one({ type: "string", registers: 4, wordOrder: "high_first", byteOrder: "high_first" })),
    ).not.toThrow();
  });

  /**
   * This expectation was wrong on the first attempt: the test asserted that a four register string
   * needed no orders. The code refuses it, and the code is right. A string stored in registers is
   * byte swapped on real devices, which is why the issue's own fixture holds "strings (byte-swapped,
   * odd length, UTF-8)", so a multi register string needs its orders exactly as a number does.
   */
  test("a multi register string also has to state its orders", () => {
    expect(() => parseRegisterMap(one({ type: "string", registers: 4 }))).toThrow(/word order/);
    expect(() => parseRegisterMap(one({ type: "string", registers: 4, wordOrder: "high_first" }))).toThrow(
      /byte order/,
    );
  });

  test("a one register string needs no orders, because there is nothing to order", () => {
    expect(() => parseRegisterMap(one({ type: "string", registers: 1 }))).not.toThrow();
  });
  test("a register count that disagrees with the type is refused", () => {
    expect(() =>
      parseRegisterMap(one({ type: "uint32", registers: 3, wordOrder: "high_first", byteOrder: "high_first" })),
    ).toThrow(/2 register/);
  });
  test("an unknown table and an unknown type are each refused", () => {
    expect(() => parseRegisterMap(one({ table: "register" }))).toThrow(/four tables/);
    expect(() => parseRegisterMap(one({ type: "uint24" }))).toThrow(/unknown type/);
  });
  test("a point that reaches past the table end is refused", () => {
    expect(() =>
      parseRegisterMap(one({ address: 65535, type: "uint32", wordOrder: "high_first", byteOrder: "high_first" })),
    ).toThrow(/past the end/);
  });
});
