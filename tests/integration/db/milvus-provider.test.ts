/**
 * Milvus provider, end to end over the real adapter.
 *
 * The real adapter (`grpc-client.ts`), the real connect sequence, object surface, monitoring reads, preview, Load and
 * Release and error table all run; only the server is fake. The fake is the recorded transport of
 * `tests/helpers/milvus-wire.ts`, handed to `createGrpcMilvusClient` through the provider constructor's client
 * factory, so every call the composition makes goes through the adapter's request building, status check and error
 * translation. `mock.module()` is not used: it is process-wide in bun and would poison sibling test files.
 *
 * Most answers are built here in the shape Milvus 3.0.2 gives them, from the fixtures of
 * `tests/helpers/milvus-catalog-client.ts`; the last blocks replay answers captured from a server
 * (`tests/fixtures/milvus/`), so the composition also meets bytes a real server sent, the agent read-only profile's
 * boundary among them (`tests/fixtures/milvus/3.0.2/agent-boundary/`).
 *
 * Server: Milvus 3.0.2 standalone (milvusdb/milvus:v3.0.2), the build the captures were taken from.
 * Live check (tests/live/milvus-live-check.ts) against milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0,
 * 2026-10-03: Bun 1.4.2 19/19 passed, Node v24.14.0 19/19, Node v26.10.0 19/19.
 */
import { describe, expect, test } from "bun:test";
import {
  createGrpcMilvusClient,
  type MilvusRpc,
  SYSTEM_INFO_REQUEST,
} from "@/lib/db/providers/vector/milvus/grpc-client";
import { ExecutionProfileError } from "@/lib/db/errors";
import { MilvusError } from "@/lib/db/providers/vector/milvus/client";
import { toMilvusError } from "@/lib/db/providers/vector/milvus/errors";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import type { DescribeCollectionResponse } from "@/lib/db/providers/vector/milvus/client";
import { collectionColumns } from "@/lib/db/providers/vector/milvus/schema";
import { milvusSelectQuery } from "@/lib/db/providers/vector/milvus/generators";
import { milvusSourceParts } from "@/lib/db/providers/vector/milvus/source";
import type { DatabaseConnection } from "@/lib/db/types";
import { DOCS_INT64, DOCS_INT64_INDEX, FTS, SYSTEM_INFO } from "../../helpers/milvus-catalog-client";
import {
  agentMilvusWire,
  MILVUS_AGENT_USERS,
  milvusAgentCapture,
  milvusAgentCaptureNames,
} from "../../helpers/milvus-agent";
import { capturedAnswer, milvusCapture } from "../../helpers/milvus-fixtures";
import { okStatus, type RecordedMilvusAnswer, recordedMilvusWire, statusError } from "../../helpers/milvus-wire";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

const CONNECTION: DatabaseConnection = {
  id: "milvus-integration",
  name: "milvus integration",
  type: "milvus",
  host: "127.0.0.1",
  port: 19530,
  createdAt: new Date(0),
};

type Answers = Partial<Record<MilvusRpc, RecordedMilvusAnswer>>;

/** What a 3.0.2 server holding `default.docs_int64` and `probe_db.notes` answers, each RPC in its own shape. */
function answers(over: Answers = {}): Answers {
  return {
    GetVersion: () => ({ status: okStatus, version: "v3.0.2" }),
    CheckHealth: () => ({ status: okStatus, isHealthy: true, reasons: [], quota_states: [] }),
    ListDatabases: () => ({ status: okStatus, db_names: ["probe_db", "default"], created_timestamp: [], db_ids: [] }),
    ShowCollections: (request) => ({
      status: okStatus,
      collection_names: request.db_name === "probe_db" ? ["notes"] : ["docs_int64"],
      collection_ids: [],
      created_timestamps: [],
      created_utc_timestamps: [],
      inMemory_percentages: [],
      query_service_available: [],
      shards_num: [],
    }),
    DescribeCollection: (request) =>
      request.collection_name === "docs_int64"
        ? DOCS_INT64
        : {
            ...DOCS_INT64,
            schema: null,
            status: { ...okStatus, code: 100, error_code: "CollectionNotExists", reason: "collection not found" },
          },
    BatchDescribeCollection: (request) => ({
      status: okStatus,
      responses: (request.collection_name as readonly string[]).map(() => DOCS_INT64),
    }),
    DescribeIndex: () => ({ status: okStatus, index_descriptions: [DOCS_INT64_INDEX] }),
    GetLoadState: () => ({ status: okStatus, state: "LoadStateLoaded" }),
    GetLoadingProgress: () => ({ status: okStatus, progress: "100", refresh_progress: "100" }),
    GetCollectionStatistics: () => ({ status: okStatus, stats: [{ key: "row_count", value: "2000" }] }),
    ShowPartitions: () => ({
      status: okStatus,
      partition_names: ["_default"],
      partitionIDs: [],
      created_timestamps: [],
      created_utc_timestamps: [],
      inMemory_percentages: [],
    }),
    ListAliases: () => ({ status: okStatus, db_name: "default", collection_name: "docs_int64", aliases: [] }),
    GetMetrics: () => ({ status: okStatus, response: SYSTEM_INFO, component_name: "proxy1" }),
    LoadCollection: () => okStatus,
    ReleaseCollection: () => okStatus,
    ...over,
  };
}

async function connected(over: Answers = {}, connection: DatabaseConnection = CONNECTION) {
  const wire = recordedMilvusWire(answers(over));
  const provider = new MilvusProvider(connection, { queryTimeout: 5_000 }, {}, (options) =>
    createGrpcMilvusClient(options, wire.transport),
  );
  await provider.connect();
  return { provider, wire };
}

const rpcs = (wire: { calls: readonly { method: string }[] }) => wire.calls.map((call) => call.method);
const requestOf = (wire: { calls: readonly { method: string; args?: readonly unknown[] }[] }, rpc: string) =>
  wire.calls.filter((call) => call.method === rpc).map((call) => call.args?.[0]);
const failure = (pending: Promise<unknown>): Promise<Error> =>
  pending.then(
    () => {
      throw new Error("it succeeded");
    },
    (error: unknown) => error as Error,
  );

describe("connect, on one channel", () => {
  test("one channel, GetVersion and nothing else; disconnect closes it", async () => {
    const { provider, wire } = await connected();
    expect(wire.opened).toHaveLength(1);
    expect(rpcs(wire)).toEqual(["GetVersion"]);
    await provider.disconnect();
    expect(wire.closes()).toBe(1);
  });

  test("a GetVersion the server refuses with UNAUTHENTICATED fails the connect in Studio's words and closes the channel", async () => {
    const wire = recordedMilvusWire(
      answers({
        GetVersion: () => {
          throw statusError(16, "auth check failure, please check username and password are correct");
        },
      }),
    );
    const provider = new MilvusProvider(CONNECTION, {}, {}, (options) =>
      createGrpcMilvusClient(options, wire.transport),
    );
    const error = await failure(provider.connect());
    expect(error.message).toStartWith("Milvus refused the user name or password (or token).");
    expect(wire.closes()).toBe(1);
  });
});

describe("the object surface over the adapter", () => {
  test("a dynamic collection exposes $meta for Generate Command even when DescribeCollection omits it (#1417)", async () => {
    const schema = DOCS_INT64.schema!;
    const described = {
      ...DOCS_INT64,
      schema: {
        ...schema,
        fields: schema.fields.filter((field) => field.name !== "$meta"),
        enable_dynamic_field: true,
      },
    };
    const { provider } = await connected({
      DescribeCollection: () => described,
      BatchDescribeCollection: () => ({ status: okStatus, responses: [described] }),
    });
    const detail = await provider.describeObject(["default", "docs_int64"], "collection");
    expect(detail.columns?.filter((column) => column.name === "$meta")).toEqual([
      { name: "$meta", type: "JSON (dynamic)", nullable: true, isPrimary: false },
    ]);
    const batch = await provider.describeObjects(["default"], "collection");
    expect(batch.details[0].columns).toEqual(detail.columns);
    const command = milvusSelectQuery(["default", "docs_int64"], detail.columns!);
    expect(command).toContain('"maybe_count", "$meta"]');
    await provider.disconnect();
  });

  test("the tree: the databases, then one ShowCollections that carries its database", async () => {
    const { provider, wire } = await connected();
    expect((await provider.listContainers()).map((container) => container.name)).toEqual(["default", "probe_db"]);
    expect(await provider.countObjects(["probe_db"])).toEqual({ collection: { count: 1 } });
    expect(await provider.listObjects(["default"], "collection")).toEqual([
      { path: ["default", "docs_int64"], name: "docs_int64", kind: "collection" },
    ]);
    expect(requestOf(wire, "ShowCollections")).toEqual([{ db_name: "probe_db" }, { db_name: "default" }]);
  });

  test("a collection opened: DescribeCollection and DescribeIndex name the collection and its database", async () => {
    const { provider, wire } = await connected();
    const detail = await provider.describeObject(["default", "docs_int64"], "collection");
    expect(detail.columns).toEqual(collectionColumns(DOCS_INT64));
    expect(detail.indexes).toEqual([{ name: "vec", columns: ["vec"], unique: false }]);
    expect(requestOf(wire, "DescribeCollection")).toEqual([{ collection_name: "docs_int64", db_name: "default" }]);
    expect(requestOf(wire, "DescribeIndex")).toEqual([{ collection_name: "docs_int64", db_name: "default" }]);
  });

  test("the bulk describe is one BatchDescribeCollection for the listed names", async () => {
    const { provider, wire } = await connected();
    const batch = await provider.describeObjects(["default"], "collection");
    expect(batch.details.map((detail) => detail.path)).toEqual([["default", "docs_int64"]]);
    expect(requestOf(wire, "BatchDescribeCollection")).toEqual([
      { collection_name: ["docs_int64"], db_name: "default" },
    ]);
  });

  test("the Source's two parts are source.ts's over the adapter's answers", async () => {
    const { provider } = await connected();
    const document = await provider.readObjectSource(["default", "docs_int64"], "collection");
    expect(document.parts).toEqual(
      milvusSourceParts({
        describe: DOCS_INT64,
        indexes: [DOCS_INT64_INDEX],
        loadState: "LoadStateLoaded",
        rowCount: "2000",
        partitions: ["_default"],
        aliases: [],
        secretForms: [],
      }),
    );
  });

  test("a collection that is not there is the adapter's status, worded by the error table", async () => {
    const { provider } = await connected();
    const error = await failure(provider.describeObject(["default", "gone"], "collection"));
    expect(error.message).toStartWith("Collection gone does not exist in database default.");
  });

  test("two databases at once: each ShowCollections carries its own db_name", async () => {
    const { provider, wire } = await connected();
    const [left, right] = await Promise.all([
      provider.listObjects(["default"], "collection"),
      provider.listObjects(["probe_db"], "collection"),
    ]);
    expect(left.map((object) => object.name)).toEqual(["docs_int64"]);
    expect(right.map((object) => object.name)).toEqual(["notes"]);
    expect(requestOf(wire, "ShowCollections")).toContainEqual({ db_name: "default" });
    expect(requestOf(wire, "ShowCollections")).toContainEqual({ db_name: "probe_db" });
  });

  test("the object surface meets the fleet's contract", async () => {
    const byName: Record<string, DescribeCollectionResponse> = { docs_int64: DOCS_INT64, fts: FTS };
    const notFound = {
      ...DOCS_INT64,
      schema: null,
      status: { ...okStatus, code: 100, error_code: "CollectionNotExists", reason: "collection not found" },
    };
    const { provider } = await connected({
      ShowCollections: (request) => ({
        status: okStatus,
        collection_names: request.db_name === "probe_db" ? ["notes"] : ["docs_int64", "fts"],
        collection_ids: [],
        created_timestamps: [],
        created_utc_timestamps: [],
        inMemory_percentages: [],
        query_service_available: [],
        shards_num: [],
      }),
      DescribeCollection: (request) => byName[request.collection_name as string] ?? notFound,
      BatchDescribeCollection: (request) => ({
        status: okStatus,
        responses: (request.collection_name as readonly string[]).map((name) => byName[name] ?? notFound),
      }),
    });
    await assertObjectSurface(provider, {
      containers: [["default"], ["probe_db"]],
      container: ["default"],
      kinds: { collection: 2 },
      sampleObject: { path: ["default", "docs_int64"], kind: "collection" },
      absentSource: { path: ["default", "no_such_collection"], kind: "collection" },
      noAbstainingKinds: true,
    });
    await provider.disconnect();
  });
});

describe("monitoring over the adapter", () => {
  test("health, the overview, the tables and the indexes", async () => {
    const { provider, wire } = await connected();
    await provider.getHealth();
    expect((await provider.getOverview()).version).toBe("v3.0.2");
    expect(await provider.getTableStats()).toEqual([
      { schemaName: "default", tableName: "docs_int64", rowCount: 2000, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
    expect((await provider.getIndexStats()).map((row) => [row.indexName, row.indexType])).toEqual([["vec", "HNSW"]]);
    expect(rpcs(wire)).toContain("CheckHealth");
    expect(rpcs(wire)).not.toContain("GetMetrics");
  });
});

describe("Load and Release over the adapter", () => {
  test("the preview: DescribeCollection first, then the four reads, GetMetrics with its one fixed request", async () => {
    const { provider, wire } = await connected();
    wire.calls.length = 0;
    const preview = await provider.previewMaintenance("load", ["default", "docs_int64"]);
    expect(rpcs(wire)[0]).toBe("DescribeCollection");
    expect(rpcs(wire).slice(1).sort()).toEqual([
      "DescribeIndex",
      "GetCollectionStatistics",
      "GetLoadState",
      "GetMetrics",
    ]);
    expect(requestOf(wire, "GetMetrics")).toEqual([{ request: SYSTEM_INFO_REQUEST }]);
    expect(preview.facts).toContainEqual({ label: "Query-node memory", value: "925.0 MiB used of 4.0 GiB" });
    expect(preview.refusal).toBeUndefined();
  });

  test("Load: the load state, LoadCollection, then the progress", async () => {
    const { provider, wire } = await connected();
    wire.calls.length = 0;
    const result = await provider.runMaintenance("load", "docs_int64", "default");
    expect(result.message).toStartWith("Loaded:");
    expect(rpcs(wire)).toEqual(["GetLoadState", "LoadCollection", "GetLoadingProgress"]);
    expect(requestOf(wire, "LoadCollection")).toEqual([{ collection_name: "docs_int64", db_name: "default" }]);
  });

  test("a LoadCollection whose answer is lost is sent once and reads 'may have been applied'; the next Load is not blocked", async () => {
    let lost = true;
    const { provider, wire } = await connected({
      LoadCollection: () => {
        if (lost) throw statusError(14, "Connection dropped");
        return okStatus;
      },
    });
    const error = await failure(provider.runMaintenance("load", "docs_int64", "default"));
    expect(error.message).toContain("It may have been applied");
    expect(requestOf(wire, "LoadCollection")).toHaveLength(1);
    lost = false;
    expect((await provider.runMaintenance("load", "docs_int64", "default")).message).toStartWith("Loaded:");
  });

  test("Release: one ReleaseCollection", async () => {
    const { provider, wire } = await connected();
    wire.calls.length = 0;
    await provider.runMaintenance("release", "docs_int64", "default");
    expect(rpcs(wire)).toEqual(["ReleaseCollection"]);
    expect(requestOf(wire, "ReleaseCollection")).toEqual([{ collection_name: "docs_int64", db_name: "default" }]);
  });

  test("a read-only connection sends neither, and a session of reads sends no load at all", async () => {
    const { provider, wire } = await connected({}, { ...CONNECTION, readOnly: true });
    await failure(provider.runMaintenance("load", "docs_int64", "default"));
    await failure(provider.runMaintenance("release", "docs_int64", "default"));
    await provider.listContainers();
    await provider.describeObject(["default", "docs_int64"], "collection");
    await provider.describeObjects(["default"], "collection");
    await provider.readObjectSource(["default", "docs_int64"], "collection");
    await provider.getMonitoringData();
    // The preview of a run the mode refuses is refused with it, and reads nothing (#1418).
    await failure(provider.previewMaintenance("load", ["default", "docs_int64"]));
    for (const never of ["LoadCollection", "ReleaseCollection", "GetLoadingProgress"])
      expect(rpcs(wire)).not.toContain(never);
  });
});

describe("answers captured from Milvus 3.0.2, replayed through the adapter", () => {
  test("the captured GetVersion is the version the overview reports", async () => {
    const { provider } = await connected({
      GetVersion: () => capturedAnswer(milvusCapture("milvus/get-version-root")),
    });
    expect((await provider.getOverview()).version).toContain("3.0.2");
  });

  test("the captured DescribeCollection of docs_int64 is described column for column, with no default value", async () => {
    const captured = capturedAnswer(milvusCapture("milvus/describe-collection-default-docs_int64"));
    const { provider } = await connected({ DescribeCollection: () => captured });
    const detail = await provider.describeObject(["default", "docs_int64"], "collection");
    expect(detail.columns.length).toBeGreaterThan(0);
    expect(detail.columns).toEqual(collectionColumns(captured as DescribeCollectionResponse));
    expect(detail.columns.every((column) => column.defaultValue === undefined)).toBe(true);
  });
});

/**
 * The agent boundary, replayed from 3.0.2's answers: every write a read-only principal sent past Studio, with no
 * client admission in front of it, classified as an authorization refusal with the state root reads unchanged; the
 * same writes from the principals that may write, landing; and the read-only proof's verdict on every principal.
 */
describe("the agent read-only boundary, replayed from what 3.0.2 answered", () => {
  const READ_ONLY = ["reader", "dbro", "custom", "clusterro", "nobody", "midrun"];
  const WRITERS = ["rw", "admin", "root", "open-reader", "open-anonymous"];
  const writes = [
    ...new Set(
      milvusAgentCaptureNames()
        .filter((name) => name.startsWith("write-") && name.endsWith("-reader") && !name.endsWith("-open-reader"))
        .map((name) => name.slice(0, -"-reader".length)),
    ),
  ];

  test("every write, Load, Release, Flush, compaction and import is captured for every read-only principal", () => {
    expect(writes.sort()).toEqual([
      "write-compact",
      "write-create-alias",
      "write-create-collection",
      "write-create-credential",
      "write-create-database",
      "write-create-index",
      "write-create-partition",
      "write-delete-none",
      "write-drop-missing-alias",
      "write-drop-missing-collection",
      "write-flush",
      "write-grant-self",
      "write-import",
      "write-insert",
      "write-load",
      "write-release",
      "write-upsert",
    ]);
  });

  test.each(READ_ONLY)("every write from %s is refused PERMISSION_DENIED, an authorization refusal", (principal) => {
    for (const write of writes) {
      const capture = milvusAgentCapture(write, principal);
      expect({ write, outcome: capture.outcome }).toEqual({ write, outcome: "fail" });
      const error = (capture.payload as { error: { code: number; details: string } }).error;
      const classified = toMilvusError(
        Object.assign(new Error(error.details), error, { metadata: {} }),
        new AbortController().signal,
      );
      expect({ write, category: (classified as MilvusError).category }).toEqual({
        write,
        category: "permission-denied",
      });
    }
  });

  test("the state root reads is the same before and after every refused write", () => {
    for (const surface of ["count", "collections", "aliases", "partitions", "databases", "load", "indexes"]) {
      const strip = (payload: unknown) =>
        JSON.stringify(payload, (key, value) =>
          key === "session_ts" ||
          key.endsWith("timestamps") ||
          key.endsWith("timestamp") ||
          key.endsWith("_ids") ||
          key === "partitionIDs" ||
          key === "collection_ids" ||
          key === "db_ids" ||
          key === "indexID"
            ? undefined
            : value,
        );
      const before = JSON.parse(strip(milvusAgentCapture(`state-before-${surface}`, "root").payload));
      const after = JSON.parse(strip(milvusAgentCapture(`state-after-refused-${surface}`, "root").payload));
      const sortLists = (value: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(value).map(([key, inner]) => [
            key,
            Array.isArray(inner) && inner.every((item) => typeof item === "string") ? [...inner].sort() : inner,
          ]),
        );
      expect({ surface, state: sortLists(after) }).toEqual({ surface, state: sortLists(before) });
    }
  });

  test("the positive controls: the same Insert, alias, partition and database land for a principal that may write", () => {
    for (const principal of WRITERS) {
      for (const write of [
        "write-insert",
        "write-create-partition",
        "write-create-database",
        "write-load",
        "write-release",
      ]) {
        expect({ principal, write, outcome: milvusAgentCapture(write, principal).outcome }).toEqual({
          principal,
          write,
          outcome: principal === "rw" && write === "write-create-database" ? "fail" : "pass",
        });
      }
    }
    expect(milvusAgentCapture("state-after-writable-count", "root").payload).toMatchObject({
      fields_data: [{ scalars: { long_data: { data: ["5"] } } }],
    });
    expect(milvusAgentCapture("write-insert-after-grant", "midrun").outcome).toBe("pass");
  });

  test.each([
    ["reader", "proved"],
    ["dbro", "proved"],
    ["nobody", "proved"],
    ["midrun", "proved"],
    ["custom", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["clusterro", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["rw", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["elsewhere", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["rwother", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["admin", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["root", "PROFILE_PRIVILEGES_TOO_BROAD"],
    ["open-reader", "PROFILE_SERVER_UNENFORCED"],
  ])("the proof's verdict on %s, at the open: %s", async (principal, verdict) => {
    const wire = agentMilvusWire(principal);
    const provider = new MilvusProvider(
      { ...CONNECTION, user: MILVUS_AGENT_USERS[principal], password: "not-a-real-password" },
      {},
      { readOnly: true, sendsStatements: true },
      (options) => createGrpcMilvusClient(options, wire.transport),
    );
    const outcome = await provider.connect().then(
      () => "proved",
      (error: unknown) => (error instanceof ExecutionProfileError ? error.reasonCode : error),
    );
    expect(outcome).toBe(verdict);
  });
});
