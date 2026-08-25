/**
 * MongoDB Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'mongodb' driver
 * before importing the MongoDBProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";

// ============================================================================
// Mock Setup — MUST come before provider import
// ============================================================================

// Track mock instances for assertions
let mockCollectionData: Record<string, unknown>[] = [];
let mockCollections: { name: string; type: string }[] = [
  { name: "users", type: "collection" },
  { name: "orders", type: "collection" },
];
let mockCurrentOps: Record<string, unknown>[] = [];
// The URI `buildConnectionString()` composed, as the driver received it. The only
// place the query string is observable: `MongoClient` is where it goes.
let lastMongoUri = "";
// The options object the driver received. TLS is observable nowhere else: the
// `MongoClient` constructor is the only place it is stated.
let lastMongoOptions: Record<string, unknown> = {};

const createMockCursor = (data: Record<string, unknown>[]) => {
  const cursor = {
    project: () => cursor,
    sort: () => cursor,
    skip: () => cursor,
    limit: () => cursor,
    toArray: async () => data,
    close: async () => {},
  };
  return cursor;
};

/**
 * The server's own answer for a command that is not supported on a view: code 166,
 * `CommandNotSupportedOnView`. Reproduced here because it is what one view in a
 * database used to do to the WHOLE schema read - `estimatedDocumentCount()` and
 * `indexes()` were unguarded, so the first view aborted every collection after it.
 */
const commandNotSupportedOnView = (command: string, name: string): Error => {
  const error = new Error(`Namespace testdb.${name} is a view, not a collection`) as Error & { code: number };
  error.code = 166;
  error.name = `MongoServerError(${command})`;
  return error;
};

const isMockView = (name: string): boolean => mockCollections.some((c) => c.name === name && c.type === "view");

const createMockCollection = (name = "users") => ({
  find: () => createMockCursor(mockCollectionData),
  findOne: async () => mockCollectionData[0] || null,
  aggregate: () => ({
    toArray: async () => mockCollectionData,
  }),
  countDocuments: async () => mockCollectionData.length,
  distinct: async (field: string) => mockCollectionData.map((d) => d[field]),
  insertOne: async () => ({
    insertedId: "new-id-123",
    acknowledged: true,
  }),
  insertMany: async (docs: Record<string, unknown>[]) => ({
    insertedCount: docs.length,
    insertedIds: docs.map((_, i) => `id-${i}`),
  }),
  updateOne: async () => ({
    matchedCount: 1,
    modifiedCount: 1,
  }),
  updateMany: async () => ({
    matchedCount: 2,
    modifiedCount: 2,
  }),
  deleteOne: async () => ({ deletedCount: 1 }),
  deleteMany: async () => ({ deletedCount: 3 }),
  estimatedDocumentCount: async () => {
    if (isMockView(name)) throw commandNotSupportedOnView("count", name);
    return 42;
  },
  indexes: async () => {
    if (isMockView(name)) throw commandNotSupportedOnView("listIndexes", name);
    return [
      { name: "_id_", key: { _id: 1 }, unique: true },
      { name: "email_1", key: { email: 1 }, unique: false },
    ];
  },
});

const mockCommandResults: Record<string, unknown> = {};

/**
 * What `serverStatus` answers, as a function rather than a literal: the metric
 * paths have to be driven on a server that publishes NO `wiredTiger` section
 * (mongos, the in-memory storage engine, an API-compatible service) and on one
 * where the command fails outright. Both used to reach the panel as a cache hit
 * ratio of 99%.
 */
const defaultServerStatus = () => ({
  connections: { current: 5, available: 95 },
  uptime: 86400,
  wiredTiger: {
    cache: {
      "pages read into cache": 10,
      "pages requested from the cache": 1000,
      "bytes currently in the cache": 5000000,
      "maximum bytes configured": 10000000,
    },
  },
  opcounters: { query: 100, insert: 50, update: 30, delete: 20 },
});

let mockServerStatus: () => Record<string, unknown> = defaultServerStatus;

const createMockDb = () => ({
  command: async (cmd: Record<string, unknown>) => {
    if (cmd.ping) return { ok: 1 };
    if (cmd.collStats) {
      if (isMockView(String(cmd.collStats))) throw commandNotSupportedOnView("collStats", String(cmd.collStats));
      return { size: 1024, totalIndexSize: 512, count: 42 };
    }
    if (cmd.validate) return { ok: 1, valid: true };
    if (cmd.compact) return { ok: 1 };
    return mockCommandResults;
  },
  listCollections: () => ({
    toArray: async () => mockCollections,
  }),
  collection: (name?: string) => createMockCollection(name),
  stats: async () => ({
    dataSize: 2048,
    indexSize: 512,
    storageSize: 4096,
    collections: 2,
    objects: 100,
  }),
  admin: () => ({
    serverStatus: async () => mockServerStatus(),
    command: async (cmd: Record<string, unknown>) => {
      if (cmd.currentOp) return { inprog: mockCurrentOps };
      if (cmd.buildInfo) return { version: "7.0.0" };
      return {};
    },
  }),
});

class MockObjectId {
  private _str: string;
  constructor(str?: string) {
    this._str = str || "mock-object-id-123456789012";
  }
  toString() {
    return this._str;
  }
}

class MockBinary {
  private _data: Buffer;
  constructor(data?: Buffer | string) {
    this._data = Buffer.from(data || "binary-data");
  }
  length() {
    return this._data.length;
  }
}

class MockDecimal128 {
  private _val: string;
  constructor(val?: string) {
    this._val = val || "123.456";
  }
  toString() {
    return this._val;
  }
}

mock.module("mongodb", () => ({
  MongoClient: class MockMongoClient {
    private _uri: string;
    private _opts: unknown;

    constructor(uri: string, opts?: unknown) {
      this._uri = uri;
      this._opts = opts;
      lastMongoUri = uri;
      lastMongoOptions = (opts ?? {}) as Record<string, unknown>;
    }

    async connect() {
      // noop — connection established
    }

    async close() {
      // noop — connection closed
    }

    db() {
      return createMockDb();
    }
  },
  ObjectId: MockObjectId,
  Binary: MockBinary,
  Decimal128: MockDecimal128,
}));

// ============================================================================
// Provider import — AFTER mock registration
// ============================================================================

const { MongoDBProvider } = await import("@/lib/db/providers/document/mongodb");
const { DatabaseConfigError } = await import("@/lib/db/errors");

// ============================================================================
// Test Config
// ============================================================================

const baseConfig: DatabaseConnection = {
  id: "test-mongo",
  name: "Test Mongo",
  type: "mongodb",
  host: "localhost",
  port: 27017,
  database: "testdb",
  createdAt: new Date(),
};

// ============================================================================
// Tests
// ============================================================================

describe("MongoDBProvider", () => {
  let provider: InstanceType<typeof MongoDBProvider>;

  beforeEach(() => {
    mockCollectionData = [
      { _id: new MockObjectId("aaa"), name: "Alice", email: "alice@test.com" },
      { _id: new MockObjectId("bbb"), name: "Bob", email: "bob@test.com" },
    ];
    mockCollections = [
      { name: "users", type: "collection" },
      { name: "orders", type: "collection" },
    ];
    mockCurrentOps = [];
    mockServerStatus = defaultServerStatus;
    provider = new MongoDBProvider({ ...baseConfig });
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe("validation", () => {
    test("throws when host is missing and no connectionString", () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            host: undefined,
            connectionString: undefined,
          }),
      ).toThrow(DatabaseConfigError);
    });

    test("throws when database is missing and no connectionString", () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            database: undefined,
            connectionString: undefined,
          }),
      ).toThrow(DatabaseConfigError);
    });

    test("connectionString bypasses host/database requirement", () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            host: undefined,
            database: undefined,
            connectionString: "mongodb://remote:27017/mydb",
          }),
      ).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // URI composition
  // --------------------------------------------------------------------------

  describe("the composed URI", () => {
    test("carries no query string when no auth database is named", async () => {
      await provider.connect();
      expect(lastMongoUri).toBe("mongodb://localhost:27017/testdb");
    });

    test("names the auth database as ?authSource, and percent-encodes it", async () => {
      // MongoDB keeps users in one database and the data in another, and the driver
      // authenticates against the database in the URI when nothing says otherwise. So
      // the ordinary deployment - users in `admin`, data elsewhere - could not be
      // reached through the form fields at all: it failed as a credentials error.
      provider = new MongoDBProvider({ ...baseConfig, user: "app", password: "s3cret", authSource: "admin db" });
      await provider.connect();
      expect(lastMongoUri).toBe("mongodb://app:s3cret@localhost:27017/testdb?authSource=admin%20db");
    });

    test("a pasted connection string is passed through verbatim, authSource and all", async () => {
      // The URI the user typed is the whole answer. Re-composing it would drop the
      // options only they know about (replica set, TLS, read preference), so an
      // `authSource` field alongside it is ignored rather than appended twice.
      provider = new MongoDBProvider({
        ...baseConfig,
        authSource: "admin",
        connectionString: "mongodb://app:s3cret@remote:27017/shop?authSource=users&replicaSet=rs0",
      });
      await provider.connect();
      expect(lastMongoUri).toBe("mongodb://app:s3cret@remote:27017/shop?authSource=users&replicaSet=rs0");
    });
  });

  // --------------------------------------------------------------------------
  // TLS
  // --------------------------------------------------------------------------

  describe("the TLS options handed to the driver", () => {
    const connectWithSSL = async (ssl: DatabaseConnection["ssl"], extra: Partial<DatabaseConnection> = {}) => {
      provider = new MongoDBProvider({ ...baseConfig, ...extra, ssl });
      await provider.connect();
      return lastMongoOptions;
    };

    test("carries no tls option when the connection names no SSL config", async () => {
      await provider.connect();
      expect("tls" in lastMongoOptions).toBe(false);
    });

    test("carries no tls option in mode disable", async () => {
      expect("tls" in (await connectWithSSL({ mode: "disable" }))).toBe(false);
    });

    test("mode require encrypts without checking the chain", async () => {
      const options = await connectWithSSL({ mode: "require" });
      expect(options.tls).toBe(true);
      expect(options.rejectUnauthorized).toBe(false);
    });

    test("mode verify-ca and verify-full check the chain", async () => {
      expect(await connectWithSSL({ mode: "verify-ca" })).toMatchObject({ tls: true, rejectUnauthorized: true });
      expect(await connectWithSSL({ mode: "verify-full" })).toMatchObject({ tls: true, rejectUnauthorized: true });
    });

    test("an explicit rejectUnauthorized wins over the mode", async () => {
      const options = await connectWithSSL({ mode: "verify-full", rejectUnauthorized: false });
      expect(options.rejectUnauthorized).toBe(false);
    });

    test("the CA and client certificate bundle reaches the driver under Node's own names", async () => {
      const options = await connectWithSSL({
        mode: "verify-full",
        caCert: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----",
        clientCert: "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----",
        // Deliberately not a PEM header: `-----BEGIN PRIVATE KEY-----` alone, with no material
        // after it, is enough for gitleaks' `private-key` rule, so the realistic string fails the
        // Secret Scan gate for a secret that does not exist (the same reason
        // tests/unit/db/cassandra/wire.test.ts uses this literal). These assertions are about which
        // option name carries the value, not what the value looks like.
        clientKey: "client-key-pem",
      });
      expect(options.ca).toBe("-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----");
      expect(options.cert).toBe("-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----");
      expect(options.key).toBe("client-key-pem");
    });

    test("is honoured alongside a pasted connection string, unlike authSource", async () => {
      // The URI is passed through verbatim, so a `tls=` it does not carry cannot be
      // appended to it - but the options object is a second, independent channel the
      // driver reads, and the form shows the SSL panel in connection-string mode too.
      const options = await connectWithSSL({ mode: "require" }, { connectionString: "mongodb://remote:27017/shop" });
      expect(lastMongoUri).toBe("mongodb://remote:27017/shop");
      expect(options.tls).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    test("connect succeeds and marks provider as connected", async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect succeeds and marks provider as disconnected", async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      await provider.connect();
      await provider.connect(); // should not throw
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getCapabilities()
  // --------------------------------------------------------------------------

  describe("getCapabilities()", () => {
    // #U9: `validate` and `compact` are per-collection commands this provider also
    // loops over `listCollections()`, so both placements are real. `dbCheck` is not
    // looped and refuses to run without a collection name.
    test("declares the target grammar of every maintenance operation", () => {
      const caps = provider.getCapabilities();

      expect(caps.maintenanceOperationSpecs).toEqual({
        vacuum: { label: "Compact Collection", perEntity: true, global: true },
        analyze: { label: "Validate Collection", perEntity: true, global: true },
        check: { label: "Check Collection", perEntity: true, global: false },
      });
      expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
      // MongoDB's "Compact Collection" really is the `vacuum` it declares, so the
      // label needs no redirection.
      expect(provider.getLabels().vacuumActionOperation).toBeUndefined();
    });
    test("returns correct capability metadata", () => {
      const caps = provider.getCapabilities();
      expect(caps.queryLanguage).toBe("json");
      expect(caps.defaultPort).toBe(27017);
      expect(caps.supportsCreateTable).toBe(false);
      // No SQL at all here: the query language is JSON commands, so the inline row
      // editor's `UPDATE ... SET` has nothing to run against (#269).
      expect(caps.supportsInlineRowEdit).toBe(false);
      // Multi-document transactions need a client session this provider does not
      // hold, so the trio and the sandbox toggle are withheld (#U13).
      expect(caps.supportsTransactions).toBe(false);
      // MongoDB has no foreign key constraint, so an empty `foreignKeys` here is the
      // engine's model and not this database's shape (#414).
      expect(caps.declaresForeignKeys).toBe(false);
      expect(caps.supportsConnectionString).toBe(true);
      expect(caps.supportsMaintenance).toBe(true);
      expect(caps.explainFormat).toBeUndefined();
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
    });
  });

  // --------------------------------------------------------------------------
  // getLabels()
  // --------------------------------------------------------------------------

  describe("getLabels()", () => {
    test("returns correct provider labels", () => {
      const labels = provider.getLabels();
      expect(labels.entityName).toBe("Collection");
      expect(labels.rowName).toBe("document");
      expect(labels.selectAction).toBe("Find Documents");
    });

    // Until #U12 the monitoring Queries panel told a MongoDB operator to install a
    // PostgreSQL extension. `getSlowQueries()` reads `system.profile`, which does not
    // exist until the profiler is on, so that is the switch the sentence must name.
    test("names the profiler, not a Postgres extension, as where query stats come from", () => {
      const { slowQueriesEmptyState } = provider.getLabels();

      expect(slowQueriesEmptyState).toContain("profiler");
      expect(slowQueriesEmptyState).toContain("system.profile");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
    });

    // `statementLanguage` is the sentence the agent's plan contract states verbatim
    // (`ProviderLabels.statementLanguage`), and this engine needs one for the reason
    // the search products did: asked for "one runnable statement in this MongoDB
    // database's own query language", a live plan run on 2026-08-22 answered with
    // mongosh shell syntax - `db.orders.aggregate([{ $group: ... }])` - which is
    // correct MongoDB and unrunnable here, because `query()` takes the JSON command
    // object and nothing else. So the sentence has to name the envelope AND rule out
    // the shell by name; naming only what the language is did not survive contact
    // with the model's prior on Elasticsearch and does not here either.
    test("declares the JSON command envelope as the statement language and rules out mongosh", () => {
      const { statementLanguage } = provider.getLabels();

      expect(statementLanguage).toBeString();
      // The keys a runnable command is built from - the ones `parseQuery` reads.
      // `field` is here because a model that cannot see it writes a `distinct` with no
      // field, which is now refused rather than answered with `_id`.
      for (const key of ["collection", "operation", "filter", "pipeline", "field"]) {
        expect(statementLanguage).toContain(key);
      }
      // The two forms a model reaches for instead, named so they are excluded.
      expect(statementLanguage).toContain("mongosh");
      expect(statementLanguage).toContain("db.");
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe("prepareQuery()", () => {
    test("returns query unchanged with wasLimited=false", () => {
      const input = '{"collection":"users","operation":"find"}';
      const prepared = provider.prepareQuery(input);
      expect(prepared.query).toBe(input);
      expect(prepared.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // query()
  // --------------------------------------------------------------------------

  describe("query()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("find operation returns rows", async () => {
      const result = await provider.query(JSON.stringify({ collection: "users", operation: "find", filter: {} }));
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBe(2);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      // ObjectId should be serialized to string
      expect(typeof result.rows[0]._id).toBe("string");
    });

    test("findOne returns a single document", async () => {
      const result = await provider.query(
        JSON.stringify({ collection: "users", operation: "findOne", filter: { name: "Alice" } }),
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe("Alice");
    });

    test("aggregate works", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "aggregate",
          pipeline: [{ $group: { _id: null, count: { $sum: 1 } } }],
        }),
      );
      expect(result.rows).toBeArray();
    });

    test("count returns document count", async () => {
      const result = await provider.query(JSON.stringify({ collection: "users", operation: "count", filter: {} }));
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].count).toBe(2);
    });

    test("insertOne returns insertedId", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "insertOne",
          documents: [{ name: "Charlie" }],
        }),
      );
      expect(result.rows[0].insertedId).toBe("new-id-123");
      expect(result.rows[0].acknowledged).toBe(true);
      expect(result.rowCount).toBe(1);
    });

    test("unsupported operation throws QueryError", async () => {
      await expect(provider.query(JSON.stringify({ collection: "users", operation: "drop" }))).rejects.toThrow();
    });

    test("invalid JSON throws QueryError", async () => {
      await expect(provider.query("not valid json")).rejects.toThrow();
    });

    test("missing collection throws QueryError", async () => {
      await expect(provider.query(JSON.stringify({ operation: "find" }))).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getSchema()
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns collections with inferred columns from sampled docs", async () => {
      const schemas = await provider.getSchema();
      expect(schemas).toBeArray();
      expect(schemas.length).toBe(2); // users + orders

      const usersSchema = schemas.find((s) => s.name === "users");
      expect(usersSchema).toBeDefined();
      expect(usersSchema!.rowCount).toBe(42);
      expect(usersSchema!.columns.length).toBeGreaterThan(0);

      // _id field should be first and marked primary
      const idCol = usersSchema!.columns[0];
      expect(idCol.name).toBe("_id");
      expect(idCol.isPrimary).toBe(true);

      // indexes should be present
      expect(usersSchema!.indexes!.length).toBe(2);
    });

    test("lists a view, and does not ask a view the two questions MongoDB refuses on one", async () => {
      // The defect this pins (#414): `listCollections()` returns views, and both
      // `estimatedDocumentCount()` and `indexes()` answer CommandNotSupportedOnView
      // (code 166) on one. Both calls were unguarded, so a single view in the
      // database aborted the entire schema read - the user lost every collection,
      // not just the view.
      mockCollections = [
        { name: "users", type: "collection" },
        { name: "active_users", type: "view" },
        { name: "orders", type: "collection" },
      ];

      const schemas = await provider.getSchema();

      // The view is LISTED. A user who created it wants to see it, and its fields are
      // readable by exactly the sample this provider already takes.
      expect(schemas.map((s) => s.name)).toEqual(["users", "active_users", "orders"]);
      const view = schemas.find((s) => s.name === "active_users")!;
      expect(view.columns.length).toBeGreaterThan(0);
      // And what a view genuinely has no answer for is left ABSENT rather than
      // reported as zero: a view holds no documents of its own and carries no
      // indexes, and `rowCount: 0` would read as "this view is empty".
      expect(view.rowCount).toBeUndefined();
      expect(view.size).toBeUndefined();
      expect(view.indexes).toEqual([]);
      // The collections after it are still read, which is the half of the defect a
      // user actually noticed.
      expect(schemas.find((s) => s.name === "orders")!.rowCount).toBe(42);
    });

    // Why nested fields are listed at all: the inventory this schema feeds is what
    // grounds an agent plan run, and a document field recorded only as
    // `shipping: object` tells a model that something is nested there and nothing
    // about what. A live plan run on 2026-08-22 grouped by `$shipping.region` - a
    // path that does not exist in the database it was handed - and MongoDB answers
    // that with one null group rather than an error, so the plan looked runnable and
    // was silently wrong. `shipping.city` is a first-class field name in MQL, so the
    // fix is to name it.
    test("lists nested object fields as dotted paths, down to the depth limit", async () => {
      mockCollectionData = [
        {
          _id: new MockObjectId("aaa"),
          total: 10,
          shipping: { city: "Istanbul", method: "express", geo: { lat: 41, deep: { tooFar: 1 } } },
        },
      ];

      const schemas = await provider.getSchema();
      const names = schemas.find((s) => s.name === "users")!.columns.map((c) => c.name);

      // The container is still listed - a query may address the whole subdocument.
      expect(names).toContain("shipping");
      expect(names).toContain("shipping.city");
      expect(names).toContain("shipping.method");
      // Depth 3 is reached and named.
      expect(names).toContain("shipping.geo.lat");
      // Depth 4 is not: an unbounded walk turns one deeply nested document into
      // hundreds of rows in the schema tree and hundreds of lines in a model's
      // context window. The container at the boundary is still named, so the reader
      // knows the nesting continues.
      expect(names).toContain("shipping.geo.deep");
      expect(names).not.toContain("shipping.geo.deep.tooFar");
    });

    test("does not descend into arrays, and keeps _id first after nesting", async () => {
      mockCollectionData = [
        {
          _id: new MockObjectId("aaa"),
          items: [{ sku: "A-1", qty: 2 }],
          tags: ["seed"],
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ];

      const schemas = await provider.getSchema();
      const columns = schemas.find((s) => s.name === "users")!.columns;
      const names = columns.map((c) => c.name);

      expect(names[0]).toBe("_id");
      expect(names).toContain("items");
      expect(names).toContain("tags");
      // An array element's fields are NOT dotted paths of the same kind: `items.sku`
      // reads a value per array entry, so grouping or sorting on it does not mean
      // what the same syntax means on a subdocument. Naming it in a flat field list
      // would invite exactly that confusion, so the array is named and left closed.
      expect(names).not.toContain("items.sku");
      // A Date is an object to `typeof` and has no fields worth listing.
      expect(names).not.toContain("createdAt.getTime");
    });

    test("caps the number of inferred fields so one wide document cannot flood the tree", async () => {
      const wide: Record<string, unknown> = { _id: new MockObjectId("aaa") };
      for (let i = 0; i < 60; i++) {
        wide[`group${i}`] = Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`f${j}`, j]));
      }
      mockCollectionData = [wide];

      const schemas = await provider.getSchema();
      const columns = schemas.find((s) => s.name === "users")!.columns;

      // 60 containers + 600 leaves + _id would be 661 rows for one document.
      expect(columns.length).toBeLessThanOrEqual(200);
      // The cap keeps a deterministic prefix rather than an arbitrary slice, and _id
      // survives it: it is the field every generated statement addresses.
      expect(columns[0].name).toBe("_id");
    });
  });

  // --------------------------------------------------------------------------
  // getHealth()
  // --------------------------------------------------------------------------

  describe("getHealth()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns health info with connections and database size", async () => {
      const health = await provider.getHealth();
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe("string");
      // 10 of 1000 requested pages came from disk: a measured 99.0%.
      expect(health.cacheHitRatio).toBe("99.0%");
    });

    test("a server with no wiredTiger section reports the cache hit ratio as unavailable", async () => {
      mockServerStatus = () => ({ connections: { current: 5, available: 95 }, uptime: 86400 });
      const health = await provider.getHealth();
      expect(health.cacheHitRatio).toBe("N/A");
    });

    test("a cache nothing has been requested from yet reports the ratio as unavailable", async () => {
      mockServerStatus = () => ({
        connections: { current: 5, available: 95 },
        uptime: 86400,
        wiredTiger: { cache: { "pages read into cache": 0, "pages requested from the cache": 0 } },
      });
      const health = await provider.getHealth();
      // No requests means no hits and no misses - there is no ratio, not a 100%.
      expect(health.cacheHitRatio).toBe("N/A");
    });

    test("a cache that served nothing from memory reports a measured zero", async () => {
      mockServerStatus = () => ({
        connections: { current: 5, available: 95 },
        uptime: 86400,
        wiredTiger: { cache: { "pages read into cache": 400, "pages requested from the cache": 400 } },
      });
      const health = await provider.getHealth();
      // A cold cache measures 0 and that is a measurement, not an absence.
      expect(health.cacheHitRatio).toBe("0.0%");
    });

    test("maps in-progress operations to active sessions", async () => {
      mockCurrentOps = [
        {
          opid: 123,
          client: "127.0.0.1:5555",
          ns: "testdb.users",
          active: true,
          command: { find: "users" },
          microsecs_running: 2500000,
        },
        { active: false },
      ];
      const health = await provider.getHealth();
      expect(health.activeSessions.length).toBe(2);
      expect(health.activeSessions[0].pid).toBe(123);
      expect(health.activeSessions[0].user).toBe("127.0.0.1:5555");
      expect(health.activeSessions[0].database).toBe("testdb.users");
      expect(health.activeSessions[0].state).toBe("active");
      expect(health.activeSessions[0].query).toContain("find");
      expect(health.activeSessions[0].duration).toBe("2.50s");
      // Missing fields fall back to defaults
      expect(health.activeSessions[1].pid).toBe("N/A");
      expect(health.activeSessions[1].user).toBe("N/A");
      expect(health.activeSessions[1].database).toBe("testdb");
      expect(health.activeSessions[1].state).toBe("idle");
      expect(health.activeSessions[1].duration).toBe("N/A");
    });
  });

  // --------------------------------------------------------------------------
  // runMaintenance()
  // --------------------------------------------------------------------------

  describe("runMaintenance()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("analyze validates collections", async () => {
      const result = await provider.runMaintenance("analyze", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("Validated");
    });

    test("vacuum compacts collections", async () => {
      const result = await provider.runMaintenance("vacuum", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("Compacted");
    });

    test("unsupported maintenance type throws", async () => {
      await expect(provider.runMaintenance("flush" as never)).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getOverview()
  // --------------------------------------------------------------------------

  describe("getOverview()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns version, uptime, connections, size, counts", async () => {
      const overview = await provider.getOverview();
      expect(typeof overview.version).toBe("string");
      expect(typeof overview.uptime).toBe("string");
      expect(typeof overview.activeConnections).toBe("number");
      expect(typeof overview.maxConnections).toBe("number");
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(typeof overview.tableCount).toBe("number");
      expect(typeof overview.indexCount).toBe("number");
    });

    test("connections.available present makes the limit the sum, and a 0 available is a real zero", async () => {
      const overview = await provider.getOverview();
      expect(overview.maxConnections).toBe(100);

      mockServerStatus = () => ({ connections: { current: 5, available: 0 }, uptime: 1 });
      // A pool with nothing left is a limit of 5, not the fabricated 100.
      expect((await provider.getOverview()).maxConnections).toBe(5);
    });

    test("a server publishing no connection headroom publishes no limit", async () => {
      mockServerStatus = () => ({ connections: { current: 5 }, uptime: 1 });
      // 0 is how every provider spells "no limit published"; 100 was invented.
      expect((await provider.getOverview()).maxConnections).toBe(0);
    });

    test("a failing serverStatus publishes no connection limit either", async () => {
      mockServerStatus = () => {
        throw new Error("not authorized on admin to execute command { serverStatus: 1 }");
      };
      expect((await provider.getOverview()).maxConnections).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // getPerformanceMetrics()
  // --------------------------------------------------------------------------

  describe("getPerformanceMetrics()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns cache hit ratio and connection pool metrics", async () => {
      const metrics = await provider.getPerformanceMetrics();
      expect(metrics.cacheHitRatio).toBe(99);
      expect(metrics.bufferPoolUsage).toBe(50);
    });

    test("omits the cache metrics on a server with no wiredTiger section", async () => {
      mockServerStatus = () => ({ uptime: 100, opcounters: { query: 100 } });
      const metrics = await provider.getPerformanceMetrics();
      expect("cacheHitRatio" in metrics).toBe(false);
      expect("bufferPoolUsage" in metrics).toBe(false);
      // What IS measurable still arrives: 100 ops over 100 seconds.
      expect(metrics.queriesPerSecond).toBe(1);
    });

    test("omits the ratio when nothing has been requested from the cache", async () => {
      mockServerStatus = () => ({
        uptime: 100,
        wiredTiger: { cache: { "pages read into cache": 0, "pages requested from the cache": 0 } },
      });
      expect("cacheHitRatio" in (await provider.getPerformanceMetrics())).toBe(false);
    });

    test("reports a measured zero rather than dropping it", async () => {
      mockServerStatus = () => ({
        uptime: 100,
        wiredTiger: {
          cache: {
            "pages read into cache": 400,
            "pages requested from the cache": 400,
            "bytes currently in the cache": 0,
            "maximum bytes configured": 10,
          },
        },
      });
      const metrics = await provider.getPerformanceMetrics();
      expect(metrics.cacheHitRatio).toBe(0);
      expect(metrics.bufferPoolUsage).toBe(0);
    });

    test("measures nothing and reports nothing when serverStatus fails", async () => {
      mockServerStatus = () => {
        throw new Error("not authorized on admin to execute command { serverStatus: 1 }");
      };
      // The whole point of the change: this used to answer the panel with 99% cache hit.
      expect(await provider.getPerformanceMetrics()).toEqual({});
    });
  });

  // --------------------------------------------------------------------------
  // getSlowQueries()
  // --------------------------------------------------------------------------

  describe("getSlowQueries()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns slow query data", async () => {
      const slow = await provider.getSlowQueries();
      expect(slow).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getActiveSessions()
  // --------------------------------------------------------------------------

  describe("getActiveSessions()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns session data", async () => {
      const sessions = await provider.getActiveSessions();
      expect(sessions).toBeArray();
    });

    test("maps in-progress operations with duration formatting for every range", async () => {
      mockCurrentOps = [
        {
          opid: 1,
          client: "10.0.0.1:4444",
          ns: "testdb.orders",
          appName: "mongosh",
          active: true,
          command: { find: "orders" },
          microsecs_running: 500000, // 500ms
          waitingForLock: true,
          lockStats: { acquireCount: 1 },
        },
        { opid: 2, microsecs_running: 5000000 }, // 5.0s
        { opid: 3, microsecs_running: 120000000 }, // 2m 0s
        { opid: 4, microsecs_running: 7260000000 }, // 2h 1m
      ];
      const sessions = await provider.getActiveSessions();
      expect(sessions.length).toBe(4);

      // Fully populated op
      expect(sessions[0].pid).toBe(1);
      expect(sessions[0].user).toBe("10.0.0.1:4444");
      expect(sessions[0].database).toBe("testdb");
      expect(sessions[0].applicationName).toBe("mongosh");
      expect(sessions[0].clientAddr).toBe("10.0.0.1");
      expect(sessions[0].state).toBe("active");
      expect(sessions[0].query).toContain("find");
      expect(sessions[0].duration).toBe("500ms");
      expect(sessions[0].durationMs).toBe(500);
      expect(sessions[0].waitEventType).toBe("Lock");
      expect(sessions[0].waitEvent).toBe("Acquiring lock");

      // Sparse op falls back to defaults
      expect(sessions[1].pid).toBe(2);
      expect(sessions[1].user).toBe("N/A");
      expect(sessions[1].database).toBe("testdb");
      expect(sessions[1].applicationName).toBeUndefined();
      expect(sessions[1].clientAddr).toBeUndefined();
      expect(sessions[1].state).toBe("idle");
      expect(sessions[1].waitEventType).toBeUndefined();
      expect(sessions[1].waitEvent).toBeUndefined();

      // Duration formatting across seconds / minutes / hours ranges
      expect(sessions[1].duration).toBe("5.0s");
      expect(sessions[2].duration).toBe("2m 0s");
      expect(sessions[3].duration).toBe("2h 1m");
    });

    test("respects the limit option", async () => {
      mockCurrentOps = [
        { opid: 1, microsecs_running: 1000 },
        { opid: 2, microsecs_running: 2000 },
        { opid: 3, microsecs_running: 3000 },
      ];
      const sessions = await provider.getActiveSessions({ limit: 2 });
      expect(sessions.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getTableStats()
  // --------------------------------------------------------------------------

  describe("getTableStats()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns collection stats", async () => {
      const stats = await provider.getTableStats();
      expect(stats).toBeArray();
    });

    test("carries the index bytes the server measured, not only their formatted form", async () => {
      // `collStats.totalIndexSize` was formatted for display and then dropped, so the storage
      // panel had no per-collection index total to add up and reported it as unavailable.
      const stats = await provider.getTableStats();
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].indexSizeBytes).toBe(512);
    });
  });

  // --------------------------------------------------------------------------
  // getIndexStats()
  // --------------------------------------------------------------------------

  describe("getIndexStats()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns index stats for collections", async () => {
      const stats = await provider.getIndexStats();
      expect(stats).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getStorageStats()
  // --------------------------------------------------------------------------

  describe("getStorageStats()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns storage stats", async () => {
      const stats = await provider.getStorageStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThan(0);
      expect(typeof stats[0].name).toBe("string");
      expect(typeof stats[0].size).toBe("string");
      expect(typeof stats[0].sizeBytes).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // BSON serialization
  // --------------------------------------------------------------------------

  describe("BSON serialization", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("ObjectId is serialized to string in query results", async () => {
      const result = await provider.query(JSON.stringify({ collection: "users", operation: "find", filter: {} }));
      expect(typeof result.rows[0]._id).toBe("string");
    });

    test("insertMany returns correct count", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "insertMany",
          documents: [{ name: "A" }, { name: "B" }, { name: "C" }],
        }),
      );
      expect(result.rows[0].insertedCount).toBe(3);
      // rowCount is rows.length (1 result row) since rows.length > 0
      expect(result.rowCount).toBe(1);
    });

    test("updateOne returns matched/modified counts", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "updateOne",
          filter: { name: "Alice" },
          update: { $set: { name: "Alice Updated" } },
        }),
      );
      expect(result.rows[0].matchedCount).toBe(1);
      expect(result.rows[0].modifiedCount).toBe(1);
    });

    test("updateMany returns matched/modified counts", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "updateMany",
          filter: {},
          update: { $set: { active: true } },
        }),
      );
      expect(result.rows[0].matchedCount).toBe(2);
      expect(result.rows[0].modifiedCount).toBe(2);
    });

    test("deleteOne returns deletedCount", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "deleteOne",
          filter: { name: "Alice" },
        }),
      );
      expect(result.rows[0].deletedCount).toBe(1);
      expect(result.rowCount).toBe(1);
    });

    test("deleteMany returns deletedCount", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "deleteMany",
          filter: {},
        }),
      );
      expect(result.rows[0].deletedCount).toBe(3);
      // rowCount is rows.length (1 result row) since rows.length > 0
      expect(result.rowCount).toBe(1);
    });

    test("distinct collects the values of the named field", async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: "users",
          operation: "distinct",
          filter: {},
          field: "name",
        }),
      );
      expect(result.rows).toEqual([{ name: "Alice" }, { name: "Bob" }]);
      expect(result.fields).toEqual(["name"]);
    });

    test("distinct with no field is an error naming the key it wanted", async () => {
      // Measured 2026-08-22 on live mongo:latest, 120 products in five categories:
      // this used to answer 120 rows of `_id`, because the field came from the first
      // key of `options.projection` and defaulted to `_id`. A plausible list of ids
      // reads as "120 distinct categories"; an error does not.
      await expect(
        provider.query(JSON.stringify({ collection: "users", operation: "distinct", filter: {} })),
      ).rejects.toThrow(/distinct requires a "field"/);
    });

    test("distinct does not take its field from options.projection", async () => {
      // The former spelling. It is gone rather than kept as an alias: nothing in the
      // product generates a `distinct`, so there is no caller to be compatible with,
      // and one accepted key is one thing to document.
      await expect(
        provider.query(
          JSON.stringify({
            collection: "users",
            operation: "distinct",
            options: { projection: { name: 1 } },
          }),
        ),
      ).rejects.toThrow(/distinct requires a "field"/);
    });

    test("distinct rejects a field that is not a field name", async () => {
      await expect(
        provider.query(JSON.stringify({ collection: "users", operation: "distinct", field: "" })),
      ).rejects.toThrow(/distinct requires a "field"/);
      await expect(
        provider.query(JSON.stringify({ collection: "users", operation: "distinct", field: { name: 1 } })),
      ).rejects.toThrow(/distinct requires a "field"/);
    });
  });

  // --------------------------------------------------------------------------
  // getMonitoringData()
  // --------------------------------------------------------------------------

  describe("getMonitoringData()", () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test("returns monitoring data with all sections", async () => {
      const data = await provider.getMonitoringData();
      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
      expect(data.slowQueries).toBeArray();
      expect(data.activeSessions).toBeArray();
    });
  });
});
