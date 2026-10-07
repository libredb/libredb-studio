/**
 * MilvusProvider at its own seam: the declarations with no client; a constructor that validates nothing and opens
 * nothing; the connect sequence, which maps the connection, builds the client through the injected factory and reads
 * GetVersion and nothing else; and every surface answering exactly what the module that owns it answers over the same
 * catalog, so the provider composes and never reshapes.
 *
 * Every client is the fake of tests/helpers/milvus-catalog-client.ts; the real adapter over a recorded wire runs in
 * tests/integration/db/milvus-provider.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { MilvusError } from "@/lib/db/providers/vector/milvus/client";
import type { MilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import { MILVUS_LABELS } from "@/lib/db/providers/vector/milvus/labels";
import { MILVUS_MAINTENANCE_SPECS, previewMilvusMaintenance } from "@/lib/db/providers/vector/milvus/maintenance";
import {
  readMilvusHealth,
  readMilvusIndexStats,
  readMilvusOverview,
  readMilvusTableStats,
} from "@/lib/db/providers/vector/milvus/monitoring-reads";
import {
  countMilvusCollections,
  describeMilvusCollection,
  describeMilvusCollections,
  listMilvusCollectionNames,
  listMilvusCollections,
  listMilvusDatabases,
  MILVUS_CONTAINER_LEVELS,
  MILVUS_OBJECT_KINDS,
  readMilvusCollectionSource,
} from "@/lib/db/providers/vector/milvus/objects";
import type { DatabaseConnection, ProviderExecutionContext } from "@/lib/db/types";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  type FakeCatalog,
  plainCollection,
  SYSTEM_INFO,
  testSurface,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
/** A token without a colon, a second stand-in. */
const TEST_TOKEN = "password-second";
const QUERY_TIMEOUT = 5_000;

/** A loopback endpoint, so a credential may travel without TLS. */
const CONNECTION: DatabaseConnection = {
  id: "milvus-unit",
  name: "milvus unit",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

const CATALOG: FakeCatalog = {
  databases: {
    default: [
      { describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000", partitions: ["_default", "part_a"] },
      { describe: plainCollection("notes"), indexes: [wireIndex("vec", "FLAT", "L2")], rowCount: "7" },
    ],
    probe_db: [{ describe: plainCollection("other", "probe_db"), indexes: [wireIndex("vec", "FLAT", "L2")] }],
  },
  metrics: SYSTEM_INFO,
};

function over(
  catalog: FakeCatalog,
  connection: DatabaseConnection = CONNECTION,
  execution: ProviderExecutionContext = {},
) {
  const client = createFakeMilvusClient(catalog);
  const opened: MilvusConnectionOptions[] = [];
  const provider = new MilvusProvider(connection, { queryTimeout: QUERY_TIMEOUT }, execution, async (options) => {
    opened.push(options);
    return client;
  });
  return { provider, client, opened };
}

/** A connected provider whose call log starts empty. */
async function connected(catalog: FakeCatalog = CATALOG, connection: DatabaseConnection = CONNECTION) {
  const built = over(catalog, connection);
  await built.provider.connect();
  built.client.calls.length = 0;
  return built;
}

const failure = (pending: Promise<unknown>): Promise<Error> =>
  pending.then(
    () => {
      throw new Error("it succeeded");
    },
    (error: unknown) => error as Error,
  );

describe("the declarations, with no client", () => {
  test("the capabilities, every member written out", () => {
    const { queryDialect, ...declared } = over(CATALOG).provider.getCapabilities();
    expect<string | undefined>(queryDialect).toBe("milvus");
    expect(declared).toEqual({
      queryLanguage: "json",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsTransactions: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsExternalQueryLimiting: false,
      supportsConnectionString: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["load", "release"],
      maintenanceOperationSpecs: MILVUS_MAINTENANCE_SPECS,
      statementTerminator: "none",
      defaultPort: 19530,
      containerLevels: MILVUS_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: MILVUS_OBJECT_KINDS,
      enforcesReadOnly: true,
      schemaRefreshPattern: "(?!)",
    });
  });

  test("the labels are a copy of the provider's own", () => {
    const { provider } = over(CATALOG);
    expect(provider.getLabels()).toEqual(MILVUS_LABELS);
    expect(provider.getLabels()).not.toBe(MILVUS_LABELS);
  });

  test("a request carries its own bounds, so no limit is added to it", () => {
    expect(over(CATALOG).provider.prepareQuery("POST collections/list\n{}")).toEqual({
      query: "POST collections/list\n{}",
      wasLimited: false,
      limit: 500,
      offset: 0,
    });
  });

  test("the constructor validates nothing and opens nothing, even for a connection connect() would refuse", () => {
    const { provider, opened, client } = over(CATALOG, { ...CONNECTION, host: "http://localhost", port: -1 });
    expect(provider.isConnected()).toBe(false);
    expect(opened).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(provider.getCapabilities().defaultPort).toBe(19530);
  });

  test("what is detected by presence: cancelQuery, the preview and the engine user are there; queryReadOnly, a pool, row edits and a key scan are not", () => {
    const provider: object = over(CATALOG).provider;
    for (const present of ["cancelQuery", "previewMaintenance", "engineUser", "readObjectSource"]) {
      expect(present in provider).toBe(true);
    }
    for (const absent of [
      "queryReadOnly",
      "getPoolStats",
      "buildObjectEdit",
      "applyObjectEdit",
      "scanKeysPage",
      "beginTransaction",
    ]) {
      expect(absent in provider).toBe(false);
    }
  });

  test("an unconnected provider refuses every surface", async () => {
    const { provider, client } = over(CATALOG);
    const calls: Array<() => Promise<unknown>> = [
      () => provider.listContainers(),
      () => provider.countObjects(["default"]),
      () => provider.listObjects(["default"], "collection"),
      () => provider.describeObject(["default", "notes"], "collection"),
      () => provider.describeObjects(["default"], "collection"),
      () => provider.readObjectSource(["default", "notes"], "collection"),
      () => provider.query("POST collections/list\n{}"),
      () => provider.getHealth(),
      () => provider.getOverview(),
      () => provider.getTableStats(),
      () => provider.getIndexStats(),
      () => provider.getPerformanceMetrics(),
      () => provider.getSlowQueries(),
      () => provider.getActiveSessions(),
      () => provider.getStorageStats(),
      () => provider.runMaintenance("load", "notes", "default"),
      () => provider.previewMaintenance("load", ["default", "notes"]),
    ];
    for (const call of calls) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time.
      const error = await failure(call());
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe("Provider is not connected. Call connect() first.");
    }
    expect(provider.engineUser()).toBeUndefined();
    expect(await provider.cancelQuery("q-1")).toBe(false);
    expect(client.calls).toEqual([]);
  });
});

describe("connect and disconnect", () => {
  test("maps the connection, builds one client through the factory, reads GetVersion and nothing else", async () => {
    const { provider, client, opened } = over(CATALOG);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toBe("dns:127.0.0.1:19530");
    expect(opened[0].database).toBe("default");
    expect(opened[0].callTimeoutMs).toBe(QUERY_TIMEOUT);
    expectCalls(client, [{ method: "getVersion", args: ["default"] }]);
  });

  test("the connection's database is the one every surface defaults to", async () => {
    const { provider, client } = await connected(CATALOG, { ...CONNECTION, database: "probe_db" });
    expect((await provider.listContainers()).find((container) => container.isSessionDefault)?.name).toBe("probe_db");
    expect((await provider.getTableStats()).map((row) => row.tableName)).toEqual(["other"]);
    expect(client.calls.every((call) => call.args?.[0] === "probe_db")).toBe(true);
  });

  test("a connection the mapping refuses never reaches the factory", async () => {
    const { provider, opened } = over(CATALOG, { ...CONNECTION, host: "http://localhost" });
    expect(await failure(provider.connect())).toBeInstanceOf(DatabaseConfigError);
    expect(opened).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("a factory that fails is worded by the error table", async () => {
    const provider = new MilvusProvider(CONNECTION, {}, {}, async () => {
      throw new MilvusError("not-connected", "ECONNREFUSED");
    });
    const error = await failure(provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toStartWith("No Milvus answered a plaintext connection at 127.0.0.1:19530.");
    expect(provider.isConnected()).toBe(false);
  });

  test("a GetVersion the server refuses fails the connect and closes the client it built", async () => {
    const { provider, client } = over(CATALOG);
    client.on("getVersion", () => new MilvusError("unauthenticated", "auth check failure", { grpcCode: 16 }));
    const error = await failure(provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(client.closes()).toBe(1);
    expect(provider.isConnected()).toBe(false);
  });

  test("disconnect closes the one client, and the provider then refuses its surfaces", async () => {
    const { provider, client } = await connected();
    await provider.disconnect();
    expect(client.closes()).toBe(1);
    expect(provider.isConnected()).toBe(false);
    expect(await failure(provider.listContainers())).toBeInstanceOf(DatabaseConfigError);
    await provider.disconnect();
    expect(client.closes()).toBe(1);
  });
});

describe("the object surface is objects.ts's", () => {
  test("listContainers is the database listing, and nothing nests under a database", async () => {
    const { provider, client } = await connected();
    expect(await provider.listContainers()).toEqual(
      await listMilvusDatabases(createFakeMilvusClient(CATALOG), testSurface()),
    );
    client.calls.length = 0;
    expect(await provider.listContainers(["default"])).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  test("countObjects and listObjects are one listing each, for the container's database", async () => {
    const { provider, client } = await connected();
    const other = createFakeMilvusClient(CATALOG);
    expect(await provider.countObjects(["probe_db"])).toEqual(
      await countMilvusCollections(other, testSurface(), "probe_db"),
    );
    expect(await provider.listObjects(["probe_db"], "collection")).toEqual(
      await listMilvusCollections(other, testSurface(), "probe_db"),
    );
    expectCalls(client, [
      { method: "showCollections", args: ["probe_db"] },
      { method: "showCollections", args: ["probe_db"] },
    ]);
  });

  test("describeObject, describeObjects and readObjectSource answer what objects.ts answers", async () => {
    const { provider } = await connected();
    const other = createFakeMilvusClient(CATALOG);
    expect(await provider.describeObject(["default", "docs_int64"], "collection")).toEqual(
      await describeMilvusCollection(other, testSurface(), "default", "docs_int64"),
    );
    const names = await listMilvusCollectionNames(other, testSurface(), "default");
    expect(await provider.describeObjects(["default"], "collection", 1)).toEqual(
      await describeMilvusCollections(other, testSurface(), "default", names, 1),
    );
    expect(await provider.readObjectSource(["default", "docs_int64"], "collection", 5_000)).toEqual(
      await readMilvusCollectionSource(other, testSurface(), "default", "docs_int64", 5_000),
    );
  });

  test("a path of the wrong shape and a kind Milvus does not declare are refused with no call", async () => {
    const { provider, client } = await connected();
    const refusals = await Promise.all([
      failure(provider.countObjects([])),
      failure(provider.listObjects(["a", "b"], "collection")),
      failure(provider.describeObjects([], "collection")),
      failure(provider.describeObject(["docs_int64"], "collection")),
      failure(provider.readObjectSource(["default"], "collection")),
      failure(provider.listObjects(["default"], "table")),
      failure(provider.describeObject(["default", "docs_int64"], "table")),
      failure(provider.describeObjects(["default"], "table")),
      failure(provider.readObjectSource(["default", "docs_int64"], "table")),
    ]);
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(QueryError);
    expect(refusals[0].message).toBe("A Milvus container path is [database], received []");
    expect(refusals[3].message).toBe('A Milvus "collection" path is [database, name], received ["docs_int64"]');
    expect(refusals[5].message).toBe('Milvus declares no object kind "table"');
    expect(refusals[8].message).toBe('Milvus declares no object kind "table"');
    expect(client.calls).toEqual([]);
  });
});

describe("monitoring is monitoring-reads.ts's", () => {
  test("health, the overview with the version read at connect, the tables and the indexes", async () => {
    const { provider } = await connected();
    const other = createFakeMilvusClient(CATALOG);
    expect(await provider.getHealth()).toEqual(await readMilvusHealth(other, testSurface()));
    expect(await provider.getOverview()).toEqual(
      await readMilvusOverview(other, testSurface(), "default", { reported: "v3.0.2", major: 3, minor: 0 }),
    );
    expect(await provider.getTableStats()).toEqual(await readMilvusTableStats(other, testSurface(), "default"));
    expect(await provider.getTableStats({ schema: "probe_db" })).toEqual(
      await readMilvusTableStats(other, testSurface(), "probe_db"),
    );
    expect(await provider.getIndexStats()).toEqual(await readMilvusIndexStats(other, testSurface(), "default"));
    expect(await provider.getIndexStats({ schema: "probe_db" })).toEqual(
      await readMilvusIndexStats(other, testSurface(), "probe_db"),
    );
  });

  test("what Milvus keeps on its management port is absent: no metric, slow query, session or storage row, and no call", async () => {
    const { provider, client } = await connected();
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  test("the dashboard's read fills the overview, the tables and the indexes with no panel error", async () => {
    const { provider } = await connected();
    const data = await provider.getMonitoringData();
    expect(data.overview?.tableCount).toBe(2);
    expect(data.tables).toHaveLength(2);
    expect(data.indexes).toHaveLength(2);
    expect(data.errors).toBeUndefined();
  });
});

describe("maintenance is maintenance.ts's", () => {
  test("the preview, over the provider's own client", async () => {
    const { provider } = await connected();
    expect(await provider.previewMaintenance("load", ["default", "docs_int64"])).toEqual(
      await previewMilvusMaintenance(createFakeMilvusClient(CATALOG), testSurface(), "load", ["default", "docs_int64"]),
    );
  });

  test("Load and Release run with the collection as the target and the database as the container", async () => {
    const { provider, client } = await connected();
    const loaded = await provider.runMaintenance("load", "docs_int64", "default");
    expect(loaded.message).toStartWith("Loaded: collection docs_int64 of database default");
    const released = await provider.runMaintenance("release", "other", "probe_db");
    expect(released.message).toStartWith("Released: collection other of database probe_db");
    expect(client.calls.map((call) => [call.method, call.args?.[0]])).toEqual([
      ["getLoadState", "default"],
      ["loadCollection", "default"],
      ["getLoadingProgress", "default"],
      ["releaseCollection", "probe_db"],
    ]);
  });
});

describe("engineUser, the principal an audit row names", () => {
  test("the configured user", async () => {
    const { provider } = await connected(CATALOG, { ...CONNECTION, user: "reader", password: TEST_PASSWORD });
    expect(provider.engineUser()).toBe("reader");
  });

  test("the part of a user:password token before its first colon, and nothing after it", async () => {
    const { provider } = await connected(CATALOG, { ...CONNECTION, password: `reader:${TEST_PASSWORD}` });
    expect(provider.engineUser()).toBe("reader");
  });

  test("the literal token for a token without a colon, and nothing with no credential", async () => {
    const withToken = await connected(CATALOG, { ...CONNECTION, password: TEST_TOKEN });
    expect(withToken.provider.engineUser()).toBe("token");
    expect((await connected()).provider.engineUser()).toBeUndefined();
  });
});

describe("the console is execute.ts's", () => {
  test("bound parameters are refused before anything is read", async () => {
    const { provider, client } = await connected();
    const error = await failure(provider.query("POST collections/list\n{}", [1]));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Bound params are not supported: a Milvus request has no placeholders");
    expect(client.calls).toEqual([]);
    await provider.query("POST collections/list\n{}", []);
  });

  test("a request runs over the provider's own client, in the database its body names", async () => {
    const { provider, client } = await connected();
    const result = await provider.query('POST /v2/vectordb/collections/list\n{"dbName": "probe_db"}');
    expect(JSON.stringify(result.rows)).toContain("other");
    expect(client.calls).toContainEqual({ method: "showCollections", args: ["probe_db"] });
  });

  test("cancelQuery answers false for an id that names no run", async () => {
    const { provider } = await connected();
    expect(await provider.cancelQuery("q-1759400000000-abcdef0123456789")).toBe(false);
  });
});
