/**
 * DescribeCollection and DescribeIndex answers in the gRPC shape `client.ts` declares, for the Milvus request and
 * result tests (vector-family spec 5.4, 5.5).
 *
 * `describedCollection(name)` reads the seeded collection's recorded REST describe answer under
 * `tests/fixtures/vector/milvus/` (PR 1v) and writes it in the wire shape: the same fields in the same order, with
 * their types, type parameters, keys, nullability and functions, and the dynamic field `$meta`, which gRPC lists
 * as a field when the schema enables it and REST leaves out. `fieldSchema` and `collectionSchema` build the
 * synthetic schemas a single test needs. Nothing here reads a live server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DescribeCollectionResponse,
  DescribeIndexResponse,
  WireCollectionSchema,
  WireFieldSchema,
  WireFunctionSchema,
  WireStatus,
} from "@/lib/db/providers/vector/milvus/client";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vector", "milvus");

export const OK_STATUS: WireStatus = {
  error_code: "Success",
  reason: "",
  code: 0,
  retriable: false,
  detail: "",
  extra_info: {},
};

export function fieldSchema(
  field: Partial<WireFieldSchema> & Pick<WireFieldSchema, "name" | "data_type">,
): WireFieldSchema {
  return {
    fieldID: "0",
    is_primary_key: false,
    description: "",
    type_params: [],
    index_params: [],
    autoID: false,
    state: "FieldCreated",
    element_type: "None",
    default_value: null,
    is_dynamic: false,
    is_partition_key: false,
    is_clustering_key: false,
    nullable: false,
    is_function_output: false,
    external_field: "",
    ...field,
  };
}

export function collectionSchema(
  name: string,
  fields: readonly WireFieldSchema[],
  extra: Partial<WireCollectionSchema> = {},
): WireCollectionSchema {
  return {
    name,
    description: "",
    autoID: false,
    fields,
    enable_dynamic_field: fields.some((field) => field.is_dynamic),
    properties: [],
    functions: [],
    dbName: "default",
    struct_array_fields: [],
    version: 0,
    ...extra,
  };
}

export function describeAnswer(schema: WireCollectionSchema): DescribeCollectionResponse {
  return {
    status: OK_STATUS,
    schema,
    collectionID: "1",
    created_timestamp: "0",
    created_utc_timestamp: "0",
    shards_num: 1,
    aliases: [],
    consistency_level: "Bounded",
    collection_name: schema.name,
    properties: [],
    db_name: schema.dbName,
    num_partitions: "1",
  };
}

interface RestField {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly primaryKey: boolean;
  readonly autoId: boolean;
  readonly nullable: boolean;
  readonly partitionKey: boolean;
  readonly isFunctionOutput?: boolean;
  readonly elementType?: string;
  readonly params?: readonly { readonly key: string; readonly value: string }[];
}

interface RestFunction {
  readonly id: number;
  readonly name: string;
  readonly type: number;
  readonly inputFieldNames: readonly string[];
  readonly outputFieldNames: readonly string[];
}

/** REST numbers a function's type; the wire names it (schema.proto FunctionType). */
const FUNCTION_TYPES = ["Unknown", "BM25", "TextEmbedding", "Rerank", "MinHash", "MolFingerprint"];

/** The seeded collection `name` of database `default`, as DescribeCollection answers it. */
export function describedCollection(name: string): DescribeCollectionResponse {
  const capture = JSON.parse(readFileSync(join(FIXTURES, `describe-default-${name}.json`), "utf8")) as {
    readonly payload: { readonly body: string };
  };
  const data = (JSON.parse(quoteUnsafeIntegers(capture.payload.body)) as { readonly data: Record<string, unknown> })
    .data;
  const fields = (data.fields as readonly RestField[]).map((field) =>
    fieldSchema({
      fieldID: String(field.id),
      name: field.name,
      data_type: field.type,
      is_primary_key: field.primaryKey,
      autoID: field.autoId,
      nullable: field.nullable,
      is_partition_key: field.partitionKey,
      is_function_output: field.isFunctionOutput === true,
      element_type: field.elementType ?? "None",
      type_params: field.params ?? [],
    }),
  );
  const dynamic = data.enableDynamicField === true;
  const functions: WireFunctionSchema[] = (data.functions as readonly RestFunction[]).map((fn) => ({
    name: fn.name,
    id: String(fn.id),
    description: "",
    type: FUNCTION_TYPES[fn.type],
    input_field_names: fn.inputFieldNames,
    input_field_ids: [],
    output_field_names: fn.outputFieldNames,
    output_field_ids: [],
    params: [],
  }));
  const schema = collectionSchema(
    name,
    dynamic ? [...fields, fieldSchema({ name: "$meta", data_type: "JSON", is_dynamic: true })] : fields,
    { enable_dynamic_field: dynamic, functions },
  );
  return describeAnswer(schema);
}

/** A DescribeIndex answer: one description per field, with its index type and metric. */
export function describedIndex(
  indexes: Readonly<Record<string, { readonly indexType: string; readonly metric: string }>>,
): DescribeIndexResponse {
  return {
    status: OK_STATUS,
    index_descriptions: Object.entries(indexes).map(([field, index]) => ({
      index_name: field,
      indexID: "1",
      params: [
        { key: "index_type", value: index.indexType },
        { key: "metric_type", value: index.metric },
        { key: "params", value: "{}" },
      ],
      field_name: field,
      indexed_rows: "0",
      total_rows: "0",
      state: "Finished",
      index_state_fail_reason: "",
      pending_index_rows: "0",
    })),
  };
}
