/**
 * Qdrant's words in the vector family's vocabulary (vector-family spec 3.3, 6.5): distances, datatypes, a vector's
 * result-column declaration, and the score table, total over every accepted query form.
 */
import { describe, expect, test } from "bun:test";
import {
  qdrantElementType,
  qdrantMetric,
  qdrantModifier,
  qdrantScoreSemantics,
  qdrantVectorColumn,
} from "@/lib/db/providers/vector/qdrant/qdrant-vocabulary";
import type { QdrantQueryForm } from "@/lib/db/providers/vector/qdrant/request";
import { scoreColumnType } from "@/lib/db/vector/score";
import { seededFacts } from "../../../helpers/qdrant-facts";

describe("qdrantMetric", () => {
  test("maps each distance, Euclid to the distance itself and never to its square", () => {
    expect(qdrantMetric("Cosine")).toEqual({ metric: "cosine", nativeMetric: "Cosine" });
    expect(qdrantMetric("Euclid")).toEqual({ metric: "euclidean", nativeMetric: "Euclid" });
    expect(qdrantMetric("Euclid").metric).not.toBe("euclidean_squared");
    expect(qdrantMetric("Dot")).toEqual({ metric: "dot", nativeMetric: "Dot" });
    expect(qdrantMetric("Manhattan")).toEqual({ metric: "manhattan", nativeMetric: "Manhattan" });
    expect(qdrantMetric("Hamming")).toEqual({ metric: "other", nativeMetric: "Hamming" });
  });
});

describe("qdrantElementType", () => {
  test("reads float32 by default, float16 and uint8 as themselves, and turbo4 as a float32 reconstruction", () => {
    expect(qdrantElementType(undefined)).toEqual({ dtype: "float32", reconstructed: false });
    expect(qdrantElementType(null)).toEqual({ dtype: "float32", reconstructed: false });
    expect(qdrantElementType("float16")).toEqual({ dtype: "float16", reconstructed: false });
    expect(qdrantElementType("uint8")).toEqual({ dtype: "uint8", reconstructed: false });
    expect(qdrantElementType("turbo4")).toEqual({ dtype: "float32", reconstructed: true });
  });

  test("refuses a datatype it does not know rather than guessing its range", () => {
    expect(() => qdrantElementType("int4")).toThrow(
      'Qdrant declares the vector datatype "int4", which this Studio does not read',
    );
  });
});

describe("qdrantModifier", () => {
  test("keeps idf and writes none or an absent modifier as none", () => {
    expect(qdrantModifier("idf")).toBe("idf");
    expect(qdrantModifier("none")).toBeNull();
    expect(qdrantModifier(undefined)).toBeNull();
    expect(qdrantModifier(null)).toBeNull();
  });
});

describe("qdrantVectorColumn", () => {
  test("declares the seeded docs vectors and small_dtypes vectors as spec 6.5 lists them", () => {
    const docs = Object.fromEntries(
      seededFacts("docs").vectors.map((field) => [field.name, qdrantVectorColumn(field)]),
    );
    expect(docs).toEqual({
      text: { kind: "dense", dtype: "float32", dimension: 384 },
      image: { kind: "dense", dtype: "float32", dimension: 64 },
      colbert: { kind: "multi", dtype: "float32", dimension: 16 },
      keywords: { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "indices-values" },
    });
    const small = Object.fromEntries(
      seededFacts("small_dtypes").vectors.map((field) => [field.name, qdrantVectorColumn(field).dtype]),
    );
    expect(small).toEqual({ f16: "float16", u8: "uint8", t4: "float32", manhattan: "float32", sp_u8: "uint8" });
  });
});

describe("qdrantScoreSemantics", () => {
  const vectors = [...seededFacts("docs").vectors, ...seededFacts("small_dtypes").vectors];
  const label = (form: QdrantQueryForm, using = "text") =>
    scoreColumnType(qdrantScoreSemantics({ form, using }, vectors));

  test("a vector, a point id, nearest and mmr take the metric of the vector they search", () => {
    expect(label("vector", "text")).toBe("Float, Cosine, higher is closer");
    expect(label("id", "image")).toBe("Float, Euclid, lower is closer");
    expect(label("nearest", "colbert")).toBe("Float, Dot, higher is closer");
    expect(label("vector", "manhattan")).toBe("Float, Manhattan, lower is closer");
    expect(label("vector", "keywords")).toBe("Float, Dot, higher is closer");
  });

  test("recommend, discover, context, formula and relevance feedback compute a score that ranks", () => {
    expect(label("formula")).toBe("Float, formula score, rows are in rank order");
    expect(label("recommend")).toBe("Float, recommend score, rows are in rank order");
    expect(label("discover")).toBe("Float, discover score, rows are in rank order");
    expect(label("context")).toBe("Float, context score, rows are in rank order");
    expect(label("relevance_feedback")).toBe("Float, relevance_feedback score, rows are in rank order");
  });

  test("a fusion ranks higher first, and no query, order_by and sample are not a similarity", () => {
    expect(label("fusion.rrf")).toBe("Float, RRF fusion, higher ranks first");
    expect(label("rrf")).toBe("Float, RRF fusion, higher ranks first");
    expect(label("fusion.dbsf")).toBe("Float, DBSF fusion, higher ranks first");
    for (const form of ["none", "order_by", "sample"] as const) {
      expect(label(form)).toBe("Float, not a similarity (constant 1.0)");
    }
  });

  test("no label states a bound on a cosine score", () => {
    expect(label("vector", "f16")).not.toMatch(/1\.0|at most|bound/);
  });

  test("a vector search names a vector the collection has; one that does not is a programming error", () => {
    expect(() => qdrantScoreSemantics({ form: "vector", using: "missing" }, vectors)).toThrow(
      'A vector search names the vector "missing", which the collection lacks',
    );
  });
});
