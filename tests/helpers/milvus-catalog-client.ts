/**
 * A fake `MilvusClient` over an in-memory catalog, for the Milvus provider's surfaces. It answers each allowlisted
 * method from the catalog as the adapter hands Milvus 3.0.2's answers on, raises a failed `common.Status` as the
 * adapter's `MilvusError` (800 for an unknown database, 100 for an unknown collection,
 * 700 for a collection with no index), and records every call as `{ method, args: [db, request] }`, or
 * `{ method, args: [db] }` for a method that takes no request, the shape `expectCalls` reads. It counts the calls in
 * flight, can hold a method's calls until a test releases them, and answers through a hook a test installs. A held or
 * waiting call whose signal aborts rejects as the adapter does, through `toMilvusError`.
 *
 * A query answers no column and a search no hit unless a test installs a hook: what a result holds is tested where
 * results are built. The real adapter over a recorded wire runs in tests/integration/db/milvus-provider.test.ts.
 */
import {
  type CallOptions,
  type DescribeCollectionResponse,
  type MilvusClient,
  MilvusError,
  type SearchResults,
  type WireFieldSchema,
  type WireFunctionSchema,
  type WireIndexDescription,
  type WireKeyValuePair,
  type WireStatus,
} from "@/lib/db/providers/vector/milvus/client";
import { type MilvusErrorConnection, toMilvusError } from "@/lib/db/providers/vector/milvus/errors";
import type { MilvusSurfaceContext } from "@/lib/db/providers/vector/milvus/objects";
import { engineLimiter } from "@/lib/db/utils/bounded-limiter";
import type { LoggedCall } from "./call-log";

export const OK: WireStatus = {
  code: 0,
  error_code: "Success",
  reason: "",
  retriable: false,
  detail: "",
  extra_info: {},
};

/** A failed common.Status, as the adapter raises it (errors.ts `statusFailure`). */
export function failedStatus(code: number, errorCode: string, reason: string): MilvusError {
  return new MilvusError("status", reason, { status: { code, errorCode } });
}

/** A gRPC 7, as the adapter raises it. */
export function permissionDenied(privilege: string): MilvusError {
  return new MilvusError("permission-denied", `PrivilegeNot${privilege}: permission deny`, { grpcCode: 7 });
}

/** A gRPC 12, as the adapter raises it. */
export function unimplemented(rpc: string): MilvusError {
  return new MilvusError("unimplemented", `unknown method ${rpc} for service milvus.proto.milvus.MilvusService`, {
    grpcCode: 12,
  });
}

export const kv = (key: string, value: string): WireKeyValuePair => ({ key, value });

/** A field as DescribeCollection carries it, with every proto default. */
export function wireField(name: string, dataType: string, extra: Partial<WireFieldSchema> = {}): WireFieldSchema {
  return {
    fieldID: "100",
    name,
    is_primary_key: false,
    description: "",
    data_type: dataType,
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
    ...extra,
  };
}

export interface CollectionSpec {
  readonly name: string;
  readonly fields: readonly WireFieldSchema[];
  readonly functions?: readonly WireFunctionSchema[];
  readonly autoID?: boolean;
  readonly dynamic?: boolean;
  readonly collectionID?: string;
  readonly aliases?: readonly string[];
  readonly numPartitions?: string;
}

/** A DescribeCollection answer, as the adapter hands it on. */
export function describeAnswer(spec: CollectionSpec, database = "default"): DescribeCollectionResponse {
  return {
    status: OK,
    schema: {
      name: spec.name,
      description: "",
      autoID: spec.autoID ?? false,
      fields: spec.fields,
      enable_dynamic_field: spec.dynamic ?? false,
      properties: [],
      functions: spec.functions ?? [],
      dbName: database,
      struct_array_fields: [],
      version: 0,
    },
    collectionID: spec.collectionID ?? "469489107428444006",
    created_timestamp: "0",
    created_utc_timestamp: "0",
    shards_num: 1,
    aliases: spec.aliases ?? [],
    consistency_level: "Bounded",
    collection_name: spec.name,
    properties: [],
    db_name: database,
    num_partitions: spec.numPartitions ?? "1",
  };
}

/** A collection with an Int64 key `id` and one FloatVector `vec` of dimension 4. */
export function plainCollection(name: string, database = "default"): DescribeCollectionResponse {
  return describeAnswer(
    {
      name,
      fields: [
        wireField("id", "Int64", { fieldID: "100", is_primary_key: true }),
        wireField("vec", "FloatVector", { fieldID: "101", type_params: [kv("dim", "4")] }),
      ],
    },
    database,
  );
}

/** One DescribeIndex entry, as the adapter hands it on. */
export function wireIndex(
  fieldName: string,
  indexType: string,
  metric: string,
  extra: Partial<WireIndexDescription> = {},
): WireIndexDescription {
  return {
    index_name: fieldName,
    indexID: "1",
    params: [kv("metric_type", metric), kv("index_type", indexType)],
    field_name: fieldName,
    indexed_rows: "0",
    total_rows: "0",
    state: "Finished",
    index_state_fail_reason: "",
    pending_index_rows: "0",
    ...extra,
  };
}

/** docs_int64 of the seeded set (tests/fixtures/vector/milvus/describe-default-docs_int64.json), as gRPC describes it. */
export const DOCS_INT64: DescribeCollectionResponse = describeAnswer({
  name: "docs_int64",
  autoID: true,
  dynamic: true,
  collectionID: "469489107428444006",
  fields: [
    wireField("id", "Int64", { fieldID: "100", is_primary_key: true, autoID: true }),
    wireField("seq", "Int64", { fieldID: "101" }),
    wireField("vec", "FloatVector", { fieldID: "102", type_params: [kv("dim", "8")] }),
    wireField("title", "VarChar", { fieldID: "103", type_params: [kv("max_length", "256")] }),
    wireField("meta", "JSON", { fieldID: "104" }),
    wireField("tags", "Array", { fieldID: "105", element_type: "Int64", type_params: [kv("max_capacity", "8")] }),
    wireField("maybe_count", "Int32", { fieldID: "106", nullable: true }),
    wireField("$meta", "JSON", { fieldID: "107", is_dynamic: true }),
  ],
});

/** docs_int64's index, its parameters in the order 3.0.2 sends them. */
export const DOCS_INT64_INDEX: WireIndexDescription = wireIndex("vec", "HNSW", "COSINE", {
  indexID: "469489107428765039",
  params: [kv("M", "16"), kv("efConstruction", "64"), kv("metric_type", "COSINE"), kv("index_type", "HNSW")],
  indexed_rows: "2000",
  total_rows: "2000",
});

/** A marker in a function's parameters, which no surface may show. */
export const FUNCTION_MARKER = "MARKER_FUNCTION_PARAMETER";
/** A marker in a field's default value, which no surface may show. */
export const DEFAULT_MARKER = "MARKER_DEFAULT_VALUE";

/** fts: a BM25 function from `text` to the sparse `text_sparse`, its parameters and a default value marked. */
export const FTS: DescribeCollectionResponse = describeAnswer({
  name: "fts",
  autoID: true,
  collectionID: "469489107428444099",
  fields: [
    wireField("id", "Int64", { fieldID: "100", is_primary_key: true, autoID: true }),
    wireField("text", "VarChar", {
      fieldID: "101",
      type_params: [kv("max_length", "1024"), kv("enable_analyzer", "true")],
      default_value: { string_data: DEFAULT_MARKER, data: "string_data" },
    }),
    wireField("text_sparse", "SparseFloatVector", { fieldID: "102", is_function_output: true }),
  ],
  functions: [
    {
      name: "text_bm25",
      id: "1",
      description: "",
      type: "BM25",
      input_field_names: ["text"],
      input_field_ids: ["101"],
      output_field_names: ["text_sparse"],
      output_field_ids: ["102"],
      params: [kv("credential", FUNCTION_MARKER)],
    },
  ],
});

export const FTS_INDEX: WireIndexDescription = wireIndex("text_sparse", "SPARSE_INVERTED_INDEX", "BM25");

/**
 * A GetMetrics(system_info) answer in 3.0.2's shape: a proxy and a query
 * node, the query node loaded (925.0 MiB used of 4.0 GiB, 518.5 MiB loaded), with node addresses, another
 * database's collection id and an unknown field that the GetMetrics allowlist must drop. The collection id passes
 * 2^53, so it is written into the text as its digits, as the server writes it, never through a JS number.
 */
const OTHER_COLLECTION_ID = "469496801668309284";
export const SYSTEM_INFO = JSON.stringify({
  nodes_info: [
    {
      identifier: 1,
      infos: {
        type: "proxy",
        id: 1,
        name: "proxy1",
        hardware_infos: { ip: "172.17.0.2:19529", memory: 4294967296, memory_usage: 969932800 },
      },
    },
    {
      identifier: 1,
      infos: {
        type: "querynode",
        id: 1,
        name: "querynode1",
        has_error: false,
        hardware_infos: {
          ip: "172.17.0.2:21123",
          memory: 4294967296,
          memory_usage: 969932800,
          jemalloc_resident: 527433728,
        },
        quota_metrics: {
          LoadedBinlogSize: 543686656,
          GrowingSegmentsSize: 0,
          Effect: { NodeID: 1, CollectionIDs: ["OTHER_COLLECTION_ID"] },
        },
        collection_metrics: { CollectionRows: { [OTHER_COLLECTION_ID]: 1000000 } },
        unknown_field: "MARKER_UNKNOWN_FIELD",
      },
    },
  ],
}).replace('"OTHER_COLLECTION_ID"', OTHER_COLLECTION_ID);

export interface FakeCollection {
  readonly describe: DescribeCollectionResponse;
  /** Absent or empty: DescribeIndex answers 700 IndexNotExist. */
  readonly indexes?: readonly WireIndexDescription[];
  /** GetLoadState's answer; `LoadStateLoaded` when absent. */
  readonly loadState?: string;
  /** GetCollectionStatistics' `row_count`; "0" when absent. */
  readonly rowCount?: string;
  /** ShowPartitions' names; `["_default"]` when absent. */
  readonly partitions?: readonly string[];
}

export interface FakeCatalog {
  readonly databases: Readonly<Record<string, readonly FakeCollection[]>>;
  readonly version?: string;
  readonly health?: { readonly isHealthy: boolean; readonly reasons: readonly string[] };
  /** GetMetrics' JSON text; absent, GetMetrics answers UNIMPLEMENTED. */
  readonly metrics?: string;
  /** GetLoadingProgress' answers in turn, the last one repeated; `["100"]` when absent. */
  readonly progress?: readonly string[];
}

export type FakeMethod = Exclude<keyof MilvusClient, "close">;

/** Answers a call before the catalog: an Error rejects it, an object answers it, undefined falls through. */
export type FakeHook = (db: string, request: unknown) => Error | object | undefined;

export interface FakeMilvusClient extends MilvusClient {
  readonly calls: LoggedCall[];
  inFlight(): number;
  maxInFlight(): number;
  closes(): number;
  on(method: FakeMethod, hook: FakeHook): void;
  /** Holds every later call of `method` until the returned function is called. */
  hold(method: FakeMethod): () => void;
}

const EMPTY_DESCRIBE: DescribeCollectionResponse = {
  ...describeAnswer({ name: "", fields: [] }),
  schema: null,
  collectionID: "0",
};

export function createFakeMilvusClient(catalog: FakeCatalog): FakeMilvusClient {
  const calls: LoggedCall[] = [];
  const hooks = new Map<FakeMethod, FakeHook>();
  const gates = new Map<FakeMethod, Promise<void>>();
  let current = 0;
  let most = 0;
  let closed = 0;
  let progressAt = 0;

  const databaseOf = (db: string): readonly FakeCollection[] => {
    const found = catalog.databases[db];
    if (found === undefined) throw failedStatus(800, "DatabaseNotExist", `database not found[database=${db}]`);
    return found;
  };
  const collectionOf = (db: string, name: string): FakeCollection => {
    const found = databaseOf(db).find((entry) => entry.describe.collection_name === name);
    if (found === undefined) {
      throw failedStatus(100, "CollectionNotExists", `collection not found[database=${db}][collection=${name}]`);
    }
    return found;
  };
  const waitFor = (gate: Promise<void>, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const stop = () => reject(toMilvusError(signal.reason, signal));
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
      void gate.then(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      });
    });

  async function run<T>(method: FakeMethod, options: CallOptions, request: unknown, answer: () => T): Promise<T> {
    calls.push({ method, args: request === undefined ? [options.db] : [options.db, request] });
    if (closed > 0) throw new MilvusError("closed", "the client is closed");
    current += 1;
    most = Math.max(most, current);
    try {
      const gate = gates.get(method);
      if (gate !== undefined) await waitFor(gate, options.signal);
      if (options.signal.aborted) throw toMilvusError(options.signal.reason, options.signal);
      const hooked = hooks.get(method)?.(options.db, request);
      if (hooked instanceof Error) throw hooked;
      if (hooked !== undefined) return hooked as T;
      return answer();
    } finally {
      current -= 1;
    }
  }

  /** A search answer with no hit, in the shape the adapter decodes. */
  const noHits = (collection: string): SearchResults => ({
    status: OK,
    results: {
      num_queries: "1",
      top_k: "0",
      fields_data: [],
      scores: [],
      ids: null,
      topks: ["0"],
      output_fields: [],
      group_by_field_value: null,
      all_search_count: "0",
      distances: [],
      recalls: [],
      primary_field_name: "id",
      element_indices: null,
      group_by_field_values: [],
    },
    collection_name: collection,
    session_ts: "0",
  });

  return {
    calls,
    inFlight: () => current,
    maxInFlight: () => most,
    closes: () => closed,
    on: (method, hook) => {
      hooks.set(method, hook);
    },
    hold: (method) => {
      let open: () => void = () => {};
      gates.set(
        method,
        new Promise<void>((resolve) => {
          open = resolve;
        }),
      );
      return () => {
        gates.delete(method);
        open();
      };
    },
    getVersion: (o) => run("getVersion", o, undefined, () => ({ status: OK, version: catalog.version ?? "v3.0.2" })),
    checkHealth: (o) =>
      run("checkHealth", o, undefined, () => ({
        status: OK,
        isHealthy: catalog.health?.isHealthy ?? true,
        reasons: [...(catalog.health?.reasons ?? [])],
        quota_states: [],
      })),
    getMetricsSystemInfo: (o) =>
      run("getMetricsSystemInfo", o, undefined, () => {
        if (catalog.metrics === undefined) throw unimplemented("GetMetrics");
        return { status: OK, response: catalog.metrics, component_name: "proxy1" };
      }),
    listDatabases: (o) =>
      run("listDatabases", o, undefined, () => ({
        status: OK,
        db_names: Object.keys(catalog.databases),
        created_timestamp: [],
        db_ids: [],
      })),
    describeDatabase: (r, o) =>
      run("describeDatabase", o, r, () => {
        databaseOf(o.db);
        return { status: OK, db_name: o.db, dbID: "1", created_timestamp: "0", properties: [] };
      }),
    showCollections: (o) =>
      run("showCollections", o, undefined, () => ({
        status: OK,
        collection_names: databaseOf(o.db).map((entry) => entry.describe.collection_name),
        collection_ids: [],
        created_timestamps: [],
        created_utc_timestamps: [],
        inMemory_percentages: [],
        query_service_available: [],
        shards_num: [],
      })),
    describeCollection: (r, o) => run("describeCollection", o, r, () => collectionOf(o.db, r.collection_name).describe),
    batchDescribeCollection: (r, o) =>
      run("batchDescribeCollection", o, r, () => ({
        status: OK,
        responses: r.collection_name.map((name) => {
          try {
            return collectionOf(o.db, name).describe;
          } catch (error) {
            const failed = error as MilvusError;
            const status = failed.status ?? { code: 2, errorCode: "UnexpectedError" };
            return {
              ...EMPTY_DESCRIBE,
              status: { ...OK, code: status.code, error_code: status.errorCode, reason: failed.detail },
            };
          }
        }),
      })),
    describeIndex: (r, o) =>
      run("describeIndex", o, r, () => {
        const indexes = collectionOf(o.db, r.collection_name).indexes ?? [];
        if (indexes.length === 0) {
          throw failedStatus(700, "IndexNotExist", `index not found[collection=${r.collection_name}]`);
        }
        return { status: OK, index_descriptions: [...indexes] };
      }),
    getLoadState: (r, o) =>
      run("getLoadState", o, r, () => ({
        status: OK,
        state: collectionOf(o.db, r.collection_name).loadState ?? "LoadStateLoaded",
      })),
    getLoadingProgress: (r, o) =>
      run("getLoadingProgress", o, r, () => {
        collectionOf(o.db, r.collection_name);
        const answers = catalog.progress ?? ["100"];
        const progress = answers[Math.min(progressAt, answers.length - 1)];
        progressAt += 1;
        return { status: OK, progress, refresh_progress: "100" };
      }),
    getCollectionStatistics: (r, o) =>
      run("getCollectionStatistics", o, r, () => ({
        status: OK,
        stats: [kv("row_count", collectionOf(o.db, r.collection_name).rowCount ?? "0")],
      })),
    showPartitions: (r, o) =>
      run("showPartitions", o, r, () => ({
        status: OK,
        partition_names: [...(collectionOf(o.db, r.collection_name).partitions ?? ["_default"])],
        partitionIDs: [],
        created_timestamps: [],
        created_utc_timestamps: [],
        inMemory_percentages: [],
      })),
    listAliases: (r, o) =>
      run("listAliases", o, r, () => ({
        status: OK,
        db_name: o.db,
        collection_name: r.collection_name ?? "",
        aliases:
          r.collection_name === undefined
            ? databaseOf(o.db).flatMap((entry) => entry.describe.aliases)
            : [...collectionOf(o.db, r.collection_name).describe.aliases],
      })),
    describeAlias: (r, o) =>
      run("describeAlias", o, r, () => {
        const owner = databaseOf(o.db).find((entry) => entry.describe.aliases.includes(r.alias));
        if (owner === undefined) throw failedStatus(1600, "AliasNotExist", `alias not found[alias=${r.alias}]`);
        return { status: OK, db_name: o.db, alias: r.alias, collection: owner.describe.collection_name };
      }),
    query: (r, o) =>
      run("query", o, r, () => {
        collectionOf(o.db, r.collection_name);
        return {
          status: OK,
          fields_data: [],
          collection_name: r.collection_name,
          output_fields: [],
          session_ts: "0",
          primary_field_name: "id",
        };
      }),
    search: (r, o) =>
      run("search", o, r, () => {
        collectionOf(o.db, r.collection_name);
        return noHits(r.collection_name);
      }),
    hybridSearch: (r, o) =>
      run("hybridSearch", o, r, () => {
        collectionOf(o.db, r.collection_name);
        return noHits(r.collection_name);
      }),
    loadCollection: (r, o) =>
      run("loadCollection", o, r, () => {
        collectionOf(o.db, r.collection_name);
        return OK;
      }),
    releaseCollection: (r, o) =>
      run("releaseCollection", o, r, () => {
        collectionOf(o.db, r.collection_name);
        return OK;
      }),
    close: () => {
      closed += 1;
    },
  };
}

export const TEST_ERRORS: MilvusErrorConnection = {
  host: "127.0.0.1",
  port: 19530,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 16 * 1024 * 1024,
  timeoutMs: 10_000,
};

let engines = 0;

/** A surface context over a limiter with an engine key of its own, so no two tests share a bound. */
export function testSurface(over: Partial<MilvusSurfaceContext> = {}, perProvider = 4): MilvusSurfaceContext {
  engines += 1;
  return {
    database: "default",
    limiter: engineLimiter(`milvus-surface-test-${engines}`, { perProvider, perEngine: 16, queueDepth: 64 })(),
    signal: () => new AbortController().signal,
    errors: TEST_ERRORS,
    secretForms: [],
    ...over,
  };
}

/** Lets every pending microtask and zero-delay timer run, so the calls a test started reach the fake. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn lets the previous turn's continuations run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
