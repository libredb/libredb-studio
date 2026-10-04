/**
 * A Qdrant vector column's type text, written and read back, and its column name. The texts are the ones the tree
 * shows for the seeded collections; for every vector the target read from the text carries the kind, the element
 * type and the size the shared vector checks read, so the tree's generators and the server's checks agree. A text
 * that is not a vector's answers null.
 */
import { describe, expect, test } from "bun:test";
import {
  QDRANT_ELEMENT_DTYPE,
  QDRANT_MAX_VECTOR_SIZE,
  type QdrantVectorShape,
  vectorColumnName,
  vectorNameOfColumn,
  vectorShapeOfType,
  vectorTargetOfType,
  vectorTypeText,
} from "@/lib/db/providers/vector/qdrant/type-spelling";
import { VECTOR_DTYPES } from "@/lib/db/vector/types";

const SHAPES: readonly (readonly [string, QdrantVectorShape])[] = [
  [
    "Dense(384, float32, Cosine; stored normalised)",
    { kind: "dense", size: 384, datatype: "float32", distance: "Cosine" },
  ],
  ["Dense(64, float32, Euclid)", { kind: "dense", size: 64, datatype: "float32", distance: "Euclid" }],
  ["Dense(4, float32, Dot)", { kind: "dense", size: 4, datatype: "float32", distance: "Dot" }],
  ["Dense(4, float32, Manhattan)", { kind: "dense", size: 4, datatype: "float32", distance: "Manhattan" }],
  ["Dense(8, float16, Cosine)", { kind: "dense", size: 8, datatype: "float16", distance: "Cosine" }],
  ["Dense(8, uint8, Euclid)", { kind: "dense", size: 8, datatype: "uint8", distance: "Euclid" }],
  ["Dense(64, turbo4, Cosine)", { kind: "dense", size: 64, datatype: "turbo4", distance: "Cosine" }],
  [
    "Multi(16, float32, Dot, max_sim)",
    { kind: "multi", size: 16, datatype: "float32", distance: "Dot", comparator: "max_sim" },
  ],
  [
    "Multi(16, float32, Cosine, max_sim; stored normalised)",
    { kind: "multi", size: 16, datatype: "float32", distance: "Cosine", comparator: "max_sim" },
  ],
  ["Sparse(idf)", { kind: "sparse", modifier: "idf", datatype: "float32" }],
  ["Sparse(none)", { kind: "sparse", modifier: "none", datatype: "float32" }],
  ["Sparse(none, uint8)", { kind: "sparse", modifier: "none", datatype: "uint8" }],
];

describe("vectorTypeText and vectorShapeOfType", () => {
  test.each(SHAPES)("%s is written from its shape and read back to it", (text, shape) => {
    expect(vectorTypeText(shape)).toBe(text);
    expect(vectorShapeOfType(text)).toEqual(shape);
  });

  test("only a float32 Cosine vector says it is stored normalised", () => {
    const normalised = SHAPES.filter(([text]) => text.includes("stored normalised")).map(([, shape]) => shape);
    expect(normalised).toHaveLength(2);
    for (const shape of normalised) expect(shape).toMatchObject({ datatype: "float32", distance: "Cosine" });
  });

  test.each([
    "keyword",
    "uint64 or UUID",
    "string",
    "mixed (number, string)",
    "Dense(0, float32, Dot)",
    "Dense(65537, float32, Dot)",
    "Dense(99999999999999999999, float32, Dot)",
    "Multi(65537, float32, Dot, max_sim)",
    "Dense(4, float64, Dot)",
    "Dense(4, float32, Dot",
    "dense(4, float32, Dot)",
    "Dense(4,float32,Dot)",
    "Multi(16, float32, Dot)",
    "Multi(16, int8, Dot, max_sim)",
    "Sparse()",
    "Sparse(idf, float64)",
    "constructor",
    "",
  ])("%j is not a vector", (text) => {
    expect(vectorShapeOfType(text)).toBeNull();
    expect(vectorTargetOfType("v", text)).toBeNull();
  });
});

describe("the size bound", () => {
  test("65,536, Qdrant's largest dense size, is a vector", () => {
    expect(QDRANT_MAX_VECTOR_SIZE).toBe(65_536);
    expect(vectorShapeOfType("Dense(65536, float32, Dot)")).toMatchObject({ size: 65_536 });
    expect(vectorShapeOfType("Multi(65536, float32, Dot, max_sim)")).toMatchObject({ size: 65_536 });
  });
});

describe("vectorTargetOfType", () => {
  test("a dense or multivector text gives its size as the dimension, a sparse one none", () => {
    expect(vectorTargetOfType("text", "Dense(384, float32, Cosine; stored normalised)")).toEqual({
      name: "text",
      kind: "dense",
      dtype: "float32",
      dimension: 384,
    });
    expect(vectorTargetOfType("colbert", "Multi(16, float32, Dot, max_sim)")).toEqual({
      name: "colbert",
      kind: "multi",
      dtype: "float32",
      dimension: 16,
    });
    expect(vectorTargetOfType("keywords", "Sparse(idf)")).toEqual({
      name: "keywords",
      kind: "sparse",
      dtype: "float32",
      dimension: null,
    });
    expect(vectorTargetOfType("sp_u8", "Sparse(none, uint8)")).toMatchObject({ kind: "sparse", dtype: "uint8" });
  });

  test("turbo4 is read and searched as float32, and the other datatypes as themselves", () => {
    expect(vectorTargetOfType("t4", "Dense(64, turbo4, Cosine)")).toMatchObject({ dtype: "float32", dimension: 64 });
    expect(vectorTargetOfType("f16", "Dense(8, float16, Cosine)")).toMatchObject({ dtype: "float16" });
    expect(vectorTargetOfType("u8", "Dense(8, uint8, Euclid)")).toMatchObject({ dtype: "uint8" });
  });

  test("every datatype maps to an element type the shared vector layer knows", () => {
    for (const dtype of Object.values(QDRANT_ELEMENT_DTYPE)) expect(VECTOR_DTYPES).toContain(dtype);
  });
});

describe("vector column names", () => {
  test("the unnamed vector is `vector`, a named one `vector.<name>`, and each reads back", () => {
    expect(vectorColumnName("")).toBe("vector");
    expect(vectorColumnName("text")).toBe("vector.text");
    expect(vectorNameOfColumn("vector")).toBe("");
    expect(vectorNameOfColumn("vector.text")).toBe("text");
    expect(vectorNameOfColumn("vector.a.b")).toBe("a.b");
  });

  test.each(["id", "payload.vector.x", "vectors", "vector.", "category", ""])(
    "%j is not a vector's column",
    (column) => {
      expect(vectorNameOfColumn(column)).toBeNull();
    },
  );
});
