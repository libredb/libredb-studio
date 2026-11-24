/**
 * The fleet census of monitoring panel reads (FND-4): every provider is built through the real
 * `createDatabaseProvider`, unconnected, and its `getMonitoringData` is driven with the seven reads replaced on the
 * instance by recording doubles, so the census measures which reads core calls for each engine rather than what a
 * double of the base class would do.
 *
 * It holds the two halves of the engine facets contract against real providers: core alone orchestrates the reads (no
 * provider overrides `getMonitoringData`, nor `mapError`, which the host's monitoring facade stands in for with
 * `mapDatabaseError` for the engine's type), and core calls exactly the reads of the panels the engine's
 * `ENGINE_FACETS` row offers, listing the others in `notOffered`; and every provider holds the member of each panel its
 * row offers, so the legacy bridge offers that row on its session. What each row declares is held separately, against
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
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
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

  test("no provider overrides mapError, so the host's mapping of a dashboard's several sentences is each provider's own", async () => {
    const providers = await Promise.all(ALL.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const mapErrorOf = (target: object): unknown => (target as { mapError: unknown }).mapError;
    const overriding = ALL.filter(
      (_type, at) => mapErrorOf(providers[at]) !== mapErrorOf(BaseDatabaseProvider.prototype),
    );
    expect(overriding).toEqual([]);
  });

  test("every shipped provider holds the member of each panel its engine offers, so its bridged session offers its engine's row", async () => {
    const providers = await Promise.all(ALL.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const missing = ALL.flatMap((type, at) =>
      MONITORING_PANELS.filter(
        (panel) =>
          ENGINE_FACETS[type].monitoring[panel] === "offered" && typeof providers[at][METHOD[panel]] !== "function",
      ).map((panel) => `${type} ${panel}`),
    );
    const rowless = ALL.filter(
      (type, at) => bridgedConsole(providers[at], {}).session.panels !== ENGINE_FACETS[type].monitoring,
    );

    expect(missing).toEqual([]);
    expect(rowless).toEqual([]);
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

/**
 * The panel each copy field is drawn on. A sentence for the empty answer of a panel, or a caption above its list,
 * belongs to an engine that offers that panel: where its `ENGINE_FACETS` row does not, nothing draws the panel, and the
 * copy would document a behaviour no reader has.
 */
const COPY_PANEL = {
  sessionsEmptyState: "activeSessions",
  slowQueriesEmptyState: "slowQueries",
  tableStatsCaption: "tables",
} as const satisfies Record<string, MonitoringPanel>;

describe("empty-state copy across the fleet", () => {
  test.each([...ALL])(
    "%s sets no empty-state sentence or table caption for a panel it does not offer",
    async (type) => {
      const labels = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getLabels();
      const offer = ENGINE_FACETS[type].monitoring;

      const unrendered = Object.entries(COPY_PANEL)
        .filter(
          ([field, panel]) => labels[field as keyof typeof COPY_PANEL] !== undefined && offer[panel] !== "offered",
        )
        .map(([field]) => field);

      expect(unrendered).toEqual([]);
    },
  );
});
