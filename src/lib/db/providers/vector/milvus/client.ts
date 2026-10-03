/**
 * The Milvus provider's I/O-free seam (vector-family spec 5.1, 5.11, E15).
 *
 * Every module above this line depends on `MilvusClient`, never on the gRPC library: `grpc-client.ts` is the one
 * implementation, and tests implement the interface over a recorded wire. The interface holds E15's allowlist and
 * nothing else, so a method that is not declared here cannot be called by provider logic, and each consumer takes a
 * `Pick<MilvusClient, K>` naming exactly the methods it calls.
 *
 * The wire types mirror the descriptor as `MILVUS_LOADER_OPTIONS` decodes it: the field names the `.proto` files
 * spell, 64-bit integers as decimal strings, enums by name, bytes as `Uint8Array` (a `Buffer` on decode), an absent
 * message field as `null`, and each oneof's name as a virtual field naming the member that is set.
 * tests/unit/db/milvus/wire-fields.test.ts holds every property to the descriptor. A request type is
 * `Omit<Wire..., "db_name">`: the database has one source, `CallOptions.db`, which the adapter writes into every
 * request that carries the field (E16). A request type declares only what Studio may send, so a function score, a
 * function chain, a search aggregation, a highlighter, a namespace, a replica count or a refresh load cannot be
 * written at all (E11, E34).
 *
 * tsconfig targets ES2017, where a bigint literal is error TS2737, so no 64-bit value here is a bigint.
 */

/** 64-bit integers travel as decimal strings (`longs: String`). */
export type MilvusInt64 = string;

// -- common.proto --------------------------------------------------------------------------------------------------

export interface WireStatus {
  /** The `ErrorCode` enum by name; success is `code == 0` with `"Success"` here (E20). */
  readonly error_code: string;
  readonly reason: string;
  readonly code: number;
  readonly retriable: boolean;
  readonly detail: string;
  readonly extra_info: Readonly<Record<string, string>>;
}

export interface WireKeyValuePair {
  readonly key: string;
  readonly value: string;
}

// -- schema.proto: arrays ------------------------------------------------------------------------------------------

export interface WireBoolArray {
  readonly data: readonly boolean[];
}
export interface WireIntArray {
  readonly data: readonly number[];
}
export interface WireLongArray {
  readonly data: readonly MilvusInt64[];
}
export interface WireFloatArray {
  readonly data: readonly number[];
}
export interface WireDoubleArray {
  readonly data: readonly number[];
}
export interface WireStringArray {
  readonly data: readonly string[];
}
export interface WireBytesArray {
  readonly data: readonly Uint8Array[];
}
export interface WireJSONArray {
  readonly data: readonly Uint8Array[];
}
export interface WireGeometryArray {
  readonly data: readonly Uint8Array[];
}
export interface WireGeometryWktArray {
  readonly data: readonly string[];
}
export interface WireTimestamptzArray {
  readonly data: readonly MilvusInt64[];
}
export interface WireDateArray {
  readonly data: readonly number[];
}
export interface WireTimeArray {
  readonly data: readonly MilvusInt64[];
}
export interface WireMolArray {
  readonly data: readonly Uint8Array[];
}
export interface WireMolSmilesArray {
  readonly data: readonly string[];
}
export interface WireArrayArray {
  readonly data: readonly WireScalarField[];
  readonly element_type: string;
}
export interface WireSparseFloatArray {
  /** Each row as little-endian pairs of a uint32 index and a float32 value. */
  readonly contents: readonly Uint8Array[];
  readonly dim: MilvusInt64;
}

// -- schema.proto: field data --------------------------------------------------------------------------------------

/** Exactly one arm is set, which the virtual `data` names. */
export interface WireScalarField {
  readonly bool_data: WireBoolArray | null;
  readonly int_data: WireIntArray | null;
  readonly long_data: WireLongArray | null;
  readonly float_data: WireFloatArray | null;
  readonly double_data: WireDoubleArray | null;
  readonly string_data: WireStringArray | null;
  readonly bytes_data: WireBytesArray | null;
  readonly array_data: WireArrayArray | null;
  readonly json_data: WireJSONArray | null;
  readonly geometry_data: WireGeometryArray | null;
  readonly timestamptz_data: WireTimestamptzArray | null;
  readonly geometry_wkt_data: WireGeometryWktArray | null;
  readonly mol_data: WireMolArray | null;
  readonly mol_smiles_data: WireMolSmilesArray | null;
  readonly date_data: WireDateArray | null;
  readonly time_data: WireTimeArray | null;
  readonly data?: string;
}

/** Exactly one arm is set, which the virtual `data` names. */
export interface WireVectorField {
  readonly dim: MilvusInt64;
  readonly float_vector: WireFloatArray | null;
  readonly binary_vector: Uint8Array;
  readonly float16_vector: Uint8Array;
  readonly bfloat16_vector: Uint8Array;
  readonly sparse_float_vector: WireSparseFloatArray | null;
  readonly int8_vector: Uint8Array;
  readonly vector_array: WireVectorArray | null;
  readonly data?: string;
}

export interface WireVectorArray {
  readonly dim: MilvusInt64;
  readonly data: readonly WireVectorField[];
  readonly element_type: string;
}

export interface WireStructArrayField {
  readonly fields: readonly WireFieldData[];
}

/** One column of a query or search answer; `field` names the arm that is set. */
export interface WireFieldData {
  readonly type: string;
  readonly field_name: string;
  readonly scalars: WireScalarField | null;
  readonly vectors: WireVectorField | null;
  readonly struct_arrays: WireStructArrayField | null;
  readonly field_id: MilvusInt64;
  readonly is_dynamic: boolean;
  readonly valid_data: readonly boolean[];
  readonly field?: string;
}

export interface WireIDs {
  readonly int_id?: WireLongArray | null;
  readonly str_id?: WireStringArray | null;
  readonly id_field?: string;
}

export interface WireSearchResultData {
  readonly num_queries: MilvusInt64;
  readonly top_k: MilvusInt64;
  readonly fields_data: readonly WireFieldData[];
  /** float32 on the wire: a value past its range arrives as Infinity, which no JSON can carry (3.3). */
  readonly scores: readonly number[];
  readonly ids: WireIDs | null;
  readonly topks: readonly MilvusInt64[];
  readonly output_fields: readonly string[];
  readonly group_by_field_value: WireFieldData | null;
  readonly all_search_count: MilvusInt64;
  readonly distances: readonly number[];
  readonly recalls: readonly number[];
  readonly primary_field_name: string;
  readonly element_indices: WireLongArray | null;
  readonly group_by_field_values: readonly WireFieldData[];
}

// -- schema.proto: schema ------------------------------------------------------------------------------------------

/** A default value; the provider never sets `ColumnSchema.defaultValue` from it (E17). */
export interface WireValueField {
  readonly bool_data?: boolean;
  readonly int_data?: number;
  readonly long_data?: MilvusInt64;
  readonly float_data?: number;
  readonly double_data?: number;
  readonly string_data?: string;
  readonly bytes_data?: Uint8Array;
  readonly timestamptz_data?: MilvusInt64;
  readonly date_data?: number;
  readonly time_data?: MilvusInt64;
  readonly data?: string;
}

export interface WireFieldSchema {
  readonly fieldID: MilvusInt64;
  readonly name: string;
  readonly is_primary_key: boolean;
  readonly description: string;
  readonly data_type: string;
  readonly type_params: readonly WireKeyValuePair[];
  readonly index_params: readonly WireKeyValuePair[];
  readonly autoID: boolean;
  readonly state: string;
  readonly element_type: string;
  readonly default_value: WireValueField | null;
  readonly is_dynamic: boolean;
  readonly is_partition_key: boolean;
  readonly is_clustering_key: boolean;
  readonly nullable: boolean;
  readonly is_function_output: boolean;
  readonly external_field: string;
}

/** Function parameters may carry a credential label or a service URL; they stay out of every model surface (E17). */
export interface WireFunctionSchema {
  readonly name: string;
  readonly id: MilvusInt64;
  readonly description: string;
  readonly type: string;
  readonly input_field_names: readonly string[];
  readonly input_field_ids: readonly MilvusInt64[];
  readonly output_field_names: readonly string[];
  readonly output_field_ids: readonly MilvusInt64[];
  readonly params: readonly WireKeyValuePair[];
}

export interface WireStructArrayFieldSchema {
  readonly fieldID: MilvusInt64;
  readonly name: string;
  readonly description: string;
  readonly fields: readonly WireFieldSchema[];
  readonly type_params: readonly WireKeyValuePair[];
  readonly nullable: boolean;
}

export interface WireCollectionSchema {
  readonly name: string;
  readonly description: string;
  readonly autoID: boolean;
  readonly fields: readonly WireFieldSchema[];
  readonly enable_dynamic_field: boolean;
  readonly properties: readonly WireKeyValuePair[];
  readonly functions: readonly WireFunctionSchema[];
  readonly dbName: string;
  readonly struct_array_fields: readonly WireStructArrayFieldSchema[];
  readonly version: number;
}

// -- schema.proto: expression templates (requests) ------------------------------------------------------------------

/** One template value; an integer is `int64_val` built from validated digits, never a JS number (E12, VF6). */
export interface WireTemplateValue {
  readonly bool_val?: boolean;
  readonly int64_val?: MilvusInt64;
  readonly float_val?: number;
  readonly string_val?: string;
  readonly array_val?: WireTemplateArrayValue;
}

export interface WireTemplateArrayValue {
  readonly bool_data?: WireBoolArray;
  readonly long_data?: WireLongArray;
  readonly double_data?: WireDoubleArray;
  readonly string_data?: WireStringArray;
  readonly array_data?: WireTemplateArrayValueArray;
}

export interface WireTemplateArrayValueArray {
  readonly data: readonly WireTemplateArrayValue[];
}

// -- milvus.proto: requests (as sent; the adapter adds db_name) ----------------------------------------------------

export interface WireDescribeDatabaseRequest {
  readonly db_name: string;
}
export interface WireShowCollectionsRequest {
  readonly db_name: string;
}
export interface WireDescribeCollectionRequest {
  readonly db_name: string;
  readonly collection_name: string;
}
export interface WireBatchDescribeCollectionRequest {
  readonly db_name: string;
  readonly collection_name: readonly string[];
}
export interface WireDescribeIndexRequest {
  readonly db_name: string;
  readonly collection_name: string;
  readonly field_name?: string;
  readonly index_name?: string;
}
export interface WireGetLoadStateRequest {
  readonly db_name: string;
  readonly collection_name: string;
  readonly partition_names?: readonly string[];
}
export interface WireGetLoadingProgressRequest {
  readonly db_name: string;
  readonly collection_name: string;
  readonly partition_names?: readonly string[];
}
export interface WireGetCollectionStatisticsRequest {
  readonly db_name: string;
  readonly collection_name: string;
}
export interface WireShowPartitionsRequest {
  readonly db_name: string;
  readonly collection_name: string;
}
export interface WireListAliasesRequest {
  readonly db_name: string;
  readonly collection_name?: string;
}
export interface WireDescribeAliasRequest {
  readonly db_name: string;
  readonly alias: string;
}
export interface WireQueryRequest {
  readonly db_name: string;
  readonly collection_name: string;
  readonly expr: string;
  readonly output_fields: readonly string[];
  readonly partition_names?: readonly string[];
  readonly guarantee_timestamp?: MilvusInt64;
  readonly query_params: readonly WireKeyValuePair[];
  readonly consistency_level?: string;
  readonly use_default_consistency?: boolean;
  readonly expr_template_values?: Readonly<Record<string, WireTemplateValue>>;
}
/** `placeholder_group` or `ids`, never both: the oneof `search_input`. */
export interface WireSearchRequest {
  readonly db_name: string;
  readonly collection_name: string;
  readonly partition_names?: readonly string[];
  readonly dsl: string;
  readonly dsl_type: "BoolExprV1";
  readonly placeholder_group?: Uint8Array;
  readonly ids?: WireIDs;
  readonly output_fields: readonly string[];
  readonly search_params: readonly WireKeyValuePair[];
  readonly nq: MilvusInt64;
  readonly consistency_level?: string;
  readonly use_default_consistency?: boolean;
  readonly expr_template_values?: Readonly<Record<string, WireTemplateValue>>;
}
/** Each sub-request is a SearchRequest without its own database (E16). */
export interface WireHybridSearchRequest {
  readonly db_name: string;
  readonly collection_name: string;
  readonly partition_names?: readonly string[];
  readonly requests: readonly Omit<WireSearchRequest, "db_name">[];
  readonly rank_params: readonly WireKeyValuePair[];
  readonly output_fields: readonly string[];
  readonly consistency_level?: string;
  readonly use_default_consistency?: boolean;
}
/** No replica count, resource group, refresh or load parameter: replicas stay the server default (E27). */
export interface WireLoadCollectionRequest {
  readonly db_name: string;
  readonly collection_name: string;
}
export interface WireReleaseCollectionRequest {
  readonly db_name: string;
  readonly collection_name: string;
}

// -- milvus.proto: answers -----------------------------------------------------------------------------------------

export interface WireGetVersionResponse {
  readonly status: WireStatus | null;
  readonly version: string;
}
export interface WireCheckHealthResponse {
  readonly status: WireStatus | null;
  readonly isHealthy: boolean;
  readonly reasons: readonly string[];
  readonly quota_states: readonly string[];
}
/** `response` is the JSON text of the fixed system_info request; monitoring parses it (E29). */
export interface WireGetMetricsResponse {
  readonly status: WireStatus | null;
  readonly response: string;
  readonly component_name: string;
}
export interface WireListDatabasesResponse {
  readonly status: WireStatus | null;
  readonly db_names: readonly string[];
  readonly created_timestamp: readonly MilvusInt64[];
  readonly db_ids: readonly MilvusInt64[];
}
export interface WireDescribeDatabaseResponse {
  readonly status: WireStatus | null;
  readonly db_name: string;
  readonly dbID: MilvusInt64;
  readonly created_timestamp: MilvusInt64;
  readonly properties: readonly WireKeyValuePair[];
}
export interface WireShowCollectionsResponse {
  readonly status: WireStatus | null;
  readonly collection_names: readonly string[];
  readonly collection_ids: readonly MilvusInt64[];
  readonly created_timestamps: readonly MilvusInt64[];
  readonly created_utc_timestamps: readonly MilvusInt64[];
  readonly inMemory_percentages: readonly MilvusInt64[];
  readonly query_service_available: readonly boolean[];
  readonly shards_num: readonly number[];
}
export interface WireDescribeCollectionResponse {
  readonly status: WireStatus | null;
  readonly schema: WireCollectionSchema | null;
  readonly collectionID: MilvusInt64;
  readonly created_timestamp: MilvusInt64;
  readonly created_utc_timestamp: MilvusInt64;
  readonly shards_num: number;
  readonly aliases: readonly string[];
  readonly consistency_level: string;
  readonly collection_name: string;
  readonly properties: readonly WireKeyValuePair[];
  readonly db_name: string;
  readonly num_partitions: MilvusInt64;
}
/** Each entry carries its own status, read by position (M7); the adapter checks the outer one only. */
export interface WireBatchDescribeCollectionResponse {
  readonly status: WireStatus | null;
  readonly responses: readonly WireDescribeCollectionResponse[];
}
export interface WireIndexDescription {
  readonly index_name: string;
  readonly indexID: MilvusInt64;
  readonly params: readonly WireKeyValuePair[];
  readonly field_name: string;
  readonly indexed_rows: MilvusInt64;
  readonly total_rows: MilvusInt64;
  readonly state: string;
  readonly index_state_fail_reason: string;
  readonly pending_index_rows: MilvusInt64;
}
export interface WireDescribeIndexResponse {
  readonly status: WireStatus | null;
  readonly index_descriptions: readonly WireIndexDescription[];
}
export interface WireGetLoadStateResponse {
  readonly status: WireStatus | null;
  /** `LoadStateNotExist`, `LoadStateNotLoad`, `LoadStateLoading` or `LoadStateLoaded`. */
  readonly state: string;
}
export interface WireGetLoadingProgressResponse {
  readonly status: WireStatus | null;
  readonly progress: MilvusInt64;
  readonly refresh_progress: MilvusInt64;
}
export interface WireGetCollectionStatisticsResponse {
  readonly status: WireStatus | null;
  readonly stats: readonly WireKeyValuePair[];
}
export interface WireShowPartitionsResponse {
  readonly status: WireStatus | null;
  readonly partition_names: readonly string[];
  readonly partitionIDs: readonly MilvusInt64[];
  readonly created_timestamps: readonly MilvusInt64[];
  readonly created_utc_timestamps: readonly MilvusInt64[];
  readonly inMemory_percentages: readonly MilvusInt64[];
}
export interface WireListAliasesResponse {
  readonly status: WireStatus | null;
  readonly db_name: string;
  readonly collection_name: string;
  readonly aliases: readonly string[];
}
export interface WireDescribeAliasResponse {
  readonly status: WireStatus | null;
  readonly db_name: string;
  readonly alias: string;
  readonly collection: string;
}
/** Columns come in a different order on every call: rows are keyed by field name, never position (R09 F23). */
export interface WireQueryResults {
  readonly status: WireStatus | null;
  readonly fields_data: readonly WireFieldData[];
  readonly collection_name: string;
  readonly output_fields: readonly string[];
  readonly session_ts: MilvusInt64;
  readonly primary_field_name: string;
}
export interface WireSearchResults {
  readonly status: WireStatus | null;
  readonly results: WireSearchResultData | null;
  readonly collection_name: string;
  readonly session_ts: MilvusInt64;
}

// -- the public names the seam uses ---------------------------------------------------------------------------------

export type Status = WireStatus;
export type DescribeDatabaseRequest = Omit<WireDescribeDatabaseRequest, "db_name">;
export type DescribeCollectionRequest = Omit<WireDescribeCollectionRequest, "db_name">;
export type BatchDescribeCollectionRequest = Omit<WireBatchDescribeCollectionRequest, "db_name">;
export type DescribeIndexRequest = Omit<WireDescribeIndexRequest, "db_name">;
export type GetLoadStateRequest = Omit<WireGetLoadStateRequest, "db_name">;
export type GetLoadingProgressRequest = Omit<WireGetLoadingProgressRequest, "db_name">;
export type GetCollectionStatisticsRequest = Omit<WireGetCollectionStatisticsRequest, "db_name">;
export type ShowPartitionsRequest = Omit<WireShowPartitionsRequest, "db_name">;
export type ListAliasesRequest = Omit<WireListAliasesRequest, "db_name">;
export type DescribeAliasRequest = Omit<WireDescribeAliasRequest, "db_name">;
export type QueryRequest = Omit<WireQueryRequest, "db_name">;
export type SearchRequest = Omit<WireSearchRequest, "db_name">;
export type HybridSearchRequest = Omit<WireHybridSearchRequest, "db_name">;
export type LoadCollectionRequest = Omit<WireLoadCollectionRequest, "db_name">;
export type ReleaseCollectionRequest = Omit<WireReleaseCollectionRequest, "db_name">;
export type GetVersionResponse = WireGetVersionResponse;
export type CheckHealthResponse = WireCheckHealthResponse;
export type GetMetricsResponse = WireGetMetricsResponse;
export type ListDatabasesResponse = WireListDatabasesResponse;
export type DescribeDatabaseResponse = WireDescribeDatabaseResponse;
export type ShowCollectionsResponse = WireShowCollectionsResponse;
export type DescribeCollectionResponse = WireDescribeCollectionResponse;
export type BatchDescribeCollectionResponse = WireBatchDescribeCollectionResponse;
export type DescribeIndexResponse = WireDescribeIndexResponse;
export type GetLoadStateResponse = WireGetLoadStateResponse;
export type GetLoadingProgressResponse = WireGetLoadingProgressResponse;
export type GetCollectionStatisticsResponse = WireGetCollectionStatisticsResponse;
export type ShowPartitionsResponse = WireShowPartitionsResponse;
export type ListAliasesResponse = WireListAliasesResponse;
export type DescribeAliasResponse = WireDescribeAliasResponse;
export type QueryResults = WireQueryResults;
export type SearchResults = WireSearchResults;

/** The adapter adds the deadline per method class (E14) and the authorization metadata. */
export interface CallOptions {
  /** Written into the request's `db_name` by the adapter, never sent as metadata or kept as state (E16). */
  readonly db: string;
  /** Aborting it is `call.cancel()`; a `TimeoutError` reason reads as a deadline, any other as a cancel. */
  readonly signal: AbortSignal;
}

/** E15's allowlist plus `close()`, and nothing else. */
export interface MilvusClient {
  getVersion(o: CallOptions): Promise<GetVersionResponse>;
  checkHealth(o: CallOptions): Promise<CheckHealthResponse>;
  /** The adapter writes the fixed `{"metric_type": "system_info"}` request (E29). */
  getMetricsSystemInfo(o: CallOptions): Promise<GetMetricsResponse>;
  listDatabases(o: CallOptions): Promise<ListDatabasesResponse>;
  describeDatabase(r: DescribeDatabaseRequest, o: CallOptions): Promise<DescribeDatabaseResponse>;
  showCollections(o: CallOptions): Promise<ShowCollectionsResponse>;
  describeCollection(r: DescribeCollectionRequest, o: CallOptions): Promise<DescribeCollectionResponse>;
  /** objects.ts only. */
  batchDescribeCollection(r: BatchDescribeCollectionRequest, o: CallOptions): Promise<BatchDescribeCollectionResponse>;
  describeIndex(r: DescribeIndexRequest, o: CallOptions): Promise<DescribeIndexResponse>;
  getLoadState(r: GetLoadStateRequest, o: CallOptions): Promise<GetLoadStateResponse>;
  getLoadingProgress(r: GetLoadingProgressRequest, o: CallOptions): Promise<GetLoadingProgressResponse>;
  getCollectionStatistics(r: GetCollectionStatisticsRequest, o: CallOptions): Promise<GetCollectionStatisticsResponse>;
  showPartitions(r: ShowPartitionsRequest, o: CallOptions): Promise<ShowPartitionsResponse>;
  listAliases(r: ListAliasesRequest, o: CallOptions): Promise<ListAliasesResponse>;
  describeAlias(r: DescribeAliasRequest, o: CallOptions): Promise<DescribeAliasResponse>;
  query(r: QueryRequest, o: CallOptions): Promise<QueryResults>;
  search(r: SearchRequest, o: CallOptions): Promise<SearchResults>;
  hybridSearch(r: HybridSearchRequest, o: CallOptions): Promise<SearchResults>;
  /** maintenance.ts only. */
  loadCollection(r: LoadCollectionRequest, o: CallOptions): Promise<Status>;
  /** maintenance.ts only. */
  releaseCollection(r: ReleaseCollectionRequest, o: CallOptions): Promise<Status>;
  /** Closes the channel; later calls reject with the `closed` category and send nothing. */
  close(): void;
}

/** Every method of `MilvusClient`, in E15's order; the compiler holds it complete. */
export const MILVUS_CLIENT_METHODS = [
  "getVersion",
  "checkHealth",
  "getMetricsSystemInfo",
  "listDatabases",
  "describeDatabase",
  "showCollections",
  "describeCollection",
  "batchDescribeCollection",
  "describeIndex",
  "getLoadState",
  "getLoadingProgress",
  "getCollectionStatistics",
  "showPartitions",
  "listAliases",
  "describeAlias",
  "query",
  "search",
  "hybridSearch",
  "loadCollection",
  "releaseCollection",
  "close",
] as const satisfies readonly (keyof MilvusClient)[];

/** Fails to compile when `MilvusClient` gains a method the list above does not name. */
type UnlistedMethod = Exclude<keyof MilvusClient, (typeof MILVUS_CLIENT_METHODS)[number]>;
const everyMethodListed: [UnlistedMethod] extends [never] ? true : UnlistedMethod = true;
void everyMethodListed;

export type MilvusErrorCategory =
  | "not-connected" // the request never left: no connection, a refused socket, a name that does not resolve, a deadline before the pick
  | "unavailable" // UNAVAILABLE after the request may have left
  | "connection-dropped" // UNAVAILABLE "Connection dropped": the keepalive found a silently dropped connection (R41 M6)
  | "ping-goaway" // RESOURCE_EXHAUSTED "Bandwidth exhausted or memory limit exceeded": a too_many_pings GOAWAY (R41 F5)
  | "transport" // a ServiceError whose code is not a number (R41 F12)
  | "tls" // a handshake or verification failure
  | "unauthenticated" // gRPC 16
  | "permission-denied" // gRPC 7
  | "unimplemented" // gRPC 12: not supported by this server version
  | "receive-cap" // the client's receive cap, on the wire or inflated
  | "deadline-exceeded" // gRPC 4, an unrequested CANCELLED, a common.Status 10001 "context deadline exceeded", or the call's own timeout
  | "cancelled" // the call's own signal aborted it (cancelQuery)
  | "status" // a common.Status that is not success
  | "malformed" // an answer with no status
  | "closed" // the client or channel closed
  | "unknown";

/** Which part of a TLS connection failed, when the runtime said so (E6). Only on the `tls` category. */
export type MilvusTlsFailure =
  | "chain"
  | "name"
  | "not-tls"
  | "client-certificate-required"
  | "client-certificate-refused"
  | "client-certificate-expired";

export interface MilvusErrorExtra {
  readonly grpcCode?: number;
  readonly status?: { readonly code: number; readonly errorCode: string };
  readonly tlsFailure?: MilvusTlsFailure;
}

/**
 * A failure as the adapter classified it. The message is fixed text: the server's or the runtime's own words are in
 * `detail`, which only `toProviderError` reads, after `serverText` (VF9), so an error that escapes unmapped shows none.
 */
export class MilvusError extends Error {
  // Declared, never defined as fields, so an absent property stays absent under every class-field semantics.
  declare readonly category: MilvusErrorCategory;
  declare readonly detail: string;
  declare readonly grpcCode?: number;
  declare readonly status?: { readonly code: number; readonly errorCode: string };
  declare readonly tlsFailure?: MilvusTlsFailure;
  constructor(category: MilvusErrorCategory, detail: string, extra: MilvusErrorExtra = {}) {
    if (extra.tlsFailure !== undefined && category !== "tls") {
      throw new TypeError(`A MilvusError of category ${category} cannot carry a TLS failure`);
    }
    super(`The Milvus client failed (${category})`);
    this.name = "MilvusError";
    this.category = category;
    this.detail = detail;
    if (extra.grpcCode !== undefined) this.grpcCode = extra.grpcCode;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.tlsFailure !== undefined) this.tlsFailure = extra.tlsFailure;
  }
}

/** Builds the one client of a provider instance; injected, so tests pass a recorded wire (3.13). */
export type MilvusClientFactory<TOptions> = (options: TOptions) => Promise<MilvusClient>;
