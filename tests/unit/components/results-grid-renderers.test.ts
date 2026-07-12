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
// renderDetail — per-renderer detail-sheet output (#96 phase 1)
// =============================================================================

describe("renderDetail", () => {
  test("nullRenderer pins the detail sheet's historical null/undefined split", () => {
    // The sheet has always shown lowercase "null" for null (typeof null ===
    // "object" took the JSON.stringify branch) and "NULL" for undefined.
    expect(nullRenderer.renderDetail(null)).toEqual({
      text: "null",
      className: "text-zinc-600 italic",
      preserveWhitespace: false,
    });
    expect(nullRenderer.renderDetail(undefined)).toEqual({
      text: "NULL",
      className: "text-zinc-600 italic",
      preserveWhitespace: false,
    });
  });

  test("scalarRenderer detail output matches its compact output inline", () => {
    for (const value of [42, true, false, "active", "disabled", "plain text"]) {
      const compact = scalarRenderer.renderCompact(value);
      expect(scalarRenderer.renderDetail(value)).toEqual({
        text: compact.display,
        className: compact.className,
        preserveWhitespace: false,
      });
    }
  });

  test("jsonRenderer pretty-prints objects and arrays with preserved whitespace", () => {
    const obj = { a: 1, b: [1, 2] };
    expect(jsonRenderer.renderDetail(obj)).toEqual({
      text: JSON.stringify(obj, null, 2),
      className: "text-zinc-300",
      preserveWhitespace: true,
    });
    expect(jsonRenderer.renderDetail([1, 2]).text).toBe("[\n  1,\n  2\n]");
  });

  test("jsonRenderer parses a JSON container string before pretty-printing", () => {
    expect(jsonRenderer.renderDetail('{"id":1}').text).toBe('{\n  "id": 1\n}');
    // An already-pretty JSON string round-trips to canonical two-space form.
    expect(jsonRenderer.renderDetail('{\n    "id": 1\n}').text).toBe('{\n  "id": 1\n}');
  });

  test("jsonRenderer keeps the raw string when the number round-trip would lose fidelity", () => {
    // 9007199254740993 > 2^53: JSON.parse would round it to ...992, so the
    // detail sheet must show the stored text, not the canonicalized lie.
    const bigInt = '{"n":9007199254740993}';
    expect(jsonRenderer.renderDetail(bigInt)).toEqual({
      text: bigInt,
      className: "text-zinc-300",
      preserveWhitespace: true,
    });
    // Same for representations stringify would normalize (1.50 -> 1.5).
    const trailingZero = '{"price":1.50}';
    expect(jsonRenderer.renderDetail(trailingZero).text).toBe(trailingZero);
    // A pretty-printed original with a lossy number keeps its own newlines.
    const prettyLossy = '{\n  "n": 9007199254740993\n}';
    const detail = jsonRenderer.renderDetail(prettyLossy);
    expect(detail.text).toBe(prettyLossy);
    expect(detail.preserveWhitespace).toBe(true);
  });

  test("whitespace inside JSON string values never triggers the raw fallback", () => {
    // Spaces/newlines inside string literals are significant and survive the
    // canonical round-trip, so this input still gets the pretty treatment.
    expect(jsonRenderer.renderDetail('{"note":"a  b"}').text).toBe('{\n  "note": "a  b"\n}');
    expect(jsonRenderer.renderDetail('{"quote":"she said \\"hi\\""}').text).toBe(
      '{\n  "quote": "she said \\"hi\\""\n}',
    );
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
