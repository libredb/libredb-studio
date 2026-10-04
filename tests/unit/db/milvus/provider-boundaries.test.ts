/**
 * What MilvusProvider holds across its surfaces, over the fake client: nothing but Load loads a collection; each surface calls only the client
 * methods its own slice names; two databases are served by one provider at once; a call ends at its deadline and at
 * the connection's close; a console run and a preview share the provider's four permits; a running request is
 * cancelled by its id; and a Load that is watching when the connection closes frees the lock.
 */
import { describe, expect, test } from "bun:test";
import { QueryCancelledError, TimeoutError } from "@/lib/db/errors";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import type { DatabaseConnection } from "@/lib/db/types";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  type FakeCatalog,
  type FakeMilvusClient,
  plainCollection,
  SYSTEM_INFO,
  settle,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

const CONNECTION: DatabaseConnection = {
  id: "milvus-boundaries",
  name: "milvus boundaries",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

const CATALOG: FakeCatalog = {
  databases: {
    default: [
      { describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000" },
      {
        describe: plainCollection("unloaded_big"),
        indexes: [wireIndex("vec", "IVF_FLAT", "L2")],
        loadState: "LoadStateNotLoad",
      },
    ],
    probe_db: [{ describe: plainCollection("notes", "probe_db"), indexes: [wireIndex("vec", "FLAT", "L2")] }],
  },
  metrics: SYSTEM_INFO,
};

/** A connected provider over a fresh fake for every connect, its call log starting empty. */
async function connected(catalog: FakeCatalog = CATALOG, queryTimeout = 5_000) {
  const clients: FakeMilvusClient[] = [];
  const provider = new MilvusProvider(CONNECTION, { queryTimeout }, {}, async () => {
    const client = createFakeMilvusClient(catalog);
    clients.push(client);
    return client;
  });
  await provider.connect();
  clients[0].calls.length = 0;
  return { provider, client: clients[0], clients };
}

const methodsOf = (client: FakeMilvusClient) => client.calls.map((call) => call.method);
const failure = (pending: Promise<unknown>): Promise<Error> =>
  pending.then(
    () => {
      throw new Error("it succeeded");
    },
    (error: unknown) => error as Error,
  );

/** Every surface but running a Load or a Release, each as one call a test can name. */
const SURFACES: ReadonlyArray<readonly [string, (provider: MilvusProvider) => Promise<unknown>, readonly string[]]> = [
  ["listContainers", (p) => p.listContainers(), ["listDatabases"]],
  ["countObjects", (p) => p.countObjects(["default"]), ["showCollections"]],
  ["listObjects", (p) => p.listObjects(["default"], "collection"), ["showCollections"]],
  [
    "describeObject",
    (p) => p.describeObject(["default", "unloaded_big"], "collection"),
    ["describeCollection", "describeIndex"],
  ],
  [
    "describeObjects",
    (p) => p.describeObjects(["default"], "collection"),
    ["showCollections", "batchDescribeCollection"],
  ],
  [
    "readObjectSource",
    (p) => p.readObjectSource(["default", "unloaded_big"], "collection"),
    ["describeCollection", "describeIndex", "getLoadState", "getCollectionStatistics", "showPartitions", "listAliases"],
  ],
  ["getHealth", (p) => p.getHealth(), ["checkHealth"]],
  ["getOverview", (p) => p.getOverview(), ["showCollections", "describeIndex"]],
  ["getTableStats", (p) => p.getTableStats(), ["showCollections", "getCollectionStatistics"]],
  ["getIndexStats", (p) => p.getIndexStats(), ["showCollections", "describeIndex"]],
  [
    "previewMaintenance(load)",
    (p) => p.previewMaintenance("load", ["default", "unloaded_big"]),
    ["describeCollection", "getLoadState", "getCollectionStatistics", "describeIndex", "getMetricsSystemInfo"],
  ],
  [
    "previewMaintenance(release)",
    (p) => p.previewMaintenance("release", ["default", "unloaded_big"]),
    ["describeCollection", "getLoadState"],
  ],
];

describe("each surface calls only what its own slice names", () => {
  test.each(SURFACES)("%s", async (_name, run, allowed) => {
    const { provider, client } = await connected();
    await run(provider);
    expect([...new Set(methodsOf(client))].sort()).toEqual([...allowed].sort());
  });

  test("only Load and Release reach loadCollection and releaseCollection", async () => {
    const { provider, client } = await connected();
    await provider.runMaintenance("load", "docs_int64", "default");
    expect([...new Set(methodsOf(client))].sort()).toEqual(["getLoadState", "getLoadingProgress", "loadCollection"]);
    client.calls.length = 0;
    await provider.runMaintenance("release", "docs_int64", "default");
    expect(methodsOf(client)).toEqual(["releaseCollection"]);
  });
});

describe("nothing loads a collection implicitly", () => {
  test("a session over an unloaded collection, every read surface in turn, sends no load and no load-progress read", async () => {
    const { provider, client } = await connected();
    for (const [, run] of SURFACES) {
      // oxlint-disable-next-line no-await-in-loop -- the surfaces in the order a user opens them.
      await run(provider);
    }
    await provider.getMonitoringData();
    const sent = new Set(methodsOf(client));
    for (const never of ["loadCollection", "releaseCollection", "getLoadingProgress"])
      expect(sent.has(never)).toBe(false);
    const source = await provider.readObjectSource(["default", "unloaded_big"], "collection");
    expect(JSON.parse((source.parts[1] as { text: string }).text).load).toBe("LoadStateNotLoad");
  });
});

describe("one database per call", () => {
  test("two surfaces for two databases in flight on one provider each reach their own", async () => {
    const { provider, client } = await connected();
    const [left, right] = await Promise.all([
      provider.listObjects(["default"], "collection"),
      provider.listObjects(["probe_db"], "collection"),
    ]);
    expect(left.map((object) => object.path[0])).toEqual(["default", "default"]);
    expect(right.map((object) => object.path)).toEqual([["probe_db", "notes"]]);
    expect(client.calls.map((call) => call.args?.[0]).sort()).toEqual(["default", "probe_db"]);
  });
});

describe("time", () => {
  test("a surface call ends at its deadline, the query timeout when that is shorter than 10 seconds, and frees its permit", async () => {
    const { provider, client } = await connected(CATALOG, 40);
    const release = client.hold("showCollections");
    expect(await failure(provider.listObjects(["default"], "collection"))).toBeInstanceOf(TimeoutError);
    release();
    expect(await provider.listObjects(["default"], "collection")).toHaveLength(2);
    expect(client.inFlight()).toBe(0);
  });

  test("a call in flight when the connection closes ends as cancelled", async () => {
    const { provider, client } = await connected();
    client.hold("showCollections");
    const pending = failure(provider.listObjects(["default"], "collection"));
    await settle();
    await provider.disconnect();
    expect(await pending).toBeInstanceOf(QueryCancelledError);
  });
});

describe("a console run and a panel share the provider's four permits", () => {
  const QUERY = 'POST /v2/vectordb/entities/query\n{"collectionName": "docs_int64", "filter": "", "limit": 10}';

  test("with one request in flight, a Load preview has three of its four reads in flight until the request settles", async () => {
    const { provider, client } = await connected();
    const releaseQuery = client.hold("query");
    const run = provider.query(QUERY, undefined, "q-1759400000000-a1");
    await settle();
    expect(client.inFlight()).toBe(1);
    const releases = (
      ["describeIndex", "getCollectionStatistics", "getLoadState", "getMetricsSystemInfo"] as const
    ).map((method) => client.hold(method));
    const preview = provider.previewMaintenance("load", ["default", "docs_int64"]);
    await settle();
    expect(client.inFlight()).toBe(4);
    releaseQuery();
    await run;
    await settle();
    expect(client.inFlight()).toBe(4);
    for (const release of releases) release();
    await preview;
    expect(client.maxInFlight()).toBe(4);
  });

  test("cancelQuery stops a running request by its id, answers true once, and frees its permit", async () => {
    const { provider, client } = await connected();
    client.hold("query");
    const run = failure(provider.query(QUERY, undefined, "q-1759400000000-b2"));
    await settle();
    expect(await provider.cancelQuery("q-1759400000000-b2")).toBe(true);
    expect(await run).toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("q-1759400000000-b2")).toBe(false);
    expect(client.inFlight()).toBe(0);
    expect(await provider.listObjects(["probe_db"], "collection")).toHaveLength(1);
  });
});

describe("the load lock across the connection's life", () => {
  test("a Load that is watching when the connection closes stops with a sentence, and the next connection's Load is not blocked", async () => {
    const { provider, clients } = await connected({ ...CATALOG, progress: ["0"] });
    const watching = failure(provider.runMaintenance("load", "docs_int64", "default"));
    await settle();
    expect(clients[0].calls.map((call) => call.method)).toEqual([
      "getLoadState",
      "loadCollection",
      "getLoadingProgress",
    ]);
    await provider.disconnect();
    expect((await watching).message).toBe(
      "Studio stopped watching the load because the connection closed; Milvus continues the load on the server.",
    );
    await provider.connect();
    clients[1].on("getLoadingProgress", () => ({
      status: { code: 0, error_code: "Success" },
      progress: "100",
      refresh_progress: "100",
    }));
    const again = await provider.runMaintenance("load", "docs_int64", "default");
    expect(again.message).toStartWith("Loaded:");
  });

  test("two Loads on one provider send their LoadCollection one after the other", async () => {
    const { provider, client } = await connected();
    const release = client.hold("loadCollection");
    const first = provider.runMaintenance("load", "docs_int64", "default");
    const second = provider.runMaintenance("load", "unloaded_big", "default");
    await settle();
    expect(methodsOf(client).filter((method) => method === "loadCollection")).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(methodsOf(client).filter((method) => method === "loadCollection")).toHaveLength(2);
  });
});
