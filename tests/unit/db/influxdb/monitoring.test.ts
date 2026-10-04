/**
 * The InfluxDB monitoring mappings (InfluxDB spec 7, R24): the health every surface reads, and the overview's version
 * text, object count and floor sentence for both types. Every figure no InfluxDB route reports reads "N/A" or 0.
 */
import { describe, expect, test } from "bun:test";
import { toInfluxHealth, toInfluxOverview } from "@/lib/db/providers/timeseries/influxdb/monitoring";
import type { InfluxServerVersion } from "@/lib/db/providers/timeseries/influxdb/versions";

const V1: InfluxServerVersion = { generation: "v1", reported: "1.13.1", build: null };
const V2: InfluxServerVersion = { generation: "v2", reported: "v2.9.1", build: null };
const V3: InfluxServerVersion = { generation: "v3", reported: "3.12.0", build: "Core" };
const UNKNOWN: InfluxServerVersion = { generation: "unknown", reported: null, build: null };

describe("toInfluxHealth", () => {
  test("reports nothing it cannot read", () => {
    expect(toInfluxHealth()).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
  });
});

describe("toInfluxOverview", () => {
  const overview = (version: InfluxServerVersion, extra: Partial<Parameters<typeof toInfluxOverview>[0]> = {}) =>
    toInfluxOverview({ version, objectCount: 6, objectCountCut: false, objects: "measurements", ...extra });

  test.each([
    [V1, "InfluxDB 1.13.1"],
    [V2, "InfluxDB 2.9.1"],
    [V3, "InfluxDB 3 Core 3.12.0"],
    [{ generation: "v3", reported: "3.12.0", build: null } as InfluxServerVersion, "InfluxDB 3.12.0"],
    [{ generation: "v3", reported: null, build: null } as InfluxServerVersion, "InfluxDB 3, version not reported"],
    [UNKNOWN, "InfluxDB, version not reported"],
  ])("the version text of %p is %s", (version, text) => {
    expect(overview(version).version).toBe(text);
  });

  test("influxdb: every unreported figure, the measurement count, and no floor field when nothing was cut", () => {
    expect(overview(V1)).toEqual({
      version: "InfluxDB 1.13.1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 6,
      indexCount: 0,
    });
  });

  test("influxdb: a cut listing sets the floor sentence for measurements", () => {
    const cut = overview(V1, { objectCount: 2000, objectCountCut: true });
    expect(cut.tableCount).toBe(2000);
    expect(cut.tableCountSampledFrom).toBe("the first 2,000 measurements SHOW MEASUREMENTS returned for each database");
  });

  test("influxdb3: the session database follows the version text", () => {
    const sql = overview(V3, { sessionDatabase: "home", objects: "tables", objectCount: 5 });
    expect(sql.version).toBe("InfluxDB 3 Core 3.12.0, database home");
    expect(sql.tableCount).toBe(5);
    expect(sql).not.toHaveProperty("tableCountSampledFrom");
  });

  test("influxdb3: a cut listing sets the floor sentence for tables", () => {
    const sql = overview(V3, { sessionDatabase: "home", objects: "tables", objectCount: 2000, objectCountCut: true });
    expect(sql.tableCountSampledFrom).toBe("the first 2,000 tables the session database's table listing returned");
  });
});
