import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyValue } from "@/components/results-grid/renderers/classify";
import { getRenderer } from "@/components/results-grid/renderers/registry";
import { jsonRenderer } from "@/components/results-grid/renderers/json";
import { nullRenderer } from "@/components/results-grid/renderers/null";
import { scalarRenderer } from "@/components/results-grid/renderers/scalar";
import type { ValueKind } from "@/components/results-grid/renderers/types";

// =============================================================================
// classifyValue — value-shape classification (#96)
// =============================================================================

describe("classifyValue", () => {
  test("null and undefined are kind null", () => {
    expect(classifyValue(null)).toBe("null");
    expect(classifyValue(undefined)).toBe("null");
  });

  test("strings, numbers and booleans are kind scalar", () => {
    expect(classifyValue("hello")).toBe("scalar");
    expect(classifyValue("")).toBe("scalar");
    expect(classifyValue(42)).toBe("scalar");
    expect(classifyValue(0)).toBe("scalar");
    expect(classifyValue(true)).toBe("scalar");
    expect(classifyValue(false)).toBe("scalar");
  });

  test("objects and arrays are kind json", () => {
    expect(classifyValue({ a: 1 })).toBe("json");
    expect(classifyValue({})).toBe("json");
    expect(classifyValue([1, 2, 3])).toBe("json");
    expect(classifyValue([])).toBe("json");
  });

  test("a string parsing to a JSON object or array is kind json", () => {
    expect(classifyValue('{"a": 1}')).toBe("json");
    expect(classifyValue("[1, 2]")).toBe("json");
    expect(classifyValue('{\n  "id": "1",\n  "name": "Ada"\n}')).toBe("json");
    expect(classifyValue('  {"padded": true}  ')).toBe("json");
  });

  test("a string parsing to a JSON primitive stays scalar", () => {
    // Only containers get the json treatment — bare JSON primitives render as
    // the plain strings they are ("true" keeps its status coloring, etc.).
    expect(classifyValue("true")).toBe("scalar");
    expect(classifyValue("123")).toBe("scalar");
    expect(classifyValue('"quoted"')).toBe("scalar");
    expect(classifyValue("null")).toBe("scalar");
  });

  test("a non-JSON string stays scalar", () => {
    expect(classifyValue("{not json")).toBe("scalar");
    expect(classifyValue("[1, 2")).toBe("scalar");
    expect(classifyValue("plain text with { braces }")).toBe("scalar");
  });
});

// =============================================================================
// getRenderer — registry selection with scalar fallback
// =============================================================================

describe("getRenderer", () => {
  test("returns the renderer registered for each kind", () => {
    expect(getRenderer("null")).toBe(nullRenderer);
    expect(getRenderer("scalar")).toBe(scalarRenderer);
    expect(getRenderer("json")).toBe(jsonRenderer);
  });

  test("falls back to the scalar renderer for an unregistered kind", () => {
    expect(getRenderer("vector" as ValueKind)).toBe(scalarRenderer);
  });

  test("every renderer declares the kind it is registered under", () => {
    for (const kind of ["null", "scalar", "json"] as const) {
      expect(getRenderer(kind).kind).toBe(kind);
    }
  });
});

// =============================================================================
// renderCompact — per-renderer grid-cell output
// =============================================================================

describe("renderCompact", () => {
  test("nullRenderer renders the NULL marker for any input", () => {
    expect(nullRenderer.renderCompact(null)).toEqual({ display: "NULL", className: "text-zinc-600 italic" });
    expect(nullRenderer.renderCompact(undefined)).toEqual({ display: "NULL", className: "text-zinc-600 italic" });
  });

  test("jsonRenderer compact-stringifies objects and arrays on a single line", () => {
    expect(jsonRenderer.renderCompact({ a: 1 })).toEqual({
      display: '{"a":1}',
      className: "text-blue-400/80 italic font-light",
    });
    expect(jsonRenderer.renderCompact([1, 2])).toEqual({
      display: "[1,2]",
      className: "text-blue-400/80 italic font-light",
    });
  });

  test("jsonRenderer keeps a JSON string's raw display in the grid", () => {
    const pretty = '{\n  "id": 1\n}';
    expect(jsonRenderer.renderCompact(pretty)).toEqual({ display: pretty, className: "text-zinc-300" });
  });

  test("scalarRenderer keeps the status-string coloring", () => {
    expect(scalarRenderer.renderCompact("active")).toEqual({ display: "active", className: "text-emerald-500/90" });
    expect(scalarRenderer.renderCompact("disabled")).toEqual({ display: "disabled", className: "text-rose-500/90" });
    expect(scalarRenderer.renderCompact("plain")).toEqual({ display: "plain", className: "text-zinc-300" });
  });
});

// =============================================================================
// Rendering layer stays provider-agnostic (#96 acceptance: greppable)
// =============================================================================

describe("rendering layer is provider-agnostic", () => {
  test("no connection-type identifiers in the renderer modules or the formatter", () => {
    const renderersDir = join(process.cwd(), "src/components/results-grid/renderers");
    const sources = readdirSync(renderersDir).map((f) => join(renderersDir, f));
    sources.push(join(process.cwd(), "src/components/results-grid/utils.ts"));

    const providerTypeIds = /\b(postgres|mysql|sqlite|oracle|mssql|mongodb|redis|libredb)\b/i;
    for (const file of sources) {
      expect(readFileSync(file, "utf8")).not.toMatch(providerTypeIds);
    }
  });
});
