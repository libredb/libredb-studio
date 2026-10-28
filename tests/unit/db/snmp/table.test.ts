/**
 * Conceptual tables, against the table that was actually served (M2).
 *
 * The fixture is not invented. On 13 October 2026 a Net-SNMP snmpd 5.9.4 agent served a table
 * indexed by a text string whose second column was missing one row, and these are the instances
 * it returned: the name column held abc, def and ghi, and the value column held entries for abc
 * and ghi only, with the def row absent from the wire entirely. A GetNext that reached the gap
 * stepped to the next row rather than to an empty value.
 *
 * The duplicate key case is here because a mutation run showed the no-repeat rule was not bound
 * by anything: the fixture carried no duplicate, so deleting the check changed no result.
 */
import { describe, expect, test } from "bun:test";
import {
  buildTable,
  decodeIndex,
  IndexDecodeError,
  joinAugments,
  rowKey,
  type Cell,
  type RowKeyInput,
} from "@/lib/db/providers/network/snmp/table";

const present = (value: string): Cell => ({ state: "present", value, raw: new Uint8Array() });
const keyFor = (text: string): RowKeyInput => {
  const suffix = [text.length, ...[...text].map((c) => c.charCodeAt(0))];
  const index = decodeIndex(suffix, [{ kind: "lengthPrefixedText" }]);
  return { key: rowKey(index), index, instanceSuffix: suffix.join(".") };
};
const KEYS = [keyFor("abc"), keyFor("def"), keyFor("ghi")];
const NAMES = {
  name: "name",
  cells: new Map([
    [KEYS[0].key, present("abc")],
    [KEYS[1].key, present("def")],
    [KEYS[2].key, present("ghi")],
  ]),
};
const VALUES = {
  name: "value",
  cells: new Map([
    [KEYS[0].key, present("abc-value")],
    [KEYS[2].key, present("ghi-value")],
  ]),
};

describe("an instance suffix decodes by the shape its INDEX clause declares", () => {
  test("a length prefixed text index", () => {
    expect(decodeIndex([3, 97, 98, 99], [{ kind: "lengthPrefixedText" }])).toEqual([{ kind: "text", value: "abc" }]);
  });
  test("an integer index", () => {
    expect(decodeIndex([11], [{ kind: "integer" }])).toEqual([{ kind: "number", value: 11 }]);
  });
  test("a compound index", () => {
    expect(
      decodeIndex([2, 1, 2, 65, 66], [{ kind: "integer" }, { kind: "integer" }, { kind: "lengthPrefixedText" }]),
    ).toEqual([
      { kind: "number", value: 2 },
      { kind: "number", value: 1 },
      { kind: "text", value: "AB" },
    ]);
  });
  test("a suffix with a sub-identifier left over is refused", () => {
    expect(() => decodeIndex([3, 97, 98, 99, 99], [{ kind: "lengthPrefixedText" }])).toThrow(IndexDecodeError);
  });
  test("a text index holding a sub-identifier that is not a byte is refused", () => {
    const run = () => decodeIndex([2, 97, 256], [{ kind: "lengthPrefixedText" }]);
    expect(run).toThrow(IndexDecodeError);
    expect(run).toThrow("index text holds a sub-identifier that is not a byte");
  });
  test("a suffix that ends early is refused", () => {
    expect(() => decodeIndex([3, 97, 98], [{ kind: "lengthPrefixedText" }])).toThrow(IndexDecodeError);
  });
});

describe("a gap in a column leaves a gap, and shifts nothing", () => {
  const table = buildTable(KEYS, [NAMES, VALUES]);
  test("every row key appears, in the order the agent gave them", () => {
    expect(table.rows.map((r) => (r.index[0] as { value: string }).value)).toEqual(["abc", "def", "ghi"]);
  });
  test("the row before the gap keeps its own value", () => {
    expect(table.rows[0].cells.get("value")).toMatchObject({ state: "present", value: "abc-value" });
  });
  test("the row in the gap is absent, not empty", () => {
    expect(table.rows[1].cells.get("value")?.state).toBe("absent");
  });
  test("the row after the gap is NOT shifted up into it", () => {
    expect(table.rows[2].cells.get("value")).toMatchObject({ state: "present", value: "ghi-value" });
  });
  test("an empty string stays present, which is a different fact from absent", () => {
    const empty = buildTable([KEYS[1]], [{ name: "value", cells: new Map([[KEYS[1].key, present("")]]) }]);
    expect(empty.rows[0].cells.get("value")?.state).toBe("present");
  });
  test("a repeated row key yields one row", () => {
    const repeated = buildTable([KEYS[0], KEYS[0], KEYS[1]], [NAMES]);
    expect(repeated.rows).toHaveLength(2);
    expect((repeated.rows[1].index[0] as { value: string }).value).toBe("def");
  });
});

describe("a cell no datagram can carry is named, not dropped", () => {
  const OID = "1.3.6.1.4.1.8072.1.3.2.3.1.2.11.98.117.121.117.107.49.50.56.48.48.48";
  const wide = {
    name: "outputFull",
    cells: new Map<string, Cell>([
      [KEYS[0].key, present("a value that fits")],
      [
        KEYS[1].key,
        { state: "unreachable", oid: OID, why: "v2c: no answer, the value exceeds what a datagram can carry" },
      ],
    ]),
  };
  const table = buildTable(KEYS, [wide]);
  test("it is reported by its own OID", () => {
    expect(table.unreachable).toHaveLength(1);
    expect(table.unreachable[0].oid).toBe(OID);
  });
  test("its row is still a row", () => {
    expect(table.rows).toHaveLength(3);
  });
});

describe("an AUGMENTS table joins on the index", () => {
  const base = buildTable(KEYS, [NAMES, VALUES]);
  const extra = {
    name: "ifName",
    cells: new Map([
      [KEYS[0].key, present("lo")],
      [KEYS[2].key, present("eth0")],
    ]),
  };
  const joined = joinAugments(base, [extra], KEYS);
  test("each row takes its own augmenting cell", () => {
    expect(joined.rows[0].cells.get("ifName")).toMatchObject({ value: "lo" });
    expect(joined.rows[2].cells.get("ifName")).toMatchObject({ value: "eth0" });
  });
  test("a base row with no augmenting row gains an absence, not its neighbour's value", () => {
    expect(joined.rows[1].cells.get("ifName")?.state).toBe("absent");
  });
});
