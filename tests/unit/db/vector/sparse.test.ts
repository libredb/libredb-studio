/**
 * Sparse vectors (vector-family spec 3.3): one in-memory form read from either written form, the index bound as
 * engine data, and both engines' sparse cells normalised to the same form.
 */
import { describe, expect, test } from "bun:test";
import { taggedNumber, type TaggedObject } from "@/lib/db/console/tagged-json";
import type { VectorRefusal, VectorTarget } from "@/lib/db/vector/dense";
import {
  checkSparse,
  type SparseVector,
  sparseFromCell,
  sparseFromIndexMap,
  sparseFromIndicesValues,
} from "@/lib/db/vector/sparse";
import { expectedCells, SPARSE_INDEX_BOUND, tagged, targetOf } from "../../../helpers/vector-fixtures";

const sp: VectorTarget = { name: "sp", kind: "sparse", dtype: "float32", dimension: null };
const map = (value: Record<string, unknown>) => tagged(value) as TaggedObject;

describe("sparseFromIndexMap", () => {
  test("reads canonical decimal keys into ascending indices", () => {
    expect(sparseFromIndexMap(sp, map({ "900": 0.25, "17": 0.5, "0": 1 }), 1000)).toEqual({
      indices: [0, 17, 900],
      values: [1, 0.5, 0.25],
    });
  });

  test("refuses a key that is not plain decimal digits, and a value that is not a number", () => {
    expect((sparseFromIndexMap(sp, map({ "017": 1 }), 1000) as VectorRefusal).sentence).toBe(
      'Vector field "sp" (float32, sparse): the key "017" is not an index written as plain decimal digits.',
    );
    expect((sparseFromIndexMap(sp, map({ "1": "x" }), 1000) as VectorRefusal).sentence).toBe(
      'Vector field "sp" (float32, sparse): the value at index 1 is not a number.',
    );
  });

  test("applies the bound the provider gives", () => {
    expect((sparseFromIndexMap(sp, map({ "1000": 1 }), 1000) as VectorRefusal).index).toBe(0);
  });
});

describe("sparseFromIndicesValues", () => {
  test("reads two parallel lists into ascending indices", () => {
    expect(sparseFromIndicesValues(sp, [taggedNumber("7"), 3], [taggedNumber("0.5"), 0.25], 10)).toEqual({
      indices: [3, 7],
      values: [0.25, 0.5],
    });
  });

  test("refuses lists of different lengths, an index that is not an integer and a value that is not a number", () => {
    expect((sparseFromIndicesValues(sp, [taggedNumber("1")], [], 10) as VectorRefusal).sentence).toBe(
      'Vector field "sp" (float32, sparse): 1 indices and 0 values given; the two lists pair up.',
    );
    expect((sparseFromIndicesValues(sp, [taggedNumber("1.5")], [taggedNumber("1")], 10) as VectorRefusal).index).toBe(
      0,
    );
    expect((sparseFromIndicesValues(sp, [taggedNumber("1")], [null], 10) as VectorRefusal).sentence).toBe(
      'Vector field "sp" (float32, sparse): value 0 is not a number.',
    );
  });
});

describe("checkSparse", () => {
  test("refuses unequal lengths, an index out of range or repeated, and a value that is not a finite float32", () => {
    const check = (vector: SparseVector) => checkSparse(sp, vector, 10)?.sentence;
    expect(check({ indices: [1, 2], values: [1] })).toBe(
      'Vector field "sp" (float32, sparse): 2 indices and 1 values; the two lists pair up.',
    );
    expect(check({ indices: [-1], values: [1] })).toBe(
      'Vector field "sp" (float32, sparse): index -1 is not an integer from 0 to below 10.',
    );
    expect(check({ indices: [10], values: [1] })).toBe(
      'Vector field "sp" (float32, sparse): index 10 is not an integer from 0 to below 10.',
    );
    expect(check({ indices: [1.5], values: [1] })).toBe(
      'Vector field "sp" (float32, sparse): index 1.5 is not an integer from 0 to below 10.',
    );
    expect(check({ indices: [2, 2], values: [1, 1] })).toBe(
      'Vector field "sp" (float32, sparse): index 2 is given twice.',
    );
    expect(check({ indices: [2], values: [1e39] })).toBe(
      'Vector field "sp" (float32, sparse): the value at index 2 is 1e+39, not a finite float32.',
    );
    expect(check({ indices: [0, 9], values: [0.5, 3.4e38] })).toBeUndefined();
  });
});

describe("sparseFromCell", () => {
  test("reads a cell of the declared encoding, and answers null for any other shape", () => {
    expect(sparseFromCell({ "5": 1, "2": 0.5 }, "index-map")).toEqual({ indices: [2, 5], values: [0.5, 1] });
    expect(sparseFromCell({ indices: [5, 2], values: [1, 0.5] }, "indices-values")).toEqual({
      indices: [2, 5],
      values: [0.5, 1],
    });
    for (const [cell, encoding] of [
      [null, "index-map"],
      [[1], "index-map"],
      ["x", "indices-values"],
      [{ a: 1 }, "index-map"],
      [{ "1": "x" }, "index-map"],
      [{ indices: [1] }, "indices-values"],
      [{ indices: [1], values: [1, 2] }, "indices-values"],
      [{ indices: [1.5], values: [1] }, "indices-values"],
      [{ indices: [1], values: [null] }, "indices-values"],
    ] as const) {
      expect(sparseFromCell(cell, encoding), JSON.stringify(cell)).toBeNull();
    }
  });
});

describe("both engines' sparse cells", () => {
  const milvus = expectedCells("milvus").cells.filter((cell) => cell.kind === "sparse");
  const qdrant = expectedCells("qdrant").cells.filter((cell) => cell.kind === "sparse");

  test("both fixtures hold sparse cells", () => {
    expect(milvus.length).toBeGreaterThan(0);
    expect(qdrant.length).toBeGreaterThan(0);
  });

  test("normalise to the same {indices, values}, whichever encoding writes them", () => {
    for (const cell of milvus) {
      const read = sparseFromCell(cell.cell, "index-map") as SparseVector;
      expect(read, `${cell.collection} ${cell.field}`).not.toBeNull();
      expect(sparseFromCell({ indices: read.indices, values: read.values }, "indices-values")).toEqual(read);
      const field = targetOf("milvus", cell.collection, cell.field);
      expect(sparseFromIndexMap(field, tagged(cell.cell) as TaggedObject, SPARSE_INDEX_BOUND.milvus)).toEqual(read);
    }
    for (const cell of qdrant) {
      const pair = cell.cell as { indices: number[]; values: number[] };
      const read = sparseFromCell(pair, "indices-values") as SparseVector;
      expect(read, `${cell.collection} ${cell.field}`).not.toBeNull();
      const asMap = Object.fromEntries(read.indices.map((index, position) => [String(index), read.values[position]]));
      expect(sparseFromCell(asMap, "index-map")).toEqual(read);
      const field = targetOf("qdrant", cell.collection, cell.field);
      expect(
        sparseFromIndicesValues(field, pair.indices.map(tagged), pair.values.map(tagged), SPARSE_INDEX_BOUND.qdrant),
      ).toEqual(read);
    }
  });

  test("Milvus refuses index 4294967295 and Qdrant accepts it, each engine's edge cell inside its own bound", () => {
    const edge = { indices: [4_294_967_295], values: [1] };
    expect(checkSparse(sp, edge, SPARSE_INDEX_BOUND.milvus)?.sentence).toBe(
      'Vector field "sp" (float32, sparse): index 4294967295 is not an integer from 0 to below 4294967295.',
    );
    expect(checkSparse(sp, edge, SPARSE_INDEX_BOUND.qdrant)).toBeNull();
    const milvusEdge = milvus.find((cell) => Object.keys(cell.cell as object).includes("4294967294"));
    const qdrantEdge = qdrant.find((cell) => (cell.cell as { indices: number[] }).indices.includes(4_294_967_295));
    expect(milvusEdge).toBeDefined();
    expect(qdrantEdge).toBeDefined();
    expect(
      checkSparse(sp, sparseFromCell(milvusEdge?.cell, "index-map") as SparseVector, SPARSE_INDEX_BOUND.milvus),
    ).toBeNull();
    expect(
      checkSparse(sp, sparseFromCell(qdrantEdge?.cell, "indices-values") as SparseVector, SPARSE_INDEX_BOUND.qdrant),
    ).toBeNull();
  });
});
