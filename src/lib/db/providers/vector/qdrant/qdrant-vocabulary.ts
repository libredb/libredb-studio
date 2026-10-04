import type { ScoreSemantics, VectorColumn, VectorDType, VectorFieldInfo, VectorMetric } from "@/lib/db/vector/types";
import type { QdrantQueryForm, QdrantSearch } from "./request";

/**
 * Qdrant's own words mapped onto the vector family's: a distance to a metric, a datatype to the element type
 * Studio reads, a vector to its result column's declaration, and a search's final stage to what its score means.
 * Each native spelling is kept beside the shared word, so nothing downstream interprets Qdrant's vocabulary.
 */

/** A distance as the family names it, with Qdrant's spelling kept. */
export interface QdrantMetric {
  readonly metric: VectorMetric;
  readonly nativeMetric: string;
}

const DISTANCES: Readonly<Record<string, VectorMetric>> = {
  Cosine: "cosine",
  Euclid: "euclidean",
  Dot: "dot",
  Manhattan: "manhattan",
};

/**
 * A collection's `distance`. Qdrant's Euclid is the distance itself, not its square: (3, 4) against the origin
 * scores 5. A distance this table does not know maps to `other`, its spelling kept.
 */
export function qdrantMetric(distance: string): QdrantMetric {
  return { metric: Object.hasOwn(DISTANCES, distance) ? DISTANCES[distance] : "other", nativeMetric: distance };
}

/** What a stored element type reads back as, and whether the server answers a reconstruction of it. */
export interface QdrantElementType {
  readonly dtype: VectorDType;
  /** True for turbo4, a 4-bit storage the server answers as floats that only approximate what was written. */
  readonly reconstructed: boolean;
}

const DATATYPES: Readonly<Record<string, QdrantElementType>> = {
  float32: { dtype: "float32", reconstructed: false },
  float16: { dtype: "float16", reconstructed: false },
  uint8: { dtype: "uint8", reconstructed: false },
  turbo4: { dtype: "float32", reconstructed: true },
};

/**
 * A vector's `datatype`, float32 when the collection declares none. A datatype this table does not know is
 * refused: Studio cannot check a query element against a range it does not know.
 */
export function qdrantElementType(datatype: string | null | undefined): QdrantElementType {
  const name = datatype ?? "float32";
  if (!Object.hasOwn(DATATYPES, name)) {
    throw new Error(`Qdrant declares the vector datatype ${JSON.stringify(name)}, which this Studio does not read`);
  }
  return DATATYPES[name];
}

/** A sparse vector's modifier: `idf` is kept, and `none` or an absent modifier is written as no modifier. */
export function qdrantModifier(modifier: string | null | undefined): string | null {
  return modifier === undefined || modifier === null || modifier === "none" ? null : modifier;
}

/** A vector field's result-column declaration: a sparse vector is written as Qdrant's own `{indices, values}`. */
export function qdrantVectorColumn(field: VectorFieldInfo): VectorColumn {
  return field.kind === "sparse"
    ? { kind: "sparse", dtype: field.dtype, dimension: null, sparseEncoding: "indices-values" }
    : { kind: field.kind, dtype: field.dtype, dimension: field.dimension };
}

/** The score name a sparse vector carries: Qdrant scores every sparse vector by its dot product. */
const SPARSE_SCORE = "Dot";

const COMPUTED: Readonly<Partial<Record<QdrantQueryForm, string>>> = {
  recommend: "recommend",
  discover: "discover",
  context: "context",
  formula: "formula",
  relevance_feedback: "relevance_feedback",
};

/**
 * What a search's score means, from the executed form of its final stage: a vector, a point id, `nearest` and
 * `mmr` take the metric of the vector they search; recommend, discover, context, formula and relevance feedback
 * compute a score that ranks; a fusion ranks higher first; and no query, `order_by` and `sample` give the constant
 * 1.0, which is not a similarity.
 */
export function qdrantScoreSemantics(search: QdrantSearch, vectors: readonly VectorFieldInfo[]): ScoreSemantics {
  const { form } = search;
  if (form === "none" || form === "order_by" || form === "sample") {
    return { kind: "unranked", better: null, metric: null, nativeName: null };
  }
  if (form === "fusion.rrf" || form === "rrf")
    return { kind: "fused", better: "higher", metric: null, nativeName: "RRF" };
  if (form === "fusion.dbsf") return { kind: "fused", better: "higher", metric: null, nativeName: "DBSF" };
  const computed = COMPUTED[form];
  if (computed !== undefined) return { kind: "computed", better: null, metric: null, nativeName: computed };
  const vector = vectors.find((field) => field.name === search.using);
  if (vector === undefined) {
    throw new Error(`A ${form} search names the vector ${JSON.stringify(search.using)}, which the collection lacks`);
  }
  if (vector.kind === "sparse")
    return { kind: "similarity", better: "higher", metric: "dot", nativeName: SPARSE_SCORE };
  const better = vector.metric === "euclidean" || vector.metric === "manhattan" ? "lower" : "higher";
  return {
    kind: better === "lower" ? "distance" : "similarity",
    better,
    metric: vector.metric,
    nativeName: vector.nativeMetric,
  };
}
