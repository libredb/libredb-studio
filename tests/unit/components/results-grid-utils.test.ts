import { describe, test, expect } from "bun:test";
import { formatCellValue } from "@/components/results-grid/utils";

// =============================================================================
// formatCellValue — output parity pins (#96)
//
// These cases pin the exact { display, className } output for every input shape
// the formatter handles today, so the registry-based refactor happens under
// green: any drift in grid-cell rendering fails here, not in production.
// =============================================================================

describe("formatCellValue parity", () => {
  test("null renders the NULL marker", () => {
    expect(formatCellValue(null)).toEqual({ display: "NULL", className: "text-zinc-600 italic" });
  });

  test("undefined renders the NULL marker", () => {
    expect(formatCellValue(undefined)).toEqual({ display: "NULL", className: "text-zinc-600 italic" });
  });

  test("object compact-stringifies on a single line", () => {
    expect(formatCellValue({ a: 1, b: "x" })).toEqual({
      display: '{"a":1,"b":"x"}',
      className: "text-blue-400/80 italic font-light",
    });
  });

  test("array compact-stringifies on a single line", () => {
    expect(formatCellValue([1, 2, 3])).toEqual({
      display: "[1,2,3]",
      className: "text-blue-400/80 italic font-light",
    });
  });

  test("number renders via String()", () => {
    expect(formatCellValue(42)).toEqual({ display: "42", className: "text-amber-500/90 font-medium" });
    expect(formatCellValue(0)).toEqual({ display: "0", className: "text-amber-500/90 font-medium" });
    expect(formatCellValue(-1.5)).toEqual({ display: "-1.5", className: "text-amber-500/90 font-medium" });
  });

  test("boolean true is emerald, false is rose", () => {
    expect(formatCellValue(true)).toEqual({ display: "true", className: "text-emerald-500/90" });
    expect(formatCellValue(false)).toEqual({ display: "false", className: "text-rose-500/90" });
  });

  test("truthy status strings are emerald, case preserved", () => {
    expect(formatCellValue("true")).toEqual({ display: "true", className: "text-emerald-500/90" });
    expect(formatCellValue("ACTIVE")).toEqual({ display: "ACTIVE", className: "text-emerald-500/90" });
    expect(formatCellValue("Enabled")).toEqual({ display: "Enabled", className: "text-emerald-500/90" });
  });

  test("falsy status strings are rose, case preserved", () => {
    expect(formatCellValue("false")).toEqual({ display: "false", className: "text-rose-500/90" });
    expect(formatCellValue("INACTIVE")).toEqual({ display: "INACTIVE", className: "text-rose-500/90" });
    expect(formatCellValue("Disabled")).toEqual({ display: "Disabled", className: "text-rose-500/90" });
  });

  test("plain string renders as-is", () => {
    expect(formatCellValue("hello world")).toEqual({ display: "hello world", className: "text-zinc-300" });
    expect(formatCellValue("")).toEqual({ display: "", className: "text-zinc-300" });
  });

  test("JSON-parseable string keeps its raw string display in the grid", () => {
    // The grid cell must not re-serialize or reformat a JSON string — the
    // detail sheet is where json-kind values get the pretty treatment (#96).
    expect(formatCellValue('{"a": 1}')).toEqual({ display: '{"a": 1}', className: "text-zinc-300" });
    expect(formatCellValue("[1, 2]")).toEqual({ display: "[1, 2]", className: "text-zinc-300" });
  });

  test("pretty-printed JSON string display survives byte-for-byte", () => {
    const pretty = '{\n  "id": "1",\n  "name": "Ada"\n}';
    expect(formatCellValue(pretty)).toEqual({ display: pretty, className: "text-zinc-300" });
  });
});
