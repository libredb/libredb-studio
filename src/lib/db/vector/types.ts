/**
 * The vector family's shared types (vector-family spec 3.3): what a vector field is, what a score means and what a
 * count claims, in words no engine owns. Each provider maps its own spellings onto these and keeps the spelling
 * beside them (`nativeMetric`, `nativeType`, `nativeName`), so nothing here interprets an engine's vocabulary.
 */

export type VectorKind = "dense" | "sparse" | "multi";

/** The value domain of the elements Studio reads. Closed, so every table keyed by it is exhaustive. */
export type VectorDType = "float32" | "float64" | "float16" | "bfloat16" | "int8" | "uint8" | "binary";

/** Every member of `VectorDType` once, in this order, for exhaustive tables. */
export const VECTOR_DTYPES: readonly VectorDType[] = Object.freeze([
  "float32",
  "float64",
  "float16",
  "bfloat16",
  "int8",
  "uint8",
  "binary",
]);

/** How a sparse cell is written: a map from index to value, or two parallel lists. */
export type SparseEncoding = "index-map" | "indices-values";

/**
 * The family's metrics. `euclidean` is the distance and `euclidean_squared` its square, kept apart because one
 * engine reports the one and another the other; a metric with no family meaning is `other`, beside its native name.
 */
export type VectorMetric =
  | "cosine"
  | "euclidean"
  | "euclidean_squared"
  | "dot"
  | "manhattan"
  | "hamming"
  | "jaccard"
  | "other";

export type VectorIndexKind = "hnsw" | "flat" | "ivf" | "graph_other" | "opaque";

/** One vector field as the schema describes it. */
export interface VectorFieldInfo {
  /** The field or vector name; "" for an unnamed vector. */
  readonly name: string;
  readonly kind: VectorKind;
  /** The value domain of the elements Studio reads, not the storage codec. */
  readonly dtype: VectorDType;
  /** Null for a sparse field, and where the engine declares none. */
  readonly dimension: number | null;
  /** Null where nothing binds one yet, such as a field with no index. */
  readonly metric: VectorMetric | null;
  /** The engine's own metric spelling, never interpreted here. */
  readonly nativeMetric: string | null;
  readonly indexKind: VectorIndexKind | null;
  /** Display text the provider writes. */
  readonly nativeType: string;
}

export type ScoreKind = "similarity" | "distance" | "fused" | "computed" | "unranked";

/** What a result's score column means. */
export interface ScoreSemantics {
  readonly kind: ScoreKind;
  /** Null for `unranked`, and wherever the engine states no direction. */
  readonly better: "higher" | "lower" | null;
  readonly metric: VectorMetric | null;
  /** The engine's own name for the score. */
  readonly nativeName: string | null;
}

/** Whether a count is one the engine computed exactly, or an estimate. */
export type CountKind = "exact" | "estimate";

/**
 * A result column that holds vectors, as `QueryResult.vectorColumns` declares it.
 *
 * The results grid draws a cell as a vector only when its column is declared here, so a column nobody declared
 * keeps the JSON rendering it always had, and Copy Cell writes a declared cell whole, in the engine's own encoding.
 */
export interface VectorColumn {
  readonly kind: VectorKind;
  readonly dtype: VectorDType;
  /**
   * Elements per vector, bits for a binary vector, and the size of one row for a multivector; null for a sparse
   * column and where the engine declares no dimension.
   */
  readonly dimension: number | null;
  /** How a sparse cell is encoded: set on every sparse column and on no other. */
  readonly sparseEncoding?: SparseEncoding;
}
