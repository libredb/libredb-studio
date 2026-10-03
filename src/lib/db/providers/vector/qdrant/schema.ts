/**
 * A Qdrant collection's description read into Studio's schema types (vector-family spec 6.3): the columns the engine
 * declares (the id, one per vector, one per payload index), the indexes, the shared `VectorFieldInfo` of each vector
 * and the `vectorColumns` a result declares. Pure: it receives the `result` of `GET /collections/{collection_name}`
 * and never a client.
 *
 * The payload is schemaless, so `payload_schema` lists only the fields that carry an index; the keys a sample finds
 * are sample.ts's. A vector's index kind is its configuration, the vector's own `hnsw_config` over the collection's,
 * and never the build state: `indexed_vectors_count` says how much of the data the index covers, which the Source
 * states.
 */
import { QueryError } from "@/lib/db/errors";
import type { VectorColumn, VectorFieldInfo, VectorIndexKind } from "@/lib/db/vector/types";
import type { ColumnSchema, DatabaseType, IndexSchema } from "@/lib/types";
import { payloadColumnName } from "./columns";
import { qdrantMetric } from "./qdrant-vocabulary";
import {
  QDRANT_ELEMENT_DTYPE,
  type QdrantDatatype,
  type QdrantVectorShape,
  vectorColumnName,
  vectorTypeText,
} from "./type-spelling";

const PROVIDER: DatabaseType = "qdrant";

type JsonObject = Readonly<Record<string, unknown>>;

/** The `result` of `GET /collections/{collection_name}`, its two parts this module reads checked to be objects. */
export interface QdrantCollection {
  readonly name: string;
  readonly info: JsonObject;
  readonly config: JsonObject;
  readonly params: JsonObject;
}

/** One vector of a collection as its configuration declares it. */
export interface QdrantVector {
  /** The vector's name, "" for the unnamed one. */
  readonly name: string;
  /** Its column: `vector`, or `vector.<name>`. */
  readonly column: string;
  readonly shape: QdrantVectorShape;
  readonly typeText: string;
  readonly indexKind: VectorIndexKind;
  /** The index in Qdrant's own words, which the index panel shows. */
  readonly nativeIndex: string;
}

/** One payload index of `payload_schema`: the field's key as filters write it, and its type. */
export interface QdrantPayloadIndex {
  readonly key: string;
  readonly column: string;
  readonly type: string;
  /** The index's parameters, present only on a parameterised index. */
  readonly params?: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(collection: string, what: string): QueryError {
  return new QueryError(
    `Qdrant's description of collection ${JSON.stringify(collection)} is not one Studio can read: ${what}.`,
    PROVIDER,
  );
}

/** The description of a collection, or a refusal naming the part that is missing. */
export function readQdrantCollection(name: string, result: unknown): QdrantCollection {
  if (!isObject(result)) throw unreadable(name, "the answer holds no result object");
  const { config } = result;
  if (!isObject(config)) throw unreadable(name, "it holds no config");
  const { params } = config;
  if (!isObject(params)) throw unreadable(name, "its config holds no params");
  return { name, info: result, config, params };
}

/**
 * A count the description reports: a number, or the exact digits of one past 2^53, which the lossless parse hands
 * over as a string. Null where the server reports none, which its schema allows.
 */
export function qdrantCount(value: unknown): number | null {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : null;
}

function datatypeOf(collection: QdrantCollection, vector: string, value: unknown): QdrantDatatype {
  if (value === undefined || value === null) return "float32";
  if (typeof value === "string" && Object.hasOwn(QDRANT_ELEMENT_DTYPE, value)) return value as QdrantDatatype;
  throw unreadable(
    collection.name,
    `vector ${JSON.stringify(vector)} has the datatype ${JSON.stringify(value)}, which this version of Studio does not read`,
  );
}

const HNSW = "HNSW";
const PER_TENANT = "HNSW per tenant (payload_m)";
const FULL_SCAN = "full scan (m is 0)";
const INVERTED = "sparse inverted index";
const UNREAD_INDEX = "unknown";

/** The index of a dense or multivector by its effective `hnsw_config`: the vector's own keys over the collection's. */
function denseIndex(
  collection: QdrantCollection,
  own: unknown,
): { readonly indexKind: VectorIndexKind; readonly nativeIndex: string } {
  const effective = {
    ...(isObject(collection.config.hnsw_config) ? collection.config.hnsw_config : {}),
    ...(isObject(own) ? own : {}),
  };
  const { m, payload_m: payloadM } = effective;
  if (typeof m !== "number") return { indexKind: "opaque", nativeIndex: UNREAD_INDEX };
  if (m > 0) return { indexKind: "hnsw", nativeIndex: HNSW };
  // m is 0: the global graph is off. Per-tenant graphs serve a filtered search only, so the kind is not HNSW.
  return typeof payloadM === "number" && payloadM > 0
    ? { indexKind: "opaque", nativeIndex: PER_TENANT }
    : { indexKind: "flat", nativeIndex: FULL_SCAN };
}

function denseVector(collection: QdrantCollection, name: string, declared: unknown): QdrantVector {
  if (!isObject(declared) || typeof declared.size !== "number" || typeof declared.distance !== "string") {
    throw unreadable(collection.name, `vector ${JSON.stringify(name)} declares no size and distance`);
  }
  const datatype = datatypeOf(collection, name, declared.datatype);
  const { size, distance } = declared;
  const multi = isObject(declared.multivector_config) ? declared.multivector_config.comparator : undefined;
  const shape: QdrantVectorShape =
    typeof multi === "string"
      ? { kind: "multi", size, datatype, distance, comparator: multi }
      : { kind: "dense", size, datatype, distance };
  return {
    name,
    column: vectorColumnName(name),
    shape,
    typeText: vectorTypeText(shape),
    ...denseIndex(collection, declared.hnsw_config),
  };
}

function sparseVector(collection: QdrantCollection, name: string, declared: unknown): QdrantVector {
  const index = isObject(declared) && isObject(declared.index) ? declared.index : {};
  const modifier = isObject(declared) && typeof declared.modifier === "string" ? declared.modifier : "none";
  const shape: QdrantVectorShape = {
    kind: "sparse",
    modifier,
    datatype: datatypeOf(collection, name, index.datatype),
  };
  return {
    name,
    column: vectorColumnName(name),
    shape,
    typeText: vectorTypeText(shape),
    indexKind: "opaque",
    nativeIndex: INVERTED,
  };
}

/**
 * Every vector of the collection: the dense vectors and multivectors in the order the description gives them, then
 * the sparse ones. `vectors` is one unnamed vector when it carries a numeric `size`, else a map of named ones, which
 * may be empty; `sparse_vectors` is always a map.
 */
export function qdrantVectors(collection: QdrantCollection): readonly QdrantVector[] {
  const { vectors, sparse_vectors: sparse } = collection.params;
  const dense: QdrantVector[] = [];
  if (isObject(vectors)) {
    if (typeof vectors.size === "number") dense.push(denseVector(collection, "", vectors));
    else for (const [name, declared] of Object.entries(vectors)) dense.push(denseVector(collection, name, declared));
  }
  const sparseVectors = isObject(sparse)
    ? Object.entries(sparse).map(([name, declared]) => sparseVector(collection, name, declared))
    : [];
  return [...dense, ...sparseVectors];
}

/** The shared description of each vector: the family's kind, element type, metric and index kind beside Qdrant's own words. */
export function qdrantVectorFields(collection: QdrantCollection): readonly VectorFieldInfo[] {
  return qdrantVectors(collection).map(({ name, shape, indexKind }): VectorFieldInfo => {
    const dtype = QDRANT_ELEMENT_DTYPE[shape.datatype];
    if (shape.kind === "sparse") {
      // A sparse vector is always compared by inner product, and Qdrant's description names no distance for it.
      return {
        name,
        kind: "sparse",
        dtype,
        dimension: null,
        metric: "dot",
        nativeMetric: null,
        indexKind,
        nativeType: `sparse ${shape.datatype}`,
      };
    }
    const { metric, nativeMetric } = qdrantMetric(shape.distance);
    return {
      name,
      kind: shape.kind,
      dtype,
      dimension: shape.size,
      metric,
      nativeMetric,
      indexKind,
      nativeType: `${shape.datatype}(${shape.size})${shape.kind === "multi" ? " multivector" : ""}`,
    };
  });
}

/** What a result declares for each vector column, keyed by the column's name. */
export function qdrantVectorColumns(collection: QdrantCollection): Readonly<Record<string, VectorColumn>> {
  const columns: Record<string, VectorColumn> = Object.create(null);
  for (const { column, shape } of qdrantVectors(collection)) {
    const dtype = QDRANT_ELEMENT_DTYPE[shape.datatype];
    columns[column] =
      shape.kind === "sparse"
        ? { kind: "sparse", dtype, dimension: null, sparseEncoding: "indices-values" }
        : { kind: shape.kind, dtype, dimension: shape.size };
  }
  return columns;
}

/** The payload indexes of `payload_schema`, in the description's order. An entry with no `data_type` is not an index Studio can name. */
export function qdrantPayloadIndexes(collection: QdrantCollection): readonly QdrantPayloadIndex[] {
  const schema = collection.info.payload_schema;
  if (!isObject(schema)) return [];
  return Object.entries(schema).flatMap(([key, declared]): QdrantPayloadIndex[] => {
    if (!isObject(declared) || typeof declared.data_type !== "string") return [];
    return [
      {
        key,
        column: payloadColumnName(key),
        type: declared.data_type,
        ...(isObject(declared.params) ? { params: declared.params } : {}),
      },
    ];
  });
}

/** The id's column: Qdrant's own name for it, and the two forms an id takes. */
const ID_COLUMN: ColumnSchema = Object.freeze({ name: "id", type: "uint64 or UUID", nullable: false, isPrimary: true });

/**
 * The columns the engine declares: the id, one per vector, and one per payload index, typed by the index. A named
 * or sparse vector may be absent on a point, and no payload field is required, so both are nullable.
 */
export function qdrantDeclaredColumns(collection: QdrantCollection): readonly ColumnSchema[] {
  return [
    ID_COLUMN,
    ...qdrantVectors(collection).map(
      ({ name, column, typeText }): ColumnSchema => ({
        name: column,
        type: typeText,
        nullable: name !== "",
        isPrimary: false,
      }),
    ),
    ...qdrantPayloadIndexes(collection).map(
      ({ column, type }): ColumnSchema => ({ name: column, type, nullable: true, isPrimary: false }),
    ),
  ];
}

/** One index per payload index, named by the field's key as a filter writes it, and one per vector, named by its column. */
export function qdrantIndexes(collection: QdrantCollection): readonly IndexSchema[] {
  return [
    ...qdrantPayloadIndexes(collection).map(
      ({ key, column }): IndexSchema => ({ name: key, columns: [column], unique: false }),
    ),
    ...qdrantVectors(collection).map(({ column }): IndexSchema => ({ name: column, columns: [column], unique: false })),
  ];
}
