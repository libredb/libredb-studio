/**
 * Probe vectors (vector-family spec 3.3): every expected field of both engines' fixtures gets a probe its own
 * check accepts, or null where its dimension is unknown.
 */
import { describe, expect, test } from "bun:test";
import { checkDenseElements, checkMultiVector } from "@/lib/db/vector/dense";
import { probeVector } from "@/lib/db/vector/probe";
import { checkSparse } from "@/lib/db/vector/sparse";
import { allFields, ENGINES, MULTIVECTOR_ELEMENTS, SPARSE_INDEX_BOUND } from "../../../helpers/vector-fixtures";

describe("probeVector", () => {
  test("a float probe is a unit vector of float32 elements", () => {
    expect(probeVector({ name: "v", kind: "dense", dtype: "float32", dimension: 4 })).toEqual({
      kind: "dense",
      values: [0.5, 0.5, 0.5, 0.5],
    });
    const probe = probeVector({ name: "v", kind: "dense", dtype: "float16", dimension: 3 });
    expect(probe).toEqual({ kind: "dense", values: new Array(3).fill(Math.fround(1 / Math.sqrt(3))) });
  });

  test("int8 and uint8 probes are ones, a binary probe 0x55 in each byte, a sparse probe index 0 with value 1", () => {
    expect(probeVector({ name: "v", kind: "dense", dtype: "int8", dimension: 2 })).toEqual({
      kind: "dense",
      values: [1, 1],
    });
    expect(probeVector({ name: "v", kind: "dense", dtype: "uint8", dimension: 2 })).toEqual({
      kind: "dense",
      values: [1, 1],
    });
    expect(probeVector({ name: "v", kind: "dense", dtype: "binary", dimension: 16 })).toEqual({
      kind: "dense",
      values: [0x55, 0x55],
    });
    expect(probeVector({ name: "v", kind: "sparse", dtype: "float32", dimension: null })).toEqual({
      kind: "sparse",
      vector: { indices: [0], values: [1] },
    });
  });

  test("a multivector probe is one row of the dense probe, and no probe exists without a dimension", () => {
    expect(probeVector({ name: "m", kind: "multi", dtype: "float32", dimension: 4 })).toEqual({
      kind: "multi",
      rows: [[0.5, 0.5, 0.5, 0.5]],
    });
    expect(probeVector({ name: "v", kind: "dense", dtype: "float32", dimension: null })).toBeNull();
    expect(probeVector({ name: "m", kind: "multi", dtype: "float32", dimension: null })).toBeNull();
  });
});

for (const engine of ENGINES) {
  describe(`a probe for every field of ${engine}'s fixture`, () => {
    test("passes that field's own check", () => {
      for (const { collection, field } of allFields(engine)) {
        const probe = probeVector(field);
        const where = `${collection}.${field.name}`;
        if (probe === null) {
          expect(field.dimension, where).toBeNull();
        } else if (probe.kind === "sparse") {
          expect(checkSparse(field, probe.vector, SPARSE_INDEX_BOUND[engine]), where).toBeNull();
        } else if (probe.kind === "multi") {
          expect(checkMultiVector(field, probe.rows, MULTIVECTOR_ELEMENTS[engine]), where).toBeNull();
        } else {
          expect(checkDenseElements(field, probe.values), where).toBeNull();
        }
      }
    });
  });
}
