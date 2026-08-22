/**
 * Couchbase Provider Integration Tests (issue #262)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun and would poison sibling
 * test files. Every payload below was captured from a live Couchbase Server
 * 8.0.2 Community node, so the fake speaks exactly what the cluster speaks.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { CouchbaseProvider } from "@/lib/db/providers/document/couchbase";
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
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["analyze", "reindex", "kill"],
      supportsConnectionString: true,
      defaultPort: 8091,
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

describe("CouchbaseProvider schema", () => {
  test("getSchemaList flattens scopes and infers columns", async () => {
    const provider = await connectProvider();

    const tables = await provider.getSchemaList();

    expect(tables.map((table) => table.name)).toEqual(["airline", "inventory.hotel"]);
    expect(tables[0].columns.map((column) => column.name)).toEqual(["__id", "city"]);
    expect(tables[0].indexes).toEqual([]);
  });

  test("getSchemaRelations lists indexes and never invents foreign keys", async () => {
    const provider = await connectProvider();

    const relations = await provider.getSchemaRelations();

    expect(relations.map((relation) => relation.name)).toEqual(["airline", "inventory.hotel"]);
    expect(relations[0].indexes[0]).toEqual({ name: "#primary", columns: ["META().id"], unique: true });
    expect(relations[0].foreignKeys).toEqual([]);
  });

  test("getSchema merges indexes into the inferred columns", async () => {
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["airline", "inventory.hotel"]);
    expect(schema[1].indexes.map((index) => index.name)).toEqual(["idx_hotel_city"]);
    expect(schema[1].columns.length).toBeGreaterThan(0);
  });

  test("getTables lists collections without paying for INFER", async () => {
    const provider = await connectProvider();

    const tables = await provider.getTables();

    expect(tables).toEqual(["airline", "inventory.hotel"]);
    expect(queryBodies.some((body) => String(body.statement).startsWith("INFER"))).toBe(false);
  });

  test("a denied catalog read surfaces as an AuthenticationError", async () => {
    const provider = await connectProvider();
    queryHandler = () => errorPayload(13014, "User does not have credentials to run queries");

    await expect(provider.getSchemaRelations()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

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

  test("getPerformanceMetrics reports zero rather than a perfect score when denied", async () => {
    const provider = await connectProvider();
    stubManage(`/pools/default/buckets/${BUCKET}`, {}, 403);

    const performance = await provider.getPerformanceMetrics();

    expect(performance.cacheHitRatio).toBe(0);
    expect(performance.queriesPerSecond).toBe(0);
    expect(performance.bufferPoolUsage).toBe(0);
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
      indexSize: "0 B",
      indexSizeBytes: 0,
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
    expect(data.performance.cacheHitRatio).toBe(0);
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
