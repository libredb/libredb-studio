/**
 * The rule that an absent map lists nothing and never throws.
 *
 * This is bound by a test because the failure it prevents is invisible to every other test: a throw
 * here reaches the user as a red "Schema Error" toast, and the unit suite would stay green. The
 * toast is raised in one place only, inside the `catch` of
 * `src/hooks/use-connection-manager.ts:335-362`, so an empty list takes the success path.
 */
import { describe, expect, test } from "bun:test";
import {
  countObjects,
  listObjects,
  listUnits,
  MODBUS_OBJECT_KINDS,
  NO_DISCOVERY_SENTENCE,
} from "@/lib/db/providers/industrial/modbus/objects";
import { ModbusMapError } from "@/lib/db/providers/industrial/modbus/register-map";

const KINDS = MODBUS_OBJECT_KINDS.map((k) => k.id);

describe("a connection with no map", () => {
  for (const absent of [undefined, null, "", "   ", "\n", "[]", '{"points":[]}']) {
    test(`lists nothing and does not throw for ${JSON.stringify(absent)}`, () => {
      for (const kind of KINDS) {
        const listing = listObjects(absent, kind);
        expect(listing.objects).toEqual([]);
        expect(listing.notice).toBe(NO_DISCOVERY_SENTENCE);
      }
      expect(listUnits(absent)).toEqual([]);
    });
  }

  test("all four kinds still exist", () => {
    expect(KINDS).toEqual(["coil", "discrete_input", "input_register", "holding_register"]);
  });
});

describe("a map that is present and malformed is a different case", () => {
  test("it throws, because the user wrote that document and needs told", () => {
    expect(() => listObjects("{not json", "coil")).toThrow(ModbusMapError);
    expect(() => listObjects('[{"name":"x"}]', "coil")).toThrow(ModbusMapError);
  });
});

describe("a map that is present lists its own points", () => {
  const map = JSON.stringify([
    { name: "run", unitId: 1, table: "coil", address: 0, type: "bool" },
    { name: "volts", unitId: 1, table: "holding_register", address: 100, type: "uint16" },
    {
      name: "power",
      unitId: 3,
      table: "holding_register",
      address: 200,
      type: "float32",
      wordOrder: "high_first",
      byteOrder: "high_first",
    },
  ]);

  test("one kind lists only its own", () => {
    expect(listObjects(map, "coil").objects.map((o) => o.name)).toEqual(["run"]);
    expect(listObjects(map, "holding_register").objects.map((o) => o.name)).toEqual(["volts", "power"]);
    expect(listObjects(map, "input_register").objects).toEqual([]);
  });

  test("the units are the ones the map names, in order, and never a scan", () => {
    expect(listUnits(map)).toEqual([1, 3]);
  });

  test("a listed point carries its PDU address", () => {
    expect(listObjects(map, "holding_register").objects[0]).toEqual({
      kind: "holding_register",
      name: "volts",
      unitId: 1,
      address: 100,
      type: "uint16",
    });
  });
});

describe("a count is not a zero (the contract on countObjects)", () => {
  test("with no map every kind answers unavailable, never 0", () => {
    for (const absent of [undefined, null, "", "[]"]) {
      const counts = countObjects(absent);
      for (const kind of KINDS) {
        expect(counts[kind]).toEqual({ unavailable: NO_DISCOVERY_SENTENCE });
        expect(counts[kind]).not.toHaveProperty("count");
      }
    }
  });

  test("with a map present the count is the number of points of that kind", () => {
    const map = JSON.stringify([
      { name: "a", unitId: 1, table: "coil", address: 0, type: "bool" },
      { name: "b", unitId: 1, table: "coil", address: 1, type: "bool" },
      { name: "c", unitId: 1, table: "holding_register", address: 0, type: "uint16" },
    ]);
    const counts = countObjects(map);
    expect(counts.coil).toEqual({ count: 2 });
    expect(counts.holding_register).toEqual({ count: 1 });
  });

  test("a kind the map does not use counts 0, because that zero IS the answer", () => {
    const map = JSON.stringify([{ name: "a", unitId: 1, table: "coil", address: 0, type: "bool" }]);
    expect(countObjects(map).input_register).toEqual({ count: 0 });
    expect(countObjects(map).input_register).not.toHaveProperty("unavailable");
  });
});
