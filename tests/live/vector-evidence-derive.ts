/**
 * What tests/live/vector-evidence.ts derives from the two seeds' manifests (vector-family spec 7.3), kept pure and
 * apart from the run, so tests/unit/db/vector/evidence-derive.test.ts holds every rule over small manifests.
 *
 * - The expected `VectorFieldInfo[]` of every seeded collection (spec 3.3), the target the Milvus and Qdrant
 *   providers' `schema.ts` tests reproduce from their own captures. The native-to-family tables below are this
 *   file's, and an index type they do not name maps to `opaque`.
 * - The expected cells in Studio's cell form: dense as numbers, binary as byte arrays, Milvus sparse as an index map
 *   in ascending index order, Qdrant sparse as `{indices, values}`, derived from what the seed says the server
 *   stores and never from a REST base64 answer.
 * - The expected score of the Milvus `edge_values` sparse self-search, which REST cannot encode: its value 3.4e38
 *   squared passes the float32 maximum, so the score is Infinity.
 * - The comparison of one expected cell with the cell a REST answer holds, as float32.
 */

export type VectorKindJson = "dense" | "sparse" | "multi";
export type VectorDTypeJson = "float32" | "float64" | "float16" | "bfloat16" | "int8" | "uint8" | "binary";
export type VectorMetricJson =
  | "cosine"
  | "euclidean"
  | "euclidean_squared"
  | "dot"
  | "manhattan"
  | "hamming"
  | "jaccard"
  | "other";
export type VectorIndexKindJson = "hnsw" | "flat" | "ivf" | "graph_other" | "opaque";

/** `VectorFieldInfo` of src/lib/db/vector/types.ts (spec 3.3), as JSON. */
export interface ExpectedVectorField {
  readonly name: string;
  readonly kind: VectorKindJson;
  readonly dtype: VectorDTypeJson;
  readonly dimension: number | null;
  readonly metric: VectorMetricJson | null;
  readonly nativeMetric: string | null;
  readonly indexKind: VectorIndexKindJson | null;
  readonly nativeType: string;
}

// -- the manifests, as docker/milvus/seed.py and docker/qdrant/seed.py print them ------------------------------

export interface MilvusManifestField {
  readonly name: string;
  readonly type: string;
  readonly dim?: number;
}

export interface MilvusManifestIndex {
  readonly type: string;
  readonly metric: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface MilvusManifestRow {
  readonly seq: number;
  /** The primary key, or null on a collection whose key the server assigns (auto_id). */
  readonly key: string | number | null;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface MilvusManifestCollection {
  readonly rows: number;
  readonly loaded: boolean;
  /** The primary key field a fixture addresses a row by, or null where the server assigns the key. */
  readonly key: string | null;
  readonly functions: readonly { readonly name: string; readonly output: readonly string[] }[];
  readonly fields: readonly MilvusManifestField[];
  readonly indexes: Readonly<Record<string, MilvusManifestIndex>>;
  readonly sample: readonly MilvusManifestRow[];
}

/** The build a seed's manifest was printed from: the server's pinned image, its digest, and the date it was printed. */
export interface ManifestBuild {
  readonly image: string;
  readonly digest: string;
  readonly date: string;
}

/**
 * The build a manifest records, which every capture of its engine records too. A manifest printed from another build
 * than the running server's, which `pinned` names, stops the run.
 */
export function manifestProvenance(
  engine: string,
  manifest: ManifestBuild & { readonly server_version: string },
  pinned: { readonly image: string; readonly digest: string },
): { readonly image: string; readonly digest: string; readonly version: string } {
  if (manifest.image !== pinned.image || manifest.digest !== pinned.digest) {
    throw new Error(
      `the ${engine} manifest records ${manifest.image}@${manifest.digest}, not ${pinned.image}@${pinned.digest}: nothing written`,
    );
  }
  return { image: manifest.image, digest: manifest.digest, version: manifest.server_version };
}

export interface MilvusManifest extends ManifestBuild {
  readonly engine: "milvus";
  readonly server_version: string;
  readonly databases: Readonly<Record<string, Readonly<Record<string, MilvusManifestCollection>>>>;
}

/** The HNSW settings a Qdrant collection or vector states; a key it leaves out is taken from the level above. */
export interface QdrantHnswConfig {
  readonly m?: number;
  readonly payload_m?: number | null;
}

export interface QdrantManifestVector {
  /** "" for an unnamed vector. */
  readonly name: string;
  readonly kind: VectorKindJson;
  readonly size: number | null;
  readonly distance: string | null;
  readonly datatype: string;
  /** False where the server does not return what the seed sent; `reason` then says why. */
  readonly derivable: boolean;
  readonly reason?: string;
  /** The vector's own HNSW settings, which decide over its collection's. */
  readonly hnsw_config?: QdrantHnswConfig;
}

export interface QdrantManifestPoint {
  readonly seq: number;
  readonly id: number | string;
  /** The stored form of every derivable vector, null where the point has none. */
  readonly vectors: Readonly<Record<string, unknown>>;
}

export interface QdrantManifestCollection {
  readonly points: number;
  /** The collection's HNSW settings, where they differ from the server's default. */
  readonly hnsw_config?: QdrantHnswConfig;
  readonly vectors: readonly QdrantManifestVector[];
  readonly sample: readonly QdrantManifestPoint[];
}

export interface QdrantManifest extends ManifestBuild {
  readonly engine: "qdrant";
  readonly server_version: string;
  readonly collections: Readonly<Record<string, QdrantManifestCollection>>;
}

// -- expected fields --------------------------------------------------------------------------------------------

const MILVUS_VECTOR_TYPES: Readonly<
  Record<string, { readonly kind: VectorKindJson; readonly dtype: VectorDTypeJson }>
> = {
  FloatVector: { kind: "dense", dtype: "float32" },
  Float16Vector: { kind: "dense", dtype: "float16" },
  BFloat16Vector: { kind: "dense", dtype: "bfloat16" },
  BinaryVector: { kind: "dense", dtype: "binary" },
  Int8Vector: { kind: "dense", dtype: "int8" },
  SparseFloatVector: { kind: "sparse", dtype: "float32" },
};

/** Milvus `L2` is the squared distance and Qdrant `Euclid` is not; BM25 is no metric of the family. */
const MILVUS_METRICS: Readonly<Record<string, VectorMetricJson>> = {
  COSINE: "cosine",
  IP: "dot",
  L2: "euclidean_squared",
  HAMMING: "hamming",
  JACCARD: "jaccard",
  BM25: "other",
};

/** Milvus `index_type` to the family's index kind; a name this table does not list is `opaque`. */
const MILVUS_INDEX_KINDS: Readonly<Record<string, VectorIndexKindJson>> = {
  HNSW: "hnsw",
  HNSW_SQ: "hnsw",
  HNSW_PQ: "hnsw",
  HNSW_PRQ: "hnsw",
  FLAT: "flat",
  BIN_FLAT: "flat",
  GPU_BRUTE_FORCE: "flat",
  IVF_FLAT: "ivf",
  IVF_SQ8: "ivf",
  IVF_PQ: "ivf",
  IVF_RABITQ: "ivf",
  BIN_IVF_FLAT: "ivf",
  SCANN: "ivf",
  IVF_FLAT_CC: "ivf",
  IVF_SQ_CC: "ivf",
  GPU_IVF_FLAT: "ivf",
  GPU_IVF_PQ: "ivf",
  DISKANN: "graph_other",
  AISAQ: "graph_other",
  GPU_CAGRA: "graph_other",
  AUTOINDEX: "opaque",
  SPARSE_INVERTED_INDEX: "opaque",
  SPARSE_WAND: "opaque",
  MINHASH_LSH: "opaque",
};

const QDRANT_DTYPES: Readonly<Record<string, VectorDTypeJson>> = {
  float32: "float32",
  float16: "float16",
  uint8: "uint8",
  // turbo4 stores a quantised reconstruction, and Studio reads its elements as float32.
  turbo4: "float32",
};

const QDRANT_METRICS: Readonly<Record<string, VectorMetricJson>> = {
  Cosine: "cosine",
  Euclid: "euclidean",
  Dot: "dot",
  Manhattan: "manhattan",
};

/** Qdrant's default HNSW `m` (`storage.hnsw_index.m`), which a collection that states none takes. */
const QDRANT_DEFAULT_HNSW_M = 16;

/**
 * A dense or multivector field's index kind from its effective HNSW settings, its own over its collection's: `m`
 * above 0 is `hnsw`; `m` 0 is `flat`, unless `payload_m` is above 0, which builds a payload-only graph, `opaque`.
 */
function qdrantIndexKind(collection: QdrantManifestCollection, vector: QdrantManifestVector): VectorIndexKindJson {
  const m = vector.hnsw_config?.m ?? collection.hnsw_config?.m ?? QDRANT_DEFAULT_HNSW_M;
  if (m > 0) return "hnsw";
  const payloadM = vector.hnsw_config?.payload_m ?? collection.hnsw_config?.payload_m ?? 0;
  return payloadM > 0 ? "opaque" : "flat";
}

function lookup<T>(table: Readonly<Record<string, T>>, key: string | null, what: string): T {
  const found = key === null ? undefined : table[key];
  if (found === undefined) throw new Error(`no family value for the ${what} ${String(key)}`);
  return found;
}

/** The expected fields of every Milvus collection, keyed "<database>/<collection>". */
export function expectedMilvusFields(manifest: MilvusManifest): Record<string, ExpectedVectorField[]> {
  const out: Record<string, ExpectedVectorField[]> = {};
  for (const [database, collections] of Object.entries(manifest.databases)) {
    for (const [name, collection] of Object.entries(collections)) {
      out[`${database}/${name}`] = collection.fields
        .filter((field) => field.type in MILVUS_VECTOR_TYPES)
        .map((field) => {
          const { kind, dtype } = MILVUS_VECTOR_TYPES[field.type];
          const index = collection.indexes[field.name];
          if (kind !== "sparse" && field.dim === undefined) {
            throw new Error(`${database}.${name}.${field.name} has no dimension in the manifest`);
          }
          return {
            name: field.name,
            kind,
            dtype,
            dimension: kind === "sparse" ? null : (field.dim ?? null),
            // A field with no index has neither a metric nor an index kind.
            metric:
              index === undefined
                ? null
                : lookup(MILVUS_METRICS, index.metric, `Milvus metric of ${database}.${name}.${field.name}`),
            nativeMetric: index === undefined ? null : index.metric,
            indexKind: index === undefined ? null : (MILVUS_INDEX_KINDS[index.type] ?? "opaque"),
            nativeType: kind === "sparse" ? field.type : `${field.type}(${field.dim})`,
          };
        });
    }
  }
  return out;
}

/** The expected fields of every Qdrant collection, keyed by its name. */
export function expectedQdrantFields(manifest: QdrantManifest): Record<string, ExpectedVectorField[]> {
  const out: Record<string, ExpectedVectorField[]> = {};
  for (const [name, collection] of Object.entries(manifest.collections)) {
    out[name] = collection.vectors.map((vector) => {
      const dtype = lookup(QDRANT_DTYPES, vector.datatype, `Qdrant datatype of ${name}.${vector.name}`);
      if (vector.kind === "sparse") {
        // A sparse vector declares no distance: its score is a dot product, and the index is Qdrant's own.
        return {
          name: vector.name,
          kind: "sparse",
          dtype,
          dimension: null,
          metric: "dot",
          nativeMetric: null,
          indexKind: "opaque",
          nativeType: `sparse ${vector.datatype}`,
        };
      }
      return {
        name: vector.name,
        kind: vector.kind,
        dtype,
        dimension: vector.size,
        metric: lookup(QDRANT_METRICS, vector.distance, `Qdrant distance of ${name}.${vector.name}`),
        nativeMetric: vector.distance,
        indexKind: qdrantIndexKind(collection, vector),
        nativeType: `${vector.datatype}(${vector.size})${vector.kind === "multi" ? " multivector" : ""}`,
      };
    });
  }
  return out;
}

// -- expected cells ---------------------------------------------------------------------------------------------

export interface ExpectedCell {
  /** "<database>/<collection>" on Milvus, "<collection>" on Qdrant. */
  readonly collection: string;
  readonly seq: number;
  /** How a REST row is found for this cell: the field it is addressed by, and its value. */
  readonly match: { readonly field: string; readonly value: unknown };
  readonly field: string;
  readonly kind: VectorKindJson;
  readonly dtype: VectorDTypeJson;
  readonly cell: unknown;
}

export interface ExcludedField {
  readonly collection: string;
  readonly field: string;
  readonly reason: string;
}

export interface ExpectedCells {
  readonly cells: readonly ExpectedCell[];
  readonly excluded: readonly ExcludedField[];
}

function indexMap(value: unknown, where: string): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} is not a sparse index map in the manifest`);
  }
  return Object.fromEntries(Object.entries(value as Record<string, number>).sort(([a], [b]) => Number(a) - Number(b)));
}

function indicesValues(value: unknown, where: string): { indices: number[]; values: (number | null)[] } {
  const pair = value as { indices?: unknown; values?: unknown };
  if (!Array.isArray(pair?.indices) || !Array.isArray(pair.values) || pair.indices.length !== pair.values.length) {
    throw new Error(`${where} is not a sparse {indices, values} pair of equal lengths in the manifest`);
  }
  const values = pair.values as (number | null)[];
  const order = (pair.indices as number[]).map((index, position) => ({ index, value: values[position] }));
  order.sort((a, b) => a.index - b.index);
  return { indices: order.map((entry) => entry.index), values: order.map((entry) => entry.value) };
}

export function expectedMilvusCells(manifest: MilvusManifest): ExpectedCells {
  const cells: ExpectedCell[] = [];
  const excluded: ExcludedField[] = [];
  for (const [database, collections] of Object.entries(manifest.databases)) {
    for (const [name, collection] of Object.entries(collections)) {
      const where = `${database}/${name}`;
      const outputs = new Set(collection.functions.flatMap((fn) => fn.output));
      for (const field of collection.fields) {
        const family = MILVUS_VECTOR_TYPES[field.type];
        if (family === undefined) continue;
        if (outputs.has(field.name)) {
          excluded.push({
            collection: where,
            field: field.name,
            reason: "a server function's output, which the seed never writes",
          });
          continue;
        }
        for (const row of collection.sample) {
          const value = row.values[field.name];
          if (value === undefined) throw new Error(`${where} seq ${row.seq} holds no ${field.name} in the manifest`);
          cells.push({
            collection: where,
            seq: row.seq,
            match:
              collection.key === null
                ? { field: "seq", value: row.values.seq }
                : { field: collection.key, value: row.key },
            field: field.name,
            kind: family.kind,
            dtype: family.dtype,
            cell: family.kind === "sparse" ? indexMap(value, `${where} seq ${row.seq} ${field.name}`) : value,
          });
        }
      }
    }
  }
  return { cells, excluded };
}

export function expectedQdrantCells(manifest: QdrantManifest): ExpectedCells {
  const cells: ExpectedCell[] = [];
  const excluded: ExcludedField[] = [];
  for (const [name, collection] of Object.entries(manifest.collections)) {
    for (const vector of collection.vectors) {
      if (!vector.derivable) {
        if (vector.reason === undefined) throw new Error(`${name}.${vector.name} is not derivable and says not why`);
        excluded.push({ collection: name, field: vector.name, reason: vector.reason });
        continue;
      }
      const dtype = lookup(QDRANT_DTYPES, vector.datatype, `Qdrant datatype of ${name}.${vector.name}`);
      for (const point of collection.sample) {
        const value = point.vectors[vector.name];
        if (value === undefined)
          throw new Error(`${name} point ${String(point.id)} holds no ${vector.name} in the manifest`);
        cells.push({
          collection: name,
          seq: point.seq,
          match: { field: "id", value: point.id },
          field: vector.name,
          kind: vector.kind,
          dtype,
          cell:
            vector.kind === "sparse" && value !== null
              ? indicesValues(value, `${name} point ${String(point.id)} ${vector.name}`)
              : value,
        });
      }
    }
  }
  return { cells, excluded };
}

// -- scores -----------------------------------------------------------------------------------------------------

export type ScoreText = number | "Infinity" | "-Infinity" | "NaN";

/** A score as JSON can carry it: a finite number, or the word for a non-finite one. */
export function scoreText(score: number): ScoreText {
  if (Number.isNaN(score)) return "NaN";
  if (score === Number.POSITIVE_INFINITY) return "Infinity";
  if (score === Number.NEGATIVE_INFINITY) return "-Infinity";
  return score;
}

/** A sparse vector's inner product with itself, summed in float32 as the server computes it. */
export function float32SelfInnerProduct(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    const element = Math.fround(value);
    sum = Math.fround(sum + Math.fround(element * element));
  }
  return sum;
}

export interface MilvusNonFiniteScore {
  readonly collection: string;
  readonly id: number;
  readonly field: string;
  readonly cell: Record<string, number>;
  /** The same product in double precision, for the record: finite, and above the float32 maximum. */
  readonly doubleSelfInnerProduct: ScoreText;
  readonly score: ScoreText;
}

export function milvusNonFiniteScore(manifest: MilvusManifest): MilvusNonFiniteScore {
  const row = manifest.databases.default?.edge_values?.sample.find(
    (entry) => entry.values.label === "non-finite-score",
  );
  if (row === undefined) throw new Error("the Milvus manifest has no edge_values row labelled non-finite-score");
  const cell = indexMap(row.values.sp, "default/edge_values non-finite-score sp");
  const values = Object.values(cell);
  return {
    collection: "default/edge_values",
    id: Number(row.key),
    field: "sp",
    cell,
    doubleSelfInnerProduct: scoreText(values.reduce((sum, value) => sum + value * value, 0)),
    score: scoreText(float32SelfInnerProduct(values)),
  };
}

// -- the comparison with REST -----------------------------------------------------------------------------------

/** JSON text that writes a negative zero as -0, which JSON.stringify writes as 0. */
function signedText(value: unknown): string {
  return Object.is(value, -0) ? "-0" : JSON.stringify(value);
}

const NEGATIVE_ZERO = "\u0000negative-zero\u0000";

/**
 * A fixture file's text: JSON indented by two, with a newline at the end, and every negative zero written as -0.0,
 * which JSON.parse reads back as -0. JSON.stringify alone writes -0 as 0, and the seeds store -0 on purpose.
 */
export function serialiseFixture(content: object): string {
  const placeholder = JSON.stringify(NEGATIVE_ZERO);
  if (JSON.stringify(content).includes(placeholder)) {
    throw new Error("the content holds the serialiser's placeholder for -0");
  }
  const text = JSON.stringify(content, (_key, value: unknown) => (Object.is(value, -0) ? NEGATIVE_ZERO : value), 2);
  return `${text.replaceAll(placeholder, "-0.0")}\n`;
}

export type CellComparison =
  | { readonly status: "equal" }
  | { readonly status: "differs" | "not-comparable"; readonly detail: string };

const EQUAL: CellComparison = { status: "equal" };

/**
 * Compares an expected cell with the cell a REST answer holds: numbers as float32, null only with null, arrays
 * element by element, objects key by key. A REST cell of another shape (a base64 string where a list is expected)
 * is `not-comparable`, which the run reports; a difference in value is `differs`, which stops the run.
 */
export function compareCell(expected: unknown, rest: unknown, at = "cell"): CellComparison {
  if (expected === null) {
    return rest === null
      ? EQUAL
      : { status: "differs", detail: `${at}: expected null, REST holds ${JSON.stringify(rest)}` };
  }
  if (typeof expected === "number") {
    if (typeof rest === "number" && Object.is(Math.fround(expected), Math.fround(rest))) return EQUAL;
    return { status: "differs", detail: `${at}: expected ${signedText(expected)}, REST holds ${signedText(rest)}` };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(rest)) return { status: "not-comparable", detail: `${at}: REST holds ${typeof rest}` };
    if (rest.length !== expected.length) {
      return { status: "differs", detail: `${at}: expected ${expected.length} elements, REST holds ${rest.length}` };
    }
    for (let index = 0; index < expected.length; index++) {
      const compared = compareCell(expected[index], rest[index], `${at}[${index}]`);
      if (compared.status !== "equal") return compared;
    }
    return EQUAL;
  }
  if (typeof expected === "object") {
    if (rest === null || typeof rest !== "object" || Array.isArray(rest)) {
      return {
        status: "not-comparable",
        detail: `${at}: REST holds ${Array.isArray(rest) ? "an array" : typeof rest}`,
      };
    }
    const want = Object.keys(expected).sort();
    const have = Object.keys(rest).sort();
    if (want.join(",") !== have.join(",")) {
      return { status: "differs", detail: `${at}: expected the keys ${want.join(",")}, REST holds ${have.join(",")}` };
    }
    for (const key of want) {
      const compared = compareCell(
        (expected as Record<string, unknown>)[key],
        (rest as Record<string, unknown>)[key],
        `${at}.${key}`,
      );
      if (compared.status !== "equal") return compared;
    }
    return EQUAL;
  }
  throw new Error(`${at}: an expected cell holds a ${typeof expected}`);
}
