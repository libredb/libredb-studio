/**
 * The metadata-only answer of a Milvus agent request: the reads of each admitted route (`metadata-request.ts`), their
 * projection through `src/lib/db/redaction/metadata-only.ts`, and the wording of a failure.
 *
 * - **Metadata only.** Per route a declared list of columns, each a name, a count or a flag read from a fixed place in
 *   the server's answer, so no stored scalar, vector or dynamic field value reaches a row, a column name or a nested
 *   cell. Nor does any text the operator wrote beside the schema: a field's default value, a description, a
 *   collection's or a database's properties, an index's parameters and a function's parameters, which can name a
 *   service or a credential, are never read. What remains is the operator's own names (databases, collections, fields,
 *   partitions, indexes, aliases, functions), which a name kind admits as names. A cell that fits no declared kind
 *   withholds the whole answer.
 * - **Failures without the server's words.** A refusal is worded by its category alone, since the server's text can
 *   echo what a request carried.
 *
 * Every call names the plan's database, which the agent's reader holds to the connection's own, and the calls go one
 * after another under the caller's one signal.
 */
import { QueryError, TimeoutError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  type MetadataRows,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import {
  type CallOptions,
  type DescribeCollectionResponse,
  type DescribeIndexRequest,
  type MilvusClient,
  MilvusError,
  type WireFieldSchema,
  type WireFunctionSchema,
  type WireIndexDescription,
  type WireKeyValuePair,
} from "./client";
import type { MilvusAgentPlan } from "./metadata-request";
import { loadStateWord, statisticsRowCount } from "./monitoring";
import { indexParam } from "./schema";

/** Every client method an agent request can call: the metadata reads, and nothing that answers a stored value. */
export type MilvusAgentReadClient = Pick<
  MilvusClient,
  | "listDatabases"
  | "describeDatabase"
  | "showCollections"
  | "describeCollection"
  | "describeIndex"
  | "getLoadState"
  | "getLoadingProgress"
  | "getCollectionStatistics"
  | "showPartitions"
  | "listAliases"
  | "describeAlias"
>;

/** What an answer is projected as. */
export type MilvusProjectionId =
  | "databases"
  | "database"
  | "collections"
  | "collection"
  | "statistics"
  | "load_state"
  | "partitions"
  | "indexes"
  | "aliases"
  | "alias";

/** A 64-bit integer as Milvus sends it, a decimal string, as a number; anything else as it came, which no count fits. */
function countOf(value: unknown): unknown {
  return typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
}

/** A name Milvus answers empty for "none" (an element type of `None`, an unnamed collection) is absent. */
function present(value: string): string | undefined {
  return value === "" || value === "None" ? undefined : value;
}

const param = (pairs: readonly WireKeyValuePair[], key: string): string | undefined =>
  pairs.find((pair) => pair.key === key)?.value;

/** One row of a collection read: the collection itself, a field, a struct array, one of its fields, or a function. */
type CollectionRow =
  | {
      readonly kind: "collection";
      readonly name: string;
      readonly answer: DescribeCollectionResponse;
      readonly loadState: string;
    }
  | {
      readonly kind: "field" | "struct_field";
      readonly field: WireFieldSchema;
      readonly index: WireIndexDescription | undefined;
    }
  | { readonly kind: "struct_array"; readonly name: string }
  | { readonly kind: "function"; readonly fn: WireFunctionSchema };

const fieldOf = (row: CollectionRow, read: (field: WireFieldSchema) => unknown): unknown =>
  row.kind === "field" || row.kind === "struct_field" ? read(row.field) : undefined;
const indexOf = (row: CollectionRow, read: (index: WireIndexDescription) => unknown): unknown =>
  (row.kind === "field" || row.kind === "struct_field") && row.index !== undefined ? read(row.index) : undefined;
const collectionOf = (row: CollectionRow, read: (answer: DescribeCollectionResponse) => unknown): unknown =>
  row.kind === "collection" ? read(row.answer) : undefined;

function rowName(row: CollectionRow): string {
  switch (row.kind) {
    case "collection":
    case "struct_array":
      return row.name;
    case "field":
    case "struct_field":
      return row.field.name;
    case "function":
      return row.fn.name;
  }
}

const COLLECTION: MetadataProjection<CollectionRow> = [
  { column: "name", kind: "name", read: rowName },
  { column: "kind", kind: "name", read: (row) => row.kind },
  {
    column: "type",
    kind: "name",
    read: (row) => (row.kind === "function" ? row.fn.type : fieldOf(row, (field) => field.data_type)),
    optional: true,
  },
  {
    column: "element_type",
    kind: "name",
    read: (row) => fieldOf(row, (field) => present(field.element_type)),
    optional: true,
  },
  {
    column: "dimension",
    kind: "count",
    read: (row) => fieldOf(row, (field) => countOf(param(field.type_params, "dim"))),
    optional: true,
  },
  {
    column: "max_length",
    kind: "count",
    read: (row) => fieldOf(row, (field) => countOf(param(field.type_params, "max_length"))),
    optional: true,
  },
  { column: "primary", kind: "flag", read: (row) => fieldOf(row, (field) => field.is_primary_key), optional: true },
  { column: "nullable", kind: "flag", read: (row) => fieldOf(row, (field) => field.nullable), optional: true },
  {
    column: "dynamic",
    kind: "flag",
    read: (row) =>
      row.kind === "collection" ? row.answer.schema?.enable_dynamic_field : fieldOf(row, (field) => field.is_dynamic),
    optional: true,
  },
  {
    column: "partition_key",
    kind: "flag",
    read: (row) => fieldOf(row, (field) => field.is_partition_key),
    optional: true,
  },
  {
    column: "function_output",
    kind: "flag",
    read: (row) => fieldOf(row, (field) => field.is_function_output),
    optional: true,
  },
  { column: "index", kind: "name", read: (row) => indexOf(row, (index) => index.index_name), optional: true },
  {
    column: "index_type",
    kind: "name",
    read: (row) => indexOf(row, (index) => indexParam(index, "index_type")),
    optional: true,
  },
  {
    column: "metric",
    kind: "name",
    read: (row) => indexOf(row, (index) => indexParam(index, "metric_type")),
    optional: true,
  },
  { column: "shards", kind: "count", read: (row) => collectionOf(row, (answer) => answer.shards_num), optional: true },
  {
    column: "partitions",
    kind: "count",
    read: (row) => collectionOf(row, (answer) => countOf(answer.num_partitions)),
    optional: true,
  },
  {
    column: "consistency",
    kind: "name",
    read: (row) => collectionOf(row, (answer) => answer.consistency_level),
    optional: true,
  },
  {
    column: "load_state",
    kind: "name",
    read: (row) => (row.kind === "collection" ? row.loadState : undefined),
    optional: true,
  },
];

type Named = { readonly name: string };
type Fact = Readonly<Record<string, unknown>>;

const PROJECTIONS = {
  databases: [{ column: "database", kind: "name", read: (row: Named) => row.name }],
  database: [
    { column: "database", kind: "name", read: (row: Fact) => row.database },
    { column: "properties", kind: "count", read: (row: Fact) => row.properties },
  ],
  collections: [{ column: "collection", kind: "name", read: (row: Named) => row.name }],
  collection: COLLECTION,
  statistics: [
    { column: "collection", kind: "name", read: (row: Fact) => row.collection },
    { column: "row_count", kind: "count", read: (row: Fact) => row.rowCount },
  ],
  load_state: [
    { column: "collection", kind: "name", read: (row: Fact) => row.collection },
    { column: "load_state", kind: "name", read: (row: Fact) => row.state },
    { column: "progress", kind: "count", read: (row: Fact) => row.progress, optional: true },
  ],
  partitions: [{ column: "partition", kind: "name", read: (row: Named) => row.name }],
  indexes: [
    { column: "index", kind: "name", read: (index: WireIndexDescription) => index.index_name },
    { column: "field", kind: "name", read: (index: WireIndexDescription) => index.field_name },
    {
      column: "index_type",
      kind: "name",
      read: (index: WireIndexDescription) => indexParam(index, "index_type"),
      optional: true,
    },
    {
      column: "metric",
      kind: "name",
      read: (index: WireIndexDescription) => indexParam(index, "metric_type"),
      optional: true,
    },
    { column: "state", kind: "name", read: (index: WireIndexDescription) => index.state },
    { column: "indexed_rows", kind: "count", read: (index: WireIndexDescription) => countOf(index.indexed_rows) },
    { column: "total_rows", kind: "count", read: (index: WireIndexDescription) => countOf(index.total_rows) },
    {
      column: "pending_rows",
      kind: "count",
      read: (index: WireIndexDescription) => countOf(index.pending_index_rows),
    },
    // The reason is the server's text, which can quote a stored value: answered as whether there is one.
    { column: "failed", kind: "flag", read: (index: WireIndexDescription) => index.index_state_fail_reason !== "" },
  ],
  aliases: [
    { column: "alias", kind: "name", read: (row: Fact) => row.alias },
    { column: "collection", kind: "name", read: (row: Fact) => row.collection, optional: true },
  ],
  alias: [
    { column: "alias", kind: "name", read: (row: Fact) => row.alias },
    { column: "collection", kind: "name", read: (row: Fact) => row.collection },
    { column: "database", kind: "name", read: (row: Fact) => row.database },
  ],
} as const satisfies Record<MilvusProjectionId, MetadataProjection<never>>;

/** What `ProviderCapabilities.metadataOnly` states for Milvus, derived from the projections themselves. */
export const MILVUS_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

const INDEX_NOT_EXIST = 700;
const named = (names: readonly string[]): Named[] => names.map((name) => ({ name }));

/** A collection's indexes; with `absentIsNone`, a collection with no index answers none. */
async function indexes(
  client: MilvusAgentReadClient,
  request: DescribeIndexRequest,
  call: CallOptions,
  absentIsNone: boolean,
): Promise<readonly WireIndexDescription[]> {
  try {
    return (await client.describeIndex(request, call)).index_descriptions;
  } catch (error) {
    if (absentIsNone && error instanceof MilvusError && error.status?.code === INDEX_NOT_EXIST) return [];
    throw error;
  }
}

/** A collection's own row, its fields, its struct arrays and their fields, then its functions, in the answer's order. */
async function collectionRows(
  client: MilvusAgentReadClient,
  collection: string,
  call: CallOptions,
): Promise<CollectionRow[]> {
  const request = { collection_name: collection };
  const answer = await client.describeCollection(request, call);
  const described = await indexes(client, request, call, true);
  const state = await client.getLoadState(request, call);
  const indexFor = (field: WireFieldSchema) => described.find((index) => index.field_name === field.name);
  const schema = answer.schema;
  return [
    { kind: "collection", name: collection, answer, loadState: loadStateWord(state.state) },
    ...(schema?.fields ?? []).map((field): CollectionRow => ({ kind: "field", field, index: indexFor(field) })),
    ...(schema?.struct_array_fields ?? []).flatMap((struct) =>
      [{ kind: "struct_array", name: struct.name } as CollectionRow].concat(
        struct.fields.map((field): CollectionRow => ({ kind: "struct_field", field, index: indexFor(field) })),
      ),
    ),
    ...(schema?.functions ?? []).map((fn): CollectionRow => ({ kind: "function", fn })),
  ];
}

/** The route's reads, one after another, as the sources of its projection. */
async function sourcesOf(
  client: MilvusAgentReadClient,
  plan: MilvusAgentPlan,
  call: CallOptions,
): Promise<{ readonly id: MilvusProjectionId; readonly sources: readonly unknown[] }> {
  switch (plan.op) {
    case "databases/list":
      return { id: "databases", sources: named((await client.listDatabases(call)).db_names) };
    case "databases/describe": {
      const answer = await client.describeDatabase({}, call);
      return { id: "database", sources: [{ database: answer.db_name, properties: answer.properties.length }] };
    }
    case "collections/list":
      return { id: "collections", sources: named((await client.showCollections(call)).collection_names) };
    case "collections/describe":
      return { id: "collection", sources: await collectionRows(client, plan.collection, call) };
    case "collections/get_stats": {
      const answer = await client.getCollectionStatistics({ collection_name: plan.collection }, call);
      return {
        id: "statistics",
        sources: [{ collection: plan.collection, rowCount: countOf(statisticsRowCount(answer.stats)) }],
      };
    }
    case "collections/get_load_state": {
      const request = {
        collection_name: plan.collection,
        ...(plan.partitionNames.length === 0 ? {} : { partition_names: plan.partitionNames }),
      };
      const state = (await client.getLoadState(request, call)).state;
      // Milvus answers a progress only where a load exists; asked of an unloaded collection it refuses.
      const loading = state === "LoadStateLoading" || state === "LoadStateLoaded";
      const progress = loading ? countOf((await client.getLoadingProgress(request, call)).progress) : undefined;
      return { id: "load_state", sources: [{ collection: plan.collection, state: loadStateWord(state), progress }] };
    }
    case "partitions/list": {
      const answer = await client.showPartitions({ collection_name: plan.collection }, call);
      return { id: "partitions", sources: named(answer.partition_names) };
    }
    case "indexes/list":
      return { id: "indexes", sources: await indexes(client, { collection_name: plan.collection }, call, true) };
    case "indexes/describe":
      return {
        id: "indexes",
        sources: await indexes(client, { collection_name: plan.collection, index_name: plan.indexName }, call, false),
      };
    case "aliases/list": {
      const answer = await client.listAliases(
        plan.collection === undefined ? {} : { collection_name: plan.collection },
        call,
      );
      const collection = present(answer.collection_name);
      return { id: "aliases", sources: answer.aliases.map((alias) => ({ alias, collection })) };
    }
    case "aliases/describe": {
      const answer = await client.describeAlias({ alias: plan.alias }, call);
      return {
        id: "alias",
        sources: [{ alias: answer.alias, collection: answer.collection, database: answer.db_name }],
      };
    }
  }
}

/**
 * The metadata of one admitted request: its reads under `call`, which names the plan's database, and their
 * projection. A cell that fits no declared kind withholds the whole answer; a failed read is raised as the client's.
 */
export async function readMilvusMetadata(
  client: MilvusAgentReadClient,
  plan: MilvusAgentPlan,
  call: CallOptions,
): Promise<MetadataRows> {
  const { id, sources } = await sourcesOf(client, plan, { db: plan.db, signal: call.signal });
  try {
    return projectMetadata(PROJECTIONS[id] as MetadataProjection<unknown>, sources);
  } catch (error) {
    throw error instanceof MetadataProjectionError ? new QueryError(error.message, "milvus") : error;
  }
}

/** The answer as rows, refused past the row or byte budget rather than cut. */
export function milvusAgentResult(
  projected: MetadataRows,
  budget: ReadOnlyStatementBudget,
  statement: string,
  executionTime: number,
): QueryResult {
  if (projected.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(projected.rows.length, budget.maxResultRows), "milvus", statement);
  }
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "milvus", statement);
  }
  return { fields: projected.fields, rows: projected.rows, rowCount: projected.rows.length, executionTime };
}

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is. A failed call is worded by
 * its category alone, never the server's words; a deadline is the time budget's refusal.
 */
export function milvusAgentFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if ((error instanceof MilvusError && error.category === "deadline-exceeded") || error instanceof TimeoutError) {
    return new QueryError(
      `${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`,
      "milvus",
      statement,
    );
  }
  if (error instanceof MilvusError) {
    return new QueryError(
      `${error.message}. The server's own words are not passed on to agent mode, whose answers carry metadata only.`,
      "milvus",
      statement,
    );
  }
  return undefined;
}
