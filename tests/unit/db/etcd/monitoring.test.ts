/**
 * The pure monitoring mappings (spec 7.1), from fixed `Status`, `MemberList` and `Alarm` answers: the
 * figures etcd reports, the words for what it does not, and the member and alarm namers the
 * maintenance messages of 7.2 share.
 */
import { describe, expect, test } from "bun:test";
import type { EtcdMember, EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { memberHexId } from "@/lib/db/providers/keyvalue/etcd/keys";
import {
  describeAlarm,
  ETCD_DEFAULT_QUOTA_BYTES,
  formatEtcdBytes,
  memberLabel,
  toHealthInfo,
  toOverview,
  toStorageStats,
  toTableStats,
} from "@/lib/db/providers/keyvalue/etcd/monitoring";

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
  { id: ETCD_2, name: "", peerUrls: ["http://etcd-2:2380"], clientUrls: [], isLearner: true },
];

describe("the namers the monitoring and maintenance messages share (spec 4.1, 7.2)", () => {
  test("the fixture's ids print as etcdctl prints a member id, unpadded lowercase hex", () => {
    expect([memberHexId(ETCD_1), memberHexId(ETCD_2)]).toEqual(["8e9e05c52164694d", "ab54a98ceb1f0ad2"]);
  });

  test.each([
    ["0", "0 bytes"],
    ["512", "512 bytes"],
    ["1023", "1,023 bytes"],
    ["1024", "1 KiB"],
    ["1536", "1.5 KiB"],
    ["325058560", "310 MiB"],
    ["1288490189", "1.2 GiB"],
    ["1152921504606846976", "1,024 PiB"],
  ])("formatEtcdBytes(%s) is %s", (bytes, text) => {
    expect(formatEtcdBytes(bytes)).toBe(text);
  });

  test("a member is named as the tree names it, and by its id alone when it has no name or is not listed", () => {
    expect(memberLabel(ETCD_1, MEMBERS)).toBe("etcd-1 (8e9e05c52164694d)");
    expect(memberLabel(ETCD_2, MEMBERS)).toBe("ab54a98ceb1f0ad2");
    expect(memberLabel("255", MEMBERS)).toBe("ff");
  });

  test("an alarm is its type as etcd prints it, on its member's hex id", () => {
    expect(describeAlarm({ memberId: ETCD_1, alarm: "nospace" })).toBe("NOSPACE on member 8e9e05c52164694d");
    expect(describeAlarm({ memberId: ETCD_2, alarm: "corrupt" })).toBe("CORRUPT on member ab54a98ceb1f0ad2");
  });
});

describe("toHealthInfo (spec 7.1)", () => {
  test("the answering member's size on disk, N/A for the cache ratio, empty lists, and no connection count", () => {
    const health = toHealthInfo(status());
    expect(health).toEqual({
      databaseSize: "1.2 GiB on disk, the answering member",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect("activeConnections" in health).toBe(false);
  });
});

describe("toOverview (spec 7.1)", () => {
  test("as root: the version, the exact key count, the answering member named, and no floor", () => {
    const overview = toOverview({ status: status(), members: MEMBERS, keyCount: "48213" });
    expect(overview).toEqual({
      version: "3.7.2",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "1.2 GiB on disk, the answering member etcd-1 (8e9e05c52164694d)",
      databaseSizeBytes: 1288490189,
      tableCount: 48213,
      indexCount: 0,
    });
    expect("tableCountSampledFrom" in overview).toBe(false);
  });

  test("as a user who is not root: the count is a floor, and its scope is named beside it (spec 4.7)", () => {
    const scope = "the ranges etcd user reader may read: /app/ (prefix), /config/a";
    expect(toOverview({ status: status(), members: MEMBERS, keyCount: "2", countScope: scope })).toMatchObject({
      tableCount: 2,
      tableCountSampledFrom: scope,
    });
  });

  test("an answering member the list does not hold is named by its id", () => {
    const answering = status({ header: { clusterId: "1", memberId: "255", revision: "1", raftTerm: "1" } });
    expect(toOverview({ status: answering, members: MEMBERS, keyCount: "0" }).databaseSize).toBe(
      "1.2 GiB on disk, the answering member ff",
    );
  });
});

describe("toStorageStats (spec 7.1)", () => {
  test("one row for the answering member: its size on disk and in use, and its share of the quota", () => {
    expect(toStorageStats(status({ dbSize: "536870912", dbSizeInUse: "268435456" }))).toEqual([
      {
        name: "member 8e9e05c52164694d",
        location: "the member this connection reaches",
        size: "512 MiB on disk, 256 MiB in use",
        sizeBytes: 536870912,
        usagePercent: 25,
      },
    ]);
  });

  test("a quota the server sets is read as it is", () => {
    expect(toStorageStats(status({ dbSize: "536870912", dbSizeQuota: "1073741824" }))[0].usagePercent).toBe(50);
  });

  test("a disabled quota, a negative --quota-backend-bytes etcd answers as it was set, gives no share rather than a negative one (spec 7.1)", () => {
    // Measured on etcd v3.7.2 started with --quota-backend-bytes=-1: it logs "disabled backend quota" and
    // answers dbSizeQuota -1, which over a 20 KiB member read -2048000%.
    const [row] = toStorageStats(status({ dbSize: "20480", dbSizeInUse: "16384", dbSizeQuota: "-1" }));
    expect(row).toEqual({
      name: "member 8e9e05c52164694d",
      location: "the member this connection reaches",
      size: "20 KiB on disk, 16 KiB in use",
      sizeBytes: 20480,
    });
    expect("usagePercent" in row).toBe(false);
  });

  test("a quota of 0 from 3.6 or later is the 2 GiB default, which 3.6.0 to 3.6.5 send as the flag's 0 (R06 2.9)", () => {
    // Measured 2026-10-01 with --quota-backend-bytes left at its default: v3.6.0 and v3.6.5 sent no
    // dbSizeQuota, which reads as 0, and v3.6.6 and v3.7.2 answered 2147483648; v3.6.5 answered a set
    // quota (4194304) and a disabled one (-1) as they were set.
    expect(ETCD_DEFAULT_QUOTA_BYTES).toBe(String(2 * 1024 ** 3));
    for (const version of ["3.6.0", "3.6.5", "3.7.2"]) {
      const [row] = toStorageStats(status({ version, dbSize: "536870912", dbSizeQuota: "0" }));
      expect([version, row.usagePercent]).toEqual([version, 25]);
    }
  });

  test("a quota of 0 from a server before 3.6, which sends no dbSizeQuota, gives no share of a guessed quota (spec 7.1)", () => {
    // dbSizeQuota is a 3.6 field (rpc.proto, etcd_version_field 3.6), so a server before it reports no
    // quota at all. Measured on v3.5.21 under a 4 MiB quota: a member at NOSPACE, 98.8% full, read 0.19%.
    const [row] = toStorageStats(
      status({ version: "3.5.21", dbSize: "4145152", dbSizeInUse: "4128768", dbSizeQuota: "0" }),
    );
    expect(row).toEqual({
      name: "member 8e9e05c52164694d",
      location: "the member this connection reaches",
      size: "4 MiB on disk, 3.9 MiB in use",
      sizeBytes: 4145152,
    });
    expect("usagePercent" in row).toBe(false);
  });
});

describe("toTableStats (spec 7.1)", () => {
  test("one row per group, named as the tree names it, with its exact count and no byte figure", () => {
    expect(
      toTableStats([
        { group: "/apisix/routes/*", count: "199000" },
        { group: "config/app/*", count: "1" },
      ]),
    ).toEqual([
      { schemaName: "", tableName: "/apisix/routes/*", rowCount: 199000, totalSize: "N/A", totalSizeBytes: 0 },
      { schemaName: "", tableName: "config/app/*", rowCount: 1, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
  });
});
