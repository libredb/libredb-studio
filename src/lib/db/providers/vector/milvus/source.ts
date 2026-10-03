/**
 * A collection's Source: two parts, each pretty JSON. `Schema` is the
 * collection in the vocabulary of Milvus's REST create-collection request, written only with keys that request takes,
 * so a reader can recreate the collection from it: `tests/unit/db/milvus/source.test.ts` holds every key to the create
 * key list. `State` is what the collection is now, in the describe vocabulary: its id, the load state, the
 * GetCollectionStatistics estimate and where it comes from, a partition key's field and count, the first 1,024
 * partitions, the aliases, and each index's type, metric and build progress, which `IndexStats` has no slot for.
 *
 * Neither part carries a default value or a function's parameters, which can hold a credential label and possibly a
 * service URL, and an index's fail reason, the server's text, passes `serverText`. Both
 * parts are `partial`: neither is a request Studio's console runs. Pure: objects.ts makes the reads.
 */
import { QueryError } from "@/lib/db/errors";
import { applySourceBound } from "@/lib/db/object-kinds";
import type { DatabaseType, ObjectSourcePart } from "@/lib/db/types";
import { serverText } from "@/lib/db/utils/server-text";
import type { DescribeCollectionResponse, WireFieldSchema, WireIndexDescription } from "./client";
import { indexParam } from "./schema";

const PROVIDER: DatabaseType = "milvus";

/** Where the State part's row count comes from. */
export const ROW_COUNT_SOURCE =
  "GetCollectionStatistics: flushed segments only, deletes not subtracted, may lag recent inserts";

/** The partitions the State part lists; ShowPartitions answers 1,024 in 2.8 ms. */
export const MILVUS_PARTITIONS_LISTED = 1024;

/** The type parameters the create request takes under `elementTypeParams`. */
const ELEMENT_TYPE_PARAMS: readonly string[] = ["dim", "max_length", "max_capacity"];

/** Data types the create request spells otherwise than DescribeCollection does. */
const CREATE_DATA_TYPES: Readonly<Record<string, string>> = { JSON: "Json" };

/** A parameter value that is a plain decimal reads as a number, as the create request writes it (`"M": 16`). */
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]+)?$/;

/** What objects.ts reads for one collection's Source. */
export interface MilvusSourceInput {
  readonly describe: DescribeCollectionResponse;
  readonly indexes: readonly WireIndexDescription[];
  /** GetLoadState's answer, `LoadStateLoaded` and the others, Milvus's own words. */
  readonly loadState: string;
  /** GetCollectionStatistics' `row_count`, absent when the answer carried none. */
  readonly rowCount?: string;
  readonly partitions: readonly string[];
  readonly aliases: readonly string[];
  readonly secretForms: readonly string[];
}

type JsonObject = { readonly [key: string]: unknown };

function numberOrText(value: string): number | string {
  return DECIMAL.test(value) ? Number(value) : value;
}

function createDataType(dataType: string): string {
  return Object.hasOwn(CREATE_DATA_TYPES, dataType) ? CREATE_DATA_TYPES[dataType] : dataType;
}

function createField(field: WireFieldSchema): JsonObject {
  const params = field.type_params.filter((pair) => ELEMENT_TYPE_PARAMS.includes(pair.key));
  return {
    fieldName: field.name,
    dataType: createDataType(field.data_type),
    ...(field.is_primary_key ? { isPrimary: true } : {}),
    ...(field.is_partition_key ? { isPartitionKey: true } : {}),
    ...(field.is_clustering_key ? { isClusteringKey: true } : {}),
    ...(field.data_type === "Array" ? { elementDataType: field.element_type } : {}),
    ...(params.length === 0
      ? {}
      : { elementTypeParams: Object.fromEntries(params.map((pair) => [pair.key, numberOrText(pair.value)])) }),
    ...(field.nullable ? { nullable: true } : {}),
  };
}

function createIndex(index: WireIndexDescription): JsonObject {
  const metric = indexParam(index, "metric_type");
  const indexType = indexParam(index, "index_type");
  const rest = index.params.filter((pair) => pair.key !== "metric_type" && pair.key !== "index_type");
  return {
    fieldName: index.field_name,
    indexName: index.index_name,
    ...(metric === undefined ? {} : { metricType: metric }),
    params: {
      ...(indexType === undefined ? {} : { index_type: indexType }),
      ...Object.fromEntries(rest.map((pair) => [pair.key, numberOrText(pair.value)])),
    },
  };
}

/** The Schema part: the collection as the REST create request writes it. */
export function schemaDocument(
  describe: DescribeCollectionResponse,
  indexes: readonly WireIndexDescription[],
): JsonObject {
  const { schema } = describe;
  if (schema === null) {
    throw new QueryError(
      `Milvus described collection ${describe.collection_name} with no schema, so Studio has no Source to show.`,
      PROVIDER,
    );
  }
  const partitionKey = schema.fields.some((field) => field.is_partition_key);
  return {
    collectionName: describe.collection_name,
    schema: {
      autoID: schema.autoID || schema.fields.some((field) => field.is_primary_key && field.autoID),
      enableDynamicField: schema.enable_dynamic_field,
      // The dynamic field is the flag above, never a field of the create request.
      fields: schema.fields.filter((field) => !field.is_dynamic).map(createField),
      functions: schema.functions.map((fn) => ({
        name: fn.name,
        ...(fn.description === "" ? {} : { description: fn.description }),
        type: fn.type,
        inputFieldNames: [...fn.input_field_names],
        outputFieldNames: [...fn.output_field_names],
      })),
    },
    indexParams: indexes.map(createIndex),
    params: {
      shardsNum: describe.shards_num,
      consistencyLevel: describe.consistency_level,
      ...(partitionKey ? { partitionsNum: Number(describe.num_partitions) } : {}),
    },
  };
}

function indexState(index: WireIndexDescription, secretForms: readonly string[]): JsonObject {
  const indexType = indexParam(index, "index_type");
  const metric = indexParam(index, "metric_type");
  return {
    indexName: index.index_name,
    fieldName: index.field_name,
    ...(indexType === undefined ? {} : { indexType }),
    ...(metric === undefined ? {} : { metricType: metric }),
    indexState: index.state,
    indexedRows: index.indexed_rows,
    totalRows: index.total_rows,
    pendingRows: index.pending_index_rows,
    ...(index.index_state_fail_reason === ""
      ? {}
      : { failReason: serverText(index.index_state_fail_reason, secretForms) }),
  };
}

/** The State part: the collection as it is now, ids as strings because they pass 2^53. */
export function stateDocument(input: MilvusSourceInput): JsonObject {
  const { describe } = input;
  const keyField = describe.schema?.fields.find((field) => field.is_partition_key);
  const listed = input.partitions.slice(0, MILVUS_PARTITIONS_LISTED);
  return {
    collectionID: describe.collectionID,
    load: input.loadState,
    ...(input.rowCount === undefined ? {} : { rowCountEstimate: input.rowCount, rowCountSource: ROW_COUNT_SOURCE }),
    ...(keyField === undefined
      ? {}
      : {
          partitionKey: { fieldName: keyField.name, partitionsNum: Number(describe.num_partitions), generated: true },
        }),
    partitions: listed.map((name) => ({ name })),
    ...(input.partitions.length > listed.length
      ? {
          partitionsListed: `the first ${listed.length.toLocaleString("en-US")} of ${input.partitions.length.toLocaleString("en-US")}`,
        }
      : {}),
    aliases: [...input.aliases],
    ...(input.indexes.length === 0
      ? {}
      : { indexes: input.indexes.map((index) => indexState(index, input.secretForms)) }),
  };
}

function part(id: string, label: string, document: JsonObject, limit: number | undefined): ObjectSourcePart {
  const bounded = applySourceBound(JSON.stringify(document, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "partial",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/** The Source's two parts, each under the caller's character bound. */
export function milvusSourceParts(
  input: MilvusSourceInput,
  limit?: number,
): readonly [ObjectSourcePart, ...ObjectSourcePart[]] {
  return [
    part("schema", "Schema", schemaDocument(input.describe, input.indexes), limit),
    part("state", "State", stateDocument(input), limit),
  ];
}
