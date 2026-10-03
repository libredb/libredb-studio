/**
 * Load and Release: the two declared per-row operations, Load
 * previewed and plainly confirmed, Release previewed and confirmed by the collection's exact name; the one-load lock,
 * FIFO, released once, left by a waiter whose signal aborts; and the poll's sleep, which an abort ends.
 */
import { describe, expect, test } from "bun:test";
import {
  abortableSleep,
  MILVUS_LOAD_POLL_MS,
  MILVUS_LOAD_WINDOW_MS,
  MILVUS_MAINTENANCE_OPERATIONS,
  MILVUS_MAINTENANCE_SPECS,
  METRICS_NOTE,
  MilvusLoadLock,
  maintenanceTarget,
  previewMilvusMaintenance,
  RELEASE_DESCRIPTION,
  STILL_LOADING,
} from "@/lib/db/providers/vector/milvus/maintenance";
import { vectorFieldInfos } from "@/lib/db/providers/vector/milvus/schema";
import { declaredEntityOperations, maintenanceControl, type ProviderCapabilities } from "@/lib/db/types";
import { expectCalls } from "../../../helpers/call-log";
import {
  createFakeMilvusClient,
  DOCS_INT64,
  DOCS_INT64_INDEX,
  describeAnswer,
  type FakeCatalog,
  kv,
  OK,
  permissionDenied,
  plainCollection,
  SYSTEM_INFO,
  settle,
  testSurface,
  wireField,
  wireIndex,
} from "../../../helpers/milvus-catalog-client";

const CAPABILITIES: ProviderCapabilities = {
  queryLanguage: "json",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsMaintenance: true,
  maintenanceOperations: [...MILVUS_MAINTENANCE_OPERATIONS],
  maintenanceOperationSpecs: MILVUS_MAINTENANCE_SPECS,
  supportsConnectionString: false,
  defaultPort: 19530,
  schemaRefreshPattern: "(?!)",
};

describe("the declared operations", () => {
  test("Load and Release, each its own member, never a reused one", () => {
    expect(MILVUS_MAINTENANCE_OPERATIONS).toEqual(["load", "release"]);
  });

  test("the two specs, exactly", () => {
    expect(MILVUS_MAINTENANCE_SPECS).toEqual({
      load: { label: "Load", perEntity: true, global: false, preview: true },
      release: {
        label: "Release",
        perEntity: true,
        global: false,
        confirmation: "typed-target",
        preview: true,
        description:
          "Every other client's search and query on this collection then fails with code 101 until it is loaded again.",
      },
    });
    expect(MILVUS_MAINTENANCE_SPECS.release?.description).toBe(RELEASE_DESCRIPTION);
  });

  test("both are offered per row, in declaration order, and neither on a whole-database card", () => {
    expect(declaredEntityOperations(CAPABILITIES)).toEqual([
      { type: "load", label: "Load" },
      { type: "release", label: "Release" },
    ]);
    expect(maintenanceControl(CAPABILITIES, "load", "global").offered).toBe(false);
    expect(maintenanceControl(CAPABILITIES, "release", "global").offered).toBe(false);
  });

  test("Release asks for the collection's exact name and both read the preview before the confirm button", () => {
    expect(maintenanceControl(CAPABILITIES, "release", "perEntity")).toEqual({
      offered: true,
      label: "Release",
      description: RELEASE_DESCRIPTION,
      confirmation: "typed-target",
      preview: true,
    });
    expect(maintenanceControl(CAPABILITIES, "load", "perEntity")).toEqual({
      offered: true,
      label: "Load",
      preview: true,
    });
  });

  test("the poll asks every second for at most 10 seconds", () => {
    expect(MILVUS_LOAD_POLL_MS).toBe(1_000);
    expect(MILVUS_LOAD_WINDOW_MS).toBe(10_000);
  });
});

describe("MilvusLoadLock", () => {
  test("the first acquire holds it at once; the next waits until the holder releases", async () => {
    const lock = new MilvusLoadLock();
    const free = new AbortController().signal;
    const first = await lock.acquire(free);
    expect(lock.held).toBe(true);
    let second: (() => void) | undefined;
    void lock.acquire(free).then((release) => {
      second = release;
    });
    await settle();
    expect(second).toBeUndefined();
    first();
    await settle();
    expect(second).toBeDefined();
    expect(lock.held).toBe(true);
    second?.();
    expect(lock.held).toBe(false);
  });

  test("waiters are admitted in arrival order, and a release given twice admits one", async () => {
    const lock = new MilvusLoadLock();
    const free = new AbortController().signal;
    const order: string[] = [];
    const holder = await lock.acquire(free);
    const b = lock.acquire(free).then((release) => {
      order.push("b");
      return release;
    });
    const c = lock.acquire(free).then((release) => {
      order.push("c");
      return release;
    });
    holder();
    holder();
    await settle();
    expect(order).toEqual(["b"]);
    (await b)();
    (await c)();
    expect(order).toEqual(["b", "c"]);
    expect(lock.held).toBe(false);
  });

  test("a waiter whose signal aborts leaves with the signal's reason and is never admitted", async () => {
    const lock = new MilvusLoadLock();
    const holder = await lock.acquire(new AbortController().signal);
    const leaving = new AbortController();
    const waiting = lock.acquire(leaving.signal);
    leaving.abort(new Error("the connection closed"));
    await expect(waiting).rejects.toThrow("the connection closed");
    holder();
    expect(lock.held).toBe(false);
  });

  test("an already aborted signal is refused at once", async () => {
    const lock = new MilvusLoadLock();
    const aborted = new AbortController();
    aborted.abort(new Error("closed"));
    await expect(lock.acquire(aborted.signal)).rejects.toThrow("closed");
    expect(lock.held).toBe(false);
  });
});

describe("abortableSleep", () => {
  test("resolves after the time", async () => {
    const started = Date.now();
    await abortableSleep(20, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("an abort ends it with the signal's reason, and an aborted signal refuses it at once", async () => {
    const stopping = new AbortController();
    const sleeping = abortableSleep(60_000, stopping.signal);
    stopping.abort(new Error("stopped"));
    await expect(sleeping).rejects.toThrow("stopped");
    await expect(abortableSleep(10, stopping.signal)).rejects.toThrow("stopped");
  });
});
const HALF_INDEXED = describeAnswer({
  name: "halfidx",
  fields: [
    wireField("id", "Int64", { is_primary_key: true }),
    wireField("a", "FloatVector", { type_params: [kv("dim", "4")] }),
    wireField("b", "FloatVector", { type_params: [kv("dim", "4")] }),
  ],
});

const CATALOG: FakeCatalog = {
  databases: {
    default: [
      { describe: DOCS_INT64, indexes: [DOCS_INT64_INDEX], rowCount: "2000" },
      {
        describe: plainCollection("loading"),
        indexes: [wireIndex("vec", "IVF_FLAT", "L2")],
        loadState: "LoadStateLoading",
      },
      { describe: plainCollection("noidx"), loadState: "LoadStateNotLoad" },
      { describe: HALF_INDEXED, indexes: [wireIndex("a", "FLAT", "L2")], loadState: "LoadStateNotLoad" },
    ],
    probe_db: [{ describe: plainCollection("notes", "probe_db"), indexes: [wireIndex("vec", "FLAT", "L2")] }],
  },
  metrics: SYSTEM_INFO,
};

const PREVIEW_READS = ["describeIndex", "getCollectionStatistics", "getLoadState", "getMetricsSystemInfo"];
const methodsOf = (client: { calls: readonly { method: string }[] }) => client.calls.map((call) => call.method);

describe("maintenanceTarget", () => {
  test("a path is [database, collection], or [collection] in the connection's database", () => {
    expect(maintenanceTarget(["probe_db", "notes"], "default")).toEqual({ database: "probe_db", collection: "notes" });
    expect(maintenanceTarget(["notes"], "default")).toEqual({ database: "default", collection: "notes" });
  });

  test.each([[[] as string[]], [["a", "b", "c"]]])("a path of another length, %j, is refused", (path) => {
    expect(() => maintenanceTarget(path, "default")).toThrow(
      `A Milvus maintenance target is [database, collection] or [collection], received ${JSON.stringify(path)}; nothing was sent.`,
    );
  });

  test("each segment meets Milvus's name rule, the database first", () => {
    expect(() => maintenanceTarget(["bad-db", "c"], "default")).toThrow(
      '"bad-db" is not a valid Milvus database name: a name starts with a letter or _, holds only letters, digits and _, and is at most 255 characters; nothing was sent.',
    );
    expect(() => maintenanceTarget(["default", "bad name"], "default")).toThrow(
      '"bad name" is not a valid Milvus collection name',
    );
    expect(() => maintenanceTarget([`c${"x".repeat(255)}`], "default")).toThrow(
      "is not a valid Milvus collection name",
    );
  });
});

describe("the Load preview", () => {
  test("the load state, the estimate, each vector field with its index, and the query-node memory", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "docs_int64"]);
    expect(preview).toEqual({
      summary:
        "Load collection docs_int64 of database default into query-node memory: expect about the raw data again in shared memory, which every client of this cluster shares until it is released.",
      facts: [
        { label: "Load state", value: "Loaded" },
        {
          label: "Rows (estimate)",
          value: "2,000 (estimate: flushed segments only, deletes not subtracted, may lag recent inserts)",
        },
        {
          label: "Vector field vec",
          value: `${vectorFieldInfos(DOCS_INT64)[0].nativeType}, index vec (HNSW, COSINE), Finished`,
        },
        { label: "Query-node memory", value: "925.0 MiB used of 4.0 GiB" },
        { label: "Data loaded on query nodes", value: "518.5 MiB" },
      ],
      note: "Memory figures are as reported by the server, possibly several seconds old; in standalone the memory is the whole process's.",
    });
    expect(preview.note).toContain(METRICS_NOTE);
  });

  test("DescribeCollection runs first, then the four other reads, and nothing loads or releases", async () => {
    const client = createFakeMilvusClient(CATALOG);
    await previewMilvusMaintenance(client, testSurface(), "load", ["default", "docs_int64"]);
    expect(client.calls[0]).toEqual({
      method: "describeCollection",
      args: ["default", { collection_name: "docs_int64" }],
    });
    expect(methodsOf(client).slice(1).sort()).toEqual(PREVIEW_READS);
    expect(methodsOf(client)).not.toContain("loadCollection");
    expect(methodsOf(client)).not.toContain("releaseCollection");
  });

  test("each read takes its own permit: with one permit held elsewhere, three of the four are in flight", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const context = testSurface();
    const elsewhere = await context.limiter.acquire(new AbortController().signal);
    const releases = (
      ["describeIndex", "getCollectionStatistics", "getLoadState", "getMetricsSystemInfo"] as const
    ).map((method) => client.hold(method));
    const pending = previewMilvusMaintenance(client, context, "load", ["default", "docs_int64"]);
    await settle();
    expect(client.inFlight()).toBe(3);
    elsewhere.release();
    await settle();
    expect(client.inFlight()).toBe(4);
    for (const release of releases) release();
    await pending;
    expect(client.maxInFlight()).toBe(4);
  });

  test("a collection another client is loading is refused in the preview, with no confirm to offer", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "loading"]);
    expect(preview.refusal).toBe(STILL_LOADING);
    expect(preview.refusal).toBe(
      "This collection is still loading on the server; open the preview again once it reads Loaded.",
    );
    expect(preview.facts[0]).toEqual({ label: "Load state", value: "Loading" });
    expect(methodsOf(client)).not.toContain("loadCollection");
  });

  test("a vector field with no index is refused before any LoadCollection", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "noidx"]);
    expect(preview.refusal).toBe(
      "Vector field vec has no index, and Milvus loads only a collection whose vector fields are all indexed: create the index first; Studio does not create one.",
    );
    expect(preview.facts).toContainEqual({
      label: "Vector field vec",
      value: `${vectorFieldInfos(plainCollection("noidx"))[0].nativeType}, no index`,
    });
    expect(methodsOf(client)).not.toContain("loadCollection");
  });

  test("of two vector fields, the refusal names the one without an index", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "halfidx"]);
    expect(preview.refusal).toStartWith("Vector field b has no index");
  });

  test("an unknown collection or database is refused after exactly one DescribeCollection and no other read", async () => {
    const gone = createFakeMilvusClient(CATALOG);
    await expect(previewMilvusMaintenance(gone, testSurface(), "load", ["default", "gone"])).rejects.toThrow(
      "Collection gone does not exist in database default.",
    );
    expectCalls(gone, [{ method: "describeCollection", args: ["default", { collection_name: "gone" }] }]);
    const nodb = createFakeMilvusClient(CATALOG);
    await expect(previewMilvusMaintenance(nodb, testSurface(), "release", ["nodb", "c"])).rejects.toThrow(
      "Database nodb does not exist.",
    );
    expectCalls(nodb, ["describeCollection"]);
  });

  test("a path that names nothing Milvus could hold is refused with no call", async () => {
    const client = createFakeMilvusClient(CATALOG);
    await expect(previewMilvusMaintenance(client, testSurface(), "load", ["default", "bad name"])).rejects.toThrow(
      "is not a valid Milvus collection name",
    );
    await expect(previewMilvusMaintenance(client, testSurface(), "load", [])).rejects.toThrow("nothing was sent");
    expect(client.calls).toEqual([]);
  });

  test("a one-segment path is read in the connection's database", async () => {
    const client = createFakeMilvusClient(CATALOG);
    await previewMilvusMaintenance(client, testSurface({ database: "probe_db" }), "load", ["notes"]);
    expect(client.calls.every((call) => call.args?.[0] === "probe_db")).toBe(true);
  });

  test("no GetMetrics answer leaves the memory facts out and says why, never a zero", async () => {
    const client = createFakeMilvusClient({ ...CATALOG, metrics: undefined });
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "docs_int64"]);
    expect(preview.facts.map((fact) => fact.label)).toEqual(["Load state", "Rows (estimate)", "Vector field vec"]);
    expect(preview.note).toStartWith("The server reported no query-node memory: ");
    expect(preview.note).toContain("not supported by this server version");
    expect(preview.refusal).toBeUndefined();
  });

  test("a GetMetrics refused for want of a privilege, or unreadable, is said in the note too", async () => {
    const denied = createFakeMilvusClient(CATALOG);
    denied.on("getMetricsSystemInfo", () => permissionDenied("GetMetrics"));
    expect((await previewMilvusMaintenance(denied, testSurface(), "load", ["default", "docs_int64"])).note).toContain(
      "The server reported no query-node memory: The Milvus user lacks the privilege",
    );
    const garbled = createFakeMilvusClient({ ...CATALOG, metrics: "not json" });
    expect((await previewMilvusMaintenance(garbled, testSurface(), "load", ["default", "docs_int64"])).note).toContain(
      "text that is not JSON",
    );
  });

  test("two query nodes are named by id, and the loaded data is their sum", async () => {
    const metrics = JSON.stringify({
      nodes_info: [1, 2].map((id) => ({
        infos: {
          type: "querynode",
          id,
          hardware_infos: { memory: 4294967296, memory_usage: 1073741824 },
          quota_metrics: { LoadedBinlogSize: 1048576 },
        },
      })),
    });
    const client = createFakeMilvusClient({ ...CATALOG, metrics });
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "docs_int64"]);
    expect(preview.facts.slice(3)).toEqual([
      { label: "Query node 1 memory", value: "1.0 GiB used of 4.0 GiB" },
      { label: "Query node 2 memory", value: "1.0 GiB used of 4.0 GiB" },
      { label: "Data loaded on query nodes", value: "2.0 MiB" },
    ]);
  });

  test("a query node that reports no figure adds no fact, and statistics without row_count add no estimate", async () => {
    const client = createFakeMilvusClient({
      ...CATALOG,
      metrics: '{"nodes_info":[{"infos":{"type":"querynode","id":1}}]}',
    });
    client.on("getCollectionStatistics", () => ({ status: OK, stats: [] }));
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "docs_int64"]);
    expect(preview.facts.map((fact) => fact.label)).toEqual(["Load state", "Vector field vec"]);
  });

  test("an index that names no type or metric is said so, never guessed", async () => {
    const client = createFakeMilvusClient({
      databases: {
        default: [{ describe: plainCollection("bare"), indexes: [wireIndex("vec", "X", "Y", { params: [] })] }],
      },
      metrics: SYSTEM_INFO,
    });
    const preview = await previewMilvusMaintenance(client, testSurface(), "load", ["default", "bare"]);
    expect(preview.facts[2].value).toEndWith(", index vec (type not reported, metric not reported), Finished");
  });

  test("any other read that fails is raised", async () => {
    const client = createFakeMilvusClient(CATALOG);
    client.on("getLoadState", () => permissionDenied("GetLoadState"));
    await expect(previewMilvusMaintenance(client, testSurface(), "load", ["default", "docs_int64"])).rejects.toThrow(
      "The Milvus user lacks the privilege",
    );
  });
});

describe("the Release preview", () => {
  test("DescribeCollection, then the load state, with what Release does to every other client", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const preview = await previewMilvusMaintenance(client, testSurface(), "release", ["default", "docs_int64"]);
    expect(preview).toEqual({
      summary: `Release collection docs_int64 of database default from query-node memory. ${RELEASE_DESCRIPTION}`,
      facts: [{ label: "Load state", value: "Loaded" }],
    });
    expectCalls(client, ["describeCollection", "getLoadState"]);
  });

  test("Release is not refused while the collection is loading", async () => {
    const client = createFakeMilvusClient(CATALOG);
    const preview = await previewMilvusMaintenance(client, testSurface(), "release", ["default", "loading"]);
    expect(preview.refusal).toBeUndefined();
    expect(preview.facts).toEqual([{ label: "Load state", value: "Loading" }]);
  });
});

describe("a preview of an operation Milvus does not run", () => {
  test("is refused with no call", async () => {
    const client = createFakeMilvusClient(CATALOG);
    await expect(previewMilvusMaintenance(client, testSurface(), "vacuum", ["default", "docs_int64"])).rejects.toThrow(
      "Milvus runs Load and Release, and not vacuum.",
    );
    expect(client.calls).toEqual([]);
  });
});
