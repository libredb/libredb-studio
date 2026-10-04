/**
 * FieldData to cells (vector-family spec 5.5, 5.6, E13, E20, E26; R09 F15 to F18, R40 M19): every scalar arm, both
 * nullable layouts, both Timestamptz and Geometry arms, the vector types, struct arrays, the lossless dynamic field
 * and the string cut, each read one row at a time.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  cutString,
  DecodeNotes,
  dynamicEntries,
  isoFromMicros,
  readColumn,
  wkbToWkt,
} from "@/lib/db/providers/vector/milvus/field-data";
import type { WireFieldData } from "@/lib/db/providers/vector/milvus/client";
import { arrayScalars, scalarColumn, scalars, utf8, vectorColumn, vectors } from "../../../helpers/milvus-field-data";

function cells(fd: WireFieldData, notes = new DecodeNotes()): unknown[] {
  const column = readColumn(fd, notes);
  return Array.from({ length: column.length }, (_, row) => column.cell(row));
}

function messages(notes: DecodeNotes): string[] {
  return notes.warnings().map((warning) => warning.message);
}

describe("scalar arms (5.5)", () => {
  test.each([
    ["Bool", "bool_data", [true, false], [true, false]],
    ["Int8", "int_data", [-128, 127], [-128, 127]],
    ["Int16", "int_data", [7], [7]],
    ["Int32", "int_data", [2_147_483_647], [2_147_483_647]],
    [
      "Int64",
      "long_data",
      ["9223372036854775807", "-9223372036854775808"],
      ["9223372036854775807", "-9223372036854775808"],
    ],
    ["Float", "float_data", [Math.fround(0.1), Math.fround(1 / 3)], [0.1, 0.33333334]],
    ["Double", "double_data", [0.1, 1e300], [0.1, 1e300]],
    ["VarChar", "string_data", ["doc 0010"], ["doc 0010"]],
    ["String", "string_data", ["a"], ["a"]],
    ["Text", "string_data", ["long text"], ["long text"]],
  ] as const)("%s from %s", (type, arm, data, expected) => {
    expect(cells(scalarColumn("c", type, scalars(arm, data)))).toEqual([...expected]);
  });

  test("Int64 is an exact decimal string at both extremes, never a Number (E26)", () => {
    const [max, min] = cells(
      scalarColumn("id", "Int64", scalars("long_data", ["9223372036854775807", "-9223372036854775808"])),
    );
    expect(typeof max).toBe("string");
    expect([max, min]).toEqual(["9223372036854775807", "-9223372036854775808"]);
  });

  test("a non-finite Float or Double is shown as a word, with one warning per column", () => {
    const notes = new DecodeNotes();
    expect(cells(scalarColumn("f", "Float", scalars("float_data", [Number.POSITIVE_INFINITY, 1])), notes)).toEqual([
      "Infinity",
      1,
    ]);
    expect(
      cells(scalarColumn("d", "Double", scalars("double_data", [Number.NaN, Number.NEGATIVE_INFINITY])), notes),
    ).toEqual(["NaN", "-Infinity"]);
    expect(messages(notes)).toEqual([
      "1 cells of f are not finite numbers and are shown as words.",
      "2 cells of d are not finite numbers and are shown as words.",
    ]);
  });

  test("an Array is an array per row, Int64 elements as strings (R07 F16)", () => {
    const column = scalarColumn(
      "tags",
      "Array",
      arrayScalars("Int64", [scalars("long_data", ["1", "1152921504606846977"]), scalars("long_data", [])]),
    );
    expect(cells(column)).toEqual([["1", "1152921504606846977"], []]);
    const floats = scalarColumn("f", "Array", arrayScalars("Float", [scalars("float_data", [Math.fround(0.1)])]));
    expect(cells(floats)).toEqual([[0.1]]);
  });

  test("a JSON cell keeps an integer above 2^53 exact, with a warning naming the column (R09 F16)", () => {
    const notes = new DecodeNotes();
    const column = scalarColumn(
      "meta",
      "JSON",
      scalars("json_data", [utf8('{"n": 1152921504606846977, "f": 1.5}'), utf8("")]),
    );
    expect(cells(column, notes)).toEqual([{ n: "1152921504606846977", f: 1.5 }, null]);
    expect(messages(notes)).toEqual([
      "Integers above 2^53 in meta are shown as exact digit strings, because a JavaScript number would round them.",
    ]);
  });

  test("Timestamptz reads either arm: the ISO string 3.0.2 sends, or microseconds since the epoch (R09 F17)", () => {
    expect(cells(scalarColumn("ts", "Timestamptz", scalars("string_data", ["2026-10-02T12:00:00Z"])))).toEqual([
      "2026-10-02T12:00:00Z",
    ]);
    expect(
      cells(
        scalarColumn("ts", "Timestamptz", scalars("timestamptz_data", ["1790942400000000", "1790942400000001", "-1"])),
      ),
    ).toEqual(["2026-10-02T12:00:00.000Z", "2026-10-02T12:00:00.000001Z", "1969-12-31T23:59:59.999999Z"]);
  });

  test("a Timestamptz past the dates JavaScript holds is empty, with a warning", () => {
    const notes = new DecodeNotes();
    expect(
      cells(scalarColumn("ts", "Timestamptz", scalars("timestamptz_data", ["9223372036854775807"])), notes),
    ).toEqual([null]);
    expect(messages(notes)).toEqual(["1 cells of ts are in a form Studio does not decode and are empty."]);
    expect(isoFromMicros("9223372036854775807")).toBeUndefined();
  });

  test("Geometry reads either arm: WKT text, or WKB decoded to WKT (R09 F17)", () => {
    expect(cells(scalarColumn("geo", "Geometry", scalars("geometry_wkt_data", ["POINT (0 1)"])))).toEqual([
      "POINT (0 1)",
    ]);
    expect(cells(scalarColumn("geo", "Geometry", scalars("geometry_data", [wkbPoint(0, 1)])))).toEqual(["POINT (0 1)"]);
  });

  test("a WKB Studio does not decode is empty, with a warning", () => {
    const notes = new DecodeNotes();
    expect(
      cells(scalarColumn("geo", "Geometry", scalars("geometry_data", [wkb(true, 1001, [0, 0, 0])])), notes),
    ).toEqual([null]);
    expect(messages(notes)).toEqual(["1 cells of geo are in a form Studio does not decode and are empty."]);
  });

  test("a VarChar longer than 65,536 code units is cut with a marker, one warning counting the cells (R51 U39)", () => {
    const notes = new DecodeNotes();
    const long = "a".repeat(70_000);
    expect(cells(scalarColumn("t", "VarChar", scalars("string_data", [long, long, "short"])), notes)).toEqual([
      `${"a".repeat(65_536)}…[cut: 65536 of 70000 characters shown]`,
      `${"a".repeat(65_536)}…[cut: 65536 of 70000 characters shown]`,
      "short",
    ]);
    expect(messages(notes)).toEqual([
      "2 text cells were longer than 65,536 characters and are cut, with a marker; Copy and the detail view carry the cut text.",
    ]);
  });

  test("the cut never splits a surrogate pair", () => {
    const text = `${"a".repeat(65_535)}\u{1F600}tail`;
    const cut = cutString(text, new DecodeNotes());
    expect(cut.startsWith(`${"a".repeat(65_535)}…`)).toBe(true);
    expect(cutString("x".repeat(65_536), new DecodeNotes())).toBe("x".repeat(65_536));
  });

  test.each(["Decimal", "Date", "Time", "Mol"])(
    "%s cells are empty, with a warning naming the column and type (R03 F17)",
    (type) => {
      const notes = new DecodeNotes();
      const column = readColumn(scalarColumn("x", type, scalars("string_data", ["1", "2"])), notes);
      expect([column.length, column.cell(0), column.cell(1)]).toEqual([2, null, null]);
      expect(messages(notes)).toEqual([
        `Column x is of type ${type}, which Studio does not decode; its cells are empty.`,
      ]);
    },
  );

  test("an undecoded column with no arm set has no rows", () => {
    expect(
      readColumn({ ...scalarColumn("x", "Date", scalars("date_data", [])), scalars: null }, new DecodeNotes()).length,
    ).toBe(0);
  });

  test('an unknown DataType is "unsupported type N", never guessed (E20)', () => {
    expect(() => readColumn(scalarColumn("x", "31", scalars("int_data", [1])), new DecodeNotes())).toThrow(
      "Milvus returned a field of unsupported type 31, which Studio does not read rather than guess.",
    );
  });

  test("an arm the type never uses, or no arm at all, is a malformed answer", () => {
    expect(() => readColumn(scalarColumn("b", "Bool", scalars("mol_data", [])), new DecodeNotes())).toThrow(
      "Milvus returned column b in a shape Studio cannot read: the scalar arm mol_data for Bool.",
    );
    expect(() =>
      readColumn({ ...scalarColumn("b", "Bool", scalars("bool_data", [])), field: undefined }, new DecodeNotes()),
    ).toThrow("Milvus returned column b in a shape Studio cannot read: no data for Bool.");
  });
});

describe("nullable values (R09 F15)", () => {
  test("a scalar column is row-dense, with a placeholder under each null", () => {
    expect(cells(scalarColumn("n", "Int32", scalars("int_data", [5, 0, 7]), { valid: [true, false, true] }))).toEqual([
      5,
      null,
      7,
    ]);
  });

  test("a compact scalar column reads too, its values in row order", () => {
    expect(cells(scalarColumn("n", "Int32", scalars("int_data", [5, 7]), { valid: [true, false, true] }))).toEqual([
      5,
      null,
      7,
    ]);
  });

  test("a vector column is compact, holding only the present rows", () => {
    const column = vectorColumn("v", "FloatVector", vectors(2, "float_vector", { data: [1, 2] }), [false, true]);
    expect(cells(column)).toEqual([null, [1, 2]]);
  });

  test("any other count of values is a malformed answer", () => {
    expect(() =>
      readColumn(
        scalarColumn("n", "Int32", scalars("int_data", [5, 6, 7, 8]), { valid: [true, false, true] }),
        new DecodeNotes(),
      ),
    ).toThrow("Milvus returned column n in a shape Studio cannot read: 4 values for 3 rows.");
  });
});

describe("vector columns (5.5)", () => {
  test("FloatVector rows print each element as its shortest float32 decimal", () => {
    const data = [Math.fround(0.1), Math.fround(0.2), Math.fround(0.3), Math.fround(0.4)];
    expect(cells(vectorColumn("vec", "FloatVector", vectors(2, "float_vector", { data })))).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });

  test("Float16Vector, BFloat16Vector, Int8Vector and BinaryVector rows", () => {
    expect(
      cells(
        vectorColumn("h", "Float16Vector", vectors(1, "float16_vector", Uint8Array.from([0x00, 0x3c, 0x00, 0x40]))),
      ),
    ).toEqual([[1], [2]]);
    expect(
      cells(vectorColumn("b", "BFloat16Vector", vectors(1, "bfloat16_vector", Uint8Array.from([0x80, 0x3f])))),
    ).toEqual([[1]]);
    expect(cells(vectorColumn("i", "Int8Vector", vectors(2, "int8_vector", Uint8Array.from([0x80, 0x7f]))))).toEqual([
      [-128, 127],
    ]);
    expect(
      cells(vectorColumn("bin", "BinaryVector", vectors(16, "binary_vector", Uint8Array.from([9, 13, 0, 255])))),
    ).toEqual([
      [9, 13],
      [0, 255],
    ]);
  });

  test("a SparseFloatVector row is Milvus's index map, ascending, shortest floats", () => {
    const row = new Uint8Array(16);
    const view = new DataView(row.buffer);
    view.setUint32(0, 230, true);
    view.setFloat32(4, 0.2, true);
    view.setUint32(8, 17, true);
    view.setFloat32(12, 0.4, true);
    const [cell] = cells(
      vectorColumn("sp", "SparseFloatVector", vectors(231, "sparse_float_vector", { contents: [row], dim: "231" })),
    );
    expect(JSON.stringify(cell)).toBe('{"17":0.4,"230":0.2}');
  });

  test("an embedding list is an array of row arrays (R09 F18)", () => {
    const field = vectors(4, "vector_array", {
      dim: "4",
      element_type: "FloatVector",
      data: [
        vectors(4, "float_vector", { data: [0, 1, 0, 0] }),
        vectors(4, "float_vector", { data: [0, 1, 0, 0, 1, 1, 0, 0] }),
      ],
    });
    expect(cells(vectorColumn("semb", "ArrayOfVector", field))).toEqual([
      [[0, 1, 0, 0]],
      [
        [0, 1, 0, 0],
        [1, 1, 0, 0],
      ],
    ]);
  });

  test("an empty answer with dimension 0 has no rows; a length that is not whole rows is malformed", () => {
    expect(cells(vectorColumn("vec", "FloatVector", vectors(0, "float_vector", { data: [] })))).toEqual([]);
    expect(() =>
      readColumn(vectorColumn("vec", "FloatVector", vectors(0, "float_vector", { data: [1] })), new DecodeNotes()),
    ).toThrow("Milvus returned column vec in a shape Studio cannot read: a vector length that is not whole rows.");
    expect(() =>
      readColumn(
        vectorColumn("vec", "FloatVector", vectors(2, "float_vector", { data: [1, 2, 3] })),
        new DecodeNotes(),
      ),
    ).toThrow("a vector length that is not whole rows");
  });

  test("a 32,768-dimension cell survives whole (E13)", () => {
    const data = Array.from({ length: 32_768 }, (_, index) => Math.fround(index / 32_768));
    const [cell] = cells(vectorColumn("big", "FloatVector", vectors(32_768, "float_vector", { data })));
    expect((cell as number[]).length).toBe(32_768);
  });
});

describe("struct arrays (R09 F18)", () => {
  test("the columns of a struct zip into one array of element objects per row", () => {
    const struct: WireFieldData = {
      type: "ArrayOfStruct",
      field_name: "clips",
      scalars: null,
      vectors: null,
      struct_arrays: {
        fields: [
          scalarColumn("si", "Array", arrayScalars("Int32", [scalars("int_data", [0]), scalars("int_data", [10, 11])])),
          scalarColumn(
            "sv",
            "Array",
            arrayScalars("VarChar", [scalars("string_data", ["s00"]), scalars("string_data", ["s10"])]),
          ),
        ],
      },
      field_id: "200",
      is_dynamic: false,
      valid_data: [],
      field: "struct_arrays",
    };
    const [first, second] = cells(struct) as Record<string, unknown>[][];
    expect(first.map((element) => Object.assign({}, element))).toEqual([{ si: 0, sv: "s00" }]);
    expect(second.map((element) => Object.assign({}, element))).toEqual([
      { si: 10, sv: "s10" },
      { si: 11, sv: null },
    ]);
    expect(Object.getPrototypeOf(first[0])).toBeNull();
    expect(cells({ ...struct, struct_arrays: { fields: [] } })).toEqual([]);
  });
});

describe("the dynamic field, read losslessly (R40 M19, R51 U14m)", () => {
  test("keys in stored order, digit-named keys included, which JSON.parse would reorder", () => {
    const cell = dynamicEntries('{"zeta": 8, "17": 1, "2": [1, "a,]}"], "o": {"k": "}"}}', new DecodeNotes());
    expect(cell.entries).toEqual([
      ["zeta", 8],
      ["17", 1],
      ["2", [1, "a,]}"]],
      ["o", { k: "}" }],
    ]);
    expect(cell.duplicates).toEqual([]);
  });

  test("a repeated key keeps its last value at its first position, and is named", () => {
    const cell = dynamicEntries('{"k":1,"j":0,"k":2,"k":3}', new DecodeNotes());
    expect(cell).toEqual({
      entries: [
        ["k", 3],
        ["j", 0],
      ],
      duplicates: ["k"],
    });
  });

  test("an integer above 2^53 stays exact, with a warning naming the key", () => {
    const notes = new DecodeNotes();
    expect(dynamicEntries('{"big_int": 1152921504606846977}', notes).entries).toEqual([
      ["big_int", "1152921504606846977"],
    ]);
    expect(messages(notes)).toEqual([
      "Integers above 2^53 in $meta.big_int are shown as exact digit strings, because a JavaScript number would round them.",
    ]);
  });

  test("__proto__, constructor and an escaped key are plain data", () => {
    expect(
      dynamicEntries('{"__proto__": 1, "constructor": 2, "a\\"b": true, " ": null}', new DecodeNotes()).entries,
    ).toEqual([
      ["__proto__", 1],
      ["constructor", 2],
      ['a"b', true],
      [" ", null],
    ]);
  });

  test("an empty object has no keys", () => {
    expect(dynamicEntries(" { } ", new DecodeNotes()).entries).toEqual([]);
  });

  test.each(["[1]", '{"a" 1}', '{"a": 1 "b": 2}', "{1: 2}", '{"a": 1'])("%s is not a dynamic field", (text) => {
    expect(() => dynamicEntries(text, new DecodeNotes())).toThrow(QueryError);
    expect(() => dynamicEntries(text, new DecodeNotes())).toThrow(
      "Milvus returned a dynamic field that is not a JSON object.",
    );
  });

  test("a dynamic column reads each row's raw bytes, an empty one as null", () => {
    const column = readColumn(
      scalarColumn("$meta", "JSON", scalars("json_data", [utf8('{"a": 1}'), utf8("")]), { dynamic: true }),
      new DecodeNotes(),
    );
    expect(column.isDynamic).toBe(true);
    expect([column.cell(0), column.cell(1)]).toEqual([{ entries: [["a", 1]], duplicates: [] }, null]);
  });
});

describe("wkbToWkt", () => {
  test.each([
    ["a point, little-endian", wkbPoint(0, 1), "POINT (0 1)"],
    ["a point, big-endian", wkb(false, 1, [1.5, -2]), "POINT (1.5 -2)"],
    ["an empty point", wkb(true, 1, [Number.NaN, Number.NaN]), "POINT EMPTY"],
    [
      "a line",
      wkb(
        true,
        2,
        [],
        [
          [0, 0],
          [1, 1],
        ],
      ),
      "LINESTRING (0 0, 1 1)",
    ],
    ["an empty line", wkb(true, 2, [], []), "LINESTRING EMPTY"],
    [
      "a polygon",
      polygon([
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ]),
      "POLYGON ((0 0, 1 0, 0 1, 0 0))",
    ],
    ["a multipoint", multi(4, [wkbPoint(0, 0), wkbPoint(1, 1)]), "MULTIPOINT ((0 0), (1 1))"],
    [
      "a collection",
      multi(7, [
        wkbPoint(0, 1),
        wkb(
          true,
          2,
          [],
          [
            [0, 0],
            [1, 1],
          ],
        ),
      ]),
      "GEOMETRYCOLLECTION (POINT (0 1), LINESTRING (0 0, 1 1))",
    ],
  ])("%s", (_, bytes, text) => {
    expect(wkbToWkt(bytes)).toBe(text);
  });

  test("a type Studio does not decode, a part it does not decode, a truncated body and trailing bytes are undefined", () => {
    expect(wkbToWkt(wkb(true, 1001, [0, 0, 0]))).toBeUndefined();
    expect(wkbToWkt(wkb(true, 0, []))).toBeUndefined();
    expect(wkbToWkt(multi(4, [wkb(true, 1001, [0, 0, 0])]))).toBeUndefined();
    expect(wkbToWkt(wkbPoint(0, 1).subarray(0, 12))).toBeUndefined();
    expect(wkbToWkt(Uint8Array.from([...wkbPoint(0, 1), 0]))).toBeUndefined();
  });
});

// -- WKB builders for the tests above -----------------------------------------------------------------------------

function wkb(
  little: boolean,
  type: number,
  coordinates: readonly number[],
  points?: readonly (readonly number[])[],
): Uint8Array {
  const doubles = points === undefined ? coordinates : points.flat();
  const bytes = new Uint8Array(5 + (points === undefined ? 0 : 4) + doubles.length * 8);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, little ? 1 : 0);
  view.setUint32(1, type, little);
  let at = 5;
  if (points !== undefined) {
    view.setUint32(at, points.length, little);
    at += 4;
  }
  for (const value of doubles) {
    view.setFloat64(at, value, little);
    at += 8;
  }
  return bytes;
}

function wkbPoint(x: number, y: number): Uint8Array {
  return wkb(true, 1, [x, y]);
}

function polygon(ring: readonly (readonly number[])[]): Uint8Array {
  const line = wkb(true, 2, [], ring).subarray(5);
  const bytes = new Uint8Array(9 + line.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 3, true);
  view.setUint32(5, 1, true);
  bytes.set(line, 9);
  return bytes;
}

function multi(type: number, parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(9 + size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, type, true);
  view.setUint32(5, parts.length, true);
  let at = 9;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
