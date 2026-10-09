/**
 * DescribeCollection and DescribeIndex in the shapes the tree, the agent and the Load preview read: a collection's
 * columns, its vector fields as the shared `VectorFieldInfo`, and each vector field's index kind and metric.
 *
 * A column is a described field with the type text Studio spells everywhere (`FloatVector(768)`, `VarChar(256)`,
 * `Array<Int64>(8)`, a function's output with its function), which milvus-vocabulary.ts writes; the dynamic field is
 * the one column `$meta`. No column ever carries a default value: the MCP schema tool serialises that field, and a
 * default is data. A function's parameters are never read here.
 *
 * Pure: it receives answers and never a client. An index kind is read from the `index_type` DescribeIndex reports,
 * by one table; a name the table does not list is `opaque`, so a later server's index type is never guessed.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/db/types";
import type { VectorFieldInfo, VectorIndexKind } from "@/lib/db/vector/types";
import type { ColumnSchema } from "@/lib/types";
import type { DescribeCollectionResponse, WireCollectionSchema, WireFieldSchema, WireIndexDescription } from "./client";
import { fieldTypeText, scoreSemantics } from "./milvus-vocabulary";
import { vectorTargetOf } from "./request";
import { STRUCT_ARRAY_TYPE } from "./type-spelling";

const PROVIDER: DatabaseType = "milvus";

/** The schema of a describe answer; an answer without one is refused in Studio's words, never read as empty. */
export function describedSchema(describe: DescribeCollectionResponse): WireCollectionSchema {
  if (describe.schema === null) {
    throw new QueryError(
      `Milvus described collection ${describe.collection_name} with no schema, so Studio reads no field from it.`,
      PROVIDER,
    );
  }
  return describe.schema;
}

/**
 * The collection's columns, in the described order: the fields, then each struct array field as one column. The
 * dynamic field is nullable, because a row may hold no dynamic key. Milvus 3.0.2 can enable it without listing
 * $meta in fields; expose that column once so generated commands can explicitly request the dynamic keys.
 */
export function collectionColumns(describe: DescribeCollectionResponse): ColumnSchema[] {
  const schema = describedSchema(describe);
  return [
    ...schema.fields.map((field) => ({
      name: field.name,
      type: fieldTypeText(field, schema.functions),
      nullable: field.nullable || field.is_dynamic,
      isPrimary: field.is_primary_key,
    })),
    ...(schema.enable_dynamic_field && !schema.fields.some((field) => field.name === "$meta")
      ? [{ name: "$meta", type: "JSON (dynamic)", nullable: true, isPrimary: false }]
      : []),
    ...schema.struct_array_fields.map((struct) => ({
      name: struct.name,
      type: STRUCT_ARRAY_TYPE,
      nullable: struct.nullable,
      isPrimary: false,
    })),
  ];
}

/**
 * A vector field's type alone, without the function that may produce it (the function is the column's text); an
 * embedding list names its element vector type, `ArrayOfVector(FloatVector(4))`.
 */
function vectorTypeText(field: WireFieldSchema): string {
  return field.data_type === "ArrayOfVector"
    ? `ArrayOfVector(${fieldTypeText({ ...field, data_type: field.element_type }, [])})`
    : fieldTypeText(field, []);
}

function vectorField(name: string, field: WireFieldSchema): VectorFieldInfo[] {
  const target = vectorTargetOf(field);
  if (target === undefined) return [];
  return [
    {
      name,
      kind: target.kind,
      dtype: target.dtype,
      dimension: target.dimension,
      metric: null,
      nativeMetric: null,
      indexKind: null,
      nativeType: vectorTypeText(field),
    },
  ];
}

/**
 * The collection's vector fields from DescribeCollection alone, so with no metric and no index kind: both come from
 * DescribeIndex, through `withIndexKinds`. An embedding list inside a struct array field is named `struct[field]`,
 * as a search names it.
 */
export function vectorFieldInfos(describe: DescribeCollectionResponse): VectorFieldInfo[] {
  const schema = describedSchema(describe);
  return [
    ...schema.fields.flatMap((field) => vectorField(field.name, field)),
    ...schema.struct_array_fields.flatMap((struct) =>
      struct.fields.flatMap((field) => vectorField(`${struct.name}[${field.name}]`, field)),
    ),
  ];
}

/**
 * Milvus's `index_type` names to the shared `VectorIndexKind`. `AUTOINDEX` is `opaque` because the server reports it as
 * `AUTOINDEX` while what it builds depends on its configuration; the sparse and MinHash indexes are `opaque` too, and
 * so is any name not listed. The native name stays in the Source and in the index statistics.
 */
export const MILVUS_INDEX_KINDS: Readonly<Record<string, VectorIndexKind>> = Object.freeze({
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
});

/** The shared kind of one `index_type`, exact and case-sensitive; a name the table does not list is `opaque`. */
export function milvusIndexKind(indexType: string): VectorIndexKind {
  return Object.hasOwn(MILVUS_INDEX_KINDS, indexType) ? MILVUS_INDEX_KINDS[indexType] : "opaque";
}

/** One key of an index description's parameters (`index_type`, `metric_type`, `M`), as DescribeIndex sends it. */
export function indexParam(index: WireIndexDescription, key: string): string | undefined {
  return index.params.find((pair) => pair.key === key)?.value;
}

/**
 * The vector fields with the kind and the metric of the index DescribeIndex reports for each, matched by field name;
 * a field with no index has `indexKind` and `metric` null.
 */
export function withIndexKinds(
  fields: readonly VectorFieldInfo[],
  indexes: readonly WireIndexDescription[],
): VectorFieldInfo[] {
  return fields.map((field) => {
    const index = indexes.find((candidate) => candidate.field_name === field.name);
    if (index === undefined) return { ...field, indexKind: null, metric: null, nativeMetric: null };
    const nativeMetric = indexParam(index, "metric_type") ?? null;
    return {
      ...field,
      indexKind: milvusIndexKind(indexParam(index, "index_type") ?? ""),
      nativeMetric,
      metric: nativeMetric === null ? null : scoreSemantics(nativeMetric).metric,
    };
  });
}
