/**
 * The vector family's shared types (vector-family spec 3.3), held against both engines' expected fields: the closed
 * element types, the Euclidean metrics kept apart, and the fixture's field shape equal to VectorFieldInfo.
 */
import { describe, expect, test } from "bun:test";
import { countLabel } from "@/lib/db/vector/count";
import { isFiniteFloat32 } from "@/lib/db/vector/float32";
import {
  type CountKind,
  type ScoreKind,
  type ScoreSemantics,
  type SparseEncoding,
  VECTOR_DTYPES,
  type VectorDType,
  type VectorFieldInfo,
  type VectorIndexKind,
  type VectorKind,
  type VectorMetric,
} from "@/lib/db/vector/types";
import type { ExpectedVectorField } from "../../../live/vector-evidence-derive";
import { allFields, ENGINES } from "../../../helpers/vector-fixtures";

// A Record keyed by VectorDType has to name every member, so a renderer or a range table cannot miss one.
// @ts-expect-error binary is missing, which is exactly what this line proves the type refuses
const missing: Record<VectorDType, string> = {
  float32: "",
  float64: "",
  float16: "",
  bfloat16: "",
  int8: "",
  uint8: "",
};
void missing;

// The fixtures' field shape is VectorFieldInfo's, both ways, so the expected files and the type cannot drift.
const asInfo = (field: ExpectedVectorField): VectorFieldInfo => field;
const asExpected = (field: VectorFieldInfo): ExpectedVectorField => field;

const KINDS: readonly VectorKind[] = ["dense", "sparse", "multi"];
const METRICS: readonly VectorMetric[] = [
  "cosine",
  "euclidean",
  "euclidean_squared",
  "dot",
  "manhattan",
  "hamming",
  "jaccard",
  "other",
];
const INDEX_KINDS: readonly VectorIndexKind[] = ["hnsw", "flat", "ivf", "graph_other", "opaque"];
const ENCODINGS: readonly SparseEncoding[] = ["index-map", "indices-values"];
const SCORE_KINDS: readonly ScoreKind[] = ["similarity", "distance", "fused", "computed", "unranked"];

describe("VECTOR_DTYPES", () => {
  test("holds every member once, in the declared order, and is frozen", () => {
    expect(VECTOR_DTYPES).toEqual(["float32", "float64", "float16", "bfloat16", "int8", "uint8", "binary"]);
    expect(Object.isFrozen(VECTOR_DTYPES)).toBe(true);
  });
});

for (const engine of ENGINES) {
  describe(`${engine}'s expected fields`, () => {
    const fields = allFields(engine);

    test("are VectorFieldInfo values of the family's closed sets", () => {
      expect(fields.length).toBeGreaterThan(0);
      for (const { collection, field } of fields) {
        const info = asInfo(field);
        expect(asExpected(info)).toBe(field);
        expect(KINDS, `${collection}.${field.name}`).toContain(info.kind);
        expect(VECTOR_DTYPES, `${collection}.${field.name}`).toContain(info.dtype);
        if (info.metric !== null) expect(METRICS).toContain(info.metric);
        if (info.indexKind !== null) expect(INDEX_KINDS).toContain(info.indexKind);
        expect(info.kind === "sparse" ? info.dimension : typeof info.dimension, `${collection}.${field.name}`).toBe(
          info.kind === "sparse" ? null : "number",
        );
      }
    });
  });
}

describe("the Euclidean metrics stay apart", () => {
  test("Milvus L2 is the squared distance and Qdrant Euclid is not", () => {
    const l2 = allFields("milvus").filter(({ field }) => field.nativeMetric === "L2");
    const euclid = allFields("qdrant").filter(({ field }) => field.nativeMetric === "Euclid");
    expect(l2.length).toBeGreaterThan(0);
    expect(euclid.length).toBeGreaterThan(0);
    for (const { field } of l2) expect(field.metric).toBe("euclidean_squared");
    for (const { field } of euclid) expect(field.metric).toBe("euclidean");
  });

  test("a metric with no family meaning keeps its native name beside other", () => {
    for (const engine of ENGINES) {
      for (const { field } of allFields(engine).filter(({ field }) => field.metric === "other")) {
        expect(field.nativeMetric).not.toBeNull();
      }
    }
  });
});

describe("the remaining unions", () => {
  test("are the members the spec lists", () => {
    const semantics: ScoreSemantics = { kind: "unranked", better: null, metric: null, nativeName: null };
    const counts: readonly CountKind[] = ["exact", "estimate"];
    expect({ ENCODINGS, SCORE_KINDS, counts, semantics }).toEqual({
      ENCODINGS: ["index-map", "indices-values"],
      SCORE_KINDS: ["similarity", "distance", "fused", "computed", "unranked"],
      counts: ["exact", "estimate"],
      semantics: { kind: "unranked", better: null, metric: null, nativeName: null },
    });
  });
});

describe("countLabel", () => {
  test("labels a count exact only when the engine computed it exactly", () => {
    expect(countLabel("exact")).toBe("Int64, exact count");
    expect(countLabel("estimate")).toBe("Int64, estimate");
  });
});

describe("isFiniteFloat32", () => {
  test.each([
    [0, true],
    [3.4028234663852886e38, true],
    [-3.4028234663852886e38, true],
    [1e-45, true],
    [1e39, false],
    [3.4028235677973366e38, false],
    [-1e39, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])("%p is a finite float32: %p", (value, finite) => {
    expect(isFiniteFloat32(value)).toBe(finite);
  });
});
