/**
 * The read request is settled before any socket exists, so every refusal in this file is a
 * refusal the caller gets while the text is still in front of them.
 *
 * Each test binds ONE rule. Where the rule belongs to `checkRead` rather than to this parser, the
 * test says so by reading the message `checkRead` writes: that is the whole point of the parser
 * calling it instead of repeating the numbers, and a test that accepted any refusal here would
 * pass just as well if the bound had been copied and left to go stale.
 */
import { describe, expect, test } from "bun:test";
import { ModbusRequestError } from "@/lib/db/providers/industrial/modbus/pdu";
import { parseReadRequest } from "@/lib/db/providers/industrial/modbus/request";

const MAP = new Set(["voltage_l1", "frequency"]);
const NO_MAP: ReadonlySet<string> = new Set<string>();
const parse = (text: string, names: ReadonlySet<string> = MAP) => parseReadRequest(text, names);

describe("the text has to be one JSON object", () => {
  test("text that is not JSON is refused and the reason is carried", () => {
    expect(() => parse("{not json")).toThrow(ModbusRequestError);
    expect(() => parse("{not json")).toThrow(/not valid JSON/);
  });

  for (const [label, text] of [
    ["a list", "[1,2]"],
    ["a number", "7"],
    ["text", '"read"'],
    ["null", "null"],
  ] as const) {
    test(`${label} is not a read request`, () => {
      expect(() => parse(text)).toThrow(/a JSON object/);
    });
  }
});

describe("the shape is told apart by its discriminator, never guessed", () => {
  test("an object with none of the three is refused and all three are named", () => {
    const run = () => parse("{}");
    expect(run).toThrow(ModbusRequestError);
    expect(run).toThrow(/"read"/);
    expect(run).toThrow(/"identify"/);
    expect(run).toThrow(/"count"/);
  });

  test("two shapes at once are refused, and the refusal says how many", () => {
    expect(() => parse('{"read":["frequency"],"identify":"basic"}')).toThrow(/carries 2/);
  });

  test("a range key beside a named read is two shapes, not an unknown key", () => {
    // The order matters: if `shapeOf` looked only for `read` it would call this a named read with
    // a stray key, and the caller would be told to remove the very thing they meant to use.
    expect(() => parse('{"read":["frequency"],"address":5}')).toThrow(/carries 2/);
  });
});

describe("named points", () => {
  test("a named read returns the names", () => {
    expect(parse('{"read":["voltage_l1","frequency"]}')).toEqual({
      kind: "points",
      names: ["voltage_l1", "frequency"],
    });
  });

  test("an unknown key is refused rather than ignored", () => {
    expect(() => parse('{"read":["frequency"],"limit":5}')).toThrow(/no key "limit"/);
  });

  test("a name the map does not declare is refused", () => {
    expect(() => parse('{"read":["power_factor"]}')).toThrow(/no point named "power_factor"/);
  });

  test("with no map at all, the refusal says why a name cannot mean anything", () => {
    const run = () => parse('{"read":["frequency"]}', NO_MAP);
    expect(run).toThrow(/no register map/);
    expect(run).toThrow(/no discovery/);
  });

  test("an empty list is refused, because it reads nothing", () => {
    expect(() => parse('{"read":[]}')).toThrow(/carries no point name/);
  });

  test("a list that is not a list is refused", () => {
    expect(() => parse('{"read":"frequency"}')).toThrow(/must be a list/);
  });

  test("a name that is not text is refused and the value is described", () => {
    expect(() => parse('{"read":[7]}')).toThrow(/the number 7/);
  });

  test("an empty name is refused", () => {
    expect(() => parse('{"read":[""]}')).toThrow(/cannot be empty/);
  });

  test("the same name twice is refused, because the second row says nothing new", () => {
    expect(() => parse('{"read":["frequency","frequency"]}')).toThrow(/named twice/);
  });
});

describe("one range by address", () => {
  const RANGE = '{"unit":1,"table":"holding_register","address":100,"count":10}';

  test("a range read carries the four numbers the wire needs", () => {
    expect(parse(RANGE)).toEqual({
      kind: "range",
      unitId: 1,
      table: "holding_register",
      address: 100,
      count: 10,
    });
  });

  for (const missing of ["unit", "table", "address", "count"] as const) {
    test(`a range without "${missing}" is refused by name`, () => {
      const body = JSON.parse(RANGE) as Record<string, unknown>;
      delete body[missing];
      expect(() => parse(JSON.stringify(body))).toThrow(new RegExp(`needs "${missing}"`));
    });
  }

  test("a table Modbus does not have is refused, and the four are named", () => {
    const run = () => parse('{"unit":1,"table":"register","address":0,"count":1}');
    expect(run).toThrow(/coil, discrete_input, holding_register, input_register/);
    expect(run).toThrow(/the text "register"/);
  });

  for (const [key, text] of [
    ["unit", '{"unit":1.5,"table":"coil","address":0,"count":1}'],
    ["address", '{"unit":1,"table":"coil","address":"100","count":1}'],
    ["count", '{"unit":1,"table":"coil","address":0,"count":null}'],
  ] as const) {
    test(`"${key}" has to be a whole number`, () => {
      expect(() => parse(text)).toThrow(new RegExp(`"${key}" must be a whole number`));
    });
  }

  test("an unknown key is refused rather than ignored", () => {
    expect(() => parse('{"unit":1,"table":"coil","address":0,"count":1,"limit":5}')).toThrow(/no key "limit"/);
  });

  /**
   * These four are `checkRead`'s rules, not this parser's, and the assertions read the words
   * `checkRead` writes. If the bounds were ever copied into this file, these tests would go on
   * passing against the copy while the protocol's own numbers moved underneath them.
   */
  test("unit 0 is refused as the broadcast it is", () => {
    expect(() => parse('{"unit":0,"table":"coil","address":0,"count":1}')).toThrow(/broadcast/);
  });

  test("an address past the table is refused with the table's size", () => {
    expect(() => parse('{"unit":1,"table":"coil","address":65536,"count":1}')).toThrow(/from 0 to 65535/);
  });

  test("126 registers is one more than a read carries", () => {
    expect(() => parse('{"unit":1,"table":"holding_register","address":0,"count":126}')).toThrow(/1 to 125/);
  });

  test("2001 bits is one more than a read carries", () => {
    expect(() => parse('{"unit":1,"table":"coil","address":0,"count":2001}')).toThrow(/1 to 2000/);
  });

  test("a range that ends past the table is refused even though both numbers are legal alone", () => {
    expect(() => parse('{"unit":1,"table":"holding_register","address":65530,"count":10}')).toThrow(
      /passes the end of the table/,
    );
  });

  describe("an optional decode", () => {
    test("a type is carried through with its orders", () => {
      expect(
        parse(
          '{"unit":1,"table":"input_register","address":0,"count":4,"type":"float32","wordOrder":"low_first","byteOrder":"high_first"}',
        ),
      ).toEqual({
        kind: "range",
        unitId: 1,
        table: "input_register",
        address: 0,
        count: 4,
        type: "float32",
        wordOrder: "low_first",
        byteOrder: "high_first",
      });
    });

    test("a bit table has no type to decode as", () => {
      expect(() => parse('{"unit":1,"table":"coil","address":0,"count":8,"type":"uint16"}')).toThrow(
        /carries bits, not registers/,
      );
    });

    test("a type this provider does not decode is refused and the known ones are listed", () => {
      const run = () => parse('{"unit":1,"table":"holding_register","address":0,"count":2,"type":"decimal"}');
      expect(run).toThrow(/not a type this provider decodes/);
      expect(run).toThrow(/float32/);
    });

    test("a count that does not divide by the type's span is refused, not silently cut", () => {
      expect(() => parse('{"unit":1,"table":"holding_register","address":0,"count":5,"type":"float32"}')).toThrow(
        /does not divide by 2/,
      );
    });

    test("a count that divides exactly is accepted", () => {
      const request = parse('{"unit":1,"table":"holding_register","address":0,"count":6,"type":"float32"}');
      expect(request).toMatchObject({ count: 6, type: "float32" });
    });

    for (const key of ["wordOrder", "byteOrder"] as const) {
      test(`"${key}" without a type is refused, because it orders nothing`, () => {
        expect(() => parse(`{"unit":1,"table":"holding_register","address":0,"count":2,"${key}":"low_first"}`)).toThrow(
          new RegExp(`"${key}" orders the words`),
        );
      });

      test(`"${key}" takes only the two orders there are`, () => {
        expect(() =>
          parse(`{"unit":1,"table":"holding_register","address":0,"count":2,"type":"uint32","${key}":"big_endian"}`),
        ).toThrow(/high_first or low_first/);
      });
    }

    test("no type means no order keys in the parsed request at all", () => {
      const request = parse('{"unit":1,"table":"holding_register","address":0,"count":2}');
      expect(Object.hasOwn(request, "type")).toBe(false);
      expect(Object.hasOwn(request, "wordOrder")).toBe(false);
      expect(Object.hasOwn(request, "byteOrder")).toBe(false);
    });
  });
});

describe("the device identification objects", () => {
  for (const level of ["basic", "regular", "extended"] as const) {
    test(`"${level}" is a level the protocol has`, () => {
      expect(parse(`{"identify":"${level}"}`)).toEqual({ kind: "identify", level });
    });
  }

  test("a level the protocol does not have is refused and the three are named", () => {
    const run = () => parse('{"identify":"everything"}');
    expect(run).toThrow(/basic, regular, extended/);
    expect(run).toThrow(/the text "everything"/);
  });

  test("a level that is not text is refused", () => {
    expect(() => parse('{"identify":14}')).toThrow(/the number 14/);
  });

  test("an unknown key is refused rather than ignored", () => {
    expect(() => parse('{"identify":"basic","unit":1}')).toThrow(/carries 2/);
  });
});
