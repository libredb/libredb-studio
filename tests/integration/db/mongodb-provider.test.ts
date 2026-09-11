/**
 * MongoDB Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'mongodb' driver
 * before importing the MongoDBProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
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

// ----------------------------------------------------------------------------
// Object-surface state (#789)
//
// The object surface reads across DATABASES, so the fake has to honour the name
// `MongoClient.db(name)` is given instead of answering one fixed database. That is
// deliberate and it is what makes a wrong container bind visible: a provider reading
// the connected database instead of the one the container names gets a different
// collection list here rather than the same one.
// ----------------------------------------------------------------------------

interface MockCollectionInfo {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

/** What `listDatabases` answers. Mirrors `docker/mongodb-init/01-object-fixture.js`. */
let mockDatabaseList: { name: string }[] = [];
/** One collection list per database name; absent falls back to `mockCollections`. */
let mockCollectionsByDb: Record<string, MockCollectionInfo[]> = {};
/** A database whose `listCollections` is refused, by name, with the server's own error. */
let mockListCollectionsError: Record<string, Error> = {};
/** Sampled documents per `<database>.<collection>`; absent falls back to `mockCollectionData`. */
let mockDocumentsByNs: Record<string, Record<string, unknown>[]> = {};
/** Every database name `MongoClient.db()` was opened with, in order. */
let mongoOpenedDatabases: string[] = [];
/** The `listDatabases` command document the driver received, verbatim. */
let lastListDatabasesCommand: Record<string, unknown> = {};
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

const mockCollectionInfos = (dbName: string): { name: string; type: string }[] =>
  mockCollectionsByDb[dbName] ?? mockCollections;

const isMockView = (name: string, dbName: string): boolean =>
  mockCollectionInfos(dbName).some((c) => c.name === name && c.type === "view");

const createMockCollection = (name = "users", dbName = "testdb") => ({
  find: () => createMockCursor(mockDocumentsByNs[`${dbName}.${name}`] ?? mockCollectionData),
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
    if (isMockView(name, dbName)) throw commandNotSupportedOnView("count", name);
    return 42;
  },
  indexes: async () => {
    if (isMockView(name, dbName)) throw commandNotSupportedOnView("listIndexes", name);
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

/**
 * What `db.stats()` answers, a function for the same reason `serverStatus` is one:
 * `databaseSizeBytes` is optional, so the byte figure has to be driven on a database
 * that measures 0 bytes AND on a deployment that answers without `dataSize` at all.
 * Both used to reach the Storage tab as a measured 0.
 */
const defaultDbStats = () => ({
  dataSize: 2048,
  indexSize: 512,
  storageSize: 4096,
  collections: 2,
  objects: 100,
});

let mockDbStats: () => Record<string, unknown> = defaultDbStats;

const createMockDb = (dbName = "testdb") => ({
  command: async (cmd: Record<string, unknown>) => {
    if (cmd.ping) return { ok: 1 };
    if (cmd.collStats) {
      if (isMockView(String(cmd.collStats), dbName))
        throw commandNotSupportedOnView("collStats", String(cmd.collStats));
      return { size: 1024, totalIndexSize: 512, count: 42 };
    }
    if (cmd.validate) return { ok: 1, valid: true };
    if (cmd.compact) return { ok: 1 };
    return mockCommandResults;
  },
  listCollections: () => ({
    toArray: async () => {
      const refusal = mockListCollectionsError[dbName];
      if (refusal !== undefined) throw refusal;
      return mockCollectionInfos(dbName);
    },
  }),
  collection: (name?: string) => createMockCollection(name, dbName),
  stats: async () => mockDbStats(),
  admin: () => ({
    serverStatus: async () => mockServerStatus(),
    command: async (cmd: Record<string, unknown>) => {
      if (cmd.currentOp) return { inprog: mockCurrentOps };
      if (cmd.buildInfo) return { version: "7.0.0" };
      if (cmd.listDatabases) {
        lastListDatabasesCommand = cmd;
        return { databases: mockDatabaseList, ok: 1 };
      }
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

    db(name?: string) {
      mongoOpenedDatabases.push(name ?? "");
      return createMockDb(name);
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
const { assertObjectSurface } = await import("../../helpers/object-surface-conformance");

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
// The object-surface fixture (#789)
//
// Every row below is VERBATIM what `docker/mongodb-init/01-object-fixture.js` produced on
// a live MongoDB 8.3.9 on 2026-09-11, in the order the server returned it - which is not
// sorted, so the provider's own ordering is exercised rather than inherited. Measured
// twice against two fresh containers holding the same fixture, and `app` came back in two
// DIFFERENT orders, so "no documented order" is a measurement here and not a reading of
// the manual.
// ============================================================================

/** `listDatabases` on the fixture container. `admin`, `config` and `local` are the server's own. */
const OBJECT_FIXTURE_DATABASES: { name: string }[] = [
  { name: "admin" },
  { name: "app" },
  { name: "config" },
  // Starts with "config" and is a database a person created. A prefix rule would hide it.
  { name: "configstore" },
  { name: "local" },
  { name: "oddnames" },
];

/** `listCollections` on `app`, verbatim. */
const OBJECT_FIXTURE_APP: MockCollectionInfo[] = [
  { name: "orders", type: "collection" },
  // Created by the server the moment the view was created, and never by a person.
  { name: "system.views", type: "collection" },
  // Starts with the letters "system" and NOT with "system.", so it is a person's
  // collection. A provider excluding on "system" without the dot would hide it.
  { name: "systemetrics", type: "collection" },
  { name: "customers", type: "collection" },
  // The third value of `type`, beside "collection" and "view". A classifier written
  // `type === "collection"` loses this object from the count AND the listing at once.
  { name: "readings", type: "timeseries" },
  // The bucket collection a time series collection creates. Internal, and excluded.
  { name: "system.buckets.readings", type: "collection" },
  {
    name: "active_customers",
    type: "view",
    options: { viewOn: "customers", pipeline: [{ $match: { city: "Istanbul" } }] },
  },
];

/**
 * `listCollections` on `oddnames`, verbatim, and the order the server gave is the whole
 * point: the three names differ only in a character JSON ESCAPES. A quote and a backslash
 * are both legal in a MongoDB collection name - measured, only the null byte and `$` are
 * refused - so by CODE POINT they sort `x"a` (0x22), `x-a` (0x2D), `x\a` (0x5C), while by
 * `JSON.stringify` they sort `x-a`, `x"a`, `x\a`, because escaping rewrites the first two
 * to start with a backslash. The server's own order here is the JSON one, so a provider
 * sorting by `JSON.stringify` would pass by inheriting it.
 */
const OBJECT_FIXTURE_ODDNAMES: MockCollectionInfo[] = [
  { name: "x-a", type: "collection" },
  { name: 'x"a', type: "collection" },
  { name: "x\\a", type: "collection" },
];

/** `listCollections` on `configstore`, verbatim. */
const OBJECT_FIXTURE_CONFIGSTORE: MockCollectionInfo[] = [{ name: "settings", type: "collection" }];

function resetObjectSurfaceMocks(): void {
  mockDatabaseList = [];
  mockCollectionsByDb = {};
  mockListCollectionsError = {};
  mockDocumentsByNs = {};
  mongoOpenedDatabases = [];
  lastListDatabasesCommand = {};
}

function useObjectFixture(): void {
  mockDatabaseList = OBJECT_FIXTURE_DATABASES;
  mockCollectionsByDb = {
    app: OBJECT_FIXTURE_APP,
    configstore: OBJECT_FIXTURE_CONFIGSTORE,
    oddnames: OBJECT_FIXTURE_ODDNAMES,
  };
  mockDocumentsByNs = {
    "app.customers": [
      { _id: new MockObjectId("c1"), name: "Ada", city: "Istanbul" },
      { _id: new MockObjectId("c2"), name: "Grace", city: "Ankara" },
    ],
    "app.active_customers": [{ _id: new MockObjectId("c1"), name: "Ada", city: "Istanbul" }],
  };
}

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
    mockDbStats = defaultDbStats;
    resetObjectSurfaceMocks();
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

    // D26: the mode a pasted `tls=true` / `mongodb+srv://` lands on. It has to verify with
    // no CA PEM in hand, which is the whole reason it exists - an Atlas string carries no
    // certificate file.
    test("mode verify-system verifies against the runtime trust store, with no ca option", async () => {
      const options = await connectWithSSL({ mode: "verify-system" });
      expect(options.tls).toBe(true);
      expect(options.rejectUnauthorized).toBe(true);
      expect("ca" in options).toBe(false);
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
      // hold, so the trio and the sandbox toggle are withheld (#464).
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

    test("a health read that failed entirely leaves activeConnections absent, and still resolves", async () => {
      // The outer catch is deliberate: `POST /api/db/health` serialises whatever
      // `getHealth()` resolves with, and the admin fleet-health row reads `healthy`
      // from a resolved read - a rethrow here would turn both into an error for a
      // server that is up (the health-gate lockout class). What it must NOT do is
      // resolve with `activeConnections: 0`, because nothing was read: the agent's
      // curated health reading forwards that key to the model as a measurement.
      mockServerStatus = () => {
        throw new Error("not authorized on admin to execute command { serverStatus: 1 }");
      };
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(false);
      // Still a resolved HealthInfo, so the route keeps answering 200.
      expect(health.databaseSize).toBe("N/A");
      expect(health.cacheHitRatio).toBe("N/A");
    });

    test("a server publishing no connections section leaves activeConnections absent", async () => {
      // An API-compatible service, or any deployment whose serverStatus answers
      // without the section - `connections` is a network-layer field, so unlike
      // `wiredTiger` its absence is not tied to the storage engine, and which
      // deployments omit it is not measured here. `connections?.current || 0` read
      // that as zero open connections; the figure was never published.
      mockServerStatus = () => ({ uptime: 86400 });
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(false);
    });

    test("a server with zero open connections keeps its measured zero", async () => {
      // The anti-vacuity twin of the two tests above. Absence must never be spelled
      // with a falsy test (`activeConnections || undefined`): 0 here is a reading.
      mockServerStatus = () => ({ connections: { current: 0, available: 100 }, uptime: 86400 });
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(true);
      expect(health.activeConnections).toBe(0);
    });

    test("a dbStats answer without dataSize reports no size rather than a measured 0 B", async () => {
      // The byte figure has the same two inputs as the connection count, and this method is
      // the one whose reading reaches the model: the agent's curated `health` projection
      // sends `databaseSize` verbatim (`method: "getHealth"`, `fields: [..., "databaseSize",
      // ...]` in `src/lib/agent/tools.ts`), so `dbStats.dataSize || 0` told it a database it
      // never measured holds nothing. "N/A" is the spelling this method's own catch uses.
      mockDbStats = () => ({ indexSize: 512, storageSize: 4096 });
      expect((await provider.getHealth()).databaseSize).toBe("N/A");
    });

    test("a database that really measures zero bytes still reports 0 B", async () => {
      // The anti-vacuity twin: an empty database measured 0 bytes, and that is a reading.
      mockDbStats = () => ({ dataSize: 0, indexSize: 0, storageSize: 0 });
      expect((await provider.getHealth()).databaseSize).toBe("0 B");
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

    test("an overview read that failed entirely leaves activeConnections absent, and still resolves", async () => {
      // The same absence that `getHealth()` already carries, at the field the health
      // reading is composed from. The catch resolves on purpose - `getMonitoringData()`
      // reads this panel through `Promise.allSettled`, so a rethrow would replace the
      // whole overview with an error entry rather than the version/uptime placeholders
      // the tab renders - but nothing was read, so it must not name a connection count.
      mockServerStatus = () => {
        throw new Error("not authorized on admin to execute command { serverStatus: 1 }");
      };
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(false);
      // Still a resolved DatabaseOverview, so the monitoring panel keeps its shape.
      expect(overview.version).toBe("MongoDB Unknown");
      expect(overview.uptime).toBe("N/A");
    });

    test("a server publishing no connections section leaves activeConnections absent", async () => {
      // `connections` is a network-layer field, so unlike `wiredTiger` its absence is
      // not tied to the storage engine, and which deployments omit it is not measured
      // here. `connections?.current || 0` read the missing section as zero open
      // connections and the Overview card rated it against the limit.
      mockServerStatus = () => ({ uptime: 86400 });
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(false);
    });

    test("a server with zero open connections keeps its measured zero", async () => {
      // The anti-vacuity twin of the two tests above: `|| 0` destroyed a real zero as
      // well as inventing a fake one, so absence must never be spelled with a falsy
      // test. An idle server measured 0, and 0 is a reading.
      mockServerStatus = () => ({ connections: { current: 0, available: 100 }, uptime: 86400 });
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(true);
      expect(overview.activeConnections).toBe(0);
      // The limit is still the sum of what is open and what is left.
      expect(overview.maxConnections).toBe(100);
    });

    test("an overview read that failed entirely publishes no byte figure either", async () => {
      // `databaseSizeBytes` is optional for the reason its docblock gives: a 0 is a
      // measurement and the Storage tab formats whatever it is given, so a path that read
      // nothing must omit it. With the key present as 0 that tab took `sizeKnown` as true
      // and drew the whole breakdown over a 0 B total - and once the table read answers
      // (it goes through `listCollections` + `collStats`, not `serverStatus`), its
      // "Other (unattributed)" row is `0 - tables - indexes`, a negative byte figure.
      // Absent, the tab draws its own "No storage size information available."
      mockServerStatus = () => {
        throw new Error("not authorized on admin to execute command { serverStatus: 1 }");
      };
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      // The required string field says the same thing in the only shape its type allows.
      expect(overview.databaseSize).toBe("N/A");
      // `maxConnections` stays 0 because there 0 MEANS "no limit published" - the same
      // fact as absence - and the two counts are required numbers, so 0 is the only
      // value the type leaves for them. They are named here so this object's remaining
      // placeholders are pinned rather than assumed.
      expect(overview.maxConnections).toBe(0);
      expect(overview.tableCount).toBe(0);
      expect(overview.indexCount).toBe(0);
    });

    test("a database that really measures zero bytes keeps its measured zero", async () => {
      // The anti-vacuity twin: absence must not be spelled with a falsy test. An empty
      // database measures 0 bytes, and 0 is a reading the Storage tab may divide by.
      mockDbStats = () => ({ dataSize: 0, indexSize: 0, storageSize: 0 });
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(true);
      expect(overview.databaseSizeBytes).toBe(0);
      expect(overview.databaseSize).toBe("0 B");
    });

    test("a dbStats answer without dataSize publishes no byte figure", async () => {
      // MongoDB's own dbStats reference documents `dataSize` unconditionally (only the
      // three `freeStorage` fields are gated, on the command's `freeStorage: 1` option),
      // so this is not a measured deployment - it is the one arm `|| 0` could not tell
      // apart from the zero above, and the optional field exists to carry it.
      mockDbStats = () => ({ indexSize: 512, storageSize: 4096 });
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
      // Everything the same read DID answer still arrives - this is not a failed read.
      expect(overview.tableCount).toBe(2);
      expect(overview.activeConnections).toBe(5);
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

// ============================================================================
// The object surface (#789)
//
// MongoDB is the first NON-SQL engine to get one: the catalog is a command rather than a
// query, so standing ruling 5f's seam - the count and the listing drifting apart - is not
// in a WHERE clause here. Both reads are ONE `listCollections` command classified by ONE
// function, and the tests below drive both sides of that function.
// ============================================================================

describe("object surface", () => {
  let objectProvider: InstanceType<typeof MongoDBProvider>;

  /** Connected, with the connect-time `db()` call dropped so a bind assertion sees only the read. */
  const connectedProvider = async (
    overrides: Partial<DatabaseConnection> = {},
  ): Promise<InstanceType<typeof MongoDBProvider>> => {
    const created = new MongoDBProvider({ ...baseConfig, database: "app", ...overrides });
    await created.connect();
    mongoOpenedDatabases = [];
    return created;
  };

  beforeEach(async () => {
    resetObjectSurfaceMocks();
    useObjectFixture();
    objectProvider = await connectedProvider();
  });

  afterEach(async () => {
    try {
      await objectProvider.disconnect();
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // The declaration
  // --------------------------------------------------------------------------

  test("declares one container level and the two kinds MongoDB has", () => {
    const capabilities = objectProvider.getCapabilities();

    expect(capabilities.containerLevels).toEqual([{ id: "schema", label: "Database", labelPlural: "Databases" }]);

    const kinds = capabilities.objectKinds ?? [];
    expect(kinds.map((k) => k.id)).toEqual(["collection", "view"]);
    expect(kinds.find((k) => k.id === "collection")?.role).toBe("relation");
    expect(kinds.find((k) => k.id === "view")?.role).toBe("relation");
    // A collection takes a document write, and that is a per-KIND fact deliberately not
    // conjoined with the engine-wide `supportsInlineRowEdit: false` this provider also
    // declares: the latter gates the results grid's `UPDATE ... SET`, which has no MongoDB
    // spelling, and conjoining them would drop this engine out of the import target list.
    expect(kinds.find((k) => k.id === "collection")?.acceptsRowWrites).toBe(true);
    // A view is read-only: `info.readOnly` is true on every one, measured.
    expect(kinds.find((k) => k.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(objectProvider.getCapabilities().supportsInlineRowEdit).toBe(false);
  });

  test("declares no kind for anything MongoDB does not have at container level", () => {
    const ids = (objectProvider.getCapabilities().objectKinds ?? []).map((k) => k.id);
    // An index name is unique per COLLECTION and not per database: creating `by_thing` on
    // `customers` AND on `orders` in one database both succeed, measured on 8.3.9, and the
    // fixture does exactly that. So an index is an attribute of the collection it is on and
    // belongs in describeObject's output, not in a folder of its own.
    expect(ids).not.toContain("index");
    // No stored routine of any shape. `$function`, `$accumulator`, `$where` and `system.js`
    // are all deprecated as of 8.0, `mapReduce` since 5.0, `db.eval` was removed in 4.2, and
    // Atlas Triggers and Functions are an Atlas control-plane feature this provider's wire
    // protocol cannot reach at all.
    expect(ids).not.toContain("function");
    expect(ids).not.toContain("procedure");
    expect(ids).not.toContain("trigger");
    // `$merge` and `$out` write an ordinary collection with no server-side marker of where
    // it came from, so there is nothing to list and no kind to declare.
    expect(ids).not.toContain("materialized_view");
  });

  // --------------------------------------------------------------------------
  // Conformance
  // --------------------------------------------------------------------------

  test("satisfies the object-surface contract on the committed fixture", async () => {
    await assertObjectSurface(objectProvider, {
      containers: [["app"], ["configstore"], ["oddnames"]],
      kinds: { collection: 4, view: 1 },
      sampleObject: { path: ["app", "customers"], kind: "collection" },
    });
  });

  // --------------------------------------------------------------------------
  // listContainers
  // --------------------------------------------------------------------------

  test("lists every database except the three the server owns, by exact name", async () => {
    const containers = await objectProvider.listContainers();

    expect(containers.map((c) => c.path)).toEqual([["app"], ["configstore"], ["oddnames"]]);
    expect(containers.map((c) => c.name)).toEqual(["app", "configstore", "oddnames"]);
    expect(containers.every((c) => c.level === 0)).toBe(true);
    // `configstore` starts with "config" and survives, which is what makes the exclusion an
    // exact-name list rather than a prefix rule. A prefix rule would hide a database a
    // person created, and `configstore` exists in the fixture to refute it.
    expect(containers.map((c) => c.name)).toContain("configstore");
  });

  test("orders containers itself rather than relying on the server having sorted them", async () => {
    // `listDatabases` came back alphabetical in both live measurements, so the committed
    // fixture cannot tell a provider that sorts from one that inherits the server's order.
    // MongoDB does not document that ordering, and the tree addresses by path, so the
    // guarantee is the provider's own and is pinned with a list the server did not sort.
    mockDatabaseList = [{ name: "oddnames" }, { name: "app" }, { name: "local" }, { name: "configstore" }];
    const containers = await objectProvider.listContainers();
    expect(containers.map((c) => c.name)).toEqual(["app", "configstore", "oddnames"]);
  });

  test("marks the connected database as the session default and no other", async () => {
    const containers = await objectProvider.listContainers();
    expect(containers.find((c) => c.name === "app")?.isSessionDefault).toBe(true);
    expect(containers.find((c) => c.name === "configstore")?.isSessionDefault).toBe(false);
  });

  test("asks the server for authorized databases by name only", async () => {
    await objectProvider.listContainers();
    // Pinned as statement text because the fake answers the same list either way. Without
    // `authorizedDatabases`, a role holding no cluster-wide `listDatabases` action gets a
    // refusal instead of the databases it CAN read: measured with a role granted only
    // `read` on one database, the flag turns a refusal into that one database.
    expect(lastListDatabasesCommand).toEqual({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
  });

  test("answers nothing under a container, because nothing nests under a database", async () => {
    expect(await objectProvider.listContainers(["app"])).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // countObjects and listObjects, which must not be able to disagree
  // --------------------------------------------------------------------------

  test("counts what the listing contains, kind by kind", async () => {
    const counts = await objectProvider.countObjects(["app"]);
    expect(counts).toEqual({ collection: { count: 4 }, view: { count: 1 } });

    for (const [kind, count] of Object.entries(counts)) {
      const listed = await objectProvider.listObjects(["app"], kind);
      expect(listed).toHaveLength((count as { count: number }).count);
    }
  });

  test("classifies a time series collection as a collection rather than losing it", async () => {
    // The 5a case, and the reason the fixture creates one. `listCollections` answers
    // `type: "timeseries"` for `readings`, so the classifier is "view versus everything
    // else". Written `type === "collection"` instead, this object would be absent from the
    // count AND from the listing at once - the two would still agree, so ruling 5f would
    // still hold while an object a person created was invisible in the tree.
    const listed = await objectProvider.listObjects(["app"], "collection");
    expect(listed.map((o) => o.name)).toContain("readings");
  });

  test("excludes internal namespaces from the count and the listing alike", async () => {
    const listed = await objectProvider.listObjects(["app"], "collection");
    const names = listed.map((o) => o.name);
    expect(names).not.toContain("system.views");
    expect(names).not.toContain("system.buckets.readings");
    // The reserved prefix is "system." with the dot: `system.mine` is refused with "not
    // authorized" and `systemetrics` is created without complaint, both measured. So a
    // collection whose name merely begins with the letters "system" is a person's.
    expect(names).toContain("systemetrics");
    expect(names).toEqual(["customers", "orders", "readings", "systemetrics"]);
  });

  test("orders objects by their path segments, not by a JSON rendering of the path", async () => {
    // `JSON.stringify(path)` is the obvious spelling and it is wrong: it sorts by the
    // ESCAPE SEQUENCE rather than by the name. These three collection names are legal
    // MongoDB ones (only the null byte and `$` are refused, measured) and differ only in a
    // character JSON escapes, so the two spellings produce different orders - and the
    // server's own order is the JSON one, which is what a sort-by-stringify provider would
    // pass by inheriting.
    const listed = await objectProvider.listObjects(["oddnames"], "collection");
    expect(listed.map((o) => o.name)).toEqual(['x"a', "x-a", "x\\a"]);
  });

  test("addresses an object under its container and labels it with its own name", async () => {
    const listed = await objectProvider.listObjects(["app"], "view");
    expect(listed).toEqual([{ path: ["app", "active_customers"], name: "active_customers", kind: "view" }]);
  });

  test("reads the database the CONTAINER names, not the one the session is in", async () => {
    const counts = await objectProvider.countObjects(["configstore"]);
    expect(counts).toEqual({ collection: { count: 1 }, view: { count: 0 } });
    expect(mongoOpenedDatabases).toEqual(["configstore"]);

    mongoOpenedDatabases = [];
    const listed = await objectProvider.listObjects(["configstore"], "collection");
    expect(listed.map((o) => o.path)).toEqual([["configstore", "settings"]]);
    expect(mongoOpenedDatabases).toEqual(["configstore"]);
  });

  test("carries the server's own sentence when a database's catalog is refused", async () => {
    // Measured: a role with `read` on one database only answers `listCollections` on any
    // other with "not authorized on adminx to execute command { listCollections: 1 ... }".
    // That is a refusal and not an empty database, and reporting it as 0 would say the
    // database is empty when nobody has looked.
    mockListCollectionsError.configstore = new Error("not authorized on configstore to execute command");

    const counts = await objectProvider.countObjects(["configstore"]);
    expect(counts).toEqual({
      collection: { unavailable: "not authorized on configstore to execute command" },
      view: { unavailable: "not authorized on configstore to execute command" },
    });
  });

  test("counts a declared kind the catalog holds none of as zero rather than omitting it", async () => {
    mockCollectionsByDb.app = [{ name: "customers", type: "collection" }];
    const counts = await objectProvider.countObjects(["app"]);
    // A declared-and-empty kind keeps its folder and its 0 badge; leaving it out of the
    // record makes the folder disappear.
    expect(counts).toEqual({ collection: { count: 1 }, view: { count: 0 } });
  });

  test("never counts a kind the declaration does not carry", async () => {
    // The declaration is the only thing that decides which kinds appear, and the classifier
    // is not allowed to add one: conformance invariant 2 fails a provider that answers for
    // an undeclared kind. Driven by narrowing the declaration to `view` alone while the
    // fixture still holds four collections.
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...objectProvider.getCapabilities(),
      objectKinds: [{ id: "view", role: "relation", label: "View", labelPlural: "Views" }],
    });
    expect(await objectProvider.countObjects(["app"])).toEqual({ view: { count: 1 } });
  });

  test("refuses a container path of the wrong shape rather than answering an empty database", async () => {
    await expect(objectProvider.countObjects([])).rejects.toThrow(/container path is \[database\]/);
    await expect(objectProvider.countObjects(["app", "extra"])).rejects.toThrow(/container path is \[database\]/);
  });

  test("refuses a kind this engine does not declare", async () => {
    await expect(objectProvider.listObjects(["app"], "index")).rejects.toThrow(/declares no object kind "index"/);
    await expect(objectProvider.describeObject(["app", "customers"], "index")).rejects.toThrow(
      /declares no object kind "index"/,
    );
  });

  // --------------------------------------------------------------------------
  // describeObject
  // --------------------------------------------------------------------------

  test("describes a collection with its inferred fields and its own indexes", async () => {
    const detail = await objectProvider.describeObject(["app", "customers"], "collection");
    expect(detail.path).toEqual(["app", "customers"]);
    expect(detail.columns.map((c) => c.name)).toEqual(["_id", "city", "name"]);
    expect(detail.columns.find((c) => c.name === "_id")?.isPrimary).toBe(true);
    expect(detail.indexes).toEqual([
      { name: "_id_", columns: ["_id"], unique: true },
      { name: "email_1", columns: ["email"], unique: false },
    ]);
    // MongoDB has no foreign key constraint at all, which is why the provider declares
    // `declaresForeignKeys: false`.
    expect(detail.foreignKeys).toEqual([]);
  });

  test("describes a view with its fields and claims no indexes for it", async () => {
    const detail = await objectProvider.describeObject(["app", "active_customers"], "view");
    expect(detail.path).toEqual(["app", "active_customers"]);
    expect(detail.columns.map((c) => c.name)).toEqual(["_id", "city", "name"]);
    // `listIndexes` on a view is refused with code 166, and the indexes its pipeline uses
    // belong to the collection underneath it: claiming them here would misattribute them.
    expect(detail.indexes).toEqual([]);
  });

  test("refuses a name the catalog does not hold under that kind", async () => {
    await expect(objectProvider.describeObject(["app", "nope"], "collection")).rejects.toThrow(
      /No MongoDB collection named nope in app/,
    );
    // The name IS in the catalog, as a view. The kind decides, so this is still a miss
    // rather than a view described as a collection.
    await expect(objectProvider.describeObject(["app", "active_customers"], "collection")).rejects.toThrow(
      /No MongoDB collection named active_customers in app/,
    );
  });

  test("refuses an object path of the wrong length", async () => {
    await expect(objectProvider.describeObject(["customers"], "collection")).rejects.toThrow(
      /"collection" path is \[database, name\]/,
    );
  });

  // --------------------------------------------------------------------------
  // Standing ruling 5g: no positional index, driven to a BOUND VALUE
  // --------------------------------------------------------------------------

  test("takes the database from the declared level, not from a position, at depth two", async () => {
    // MongoDB declares ONE container level, so `path[0]` and `container.length !== 1` are
    // behaviour-identical here and no fixture on this engine can tell the two spellings
    // apart. Three providers shipped that defect for exactly that reason. Swapping a
    // two-level declaration in through `getCapabilities` and driving it to the value the
    // driver was BOUND with is what kills both mutations on a one-level engine.
    const capabilities = objectProvider.getCapabilities();
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [
        { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });

    const counts = await objectProvider.countObjects(["cluster0", "app"]);
    expect(counts).toEqual({ collection: { count: 4 }, view: { count: 1 } });
    // The BOUND VALUE. `path[0]` would have opened `cluster0`, which holds nothing here.
    expect(mongoOpenedDatabases).toEqual(["app"]);

    mongoOpenedDatabases = [];
    const listed = await objectProvider.listObjects(["cluster0", "app"], "view");
    expect(listed.map((o) => o.path)).toEqual([["cluster0", "app", "active_customers"]]);
    expect(mongoOpenedDatabases).toEqual(["app"]);

    mongoOpenedDatabases = [];
    const detail = await objectProvider.describeObject(["cluster0", "app", "customers"], "collection");
    expect(detail.path).toEqual(["cluster0", "app", "customers"]);
    expect(detail.columns.map((c) => c.name)).toEqual(["_id", "city", "name"]);
    expect(mongoOpenedDatabases).toEqual(["app", "app"]);

    // And the hardcoded depth: a one-segment container is now the wrong shape, and a
    // three-segment object path is the right one.
    await expect(objectProvider.countObjects(["app"])).rejects.toThrow(/container path is \[cluster, database\]/);
  });

  test("refuses a declaration that carries no database level rather than reading one named undefined", async () => {
    const capabilities = objectProvider.getCapabilities();
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [{ id: "catalog", label: "Cluster", labelPlural: "Clusters" }],
    });
    await expect(objectProvider.countObjects(["cluster0"])).rejects.toThrow(
      /needs a "schema" container level and a segment for it/,
    );
  });
});
