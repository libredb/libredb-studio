import { describe, expect, test } from "bun:test";
import { KafkaError } from "@/lib/db/providers/stream/kafka/client";
import { healthFrom, overviewFrom, storageFrom } from "@/lib/db/providers/stream/kafka/monitoring";
import { formatBytes } from "@/lib/db/utils/pool-manager";

const big = (value: number) => BigInt(value);
const dirs = [
  { brokerId: 1, path: "/var/lib/kafka", sizeBytes: big(2048), totalBytes: big(10_000), usableBytes: big(7_500) },
  { brokerId: 2, path: "/var/lib/kafka", sizeBytes: big(1024), totalBytes: big(-1), usableBytes: big(-1) },
];
const ON_DISK = (bytes: number) => `${formatBytes(bytes)} on disk, all replicas, internal topics excluded`;
const maxConnections = (value: string | null) => ({
  name: "max.connections",
  value,
  readOnly: false,
  isSensitive: false,
  source: 5,
});

describe("overviewFrom", () => {
  test("exact topic count, the broker's max.connections, the labelled log-dir size, and N/A where the protocol is silent", () => {
    const overview = overviewFrom({
      topicCount: 12,
      brokerConfigs: [maxConnections("2147483647")],
      logDirs: dirs,
    });
    expect(overview).toEqual({
      version: "N/A",
      uptime: "N/A",
      maxConnections: 2147483647,
      databaseSize: ON_DISK(3072),
      databaseSizeBytes: 3072,
      tableCount: 12,
      indexCount: 0,
    });
    expect("activeConnections" in overview).toBe(false);
  });

  test("the size counts every replica: one partition on three brokers is three times its data", () => {
    const replicas = [1, 2, 3].map((brokerId) => ({
      brokerId,
      path: "/k",
      sizeBytes: big(1000),
      totalBytes: big(-1),
      usableBytes: big(-1),
    }));
    expect(overviewFrom({ topicCount: 1, brokerConfigs: [], logDirs: replicas }).databaseSize).toBe(ON_DISK(3000));
  });

  test("no log dirs (refused, KM4): N/A and no bytes; no broker configs (refused, KM4): no limit published", () => {
    const overview = overviewFrom({ topicCount: 0, brokerConfigs: [], logDirs: undefined });
    expect(overview.databaseSize).toBe("N/A");
    expect("databaseSizeBytes" in overview).toBe(false);
    expect(overview.maxConnections).toBe(0);
  });

  test("a max.connections the broker withholds is no limit published", () => {
    const overview = overviewFrom({ topicCount: 0, brokerConfigs: [maxConnections(null)], logDirs: undefined });
    expect(overview.maxConnections).toBe(0);
  });

  test("a max.connections that is not a whole number is refused by name, never read as a number or as no limit", () => {
    for (const value of ["unlimited", "", "-1", "1.5", "1e3"]) {
      const read = () => overviewFrom({ topicCount: 0, brokerConfigs: [maxConnections(value)], logDirs: undefined });
      expect(read).toThrow(KafkaError);
      expect(read).toThrow("The broker published max.connections as a value that is not a whole number");
      try {
        read();
      } catch (error) {
        expect((error as KafkaError).category).toBe("protocol");
      }
    }
  });

  test("only the max.connections entry is read", () => {
    const overview = overviewFrom({
      topicCount: 0,
      brokerConfigs: [{ ...maxConnections("7"), name: "max.connections.per.ip" }, maxConnections("100")],
      logDirs: undefined,
    });
    expect(overview.maxConnections).toBe(100);
  });
});

describe("storageFrom", () => {
  test("one row per broker and directory; usagePercent only where the broker reports totals", () => {
    const rows = storageFrom(dirs);
    expect(rows).toEqual([
      {
        name: "broker 1: /var/lib/kafka",
        location: "/var/lib/kafka",
        size: formatBytes(2048),
        sizeBytes: 2048,
        usagePercent: 25,
      },
      { name: "broker 2: /var/lib/kafka", location: "/var/lib/kafka", size: formatBytes(1024), sizeBytes: 1024 },
    ]);
    expect("usagePercent" in rows[1]).toBe(false);
  });

  test("a known total with an unreported usable figure gives no usagePercent", () => {
    const [row] = storageFrom([
      { brokerId: 3, path: "/d", sizeBytes: big(0), totalBytes: big(10_000), usableBytes: big(-1) },
    ]);
    expect(row).toEqual({ name: "broker 3: /d", location: "/d", size: formatBytes(0), sizeBytes: 0 });
  });

  test("a full directory, 0 usable bytes of a reported total, is 100 percent; a total of 0 gives no percentage", () => {
    // Only -1 means unreported: 0 usable bytes is what the broker reports for a full disk, the
    // one storage state worth acting on (spec 7.1).
    const [full, empty] = storageFrom([
      { brokerId: 1, path: "/full", sizeBytes: big(9_000), totalBytes: big(10_000), usableBytes: big(0) },
      { brokerId: 2, path: "/none", sizeBytes: big(0), totalBytes: big(0), usableBytes: big(0) },
    ]);
    expect(full).toEqual({
      name: "broker 1: /full",
      location: "/full",
      size: formatBytes(9_000),
      sizeBytes: 9_000,
      usagePercent: 100,
    });
    expect(empty).toEqual({ name: "broker 2: /none", location: "/none", size: formatBytes(0), sizeBytes: 0 });
  });

  test("no log dirs (refused, KM4) is no rows", () => {
    expect(storageFrom(undefined)).toEqual([]);
  });
});

describe("healthFrom", () => {
  test("databaseSize from the log dirs, labelled; cache ratio N/A, empty lists, no activeConnections", () => {
    const health = healthFrom(dirs);
    expect(health).toEqual({ databaseSize: ON_DISK(3072), cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
    expect("activeConnections" in health).toBe(false);
    expect(healthFrom(undefined).databaseSize).toBe("N/A");
  });
});
