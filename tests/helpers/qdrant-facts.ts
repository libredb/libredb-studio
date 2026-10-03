/**
 * Qdrant collection facts and answers for the console's tests, from PR 1v's committed captures under
 * tests/fixtures/vector/qdrant/: each seeded collection's `VectorFieldInfo[]` from expected-fields.json, its turbo4
 * vectors and payload index types from its describe capture, and an answer's exact text from a capture. Nothing
 * here calls a server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QdrantCollectionFacts } from "@/lib/db/providers/vector/qdrant/request";
import type { VectorFieldInfo } from "@/lib/db/vector/types";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vector", "qdrant");

interface Capture {
  readonly payload: { readonly body: string };
}

/** The exact text the server answered in one capture, such as `search-non-finite`. */
export function capturedText(name: string): string {
  return (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Capture).payload.body;
}

const fields = (
  JSON.parse(readFileSync(join(FIXTURES, "expected-fields.json"), "utf8")) as {
    readonly fields: Readonly<Record<string, readonly VectorFieldInfo[]>>;
  }
).fields;

interface DescribedVector {
  readonly datatype?: string;
}

/** A seeded collection's facts: `docs`, `edge_values`, `plain`, `small_dtypes` and the rest. */
export function seededFacts(collection: string): QdrantCollectionFacts {
  const vectors = fields[collection];
  if (vectors === undefined) throw new Error(`no expected fields for ${collection}`);
  const described = JSON.parse(capturedText(`describe-${collection}`)) as {
    readonly result: {
      readonly config: { readonly params: { readonly vectors?: Readonly<Record<string, unknown>> } };
      readonly payload_schema: Readonly<Record<string, { readonly data_type: string }>>;
    };
  };
  const declared = described.result.config.params.vectors ?? {};
  const named: Readonly<Record<string, DescribedVector>> =
    "size" in declared ? { "": declared as DescribedVector } : (declared as Readonly<Record<string, DescribedVector>>);
  return {
    vectors,
    reconstructed: new Set(Object.keys(named).filter((name) => named[name].datatype === "turbo4")),
    payloadIndexTypes: new Map(
      Object.entries(described.result.payload_schema).map(([key, index]) => [key, index.data_type]),
    ),
  };
}

/** Facts for a synthetic collection of the given vectors, with no payload index and nothing reconstructed. */
export function factsOf(vectors: readonly VectorFieldInfo[]): QdrantCollectionFacts {
  return { vectors, reconstructed: new Set(), payloadIndexTypes: new Map() };
}

/** A dense vector field, as a synthetic collection declares it. */
export function dense(
  name: string,
  dimension: number,
  options: Partial<Pick<VectorFieldInfo, "dtype" | "metric" | "nativeMetric" | "kind">> = {},
): VectorFieldInfo {
  return {
    name,
    kind: options.kind ?? "dense",
    dtype: options.dtype ?? "float32",
    dimension,
    metric: options.metric ?? "cosine",
    nativeMetric: options.nativeMetric ?? "Cosine",
    indexKind: "hnsw",
    nativeType: `Dense(${dimension}, ${options.dtype ?? "float32"}, ${options.nativeMetric ?? "Cosine"})`,
  };
}

/** A sparse vector field. */
export function sparse(name: string, dtype: VectorFieldInfo["dtype"] = "float32"): VectorFieldInfo {
  return {
    name,
    kind: "sparse",
    dtype,
    dimension: null,
    metric: "dot",
    nativeMetric: null,
    indexKind: "opaque",
    nativeType: "Sparse",
  };
}
