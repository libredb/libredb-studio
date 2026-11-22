/**
 * The fleet census of monitoring panel reads (FND-4): every provider is built through the real
 * `createDatabaseProvider`, unconnected, and its `getMonitoringData` is driven with the seven reads replaced on the
 * instance by recording doubles, so the census measures which reads core calls for each engine rather than what a
 * double of the base class would do.
 *
 * It holds the two halves of the engine facets contract against real providers: core alone orchestrates the reads (no
 * provider overrides `getMonitoringData`), and core calls exactly the reads of the panels the engine's
 * `ENGINE_FACETS` row offers, listing the others in `notOffered`. What each row declares is held separately, against
 * the measurement committed in `tests/unit/db/engine-facets/census.test.ts`.
 *
 * It lives under `tests/isolated/` for the reason `object-source-declarations.test.ts` gives: it needs the real
 * factory, which every file under `tests/api/` mocks, and the runner gives each test file a process of its own.
 */
import { describe, expect, test } from "bun:test";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { MONITORING_PANELS, type MonitoringPanel } from "@/lib/db/engine-facets/types";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

const METHOD = {
  overview: "getOverview",
  performance: "getPerformanceMetrics",
  slowQueries: "getSlowQueries",
  activeSessions: "getActiveSessions",
  tables: "getTableStats",
  indexes: "getIndexStats",
  storage: "getStorageStats",
} as const satisfies Record<MonitoringPanel, keyof DatabaseProvider>;

describe("monitoring panel reads across the fleet", () => {
  test("no provider overrides getMonitoringData", async () => {
    const providers = await Promise.all(ALL.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const overriding = ALL.filter(
      (_type, at) => providers[at].getMonitoringData !== BaseDatabaseProvider.prototype.getMonitoringData,
    );
    expect(overriding).toEqual([]);
  });

  test.each([...ALL])("getMonitoringData reads every panel %s offers and none it does not", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const called: MonitoringPanel[] = [];
    for (const panel of MONITORING_PANELS) {
      Object.defineProperty(provider, METHOD[panel], {
        value: () => {
          called.push(panel);
          return Promise.resolve(panel === "overview" || panel === "performance" ? {} : []);
        },
      });
    }

    const data = await provider.getMonitoringData({ includeTables: true, includeIndexes: true, includeStorage: true });

    const offer = ENGINE_FACETS[type].monitoring;
    expect(called.sort()).toEqual(MONITORING_PANELS.filter((panel) => offer[panel] === "offered").sort());
    expect(data.notOffered).toEqual(MONITORING_PANELS.filter((panel) => offer[panel] === "not-offered"));
    expect(data.errors).toBeUndefined();
  });
});
