/**
 * The vector cell (vector-family spec 3.10): what the grid, the row detail and Copy Cell write for a cell of a
 * declared vector column, over hand-written cells and over both engines' expected cells
 * (`tests/fixtures/vector/<engine>/expected-cells.json`), which hold every kind and element type the fixture seeds
 * write, in Studio's cell form and derived from the seeds rather than from any REST answer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyValue } from "@/components/results-grid/renderers/classify";
import type { RenderContext } from "@/components/results-grid/renderers/types";
import { isVectorCell, vectorRenderer } from "@/components/results-grid/renderers/vector";
import type { SparseEncoding, VectorColumn, VectorDType, VectorKind } from "@/lib/db/vector/types";
import type { ExpectedCell, ExpectedCells } from "../../live/vector-evidence-derive";

const CLASS = "text-hue-teal/80 font-mono";
const REFUSAL = "A value that is not a cell of a declared vector column reached the vector renderer";

function column(
  kind: VectorKind,
  dtype: VectorDType,
  dimension: number | null = null,
  sparseEncoding?: SparseEncoding,
): VectorColumn {
  return sparseEncoding === undefined ? { kind, dtype, dimension } : { kind, dtype, dimension, sparseEncoding };
}

function context(
  kind: VectorKind,
  dtype: VectorDType,
  dimension: number | null = null,
  sparseEncoding?: SparseEncoding,
): RenderContext {
  return { vector: column(kind, dtype, dimension, sparseEncoding) };
}

const display = (value: unknown, ctx: RenderContext): string => vectorRenderer.renderCompact(value, ctx).display;

function copy(value: unknown, ctx: RenderContext | undefined): string {
  const write = vectorRenderer.renderCopy;
  if (write === undefined) throw new Error("the vector renderer has no copy form");
  return write(value, ctx);
}

/** 768 elements cycling -1, -0.75, ..., 1: each exact in float32, and -1, 0 and 1 integral. */
const EMBEDDING = Array.from({ length: 768 }, (_, index) => ((index % 9) - 4) / 4);
/** The same, written the way the spec says a float vector is copied: a fraction on every integral element. */
const EMBEDDING_COPY = `[${EMBEDDING.map((value) => (Number.isInteger(value) ? value.toFixed(1) : String(value))).join(",")}]`;

describe("the grid cell", () => {
  test("a dense cell shows its first 8 elements, an ellipsis and its dimension", () => {
    expect(vectorRenderer.renderCompact(EMBEDDING, context("dense", "float32", 768))).toEqual({
      display: "[-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, …] 768 dims",
      className: CLASS,
    });
  });

  test("a short cell shows every element and no ellipsis, and an undeclared dimension is the cell's length", () => {
    expect(display([1, 2.5], context("dense", "float32"))).toBe("[1.0, 2.5] 2 dims");
    expect(display([7], context("dense", "float16"))).toBe("[7.0] 1 dim");
    expect(display([-128, 0, 127], context("dense", "int8", 3))).toBe("[-128, 0, 127] 3 dims");
  });

  test("a binary cell shows its bytes and its bit dimension", () => {
    expect(display([0, 255], context("dense", "binary", 16))).toBe("[0, 255] 16 bits");
    expect(display([85], context("dense", "binary"))).toBe("[85] 8 bits");
    expect(display([1, 2, 3, 4, 5, 6, 7, 8, 9], context("dense", "binary", 72))).toBe(
      "[1, 2, 3, 4, 5, 6, 7, 8, …] 72 bits",
    );
  });

  test("a sparse cell shows its entries and their count, in either encoding", () => {
    expect(display({ "3": 0.5, "10": 1 }, context("sparse", "float32", null, "index-map"))).toBe(
      "{3: 0.5, 10: 1.0} 2 entries",
    );
    expect(display({ indices: [7], values: [2] }, context("sparse", "uint8", null, "indices-values"))).toBe(
      "{7: 2} 1 entry",
    );
    const ten = { indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] };
    expect(display(ten, context("sparse", "float32", null, "indices-values"))).toBe(
      "{0: 1.0, 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.0, 6: 1.0, 7: 1.0, …} 10 entries",
    );
  });

  test("a multivector cell shows its first row and its row count", () => {
    expect(
      display(
        [
          [1, 2],
          [3, 4],
        ],
        context("multi", "float32", 2),
      ),
    ).toBe("[[1.0, 2.0], …] 2 rows of 2 dims");
    expect(display([[0.5]], context("multi", "float32"))).toBe("[[0.5]] 1 row of 1 dim");
    expect(display([], context("multi", "float32"))).toBe("[] 0 rows of 0 dims");
  });

  test("a cell whose length differs from the declared dimension states its own length", () => {
    expect(display([], context("dense", "float32", 768))).toBe("[] 0 dims");
    expect(display([1, 2], context("dense", "float32", 768))).toBe("[1.0, 2.0] 2 dims");
    expect(display([255], context("dense", "binary", 16))).toBe("[255] 8 bits");
    expect(display([[]], context("multi", "float32", 2))).toBe("[[]] 1 row of 0 dims");
    expect(vectorRenderer.renderDetail([1, 2], context("dense", "float32", 768)).text).toBe(
      "dense float32, 2 dims\n[1.0,2.0]",
    );
  });
});

describe("the row detail", () => {
  test("a header line over the whole value on one line, which the sheet wraps", () => {
    expect(vectorRenderer.renderDetail(EMBEDDING, context("dense", "float32", 768))).toEqual({
      text: `dense float32, 768 dims\n${EMBEDDING_COPY}`,
      className: CLASS,
      preserveWhitespace: true,
    });
    expect(
      vectorRenderer.renderDetail({ indices: [3], values: [0.5] }, context("sparse", "float32", null, "indices-values"))
        .text,
    ).toBe('sparse float32, 1 entry\n{"indices":[3],"values":[0.5]}');
  });
});

describe("Copy Cell", () => {
  test("a dense float cell copies every element, an integral one with a fraction", () => {
    expect(copy(EMBEDDING, context("dense", "float32", 768))).toBe(EMBEDDING_COPY);
    expect(JSON.parse(copy(EMBEDDING, context("dense", "float32", 768)))).toEqual(EMBEDDING);
  });

  test("a two-row integral multivector copies with a fraction on every element, so it is not read as a sparse pair", () => {
    expect(
      copy(
        [
          [1, 2],
          [3, 4],
        ],
        context("multi", "float32", 2),
      ),
    ).toBe("[[1.0,2.0],[3.0,4.0]]");
    expect(copy([[1, 2]], context("multi", "uint8", 2))).toBe("[[1.0,2.0]]");
  });

  test("int8, uint8 and binary elements of a dense cell copy as integers", () => {
    expect(copy([-128, 0, 127], context("dense", "int8", 3))).toBe("[-128,0,127]");
    expect(copy([0, 255], context("dense", "uint8", 2))).toBe("[0,255]");
    expect(copy([0, 255], context("dense", "binary", 16))).toBe("[0,255]");
  });

  test("float elements keep their exponent form, -0 keeps its sign and null stays null", () => {
    const edge = [3.4028234663852886e38, 1e21, -0, 0, 1.401298464324817e-45, null];
    const text = copy(edge, context("dense", "float32"));
    expect(text).toBe("[3.4028234663852886e+38,1e+21,-0.0,0.0,1.401298464324817e-45,null]");
    expect(JSON.parse(text)).toEqual(edge);
    expect(Object.is(JSON.parse(text)[2], -0)).toBe(true);
  });

  test("a sparse cell copies in its own encoding, indices as integers and values by element type", () => {
    expect(copy({ "3": 0.5, "10": 1 }, context("sparse", "float32", null, "index-map"))).toBe('{"3":0.5,"10":1.0}');
    expect(copy({ indices: [3, 10], values: [0.5, 1] }, context("sparse", "float32", null, "indices-values"))).toBe(
      '{"indices":[3,10],"values":[0.5,1.0]}',
    );
    expect(copy({ indices: [3], values: [2] }, context("sparse", "uint8", null, "indices-values"))).toBe(
      '{"indices":[3],"values":[2]}',
    );
  });
});

describe("isVectorCell", () => {
  test("accepts a value of the shape its column declares", () => {
    expect(isVectorCell([0.1, null], column("dense", "float16", 2))).toBe(true);
    expect(isVectorCell([[1], [2]], column("multi", "float32", 1))).toBe(true);
    expect(isVectorCell({ "3": 0.5 }, column("sparse", "float32", null, "index-map"))).toBe(true);
    expect(isVectorCell({ indices: [3], values: [0.5] }, column("sparse", "float32", null, "indices-values"))).toBe(
      true,
    );
  });

  test("refuses a value its column does not describe", () => {
    const dense = column("dense", "float32", 2);
    for (const value of ["[1,2]", "***", { a: 1 }, [1, "2"], [Number.POSITIVE_INFINITY], [Number.NaN], 7, null]) {
      expect(isVectorCell(value, dense), JSON.stringify(value) ?? String(value)).toBe(false);
    }
    expect(isVectorCell([1, 2], column("multi", "float32", 2))).toBe(false);
    expect(isVectorCell([[1], [Number.POSITIVE_INFINITY]], column("multi", "float32", 1))).toBe(false);
    expect(isVectorCell({ indices: [1], values: [0.5] }, column("sparse", "float32"))).toBe(false);
    expect(isVectorCell(null, column("sparse", "float32", null, "index-map"))).toBe(false);
    expect(isVectorCell(7, column("sparse", "float32", null, "index-map"))).toBe(false);
    expect(isVectorCell({ indices: [1, 2], values: [0.5] }, column("sparse", "float32", null, "indices-values"))).toBe(
      false,
    );
  });

  test("refuses every value under a kind it does not know, so a newer host's declaration draws the cell as what it is", () => {
    const unknown = { kind: "Dense", dtype: "float32", dimension: 3 } as unknown as VectorColumn;
    for (const value of [[1, 2, 3], "abc", 5, "****"]) {
      expect(isVectorCell(value, unknown), JSON.stringify(value)).toBe(false);
      expect(classifyValue(value, { vector: unknown }), JSON.stringify(value)).not.toBe("vector");
    }
  });

  test("refuses every value under a declaration that is not an object", () => {
    const missing = null as unknown as VectorColumn;
    expect(isVectorCell([1, 2, 3], missing)).toBe(false);
    expect(classifyValue("x", { vector: missing })).toBe("scalar");
  });

  test("refuses a sparse cell whose encoding it does not know", () => {
    const csr = { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "csr" } as unknown as VectorColumn;
    expect(isVectorCell({ indices: [1], values: [0.5] }, csr)).toBe(false);
    expect(isVectorCell({ "1": 0.5 }, csr)).toBe(false);
  });

  test("the renderer refuses a value its column does not describe, rather than drawing a vector", () => {
    expect(() => vectorRenderer.renderCompact("***", context("dense", "float32"))).toThrow(REFUSAL);
    expect(() => vectorRenderer.renderDetail([1], undefined)).toThrow(REFUSAL);
    expect(() => copy([1], undefined)).toThrow(REFUSAL);
  });
});

// ---- The expected cells of both engines -----------------------------------------------------------------------

type Engine = "milvus" | "qdrant";

/** Each engine's sparse cell encoding, as each provider will declare it (spec 3.10). */
const ENCODING: Readonly<Record<Engine, SparseEncoding>> = { milvus: "index-map", qdrant: "indices-values" };

/** What each engine's seed writes, at least (tests/fixtures/vector/README.md). */
const SEEDED: Readonly<
  Record<Engine, { readonly kinds: readonly VectorKind[]; readonly dtypes: readonly VectorDType[] }>
> = {
  milvus: { kinds: ["dense", "sparse"], dtypes: ["binary", "bfloat16", "float16", "float32", "int8"] },
  qdrant: { kinds: ["dense", "multi", "sparse"], dtypes: ["float16", "float32", "uint8"] },
};

const FLOAT_DTYPES: ReadonlySet<VectorDType> = new Set<VectorDType>(["float32", "float64", "float16", "bfloat16"]);

function expectedCells(engine: Engine): readonly ExpectedCell[] {
  const file = join(import.meta.dir, "..", "..", "fixtures", "vector", engine, "expected-cells.json");
  return (JSON.parse(readFileSync(file, "utf8")) as ExpectedCells).cells;
}

function columnOf(cell: ExpectedCell, engine: Engine): VectorColumn {
  return column(cell.kind, cell.dtype, null, cell.kind === "sparse" ? ENCODING[engine] : undefined);
}

const where = (cell: ExpectedCell): string => `${cell.collection} seq ${cell.seq} ${cell.field}`;

const NUMBER = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g;

/** The numbers a copy writes, outside its quoted keys. */
function numbersIn(text: string): readonly string[] {
  return text.replace(/"[^"]*"/g, "").match(NUMBER) ?? [];
}

function expectForm(numbers: readonly string[], form: "float" | "integer", at: string): void {
  for (const token of numbers) {
    const written = form === "float" ? /[.e]/.test(token) : /^-?\d+$/.test(token);
    expect(written, `${at}: ${token} is not written as ${form === "float" ? "a float" : "an integer"}`).toBe(true);
  }
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The size a cell's display ends with, from the cell itself. */
function sizeOf(cell: ExpectedCell): string {
  const value = cell.cell;
  if (cell.kind === "sparse") {
    const pair = value as { readonly indices?: readonly unknown[] };
    return counted(
      pair.indices === undefined ? Object.keys(value as object).length : pair.indices.length,
      "entry",
      "entries",
    );
  }
  const items = value as readonly unknown[];
  if (cell.kind === "multi") {
    const rowSize = items.length === 0 ? 0 : (items[0] as readonly unknown[]).length;
    return `${counted(items.length, "row", "rows")} of ${counted(rowSize, "dim", "dims")}`;
  }
  return cell.dtype === "binary" ? counted(items.length * 8, "bit", "bits") : counted(items.length, "dim", "dims");
}

for (const engine of ["milvus", "qdrant"] as const) {
  describe(`the ${engine} expected cells`, () => {
    const cells = expectedCells(engine);
    const present = cells.filter((cell) => cell.cell !== null);

    test("hold every kind and element type the seed writes", () => {
      expect([...new Set(cells.map((cell) => cell.kind))]).toEqual(expect.arrayContaining([...SEEDED[engine].kinds]));
      expect([...new Set(cells.map((cell) => cell.dtype))]).toEqual(expect.arrayContaining([...SEEDED[engine].dtypes]));
    });

    test("every cell is a cell of its column, and its copy reads back as the same value", () => {
      expect(present.length).toBeGreaterThan(0);
      for (const cell of present) {
        const declared = columnOf(cell, engine);
        expect(isVectorCell(cell.cell, declared), where(cell)).toBe(true);
        expect(JSON.parse(copy(cell.cell, { vector: declared })), where(cell)).toEqual(cell.cell);
      }
    });

    test("every copy writes float elements with a fraction, and integer elements and sparse indices without", () => {
      for (const cell of present) {
        const text = copy(cell.cell, { vector: columnOf(cell, engine) });
        const valueForm = cell.kind === "multi" || FLOAT_DTYPES.has(cell.dtype) ? "float" : "integer";
        if (cell.kind === "sparse" && ENCODING[engine] === "indices-values") {
          const parts = /^\{"indices":\[(.*?)\],"values":\[(.*)\]\}$/.exec(text);
          expect(parts, where(cell)).not.toBeNull();
          expectForm(numbersIn(parts?.[1] ?? ""), "integer", `${where(cell)} indices`);
          expectForm(numbersIn(parts?.[2] ?? ""), valueForm, `${where(cell)} values`);
        } else {
          // An index map's keys are quoted, so only its values are numbers here.
          expectForm(numbersIn(text), valueForm, where(cell));
        }
      }
    });

    test("every grid cell ends with the size the cell holds, and the detail is its header over its copy", () => {
      for (const cell of present) {
        const ctx = { vector: columnOf(cell, engine) };
        const size = sizeOf(cell);
        expect(
          display(cell.cell, ctx).endsWith(`] ${size}`) || display(cell.cell, ctx).endsWith(`} ${size}`),
          where(cell),
        ).toBe(true);
        expect(vectorRenderer.renderDetail(cell.cell, ctx).text, where(cell)).toBe(
          `${cell.kind} ${cell.dtype}, ${size}\n${copy(cell.cell, ctx)}`,
        );
      }
    });
  });
}

test("the Qdrant cells hold a two-row integral multivector, and its copy writes every element with a fraction", () => {
  const twoRow = expectedCells("qdrant").find(
    (cell) =>
      cell.kind === "multi" &&
      Array.isArray(cell.cell) &&
      cell.cell.length === 2 &&
      (cell.cell as readonly (readonly number[])[]).every((row) => row.every(Number.isInteger)),
  );
  expect(twoRow).toBeDefined();
  if (twoRow === undefined) return;
  const text = copy(twoRow.cell, context("multi", twoRow.dtype));
  expect(numbersIn(text).every((token) => token.includes("."))).toBe(true);
  expect(JSON.parse(text)).toEqual(twoRow.cell);
});

describe("classification over both engines' expected cells", () => {
  test("every cell of a declared column is a vector, and a cell the engine left empty is null", () => {
    for (const engine of ["milvus", "qdrant"] as const) {
      for (const cell of expectedCells(engine)) {
        const expected = cell.cell === null ? "null" : "vector";
        expect(classifyValue(cell.cell, { vector: columnOf(cell, engine) }), where(cell)).toBe(expected);
      }
    }
  });

  test("without the declaration every one of those cells is the JSON it was", () => {
    for (const engine of ["milvus", "qdrant"] as const) {
      for (const cell of expectedCells(engine).filter((entry) => entry.cell !== null)) {
        expect(classifyValue(cell.cell), where(cell)).toBe("json");
      }
    }
  });
});
