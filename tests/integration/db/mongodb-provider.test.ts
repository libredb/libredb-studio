/**
 * MongoDB Provider Integration Tests
 *
 * Uses mock.module() from bun:test to replace the 'mongodb' driver with the stand-in in
 * `tests/helpers/mongodb-driver.ts` before importing the MongoDBProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
// The REAL Extended JSON serializer, taken before `mock.module` replaces the driver below
// and handed straight back to the mock, so the source read's rendering is exercised against
// the implementation that ships rather than against a double of it (#789). A double here
// would make every assertion about the rendered text an assertion about the test's own code,
// which is the shape standing ruling 5b catalogues as a fake that cannot see a change.
import * as realMongoDriver from "mongodb";
import {
  MockBinary,
  type MockCollectionInfo,
  MockObjectId,
  mongoDriver,
  mongoDriverModule,
  mongoServerError,
  resetMongoDriver,
} from "../../helpers/mongodb-driver";

// ============================================================================
// Mock Setup — MUST come before provider import
// ============================================================================

mock.module("mongodb", () => mongoDriverModule());

/** A placeholder credential: the driver is mocked, so nothing ever authenticates with it. */
const TEST_PASSWORD = "password";

/** The collections one captured sample pipeline names, first arm included. */
function pipelineNamespaces(pipeline: Record<string, unknown>[]): string[] {
  const first = (pipeline[1] as { $project?: { __ks?: { $literal?: string } } })?.$project?.__ks?.$literal;
  const rest = pipeline.slice(2).map((stage) => (stage as { $unionWith?: { coll?: string } }).$unionWith?.coll ?? "");
  return [String(first), ...rest];
}

/** What FerretDB 2.7.0 replies to `authorizedDatabases`, as measured in #1299. */
const FERRETDB_UNKNOWN_FIELD = "authorizedDatabases is an unknown field";

// ============================================================================
// Provider import — AFTER mock registration
// ============================================================================

const { MongoDBProvider } = await import("@/lib/db/providers/document/mongodb");
const {
  AuthenticationError,
  DatabaseConfigError,
  ConnectionError,
  ExecutionProfileError,
  PermissionDeniedError,
  QueryError,
} = await import("@/lib/db/errors");
const { createErrorResponse } = await import("@/lib/api/errors");
const { ApiErrorCode } = await import("@/lib/api/error-codes");
const { AGENT_VERIFY_MAX_TIME_MS } = await import("@/lib/db/providers/document/mongodb/agent-boundary");
const { rowBudgetIn } = await import("@/lib/agent/context-snapshot");
const { assertObjectSurface } = await import("../../helpers/object-surface-conformance");
const { isSourcePartUnavailable } = await import("@/lib/db/object-kinds");

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

/**
 * `listCollections` on `configstore`, verbatim.
 *
 * `dark_settings` is the ADVERSARIAL view and it is the only object in the fixture that can
 * tell two renderings of a view apart (#789). Measured on MongoDB 8.2.12: `options` carries
 * `collation` as well as `viewOn` and `pipeline`, expanded by the server from the two fields
 * the fixture asked for to the ten below, so a read rendering only the design's two fields
 * would drop it while calling itself complete; and the pipeline holds a REGULAR EXPRESSION
 * and a DATE, which `JSON.stringify` renders as `{}` and an ISO string while MongoDB
 * Extended JSON renders as `$regularExpression` and `$date`. `app.active_customers` carries
 * no BSON value at all, so the two renderings are byte-identical there and only this view
 * refutes the lossy one.
 *
 * `system.views` appears here for the same reason it appears in `app`: the server creates it
 * the moment the first view in a database is created, and it is excluded by the reserved
 * prefix rather than by anything this fixture wrote.
 */
const OBJECT_FIXTURE_CONFIGSTORE: MockCollectionInfo[] = [
  { name: "settings", type: "collection" },
  { name: "system.views", type: "collection" },
  {
    name: "dark_settings",
    type: "view",
    options: {
      viewOn: "settings",
      pipeline: [{ $match: { key: /^th/i, changed: { $gt: new Date("2026-01-01T00:00:00Z") } } }],
      collation: {
        locale: "tr",
        caseLevel: false,
        caseFirst: "off",
        strength: 2,
        numericOrdering: false,
        alternate: "non-ignorable",
        maxVariable: "punct",
        normalization: false,
        backwards: false,
        version: "57.1",
      },
    },
  },
];

/**
 * The definition text `app.active_customers` reads as, byte for byte (#789).
 *
 * Captured from a live MongoDB 8.2.12 holding `docker/mongodb-init/01-object-fixture.js`,
 * through the same `BSON.EJSON.stringify` the provider calls. This view's pipeline holds no
 * BSON value, so plain `JSON.stringify` produces the same bytes and only the other view
 * below can tell the two renderings apart.
 */
const OBJECT_FIXTURE_APP_VIEW_SOURCE = `{
  "viewOn": "customers",
  "pipeline": [
    {
      "$match": {
        "city": "Istanbul"
      }
    }
  ]
}`;

/**
 * The definition text `configstore.dark_settings` reads as, byte for byte (#789).
 *
 * Also captured from the live container, and it is what refutes the two shapes this read
 * could otherwise have taken. `collation` is present, so a read rendering only `viewOn` and
 * `pipeline` would drop it while claiming `form: "complete"`. The regular expression renders
 * as `$regularExpression` and the date as `$date`, where `JSON.stringify` renders them as
 * `{}` and an ISO string, losing the pattern with no error anywhere.
 */
const OBJECT_FIXTURE_CONFIGSTORE_VIEW_SOURCE = `{
  "viewOn": "settings",
  "pipeline": [
    {
      "$match": {
        "key": {
          "$regularExpression": {
            "pattern": "^th",
            "options": "i"
          }
        },
        "changed": {
          "$gt": {
            "$date": "2026-01-01T00:00:00Z"
          }
        }
      }
    }
  ],
  "collation": {
    "locale": "tr",
    "caseLevel": false,
    "caseFirst": "off",
    "strength": 2,
    "numericOrdering": false,
    "alternate": "non-ignorable",
    "maxVariable": "punct",
    "normalization": false,
    "backwards": false,
    "version": "57.1"
  }
}`;

/**
 * One rejection shaped like the SERVER's own error reply (#789).
 *
 * MEASURED against mongodb 7.6.0 and MongoDB 8.2.12: an unauthorized `listCollections` rejects
 * with a `MongoServerError`, whose `name` and `constructor.name` are both that string. The
 * provider tells a refusal from a transport failure by that NAME rather than by `instanceof`,
 * because this suite replaces the whole driver module and an `instanceof` against its export
 * would be `instanceof undefined` here. So the fake has to carry the name too, or every refusal
 * test would be driving the transport arm instead.
 */
function serverErrorReply(message: string): Error {
  const error = new Error(message);
  error.name = "MongoServerError";
  return error;
}

function resetObjectSurfaceMocks(): void {
  mongoDriver.databaseList = [];
  mongoDriver.collectionsByDb = {};
  mongoDriver.listCollectionsErrors = {};
  mongoDriver.maintenanceRefusals = {};
  mongoDriver.documentsByNs = {};
  mongoDriver.openedDatabases = [];
  mongoDriver.samplePipelines = [];
  mongoDriver.indexReads = [];
  mongoDriver.foundCollections = [];
  mongoDriver.findErrors = {};
  mongoDriver.args = {};
  mongoDriver.lastListDatabasesCommand = {};
  mongoDriver.listDatabasesCommands = [];
  mongoDriver.listDatabasesRefusal = undefined;
  mongoDriver.connectBehavior = undefined;
  mongoDriver.heartbeatFailure = undefined;
  mongoDriver.clientCloses = [];
  mongoDriver.heartbeatListeners = [];
}

function useObjectFixture(): void {
  mongoDriver.databaseList = OBJECT_FIXTURE_DATABASES;
  mongoDriver.collectionsByDb = {
    app: OBJECT_FIXTURE_APP,
    configstore: OBJECT_FIXTURE_CONFIGSTORE,
    oddnames: OBJECT_FIXTURE_ODDNAMES,
  };
  mongoDriver.documentsByNs = {
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
    resetMongoDriver();
    mongoDriver.collectionData = [
      { _id: new MockObjectId("aaa"), name: "Alice", email: "alice@test.com" },
      { _id: new MockObjectId("bbb"), name: "Bob", email: "bob@test.com" },
    ];
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

    // #843: the database named at connect is only the default for a statement that names
    // none, since every statement the product writes carries its own. So it is optional
    // in field mode as well, the way it always was with a connection string.
    test("accepts a missing database without a connectionString", () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            database: undefined,
            connectionString: undefined,
          }),
      ).not.toThrow();
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
      expect(mongoDriver.lastUri).toBe("mongodb://localhost:27017/testdb");
    });

    test("names no database in the path when none is configured", async () => {
      // The path database is also the driver's default auth database, so a stand-in like
      // `/test` would authenticate an `admin` user against `test` and fail as bad
      // credentials. An empty path leaves the driver's own default, which is `admin`.
      provider = new MongoDBProvider({ ...baseConfig, database: undefined, user: "app", password: TEST_PASSWORD });
      await provider.connect();
      expect(mongoDriver.lastUri).toBe(`mongodb://app:${TEST_PASSWORD}@localhost:27017/`);
    });

    test("keeps the auth database when no database is configured", async () => {
      provider = new MongoDBProvider({ ...baseConfig, database: undefined, authSource: "admin" });
      await provider.connect();
      expect(mongoDriver.lastUri).toBe("mongodb://localhost:27017/?authSource=admin");
    });

    test("names the auth database as ?authSource, and percent-encodes it", async () => {
      // MongoDB keeps users in one database and the data in another, and the driver
      // authenticates against the database in the URI when nothing says otherwise. So
      // the ordinary deployment - users in `admin`, data elsewhere - could not be
      // reached through the form fields at all: it failed as a credentials error.
      provider = new MongoDBProvider({ ...baseConfig, user: "app", password: "s3cret", authSource: "admin db" });
      await provider.connect();
      expect(mongoDriver.lastUri).toBe("mongodb://app:s3cret@localhost:27017/testdb?authSource=admin%20db");
    });

    // The session database is read from the URI's PATH, after the authority. A regex over
    // the whole string used to take the host of a path-less URI as the database name.
    for (const [uri, expected] of [
      ["mongodb://remote:27017/shop", "shop"],
      [`mongodb://app:${TEST_PASSWORD}@remote:27017/?authSource=admin`, "test"],
      ["mongodb://remote:27017", "test"],
      [`mongodb+srv://app:${TEST_PASSWORD}@cluster.example.net/shop?retryWrites=true`, "shop"],
    ] as const) {
      test(`the session database of ${uri} is ${expected}`, async () => {
        provider = new MongoDBProvider({ ...baseConfig, database: undefined, connectionString: uri });
        await provider.connect();
        expect(mongoDriver.openedDatabases).toEqual([expected]);
      });
    }

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
      expect(mongoDriver.lastUri).toBe("mongodb://app:s3cret@remote:27017/shop?authSource=users&replicaSet=rs0");
    });
  });

  // --------------------------------------------------------------------------
  // TLS
  // --------------------------------------------------------------------------

  describe("the TLS options handed to the driver", () => {
    const connectWithSSL = async (ssl: DatabaseConnection["ssl"], extra: Partial<DatabaseConnection> = {}) => {
      provider = new MongoDBProvider({ ...baseConfig, ...extra, ssl });
      await provider.connect();
      return mongoDriver.lastOptions;
    };

    test("carries no tls option when the connection names no SSL config", async () => {
      await provider.connect();
      expect("tls" in mongoDriver.lastOptions).toBe(false);
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
      expect(mongoDriver.lastUri).toBe("mongodb://remote:27017/shop");
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

    // #1458: server selection is a retry loop the driver runs until its own deadline, and
    // `serverSelectionTimeoutMS` is a client option it applies to every query and write,
    // so the bound has to clear a replica set election as well as the initial dial. The
    // defect was handing it `pool.acquireTimeout` - 60000 by default - which made Test
    // Connection to a port nothing listens on spin for a minute before the `ECONNREFUSED`
    // it already had. `connectTimeoutMS` did not bound it: that caps one TCP attempt, and a
    // refusal fails that attempt at once.
    test("server selection carries its own bound, not the pool acquire timeout", async () => {
      await provider.connect();
      expect(mongoDriver.lastOptions.serverSelectionTimeoutMS).toBe(30000);
      expect(mongoDriver.lastOptions.connectTimeoutMS).toBe(60000);
    });

    test("a configured pool still reaches the driver, and does not move the selection bound", async () => {
      provider = new MongoDBProvider(
        { ...baseConfig },
        { pool: { min: 1, max: 4, idleTimeout: 12000, acquireTimeout: 25000 } },
      );
      await provider.connect();
      expect(mongoDriver.lastOptions).toMatchObject({
        minPoolSize: 1,
        maxPoolSize: 4,
        maxIdleTimeMS: 12000,
        connectTimeoutMS: 25000,
        serverSelectionTimeoutMS: 30000,
      });
    });

    // #1573: the request that starts a connect carries its own deadline, `queryTimeout`,
    // which `connect()` used not to read. The driver's server selection waits out its own
    // 30 s bound on a closed port (#1458), so Test Connection spun past the request's
    // query timeout. The contract here is pinned against a mocked driver; the wall-clock
    // measurement against the real one is `mongodb-server-selection.test.ts`.
    describe("the request's query timeout bounds connect() (#1573)", () => {
      test("a connect that outlives queryTimeout is refused, the client closed, and the refusal names the driver's error", async () => {
        mongoDriver.connectBehavior = () => new Promise<void>(() => {});
        mongoDriver.heartbeatFailure = new Error("connect ECONNREFUSED 127.0.0.1:27999");
        const deadlineProvider = new MongoDBProvider({ ...baseConfig }, { queryTimeout: 25 });

        const started = Date.now();
        let refusal = "";
        try {
          await deadlineProvider.connect();
          refusal = "connect() returned while its driver was still selecting";
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
        const elapsed = Date.now() - started;

        // The deadline is queryTimeout (25 ms here), not the driver's 30 s: the margin
        // is for a slow machine, the defect waits the driver's own bound out.
        expect(elapsed).toBeLessThan(5000);
        expect(refusal).toContain("ECONNREFUSED");
        // No client outlives a timed-out connect: close() was called on it.
        expect(mongoDriver.clientCloses[0]).toBeGreaterThan(0);

        await deadlineProvider.disconnect();
      }, 10_000);

      test("a later connect() starts fresh after a timed-out one", async () => {
        let release: (() => void) | undefined;
        mongoDriver.connectBehavior = () => new Promise<void>((resolve) => (release = resolve));
        mongoDriver.heartbeatFailure = new Error("connect ECONNREFUSED 127.0.0.1:27999");
        const deadlineProvider = new MongoDBProvider({ ...baseConfig }, { queryTimeout: 25 });

        await expect(deadlineProvider.connect()).rejects.toThrow(/ECONNREFUSED/);
        // The connect settles after the deadline (the SRV window: `_connect` resolves
        // SRV before it creates the topology, so a close during the lookup is a no-op)
        // and the client is closed again once it does: the close count goes from 1
        // (the deadline path) to 2 (the settle), pinning the second close.
        expect(mongoDriver.clientCloses.length).toBe(1);
        expect(mongoDriver.clientCloses[0]).toBe(1);
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(mongoDriver.clientCloses.length).toBe(1);
        expect(mongoDriver.clientCloses[0]).toBe(2);

        // A fresh connect succeeds on the same provider, on a new client.
        mongoDriver.connectBehavior = undefined;
        await deadlineProvider.connect();
        expect(deadlineProvider.isConnected()).toBe(true);
        expect(mongoDriver.clientCloses.length).toBe(2);

        await deadlineProvider.disconnect();
      }, 10_000);

      test("a timed-out connect clears the provider's client so a later disconnect() closes nothing", async () => {
        // Pins `this.client = null` on the timeout path (#1573). Deleting that clear
        // leaves the timed-out client on the provider: every query is still refused
        // (the state is not connected), but a later `disconnect()` finds the stale
        // client and closes it a third time.
        let release: (() => void) | undefined;
        mongoDriver.connectBehavior = () => new Promise<void>((resolve) => (release = resolve));
        mongoDriver.heartbeatFailure = new Error("connect ECONNREFUSED 127.0.0.1:27999");
        const deadlineProvider = new MongoDBProvider({ ...baseConfig }, { queryTimeout: 25 });

        await expect(deadlineProvider.connect()).rejects.toThrow(/ECONNREFUSED/);
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
        // The deadline closed the client once and the settle closed it again.
        expect(mongoDriver.clientCloses.length).toBe(1);
        expect(mongoDriver.clientCloses[0]).toBe(2);

        // With the clear, `disconnect()` is a no-op: the client it would close is
        // already gone. Without it, the stale client takes a third close.
        await deadlineProvider.disconnect();
        expect(mongoDriver.clientCloses.length).toBe(1);
        expect(mongoDriver.clientCloses[0]).toBe(2);
      }, 10_000);

      test("a failed connect leaves no half-open client behind", async () => {
        // The driver's own refusal, before any deadline: `connect()` used to keep
        // `this.client` set while `this.db` stayed null, so a later `connect()` found
        // the half-open one and returned as if it were connected (#1573).
        mongoDriver.connectBehavior = async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:27999");
        };
        const failingProvider = new MongoDBProvider({ ...baseConfig });
        await expect(failingProvider.connect()).rejects.toThrow(/ECONNREFUSED/);
        expect(mongoDriver.clientCloses.length).toBe(1);
        expect(mongoDriver.clientCloses[0]).toBeGreaterThan(0);

        mongoDriver.connectBehavior = undefined;
        await failingProvider.connect();
        expect(failingProvider.isConnected()).toBe(true);
        expect(mongoDriver.clientCloses.length).toBe(2);

        await failingProvider.disconnect();
      });

      test("a connect within the deadline is untouched: one client, no close", async () => {
        const fastProvider = new MongoDBProvider({ ...baseConfig }, { queryTimeout: 10000 });
        await fastProvider.connect();
        expect(fastProvider.isConnected()).toBe(true);
        expect(mongoDriver.clientCloses.length).toBe(1);
        expect(mongoDriver.clientCloses[0]).toBe(0);
        await fastProvider.disconnect();
      });
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
        kill: { label: "Kill Operation", perEntity: false, global: false },
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
      expect(caps.createTable).toBeUndefined();
      // No SQL at all here: the query language is JSON commands, so the inline row
      // editor's `UPDATE ... SET` has nothing to run against (#269).
      expect(caps.supportsInlineRowEdit).toBe(false);
      // The generator writes `insertMany`, not the grid's `UPDATE ... SET`, so it is offered (#1468).
      expect(caps.supportsTestDataGeneration).toBe(true);
      // `prepareQuery` pins `offset` to 0 and returns the command untouched, so page two
      // would be page one. The control is hidden rather than offered (#816).
      expect(caps.supportsResultPagination).toBe(false);
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
      for (const key of ["collection", "operation", "filter", "pipeline", "field", "database"]) {
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

    // Measured 2026-10-03 on mongo 8.2.12: two documents of different shape answered
    // the first document's keys as the columns, so the other document's fields were in
    // the rows (and the JSON export) but in no grid column and no CSV/SQL/DDL export.
    test("find answers the union of the documents' keys as columns, first seen first", async () => {
      mongoDriver.documentsByNs["testdb.mixed"] = [
        { _id: new MockObjectId("b1"), name: "B", ts: 1 },
        { _id: new MockObjectId("a1"), name: "A", balance: 10, tags: ["x"] },
        { _id: new MockObjectId("c1"), ts: 2, re: "^a" },
      ];
      const result = await provider.query(JSON.stringify({ collection: "mixed", operation: "find", filter: {} }));
      expect(result.fields).toEqual(["_id", "name", "ts", "balance", "tags", "re"]);
      expect(result.rows.length).toBe(3);
    });

    // BSON carries an empty key (`BSON.deserialize(BSON.serialize({ "": 1 }))` answers `{ "": 1 }`,
    // measured in-process 2026-10-07), and a grid column cannot take an empty id.
    test("a document key that is empty is answered under a name of its own", async () => {
      mongoDriver.documentsByNs["testdb.blank"] = [
        { _id: new MockObjectId("b1"), "": "blank" },
        { _id: new MockObjectId("b2"), name: "B" },
      ];
      const result = await provider.query(JSON.stringify({ collection: "blank", operation: "find", filter: {} }));
      expect(result.fields).toEqual(["_id", "(No column name)", "name"]);
      expect(result.rows).toEqual([
        { _id: "b1", "(No column name)": "blank" },
        { _id: "b2", name: "B" },
      ]);
    });

    test("an empty find answers no columns", async () => {
      mongoDriver.documentsByNs["testdb.empty"] = [];
      const result = await provider.query(JSON.stringify({ collection: "empty", operation: "find", filter: {} }));
      expect(result.fields).toEqual([]);
    });

    // #843: `database` names the database a command runs in, so a collection outside
    // the connected one is reachable. Before the key existed, the same statement
    // silently read the same-named collection in the CONNECTED database instead - a
    // wrong answer, not an error.
    test("database key reads a collection in another database", async () => {
      mongoDriver.documentsByNs["otherdb.users"] = [{ _id: new MockObjectId("z1"), name: "Zoe" }];
      const result = await provider.query(
        JSON.stringify({ database: "otherdb", collection: "users", operation: "find", filter: {} }),
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe("Zoe");
      expect(mongoDriver.foundCollections).toEqual(["otherdb.users"]);
    });

    test("a statement with no database key reads the connected database", async () => {
      // Every statement written before the key existed, saved queries and snippets alike.
      mongoDriver.documentsByNs["otherdb.users"] = [{ _id: new MockObjectId("z1"), name: "Zoe" }];
      const result = await provider.query(JSON.stringify({ collection: "users", operation: "find", filter: {} }));
      expect(result.rows.length).toBe(2);
      expect(mongoDriver.foundCollections).toEqual(["testdb.users"]);
    });

    test("a database the credentials cannot read raises the server's own sentence", async () => {
      // Not an empty result: a refusal read as 0 rows is the #843 failure in another form.
      const sentence = 'not authorized on analytics to execute command { find: "events" }';
      mongoDriver.findErrors["analytics.events"] = Object.assign(new Error(sentence), { code: 13 });
      await expect(
        provider.query(JSON.stringify({ database: "analytics", collection: "events", operation: "find" })),
      ).rejects.toThrow(sentence);
    });

    // The server's reply as the driver hands it on, measured in this file's #789 notes: `code: 13` and
    // `codeName: "Unauthorized"` on a MongoServerError. A role without the action is a missing privilege, not a
    // refused credential, and it used to fall through to a 500.
    test("a command the role may not run (13, Unauthorized) is a PermissionDeniedError answered 403", async () => {
      const sentence = 'not authorized on analytics to execute command { find: "events" }';
      mongoDriver.findErrors["analytics.events"] = Object.assign(serverErrorReply(sentence), {
        code: 13,
        codeName: "Unauthorized",
      });

      const refused = await provider
        .query(JSON.stringify({ database: "analytics", collection: "events", operation: "find" }))
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PermissionDeniedError);
      const response = createErrorResponse(refused, { route: "api/db/query" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: `Permission denied: ${sentence}`,
        code: ApiErrorCode.PERMISSION_DENIED,
        statusCode: 403,
      });
    });

    test("a refused credential (18, AuthenticationFailed) is still an AuthenticationError answered 401", async () => {
      mongoDriver.findErrors["analytics.events"] = Object.assign(serverErrorReply("Authentication failed."), {
        code: 18,
        codeName: "AuthenticationFailed",
      });

      const refused = await provider
        .query(JSON.stringify({ database: "analytics", collection: "events", operation: "find" }))
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(AuthenticationError);
      expect(createErrorResponse(refused, { route: "api/db/query" }).status).toBe(401);
    });

    test("a non-string or empty database is a QueryError naming the key", async () => {
      for (const database of [42, "", null]) {
        const error = await provider
          .query(JSON.stringify({ database, collection: "users", operation: "find" }))
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toContain('"database" must be a non-empty string');
      }
      // Refused before any database is opened: `MongoClient.db("")` is not a question to send.
      expect(mongoDriver.openedDatabases).toEqual(["testdb"]);
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

    // ------------------------------------------------------------------------
    // Extended JSON. Plain JSON has no ObjectId and no Date, so before the query was
    // read as Extended JSON a document shown in the grid could not be found, updated
    // or deleted by its `_id`: `{"$oid": ...}` reached the server as an operator and
    // failed `unknown operator: $oid`, and `{"$date": ...}` in an insert was stored
    // as a subdocument with a `$date` key (measured on MongoDB 8.2.12, 2026-10-03).
    // ------------------------------------------------------------------------

    describe("Extended JSON", () => {
      const { BSON } = realMongoDriver;
      const OID = "650000000000000000000001";
      const run = (statement: Record<string, unknown>) => provider.query(JSON.stringify(statement));

      test("a $oid filter reaches find as an ObjectId", async () => {
        await run({ collection: "users", operation: "find", filter: { _id: { $oid: OID } } });
        const filter = mongoDriver.args.find[0] as Record<string, unknown>;
        expect(filter._id).toBeInstanceOf(BSON.ObjectId);
        expect((filter._id as InstanceType<typeof BSON.ObjectId>).toHexString()).toBe(OID);
      });

      test("relaxed and canonical $date both reach a range filter as a Date", async () => {
        const instant = Date.parse("2020-01-01T00:00:00Z");
        await run({
          collection: "users",
          operation: "find",
          filter: {
            created: {
              $gt: { $date: "2020-01-01T00:00:00Z" },
              $gte: { $date: instant },
              $lt: { $date: { $numberLong: String(instant) } },
            },
          },
        });
        const range = (mongoDriver.args.find[0] as { created: Record<string, unknown> }).created;
        for (const bound of [range.$gt, range.$gte, range.$lt]) {
          expect(bound).toBeInstanceOf(Date);
          expect((bound as Date).getTime()).toBe(instant);
        }
      });

      test("every operation reads its filter, pipeline, update and documents as Extended JSON", async () => {
        const filter = { _id: { $oid: OID } };
        const when = { $date: "2025-01-01T00:00:00Z" };
        await run({ collection: "users", operation: "findOne", filter });
        await run({ collection: "users", operation: "count", filter });
        await run({ collection: "users", operation: "distinct", field: "name", filter });
        await run({ collection: "users", operation: "aggregate", pipeline: [{ $match: { when: { $gte: when } } }] });
        await run({ collection: "users", operation: "insertOne", documents: [{ when }] });
        await run({ collection: "users", operation: "insertMany", documents: [{ when }, { when }] });
        await run({ collection: "users", operation: "updateOne", filter, update: { $set: { when } } });
        await run({ collection: "users", operation: "updateMany", filter, update: { $set: { when } } });
        await run({ collection: "users", operation: "deleteOne", filter });
        await run({ collection: "users", operation: "deleteMany", filter });

        const isOid = (value: unknown) => (value as { _id: unknown })._id instanceof BSON.ObjectId;
        expect(isOid(mongoDriver.args.findOne[0])).toBe(true);
        expect(isOid(mongoDriver.args.countDocuments[0])).toBe(true);
        expect(isOid(mongoDriver.args.distinct[1])).toBe(true);
        expect(isOid(mongoDriver.args.updateOne[0])).toBe(true);
        expect(isOid(mongoDriver.args.updateMany[0])).toBe(true);
        expect(isOid(mongoDriver.args.deleteOne[0])).toBe(true);
        expect(isOid(mongoDriver.args.deleteMany[0])).toBe(true);

        const pipeline = mongoDriver.args.aggregate[0] as { $match: { when: { $gte: unknown } } }[];
        expect(pipeline[0].$match.when.$gte).toBeInstanceOf(Date);
        expect((mongoDriver.args.insertOne[0] as { when: unknown }).when).toBeInstanceOf(Date);
        for (const doc of mongoDriver.args.insertMany[0] as { when: unknown }[]) expect(doc.when).toBeInstanceOf(Date);
        expect((mongoDriver.args.updateOne[1] as { $set: { when: unknown } }).$set.when).toBeInstanceOf(Date);
        expect((mongoDriver.args.updateMany[1] as { $set: { when: unknown } }).$set.when).toBeInstanceOf(Date);
      });

      test("the typed wrappers arrive as the BSON types they name, a 64-bit integer exactly", async () => {
        await run({
          collection: "users",
          operation: "insertOne",
          documents: [
            {
              big: { $numberLong: "9007199254740993" },
              price: { $numberDecimal: "19.99" },
              blob: { $binary: { base64: "AQI=", subType: "00" } },
              uid: { $uuid: "3b241101-e2bb-4255-8caf-4136c566a962" },
              pattern: { $regularExpression: { pattern: "^th", options: "i" } },
              ts: { $timestamp: { t: 1700000000, i: 1 } },
            },
          ],
        });
        const doc = mongoDriver.args.insertOne[0] as Record<string, unknown>;
        // 2^53 + 1: a JS number cannot hold it, and relaxed Extended JSON alone would round it
        // to ...992. A bigint is what the driver writes as a 64-bit integer.
        expect(doc.big).toBe(BigInt("9007199254740993"));
        expect(doc.price).toBeInstanceOf(BSON.Decimal128);
        expect(String(doc.price)).toBe("19.99");
        expect(doc.blob).toBeInstanceOf(BSON.Binary);
        expect(doc.uid).toBeInstanceOf(BSON.Binary);
        expect((doc.uid as InstanceType<typeof BSON.Binary>).sub_type).toBe(4);
        expect(doc.pattern).toBeInstanceOf(BSON.BSONRegExp);
        expect(doc.ts).toBeInstanceOf(BSON.Timestamp);
      });

      test("plain JSON reaches the driver exactly as JSON.parse read it", async () => {
        // Plain numbers stay JS numbers, so an int32-range integer is still written as int32
        // and anything else as a double, as before, and operators are left alone.
        const filter = { age: { $gt: 18, $in: [1, 3000000000, 2.5] }, name: { $type: "string" }, tags: ["a"] };
        await run({ collection: "users", operation: "find", filter, options: { limit: 10 } });
        expect(mongoDriver.args.find[0]).toEqual(filter);
      });

      test("a malformed wrapper is a QueryError carrying the reason", async () => {
        const error = await run({ collection: "users", operation: "find", filter: { _id: { $oid: "nope" } } }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toContain('Invalid Extended JSON in the query at "filter._id"');
        expect((error as Error).message).toContain("24 character hex string");
      });

      test("an operator object beside $regex keeps every key, so a delete runs the filter that was written", async () => {
        // The bson parser alone turns `{"$regex": "^a", "$nin": ["admin"]}` into the bare
        // regular expression and drops `$nin`, so this `deleteMany` would delete `admin` too.
        const filter = {
          name: { $regex: "^a", $nin: ["admin"] },
          email: { $regex: "^a", $options: "i", $ne: "a@x.io" },
        };
        await run({ collection: "users", operation: "deleteMany", filter });
        expect(mongoDriver.args.deleteMany[0]).toEqual(filter);
      });

      test("a wrapper sharing its object with another key is refused, naming both", async () => {
        for (const [bound, other] of [
          [{ $date: "2020-01-01T00:00:00Z", $lt: 5 }, "$lt"],
          [{ $timestamp: { t: 1, i: 1 }, $gt: 0 }, "$gt"],
          [{ $oid: "650000000000000000000001", note: "x" }, "note"],
          // The legacy binary form carries `$type` beside `$binary`, so it is refused too.
          [{ $binary: "AQI=", $type: "00" }, "$type"],
        ] as const) {
          const error = await run({ collection: "users", operation: "deleteMany", filter: { f: bound } }).catch(
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(QueryError);
          expect((error as Error).message).toContain('at "filter.f"');
          expect((error as Error).message).toContain(`also has ${other}`);
        }
        expect(mongoDriver.args.deleteMany).toBeUndefined();
      });

      test("an integral $numberDouble stays a double", async () => {
        await run({ collection: "users", operation: "insertOne", documents: [{ x: { $numberDouble: "5" } }] });
        const x = (mongoDriver.args.insertOne[0] as { x: unknown }).x;
        expect(x).toBeInstanceOf(BSON.Double);
        expect(Number(x)).toBe(5);
      });

      test("a $numberLong outside the 64-bit range is refused, never wrapped to a negative", async () => {
        const error = await run({
          collection: "users",
          operation: "insertOne",
          documents: [{ n: { $numberLong: "9223372036854775808" } }],
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toContain("outside the 64-bit integer range");
        expect(mongoDriver.args.insertOne).toBeUndefined();

        // The edges themselves are integers, and an explicit plus sign names the same one.
        await run({
          collection: "users",
          operation: "insertOne",
          documents: [
            {
              min: { $numberLong: "-9223372036854775808" },
              max: { $numberLong: "9223372036854775807" },
              signed: { $numberLong: "+7" },
            },
          ],
        });
        expect(mongoDriver.args.insertOne[0]).toEqual({
          min: BigInt("-9223372036854775808"),
          max: BigInt("9223372036854775807"),
          signed: BigInt(7),
        });
      });

      test("the keys outside the recognised wrappers stay literal subdocuments, as before", async () => {
        const document = {
          code: { $code: "function () {}" },
          ref: { $ref: "users", $id: "abc" },
          sym: { $symbol: "s" },
          undef: { $undefined: true },
          pointer: { $dbPointer: { $ref: "users", $id: "abc" } },
        };
        await run({ collection: "users", operation: "insertOne", documents: [document] });
        expect(mongoDriver.args.insertOne[0]).toEqual(document);
      });

      test("a typed _id the write echoes back is a value the response can carry", async () => {
        // `JSON.stringify` throws on a bigint, which answered a committed insert with an error.
        const one = await run({
          collection: "users",
          operation: "insertOne",
          documents: [{ _id: { $numberLong: "9007199254740993" } }],
        });
        expect(one.rows[0].insertedId).toBe("9007199254740993");
        expect(() => JSON.stringify(one)).not.toThrow();

        const many = await run({
          collection: "users",
          operation: "insertMany",
          documents: [{ _id: { $numberLong: "5" } }, { _id: { $numberLong: "9007199254740993" } }],
        });
        expect(many.rows[0].insertedIds).toEqual([5, "9007199254740993"]);

        const double = await run({
          collection: "users",
          operation: "insertOne",
          documents: [{ _id: { $numberDouble: "2" } }],
        });
        expect(double.rows[0].insertedId).toBe(2);
        expect(() => JSON.stringify([many, double])).not.toThrow();
      });

      test("a $date that names no instant is refused, never written as the epoch", async () => {
        // `Date.parse` answers NaN for it, and the driver serialises an invalid Date as 0:
        // 1970-01-01, in silence.
        const error = await run({
          collection: "users",
          operation: "insertMany",
          documents: [{ ok: { $date: "2025-01-01T00:00:00Z" } }, { tags: [{ when: { $date: "next tuesday" } }] }],
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toContain("documents.1.tags.0.when");
        expect(mongoDriver.args.insertMany).toBeUndefined();
      });
    });
  });

  // --------------------------------------------------------------------------
  // getSchema()
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    beforeEach(async () => {
      await provider.connect();
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
      mongoDriver.serverStatus = () => ({ connections: { current: 5, available: 95 }, uptime: 86400 });
      const health = await provider.getHealth();
      expect(health.cacheHitRatio).toBe("N/A");
    });

    test("a cache nothing has been requested from yet reports the ratio as unavailable", async () => {
      mongoDriver.serverStatus = () => ({
        connections: { current: 5, available: 95 },
        uptime: 86400,
        wiredTiger: { cache: { "pages read into cache": 0, "pages requested from the cache": 0 } },
      });
      const health = await provider.getHealth();
      // No requests means no hits and no misses - there is no ratio, not a 100%.
      expect(health.cacheHitRatio).toBe("N/A");
    });

    test("a cache that served nothing from memory reports a measured zero", async () => {
      mongoDriver.serverStatus = () => ({
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
      mongoDriver.serverStatus = () => {
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
      mongoDriver.serverStatus = () => ({ uptime: 86400 });
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(false);
    });

    test("a server with zero open connections keeps its measured zero", async () => {
      // The anti-vacuity twin of the two tests above. Absence must never be spelled
      // with a falsy test (`activeConnections || undefined`): 0 here is a reading.
      mongoDriver.serverStatus = () => ({ connections: { current: 0, available: 100 }, uptime: 86400 });
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
      mongoDriver.dbStats = () => ({ indexSize: 512, storageSize: 4096 });
      expect((await provider.getHealth()).databaseSize).toBe("N/A");
    });

    test("a database that really measures zero bytes still reports 0 B", async () => {
      // The anti-vacuity twin: an empty database measured 0 bytes, and that is a reading.
      mongoDriver.dbStats = () => ({ dataSize: 0, indexSize: 0, storageSize: 0 });
      expect((await provider.getHealth()).databaseSize).toBe("0 B");
    });

    test("getHealth publishes the same database size the overview does", async () => {
      // The admin fleet view prints each row's `getHealth().databaseSize` and adds up
      // `getOverview().databaseSizeBytes` as its total, and the Monitoring Overview's DB Size
      // card reads the overview figure. While `getHealth()` still published `dataSize` alone,
      // one MongoDB read two sizes side by side: a data-only row against a data+index total.
      mongoDriver.dbStats = () => ({ dataSize: 2048, indexSize: 1024, storageSize: 4096 });
      const health = await provider.getHealth();
      const overview = await provider.getOverview();

      expect(health.databaseSize).toBe(overview.databaseSize);
      expect(health.databaseSize).toBe("3 KB");
    });

    test("getHealth omits the database size when either addend is missing", async () => {
      // The same omit-when-either-is-missing rule the overview follows: a sum of one reading
      // and a guess is not a reading, and `indexSize` alone is no more a database size than
      // `dataSize` alone was.
      mongoDriver.dbStats = () => ({ dataSize: 2048, storageSize: 4096 });
      const health = await provider.getHealth();
      const overview = await provider.getOverview();

      expect(health.databaseSize).toBe("N/A");
      expect(overview.databaseSize).toBe("N/A");
    });

    test("maps in-progress operations to active sessions", async () => {
      mongoDriver.currentOps = [
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

    // #1091 review: the refusal compared `config.database`, and a connection-string connection
    // sets no `config.database` - so it refused the database the provider IS bound to and every
    // per-collection button answered `bound to the database ""`. The comparison is against the
    // name `getDatabaseName()` resolves and `connect()` opens.
    test("a connection-string connection accepts the database it is bound to", async () => {
      const provider = new MongoDBProvider({
        ...baseConfig,
        host: undefined,
        database: undefined,
        connectionString: "mongodb://remote:27017/fromstring",
      });
      await provider.connect();

      const result = await provider.runMaintenance("analyze", "users", "fromstring");

      expect(result.success).toBe(true);
      await provider.disconnect();
    });

    test("a container naming another database is refused, and the sentence names the bound one", async () => {
      const provider = new MongoDBProvider({
        ...baseConfig,
        host: undefined,
        database: undefined,
        connectionString: "mongodb://remote:27017/fromstring",
      });
      await provider.connect();

      await expect(provider.runMaintenance("vacuum", "users", "elsewhere")).rejects.toThrow(
        'bound to the database "fromstring"',
      );
      await provider.disconnect();
    });

    test("unsupported maintenance type throws", async () => {
      await expect(provider.runMaintenance("flush" as never)).rejects.toThrow();
    });

    // #1424: `kill` was implemented and undeclared, so the route refused the Terminate it backs.
    test("kill is declared and sends killOp with the row's opid", async () => {
      expect(provider.getCapabilities().maintenanceOperations).toContain("kill");

      const result = await provider.runMaintenance("kill", "64517");

      expect(mongoDriver.killOpCommands).toEqual([{ killOp: 1, op: 64517 }]);
      expect(result.success).toBe(true);
      expect(result.message).toBe("Killed operation: 64517");
    });

    // #1408: the whole-database loops ran `validate` on every `listCollections()` entry,
    // views included, and the server refuses it on a view - so the first view aborted
    // the run with a 500. Compact swallowed every error and answered a bare success.
    describe("over the whole database (#1408)", () => {
      beforeEach(() => {
        mongoDriver.collections = [
          { name: "users", type: "collection" },
          { name: "active_users", type: "view" },
          { name: "readings", type: "timeseries" },
          { name: "orders", type: "collection" },
        ];
      });

      test("validate skips the view, attempts the time series collection, and says so", async () => {
        const result = await provider.runMaintenance("analyze");
        expect(result).toMatchObject({
          success: true,
          message: "Validated 3 collections; skipped 1 view",
        });
      });

      test("a collection whose validate fails is named while the rest still run", async () => {
        mongoDriver.maintenanceRefusals.users = mongoServerError(13, "not authorized on testdb to execute command");
        const result = await provider.runMaintenance("analyze");
        expect(result).toMatchObject({
          success: false,
          message:
            "Validated 2 collections; skipped 1 view; failed on 1: users (not authorized on testdb to execute command)",
        });
      });

      test("compact skips the view and reports a failure instead of a bare success", async () => {
        mongoDriver.maintenanceRefusals.orders = mongoServerError(20, "compact is not allowed here");
        const result = await provider.runMaintenance("vacuum");
        expect(result).toMatchObject({
          success: false,
          message: "Compacted 2 collections; skipped 1 view; failed on 1: orders (compact is not allowed here)",
        });
      });

      test("a single collection and a single view read in the singular", async () => {
        mongoDriver.collections = [
          { name: "users", type: "collection" },
          { name: "active_users", type: "view" },
        ];
        const result = await provider.runMaintenance("vacuum");
        expect(result).toMatchObject({ success: true, message: "Compacted 1 collection; skipped 1 view" });
      });
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

      mongoDriver.serverStatus = () => ({ connections: { current: 5, available: 0 }, uptime: 1 });
      // A pool with nothing left is a limit of 5, not the fabricated 100.
      expect((await provider.getOverview()).maxConnections).toBe(5);
    });

    test("a server publishing no connection headroom publishes no limit", async () => {
      mongoDriver.serverStatus = () => ({ connections: { current: 5 }, uptime: 1 });
      // 0 is how every provider spells "no limit published"; 100 was invented.
      expect((await provider.getOverview()).maxConnections).toBe(0);
    });

    test("a failing serverStatus publishes no connection limit either", async () => {
      mongoDriver.serverStatus = () => {
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
      mongoDriver.serverStatus = () => {
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
      mongoDriver.serverStatus = () => ({ uptime: 86400 });
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(false);
    });

    test("a server with zero open connections keeps its measured zero", async () => {
      // The anti-vacuity twin of the two tests above: `|| 0` destroyed a real zero as
      // well as inventing a fake one, so absence must never be spelled with a falsy
      // test. An idle server measured 0, and 0 is a reading.
      mongoDriver.serverStatus = () => ({ connections: { current: 0, available: 100 }, uptime: 86400 });
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
      mongoDriver.serverStatus = () => {
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
      mongoDriver.dbStats = () => ({ dataSize: 0, indexSize: 0, storageSize: 0 });
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
      mongoDriver.dbStats = () => ({ indexSize: 512, storageSize: 4096 });
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
      // Everything the same read DID answer still arrives - this is not a failed read.
      expect(overview.tableCount).toBe(2);
      expect(overview.activeConnections).toBe(5);
    });

    test("the published size is the same measure as the table rows the Storage tab divides", async () => {
      // The Storage tab's shares are `figure / overview.databaseSizeBytes`, and the figures
      // that go into them are this provider's own: a collection's row is
      // `collStats.size + collStats.totalIndexSize`, and the Indexes card sums
      // `totalIndexSize` (`getTableStats()`). Publishing `dbStats.dataSize` alone - the
      // documents, uncompressed - put index bytes in the numerator and left them out of the
      // denominator, so the Indexes share and every collection carrying an index read over
      // 100% (measured on MongoDB 8.2: 1062.8% for Indexes, 354.7% for `customers`).
      mongoDriver.dbStats = () => ({ dataSize: 2048, indexSize: 1024, storageSize: 4096 });
      const overview = await provider.getOverview();
      const tables = await provider.getTableStats();

      // Both dbStats measures the collection rows are built from, summed once.
      expect(overview.databaseSizeBytes).toBe(3072);
      expect(overview.databaseSize).toBe("3 KB");

      const total = overview.databaseSizeBytes ?? 0;
      const dataBytes = tables.reduce((sum, t) => sum + (t.tableSizeBytes ?? 0), 0);
      const indexBytes = tables.reduce((sum, t) => sum + (t.indexSizeBytes ?? 0), 0);
      // `collStats` answers 1024 + 512 for each of the two collections.
      expect(dataBytes).toBe(2048);
      expect(indexBytes).toBe(1024);
      // And every figure the tab divides now sits inside the total it divides by.
      expect((dataBytes / total) * 100).toBeLessThanOrEqual(100);
      expect((indexBytes / total) * 100).toBeLessThanOrEqual(100);
      for (const table of tables) {
        expect(((table.totalSizeBytes ?? 0) / total) * 100).toBeLessThanOrEqual(100);
      }
    });

    test("a dbStats answer carrying only one of the two measures publishes no byte figure", async () => {
      // The published size is a sum of two readings now, and one reading plus a guess is not
      // a reading: `dataSize` alone is exactly the state the shares were wrong in, and 0 for
      // the index bytes the answer never carried would be the same fabrication one step
      // further in. The absence the optional field carries is unchanged by that.
      mongoDriver.dbStats = () => ({ dataSize: 2048, storageSize: 4096 });
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
      // What the same read did answer still arrives - this is not a failed read.
      expect(overview.tableCount).toBe(2);
    });

    test("a time series collection is counted once, without its internal bucket collection", async () => {
      // `listCollections` answers a time series collection TWICE: the collection itself
      // (`type: "timeseries"`) and the server's own bucket collection
      // `system.buckets.<name>`, and `collStats` answers the same bytes for both. Counting
      // both put the collection's bytes into the rows twice, so Tables + Indexes summed past
      // the database total and the Storage tab's "Other (unattributed)" remainder went
      // negative (#1455). The numbers here are the `mongo:8` measurement the reviewer took:
      // 110334 B of rows against a 105066 B total, the 5268 B time series collection counted
      // twice.
      mongoDriver.collections = [
        { name: "weather", type: "timeseries" },
        { name: "system.buckets.weather", type: "collection" },
        { name: "sensors", type: "collection" },
      ];
      mongoDriver.collStatsByCollection = {
        weather: { size: 5000, totalIndexSize: 268, count: 12 },
        "system.buckets.weather": { size: 5000, totalIndexSize: 268, count: 12 },
        sensors: { size: 99798, totalIndexSize: 0, count: 900 },
      };
      mongoDriver.dbStats = () => ({ dataSize: 104798, indexSize: 268, storageSize: 4096 });

      const overview = await provider.getOverview();
      const tables = await provider.getTableStats();

      const total = overview.databaseSizeBytes ?? 0;
      expect(total).toBe(105066);
      const dataBytes = tables.reduce((sum, t) => sum + (t.tableSizeBytes ?? 0), 0);
      const indexBytes = tables.reduce((sum, t) => sum + (t.indexSizeBytes ?? 0), 0);
      // The rows are the sums `dbStats` reports, each collection counted once...
      expect(dataBytes).toBe(104798);
      expect(indexBytes).toBe(268);
      // ...so the figures the tab divides add up to the total they divide by and the
      // remainder is not negative. Before the fix this pair read 110334 against 105066.
      expect(dataBytes + indexBytes).toBe(total);
      expect(total - dataBytes - indexBytes).toBeGreaterThanOrEqual(0);
      // The internal bucket collection is not a second table.
      expect(tables.map((t) => t.tableName).sort()).toEqual(["sensors", "weather"]);
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
      mongoDriver.serverStatus = () => ({ uptime: 100, opcounters: { query: 100 } });
      const metrics = await provider.getPerformanceMetrics();
      expect("cacheHitRatio" in metrics).toBe(false);
      expect("bufferPoolUsage" in metrics).toBe(false);
      // What IS measurable still arrives: 100 ops over 100 seconds.
      expect(metrics.queriesPerSecond).toBe(1);
    });

    test("omits the ratio when nothing has been requested from the cache", async () => {
      mongoDriver.serverStatus = () => ({
        uptime: 100,
        wiredTiger: { cache: { "pages read into cache": 0, "pages requested from the cache": 0 } },
      });
      expect("cacheHitRatio" in (await provider.getPerformanceMetrics())).toBe(false);
    });

    test("reports a measured zero rather than dropping it", async () => {
      mongoDriver.serverStatus = () => ({
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
      mongoDriver.serverStatus = () => {
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

    // A user holding only `read` is refused system.profile with code 13. That is "not allowed to look", not "nothing
    // there": answered as [], a live Operate run on 2026-10-17 reported no slow queries on a server it could not read.
    test("a profiler the user may not read is refused as a missing privilege, and any other failure is still none", async () => {
      const unauthorized = Object.assign(
        serverErrorReply('not authorized on testdb to execute command { find: "system.profile" }'),
        {
          code: 13,
        },
      );
      mongoDriver.findErrors["testdb.system.profile"] = unauthorized;
      const refused = await provider.getSlowQueries().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PermissionDeniedError);
      expect((refused as Error).message).toContain("unknown here, not absent");
      mongoDriver.findErrors["testdb.system.profile"] = serverErrorReply("something else");
      expect(await provider.getSlowQueries()).toEqual([]);
      delete mongoDriver.findErrors["testdb.system.profile"];
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

    test("a currentOp the user may not run is refused as a missing privilege, and any other failure is still none", async () => {
      mongoDriver.currentOpError = Object.assign(
        serverErrorReply("not authorized on admin to execute command { currentOp: 1 }"),
        {
          code: 13,
        },
      );
      const refused = await provider.getActiveSessions().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PermissionDeniedError);
      expect((refused as Error).message).toContain("active sessions are unknown here, not absent");
      // Code 13 from a transport-shaped error is not the server's refusal, and neither is another server error.
      mongoDriver.currentOpError = Object.assign(new Error("connection reset"), { code: 13 });
      expect(await provider.getActiveSessions()).toEqual([]);
      mongoDriver.currentOpError = serverErrorReply("interrupted");
      expect(await provider.getActiveSessions()).toEqual([]);
      mongoDriver.currentOpError = undefined;
    });

    test("maps in-progress operations with duration formatting for every range", async () => {
      mongoDriver.currentOps = [
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
      expect(sessions[0].activity).toBe("active");
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
      expect(sessions[1].activity).toBe("idle");
      expect(sessions[1].waitEventType).toBeUndefined();
      expect(sessions[1].waitEvent).toBeUndefined();

      // Duration formatting across seconds / minutes / hours ranges
      expect(sessions[1].duration).toBe("5.0s");
      expect(sessions[2].duration).toBe("2m 0s");
      expect(sessions[3].duration).toBe("2h 1m");
    });

    // #1424: `currentOp` with `$all` also answers rows `killOp` cannot end. Measured on MongoDB 9.0.2 with only
    // Studio connected: 39 rows. 1 was Studio's own `currentOp`, 34 were server threads with no opid, 2 were
    // Studio's own idle connections with no opid, and 2 were server jobs (`Checkpointer`, `JournalFlusher`)
    // whose opid `killOp` answered `ok: 1` for while both kept running.
    test("marks a row with no opid, with no client, or that is this read itself, as not terminable", async () => {
      mongoDriver.currentOps = [
        { opid: 64517, client: "10.0.0.1:4444", active: true, command: { insert: "t" }, microsecs_running: 1000 },
        { client: "10.0.0.1:4445", active: false },
        { desc: "TTLMonitor", active: false },
        { opid: 3072, desc: "JournalFlusher", active: true },
        { opid: 154627, client: "10.0.0.1:4446", active: true, command: { currentOp: 1, $all: true } },
      ];
      const sessions = await provider.getActiveSessions();
      expect(sessions.map((s) => [s.pid, s.terminable])).toEqual([
        [64517, undefined],
        ["N/A", false],
        ["N/A", false],
        [3072, false],
        [154627, false],
      ]);
    });

    test("respects the limit option", async () => {
      mongoDriver.currentOps = [
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

    test("skips system.* collections and keeps one whose name only starts with those letters", async () => {
      // Monitoring listed `system.views` and `system.buckets.readings` while the tree hid both
      // (#1428). The bucket here has no time-series parent, so the earlier duplicate-bucket
      // check would have kept it; the reserved prefix is what drops it. `systemetrics` does
      // not start with `system.` and is a collection a person created.
      mongoDriver.collections = [
        { name: "orders", type: "collection" },
        { name: "system.views", type: "collection" },
        { name: "system.buckets.readings", type: "collection" },
        { name: "systemetrics", type: "collection" },
      ];

      const stats = await provider.getTableStats();

      expect(stats.map((row) => row.tableName).sort()).toEqual(["orders", "systemetrics"]);
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

    // Measured on MongoDB 8.2.12 (#1423): the grid showed `big` as `{"high":2097152,"low":1,"unsigned":false}`,
    // `ts` the same way, `re` as `{}` and `uid` as `<Binary: 16 bytes>`. The values are the driver's own classes,
    // as it reads them back: a Long past 2^53 stays a Long and a regular expression is a native RegExp.
    test("Long, Timestamp, RegExp and UUID values are readable, alone, nested and in arrays (#1423)", async () => {
      const { BSON } = realMongoDriver;
      const big = BSON.Long.fromString("9007199254740993");
      const ts = new BSON.Timestamp({ t: 1700000000, i: 1 });
      const uid = new BSON.UUID("3b241101-e2bb-4255-8caf-4136c566a962");
      mongoDriver.collectionData = [
        {
          big,
          ts,
          re: /ab+c/i,
          bre: new BSON.BSONRegExp("x+", "m"),
          uid,
          i32: new BSON.Int32(7),
          code: new BSON.Code("function () { return 1; }"),
          min: new BSON.MinKey(),
          // The suite's driver double for Binary: a plain Binary keeps the placeholder users see.
          other: new MockBinary(Buffer.from("abc")),
          nested: { big, ts, at: new Date("2026-10-04T00:00:00.000Z") },
          list: [big, uid, new MockObjectId("aaa"), [ts], { re: /z/g }],
          // A document's own field named like the class marker is data, not a class.
          own: { _bsontype: "Long", n: 1 },
        },
      ];
      const result = await provider.query(JSON.stringify({ collection: "users", operation: "find", filter: {} }));
      expect(result.rows[0]).toEqual({
        big: "9007199254740993",
        ts: "Timestamp(1700000000, 1)",
        re: "/ab+c/i",
        bre: "/x+/m",
        uid: "3b241101-e2bb-4255-8caf-4136c566a962",
        i32: 7,
        code: '{"$code":"function () { return 1; }"}',
        min: '{"$minKey":1}',
        other: "<Binary: 3 bytes>",
        nested: { big: "9007199254740993", ts: "Timestamp(1700000000, 1)", at: "2026-10-04T00:00:00.000Z" },
        list: [
          "9007199254740993",
          "3b241101-e2bb-4255-8caf-4136c566a962",
          "aaa",
          ["Timestamp(1700000000, 1)"],
          { re: "/z/g" },
        ],
        own: { _bsontype: "Long", n: 1 },
      });
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
  // --------------------------------------------------------------------------
  // The agent read-only execution profile (issue #1614)
  // --------------------------------------------------------------------------
  /*
    The provider's half of the profile, through the stand-in driver: what it sends at open and on each read, and how it
    reads what the server answers. The boundary's pure checks are held to captured server documents in
    `tests/unit/db/mongodb/agent-boundary.test.ts`, and the deadline, the streamed read and the one builder to a fake
    client in `tests/unit/db/mongodb/agent-read.test.ts`; here they are driven through `connect()` and
    `queryReadOnly`, so a seam between the provider and those modules is a red test too.
  */
  describe("the agent read-only execution profile", () => {
    const budget = { statementTimeoutMs: 5000, maxResultRows: 10, maxResultBytes: 512 * 1024 };
    const profiledProvider = (overrides: Partial<DatabaseConnection> = {}) =>
      new MongoDBProvider({ ...baseConfig, ...overrides }, {}, { readOnly: true, sendsStatements: true });
    const envelope = (operation: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ collection: "orders", operation, ...extra });
    /** One captured server reply (`tests/unit/db/mongodb/fixtures/`). */
    const captured = (name: string): Record<string, unknown> =>
      (
        JSON.parse(readFileSync(join(import.meta.dir, "../../unit/db/mongodb/fixtures", `${name}.json`), "utf8")) as {
          reply: Record<string, unknown>;
        }
      ).reply;
    /** The names of the commands the stand-in was sent, in order. */
    const commandNames = () => mongoDriver.commands.map(({ command }) => Object.keys(command)[0]);
    /** The refusal a profiled open ends in, held to its class and code: the verdict, never a wrapped ConnectionError. */
    async function refusedAtOpen(reasonCode: string, pattern: RegExp): Promise<void> {
      const profiled = profiledProvider();
      const caught = await profiled.connect().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(ExecutionProfileError);
      expect(caught).toMatchObject({ reasonCode });
      expect(String((caught as Error).message)).toMatch(pattern);
      expect(profiled.isConnected()).toBe(false);
      // The refused open leaves no client behind (#1573).
      expect(mongoDriver.clientCloses.at(-1)).toBe(1);
    }

    test("a provider nobody opened under the profile refuses the read outright", async () => {
      await provider.connect();
      await expect(provider.queryReadOnly(envelope("count"), budget)).rejects.toThrow(
        /requires a provider opened under the agent read-only profile/,
      );
    });

    describe("at open", () => {
      test("reads buildInfo, the session's privileges and a probe that changes nothing, in that order", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        expect(commandNames()).toEqual(["ping", "buildInfo", "connectionStatus", "delete"]);
        for (const { database, command } of mongoDriver.commands.slice(1)) {
          expect(database).toBe("testdb");
          expect(command.maxTimeMS).toBe(AGENT_VERIFY_MAX_TIME_MS);
          expect(command.comment).toBe("libredb-studio-agent");
        }
        // No write and no cleanup is ever issued: the probe is one delete that matches nothing.
        expect(mongoDriver.args.insertOne).toBeUndefined();
        expect(mongoDriver.args.deleteMany).toBeUndefined();
        expect(mongoDriver.cursors).toEqual([]);
        await profiled.disconnect();
      });

      test("the admin seed is refused on its privileges, and no probe is sent", async () => {
        mongoDriver.connectionStatus = captured("connection-status-root-9.0.4");
        await refusedAtOpen("PROFILE_PRIVILEGES_TOO_BROAD", /this session holds "analyze" on \{"system_buckets":""\}/);
        expect(commandNames()).toEqual(["ping", "buildInfo", "connectionStatus"]);
      });

      test("a server that accepts the probe does not enforce authorization", async () => {
        mongoDriver.probe = "accepted";
        await refusedAtOpen("PROFILE_SERVER_UNENFORCED", /does not enforce authorization/);
        expect(commandNames()).toEqual(["ping", "buildInfo", "connectionStatus", "delete"]);
      });

      test("a connection that authenticated no user is too narrow on an enforcing server", async () => {
        mongoDriver.connectionStatus = captured("connection-status-anonymous-9.0.4");
        mongoDriver.buildInfoError = mongoServerError(13, "Command buildInfo requires authentication");
        await refusedAtOpen("PROFILE_PRIVILEGES_TOO_NARROW", /authenticated no user/);
      });

      test("a FerretDB buildInfo is refused as an unmeasured target, and a Cosmos DB host before its shape is read", async () => {
        mongoDriver.buildInfo = captured("buildinfo-ferretdb-2.7.0");
        await refusedAtOpen("PROFILE_UNSUPPORTED_TARGET", /identifies itself as FerretDB on the wire/);
        expect(commandNames()).toEqual(["ping", "buildInfo"]);
        resetMongoDriver();
        const cosmos = profiledProvider({ host: "acct.mongo.cosmos.azure.com" });
        const caught = await cosmos.connect().catch((error: unknown) => error);
        expect(caught).toMatchObject({ reasonCode: "PROFILE_UNSUPPORTED_TARGET" });
        expect(String(caught)).toContain("Azure Cosmos DB");
      });

      test("a buildInfo that answers no MongoDB shape is refused fail-closed", async () => {
        mongoDriver.buildInfo = { version: "5.0.0", ok: 1 };
        await refusedAtOpen("PROFILE_UNSUPPORTED_TARGET", /does not answer the shape a MongoDB answers/);
      });

      test("a server that cannot answer buildInfo at all fails the connect with its own error", async () => {
        mongoDriver.buildInfoError = new Error("connection destroyed");
        const profiled = profiledProvider();
        await expect(profiled.connect()).rejects.toThrow("connection destroyed");
      });

      test("a probe that fails for any reason but authorization fails the connect, never reading as a verdict", async () => {
        for (const failure of [
          mongoServerError(121, "Document failed validation"),
          mongoServerError(11000, "E11000"),
        ]) {
          resetMongoDriver();
          mongoDriver.probe = failure;
          const caught = await profiledProvider()
            .connect()
            .catch((error: unknown) => error);
          expect(caught).not.toBeInstanceOf(ExecutionProfileError);
          expect(String(caught)).toContain(failure.message);
        }
      });

      test("an acquisition that sends no statement opens unverified, and refuses statements", async () => {
        // The operations profile's curated reads: an admin principal opens as on main, with no check sent.
        mongoDriver.connectionStatus = captured("connection-status-root-9.0.4");
        const operations = new MongoDBProvider({ ...baseConfig }, {}, { readOnly: true, sendsStatements: false });
        await operations.connect();
        expect(commandNames()).toEqual(["ping"]);
        await expect(operations.queryReadOnly(envelope("count"), budget)).rejects.toThrow(
          /requires a provider opened under the agent read-only profile/,
        );
        await operations.disconnect();
        // The same principal, opened to send statements, is refused.
        mongoDriver.commands = [];
        await refusedAtOpen("PROFILE_PRIVILEGES_TOO_BROAD", /this session holds/);
      });

      test("every execution-profile client retries no write and names itself; the editor's does neither", async () => {
        for (const sendsStatements of [true, false]) {
          const profiled = new MongoDBProvider({ ...baseConfig }, {}, { readOnly: true, sendsStatements });
          await profiled.connect();
          expect(mongoDriver.lastOptions).toMatchObject({ retryWrites: false, appName: "libredb-studio-agent" });
          await profiled.disconnect();
        }
        await provider.connect();
        expect(mongoDriver.lastOptions.retryWrites).toBeUndefined();
        expect(mongoDriver.lastOptions.appName).toBeUndefined();
      });
    });

    describe("the read", () => {
      /** The cursor or command each read opened, with what it was opened with. */
      const lastCursor = () => mongoDriver.cursors.at(-1) as (typeof mongoDriver.cursors)[number];

      test("the five read operations answer through the envelope the editor takes", async () => {
        mongoDriver.collectionData = [
          { customer: "Ada", status: "shipped", total: 120 },
          { customer: "Grace", status: "open", total: 80 },
          { customer: "Ada", status: "open", total: 40 },
        ];
        const profiled = profiledProvider();
        await profiled.connect();
        const find = await profiled.queryReadOnly(envelope("find", { filter: { status: "shipped" } }), budget);
        expect(find.rows).toEqual(mongoDriver.collectionData);
        expect(find.fields).toEqual(["customer", "status", "total"]);
        const findOne = await profiled.queryReadOnly(envelope("findOne"), budget);
        expect(findOne.rows).toEqual([mongoDriver.collectionData[0]]);
        // A findOne's projection reaches the find it is, beside its limit of 1.
        await profiled.queryReadOnly(envelope("findOne", { options: { projection: { total: 1 } } }), budget);
        expect(mongoDriver.cursors.at(-1)?.options).toMatchObject({ projection: { total: 1 }, limit: 1 });
        await profiled.queryReadOnly(envelope("findOne", { options: {} }), budget);
        expect(mongoDriver.cursors.at(-1)?.options.projection).toBeUndefined();
        const aggregate = await profiled.queryReadOnly(
          envelope("aggregate", { pipeline: [{ $match: { status: "open" } }] }),
          budget,
        );
        expect(aggregate.rowCount).toBe(3);
        const count = await profiled.queryReadOnly(envelope("count"), budget);
        expect(count.rows).toEqual([{ count: 3 }]);
        const distinct = await profiled.queryReadOnly(envelope("distinct", { field: "customer" }), budget);
        expect(distinct.rows).toEqual([{ customer: "Ada" }, { customer: "Grace" }]);
        await profiled.disconnect();
      });

      test("a write operation, a write stage and an unknown key are each refused before the engine is reached", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        await expect(profiled.queryReadOnly(envelope("insertOne", { documents: [{ a: 1 }] }), budget)).rejects.toThrow(
          /not one of the five reads/,
        );
        await expect(
          profiled.queryReadOnly(envelope("aggregate", { pipeline: [{ $out: "elsewhere" }] }), budget),
        ).rejects.toThrow(/\$out.*writes the pipeline's result/);
        await expect(profiled.queryReadOnly(envelope("find", { flter: {} }), budget)).rejects.toThrow(
          /"flter" is not a key the command envelope takes/,
        );
        await profiled.disconnect();
      });

      test("a malformed limit, a mixed wrapper and an unreadable wrapper are refused before any cursor opens", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        mongoDriver.foundCollections = [];
        await expect(profiled.queryReadOnly(envelope("find", { options: { limit: 0.5 } }), budget)).rejects.toThrow(
          /"limit" must be a whole number of at least 1/,
        );
        await expect(
          profiled.queryReadOnly(
            envelope("find", { filter: { _id: { $oid: "65f0a1b2c3d4e5f6a7b8c9d0", other: 1 } } }),
            budget,
          ),
        ).rejects.toThrow(/\$oid must be the only key of its object, and this one also has other/);
        // The reader admits the wrapper's shape; its value is the reviver's to read, before anything is sent.
        await expect(
          profiled.queryReadOnly(envelope("find", { filter: { _id: { $oid: "zz" } } }), budget),
        ).rejects.toThrow(/Invalid Extended JSON in the query at "filter._id"/);
        expect(mongoDriver.foundCollections).toEqual([]);
        await profiled.disconnect();
      });

      test("every object slot of every read reaches the driver revived, each value the BSON value it names", async () => {
        const OID = { $oid: "65f0a1b2c3d4e5f6a7b8c9d0" };
        const AT = { $date: "2026-01-01T00:00:00Z" };
        const ONE = { $numberInt: "1" };
        /**
         * A value as the driver was handed it, its BSON values named, so a revived ObjectId or Date reads apart from
         * the wrapper's own subdocument: a slot left unrevived would send `{"$oid": ...}` as a field to match.
         */
        const named = (value: unknown): unknown => {
          if (value instanceof realMongoDriver.BSON.ObjectId) return `ObjectId(${value.toHexString()})`;
          if (value instanceof Date) return `Date(${value.toISOString()})`;
          if (Array.isArray(value)) return value.map(named);
          if (typeof value !== "object" || value === null) return value;
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, named(child)]));
        };
        const oid = "ObjectId(65f0a1b2c3d4e5f6a7b8c9d0)";
        const at = "Date(2026-01-01T00:00:00.000Z)";
        // Each read carries a wrapper in every object slot it takes; `$numberInt` stands where the server reads a plain
        // number (a projection's inclusion, a sort's direction), and revives to that number.
        const reads: { command: Record<string, unknown>; sent: () => unknown; expected: unknown }[] = [
          {
            command: {
              operation: "find",
              filter: { _id: OID, at: { $gte: AT } },
              options: {
                projection: { total: ONE, recent: { $gte: ["$at", AT] } },
                sort: { total: { $numberInt: "-1" } },
                skip: 2,
                limit: 5,
              },
            },
            sent: () => {
              const { filter, options } = lastCursor();
              return named({
                filter,
                projection: options.projection,
                sort: options.sort,
                skip: options.skip,
                limit: options.limit,
              });
            },
            expected: {
              filter: { _id: oid, at: { $gte: at } },
              projection: { total: 1, recent: { $gte: ["$at", at] } },
              sort: { total: -1 },
              skip: 2,
              limit: 5,
            },
          },
          {
            command: {
              operation: "findOne",
              filter: { _id: OID },
              options: { projection: { total: ONE, at: { $max: ["$at", AT] } } },
            },
            sent: () => {
              const { filter, options } = lastCursor();
              return named({ filter, projection: options.projection, limit: options.limit });
            },
            expected: { filter: { _id: oid }, projection: { total: 1, at: { $max: ["$at", at] } }, limit: 1 },
          },
          {
            command: {
              operation: "aggregate",
              pipeline: [{ $match: { at: { $gte: AT } } }, { $project: { total: ONE } }],
            },
            sent: () => named(lastCursor().pipeline),
            expected: [{ $match: { at: { $gte: at } } }, { $project: { total: 1 } }, { $limit: 11 }],
          },
          {
            command: { operation: "count", filter: { _id: OID } },
            sent: () => named(lastCursor().pipeline),
            expected: [{ $match: { _id: oid } }, { $group: { _id: 1, n: { $sum: 1 } } }],
          },
          {
            command: { operation: "distinct", field: "customer", filter: { at: { $lt: AT } } },
            sent: () => named(mongoDriver.commands.at(-1)?.command.query),
            expected: { at: { $lt: at } },
          },
        ];
        const profiled = profiledProvider();
        await profiled.connect();
        for (const { command, sent, expected } of reads) {
          const { operation, ...rest } = command;
          await profiled.queryReadOnly(envelope(String(operation), rest), budget);
          expect(sent()).toEqual(expected);
        }
        await profiled.disconnect();
      });

      test("the provider re-admits and refuses the JavaScript operators the fence refuses", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        // The provider never trusts the caller: a statement that reached queryReadOnly any other way
        // meets the same admission the model's tool path meets - including the JavaScript operators.
        await expect(
          profiled.queryReadOnly(envelope("find", { filter: { $where: "this.total > 5" } }), budget),
        ).rejects.toThrow(/runs JavaScript this run wrote on the server/);
        await profiled.disconnect();
      });

      test("every read carries the server deadline and the agent's comment, in a session it ends", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        const reads = [
          envelope("find"),
          envelope("findOne"),
          envelope("aggregate", { pipeline: [] }),
          envelope("count"),
        ];
        for (const [index, text] of reads.entries()) {
          for (const mode of ["execute", "estimate-plan"] as const) {
            await profiled.queryReadOnly(text, budget, mode);
            const cursor = lastCursor();
            expect(cursor.options).toMatchObject({ maxTimeMS: 5000, comment: "libredb-studio-agent" });
            expect((cursor.options.session as { id: unknown }).id).toEqual(mongoDriver.sessions.at(-1)?.id);
            expect(cursor.options.raw).toBe(mode === "execute");
            if (mode === "estimate-plan")
              expect(cursor.explained).toEqual({ verbosity: "queryPlanner", maxTimeMS: 5000 });
          }
          expect(mongoDriver.cursors).toHaveLength((index + 1) * 2);
        }
        for (const mode of ["execute", "estimate-plan"] as const) {
          await profiled.queryReadOnly(envelope("distinct", { field: "customer" }), budget, mode);
          const { command, options } = mongoDriver.commands.at(-1) as (typeof mongoDriver.commands)[number];
          expect(command).toMatchObject({ maxTimeMS: 5000, comment: "libredb-studio-agent" });
          expect(options).toMatchObject({ session: { id: mongoDriver.sessions.at(-1)?.id } });
        }
        expect(mongoDriver.sessions.every((session) => session.ended)).toBe(true);
        await profiled.disconnect();
      });

      test("a read is bounded one row past the budget server-side, and the crossing row is the refusal", async () => {
        mongoDriver.collectionData = Array.from({ length: 40 }, (_, i) => ({ id: i }));
        const profiled = profiledProvider();
        await profiled.connect();
        const error = await profiled.queryReadOnly(envelope("find"), budget).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(QueryError);
        // A cursor read stops one row past the budget, so the count is that bound and the sentence says the total is unknown.
        expect((error as Error).message).toBe(
          'Read-only execution exceeded the row budget: 11 rows > 10 allowed; the read stops one row past the budget, so at least 11 documents match and the total is not known (count it with "operation": "count", or narrow the read)',
        );
        // The sentence is the one the run reads its row-budget advice from.
        expect(rowBudgetIn((error as Error).message)).toEqual({ projected: 11, allowed: 10 });
        expect(lastCursor()).toMatchObject({ pulled: 11, closes: 1 });
        expect(lastCursor().options.limit).toBe(11);
        // The command's own limit is sent when it is the smaller.
        await profiled.queryReadOnly(envelope("find", { options: { limit: 3 } }), budget);
        expect(lastCursor().options.limit).toBe(3);
        const aggregate = await profiled
          .queryReadOnly(envelope("aggregate", { pipeline: [{ $match: {} }] }), budget)
          .catch((caught: unknown) => caught);
        expect((aggregate as Error).message).toContain("11 rows > 10 allowed");
        expect(lastCursor().pipeline?.at(-1)).toEqual({ $limit: 11 });
        // Exactly the budget is admitted.
        mongoDriver.collectionData = mongoDriver.collectionData.slice(0, 10);
        expect((await profiled.queryReadOnly(envelope("find"), budget)).rowCount).toBe(10);
        await profiled.disconnect();
      });

      test("a result past the byte budget is refused on the document whose bytes cross it", async () => {
        mongoDriver.collectionData = Array.from({ length: 8 }, () => ({ blob: "x".repeat(400) }));
        const profiled = profiledProvider();
        await profiled.connect();
        const tinyBudget = { statementTimeoutMs: 5000, maxResultRows: 10, maxResultBytes: 512 };
        await expect(profiled.queryReadOnly(envelope("find"), tinyBudget)).rejects.toThrow(
          /^Read-only execution exceeded the byte budget: \d+ bytes > 512 allowed$/,
        );
        expect(lastCursor()).toMatchObject({ pulled: 2, closes: 1 });
        await profiled.disconnect();
      });

      test("a maxTimeMS expiry is the statement deadline, in the sentence the SQL engines established", async () => {
        mongoDriver.findErrors["testdb.orders"] = mongoServerError(
          50,
          "Executor error during find command :: caused by :: operation exceeded time limit",
        );
        const profiled = profiledProvider();
        await profiled.connect();
        await expect(profiled.queryReadOnly(envelope("find"), budget)).rejects.toThrow(
          /deadline of 5000ms and was killed server-side/,
        );
        await profiled.disconnect();
      });

      test("a findOne that matches nothing answers no rows, and a distinct answers its values as rows", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        mongoDriver.collectionData = [];
        const none = await profiled.queryReadOnly(envelope("findOne", { filter: { customer: "nobody" } }), budget);
        expect(none.rowCount).toBe(0);
        // The distinct's reply IS the values, one row per value under the field's name.
        mongoDriver.collectionData = [{ customer: "Ada" }, { customer: "Grace" }, { customer: "Ada" }];
        const values = await profiled.queryReadOnly(envelope("distinct", { field: "customer" }), budget);
        expect(values.rows).toEqual([{ customer: "Ada" }, { customer: "Grace" }]);
        expect(values.fields).toEqual(["customer"]);
        await profiled.disconnect();
      });

      test("the estimating plan explains the command the read runs, and answers the plan alone", async () => {
        const profiled = profiledProvider();
        await profiled.connect();
        const plan = await profiled.queryReadOnly(
          envelope("find", { filter: { customer: "Ada" } }),
          budget,
          "estimate-plan",
        );
        expect(plan.rows).toEqual([
          {
            explainVersion: "1",
            queryPlanner: { namespace: "testdb.orders", winningPlan: { stage: "COLLSCAN" }, rejectedPlans: [] },
          },
        ]);
        expect(lastCursor()).toMatchObject({ kind: "find", filter: { customer: "Ada" }, pulled: 0 });
        // A count plans the $group it runs, never the count command.
        await profiled.queryReadOnly(envelope("count", { filter: { customer: "Ada" } }), budget, "estimate-plan");
        expect(lastCursor().pipeline).toEqual([
          { $match: { customer: "Ada" } },
          { $group: { _id: 1, n: { $sum: 1 } } },
        ]);
        await profiled.queryReadOnly(envelope("distinct", { field: "customer" }), budget, "estimate-plan");
        expect(mongoDriver.commands.at(-1)?.command).toEqual({
          explain: { distinct: "orders", key: "customer", query: {} },
          verbosity: "queryPlanner",
          maxTimeMS: 5000,
          comment: "libredb-studio-agent",
        });
        await profiled.disconnect();
      });

      test("a run reads the database its connection is bound to, and refuses a command naming another", async () => {
        // A connection-string connection: the bound database is the URI's path (#1091), not a database field.
        const bound = new MongoDBProvider(
          {
            ...baseConfig,
            database: undefined,
            connectionString: "mongodb://reader:secret@db.internal:27017/fromstring",
          },
          {},
          { readOnly: true, sendsStatements: true },
        );
        await bound.connect();
        mongoDriver.openedDatabases = [];
        mongoDriver.cursors = [];
        await expect(bound.queryReadOnly(envelope("find", { database: "elsewhere" }), budget)).rejects.toThrow(
          'This run reads the database "fromstring" its connection is bound to, and "database": "elsewhere" names another, so nothing was sent. Drop the key or name "fromstring".',
        );
        expect([mongoDriver.openedDatabases, mongoDriver.cursors]).toEqual([[], []]);
        await bound.queryReadOnly(envelope("find", { database: "fromstring" }), budget);
        await bound.queryReadOnly(envelope("find"), budget);
        expect(mongoDriver.cursors.map(({ namespace }) => namespace)).toEqual([
          "fromstring.orders",
          "fromstring.orders",
        ]);
        await bound.disconnect();
      });

      test("a read before the connection is open, or under an invalid budget, is refused with nothing sent", async () => {
        const profiled = profiledProvider();
        await expect(profiled.queryReadOnly(envelope("find"), budget)).rejects.toThrow(
          "Provider is not connected. Call connect() first.",
        );
        await expect(profiled.readCatalogReadOnly!({}, budget)).rejects.toThrow(
          "Provider is not connected. Call connect() first.",
        );
        await profiled.connect();
        mongoDriver.sessions = [];
        for (const invalid of [
          { ...budget, maxResultRows: 0 },
          { ...budget, statementTimeoutMs: 1.5 },
        ]) {
          await expect(profiled.queryReadOnly(envelope("find"), invalid)).rejects.toThrow(
            /Read-only execution budget field/,
          );
        }
        expect(mongoDriver.sessions).toEqual([]);
        await profiled.disconnect();
      });
    });

    describe("the catalog read", () => {
      /** A connected provider opened to send statements, with the connect's own commands dropped. */
      const connected = async (overrides: Partial<DatabaseConnection> = {}) => {
        const profiled = profiledProvider(overrides);
        await profiled.connect();
        mongoDriver.commands = [];
        return profiled;
      };

      test("lists the bound database's collections and views, never the server's own namespaces", async () => {
        mongoDriver.collectionsByDb = {
          testdb: [
            { name: "users", type: "collection" },
            { name: "active_users", type: "view" },
            { name: "system.views", type: "collection" },
            { name: "Orders", type: "collection" },
          ],
        };
        const profiled = await connected();
        const listed = await profiled.readCatalogReadOnly!({}, budget);
        expect(listed).toEqual({
          kind: "listed",
          container: "testdb",
          objects: [
            { name: "Orders", kind: "collection" },
            { name: "active_users", kind: "view" },
            { name: "users", kind: "collection" },
          ],
        });
        const [call] = mongoDriver.listCollectionsCalls;
        expect(call).toMatchObject({ database: "testdb", filter: {} });
        expect(call.options).toMatchObject({ nameOnly: true, maxTimeMS: 5000, comment: "libredb-studio-agent" });
        expect((call.options.session as { id: unknown }).id).toEqual(mongoDriver.sessions.at(-1)?.id);
        // An empty container is the bound one too.
        expect(await profiled.readCatalogReadOnly!({ container: "" }, budget)).toEqual(listed);
        await profiled.disconnect();
      });

      test("a container other than the bound database is refused, and nothing is read", async () => {
        const profiled = await connected();
        await expect(profiled.readCatalogReadOnly!({ container: "admin" }, budget)).rejects.toThrow(
          'This run reads the database "testdb" its connection is bound to, and the database "admin" names another, so nothing was sent. Drop the key or name "testdb".',
        );
        expect(mongoDriver.listCollectionsCalls).toEqual([]);
        await profiled.disconnect();
      });

      test("describes one collection: its kind from one listCollections, columns from a sample, indexes, each bounded", async () => {
        mongoDriver.documentsByNs["testdb.users"] = [
          { _id: 1, name: "Ada", address: { city: "Istanbul" } },
          { _id: 2, name: "Grace" },
        ];
        const profiled = await connected();
        const described = await profiled.readCatalogReadOnly!({ object: "users" }, budget);
        expect(described).toEqual({
          kind: "described",
          container: "testdb",
          object: "users",
          objectKind: "collection",
          columns: [
            { name: "_id", type: "number" },
            { name: "address", type: "object" },
            { name: "address.city", type: "string" },
            { name: "name", type: "string" },
          ],
          indexes: [
            { name: "_id_", columns: ["_id"] },
            { name: "email_1", columns: ["email"] },
          ],
          sampled: 2,
        });
        expect(mongoDriver.listCollectionsCalls.map(({ filter }) => filter)).toEqual([{ name: "users" }]);
        const sample = mongoDriver.cursors.at(-1) as (typeof mongoDriver.cursors)[number];
        expect(sample).toMatchObject({ kind: "find", namespace: "testdb.users", filter: {}, closes: 1 });
        expect(sample.options).toMatchObject({
          limit: 100,
          raw: true,
          maxTimeMS: 5000,
          comment: "libredb-studio-agent",
        });
        expect(mongoDriver.listIndexesCalls[0].options).toMatchObject({
          maxTimeMS: 5000,
          comment: "libredb-studio-agent",
        });
        await profiled.disconnect();
      });

      test("a view is described with no indexes, which the server would refuse", async () => {
        mongoDriver.collectionsByDb = { testdb: [{ name: "active_users", type: "view" }] };
        mongoDriver.documentsByNs["testdb.active_users"] = [{ name: "Ada" }];
        const profiled = await connected();
        const described = await profiled.readCatalogReadOnly!({ object: "active_users" }, budget);
        expect(described).toMatchObject({ kind: "described", objectKind: "view", indexes: [], sampled: 1 });
        expect(mongoDriver.listIndexesCalls).toEqual([]);
        await profiled.disconnect();
      });

      test("an object the database does not hold is not found, and a name is taken whole, never split on a dot", async () => {
        mongoDriver.collectionsByDb = {
          testdb: [
            { name: "fs.files", type: "collection" },
            { name: "system.profile", type: "collection" },
          ],
        };
        const profiled = await connected();
        expect(await profiled.readCatalogReadOnly!({ object: "orderz" }, budget)).toEqual({
          kind: "not-found",
          container: "testdb",
          object: "orderz",
        });
        expect(await profiled.readCatalogReadOnly!({ object: "system.profile" }, budget)).toMatchObject({
          kind: "not-found",
        });
        expect(await profiled.readCatalogReadOnly!({ object: "fs.files" }, budget)).toMatchObject({
          kind: "described",
          object: "fs.files",
        });
        expect(mongoDriver.cursors.at(-1)?.namespace).toBe("testdb.fs.files");
        await profiled.disconnect();
      });

      test("an object whose sample holds nothing is described with no columns and a sample of 0", async () => {
        mongoDriver.documentsByNs["testdb.users"] = [];
        const profiled = await connected();
        expect(await profiled.readCatalogReadOnly!({ object: "users" }, budget)).toMatchObject({
          kind: "described",
          columns: [],
          sampled: 0,
        });
        await profiled.disconnect();
      });

      test("the sample stops before the document whose bytes would cross the budget, and the listing is held to the row budget", async () => {
        mongoDriver.documentsByNs["testdb.users"] = Array.from({ length: 5 }, (_, i) => ({ i, pad: "x".repeat(300) }));
        const profiled = await connected();
        const tight = { ...budget, maxResultBytes: 700 };
        expect(await profiled.readCatalogReadOnly!({ object: "users" }, tight)).toMatchObject({ sampled: 2 });
        expect(mongoDriver.cursors.at(-1)).toMatchObject({ pulled: 3, closes: 1 });
        // A first document that alone crosses it is refused: there is nothing honest to infer from.
        await expect(
          profiled.readCatalogReadOnly!({ object: "users" }, { ...budget, maxResultBytes: 100 }),
        ).rejects.toThrow(/exceeded the byte budget/);
        mongoDriver.collectionsByDb = {
          testdb: Array.from({ length: 11 }, (_, i) => ({ name: `c${i}`, type: "collection" })),
        };
        await expect(profiled.readCatalogReadOnly!({}, budget)).rejects.toThrow("11 rows > 10 allowed");
        await profiled.disconnect();
      });

      test("only a provider opened to send statements answers it", async () => {
        await provider.connect();
        await expect(provider.readCatalogReadOnly!({}, budget)).rejects.toThrow(
          /requires a provider opened under the agent read-only profile/,
        );
        const operations = new MongoDBProvider({ ...baseConfig }, {}, { readOnly: true, sendsStatements: false });
        await operations.connect();
        await expect(operations.readCatalogReadOnly!({}, budget)).rejects.toThrow(
          /requires a provider opened under the agent read-only profile/,
        );
        await operations.disconnect();
      });

      test("a catalog the server refuses is the server's own error", async () => {
        mongoDriver.listCollectionsErrors.testdb = mongoServerError(
          13,
          "not authorized on testdb to execute command { listCollections: 1 }",
        );
        const profiled = await connected();
        await expect(profiled.readCatalogReadOnly!({}, budget)).rejects.toThrow("not authorized on testdb");
        await profiled.disconnect();
      });
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
    mongoDriver.openedDatabases = [];
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

  test("declares source on exactly the kinds that have a definition text", () => {
    const kinds = objectProvider.getCapabilities().objectKinds ?? [];
    const declared = kinds
      .filter((kind) => kind.hasSource === true)
      .map((kind) => [kind.id, kind.sourceLanguage] as const)
      .sort();
    // A view IS its definition: `options.viewOn` and `options.pipeline` come back on the
    // same `listCollections` row that classified it, and this product renders them as
    // JSON, which is a rich Monaco language the editor really registers.
    expect(declared).toEqual([["view", "json"]]);
    // The other direction, so a kind added later cannot quietly gain a Source tab. A
    // COLLECTION declares nothing: measured on 8.2.12, an ordinary collection's `options`
    // is `{}`, so a Source tab would open on nothing for the common case, and what options
    // a collection does carry are a property sheet rather than a definition anybody wrote.
    expect(
      kinds
        .filter((kind) => kind.hasSource !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual(["collection"]);
  });

  test("declares columns on every kind it has, and both answer a usable column shape", async () => {
    const kinds = objectProvider.getCapabilities().objectKinds ?? [];
    // BOTH, and there is no third: `describeObject` samples documents the same way for a
    // collection and for a view (its docblock in `mongodb/index.ts`), so no kind here abstains and the
    // expectation above has to say `noAbstainingKinds`.
    expect(kinds.filter((kind) => kind.hasColumns === true).map((kind) => kind.id)).toEqual(["collection", "view"]);
    expect(kinds.filter((kind) => kind.hasColumns !== true).map((kind) => kind.id)).toEqual([]);
    // `false` is not the spelling: a kind either declares the fact or abstains from it, and
    // this engine has no abstainer to spell.
    expect(kinds.some((kind) => kind.hasColumns === false)).toBe(false);

    // The declaration is what draws the twisty, so what it promises is asserted against the
    // provider's own answer rather than against the declaration alone: a name and a type
    // that are both non-empty strings, which is what the column row dereferences.
    for (const [path, kind] of [
      [["app", "customers"], "collection"],
      [["app", "active_customers"], "view"],
    ] as const) {
      const detail = await objectProvider.describeObject(path, kind);
      expect(detail.columns.length).toBeGreaterThan(0);
      for (const column of detail.columns) {
        expect(typeof column.name).toBe("string");
        expect(column.name).not.toBe("");
        expect(typeof column.type).toBe("string");
        expect(column.type).not.toBe("");
      }
    }
  });

  // --------------------------------------------------------------------------
  // Conformance
  // --------------------------------------------------------------------------

  test("satisfies the object-surface contract on the committed fixture", async () => {
    await assertObjectSurface(objectProvider, {
      containers: [["app"], ["configstore"], ["oddnames"]],
      kinds: { collection: 4, view: 1 },
      sampleObject: { path: ["app", "customers"], kind: "collection" },
      // AUTHORED, and it has to be: there is no listing that produces a name the catalog
      // does not hold. A view simply not being in the `listCollections` answer is absence
      // here, and absence RAISES rather than answering a refusal part (#789).
      absentSource: { path: ["app", "no_such_view"], kind: "view" },
      // Every kind this engine has declares `hasColumns`, so invariant 8's negative
      // direction iterates zero times and certifies nothing unless it is said out loud.
      // There is no schema to read here: a collection and a view both get their fields SAMPLED from
      // documents by the same code path (`describeObject` in `mongodb/index.ts`), so there is no kind
      // left that could abstain.
      noAbstainingKinds: true,
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
    mongoDriver.databaseList = [{ name: "oddnames" }, { name: "app" }, { name: "local" }, { name: "configstore" }];
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
    expect(mongoDriver.lastListDatabasesCommand).toEqual({
      listDatabases: 1,
      nameOnly: true,
      authorizedDatabases: true,
    });
  });

  test("sends listDatabases once on a server that accepts authorizedDatabases", async () => {
    await objectProvider.listContainers();
    expect(mongoDriver.listDatabasesCommands).toEqual([
      { listDatabases: 1, nameOnly: true, authorizedDatabases: true },
    ]);
  });

  test("retries without authorizedDatabases when the server refuses that field (FerretDB)", async () => {
    // FerretDB 2.7.0 refuses the flag with BadValue and accepts the command without it.
    mongoDriver.listDatabasesRefusal = (cmd) =>
      cmd.authorizedDatabases === undefined ? undefined : mongoServerError(2, FERRETDB_UNKNOWN_FIELD);
    const containers = await objectProvider.listContainers();
    expect(mongoDriver.listDatabasesCommands).toEqual([
      { listDatabases: 1, nameOnly: true, authorizedDatabases: true },
      { listDatabases: 1, nameOnly: true },
    ]);
    expect(containers.map((c) => c.name)).toContain("app");
  });

  test("raises the second refusal when the retry without authorizedDatabases is refused too", async () => {
    mongoDriver.listDatabasesRefusal = (cmd) =>
      cmd.authorizedDatabases === undefined
        ? mongoServerError(13, "not authorized on admin to execute command")
        : mongoServerError(2, FERRETDB_UNKNOWN_FIELD);
    await expect(objectProvider.listContainers()).rejects.toThrow("not authorized on admin");
    expect(mongoDriver.listDatabasesCommands).toEqual([
      { listDatabases: 1, nameOnly: true, authorizedDatabases: true },
      { listDatabases: 1, nameOnly: true },
    ]);
  });

  test("does not retry a BadValue that is about something other than authorizedDatabases", async () => {
    mongoDriver.listDatabasesRefusal = () => mongoServerError(2, "nameOnly is an unknown field");
    await expect(objectProvider.listContainers()).rejects.toThrow("nameOnly is an unknown field");
    expect(mongoDriver.listDatabasesCommands).toHaveLength(1);
  });

  test("does not retry when the refusal is not BadValue", async () => {
    // An unauthorized role is a real answer about this connection. Dropping the flag would
    // ask a different question rather than the same one again.
    mongoDriver.listDatabasesRefusal = () => mongoServerError(13, `not authorized: ${FERRETDB_UNKNOWN_FIELD}`);
    await expect(objectProvider.listContainers()).rejects.toThrow("not authorized");
    expect(mongoDriver.listDatabasesCommands).toHaveLength(1);
  });

  test("does not retry when the failure is not the server's own reply", async () => {
    // A transport failure is nobody answering at all, whatever its sentence says.
    mongoDriver.listDatabasesRefusal = () => {
      const error = new Error(FERRETDB_UNKNOWN_FIELD) as Error & { code: number };
      error.code = 2;
      error.name = "MongoNetworkError";
      return error;
    };
    await expect(objectProvider.listContainers()).rejects.toThrow(FERRETDB_UNKNOWN_FIELD);
    expect(mongoDriver.listDatabasesCommands).toHaveLength(1);
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
    expect(counts).toEqual({ collection: { count: 1 }, view: { count: 1 } });
    expect(mongoDriver.openedDatabases).toEqual(["configstore"]);

    mongoDriver.openedDatabases = [];
    const listed = await objectProvider.listObjects(["configstore"], "collection");
    expect(listed.map((o) => o.path)).toEqual([["configstore", "settings"]]);
    expect(mongoDriver.openedDatabases).toEqual(["configstore"]);
  });

  test("carries the server's own sentence when a database's catalog is refused", async () => {
    // Measured: a role with `read` on one database only answers `listCollections` on any
    // other with "not authorized on adminx to execute command { listCollections: 1 ... }".
    // That is a refusal and not an empty database, and reporting it as 0 would say the
    // database is empty when nobody has looked.
    mongoDriver.listCollectionsErrors.configstore = new Error("not authorized on configstore to execute command");

    const counts = await objectProvider.countObjects(["configstore"]);
    expect(counts).toEqual({
      collection: { unavailable: "not authorized on configstore to execute command" },
      view: { unavailable: "not authorized on configstore to execute command" },
    });
  });

  test("counts a declared kind the catalog holds none of as zero rather than omitting it", async () => {
    mongoDriver.collectionsByDb.app = [{ name: "customers", type: "collection" }];
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

  // A Long's `high`, `low` and `unsigned` and a Timestamp's were inferred as fields and reached Generate Find, the
  // profiler and the agent's inventory (#1423). Every BSON class is a scalar to inference.
  test("infers a BSON scalar as one field, never its internals (#1423)", async () => {
    const { BSON } = realMongoDriver;
    mongoDriver.documentsByNs["app.customers"] = [
      {
        _id: new MockObjectId("c1"),
        big: BSON.Long.fromString("9007199254740993"),
        ts: new BSON.Timestamp({ t: 1700000000, i: 1 }),
        re: /ab+c/i,
        uid: new BSON.UUID("3b241101-e2bb-4255-8caf-4136c566a962"),
        min: new BSON.MinKey(),
        // Subtype 4 but not 16 bytes: not a UUID, so an ordinary binary field.
        short: new BSON.Binary(Buffer.from("abc"), BSON.Binary.SUBTYPE_UUID),
        weird: Object.create({ _bsontype: "Unlisted" }),
        address: { city: "Ankara" },
      },
    ];
    const detail = await objectProvider.describeObject(["app", "customers"], "collection");
    expect(detail.columns.map((c) => [c.name, c.type])).toEqual([
      ["_id", "objectId"],
      ["address", "object"],
      ["address.city", "string"],
      ["big", "long"],
      ["min", "minKey"],
      ["re", "regex"],
      ["short", "binary"],
      ["ts", "timestamp"],
      ["uid", "uuid"],
      ["weird", "Unlisted"],
    ]);
  });

  // #1456: nullable was set only when a sampled value was `null`, so a field most documents
  // lack read "Nullable: No" in Docs and `NN` in the ERD. Absent counts as empty too.
  test("infers nullable from absent fields as well as nulls (#1456)", async () => {
    mongoDriver.documentsByNs["app.customers"] = [
      {
        _id: new MockObjectId("c1"),
        name: "Ada",
        city: "Istanbul",
        nick: null,
        address: { city: "Izmir", zip: "35000" },
      },
      { _id: new MockObjectId("c2"), name: "Grace", city: "Ankara", address: { city: "Ankara" } },
      { _id: new MockObjectId("c3"), name: "Lin" },
    ];
    const detail = await objectProvider.describeObject(["app", "customers"], "collection");
    expect(detail.columns.map((c) => [c.name, c.nullable])).toEqual([
      ["_id", false],
      // Absent from one document.
      ["address", true],
      ["address.city", true],
      ["address.zip", true],
      ["city", true],
      // Present in every document, never null.
      ["name", false],
      // Present only once, and as null there.
      ["nick", true],
    ]);
  });

  test("a field present in every sampled document is nullable only when one of them holds null (#1456)", async () => {
    mongoDriver.documentsByNs["app.customers"] = [
      { _id: new MockObjectId("c1"), name: "Ada", city: null },
      { _id: new MockObjectId("c2"), name: "Grace", city: "Ankara" },
    ];
    const detail = await objectProvider.describeObject(["app", "customers"], "collection");
    expect(detail.columns.map((c) => [c.name, c.nullable])).toEqual([
      ["_id", false],
      ["city", true],
      ["name", false],
    ]);
  });

  // #1456 review: `_id` follows the same rule as every other field. Measured on mongo:7, a
  // collection holding `{_id: null}` and `{_id: 2}` (or a `$group` view with `_id: null`) has a
  // null `_id`, and a fixed "never nullable" for `_id` contradicted the sample.
  test("an _id that is null in a sampled document is nullable (#1456)", async () => {
    mongoDriver.documentsByNs["app.customers"] = [
      { _id: null, name: "Ada" },
      { _id: 2, name: "Grace" },
    ];
    const detail = await objectProvider.describeObject(["app", "customers"], "collection");
    expect(detail.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["_id", "mixed(null|number)", true],
      ["name", "string", false],
    ]);
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
    expect(mongoDriver.openedDatabases).toEqual(["app"]);

    mongoDriver.openedDatabases = [];
    const listed = await objectProvider.listObjects(["cluster0", "app"], "view");
    expect(listed.map((o) => o.path)).toEqual([["cluster0", "app", "active_customers"]]);
    expect(mongoDriver.openedDatabases).toEqual(["app"]);

    mongoDriver.openedDatabases = [];
    const detail = await objectProvider.describeObject(["cluster0", "app", "customers"], "collection");
    expect(detail.path).toEqual(["cluster0", "app", "customers"]);
    expect(detail.columns.map((c) => c.name)).toEqual(["_id", "city", "name"]);
    expect(mongoDriver.openedDatabases).toEqual(["app", "app"]);

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

  // --------------------------------------------------------------------------
  // describeObjects, the bulk column read (#789)
  // --------------------------------------------------------------------------

  test("samples every collection in a folder in ONE aggregate, not one find each", async () => {
    const batch = await objectProvider.describeObjects!(["app"], "collection");

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["app", "customers"],
      ["app", "orders"],
      ["app", "readings"],
      ["app", "systemetrics"],
    ]);
    // ONE aggregate for the four collections, and no `find` at all: the sample chain is
    // what replaces the per-object read. `system.views` and `system.buckets.readings` are
    // absent because the classifier drops them, so the union names four arms and not six.
    expect(mongoDriver.samplePipelines.length).toBe(1);
    expect(pipelineNamespaces(mongoDriver.samplePipelines[0])).toEqual([
      "customers",
      "orders",
      "readings",
      "systemetrics",
    ]);
    expect(mongoDriver.foundCollections).toEqual([]);
  });

  test("the sample chain is chunked, so a wide folder cannot outgrow the pipeline limit", async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      name: `c${String(index).padStart(3, "0")}`,
      type: "collection",
    }));
    mongoDriver.collectionsByDb = { wide: many };
    mongoDriver.documentsByNs = Object.fromEntries(many.map((info) => [`wide.${info.name}`, [{ _id: 1, v: "x" }]]));

    const batch = await objectProvider.describeObjects!(["wide"], "collection");

    expect(batch.details.length).toBe(250);
    // Three aggregates of at most 100 arms each, and not 250 reads: the count grows with
    // the folder divided by the chunk, which is what keeps a 5,000-collection database off
    // both the N+1 and MongoDB's own 1,000-stage pipeline ceiling.
    expect(mongoDriver.samplePipelines.length).toBe(3);
    expect(mongoDriver.samplePipelines.map((pipeline) => pipelineNamespaces(pipeline).length)).toEqual([100, 100, 50]);
    // Every collection is described exactly once, in path order, across the chunks.
    expect(batch.details[0].path).toEqual(["wide", "c000"]);
    expect(batch.details[249].path).toEqual(["wide", "c249"]);
  });

  test("each arm carries its OWN documents, so no collection is described with another's fields", async () => {
    mongoDriver.documentsByNs = {
      "app.customers": [{ _id: 1, name: "Ada" }],
      "app.orders": [{ _id: 2, total: 10 }],
      "app.readings": [{ _id: 3, sensor: "s1" }],
      "app.systemetrics": [{ _id: 4, gauge: 1 }],
    };
    const batch = await objectProvider.describeObjects!(["app"], "collection");

    expect(batch.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([
      ["_id", "name"],
      ["_id", "total"],
      ["_id", "sensor"],
      ["_id", "gauge"],
    ]);
  });

  test("a collection carries its own indexes and a view carries none, with no view read attempted", async () => {
    const collections = await objectProvider.describeObjects!(["app"], "collection");
    expect(collections.details[0].indexes).toEqual([
      { name: "_id_", columns: ["_id"], unique: true },
      { name: "email_1", columns: ["email"], unique: false },
    ]);
    expect(collections.details.every((detail) => detail.foreignKeys.length === 0)).toBe(true);

    mongoDriver.indexReads = [];
    const views = await objectProvider.describeObjects!(["app"], "view");
    expect(views.details.map((detail) => detail.path)).toEqual([["app", "active_customers"]]);
    expect(views.details[0].indexes).toEqual([]);
    // `listIndexes` on a view is refused with code 166, so a bulk read that asked would
    // fail the whole folder on the one object that cannot answer. Nothing asks.
    expect(mongoDriver.indexReads).toEqual([]);
  });

  test("the bulk read spells an object exactly as the single read does", async () => {
    for (const kind of ["collection", "view"] as const) {
      const batch = await objectProvider.describeObjects!(["app"], kind);
      const listed = await objectProvider.listObjects(["app"], kind);
      expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
      for (const detail of batch.details) {
        expect(detail).toEqual(await objectProvider.describeObject(detail.path, kind));
      }
    }
  });

  test("the caller's bound cuts the sorted objects and reports the caller's own limit", async () => {
    const batch = await objectProvider.describeObjects!(["app"], "collection", 2);

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["app", "customers"],
      ["app", "orders"],
    ]);
    expect(batch.truncated).toEqual({
      limit: 2,
      reason: "the bulk column read was bounded at 2 objects by its caller",
    });
    // The bound reaches the EXPENSIVE half: only the two objects that will be returned are
    // sampled and only their indexes are read. A cut applied after the detail reads would
    // answer the same rows for four times the work.
    expect(pipelineNamespaces(mongoDriver.samplePipelines[0])).toEqual(["customers", "orders"]);
    expect(mongoDriver.indexReads).toEqual(["app.customers", "app.orders"]);
  });

  test("a bound the folder fits inside reports nothing, on either side of the boundary", async () => {
    expect((await objectProvider.describeObjects!(["app"], "collection", 4)).truncated).toBeUndefined();
    expect((await objectProvider.describeObjects!(["app"], "collection", 5)).truncated).toBeUndefined();
  });

  test("an empty folder answers an empty batch and sends no detail read at all", async () => {
    mongoDriver.collectionsByDb = { app: [{ name: "only_a_view", type: "view", options: { viewOn: "x" } }] };
    const batch = await objectProvider.describeObjects!(["app"], "collection");

    expect(batch).toEqual({ details: [] });
    expect(mongoDriver.samplePipelines).toEqual([]);
    expect(mongoDriver.indexReads).toEqual([]);
  });

  test("the bulk read opens the database the CONTAINER names, not the one the session is in", async () => {
    mongoDriver.openedDatabases = [];
    await objectProvider.describeObjects!(["configstore"], "collection");
    expect(new Set(mongoDriver.openedDatabases)).toEqual(new Set(["configstore"]));
  });

  test("orders the cut by path segments, not by a JSON rendering of the path", async () => {
    // `x"a` and `x\a` are escaped by `JSON.stringify` and `x-a` is not, so the two orders
    // disagree: by code point the names are `x"a`, `x-a`, `x\a`, and the server answered
    // them in the JSON order. A bounded read is where that becomes a MEMBERSHIP difference
    // rather than only a display one.
    mongoDriver.documentsByNs = {
      'oddnames.x"a': [{ _id: 1, quote: true }],
      "oddnames.x-a": [{ _id: 2, hyphen: true }],
      "oddnames.x\\a": [{ _id: 3, backslash: true }],
    };
    const batch = await objectProvider.describeObjects!(["oddnames"], "collection", 2);

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["oddnames", 'x"a'],
      ["oddnames", "x-a"],
    ]);
    expect(batch.details[0].columns.map((column) => column.name)).toEqual(["_id", "quote"]);
  });

  test("an undeclared kind is refused by the DECLARATION, naming the engine and the kind", async () => {
    await expect(objectProvider.describeObjects!(["app"], "index")).rejects.toThrow(
      /MongoDB declares no object kind "index"/,
    );
  });

  test("a container path of the wrong shape is refused before anything is read", async () => {
    await expect(objectProvider.describeObjects!([], "collection")).rejects.toThrow(/container path is \[database\]/);
    await expect(objectProvider.describeObjects!(["app", "x"], "collection")).rejects.toThrow(
      /container path is \[database\]/,
    );
  });

  test("a limit that is not a positive whole number is refused, never clamped", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(objectProvider.describeObjects!(["app"], "collection", limit)).rejects.toThrow(
        /bulk column read limit must be a positive whole number/,
      );
    }
    // Guard ORDER: the declaration first, then the container, then the limit.
    await expect(objectProvider.describeObjects!(["app"], "index", 0)).rejects.toThrow(/declares no object kind/);
    await expect(objectProvider.describeObjects!([], "collection", 0)).rejects.toThrow(
      /container path is \[database\]/,
    );
  });

  test("a refused catalog read raises rather than answering an empty folder", async () => {
    mongoDriver.listCollectionsErrors = {
      app: new Error("not authorized on app to execute command { listCollections: 1 }"),
    };
    await expect(objectProvider.describeObjects!(["app"], "collection")).rejects.toThrow(/not authorized on app/);
  });

  /**
   * Standing ruling 5g on the fifth method: a two-level declaration driven all the way to
   * the BOUND VALUE - the database name the driver was opened with - and not to a refusal.
   */
  test("the bulk read follows a two-level declaration to the database it opens", async () => {
    const capabilities = objectProvider.getCapabilities();
    spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [
        { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });

    mongoDriver.openedDatabases = [];
    const batch = await objectProvider.describeObjects!(["cluster0", "app"], "collection", 1);

    expect(batch.details.map((detail) => detail.path)).toEqual([["cluster0", "app", "customers"]]);
    expect(batch.details[0].columns.map((column) => column.name)).toEqual(["_id", "city", "name"]);
    expect(new Set(mongoDriver.openedDatabases)).toEqual(new Set(["app"]));
  });

  // --------------------------------------------------------------------------
  // readObjectSource, the definition read (#789 Phase 2)
  // --------------------------------------------------------------------------

  /**
   * The population comes from the DECLARATION and never from a number typed here.
   *
   * Recipe rule 6, and it is the assertion that decides whether the rest of this section is
   * worth anything. A wrong FIELD or KEY in a driver reply reads as `undefined`, this provider
   * correctly turns that into a REFUSAL, and a refusal passes the conformance walk, passes
   * every count and every length assertion. So the read TEXT is pinned per declared
   * source-bearing kind, and the kinds are taken from `objectKinds` so a kind that quietly
   * became a refusal is named rather than counted.
   *
   * Zero-iteration case, which is the whole risk: a declaration carrying no source-bearing
   * kind, or a fixture holding no object of one, would make every assertion below vacuous, so
   * both throw BY NAME before anything is asserted.
   */
  test("every kind that declares source answers its own definition text and not a refusal", async () => {
    const declared = (objectProvider.getCapabilities().objectKinds ?? []).filter((kind) => kind.hasSource === true);
    if (declared.length === 0) {
      throw new Error("no kind declares hasSource, so this test would certify nothing");
    }

    const read: Record<string, string> = {};
    for (const kind of declared) {
      const listed = await objectProvider.listObjects(["app"], kind.id);
      if (listed.length === 0) {
        throw new Error(`the fixture holds no ${kind.id} in app, so its source read is driven by nothing`);
      }
      const document = await objectProvider.readObjectSource!(listed[0].path, kind.id);
      expect(document.path).toEqual(listed[0].path);
      expect(document.kind).toBe(kind.id);
      expect(document.parts).toHaveLength(1);
      const [part] = document.parts;
      // BEFORE the narrowing. A part carrying both keys compiles and narrows to the refusal
      // arm, so a check written after `isSourcePartUnavailable` cannot see one.
      expect(Object.hasOwn(part, "unavailable")).toBe(false);
      if (isSourcePartUnavailable(part)) throw new Error(`${kind.id} answered a refusal: ${part.unavailable}`);
      expect(part.id).toBe("definition");
      expect(part.label).toBe("Definition");
      // From the DECLARATION, and a declaration carrying none is refused rather than compared
      // against `undefined`, which any language would satisfy.
      const language = kind.sourceLanguage;
      if (language === undefined) {
        throw new Error(`${kind.id} declares hasSource and no sourceLanguage, so a Source tab has no language`);
      }
      expect(part.language).toBe(language);
      // The whole `options` document is rendered, so nothing of the definition is left out.
      expect(part.form).toBe("complete");
      // PRINTED BY THIS PRODUCT. MongoDB stores no statement for a view, and `stored` here
      // would show a reader a rendering as an original.
      expect(part.origin).toBe("rendered");
      expect(part.truncated).toBeUndefined();
      read[kind.id] = part.text;
    }

    expect(read).toEqual({ view: OBJECT_FIXTURE_APP_VIEW_SOURCE });
  });

  test("renders every field the row carries and every BSON value inside it", async () => {
    // The adversarial view, and the only object in the fixture that can tell two renderings
    // apart. `collation` is in the text, so the read is not the design's two fields; the
    // pattern is in the text, so the read is not `JSON.stringify`, which renders a regular
    // expression as `{}` and loses it with no error anywhere.
    const document = await objectProvider.readObjectSource!(["configstore", "dark_settings"], "view");

    expect(document.path).toEqual(["configstore", "dark_settings"]);
    const [part] = document.parts;
    expect(Object.hasOwn(part, "unavailable")).toBe(false);
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.text).toBe(OBJECT_FIXTURE_CONFIGSTORE_VIEW_SOURCE);
    expect(part.form).toBe("complete");
    // The database the CONTAINER names, not the one the session opened.
    expect(mongoDriver.openedDatabases).toEqual(["configstore"]);
  });

  test("carries the server's own sentence, unprefixed, when the catalog read is refused", async () => {
    // Measured on 8.2.12 with a role holding `read` on `configstore` only. The refusal is per
    // DATABASE and not per object, because both kinds come from ONE `listCollections`.
    //
    // The injected error carries the NAME the driver gives a server error reply, because that
    // name is what tells a refusal from a transport failure. Measured against mongodb 7.6.0
    // and MongoDB 8.2.12: an unauthorized `listCollections` rejects with a `MongoServerError`.
    const sentence =
      "not authorized on app to execute command { listCollections: 1, filter: {}, cursor: {}, " +
      'nameOnly: false, authorizedCollections: false, $db: "app" }';
    mongoDriver.listCollectionsErrors.app = serverErrorReply(sentence);

    const document = await objectProvider.readObjectSource!(["app", "active_customers"], "view");
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.unavailable).toBe(sentence);
    // Recipe rule 8: a refusal test that only asserts the sentence is satisfied by a part
    // carrying a real definition too, because such a part narrows to this arm.
    expect(Object.hasOwn(part, "text")).toBe(false);

    // THE POSITIVE CONTROL, in the SAME session, and it is what makes the claim above a fact
    // about PRIVILEGE rather than a fact about the connection. Without it a change that failed
    // the whole connection, or that cached one database's failure across the others, would keep
    // this test green while the shipped doc's headline sentence became false. It is the same
    // pair the doc's own two-command recipe uses.
    const control = await objectProvider.readObjectSource!(["configstore", "dark_settings"], "view");
    const [readable] = control.parts;
    expect(Object.hasOwn(readable, "unavailable")).toBe(false);
    if (isSourcePartUnavailable(readable)) throw new Error(`configstore was refused too: ${readable.unavailable}`);
    expect(readable.text).toBe(OBJECT_FIXTURE_CONFIGSTORE_VIEW_SOURCE);
  });

  /**
   * A TRANSPORT failure is not the engine refusing this object, and the two must not arrive as
   * the same document (#789).
   *
   * MEASURED against mongodb 7.6.0 and a MongoDB 8.2.12 container created for the measurement.
   * A server error reply rejects with `MongoServerError` (`name` and `constructor.name` both
   * that, prototype chain `MongoServerError < MongoError < Error`), carrying `code: 13`,
   * `codeName: "Unauthorized"` and the "not authorized on app ..." sentence. A transport
   * failure rejects with something else entirely: nothing listening on the port gives
   * `MongoServerSelectionError` ("connect ECONNREFUSED 127.0.0.1:27999", chain
   * `MongoServerSelectionError < MongoSystemError < MongoError < Error`), an unroutable host
   * gives the same class reading "Socket 'connect' timed out after 1502ms", and a client closed
   * underneath the read gives `MongoNotConnectedError` ("Client must be connected before
   * running operations").
   *
   * The old catch presented all of those as this view's own refusal: a 200 document whose one
   * part read "connect ECONNREFUSED" as MongoDB's sentence about the object, with no raise, no
   * destructive-state row and nothing telling it apart from a real `not authorized`.
   *
   * The NAME and not `instanceof`: this suite replaces the whole driver module with
   * `mock.module`, so an `instanceof` against the driver's export would be `instanceof
   * undefined` here, which is the same reason the Redis read keys on `ReplyError` by name.
   */
  test("raises a transport failure instead of printing it as this view's own refusal", async () => {
    for (const [name, message] of [
      ["MongoServerSelectionError", "connect ECONNREFUSED 127.0.0.1:27999"],
      ["MongoNotConnectedError", "Client must be connected before running operations"],
    ] as const) {
      const failure = new Error(message);
      failure.name = name;
      mongoDriver.listCollectionsErrors.app = failure;
      await expect(objectProvider.readObjectSource!(["app", "active_customers"], "view")).rejects.toThrow(
        new RegExp(
          `Failed to read the MongoDB view "active_customers" in app: ${message.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}`,
        ),
      );
      await expect(objectProvider.readObjectSource!(["app", "active_customers"], "view")).rejects.toBeInstanceOf(
        ConnectionError,
      );
    }

    // The CONTROL that makes the two arms different rather than the catch simply being gone: the
    // server's own error reply, in the same shape, still answers a refusal document.
    mongoDriver.listCollectionsErrors.app = serverErrorReply(
      "not authorized on app to execute command { listCollections: 1 }",
    );
    const document = await objectProvider.readObjectSource!(["app", "active_customers"], "view");
    expect(isSourcePartUnavailable(document.parts[0])).toBe(true);
  });

  test("reports a row that carried no definition rather than rendering an empty one", async () => {
    // OUR sentence and not the server's, declared as such in docs/providers/mongodb.md: the
    // read SUCCEEDED and the row carried nothing, so MongoDB said nothing to carry. This is
    // the arm that makes a misspelt field name a visible refusal instead of `{}` in an editor.
    mongoDriver.collectionsByDb.app = [{ name: "active_customers", type: "view" }];

    const document = await objectProvider.readObjectSource!(["app", "active_customers"], "view");
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.unavailable).toBe(
      'The listCollections row MongoDB answered for active_customers in app carries no "viewOn" and ' +
        '"pipeline", so this view has no definition to show',
    );
    expect(Object.hasOwn(part, "text")).toBe(false);
  });

  test("reports a row whose definition is present but the wrong shape", async () => {
    // Each arm of the guard on its own, so none of them can be deleted without a red. A
    // `viewOn` that is not a name, a `pipeline` that is not a list, and an `options` that is
    // `null` are all rows this provider must refuse rather than print or crash on.
    //
    // `options: null` is the arm line coverage cannot see: `typeof null === "object"`, so the
    // null half of the guard sits on the same physical line as the typeof half and lcov reports
    // it hit either way. Without the guard the read reaches `definition.viewOn` and throws
    // `TypeError: Cannot read properties of null`, which escapes as an unmapped TypeError and
    // the route turns it into a 500 rather than the declared refusal.
    //
    // Recipe rule 8 on EVERY arm: `isSourcePartUnavailable` alone is satisfied by a hybrid part
    // carrying a real definition, and by a part carrying the WRONG refusal sentence, so each arm
    // asserts the absence of `text` and the sentence itself.
    const expected =
      'The listCollections row MongoDB answered for active_customers in app carries no "viewOn" and ' +
      '"pipeline", so this view has no definition to show';
    const rows: Record<string, unknown>[] = [
      { viewOn: "", pipeline: [] },
      { viewOn: "customers", pipeline: { $match: {} } },
    ];
    for (const options of rows) {
      mongoDriver.collectionsByDb.app = [{ name: "active_customers", type: "view", options }];
      const document = await objectProvider.readObjectSource!(["app", "active_customers"], "view");
      const [part] = document.parts;
      expect(isSourcePartUnavailable(part)).toBe(true);
      if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(Object.hasOwn(part, "text")).toBe(false);
      expect(part.unavailable).toBe(expected);
    }

    // `options: null`, which the typed fixture record cannot express, so it is cast at the one
    // place a real driver reply could carry it.
    mongoDriver.collectionsByDb.app = [
      { name: "active_customers", type: "view", options: null as unknown as Record<string, unknown> },
    ];
    const nulled = await objectProvider.readObjectSource!(["app", "active_customers"], "view");
    const [part] = nulled.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(Object.hasOwn(part, "text")).toBe(false);
    expect(part.unavailable).toBe(expected);
  });

  test("raises for a view the catalog does not hold, and never answers a refusal for it", async () => {
    // A row simply not being in the listing is ABSENCE on this engine: there is no error to
    // carry, so answering a document would invent one.
    await expect(objectProvider.readObjectSource!(["app", "no_such_view"], "view")).rejects.toThrow(
      /No MongoDB view named no_such_view in app/,
    );
    // The name IS in the catalog, as a collection. The KIND decides, so this is a miss rather
    // than a collection rendered as a view.
    await expect(objectProvider.readObjectSource!(["app", "customers"], "view")).rejects.toThrow(
      /No MongoDB view named customers in app/,
    );
  });

  /**
   * The part's `language` comes from the DECLARATION, and the provider owns that link (#789).
   *
   * Design guarantee 6.3.4 says a readable part's `language` EQUALS the kind's declared
   * `sourceLanguage` wherever the kind declares one. The declaration here says `json`, so a
   * literal `"json"` in the provider satisfies every other test in this file while the link
   * itself is unwritten: measured, replacing the whole expression with the literal left the
   * suite at 130 pass 0 fail. Swapping a different language into the declaration is what makes
   * the link mutatable, and it is the same `spyOn` shape standing ruling 5g uses for the path.
   */
  test("takes the part's language from the DECLARATION, not from a literal in the read", async () => {
    const capabilities = objectProvider.getCapabilities();
    const spy = spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      objectKinds: (capabilities.objectKinds ?? []).map((kind) =>
        kind.hasSource === true ? { ...kind, sourceLanguage: "yaml" } : kind,
      ),
    });
    try {
      const document = await objectProvider.readObjectSource!(["app", "active_customers"], "view");
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(part.language).toBe("yaml");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * A kind declaring `hasSource` and no `sourceLanguage` is a DECLARATION defect, and it raises
   * here rather than being papered over with a default (#789).
   *
   * The old code read `spec.sourceLanguage ?? "json"`. That fallback is dead against the shipped
   * declaration and silently wrong the moment it fires: a kind that gained `hasSource` without a
   * language would be answered `json` for, say, a validator expression, guarantee 6.3.4 would be
   * satisfied vacuously, and the pane would pick the wrong Monaco mode with nothing anywhere
   * saying so. The declaration test would go red, but the PROVIDER would still answer.
   */
  test("refuses a kind declaring source with no language rather than guessing one", async () => {
    const capabilities = objectProvider.getCapabilities();
    const spy = spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      objectKinds: (capabilities.objectKinds ?? []).map((kind) =>
        kind.hasSource === true ? { ...kind, sourceLanguage: undefined } : kind,
      ),
    });
    try {
      await expect(objectProvider.readObjectSource!(["app", "active_customers"], "view")).rejects.toThrow(
        /MongoDB declares source for the kind "view" and no sourceLanguage/,
      );
      // Nothing was read: the declaration is refused before a database is opened, exactly as the
      // kind check above it is.
      expect(mongoDriver.openedDatabases).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses a kind whose declaration carries no source, and one this engine never declares", async () => {
    // Read off the DECLARATION and never off the kind id. `collection` is declared and has no
    // definition text; `index` is not declared at all; both take the same path.
    await expect(objectProvider.readObjectSource!(["app", "customers"], "collection")).rejects.toThrow(
      /declares no readable source for the kind "collection"/,
    );
    await expect(objectProvider.readObjectSource!(["app", "customers"], "index")).rejects.toThrow(
      /declares no readable source for the kind "index"/,
    );
  });

  test("refuses an object path of the wrong length before it opens a database", async () => {
    await expect(objectProvider.readObjectSource!(["active_customers"], "view")).rejects.toThrow(
      /"view" path is \[database, name\]/,
    );
    await expect(objectProvider.readObjectSource!(["app", "sub", "active_customers"], "view")).rejects.toThrow(
      /"view" path is \[database, name\]/,
    );
    expect(mongoDriver.openedDatabases).toEqual([]);
  });

  test("bounds the text at the caller's limit and says so in the caller's own number", async () => {
    const whole = OBJECT_FIXTURE_APP_VIEW_SOURCE.length;
    const document = await objectProvider.readObjectSource!(["app", "active_customers"], "view", 20);
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(whole).toBeGreaterThan(20);
    expect(part.text).toBe(OBJECT_FIXTURE_APP_VIEW_SOURCE.slice(0, 20));
    expect(part.truncated).toEqual({
      limit: 20,
      reason: "the source read was bounded at 20 characters by its caller",
    });
  });

  /**
   * Standing ruling 5g on the sixth method, and recipe rule 9's second declaration with it.
   *
   * MongoDB declares ONE container level, so `path[0]` for the database and `path[1]` for the
   * name are behaviour-identical here and no fixture on this engine can tell those spellings
   * from the derived ones. Swapping a two-level declaration in through `getCapabilities` and
   * driving it to the database the driver was BOUND with is what kills them. The SECOND
   * declaration swaps the two levels over and feeds the path in the swapped order, where the
   * same three values must still reach the server: a declaration whose level order happens to
   * match the path certifies nothing about which one was read.
   */
  test("derives the database and the name from the DECLARATION, not from a position", async () => {
    const capabilities = objectProvider.getCapabilities();
    const spy = spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [
        { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });
    try {
      const document = await objectProvider.readObjectSource!(["cluster0", "app", "active_customers"], "view");
      expect(document.path).toEqual(["cluster0", "app", "active_customers"]);
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(part.text).toBe(OBJECT_FIXTURE_APP_VIEW_SOURCE);
      // The BOUND VALUE. `path[0]` would have opened `cluster0`, which holds nothing here.
      expect(mongoDriver.openedDatabases).toEqual(["app"]);
    } finally {
      spy.mockRestore();
    }

    // The swapped declaration: the database level is now FIRST and the path is fed in that
    // order, so an implementation reading the second segment as the database opens `cluster0`.
    const swapped = spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [
        { id: "schema", label: "Database", labelPlural: "Databases" },
        { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
      ],
    });
    try {
      mongoDriver.openedDatabases = [];
      const document = await objectProvider.readObjectSource!(["app", "cluster0", "active_customers"], "view");
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(part.text).toBe(OBJECT_FIXTURE_APP_VIEW_SOURCE);
      expect(mongoDriver.openedDatabases).toEqual(["app"]);
    } finally {
      swapped.mockRestore();
    }
  });

  test("refuses a declaration carrying no database level rather than reading one named undefined", async () => {
    const capabilities = objectProvider.getCapabilities();
    // Restored in a `finally` like every other spy in this file. `objectProvider` is rebuilt in
    // `beforeEach` so nothing today inherits it, but a spy that outlives its own assertion would
    // hand a one-level `catalog`-only declaration to any test appended after this one.
    const spy = spyOn(objectProvider, "getCapabilities").mockReturnValue({
      ...capabilities,
      containerLevels: [{ id: "catalog", label: "Cluster", labelPlural: "Clusters" }],
    });
    try {
      await expect(objectProvider.readObjectSource!(["cluster0", "active_customers"], "view")).rejects.toThrow(
        /needs a "schema" container level and a segment for it/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ============================================================================
// endOpenQueryTransaction() (D75)
// ============================================================================

describe("endOpenQueryTransaction()", () => {
  /** The only three answers D75 accepts from a provider that does not implement the surface. */
  const ABSENCES = [
    "the engine has no transaction to leave open",
    "the driver cannot be asked",
    "nobody has measured it yet",
  ] as const;

  test("is not implemented, and the doc names WHICH absence that is", () => {
    const provider: DatabaseProvider = new MongoDBProvider({ ...baseConfig });

    expect(provider.endOpenQueryTransaction).toBeUndefined();

    // A boundary nobody wrote down becomes a fallback the next reader trusts, so the
    // absence has to be readable in the doc as well as in the type. Exactly one of the
    // three: "one of these two" is not an answer, and a doc that names none has not
    // declared anything.
    const doc = readFileSync(join(import.meta.dir, "../../../docs/providers/mongodb.md"), "utf8");
    expect(doc).toContain("endOpenQueryTransaction");

    // The enumeration in the same sentence has to name every implementer. `redis` joined
    // them in this same wave, and a list that goes stale in silence is exactly the
    // boundary the next reader trusts. Matched over collapsed whitespace, so re-wrapping
    // the paragraph does not turn this red.
    expect(doc.replace(/\s+/g, " ")).toContain("implemented on `postgres`, `sqlite`, `duckdb` and `redis`");
    expect(ABSENCES.filter((absence) => doc.includes(absence))).toEqual([
      "the engine has no transaction to leave open",
    ]);
  });
});
