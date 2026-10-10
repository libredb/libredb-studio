/**
 * The iterative schema walk of the S3 Parquet preview: hyparquet rebuilds the
 * schema tree recursively once per chunk read, so the flat list parquetMetadata returns is bounded here first, in
 * depth and size, with an explicit stack; it yields the top-level columns, their leaf counts and VARIANT flags, and
 * each leaf's type string.
 */
import { describe, expect, test } from "bun:test";
import { S3_PREVIEW_ELEMENTS_PER_COLUMN, S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import {
  parquetTypeString,
  type SchemaElementLike,
  walkParquetSchema,
} from "@/lib/db/providers/objectstore/s3/parquet-schema";

const root = (children: number): SchemaElementLike => ({ name: "schema", num_children: children });
const leaf = (name: string, type = "INT64"): SchemaElementLike => ({ name, type });
const group = (name: string, children: number, logical?: string): SchemaElementLike => ({
  name,
  num_children: children,
  ...(logical === undefined ? {} : { logical_type: { type: logical } }),
});
const walk = (schema: readonly SchemaElementLike[]) => walkParquetSchema(schema, S3_PREVIEW_LIMITS);
const chain = (groups: number): SchemaElementLike[] => [
  root(1),
  ...Array.from({ length: groups }, (_, index) => group(`g${index}`, 1)),
  leaf("x"),
];

describe("walkParquetSchema: the refusals", () => {
  test("a chain of parquetMaxSchemaDepth + 1 groups is refused, and one of parquetMaxSchemaDepth - 1 passes", () => {
    expect(walk(chain(S3_PREVIEW_LIMITS.parquetMaxSchemaDepth + 1))).toEqual({ ok: false });
    expect(walk(chain(S3_PREVIEW_LIMITS.parquetMaxSchemaDepth - 1)).ok).toBe(true);
  });

  test("an element declaring more children than elements remain is refused", () => {
    expect(walk([root(2), leaf("a")])).toEqual({ ok: false });
    expect(walk([root(1), group("s", 3), leaf("a")])).toEqual({ ok: false });
  });

  test("a list over parquetMaxLeafColumns times 8 elements is refused before any walk, and one of exactly that many passes", () => {
    const bound = S3_PREVIEW_LIMITS.parquetMaxLeafColumns * S3_PREVIEW_ELEMENTS_PER_COLUMN;
    const flat = (columns: number) => [
      root(columns),
      ...Array.from({ length: columns }, (_, index) => leaf(`c${index}`)),
    ];
    expect(flat(bound)).toHaveLength(bound + 1);
    expect(walk(flat(bound))).toEqual({ ok: false });
    expect(flat(bound - 1)).toHaveLength(bound);
    expect(walk(flat(bound - 1)).ok).toBe(true);
  });

  test("elements left after the root's subtree ends are refused, and so is an empty list or a negative child count", () => {
    expect(walk([root(1), leaf("a"), leaf("b")])).toEqual({ ok: false });
    expect(walk([])).toEqual({ ok: false });
    expect(walk([root(1), { name: "s", num_children: -1 }])).toEqual({ ok: false });
  });

  test("two children of one group with the same name are refused, at the root and below it", () => {
    expect(walk([root(2), leaf("v"), leaf("v")])).toEqual({ ok: false, duplicateName: true });
    expect(
      walk([root(2), group("v", 2, "VARIANT"), leaf("metadata"), leaf("value"), group("v", 1), leaf("value")]),
    ).toEqual({ ok: false, duplicateName: true });
    expect(walk([root(1), group("s", 2), leaf("a"), leaf("a")])).toEqual({ ok: false, duplicateName: true });
  });

  test("the same name under two different groups, or at two levels, passes", () => {
    expect(walk([root(2), group("a", 1), leaf("x"), group("b", 1), leaf("x")]).ok).toBe(true);
    expect(walk([root(1), group("x", 1), leaf("x")]).ok).toBe(true);
  });

  test("a DECIMAL logical or converted type lacking its precision or its scale is refused", () => {
    expect(walk([root(1), { name: "d", type: "INT64", logical_type: { type: "DECIMAL", scale: 2 } }])).toEqual({
      ok: false,
    });
    expect(walk([root(1), { name: "d", type: "INT64", logical_type: { type: "DECIMAL", precision: 9 } }])).toEqual({
      ok: false,
    });
    expect(walk([root(1), { name: "d", type: "INT64", converted_type: "DECIMAL", scale: 0 }])).toEqual({ ok: false });
    expect(walk([root(1), { name: "d", type: "INT64", converted_type: "DECIMAL", precision: 9 }])).toEqual({
      ok: false,
    });
  });

  test("a chain of 100,000 groups is refused without a stack overflow", () => {
    expect(() => walk(chain(100_000))).not.toThrow();
    expect(walk(chain(100_000))).toEqual({ ok: false });
  });
});

describe("walkParquetSchema: the shape", () => {
  test("a flat schema, a struct, a list and a map give names, leaf counts and type strings in schema order", () => {
    const shape = walk([
      root(4),
      leaf("id"),
      group("s", 2),
      leaf("a", "INT32"),
      { name: "b", type: "BYTE_ARRAY", logical_type: { type: "STRING" } },
      group("l", 1, "LIST"),
      group("list", 1),
      leaf("element"),
      group("m", 1, "MAP"),
      group("key_value", 2),
      { name: "key", type: "BYTE_ARRAY", logical_type: { type: "STRING" } },
      leaf("value", "INT32"),
    ]);
    expect(shape).toEqual({
      ok: true,
      columns: [
        { name: "id", type: "INT64", leaves: 1, variant: false },
        { name: "s", type: "group STRUCT", leaves: 2, variant: false },
        { name: "l", type: "group LIST", leaves: 1, variant: false },
        { name: "m", type: "group MAP", leaves: 2, variant: false },
      ],
      leaves: [
        { path: ["id"], type: "INT64", underVariant: false },
        { path: ["s", "a"], type: "INT32", underVariant: false },
        { path: ["s", "b"], type: "BYTE_ARRAY STRING", underVariant: false },
        { path: ["l", "list", "element"], type: "INT64", underVariant: false },
        { path: ["m", "key_value", "key"], type: "BYTE_ARRAY STRING", underVariant: false },
        { path: ["m", "key_value", "value"], type: "INT32", underVariant: false },
      ],
    });
  });

  test("a VARIANT group, and a struct holding a VARIANT element, are flagged, and their leaves typed group VARIANT", () => {
    const shape = walk([
      root(2),
      group("v", 2, "VARIANT"),
      leaf("metadata", "BYTE_ARRAY"),
      leaf("value", "BYTE_ARRAY"),
      group("s", 2),
      leaf("plain"),
      group("inner", 1, "VARIANT"),
      leaf("value", "BYTE_ARRAY"),
    ]);
    expect(shape.ok && shape.columns).toEqual([
      { name: "v", type: "group VARIANT", leaves: 2, variant: true },
      { name: "s", type: "group STRUCT", leaves: 2, variant: true },
    ]);
    expect(shape.ok && shape.leaves.map((each) => [each.path.join("."), each.type, each.underVariant])).toEqual([
      ["v.metadata", "group VARIANT", true],
      ["v.value", "group VARIANT", true],
      ["s.plain", "INT64", false],
      ["s.inner.value", "group VARIANT", true],
    ]);
  });

  test("a DECIMAL leaf carries its precision and scale, from the logical or the converted type", () => {
    const shape = walk([
      root(2),
      { name: "d", type: "FIXED_LEN_BYTE_ARRAY", logical_type: { type: "DECIMAL", precision: 18, scale: 2 } },
      { name: "e", type: "INT64", converted_type: "DECIMAL", precision: 10, scale: 3 },
    ]);
    expect(shape.ok && shape.leaves.map((each) => each.decimal)).toEqual([
      { precision: 18, scale: 2 },
      { precision: 10, scale: 3 },
    ]);
  });
});

describe("parquetTypeString", () => {
  test("leaves: physical type, then the logical or converted annotation", () => {
    expect(parquetTypeString({ name: "a", type: "INT64" }, 0)).toBe("INT64");
    expect(parquetTypeString({ name: "a", type: "BYTE_ARRAY" }, 0)).toBe("BYTE_ARRAY");
    expect(parquetTypeString({ name: "a", type: "INT32", logical_type: { type: "DATE" } }, 0)).toBe("INT32 DATE");
    expect(
      parquetTypeString(
        { name: "a", type: "INT64", logical_type: { type: "TIMESTAMP", unit: "MICROS", isAdjustedToUTC: true } },
        0,
      ),
    ).toBe("INT64 TIMESTAMP(MICROS, UTC)");
    expect(
      parquetTypeString(
        { name: "a", type: "INT64", logical_type: { type: "TIME", unit: "MILLIS", isAdjustedToUTC: false } },
        0,
      ),
    ).toBe("INT64 TIME(MILLIS, local)");
    expect(
      parquetTypeString(
        { name: "a", type: "FIXED_LEN_BYTE_ARRAY", logical_type: { type: "DECIMAL", precision: 18, scale: 2 } },
        0,
      ),
    ).toBe("FIXED_LEN_BYTE_ARRAY DECIMAL(18,2)");
    expect(
      parquetTypeString(
        { name: "a", type: "INT32", logical_type: { type: "INTEGER", bitWidth: 8, isSigned: false } },
        0,
      ),
    ).toBe("INT32 INTEGER(8, unsigned)");
    expect(
      parquetTypeString(
        { name: "a", type: "INT32", logical_type: { type: "INTEGER", bitWidth: 16, isSigned: true } },
        0,
      ),
    ).toBe("INT32 INTEGER(16, signed)");
    expect(parquetTypeString({ name: "a", type: "BYTE_ARRAY", converted_type: "UTF8" }, 0)).toBe("BYTE_ARRAY UTF8");
    expect(parquetTypeString({ name: "a", type: "INT64", converted_type: "DECIMAL", precision: 12, scale: 4 }, 0)).toBe(
      "INT64 DECIMAL(12,4)",
    );
  });

  test("groups: LIST, MAP (logical or converted), VARIANT, STRUCT with children, plain group without", () => {
    expect(parquetTypeString({ name: "g", converted_type: "LIST" }, 1)).toBe("group LIST");
    expect(parquetTypeString({ name: "g", converted_type: "MAP_KEY_VALUE" }, 1)).toBe("group MAP");
    expect(parquetTypeString({ name: "g", logical_type: { type: "VARIANT" } }, 2)).toBe("group VARIANT");
    expect(parquetTypeString({ name: "g" }, 2)).toBe("group STRUCT");
    expect(parquetTypeString({ name: "g" }, 0)).toBe("group");
  });
});
