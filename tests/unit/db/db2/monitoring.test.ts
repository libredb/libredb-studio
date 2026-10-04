/**
 * Db2's neutral monitoring readings (#786): the version from `SYSIBMADM.ENV_INST_INFO`, measured
 * as `DB2 v12.1.0.0` on the dev container, and the two catalog counts.
 */

import { describe, expect, test } from "bun:test";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { OBJECT_COUNTS_SQL, VERSION_SQL, neutralHealth, readOverview } from "@/lib/db/providers/sql/db2/monitoring";

describe("readOverview", () => {
  test("the version and the counts the catalog answered, a measured 0 included", async () => {
    const asked: string[] = [];
    const overview = await readOverview(async (sql) => {
      asked.push(sql);
      if (sql === VERSION_SQL) return [{ SERVICE_LEVEL: "DB2 v12.1.0.0" }];
      return [{ TABLE_COUNT: 12, INDEX_COUNT: 0 }];
    });

    expect(asked).toEqual([VERSION_SQL, OBJECT_COUNTS_SQL]);
    expect(overview).toEqual({
      version: "DB2 v12.1.0.0",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 12,
      indexCount: 0,
    });
    expect(overview).not.toHaveProperty("activeConnections");
    expect(overview).not.toHaveProperty("databaseSizeBytes");
  });

  test("a refused version reads Unknown and refused counts read 0, without throwing", async () => {
    const overview = await readOverview(async () => {
      throw new Error("SQL0551N");
    });

    expect(overview.version).toBe("Unknown");
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("an empty answer is Unknown and 0 as well", async () => {
    const overview = await readOverview(async (sql) => (sql === VERSION_SQL ? [{ SERVICE_LEVEL: "" }] : []));

    expect(overview.version).toBe("Unknown");
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("no version row at all is Unknown", async () => {
    expect((await readOverview(async () => [])).version).toBe("Unknown");
  });
});

describe("neutralHealth", () => {
  test("nothing measured, nothing invented", () => {
    const health = neutralHealth();

    expect(health).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [],
    });
    expect(health).not.toHaveProperty("activeConnections");
  });
});
