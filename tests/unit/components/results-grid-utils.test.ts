import { describe, test, expect } from "bun:test";
import {
  describeWarning,
  formatCellCopy,
  formatCellValue,
  generatedFieldNames,
  renderContextFor,
} from "@/components/results-grid/utils";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import type { VectorColumn } from "@/lib/db/vector/types";

// =============================================================================
// formatCellValue — output parity pins (#96)
//
// These cases pin the exact { display, className } output for every input shape
// the formatter handles today, so the registry-based refactor happens under
// green: any drift in grid-cell rendering fails here, not in production.
// =============================================================================

describe("formatCellValue parity", () => {
  test("null renders the NULL marker", () => {
    expect(formatCellValue(null)).toEqual({ display: "NULL", className: "text-fg-subtle italic" });
  });

  test("undefined renders the NULL marker", () => {
    expect(formatCellValue(undefined)).toEqual({ display: "NULL", className: "text-fg-subtle italic" });
  });

  test("object compact-stringifies on a single line", () => {
    expect(formatCellValue({ a: 1, b: "x" })).toEqual({
      display: '{"a":1,"b":"x"}',
      className: "text-hue-blue/80 italic font-light",
    });
  });

  test("array compact-stringifies on a single line", () => {
    expect(formatCellValue([1, 2, 3])).toEqual({
      display: "[1,2,3]",
      className: "text-hue-blue/80 italic font-light",
    });
  });

  test("number renders via String()", () => {
    expect(formatCellValue(42)).toEqual({ display: "42", className: "text-hue-amber/90 font-medium" });
    expect(formatCellValue(0)).toEqual({ display: "0", className: "text-hue-amber/90 font-medium" });
    expect(formatCellValue(-1.5)).toEqual({ display: "-1.5", className: "text-hue-amber/90 font-medium" });
  });

  test("boolean true takes the emerald hue token, false the rose one", () => {
    expect(formatCellValue(true)).toEqual({ display: "true", className: "text-hue-emerald/90" });
    expect(formatCellValue(false)).toEqual({ display: "false", className: "text-hue-rose/90" });
  });

  test("truthy status strings take the emerald hue token, case preserved", () => {
    expect(formatCellValue("true")).toEqual({ display: "true", className: "text-hue-emerald/90" });
    expect(formatCellValue("ACTIVE")).toEqual({ display: "ACTIVE", className: "text-hue-emerald/90" });
    expect(formatCellValue("Enabled")).toEqual({ display: "Enabled", className: "text-hue-emerald/90" });
  });

  test("falsy status strings take the rose hue token, case preserved", () => {
    expect(formatCellValue("false")).toEqual({ display: "false", className: "text-hue-rose/90" });
    expect(formatCellValue("INACTIVE")).toEqual({ display: "INACTIVE", className: "text-hue-rose/90" });
    expect(formatCellValue("Disabled")).toEqual({ display: "Disabled", className: "text-hue-rose/90" });
  });

  test("plain string renders as-is", () => {
    expect(formatCellValue("hello world")).toEqual({ display: "hello world", className: "text-fg-secondary" });
    expect(formatCellValue("")).toEqual({ display: "", className: "text-fg-secondary" });
  });

  test("JSON-parseable string keeps its raw string display in the grid", () => {
    // The grid cell must not re-serialize or reformat a JSON string — the
    // detail sheet is where json-kind values get the pretty treatment (#96).
    expect(formatCellValue('{"a": 1}')).toEqual({ display: '{"a": 1}', className: "text-fg-secondary" });
    expect(formatCellValue("[1, 2]")).toEqual({ display: "[1, 2]", className: "text-fg-secondary" });
  });

  test("pretty-printed JSON string display survives byte-for-byte", () => {
    const pretty = '{\n  "id": "1",\n  "name": "Ada"\n}';
    expect(formatCellValue(pretty)).toEqual({ display: pretty, className: "text-fg-secondary" });
  });
});

// =============================================================================
// describeWarning — how one engine notice reads (#273)
// =============================================================================

describe("describeWarning", () => {
  test("uses the engine's own wording when it reported a message", () => {
    expect(describeWarning({ message: "index advice available", code: "01000" })).toBe("index advice available");
  });

  test("falls back to the code when the message is empty, including code 0", () => {
    expect(describeWarning({ message: "", code: 0 })).toBe("Warning 0");
    expect(describeWarning({ message: "", code: "01000" })).toBe("Warning 01000");
  });

  test("still reports an entry that carries neither message nor code", () => {
    expect(describeWarning({ message: "" })).toBe("Warning");
  });

  test("leads with the severity the engine reported, the way psql prints it (#1401)", () => {
    expect(
      describeWarning({ message: 'table "nope" does not exist, skipping', code: "00000", severity: "NOTICE" }),
    ).toBe('NOTICE: table "nope" does not exist, skipping');
    expect(describeWarning({ message: "", code: "01000", severity: "WARNING" })).toBe("WARNING: Warning 01000");
  });
});

describe("formatCellCopy", () => {
  test("a renderer with no copy form copies its compact display, as Copy Cell always did", () => {
    expect(formatCellCopy("Alice")).toBe("Alice");
    expect(formatCellCopy(42)).toBe("42");
    expect(formatCellCopy({ a: 1 })).toBe('{"a":1}');
    expect(formatCellCopy('{\n  "id": 1\n}')).toBe('{\n  "id": 1\n}');
    expect(formatCellCopy(null)).toBe("NULL");
  });

  test("a binary value copies every byte, where its display is a preview", () => {
    const bytes = { type: "Buffer", data: Array.from({ length: 100 }, (_, index) => index) };
    const hex = bytes.data.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(formatCellValue(bytes).display).toHaveLength(77);
    expect(formatCellCopy(bytes)).toBe(`\\x${hex}`);
    expect(formatCellCopy(new Uint8Array([1, 2, 171, 255]))).toBe("\\x0102abff");
  });
});

describe("renderContextFor", () => {
  const embedding: VectorColumn = { kind: "dense", dtype: "float32", dimension: 2 };

  test("a declared column gets its declaration, and any other column none", () => {
    expect(renderContextFor({ embedding }, "embedding")).toEqual({ vector: embedding });
    expect(renderContextFor({ embedding }, "id")).toBeUndefined();
    expect(renderContextFor(undefined, "embedding")).toBeUndefined();
  });

  test("a column named like an Object.prototype member finds no declaration", () => {
    for (const field of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(renderContextFor({ embedding }, field)).toBeUndefined();
    }
  });
});

describe("formatCellValue and formatCellCopy with a column's declaration", () => {
  const context = { vector: { kind: "dense", dtype: "float32", dimension: 2 } } as const;

  test("a declared cell draws and copies as a vector", () => {
    expect(formatCellValue([1, 0.5], context)).toEqual({
      display: "[1.0, 0.5] 2 dims",
      className: "text-hue-teal font-mono",
    });
    expect(formatCellCopy([1, 0.5], context)).toBe("[1.0,0.5]");
  });

  test("a masked cell's text in a declared column draws and copies as the text", () => {
    expect(formatCellValue("***", context).display).toBe("***");
    expect(formatCellCopy("***", context)).toBe("***");
  });
});

describe("generatedFieldNames", () => {
  test("names the columns a result had to name itself", () => {
    expect([...generatedFieldNames(["id", "name", "id (2)", "(No column name)", "(No column name) (2)"])]).toEqual([
      "id (2)",
      "(No column name)",
      "(No column name) (2)",
    ]);
  });

  // The direction of every doubt is a refusal: a column the statement aliased `id (2)` beside
  // an `id` cannot be told from a numbered repeat, and neither is a column of the table.
  test("counts a numbered name as generated only when its base is in the result too", () => {
    expect([...generatedFieldNames(["total (2)", "a (3)", "a"])]).toEqual(["a (3)"]);
  });

  // Pinned against the producer, so a change to the numbered form fails here and not only there.
  test("names every column uniqueFieldNames made up, and no column the statement named", () => {
    const fields = uniqueFieldNames(["id", "", "id", "", "name", "id"]);
    expect([...generatedFieldNames(fields)]).toEqual(["(No column name)", "id (2)", "(No column name) (2)", "id (3)"]);
  });

  test("counts any digits in the numbered form, as it always has", () => {
    expect([...generatedFieldNames(["a", "a (1)", "a (02)", "a(2)"])]).toEqual(["a (1)", "a (02)"]);
  });

  test("leaves a result with no repeat and no unnamed column alone", () => {
    expect(generatedFieldNames(["id", "name", "price (usd)"]).size).toBe(0);
  });
});
