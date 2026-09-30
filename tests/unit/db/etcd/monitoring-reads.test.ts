/**
 * The reads of spec 7.1, through the shared fake client (plan Contract C12): which calls each surface
 * sends, in which order and with which request; how a lost quorum and a raised alarm fail getHealth;
 * the overview's exact key count as root and its scoped floor as a user who is not root; and the
 * Tables panel's per-group counts over each group's readable intersection with KE2's reads in flight
 * at most, over a very flat and a very large key space (plan Review Focus 4).
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { EtcdByteRange, EtcdMember, EtcdRangeResponse, EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { type EtcdErrorConnection, toEtcdError } from "@/lib/db/providers/keyvalue/etcd/errors";
import {
  ETCD_TABLE_STATS_CONCURRENCY,
  readEtcdHealth,
  readEtcdOverview,
  readEtcdStorageStats,
  readEtcdTableStats,
} from "@/lib/db/providers/keyvalue/etcd/monitoring-reads";
import type { EtcdSurfaceContext } from "@/lib/db/providers/keyvalue/etcd/objects";
import { clipToScope, describeRange, describeScope } from "@/lib/db/providers/keyvalue/etcd/permissions";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const encoder = new TextEncoder();
const b = (text: string): Uint8Array => encoder.encode(text);
const decoder = new TextDecoder();
const text = (bytes: Uint8Array): string => decoder.decode(bytes);

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** A user who is not root, signed in with a password (spec 4.7). */
const READER = { name: "reader", via: "password" } as const;

/** Root, or auth off: every key readable and writable, read-write, and a clock that stands still. */
function surface(over: Partial<EtcdSurfaceContext> = {}): EtcdSurfaceContext {
  return {
    readable: { kind: "all" },
    writable: { kind: "all" },
    signal: new AbortController().signal,
    now: () => 1_000,
    errors: CONNECTION,
    ...over,
  };
}

/** Two member ids past 2^53, as etcd answers them: decimal strings (spec 4.1). */
const ETCD_1 = "10276657743932975437";
const ETCD_2 = "12345678901234567890";

function status(over: Partial<EtcdStatus> = {}): EtcdStatus {
  return {
    header: { clusterId: "14841639068965178418", memberId: ETCD_1, revision: "4242", raftTerm: "3" },
    version: "3.7.2",
    dbSize: "1288490189",
    dbSizeInUse: "325058560",
    dbSizeQuota: "2147483648",
    leader: ETCD_1,
    raftIndex: "5000",
    raftTerm: "3",
    raftAppliedIndex: "5000",
    errors: [],
    isLearner: false,
    storageVersion: "3.7.0",
    ...over,
  };
}

const MEMBERS: readonly EtcdMember[] = [
  {
    id: ETCD_1,
    name: "etcd-1",
    peerUrls: ["http://etcd-1:2380"],
    clientUrls: ["http://etcd-1:2379"],
    isLearner: false,
  },
  {
    id: ETCD_2,
    name: "etcd-2",
    peerUrls: ["http://etcd-2:2380"],
    clientUrls: ["http://etcd-2:2379"],
    isLearner: false,
  },
];

/** A count_only answer: no key back, and the count of the whole range. */
function counted(count: string): EtcdRangeResponse {
  return { header: status().header, kvs: [], more: false, count };
}

/** A grpc-js ServiceError, as the adapter hands it to toEtcdError (plan C5). */
function grpc(code: number, details: string): Error {
  return Object.assign(new Error(`${code} STATUS: ${details}`), { code, details, metadata: {} });
}

/** The reader's grants of the etcd-auth fixture (spec 9): READ on the prefix /app/ and on the single key /config/a. */
const READABLE = {
  kind: "ranges",
  ranges: [{ key: b("/app/"), rangeEnd: b("/app0") }, { key: b("/config/a") }],
} as const;

/** A group's prefix range, as the walk records it (spec 4.1): the prefix, to the prefix with its last byte raised. */
const prefixRange = (prefix: string): EtcdByteRange => ({ key: b(prefix), rangeEnd: b(`${prefix.slice(0, -1)}0`) });

describe("readEtcdHealth (spec 7.1)", () => {
  test("a member with a leader and no alarm: its size on disk, N/A for the cache ratio, and no connection count", async () => {
    const client = createFakeEtcdClient({ status: async () => status(), alarmList: async () => [] });
    const health = await readEtcdHealth(client, surface());
    expect(health).toEqual({
      databaseSize: "1.2 GiB on disk, the answering member",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect("activeConnections" in health).toBe(false);
    expect(client.calls.map((call) => call.method)).toEqual(["status", "alarmList"]);
  });

  test("a Status.leader of 0 is 5.6's lost quorum, carrying Status.errors in etcd's words, before any Alarm GET", async () => {
    const client = createFakeEtcdClient({
      status: async () =>
        status({ leader: "0", errors: ["etcdserver: no leader", `memberID:${ETCD_1} alarm:NOSPACE`] }),
      alarmList: async () => [],
    });
    const attempt = readEtcdHealth(client, surface());
    await expect(attempt).rejects.toThrow(ConnectionError);
    await expect(attempt).rejects.toThrow("lost quorum");
    await expect(attempt).rejects.toThrow(`(etcd: no leader; memberID:${ETCD_1} alarm:NOSPACE)`);
    expect(client.calls.map((call) => call.method)).toEqual(["status"]);
  });

  test("an alarm raised on any member is raised, naming every alarm, since HealthInfo has no field for one", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(),
      alarmList: async () => [
        { memberId: ETCD_2, alarm: "nospace" },
        { memberId: ETCD_1, alarm: "corrupt" },
      ],
    });
    const attempt = readEtcdHealth(client, surface());
    await expect(attempt).rejects.toThrow(QueryError);
    await expect(attempt).rejects.toThrow(
      "etcd reports active alarms: NOSPACE on member ab54a98ceb1f0ad2, CORRUPT on member 8e9e05c52164694d. A cluster with an active alarm is not healthy",
    );
  });

  test("a failed Status read and a failed Alarm GET each raise 5.6's mapped error", async () => {
    const late = createFakeEtcdClient({
      status: async () => {
        throw toEtcdError(grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:2379"));
      },
    });
    await expect(readEtcdHealth(late, surface())).rejects.toThrow(TimeoutError);
    const noLeader = createFakeEtcdClient({
      status: async () => status(),
      alarmList: async () => {
        throw toEtcdError(grpc(14, "etcdserver: no leader"));
      },
    });
    await expect(readEtcdHealth(noLeader, surface())).rejects.toThrow(ConnectionError);
  });
});

describe("readEtcdOverview (spec 7.1)", () => {
  test("as root: Status, a serializable MemberList, and one count_only over the whole key space", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(),
      memberList: async () => ({ header: status().header, members: MEMBERS }),
      range: async () => counted("48213"),
    });
    expect(await readEtcdOverview(client, surface())).toEqual({
      version: "3.7.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "1.2 GiB on disk, the answering member etcd-1 (8e9e05c52164694d)",
      databaseSizeBytes: 1288490189,
      tableCount: 48213,
      indexCount: 0,
    });
    expect(client.calls).toEqual([
      { method: "status", args: [{ signal: expect.any(AbortSignal) }] },
      { method: "memberList", args: [{ linearizable: false }, { signal: expect.any(AbortSignal) }] },
      {
        method: "range",
        args: [
          { key: new Uint8Array([0]), rangeEnd: new Uint8Array([0]), limit: 1, countOnly: true },
          { signal: expect.any(AbortSignal) },
        ],
      },
    ]);
  });

  test("as a user who is not root: one count_only per readable range, summed, and the floor names its scope (spec 4.7)", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(),
      memberList: async () => ({ header: status().header, members: MEMBERS }),
      range: async (request) => counted(text(request.key) === "/app/" ? "3" : "1"),
    });
    const overview = await readEtcdOverview(
      client,
      surface({ principal: READER, readable: READABLE, writable: READABLE }),
    );
    expect(overview).toMatchObject({
      tableCount: 4,
      tableCountSampledFrom: `the ranges etcd user reader may read: ${describeScope(READABLE)}`,
    });
    expect(client.calls.filter((call) => call.method === "range").map((call) => call.args[0])).toEqual([
      { key: b("/app/"), rangeEnd: b("/app0"), limit: 1, countOnly: true },
      { key: b("/config/a"), limit: 1, countOnly: true },
    ]);
  });

  test("the count is linearizable, so during a quorum loss it fails at once as the lost quorum", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(),
      memberList: async () => ({ header: status().header, members: MEMBERS }),
      range: async () => {
        throw toEtcdError(grpc(14, "etcdserver: no leader"));
      },
    });
    await expect(readEtcdOverview(client, surface())).rejects.toThrow(ConnectionError);
  });

  test("a context scoped to grants but carrying no principal is a composition defect, raised before any read", async () => {
    const client = createFakeEtcdClient();
    await expect(readEtcdOverview(client, surface({ readable: READABLE }))).rejects.toThrow("carries no principal");
    expect(client.calls).toEqual([]);
  });
});

describe("readEtcdStorageStats (spec 7.1)", () => {
  test("one row for the answering member, from one Status read", async () => {
    const client = createFakeEtcdClient({
      status: async () => status({ dbSize: "536870912", dbSizeInUse: "268435456" }),
    });
    expect(await readEtcdStorageStats(client, surface())).toEqual([
      {
        name: "member 8e9e05c52164694d",
        location: "the member this connection reaches",
        size: "512 MiB on disk, 256 MiB in use",
        sizeBytes: 536870912,
        usagePercent: 25,
      },
    ]);
    expect(client.calls.map((call) => call.method)).toEqual(["status"]);
  });
});

describe("readEtcdTableStats (spec 7.1, 4.7)", () => {
  test("as root: one count_only per group over its prefix range, each row named as the tree names the group", async () => {
    const client = createFakeEtcdClient({
      range: async (request) => counted(text(request.key) === "/apisix/routes/" ? "12" : "1"),
    });
    const rows = await readEtcdTableStats(client, surface(), ["/apisix/routes/", "config/app/", "/a-flat/"]);
    expect(rows).toEqual([
      { schemaName: "", tableName: "/apisix/routes/*", rowCount: 12, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "", tableName: "config/app/*", rowCount: 1, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "", tableName: "/a-flat/*", rowCount: 1, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
    expect(client.calls.map((call) => call.args[0])).toEqual([
      { ...prefixRange("/apisix/routes/"), limit: 1, countOnly: true },
      { ...prefixRange("config/app/"), limit: 1, countOnly: true },
      { ...prefixRange("/a-flat/"), limit: 1, countOnly: true },
    ]);
  });

  test("as the reader: each group counted over its readable intersection, one count_only per piece (spec 4.7)", async () => {
    const client = createFakeEtcdClient({ range: async () => counted("1") });
    const prefixes = ["/app/a/", "/app/x/", "/config/"];
    const rows = await readEtcdTableStats(
      client,
      surface({ principal: READER, readable: READABLE, writable: READABLE }),
      prefixes,
    );
    expect(rows.map((row) => [row.tableName, row.rowCount])).toEqual([
      ["/app/a/*", 1],
      ["/app/x/*", 1],
      ["/config/*", 1],
    ]);
    const pieces = prefixes.flatMap((prefix) => clipToScope(prefixRange(prefix), READABLE));
    expect(pieces).toHaveLength(3);
    expect(client.calls.map((call) => call.args[0])).toEqual(
      // oxlint-disable-next-line no-map-spread -- each expected request is a new object, compared by value with the one sent.
      pieces.map((piece) => ({ ...piece, limit: 1, countOnly: true })),
    );
  });

  test("a group met by two readable pieces is one row whose count is the sum of its pieces", async () => {
    const scope = {
      kind: "ranges",
      ranges: [{ key: b("/app/a/"), rangeEnd: b("/app/a0") }, { key: b("/app/cfg") }],
    } as const;
    const client = createFakeEtcdClient({
      range: async (request) => counted(text(request.key) === "/app/a/" ? "3" : "1"),
    });
    const rows = await readEtcdTableStats(client, surface({ principal: READER, readable: scope, writable: scope }), [
      "/app/",
    ]);
    expect(clipToScope(prefixRange("/app/"), scope)).toHaveLength(2);
    expect(rows).toEqual([{ schemaName: "", tableName: "/app/*", rowCount: 4, totalSize: "N/A", totalSizeBytes: 0 }]);
  });

  test("as the reader, a refused count names every range that user may read (spec 5.6)", async () => {
    const client = createFakeEtcdClient({
      range: async () => {
        throw toEtcdError(grpc(7, "etcdserver: permission denied"));
      },
    });
    await expect(
      readEtcdTableStats(client, surface({ principal: READER, readable: READABLE, writable: READABLE }), ["/app/"]),
    ).rejects.toThrow(`etcd user reader may read: ${describeScope(READABLE)}.`);
  });

  test("a prefix that does not end in / names no group the walk listed: raised before any read", async () => {
    const client = createFakeEtcdClient();
    await expect(readEtcdTableStats(client, surface(), ["/apisix/routes/", "/apisix/routes"])).rejects.toThrow(
      QueryError,
    );
    expect(client.calls).toEqual([]);
  });

  test("after the first failed count no further count starts, and the failure is raised naming the group", async () => {
    const prefixes = Array.from({ length: ETCD_TABLE_STATS_CONCURRENCY + 12 }, (_, at) => `/g${at}/`);
    const client = createFakeEtcdClient({
      range: async (request) => {
        if (text(request.key) === "/g0/") throw toEtcdError(grpc(7, "etcdserver: permission denied"));
        await Promise.resolve();
        return counted("1");
      },
    });
    await expect(readEtcdTableStats(client, surface(), prefixes)).rejects.toThrow(
      "etcd refused the key count on /g0/*",
    );
    expect(client.calls).toHaveLength(ETCD_TABLE_STATS_CONCURRENCY);
  });
});

describe("a very flat or very large key space (plan Review Focus 4)", () => {
  test("the overview counts 200,000 keys, or a Kubernetes store's tens of thousands, with one count_only and no walk", async () => {
    for (const count of ["200000", "48213"]) {
      const client = createFakeEtcdClient({
        status: async () => status(),
        memberList: async () => ({ header: status().header, members: MEMBERS }),
        range: async () => counted(count),
      });
      // oxlint-disable-next-line no-await-in-loop -- one overview per key space in turn, each with its own fake client.
      expect((await readEtcdOverview(client, surface())).tableCount).toBe(Number(count));
      expect(client.calls.filter((call) => call.method === "range")).toHaveLength(1);
    }
  });

  test("1,000 groups, one holding most keys, are each counted once and exactly, KE2's reads in flight at most", async () => {
    const prefixes = Array.from({ length: 1_000 }, (_, at) => `/group-${String(at).padStart(4, "0")}/`);
    let inFlight = 0;
    let peak = 0;
    const client = createFakeEtcdClient({
      range: async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return counted(text(request.key) === "/group-0000/" ? "199000" : "1");
      },
    });
    const rows = await readEtcdTableStats(client, surface(), prefixes);
    expect(peak).toBe(ETCD_TABLE_STATS_CONCURRENCY);
    expect(client.calls).toHaveLength(1_000);
    expect(rows).toHaveLength(1_000);
    expect(rows[0]).toEqual({
      schemaName: "",
      tableName: "/group-0000/*",
      rowCount: 199_000,
      totalSize: "N/A",
      totalSizeBytes: 0,
    });
    expect(rows.slice(1).every((row) => row.rowCount === 1)).toBe(true);
    expect(new Set(rows.map((row) => row.tableName)).size).toBe(1_000);
  });

  test("a first segment of 200,000 two-segment keys sorting ahead of the others is one group, counted in one read", async () => {
    const client = createFakeEtcdClient({
      range: async (request) => counted(text(request.key) === "/a-flat/" ? "200000" : "7"),
    });
    const rows = await readEtcdTableStats(client, surface(), ["/a-flat/", "/b/x/", "/c/"]);
    expect(rows.map((row) => [row.tableName, row.rowCount])).toEqual([
      ["/a-flat/*", 200_000],
      ["/b/x/*", 7],
      ["/c/*", 7],
    ]);
    expect(client.calls).toHaveLength(3);
    expect(describeRange(prefixRange("/a-flat/"))).not.toBe("");
  });
});
