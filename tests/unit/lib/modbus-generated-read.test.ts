/**
 * The texts the object tree writes for a Modbus device, sent through the provider's own parser, so
 * "runs as is" is a test and not a claim.
 *
 * A click lands on one of two depths and the generator answers differently for each: a point has a
 * name the map already holds the unit, table, address and type for, and a unit has no point to
 * name, so the one shape that needs no map is written instead. Both texts are parsed here with
 * `parseReadRequest`, the same function the provider runs them through, because a generated
 * request that does not parse is a tree click that opens an editor and refuses on execute.
 */
import { describe, expect, test } from "bun:test";
import { parseReadRequest } from "@/lib/db/providers/industrial/modbus/request";
import type { ProviderCapabilities } from "@/lib/db/types";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";

const caps = { queryLanguage: "json", queryDialect: "modbus" } as ProviderCapabilities;
const NAMES: ReadonlySet<string> = new Set(["volts"]);

describe("a click on a point", () => {
  test("writes a read of that point by name, and the provider parses it as one", () => {
    const text = generateTableQuery(["1", "volts"], caps);

    expect(JSON.parse(text)).toEqual({ read: ["volts"] });
    expect(parseReadRequest(text, NAMES)).toEqual({ kind: "points", names: ["volts"] });
  });
});

describe("a click on a unit, where there is no point to name", () => {
  test("writes the one shape that needs no map: a range by address, with the unit filled in", () => {
    const text = generateTableQuery(["10"], caps);

    expect(JSON.parse(text)).toEqual({ unit: 10, table: "holding_register", address: 0, count: 1 });
    expect(parseReadRequest(text, NAMES)).toEqual({
      kind: "range",
      unitId: 10,
      table: "holding_register",
      address: 0,
      count: 1,
    });
  });

  test("falls back to unit 1 where the segment is not a unit id, rather than writing one that is not", () => {
    // An empty segment, a word and a fraction are the three ways the segment can fail to be a unit
    // id, and a request carrying `NaN` would not be JSON at all.
    for (const segment of ["", "all", "1.5"]) {
      expect(JSON.parse(generateTableQuery([segment], caps)).unit).toBe(1);
    }
  });

  test("the select generator answers the same line, because the line is correct wherever it lands", () => {
    expect(generateSelectQuery(["10"], [], caps)).toBe(generateTableQuery(["10"], caps));
  });
});
