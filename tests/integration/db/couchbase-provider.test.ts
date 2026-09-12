/**
 * Couchbase Provider Integration Tests (issue #262)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun and would poison sibling
 * test files. Every payload below was captured from a live Couchbase Server
 * 8.0.2 Community node, so the fake speaks exactly what the cluster speaks.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { CouchbaseProvider } from "@/lib/db/providers/document/couchbase";
import { COUCHBASE_CONTAINER_LEVELS, COUCHBASE_OBJECT_KINDS } from "@/lib/db/providers/document/couchbase/objects";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError, TimeoutError } from "@/lib/db/errors";

// ============================================================================
// Connection
// ============================================================================

// The DatabaseType union gains "couchbase" in the registration commit; the
// double assertion keeps this file compiling on either side of that change.
const COUCHBASE: DatabaseType = "couchbase" as unknown as DatabaseType;

const BUCKET = "travel";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "cb-1",
    name: "Couchbase",
    type: COUCHBASE,
    host: "127.0.0.1",
    port: 8091,
    user: "Administrator",
    password: "password123",
    database: BUCKET,
    createdAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Management payloads (captured from Couchbase Server 8.0.2 Community)
// ============================================================================

const NODE_SERVICES = {
  nodesExt: [{ hostname: "127.0.0.1", services: { mgmt: 8091, n1ql: 8093 } }],
};

const POOLS = {
  name: "default",
  nodes: [{ version: "8.0.2-5503-community", uptime: "2722", status: "healthy" }],
};

const BUCKET_INFO = {
  name: BUCKET,
  storageBackend: "couchstore",
  quota: { ram: 268435456, rawRAM: 268435456 },
  basicStats: {
    quotaPercentUsed: 14.6,
    opsPerSec: 0,
    itemCount: 7,
    diskUsed: 17581056,
    dataUsed: 1814878,
    memUsed: 39189488,
  },
};

const BUCKET_STATS = {
  op: {
    samples: {
      curr_connections: [55, 55, 55],
      cmd_get: [1, 2, 3],
      cmd_set: [0, 0, 1],
      ep_cache_miss_rate: [0, 0, 2.5],
    },
  },
};

const INDEX_STATS_SAMPLES = {
  op: {
    samples: {
      "index/idx_hotel_city/data_size": [1, 2, 4096],
      "index/idx_hotel_city/num_requests": [0, 0, 7],
    },
  },
};

// ============================================================================
// Query payloads
// ============================================================================

const COLLECTION_ROWS = [
  { bucket_name: BUCKET, scope_name: "_default", collection_name: "airline" },
  { bucket_name: BUCKET, scope_name: "inventory", collection_name: "hotel" },
];

const INDEX_ROWS = [
  {
    index_name: "#primary",
    bucket_name: BUCKET,
    scope_name: "_default",
    collection_name: "airline",
    index_key: [],
    is_primary: true,
    state: "online",
    index_type: "gsi",
  },
  {
    index_name: "idx_hotel_city",
    bucket_name: BUCKET,
    scope_name: "inventory",
    collection_name: "hotel",
    index_key: ["`city`"],
    state: "online",
    index_type: "gsi",
  },
];

const INFER_FLAVOURS = [
  {
    "#docs": 3,
    Flavor: "",
    properties: {
      city: { type: "string", "%docs": 100, samples: ["Bursa", "Istanbul"] },
      "~meta": { properties: { id: { type: "string", samples: ["hotel::1"] } } },
    },
  },
];

const COMPLETED_REQUEST_ROWS = [
  {
    request_id: "2c95157c",
    statement: "CREATE INDEX idx_hotel_city ON `travel`.`inventory`.`hotel`(city)",
    elapsed_ns: 4410636437,
    result_count: 1,
  },
];

const ACTIVE_REQUEST_ROWS = [
  {
    request_id: "8a45dcda",
    statement: "SELECT * FROM `travel`.`inventory`.`hotel`",
    users: "builtin:Administrator",
    remote_addr: "172.17.0.1:41136",
    state: "running",
    elapsed_ns: 914475,
  },
];

// ============================================================================
// fetch harness
// ============================================================================

interface ManageStub {
  match: string;
  payload: unknown;
  httpCode: number;
}

const originalFetch = globalThis.fetch;

let manageStubs: ManageStub[] = [];
let manageUrls: string[] = [];
let queryBodies: Record<string, unknown>[] = [];
let queryHandler: (statement: string) => unknown;
let queryHttpCode = 200;
let deferredIndexRows: Record<string, unknown>[] = [];
let networkFailure: Error | null = null;

function jsonResponse(payload: unknown, httpCode: number): Response {
  return new Response(JSON.stringify(payload), {
    status: httpCode,
    headers: { "content-type": "application/json" },
  });
}

function queryPayload(rows: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestID: "req-1",
    signature: { "*": "*" },
    results: rows,
    status: "success",
    metrics: { elapsedTime: "2.5ms", executionTime: "1.234ms", resultCount: rows.length, mutationCount: 0 },
    ...overrides,
  };
}

function errorPayload(code: number, msg: string): Record<string, unknown> {
  return {
    requestID: "req-1",
    errors: [{ code, msg }],
    status: "fatal",
    metrics: { elapsedTime: "0.4ms", executionTime: "0.3ms", resultCount: 0, errorCount: 1 },
  };
}

/** Route a statement onto the catalog fixtures above. */
function defaultQueryPayload(statement: string): unknown {
  if (statement.startsWith("INFER")) return queryPayload([INFER_FLAVOURS]);
  if (statement.includes("system:keyspaces")) {
    return statement.includes("COUNT(*)") ? queryPayload([{ total: 4 }]) : queryPayload(COLLECTION_ROWS);
  }
  if (statement.includes("system:indexes")) {
    if (statement.includes("COUNT(*)")) return queryPayload([{ total: 3 }]);
    if (statement.includes("deferred")) return queryPayload(deferredIndexRows);
    return queryPayload(INDEX_ROWS);
  }
  if (statement.includes("system:completed_requests")) return queryPayload(COMPLETED_REQUEST_ROWS);
  if (statement.includes("system:active_requests")) {
    return statement.startsWith("DELETE") ? queryPayload([]) : queryPayload(ACTIVE_REQUEST_ROWS);
  }
  return queryPayload([]);
}

function stubManage(match: string, payload: unknown, httpCode = 200): void {
  manageStubs.unshift({ match, payload, httpCode });
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (networkFailure) throw networkFailure;
    const url = String(input);

    if (url.includes("/query/service")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      queryBodies.push(body);
      return jsonResponse(queryHandler(String(body.statement)), queryHttpCode);
    }

    manageUrls.push(url);
    const stub = manageStubs.find((entry) => url.includes(entry.match));
    return jsonResponse(stub?.payload ?? {}, stub?.httpCode ?? 404);
  }) as typeof fetch;
}

function bodyOf(match: string): Record<string, unknown> {
  const body = queryBodies.find((entry) => String(entry.statement).includes(match));
  if (!body) throw new Error(`no statement matching "${match}" was sent`);
  return body;
}

async function connectProvider(overrides: Partial<DatabaseConnection> = {}): Promise<CouchbaseProvider> {
  const provider = new CouchbaseProvider(makeConnection(overrides));
  await provider.connect();
  return provider;
}

beforeEach(() => {
  manageUrls = [];
  queryBodies = [];
  deferredIndexRows = [];
  networkFailure = null;
  queryHttpCode = 200;
  queryHandler = defaultQueryPayload;
  manageStubs = [
    { match: "/pools/default/nodeServices", payload: NODE_SERVICES, httpCode: 200 },
    { match: `/pools/default/buckets/@index-${BUCKET}/stats`, payload: INDEX_STATS_SAMPLES, httpCode: 200 },
    { match: `/pools/default/buckets/${BUCKET}/stats`, payload: BUCKET_STATS, httpCode: 200 },
    { match: `/pools/default/buckets/${BUCKET}`, payload: BUCKET_INFO, httpCode: 200 },
    { match: "/pools/default", payload: POOLS, httpCode: 200 },
  ];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Metadata
// ============================================================================

describe("CouchbaseProvider metadata", () => {
  test("declares the capabilities issue #262 specifies", () => {
    const capabilities = new CouchbaseProvider(makeConnection()).getCapabilities();

    expect(capabilities).toEqual({
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "couchbase-json",
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      // The HTTP query service is stateless per request; no session spans two of them.
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["analyze", "reindex", "kill"],
      // All three go through `requireTarget`, so all three are per-keyspace only.
      // The global Reindex card that #U6 wired up answered *"The reindex operation
      // requires a target"* on every click, which is what `global: false` withholds.
      maintenanceOperationSpecs: {
        analyze: { label: "Update Statistics", perEntity: true, global: false },
        reindex: { label: "Build Deferred Indexes", perEntity: true, global: false },
        kill: { label: "Cancel Request", perEntity: false, global: false },
      },
      supportsConnectionString: true,
      defaultPort: 8091,
      // The object surface (#789); asserted field by field in the object-surface block.
      containerLevels: COUCHBASE_CONTAINER_LEVELS,
      objectKinds: COUCHBASE_OBJECT_KINDS,
      schemaRefreshPattern: "\\b(CREATE|DROP|ALTER)\\s+(COLLECTION|SCOPE|INDEX)\\b",
    });
  });

  test("declares supportsInlineRowEdit false because the grid's key column is a projection alias", () => {
    // SQL++ does have `UPDATE <keyspace> SET ... WHERE ...`, but the statement the
    // shared hook builds cannot address a document here: the collection-open query
    // projects the key as `META(d).id AS __id` (`src/lib/query-generators.ts`), and
    // the hook's primary-key heuristic picks `__id` up because it ends in `_id`. The
    // emitted `WHERE __id = '<key>'` filters on a field no document has, so it
    // matches nothing. Addressing a document needs `META(d).id` or `USE KEYS`, which
    // is per-dialect statement building - deferred to issue #279.
    expect(new CouchbaseProvider(makeConnection()).getCapabilities().supportsInlineRowEdit).toBe(false);
  });

  test("declares declaresForeignKeys false because SQL++ has no referential constraint", () => {
    // Collections are schemaless and the columns this provider reports are inferred
    // from a document sample, so `getSchema()`'s empty `foreignKeys` is not "none
    // were declared here" but "none can be declared at all" (#414).
    expect(new CouchbaseProvider(makeConnection()).getCapabilities().declaresForeignKeys).toBe(false);
  });

  test("labels collections and documents", () => {
    const labels = new CouchbaseProvider(makeConnection()).getLabels();

    expect(labels.entityName).toBe("Collection");
    expect(labels.entityNamePlural).toBe("Collections");
    expect(labels.rowName).toBe("document");
    expect(labels.rowNamePlural).toBe("documents");
    expect(labels.analyzeGlobalDesc).toContain("Enterprise");
  });

  // The Operations tab's global Reindex card was hardcoded to PostgreSQL's "Run
  // Reindex / Rebuild Indexes / Reconstructs all indexes in the database." Couchbase's
  // `reindex` is `BUILD INDEX` over the DEFERRED GSI indexes of one keyspace
  // (`buildDeferredIndexes()`), so none of those three strings described it (#464).
  test("names the deferred GSI build, not a table reindex, in the global reindex card", () => {
    const labels = new CouchbaseProvider(makeConnection()).getLabels();

    expect(labels.reindexGlobalLabel).toBe("Build Indexes");
    expect(labels.reindexGlobalTitle).toContain("GSI");
    expect(labels.reindexGlobalDesc).toContain("BUILD INDEX");
    expect(labels.reindexGlobalDesc).not.toContain("REINDEX");
  });

  // Until #U12 the monitoring Queries panel told a Couchbase operator to install a
  // PostgreSQL extension. `getSlowQueries()` reads system:completed_requests, which
  // keeps only requests over the query service's threshold.
  test("names system:completed_requests, not a Postgres extension, as the source of query stats", () => {
    const { slowQueriesEmptyState } = new CouchbaseProvider(makeConnection()).getLabels();

    expect(slowQueriesEmptyState).toContain("system:completed_requests");
    expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

// ============================================================================
// Validation
// ============================================================================

describe("CouchbaseProvider validation", () => {
  test("requires a host or a connection string", () => {
    expect(() => new CouchbaseProvider(makeConnection({ host: undefined }))).toThrow(DatabaseConfigError);
  });

  test("requires a bucket in the database field", () => {
    expect(() => new CouchbaseProvider(makeConnection({ database: undefined }))).toThrow(/bucket/i);
  });

  test("accepts a connection string instead of a host and targets its hostname", async () => {
    const provider = await connectProvider({
      host: undefined,
      connectionString: "couchbases://cb.example.cloud.couchbase.com",
    });

    expect(manageUrls[0]).toContain("cb.example.cloud.couchbase.com:8091/pools/default");
    await provider.disconnect();
  });

  test("keeps the configured host when the connection string is unparsable", async () => {
    const provider = await connectProvider({ host: undefined, connectionString: "not a url" });

    expect(manageUrls[0]).toContain("localhost:8091/pools/default");
    await provider.disconnect();
  });
});

// ============================================================================
// Lifecycle
// ============================================================================

describe("CouchbaseProvider lifecycle", () => {
  test("connect verifies the cluster and marks the provider connected", async () => {
    const provider = await connectProvider();

    expect(provider.isConnected()).toBe(true);
    expect(manageUrls[0]).toContain("/pools/default");
  });

  test("connect maps rejected credentials to an AuthenticationError", async () => {
    stubManage("/pools/default", {}, 401);
    const provider = new CouchbaseProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect maps an unreachable cluster to a ConnectionError", async () => {
    networkFailure = new Error("connect ECONNREFUSED 127.0.0.1:8091");
    const provider = new CouchbaseProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("disconnect releases the transport and is safe to call twice", async () => {
    const provider = await connectProvider();

    await provider.disconnect();
    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
  });

  test("query before connect is refused", async () => {
    const provider = new CouchbaseProvider(makeConnection());

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(DatabaseConfigError);
  });
});

// ============================================================================
// Query execution
// ============================================================================

describe("CouchbaseProvider query", () => {
  test("returns rows, fields, row count and the cluster execution time", async () => {
    const provider = await connectProvider();
    queryHandler = () =>
      queryPayload([{ id: "hotel::1", city: "Bursa" }], { signature: { id: "string", city: "string" } });

    const result = await provider.query("SELECT id, city FROM `travel`.`inventory`.`hotel`");

    expect(result.rows).toEqual([{ id: "hotel::1", city: "Bursa" }]);
    expect(result.fields).toEqual(["id", "city"]);
    expect(result.rowCount).toBe(1);
    expect(result.executionTime).toBe(1);
  });

  test("derives fields from the rows when the projection is a wildcard", async () => {
    const provider = await connectProvider();
    queryHandler = () => queryPayload([{ hotel: { city: "Bursa" } }, { hotel: {}, __id: "hotel::2" }]);

    const result = await provider.query("SELECT * FROM `travel`.`inventory`.`hotel`");

    expect(result.fields).toEqual(["hotel", "__id"]);
  });

  test("wraps SELECT RAW scalars so the grid gets one honest column", async () => {
    // SELECT RAW / SELECT VALUE return bare scalars, not objects. Handing those
    // through unchanged makes deriveFields call Object.keys on a string, which
    // yields one column per character index.
    const provider = await connectProvider();
    queryHandler = () => queryPayload(["Grand Plaza", "Seaside Inn"] as unknown as Record<string, unknown>[]);

    const result = await provider.query("SELECT RAW h.name FROM `travel`.`inventory`.`hotel` AS h");

    expect(result.rows).toEqual([{ __value: "Grand Plaza" }, { __value: "Seaside Inn" }]);
    expect(result.fields).toEqual(["__value"]);
  });

  test("wraps null and array rows rather than crashing on them", async () => {
    // A RAW projection of a missing field yields null, and Object.keys(null)
    // throws - the whole request used to fail with a 500.
    const provider = await connectProvider();
    queryHandler = () => queryPayload([null, [1, 2]] as unknown as Record<string, unknown>[]);

    const result = await provider.query("SELECT RAW h.missing FROM `travel`.`inventory`.`hotel` AS h");

    expect(result.rows).toEqual([{ __value: null }, { __value: [1, 2] }]);
    expect(result.fields).toEqual(["__value"]);
  });

  test("reports the mutation count as the row count when a statement returns no rows", async () => {
    const provider = await connectProvider();
    queryHandler = () => queryPayload([], { metrics: { elapsedTime: "5ms", executionTime: "4ms", mutationCount: 3 } });

    const result = await provider.query("INSERT INTO `travel`.`_default`.`airline` VALUES ('a', {})");

    expect(result.rowCount).toBe(3);
    expect(result.rows).toEqual([]);
  });

  test("falls back to the measured time when the cluster reports no metrics", async () => {
    const provider = await connectProvider();
    queryHandler = () => queryPayload([], { metrics: {} });

    const result = await provider.query("SELECT 1");

    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  test("asks for request_plus so a user always sees their own writes", async () => {
    const provider = await connectProvider();

    await provider.query("SELECT 1");

    expect(bodyOf("SELECT 1").scan_consistency).toBe("request_plus");
  });

  test("forwards positional parameters to the cluster", async () => {
    const provider = await connectProvider();

    await provider.query("SELECT * FROM `travel`.`_default`.`airline` WHERE country = $1", ["France"]);

    expect(bodyOf("country = $1").args).toEqual(["France"]);
  });

  test("carries the notices the cluster attached to a completed statement (#273)", async () => {
    // The cluster answers `status: success` and appends advice about the
    // statement it just ran; those notices used to stop at the transport seam,
    // so a user never learned their query had been answered with a caveat.
    const provider = await connectProvider();
    queryHandler = () =>
      queryPayload([{ id: "hotel::1" }], {
        signature: { id: "string" },
        warnings: [
          { code: 4321, msg: "The index advisor recommends an index on `city`" },
          { code: 3230, msg: "This statement uses a full keyspace scan" },
        ],
      });

    const result = await provider.query("SELECT id FROM `travel`.`inventory`.`hotel`");

    expect(result.warnings).toEqual([
      { code: 4321, message: "The index advisor recommends an index on `city`" },
      { code: 3230, message: "This statement uses a full keyspace scan" },
    ]);
  });

  test("leaves the warnings channel absent when the cluster reported none", async () => {
    // Absence is the signal, so a clean run must not carry an empty array: the
    // result UI decides whether to render anything at all from this field.
    const provider = await connectProvider();
    queryHandler = () => queryPayload([{ id: "hotel::1" }], { signature: { id: "string" } });

    const result = await provider.query("SELECT id FROM `travel`.`inventory`.`hotel`");

    expect(result.warnings).toBeUndefined();
    expect("warnings" in result).toBe(false);
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe("CouchbaseProvider error mapping", () => {
  test("error 4000 carries the CREATE PRIMARY INDEX remedy for the quoted keyspace", async () => {
    const provider = await connectProvider();
    queryHandler = () =>
      errorPayload(
        4000,
        "No index available on keyspace `default`:`travel`.`inventory`.`hotel` that matches your query.",
      );

    const failure = provider.query("SELECT * FROM `travel`.`inventory`.`hotel` LIMIT 10");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("CREATE PRIMARY INDEX ON `travel`.`inventory`.`hotel`");
  });

  test("error 4000 on an unquoted keyspace still produces a runnable remedy", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(4000, "No index available on keyspace travel");

    await expect(provider.query("select * from travel")).rejects.toThrow("CREATE PRIMARY INDEX ON `travel`");
  });

  test("error 4000 without a FROM clause falls back to the pinned bucket", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(4000, "No index available on keyspace");

    await expect(provider.query("EXECUTE 'p1'")).rejects.toThrow("CREATE PRIMARY INDEX ON `travel`");
  });

  test("a missing privilege becomes an AuthenticationError", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(13014, "User does not have credentials to run SELECT queries");

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a request timeout becomes a TimeoutError", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(1080, "Timeout 30s exceeded");

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(TimeoutError);
  });

  test("an unavailable query service becomes a ConnectionError", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(503, "service unavailable");

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("an HTTP-level rejection with no payload still maps by its code", async () => {
    const provider = await connectProvider();
    queryHandler = () => ({});
    queryHttpCode = 403;

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a network fault becomes a ConnectionError", async () => {
    const provider = await connectProvider();
    networkFailure = new Error("socket hang up");

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("a rejected statement becomes a QueryError", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(3000, "syntax error - line 1, column 8, near 'SELEC'");

    await expect(provider.query("SELEC 1")).rejects.toBeInstanceOf(QueryError);
  });

  test("a statement rejected with no code at all still becomes a QueryError", async () => {
    const provider = await connectProvider();
    queryHandler = () => ({ requestID: "req-1", status: "errors" });

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(QueryError);
  });
});

// ============================================================================
// Schema
// ============================================================================

// ============================================================================
// Monitoring
// ============================================================================

describe("CouchbaseProvider monitoring", () => {
  test("getOverview combines cluster, bucket and catalog counts", async () => {
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("8.0.2-5503-community");
    expect(overview.uptime).toBe("45.37m");
    expect(overview.activeConnections).toBe(55);
    expect(overview.maxConnections).toBe(65536);
    expect(overview.databaseSizeBytes).toBe(17581056);
    expect(overview.databaseSize).toBe("16.77 MB");
    expect(overview.tableCount).toBe(4);
    expect(overview.indexCount).toBe(3);
    expect(overview.startTime).toBeInstanceOf(Date);
  });

  test("getOverview degrades to zeros when every source is denied", async () => {
    const provider = await connectProvider();
    stubManage("/pools/default", {}, 403);
    queryHandler = () => errorPayload(13014, "User does not have credentials");

    const overview = await provider.getOverview();

    expect(overview.version).toBe("unknown");
    expect(overview.activeConnections).toBe(0);
    expect(overview.databaseSizeBytes).toBe(0);
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("getPerformanceMetrics derives the hit ratio from the miss rate", async () => {
    const provider = await connectProvider();

    const performance = await provider.getPerformanceMetrics();

    expect(performance.cacheHitRatio).toBe(97.5);
    expect(performance.queriesPerSecond).toBe(4);
    expect(performance.bufferPoolUsage).toBe(14.6);
  });

  // This test used to be named "reports zero rather than a perfect score when
  // denied" and asserted three zeroes - it is what protected the fabrication. A
  // denied stats read measures nothing, and 0 is not nothing: the cache-ratio
  // threshold rates 0% as red-critical, so the panel invented an incident on a
  // healthy cluster whose statistics the user simply may not read.
  test("getPerformanceMetrics omits every metric when the stats read is denied", async () => {
    const provider = await connectProvider();
    stubManage(`/pools/default/buckets/${BUCKET}`, {}, 403);

    const performance = await provider.getPerformanceMetrics();

    expect("cacheHitRatio" in performance).toBe(false);
    expect("queriesPerSecond" in performance).toBe(false);
    expect("bufferPoolUsage" in performance).toBe(false);
  });

  test("getPerformanceMetrics keeps a measured zero, which is a real reading", async () => {
    const provider = await connectProvider();
    // A cluster nobody has touched: no misses (so a perfect hit ratio), no
    // operations in the last sample, and an empty quota.
    // Bucket info first: `stubManage` unshifts and the matcher is a substring, so
    // the narrower `/stats` stub has to be registered last to win.
    stubManage(`/pools/default/buckets/${BUCKET}`, { ...BUCKET_INFO, basicStats: { quotaPercentUsed: 0 } });
    stubManage(`/pools/default/buckets/${BUCKET}/stats`, {
      op: { samples: { ep_cache_miss_rate: [0, 0, 0], cmd_get: [0], cmd_set: [0] } },
    });

    const performance = await provider.getPerformanceMetrics();

    expect(performance.cacheHitRatio).toBe(100);
    expect(performance.queriesPerSecond).toBe(0);
    expect(performance.bufferPoolUsage).toBe(0);
  });

  test("getPerformanceMetrics omits only what the sample set is missing", async () => {
    const provider = await connectProvider();
    // A bucket whose KV series are absent (a memcached bucket publishes no `ep_*`
    // stats at all) while the quota the bucket endpoint reports is still readable.
    stubManage(`/pools/default/buckets/${BUCKET}/stats`, { op: { samples: { curr_connections: [55] } } });

    const performance = await provider.getPerformanceMetrics();

    expect("cacheHitRatio" in performance).toBe(false);
    expect("queriesPerSecond" in performance).toBe(false);
    expect(performance.bufferPoolUsage).toBe(14.6);
  });

  test("getPerformanceMetrics counts a half-published operation pair", async () => {
    const provider = await connectProvider();
    stubManage(`/pools/default/buckets/${BUCKET}/stats`, {
      op: { samples: { ep_cache_miss_rate: [1.5], cmd_get: [7] } },
    });

    const performance = await provider.getPerformanceMetrics();

    expect(performance.cacheHitRatio).toBe(98.5);
    expect(performance.queriesPerSecond).toBe(7);
  });

  test("getSlowQueries reads system:completed_requests", async () => {
    const provider = await connectProvider();

    const slow = await provider.getSlowQueries({ limit: 5 });

    expect(slow).toHaveLength(1);
    expect(slow[0].queryId).toBe("2c95157c");
    expect(slow[0].totalTime).toBe(4411);
    expect(slow[0].avgTime).toBe(4411);
    expect(slow[0].rows).toBe(1);
    expect(bodyOf("system:completed_requests").args).toEqual([5]);
  });

  test("getSlowQueries returns empty when the Query System Catalog role is missing", async () => {
    const provider = await connectProvider();
    queryHandler = () =>
      errorPayload(13014, "User does not have credentials to run queries on system:completed_requests");

    expect(await provider.getSlowQueries()).toEqual([]);
  });

  test("getActiveSessions reads system:active_requests", async () => {
    const provider = await connectProvider();

    const sessions = await provider.getActiveSessions({ limit: 7 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe("8a45dcda");
    expect(sessions[0].user).toBe("builtin:Administrator");
    expect(sessions[0].database).toBe(BUCKET);
    expect(sessions[0].state).toBe("running");
    expect(sessions[0].clientAddr).toBe("172.17.0.1:41136");
    expect(sessions[0].durationMs).toBe(1);
    expect(bodyOf("system:active_requests").args).toEqual([7]);
  });

  test("getActiveSessions returns empty when the system keyspace is denied", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(13014, "User does not have credentials");

    expect(await provider.getActiveSessions()).toEqual([]);
  });

  test("getTableStats reports the bucket, the only cheap granularity", async () => {
    const provider = await connectProvider();

    const stats = await provider.getTableStats();

    expect(stats).toHaveLength(1);
    expect(stats[0].tableName).toBe(BUCKET);
    expect(stats[0].rowCount).toBe(7);
    expect(stats[0].tableSizeBytes).toBe(1814878);
    expect(stats[0].totalSizeBytes).toBe(17581056);
  });

  test("getTableStats returns empty when the bucket endpoint is denied", async () => {
    const provider = await connectProvider();
    stubManage(`/pools/default/buckets/${BUCKET}`, {}, 403);

    expect(await provider.getTableStats()).toEqual([]);
  });

  test("getIndexStats joins system:indexes with the index service samples", async () => {
    const provider = await connectProvider();

    const stats = await provider.getIndexStats();

    expect(stats).toHaveLength(2);
    expect(stats[0]).toEqual({
      schemaName: "_default",
      tableName: "airline",
      indexName: "#primary",
      indexType: "gsi",
      columns: [],
      isUnique: true,
      isPrimary: true,
      // The index service publishes no `data_size` series for this index, and
      // "0 B" claimed an empty index where nothing was measured at all.
      indexSize: "N/A",
      scans: 0,
    });
    expect(stats[1].columns).toEqual(["city"]);
    expect(stats[1].isPrimary).toBe(false);
    expect(stats[1].indexSizeBytes).toBe(4096);
    expect(stats[1].scans).toBe(7);
  });

  test("getIndexStats returns empty when system:indexes is denied", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(13014, "User does not have credentials");

    expect(await provider.getIndexStats()).toEqual([]);
  });

  test("getStorageStats reports disk usage and the RAM quota", async () => {
    const provider = await connectProvider();

    const storage = await provider.getStorageStats();

    expect(storage).toHaveLength(2);
    expect(storage[0]).toEqual({
      name: "Data",
      location: BUCKET,
      size: "16.77 MB",
      sizeBytes: 17581056,
    });
    expect(storage[1].sizeBytes).toBe(268435456);
    expect(storage[1].usagePercent).toBe(14.6);
  });

  test("getStorageStats returns empty when the bucket endpoint is denied", async () => {
    const provider = await connectProvider();
    stubManage(`/pools/default/buckets/${BUCKET}`, {}, 403);

    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("getHealth composes the degrading sources", async () => {
    const provider = await connectProvider();

    const health = await provider.getHealth();

    expect(health.activeConnections).toBe(55);
    expect(health.databaseSize).toBe("16.77 MB");
    expect(health.cacheHitRatio).toBe("97.5");
    expect(health.slowQueries[0].avgTime).toBe("4411ms");
    expect(health.activeSessions[0].pid).toBe("8a45dcda");
  });

  test("getMonitoringData survives a user who can read nothing", async () => {
    const provider = await connectProvider();
    stubManage("/pools/default", {}, 403);
    queryHandler = () => errorPayload(13014, "User does not have credentials");

    const data = await provider.getMonitoringData();

    expect(data.slowQueries).toEqual([]);
    expect(data.activeSessions).toEqual([]);
    expect(data.tables).toEqual([]);
    expect(data.indexes).toEqual([]);
    expect(data.storage).toEqual([]);
    // Nothing was readable, so the panel is told there is no ratio and renders
    // "Not measured" instead of a red 0%.
    expect("cacheHitRatio" in data.performance!).toBe(false);
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("CouchbaseProvider maintenance", () => {
  test("analyze runs UPDATE STATISTICS for the keyspace", async () => {
    const provider = await connectProvider();

    const result = await provider.runMaintenance("analyze", "inventory.hotel");

    expect(result.success).toBe(true);
    expect(bodyOf("UPDATE STATISTICS").statement).toBe("UPDATE STATISTICS FOR `travel`.`inventory`.`hotel` INDEX ALL");
  });

  test("analyze surfaces the Community Edition rejection verbatim", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(3230, "'Update Statistics' is an enterprise level feature.");

    const result = await provider.runMaintenance("analyze", "inventory.hotel");

    expect(result.success).toBe(false);
    expect(result.message).toBe("'Update Statistics' is an enterprise level feature.");
  });

  test("analyze without a target is refused", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("analyze")).rejects.toBeInstanceOf(QueryError);
  });

  test("reindex builds the deferred indexes of the keyspace", async () => {
    const provider = await connectProvider();
    deferredIndexRows = [{ index_name: "idx_city" }, { index_name: "idx_name" }, { index_name: 42 }];

    const result = await provider.runMaintenance("reindex", "inventory.hotel");

    expect(result.success).toBe(true);
    expect(bodyOf("BUILD INDEX").statement).toBe("BUILD INDEX ON `travel`.`inventory`.`hotel`(`idx_city`, `idx_name`)");
    expect(result.message).toContain("2");
  });

  test("reindex reports when nothing is deferred", async () => {
    const provider = await connectProvider();

    const result = await provider.runMaintenance("reindex", "inventory.hotel");

    expect(result.success).toBe(true);
    expect(result.message).toContain("No deferred");
    expect(queryBodies.some((body) => String(body.statement).startsWith("BUILD INDEX"))).toBe(false);
  });

  test("kill deletes the row from system:active_requests", async () => {
    const provider = await connectProvider();

    const result = await provider.runMaintenance("kill", "8a45dcda");

    expect(result.success).toBe(true);
    expect(bodyOf("DELETE FROM system:active_requests").args).toEqual(["8a45dcda"]);
  });

  test("an operation Couchbase has no equivalent for is refused", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("vacuum", "inventory.hotel")).rejects.toThrow(/vacuum/);
  });

  test("a rejected maintenance statement is mapped like any other failure", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(13014, "User does not have credentials");

    await expect(provider.runMaintenance("kill", "8a45dcda")).rejects.toBeInstanceOf(AuthenticationError);
  });
});

// ============================================================================
// Query preparation
// ============================================================================

describe("CouchbaseProvider query preparation", () => {
  test("applies the external row limit to a SELECT", () => {
    const provider = new CouchbaseProvider(makeConnection());

    const prepared = provider.prepareQuery("SELECT * FROM `travel`.`inventory`.`hotel`", { limit: 25 });

    expect(prepared.query).toContain("LIMIT 25");
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.limit).toBe(25);
  });

  // Couchbase delegates to the shared limiter, so a comment-led SELECT is bounded
  // through the same fix rather than through anything of this provider's own (#275).
  test("applies the external row limit to a comment-led SELECT", () => {
    const provider = new CouchbaseProvider(makeConnection());

    const prepared = provider.prepareQuery("/* annotated */ SELECT * FROM `travel`.`inventory`.`hotel`", {
      limit: 25,
    });

    expect(prepared.query).toBe("/* annotated */ SELECT * FROM `travel`.`inventory`.`hotel` LIMIT 25");
    expect(prepared.wasLimited).toBe(true);
  });

  // Same inheritance for the trailing edge (#280): the bound has to land before a
  // closing comment, and a backtick-quoted path must not be mistaken for one.
  test("puts the bound before a trailing comment", () => {
    const provider = new CouchbaseProvider(makeConnection());

    const prepared = provider.prepareQuery("SELECT * FROM `travel`.`inventory`.`hotel` -- daily check", {
      limit: 25,
    });

    expect(prepared.query).toBe("SELECT * FROM `travel`.`inventory`.`hotel` LIMIT 25 -- daily check");
    expect(prepared.wasLimited).toBe(true);
  });

  test("leaves a mutation untouched", () => {
    const provider = new CouchbaseProvider(makeConnection());

    const prepared = provider.prepareQuery("DELETE FROM `travel`.`_default`.`airline`");

    expect(prepared.query).toBe("DELETE FROM `travel`.`_default`.`airline`");
    expect(prepared.wasLimited).toBe(false);
  });
});

// ============================================================================
// Object surface (#789)
//
// The rows below are EXACTLY what a live Couchbase Server 8.0.2 Community node
// running docker/couchbase-init/01-object-fixture.sh answers, re-aliased onto
// the projections `objects.ts` asks for. Every count in this block is that
// fixture's, so a claim here is re-measurable rather than invented.
//
// THE FAKE DISPATCHES ON STATEMENT CONTENT (standing ruling 5b), so a change to
// a statement is invisible to a behavioural assertion unless the statement text
// is itself asserted. The statement-text block below is what pins the parts a
// behavioural assertion cannot see, and the report sizes the gap by naming the
// mutations that survive without it.
// ============================================================================

const OBJECT_BUCKET_ROWS = [{ bucket_name: BUCKET }];

// `_system` is already excluded by the statement's own predicate, so it is not
// here; `_default` IS here, which is the whole reason system:all_scopes is read
// instead of system:scopes.
const OBJECT_SCOPE_ROWS = [{ scope_name: "_default" }, { scope_name: "inventory" }];

const OBJECT_COLLECTION_ROWS = [
  // The pre-scopes bucket-level row: no `bucket` and no `scope` field at all, and
  // `name` is the BUCKET's name. It is `_default`.`_default`, not a collection
  // called `travel`.
  { object_name: BUCKET },
  { bucket_id: BUCKET, scope_id: "_default", object_name: "bookings" },
  // The SAME collection name in the other scope. A collection name is unique per scope,
  // not per bucket, so a read that filtered a collection's indexes on the name alone would
  // hand this one `inventory`.`airline`'s.
  { bucket_id: BUCKET, scope_id: "_default", object_name: "airline" },
  { bucket_id: BUCKET, scope_id: "inventory", object_name: "hotel" },
  { bucket_id: BUCKET, scope_id: "inventory", object_name: "airline" },
];

const OBJECT_INDEX_ROWS = [
  // The bucket-level primary index, same pre-scopes row shape as above. A PRIMARY index
  // carries an EMPTY `index_key`: it keys the document key itself.
  { collection_id: BUCKET, object_name: "#primary", index_key: [], is_primary: true },
  // One index NAME on the two same-named collections of two scopes, over DIFFERENT keys,
  // so a scope-blind filter reports the wrong keys and not merely the wrong count.
  { bucket_id: BUCKET, scope_id: "_default", collection_id: "airline", object_name: "ix_name", index_key: ["`code`"] },
  { bucket_id: BUCKET, scope_id: "inventory", collection_id: "hotel", object_name: "ix_name", index_key: ["`name`"] },
  { bucket_id: BUCKET, scope_id: "inventory", collection_id: "airline", object_name: "ix_name", index_key: ["`name`"] },
  {
    bucket_id: BUCKET,
    scope_id: "inventory",
    collection_id: "airline",
    object_name: "#primary",
    index_key: [],
    is_primary: true,
  },
];

const OBJECT_FUNCTION_ROWS = [
  // GLOBAL: it belongs to the `default:` namespace, above every bucket, so it has
  // no container in a bucket/scope tree and must never be listed.
  { identity: { name: "celsius", namespace: "default", type: "global" } },
  // Another bucket's scope function. The statement reads the whole namespace, so the
  // bucket is matched in code and this row is what makes that check killable.
  { identity: { bucket: "other", scope: "inventory", name: "discount", namespace: "default", type: "scope" } },
  { identity: { bucket: BUCKET, scope: "_default", name: "discount", namespace: "default", type: "scope" } },
  { identity: { bucket: BUCKET, scope: "inventory", name: "discount", namespace: "default", type: "scope" } },
];

/**
 * INFER answers, keyed by the exact keyspace the statement names (#789).
 *
 * The bulk column read issues one INFER per described collection, and a fake answering ONE
 * canned flavour array whatever the statement said could not tell a read that attributes
 * each answer to its own collection from one that hands every collection the first
 * collection's fields. Only the keyspaces below differ from the default; everything else
 * still gets `OBJECT_INFER_FLAVOURS`, so the tests written before this map are untouched.
 */
const OBJECT_INFER_BY_KEYSPACE: Record<string, unknown[]> = {
  // `_default`.`airline`, the same collection NAME in the other scope, with fields of its
  // own: a bulk read that sampled by name would give it `inventory`.`airline`'s.
  // `~meta` rides along on every live INFER answer and is what `__id` is derived from, so
  // it is here too: a double that dropped it would let a read that loses the document key
  // pass.
  "`travel`.`_default`.`airline`": [
    {
      "#docs": 1,
      Flavor: "",
      properties: { code: { type: "string", "%docs": 100 }, "~meta": { properties: { id: { type: "string" } } } },
    },
  ],
  "`travel`.`_default`.`bookings`": [
    {
      "#docs": 1,
      Flavor: "",
      properties: { guest: { type: "string", "%docs": 100 }, "~meta": { properties: { id: { type: "string" } } } },
    },
  ],
};

const OBJECT_INFER_FLAVOURS = [
  {
    "#docs": 2,
    Flavor: "",
    properties: {
      name: { type: "string", "%docs": 100 },
      country: { type: "string", "%docs": 100 },
      fleet: { type: "number", "%docs": 100 },
      "~meta": { properties: { id: { type: "string" } } },
    },
  },
];

/** The object-surface reads, layered over the schema-explorer routing above. */
function objectQueryPayload(statement: string): unknown {
  if (statement.startsWith("INFER")) {
    for (const [keyspace, flavours] of Object.entries(OBJECT_INFER_BY_KEYSPACE)) {
      if (statement.includes(keyspace)) return queryPayload([flavours]);
    }
    return queryPayload([OBJECT_INFER_FLAVOURS]);
  }
  if (statement.includes("system:buckets")) return queryPayload(OBJECT_BUCKET_ROWS);
  if (statement.includes("system:all_scopes")) return queryPayload(OBJECT_SCOPE_ROWS);
  if (statement.includes("system:functions")) return queryPayload(OBJECT_FUNCTION_ROWS);
  if (statement.includes("object_name")) {
    return statement.includes("system:indexes")
      ? queryPayload(OBJECT_INDEX_ROWS)
      : queryPayload(OBJECT_COLLECTION_ROWS);
  }
  return defaultQueryPayload(statement);
}

describe("CouchbaseProvider object surface (#789)", () => {
  let objectProvider: CouchbaseProvider;

  beforeEach(async () => {
    queryHandler = objectQueryPayload;
    objectProvider = await connectProvider();
  });

  test("declares two container levels and three object kinds", () => {
    const capabilities = objectProvider.getCapabilities();

    expect(capabilities.containerLevels).toEqual([
      { id: "catalog", label: "Bucket", labelPlural: "Buckets" },
      { id: "schema", label: "Scope", labelPlural: "Scopes" },
    ]);
    expect(capabilities.objectKinds).toEqual([
      {
        id: "collection",
        role: "relation",
        label: "Collection",
        labelPlural: "Collections",
        acceptsRowWrites: true,
      },
      { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
      // `attachedTo` and not a bare container-level kind: measured on 8.0.2, one
      // index NAME lives on two collections of one scope, so the collection segment
      // is what makes the last segment unique within its parent.
      { id: "index", role: "config", label: "Index", labelPlural: "Indexes", attachedTo: "collection" },
    ]);
  });

  test("satisfies the shared object-surface contract", async () => {
    const { assertObjectSurface } = await import("../../helpers/object-surface-conformance");

    await assertObjectSurface(objectProvider, {
      containers: [[BUCKET]],
      kinds: { collection: 5, function: 2, index: 5 },
      sampleObject: { path: [BUCKET, "inventory", "airline"], kind: "collection" },
    });
  });

  // --------------------------------------------------------------------------
  // listContainers
  // --------------------------------------------------------------------------

  test("lists buckets at level 0 and marks the connection's own", async () => {
    expect(await objectProvider.listContainers()).toEqual([
      { path: [BUCKET], name: BUCKET, level: 0, isSessionDefault: true },
    ]);
  });

  test("lists a bucket's scopes and marks _default as the session's", async () => {
    // Standing ruling 5a2: a two-level engine that marked `isSessionDefault` only on
    // the bucket would leave first paint opening the bucket and stopping, having read
    // no counts at all.
    expect(await objectProvider.listContainers([BUCKET])).toEqual([
      { path: [BUCKET, "_default"], name: "_default", level: 1, isSessionDefault: true },
      { path: [BUCKET, "inventory"], name: "inventory", level: 1, isSessionDefault: false },
    ]);
  });

  test("marks no scope of another bucket as the session default", async () => {
    const containers = await objectProvider.listContainers(["other"]);
    expect(containers.map((container) => container.isSessionDefault)).toEqual([false, false]);
  });

  test("answers nothing below the deepest declared level without a round trip", async () => {
    queryBodies = [];
    expect(await objectProvider.listContainers([BUCKET, "inventory"])).toEqual([]);
    expect(queryBodies).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // countObjects and listObjects
  // --------------------------------------------------------------------------

  test("counts the whole bucket, including the pre-scopes bucket-level rows", async () => {
    expect(await objectProvider.countObjects([BUCKET])).toEqual({
      collection: { count: 5 },
      function: { count: 2 },
      index: { count: 5 },
    });
  });

  test("counts one scope", async () => {
    expect(await objectProvider.countObjects([BUCKET, "inventory"])).toEqual({
      collection: { count: 2 },
      function: { count: 1 },
      index: { count: 3 },
    });
    expect(await objectProvider.countObjects([BUCKET, "_default"])).toEqual({
      collection: { count: 3 },
      function: { count: 1 },
      index: { count: 2 },
    });
  });

  test("places the bucket-level keyspace row in _default._default rather than in a collection named after the bucket", async () => {
    const collections = await objectProvider.listObjects([BUCKET, "_default"], "collection");
    expect(collections.map((object) => object.path)).toEqual([
      [BUCKET, "_default", "_default"],
      [BUCKET, "_default", "airline"],
      [BUCKET, "_default", "bookings"],
    ]);
    // The DISPLAY name of the bucket-level row is `_default`, not `travel`.
    expect(collections[0].name).toBe("_default");
  });

  test("addresses an index through its collection, so one name on two collections is two paths", async () => {
    const indexes = await objectProvider.listObjects([BUCKET, "inventory"], "index");
    expect(indexes.map((object) => object.path)).toEqual([
      [BUCKET, "inventory", "airline", "#primary"],
      [BUCKET, "inventory", "airline", "ix_name"],
      [BUCKET, "inventory", "hotel", "ix_name"],
    ]);
  });

  test("excludes a global function, which belongs to the namespace above every bucket", async () => {
    const functions = await objectProvider.listObjects([BUCKET], "function");
    expect(functions.map((object) => object.path)).toEqual([
      [BUCKET, "_default", "discount"],
      [BUCKET, "inventory", "discount"],
    ]);
    expect(functions.map((object) => object.name)).toEqual(["discount", "discount"]);
  });

  test("seeds every declared kind at zero so an empty scope keeps its folders", async () => {
    queryHandler = (statement) =>
      statement.includes("system:buckets") || statement.includes("system:all_scopes")
        ? objectQueryPayload(statement)
        : queryPayload([]);
    expect(await objectProvider.countObjects([BUCKET])).toEqual({
      collection: { count: 0 },
      function: { count: 0 },
      index: { count: 0 },
    });
  });

  test("carries the cluster's own sentence for a refused catalog read rather than a zero nobody measured", async () => {
    queryHandler = () => errorPayload(13014, "User does not have credentials to run queries");
    const counts = await objectProvider.countObjects([BUCKET]);
    expect(counts).toEqual({
      collection: { unavailable: expect.stringContaining("credentials") },
      function: { unavailable: expect.stringContaining("credentials") },
      index: { unavailable: expect.stringContaining("credentials") },
    });
  });

  test("never counts a kind the declaration does not carry", async () => {
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...objectProvider.getCapabilities(),
      objectKinds: [{ id: "function", role: "routine", label: "Function", labelPlural: "Functions" }],
    });
    expect(await objectProvider.countObjects([BUCKET])).toEqual({ function: { count: 2 } });
  });

  test("refuses a container path of the wrong shape rather than answering an empty bucket", async () => {
    await expect(objectProvider.countObjects([])).rejects.toThrow(/container path is \[bucket\] or \[bucket, scope\]/);
    await expect(objectProvider.countObjects([BUCKET, "inventory", "airline"])).rejects.toThrow(
      /container path is \[bucket\] or \[bucket, scope\]/,
    );
  });

  test("refuses a kind this engine does not declare", async () => {
    await expect(objectProvider.listObjects([BUCKET], "view")).rejects.toThrow(/declares no object kind "view"/);
    await expect(objectProvider.describeObject([BUCKET, "_default", "v"], "view")).rejects.toThrow(
      /declares no object kind "view"/,
    );
  });

  // --------------------------------------------------------------------------
  // describeObject
  // --------------------------------------------------------------------------

  test("describes a collection with its inferred fields and its own indexes", async () => {
    const detail = await objectProvider.describeObject([BUCKET, "inventory", "airline"], "collection");

    expect(detail.path).toEqual([BUCKET, "inventory", "airline"]);
    expect(detail.columns.map((column) => column.name)).toEqual(["__id", "country", "fleet", "name"]);
    expect(detail.columns[0].isPrimary).toBe(true);
    expect(detail.indexes).toEqual([
      { name: "#primary", columns: ["META().id"], unique: true },
      { name: "ix_name", columns: ["name"], unique: false },
    ]);
    // SQL++ has no referential constraint at all, which is the same measurement
    // behind `declaresForeignKeys: false`.
    expect(detail.foreignKeys).toEqual([]);
  });

  test("describes an empty collection as a collection with no columns rather than failing", async () => {
    // INFER answers error 7014, "No documents found, unable to infer schema", on an
    // empty collection. That is an ordinary state and the fixture leaves `hotel`
    // empty so it stays measured.
    queryHandler = (statement) =>
      statement.startsWith("INFER")
        ? errorPayload(7014, "No documents found, unable to infer schema")
        : objectQueryPayload(statement);
    const detail = await objectProvider.describeObject([BUCKET, "inventory", "hotel"], "collection");
    expect(detail.columns).toEqual([]);
    expect(detail.indexes).toEqual([{ name: "ix_name", columns: ["name"], unique: false }]);
  });

  test("keeps two same-named collections of two scopes apart when reading their indexes", async () => {
    // `airline` exists in BOTH `_default` and `inventory`, each with its own `ix_name`
    // over a different key. A filter on the collection name alone answers the same two
    // indexes for both and would put `inventory`'s key on `_default`'s collection.
    const inDefault = await objectProvider.describeObject([BUCKET, "_default", "airline"], "collection");
    expect(inDefault.indexes).toEqual([{ name: "ix_name", columns: ["code"], unique: false }]);

    const inInventory = await objectProvider.describeObject([BUCKET, "inventory", "airline"], "collection");
    expect(inInventory.indexes).toEqual([
      { name: "#primary", columns: ["META().id"], unique: true },
      { name: "ix_name", columns: ["name"], unique: false },
    ]);
  });

  test("describes a function and an index without claiming columns neither has", async () => {
    const fn = await objectProvider.describeObject([BUCKET, "inventory", "discount"], "function");
    expect(fn).toEqual({ path: [BUCKET, "inventory", "discount"], columns: [], indexes: [], foreignKeys: [] });

    const index = await objectProvider.describeObject([BUCKET, "inventory", "airline", "ix_name"], "index");
    expect(index).toEqual({
      path: [BUCKET, "inventory", "airline", "ix_name"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
  });

  test("refuses an object path of the wrong depth for its kind", async () => {
    await expect(objectProvider.describeObject([BUCKET, "airline"], "collection")).rejects.toThrow(
      /"collection" path is \[bucket, scope, name\]/,
    );
    // An index carries the collection it is attached to, so its path is one longer.
    await expect(objectProvider.describeObject([BUCKET, "inventory", "ix_name"], "index")).rejects.toThrow(
      /"index" path is \[bucket, scope, collection, name\]/,
    );
  });

  // --------------------------------------------------------------------------
  // describeObjects, the bulk column read (#789)
  // --------------------------------------------------------------------------

  /** Every statement the fake was sent since the last reset, in order. */
  function statementsIssued(): string[] {
    return queryBodies.map((body) => String(body.statement));
  }

  /** The keyspace each INFER named, in the order the statements were sent. */
  function inferredKeyspaces(): string[] {
    return statementsIssued()
      .filter((statement) => statement.startsWith("INFER"))
      .map((statement) => statement.replace(/^INFER /, "").replace(/ WITH .*$/, ""));
  }

  test("describes a whole folder with ONE index read and one INFER per described collection", async () => {
    queryBodies = [];
    const batch = await objectProvider.describeObjects!([BUCKET], "collection");

    expect(batch.details.map((detail) => detail.path)).toEqual([
      [BUCKET, "_default", "_default"],
      [BUCKET, "_default", "airline"],
      [BUCKET, "_default", "bookings"],
      [BUCKET, "inventory", "airline"],
      [BUCKET, "inventory", "hotel"],
    ]);
    expect(batch.truncated).toBeUndefined();

    // ONE system:indexes read for the whole batch, where `describeObject` issues that same
    // whole-bucket statement once per object: five objects cost two catalog statements
    // here and ten there. The INFER count is irreducible - measured on 8.0.2, INFER takes
    // exactly one keyspace - so it is asserted rather than hidden.
    const catalog = statementsIssued().filter((statement) => !statement.startsWith("INFER"));
    expect(catalog.filter((statement) => statement.includes("system:indexes"))).toHaveLength(1);
    expect(catalog.filter((statement) => statement.includes("system:keyspaces"))).toHaveLength(1);
    expect(inferredKeyspaces()).toEqual([
      "`travel`.`_default`.`_default`",
      "`travel`.`_default`.`airline`",
      "`travel`.`_default`.`bookings`",
      "`travel`.`inventory`.`airline`",
      "`travel`.`inventory`.`hotel`",
    ]);
  });

  test("gives each collection its OWN columns and its OWN indexes", async () => {
    const batch = await objectProvider.describeObjects!([BUCKET], "collection");
    const of = (scope: string, name: string) =>
      batch.details.find((detail) => detail.path[1] === scope && detail.path[2] === name)!;

    // `airline` exists in both scopes. Sampling or filtering by the collection NAME alone
    // hands one of them the other's fields and the other's index keys.
    expect(of("_default", "airline").columns.map((column) => column.name)).toEqual(["__id", "code"]);
    expect(of("_default", "airline").indexes).toEqual([{ name: "ix_name", columns: ["code"], unique: false }]);
    expect(of("inventory", "airline").columns.map((column) => column.name)).toEqual([
      "__id",
      "country",
      "fleet",
      "name",
    ]);
    expect(of("inventory", "airline").indexes).toEqual([
      { name: "#primary", columns: ["META().id"], unique: true },
      { name: "ix_name", columns: ["name"], unique: false },
    ]);
    expect(of("_default", "bookings").columns.map((column) => column.name)).toEqual(["__id", "guest"]);
    // SQL++ has no referential constraint at all.
    expect(batch.details.every((detail) => detail.foreignKeys.length === 0)).toBe(true);
  });

  test("the bulk read spells an object exactly as the single read does", async () => {
    const listed = await objectProvider.listObjects([BUCKET], "collection");
    const batch = await objectProvider.describeObjects!([BUCKET], "collection");

    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    for (const detail of batch.details) {
      expect(detail).toEqual(await objectProvider.describeObject(detail.path, "collection"));
    }
  });

  test("an INFER the server refuses leaves that collection with no columns, not the batch in ruins", async () => {
    // Error 7014, "No documents found, unable to infer schema", is what an EMPTY collection
    // answers, and the fixture keeps `hotel` and `bookings` empty because it is an ordinary
    // state. It is also why the columns are read one INFER at a time: measured on 8.0.2, a
    // single statement unioning several INFERs fails ENTIRELY on the first empty keyspace,
    // so one empty collection would cost the whole folder its columns.
    queryHandler = (statement) =>
      statement.startsWith("INFER `travel`.`inventory`.`hotel`")
        ? errorPayload(7014, "No documents found, unable to infer schema")
        : objectQueryPayload(statement);

    const batch = await objectProvider.describeObjects!([BUCKET], "collection");
    const hotel = batch.details.find((detail) => detail.path[2] === "hotel")!;
    expect(hotel.columns).toEqual([]);
    expect(hotel.indexes).toEqual([{ name: "ix_name", columns: ["name"], unique: false }]);
    expect(batch.details).toHaveLength(5);
  });

  test("the caller's bound cuts the sorted objects and reaches the INFERs", async () => {
    queryBodies = [];
    const batch = await objectProvider.describeObjects!([BUCKET], "collection", 2);

    expect(batch.details.map((detail) => detail.path)).toEqual([
      [BUCKET, "_default", "_default"],
      [BUCKET, "_default", "airline"],
    ]);
    expect(batch.truncated).toEqual({
      limit: 2,
      reason: "the bulk column read was bounded at 2 objects by its caller",
    });
    // The bound reaches the EXPENSIVE half: three of the five INFERs are never sent. A cut
    // applied after the reads would answer the same two objects for the whole folder's cost.
    expect(inferredKeyspaces()).toEqual(["`travel`.`_default`.`_default`", "`travel`.`_default`.`airline`"]);
  });

  test("a bound the folder fits inside reports nothing, on either side of the boundary", async () => {
    expect((await objectProvider.describeObjects!([BUCKET], "collection", 5)).truncated).toBeUndefined();
    expect((await objectProvider.describeObjects!([BUCKET], "collection", 6)).truncated).toBeUndefined();
  });

  test("a scope is a container of its own, and the batch holds only its collections", async () => {
    const batch = await objectProvider.describeObjects!([BUCKET, "inventory"], "collection");
    expect(batch.details.map((detail) => detail.path)).toEqual([
      [BUCKET, "inventory", "airline"],
      [BUCKET, "inventory", "hotel"],
    ]);
  });

  test("a kind with no columns answers an empty batch with no round trip at all", async () => {
    // A function's parameters and an index's keys are not columns, and `describeObject`
    // answers three empty arrays for both. The batch says the same thing by holding
    // nothing, and says it without asking the cluster anything.
    for (const kind of ["function", "index"]) {
      queryBodies = [];
      expect(await objectProvider.describeObjects!([BUCKET], kind)).toEqual({ details: [] });
      expect(queryBodies).toEqual([]);
    }
  });

  test("an undeclared kind is refused by the DECLARATION, naming the engine and the kind", async () => {
    await expect(objectProvider.describeObjects!([BUCKET], "view")).rejects.toThrow(
      /Couchbase declares no object kind "view"/,
    );
  });

  test("a container path of the wrong shape is refused before anything is read", async () => {
    queryBodies = [];
    await expect(objectProvider.describeObjects!([], "collection")).rejects.toThrow(
      /container path is \[bucket\] or \[bucket, scope\], received \[\]/,
    );
    await expect(objectProvider.describeObjects!([BUCKET, "inventory", "airline"], "collection")).rejects.toThrow(
      /container path is \[bucket\] or \[bucket, scope\]/,
    );
    expect(queryBodies).toEqual([]);
  });

  test("a limit that is not a positive whole number is refused, never clamped", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(objectProvider.describeObjects!([BUCKET], "collection", limit)).rejects.toThrow(
        /bulk column read limit must be a positive whole number/,
      );
    }
    // Guard ORDER: the declaration first, then the container, then the limit. A `0` against
    // an undeclared kind must report the KIND, and against a bad container the CONTAINER.
    await expect(objectProvider.describeObjects!([BUCKET], "view", 0)).rejects.toThrow(/declares no object kind/);
    await expect(objectProvider.describeObjects!([], "collection", 0)).rejects.toThrow(
      /container path is \[bucket\] or \[bucket, scope\]/,
    );
  });

  test("a refused catalog read raises rather than answering an empty folder", async () => {
    queryHandler = (statement) =>
      statement.includes("system:keyspaces")
        ? errorPayload(13014, "User does not have credentials to run queries")
        : objectQueryPayload(statement);
    await expect(objectProvider.describeObjects!([BUCKET], "collection")).rejects.toThrow(/does not have credentials/);
  });

  /**
   * Standing ruling 5g on the fifth method, driven to the BOUND VALUE rather than to a
   * refusal: with the declaration reversed, a positional read binds the scope as the bucket.
   */
  test("the bulk read follows the DECLARED levels, not the container's positions", async () => {
    const capabilities = objectProvider.getCapabilities();
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [
        { id: "schema", label: "Scope", labelPlural: "Scopes" },
        { id: "catalog", label: "Bucket", labelPlural: "Buckets" },
      ],
    });

    queryBodies = [];
    const batch = await objectProvider.describeObjects!(["inventory", BUCKET], "collection", 1);

    expect(batch.details.map((detail) => detail.path)).toEqual([["inventory", BUCKET, "airline"]]);
    expect(bodyOf("system:keyspaces").args).toEqual([BUCKET]);
    expect(bodyOf("system:indexes").args).toEqual([BUCKET]);
    // The INFER statement is built bucket-first from the declared ids, not from the path.
    expect(inferredKeyspaces()).toEqual(["`travel`.`inventory`.`airline`"]);
  });

  // --------------------------------------------------------------------------
  // Standing ruling 5g: no position is read out of a path or a container
  // --------------------------------------------------------------------------

  test("reads every container segment by its DECLARED level, not by its position", async () => {
    // Couchbase already declares two levels, so `container.length !== 1` and `path[1]`
    // are wrong here rather than merely fragile. What a same-depth engine still cannot
    // tell apart is a segment read by POSITION from one read by declared id, because
    // both spellings agree while the declared order happens to be [catalog, schema].
    // Reversing the declaration separates them, and the assertion is on the BOUND
    // VALUE the cluster was sent rather than on a refusal.
    const capabilities = objectProvider.getCapabilities();
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [
        { id: "schema", label: "Scope", labelPlural: "Scopes" },
        { id: "catalog", label: "Bucket", labelPlural: "Buckets" },
      ],
    });

    queryBodies = [];
    const counts = await objectProvider.countObjects(["inventory", BUCKET]);
    expect(counts).toEqual({ collection: { count: 2 }, function: { count: 1 }, index: { count: 3 } });
    // THE BOUND VALUE. `container[0]` would have bound "inventory" as the bucket.
    expect(bodyOf("system:keyspaces").args).toEqual([BUCKET]);
    expect(bodyOf("system:indexes").args).toEqual([BUCKET]);

    // And the object name is the LAST segment at whatever depth the declaration makes.
    const listed = await objectProvider.listObjects(["inventory", BUCKET], "index");
    expect(listed.map((object) => object.path)).toEqual([
      ["inventory", BUCKET, "airline", "#primary"],
      ["inventory", BUCKET, "airline", "ix_name"],
      ["inventory", BUCKET, "hotel", "ix_name"],
    ]);

    queryBodies = [];
    const detail = await objectProvider.describeObject(["inventory", BUCKET, "airline"], "collection");
    expect(detail.path).toEqual(["inventory", BUCKET, "airline"]);
    // The INFER statement names the keyspace bucket-first, from the declared ids and
    // not from the path's order.
    expect(String(bodyOf("INFER").statement)).toContain("INFER `travel`.`inventory`.`airline`");
  });

  test("reads a RELATION's own collection as the last segment, not as a fixed position", async () => {
    // At three segments `path[2]` and `path[path.length - 1]` are the same read, and every
    // relation this engine has sits at three. So the DECLARATION is varied instead: a
    // `collection` kind carrying `attachedTo` is addressed at four segments, and the two
    // spellings then name different things. The assertion is on the keyspace the INFER
    // statement was BUILT with, not on a refusal.
    const capabilities = objectProvider.getCapabilities();
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      objectKinds: [
        {
          id: "collection",
          role: "relation",
          label: "Collection",
          labelPlural: "Collections",
          attachedTo: "collection",
        },
      ],
    });

    queryBodies = [];
    const detail = await objectProvider.describeObject([BUCKET, "inventory", "airline", "airline_v2"], "collection");
    expect(detail.path).toEqual([BUCKET, "inventory", "airline", "airline_v2"]);
    // `path[2]` would have sampled the BASE collection `airline` instead.
    expect(String(bodyOf("INFER").statement)).toContain("INFER `travel`.`inventory`.`airline_v2`");
  });

  test("places a catalog row carrying a bucket but no scope in _default rather than dropping it", async () => {
    // This row SHAPE was not observed on 8.0.2: every `system:keyspaces` row that carries
    // a `bucket` carries a `scope` too, and a row with neither is the pre-scopes
    // bucket-level row, which the branch above already owns. The rule is pinned anyway,
    // because the alternative to placing such a row is dropping an object out of the count
    // AND the listing at once, which is the absence standing ruling 5a exists for.
    queryHandler = (statement) =>
      statement.includes("object_name") && !statement.includes("system:indexes")
        ? queryPayload([{ bucket_id: BUCKET, object_name: "orphan" }])
        : objectQueryPayload(statement);
    const listed = await objectProvider.listObjects([BUCKET], "collection");
    expect(listed.map((object) => object.path)).toEqual([[BUCKET, "_default", "orphan"]]);
  });

  test("places an index row carrying a bucket but no keyspace in _default rather than dropping it", async () => {
    // The SAME placement rule as the sibling above, on the other half of the row. An index
    // row that carries a `bucket_id` but names no keyspace was not observed on 8.0.2
    // either, and neither shape can be pinned by refuting it: the reason to place it is
    // that the alternative is a row leaving the COUNT and the LISTING at once, which is
    // standing ruling 5a's invisible absence. Dropping it would still satisfy ruling 5f,
    // and that is exactly why 5f cannot be the test.
    queryHandler = (statement) =>
      statement.includes("object_name") && statement.includes("system:indexes")
        ? queryPayload([{ bucket_id: BUCKET, scope_id: "inventory", object_name: "ix_orphan", index_key: [] }])
        : objectQueryPayload(statement);
    const listed = await objectProvider.listObjects([BUCKET], "index");
    expect(listed.map((object) => object.path)).toEqual([[BUCKET, "inventory", "_default", "ix_orphan"]]);
    expect((await objectProvider.countObjects([BUCKET])).index).toEqual({ count: 1 });
  });

  test("orders paths segment by segment, shorter first where one is a prefix of the other", async () => {
    const { comparePaths } = await import("@/lib/db/object-path");

    // The MIXED-DEPTH arm. Standing ruling 5f blesses a kind whose rows sit at two depths,
    // and `JSON.stringify` orders those backwards: `,` (0x2C) is below `]` (0x5D), so a
    // serialised deeper path sorts before its own prefix. No kind here mixes depth today,
    // so the rule is pinned directly rather than through a listing that cannot show it.
    expect(comparePaths([BUCKET, "inventory"], [BUCKET, "inventory", "airline"])).toBeLessThan(0);
    expect(comparePaths([BUCKET, "inventory", "airline"], [BUCKET, "inventory"])).toBeGreaterThan(0);
    expect(comparePaths([BUCKET, "inventory"], [BUCKET, "inventory"])).toBe(0);
  });

  test("classifies a function row by where it says it lives, never by identity.type", async () => {
    const { resolveFunctionIdentity } = await import("@/lib/db/providers/document/couchbase/objects");

    // A GLOBAL function: no bucket and no scope, so it has no container in a bucket/scope
    // tree. Read structurally, so a future third `type` is placed rather than dropped.
    expect(resolveFunctionIdentity({ identity: { name: "celsius", type: "global" } })).toBeUndefined();
    // A scope function whose `type` is a spelling this provider has never seen is still
    // placed, because the bucket and the scope are what say where it lives.
    expect(
      resolveFunctionIdentity({ identity: { bucket: "b", scope: "s", name: "f", type: "something-new" } }),
    ).toEqual({ bucket: "b", scope: "s", name: "f" });
    // A row carrying no identity at all addresses nothing.
    expect(resolveFunctionIdentity({})).toBeUndefined();
  });

  test("refuses a declaration carrying no bucket level rather than binding undefined", async () => {
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...objectProvider.getCapabilities(),
      containerLevels: [{ id: "schema", label: "Scope", labelPlural: "Scopes" }],
    });
    await expect(objectProvider.countObjects(["inventory"])).rejects.toThrow(
      /needs a "catalog" container level and a segment for it/,
    );
  });

  // --------------------------------------------------------------------------
  // Statement text. The fake routes on statement content, so these are the only
  // assertions that can see a change to the statements themselves.
  // --------------------------------------------------------------------------

  test("reads the catalogs the measurements name, and no others", async () => {
    queryBodies = [];
    await objectProvider.listContainers();
    await objectProvider.listContainers([BUCKET]);
    await objectProvider.countObjects([BUCKET]);
    const statements = queryBodies.map((body) => String(body.statement));

    // system:all_scopes and NOT system:scopes: measured on 8.0.2, system:scopes
    // returns neither `_default` nor `_system` while COUNT(*) over it counts both,
    // so reading it would lose the scope that holds most of the bucket's collections.
    expect(statements.some((statement) => statement.includes("system:all_scopes"))).toBe(true);
    expect(statements.some((statement) => /system:scopes\b/.test(statement))).toBe(false);
    // `_system` is excluded by exact NAME. A user scope cannot start with `_`
    // ("First character must not be _ or %", measured), so nothing a person creates
    // can be hidden by it and `_default` is not swept up with it.
    expect(statements.some((statement) => statement.includes('s.name != "_system"'))).toBe(true);

    // system:keyspaces and system:indexes, NOT their `all_` variants: the `all_`
    // forms carry the `_system` scope, the `#sequentialscan` pseudo-index and a
    // DUPLICATE of the bucket-level row, which would give one collection two paths.
    expect(statements.some((statement) => /FROM system:keyspaces\b/.test(statement))).toBe(true);
    expect(statements.some((statement) => /system:all_keyspaces/.test(statement))).toBe(false);
    expect(statements.some((statement) => /system:all_indexes/.test(statement))).toBe(false);

    // No COUNT(*) anywhere in the object surface. Measured on 8.0.2: COUNT(*) over a
    // `system:` keyspace can count rows the same catalog's projection does not return
    // (system:scopes answers 4 and 2), so a count taken that way would badge a number
    // the folder can never show. Every count here is the length of the rows the
    // listing itself returns.
    expect(statements.some((statement) => statement.includes("COUNT(*)"))).toBe(false);

    // Both reserved words stay backtick-quoted: unquoted, the projection is error
    // 3000 on 8.0.2.
    expect(statements.some((statement) => statement.includes("`bucket`"))).toBe(true);

    // THE PRE-SCOPES BUCKET-LEVEL BRANCH, in both object statements. `_default`.`_default`
    // and any index on it appear as a row carrying no `bucket`/`bucket_id` at all, whose
    // name is the BUCKET's, so dropping this branch hides every document written before
    // scopes existed. The fake routes on statement content and cannot see the predicate
    // change, so this is the only assertion that can.
    expect(statements.some((statement) => statement.includes("k.`bucket` IS MISSING AND k.name = $1"))).toBe(true);
    expect(statements.some((statement) => statement.includes("i.bucket_id IS MISSING AND i.keyspace_id = $1"))).toBe(
      true,
    );
  });

  test("binds the bucket rather than interpolating it into the statement", async () => {
    queryBodies = [];
    await objectProvider.countObjects(["other-bucket"]);
    for (const body of queryBodies) {
      const statement = String(body.statement);
      if (statement.includes("system:functions")) continue;
      expect(statement).not.toContain("other-bucket");
      expect(body.args).toEqual(["other-bucket"]);
    }
  });
});
