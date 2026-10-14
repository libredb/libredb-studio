import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import { SparkProvider } from "@/lib/db/providers/sql/spark/index";
import {
  readHealth,
  readOverview,
  SPARK_MONITORING_LABELS,
  type SparkMonitoringDeps,
} from "@/lib/db/providers/sql/spark/monitoring";
import { formatDuration } from "@/lib/db/utils/pool-manager";
import type { DatabaseConnection } from "@/lib/types";
import { startSparkFake } from "../../../helpers/spark-connect-server";
import { columnsStream } from "../../../helpers/spark-ipc";

const NOW = new Date("2026-10-13T12:00:00Z");

afterEach(() => {
  setSystemTime();
});

/** The provider's side of the panels: SHOW CURRENT NAMESPACE answers `rows`, and every listing answers 7 tables. */
function deps(
  app: Readonly<Record<string, string>>,
  calls: string[] = [],
  rows: readonly Readonly<Record<string, unknown>>[] = [{ catalog: "spark_catalog", namespace: "studio" }],
): SparkMonitoringDeps {
  return {
    version: async () => {
      calls.push("version");
      return "4.2.0";
    },
    confAll: async (prefix) => {
      calls.push(`confAll ${prefix}`);
      return app;
    },
    currentNamespace: async () => {
      calls.push("currentNamespace");
      return rows.at(0);
    },
    tableCount: async (catalog, namespace) => {
      calls.push(`tableCount ${catalog} ${namespace}`);
      return 7;
    },
  };
}

describe("overview", () => {
  test("version, start time and uptime from spark.app., the current namespace's tables, and no size or connections", async () => {
    setSystemTime(NOW);
    const runFor = 3 * 3_600_000 + 5 * 60_000;
    const start = NOW.getTime() - runFor;
    const calls: string[] = [];
    expect(await readOverview(deps({ startTime: String(start), name: "Spark Connect server" }, calls))).toStrictEqual({
      version: "4.2.0",
      uptime: formatDuration(runFor),
      startTime: new Date(start),
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 7,
      tableCountSampledFrom: "the tables of spark_catalog.studio, the connection's current namespace",
      indexCount: 0,
    });
    expect(calls).toStrictEqual([
      "version",
      "confAll spark.app.",
      "currentNamespace",
      "tableCount spark_catalog studio",
    ]);
  });

  test("a catalog with no current namespace has no table count: no listing is read, and every other field is as with one", async () => {
    setSystemTime(NOW);
    const app = { startTime: String(NOW.getTime() - 90_000) };
    const counted = await readOverview(deps(app));
    const calls: string[] = [];
    // Spark spells the current namespace of a catalog that has none as "".
    const uncounted = await readOverview(deps(app, calls, [{ catalog: "lake", namespace: "" }]));
    const { tableCountSampledFrom, ...others } = counted;
    expect(tableCountSampledFrom).toBe("the tables of spark_catalog.studio, the connection's current namespace");
    expect(uncounted).toStrictEqual({ ...others, tableCount: 0 });
    expect(calls).toStrictEqual(["version", "confAll spark.app.", "currentNamespace"]);
  });

  test.each<[string, readonly Readonly<Record<string, unknown>>[], string]>([
    ["no row", [], "SHOW CURRENT NAMESPACE"],
    ["a catalog that is not text", [{ catalog: null, namespace: "studio" }], "the catalog column of Spark's answer"],
    ["a namespace that is not text", [{ catalog: "lake", namespace: null }], "the namespace column of Spark's answer"],
  ])(
    "SHOW CURRENT NAMESPACE with %s fails the overview as unreadable, and no listing is read",
    async (_, rows, what) => {
      const calls: string[] = [];
      const failure = await readOverview(deps({}, calls, rows)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SparkError);
      expect({ category: (failure as SparkError).category, message: (failure as SparkError).message }).toStrictEqual({
        category: "unreadable",
        message: SPARK_ERROR_SENTENCES.unreadable(what),
      });
      expect(calls).toStrictEqual(["version", "confAll spark.app.", "currentNamespace"]);
    },
  );

  test.each<Record<string, string>>([{}, { startTime: "" }, { startTime: "soon" }, { startTime: "-5" }])(
    "without a readable start time the uptime is N/A and no start time is claimed (%j)",
    async (app) => {
      const overview = await readOverview(deps(app));
      expect(overview.uptime).toBe("N/A");
      expect(overview.startTime).toBeUndefined();
      expect("startTime" in overview).toBe(false);
      expect("activeConnections" in overview).toBe(false);
      expect("databaseSizeBytes" in overview).toBe(false);
    },
  );

  test.each<[string, string]>([
    ["a start later than Studio's clock", String(NOW.getTime() + 60_000)],
    ["a start 1 ms later than Studio's clock", String(NOW.getTime() + 1)],
    ["a start past the Date range", "99999999999999999999"],
  ])("%s claims no start time and no uptime", async (_, startTime) => {
    setSystemTime(NOW);
    expect(await readOverview(deps({ startTime }))).toStrictEqual({
      version: "4.2.0",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 7,
      tableCountSampledFrom: "the tables of spark_catalog.studio, the connection's current namespace",
      indexCount: 0,
    });
  });

  test("a start at Studio's own clock is an uptime of zero", async () => {
    setSystemTime(NOW);
    const overview = await readOverview(deps({ startTime: String(NOW.getTime()) }));
    expect({ uptime: overview.uptime, startTime: overview.startTime }).toStrictEqual({
      uptime: formatDuration(0),
      startTime: NOW,
    });
  });
});

describe("the overview through the provider", () => {
  test("a connection whose catalog has no current namespace answers the overview with no table count, and sends no listing", async () => {
    const fake = await startSparkFake({
      statements: {
        // A catalog with no current namespace: Spark spells that namespace as "".
        "SHOW CURRENT NAMESPACE": {
          kind: "command",
          ipc: columnsStream([
            { name: "catalog", kind: "utf8", values: ["lake"] },
            { name: "namespace", kind: "utf8", values: [""] },
          ]),
        },
      },
    });
    const port = Number(fake.target.split(":").at(-1));
    const provider = new SparkProvider({
      id: "no-namespace",
      name: "no-namespace",
      type: "spark",
      host: "127.0.0.1",
      port,
    } as DatabaseConnection);
    try {
      await provider.connect();
      expect(await provider.getOverview()).toStrictEqual({
        version: "4.2.0",
        uptime: "N/A",
        maxConnections: 0,
        databaseSize: "N/A",
        tableCount: 0,
        indexCount: 0,
      });
      // The connect's and the overview's SHOW CURRENT NAMESPACE, and no listing.
      expect(
        fake.log.entries
          .filter((entry) => entry.rpc === "ExecutePlan")
          .map(
            (entry) =>
              (entry.request as { plan: { command: { sql_command: { input: { sql: { query: string } } } } } }).plan
                .command.sql_command.input.sql.query,
          ),
      ).toStrictEqual(["SHOW CURRENT NAMESPACE", "SHOW CURRENT NAMESPACE"]);
    } finally {
      await provider.disconnect();
      fake.close();
    }
  });
});

describe("health", () => {
  test("one AnalyzePlan round trip, and no figure Spark does not report", async () => {
    const calls: string[] = [];
    expect(await readHealth(deps({}, calls))).toStrictEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(calls).toStrictEqual(["version"]);
  });

  test("a failed version read fails health", async () => {
    const failing: Pick<SparkMonitoringDeps, "version"> = {
      version: async () => {
        throw new Error("UNAVAILABLE: No connection established");
      },
    };
    await expect(readHealth(failing)).rejects.toThrow("UNAVAILABLE: No connection established");
  });
});

test("the two empty states and the two refusals are the panels' own sentences", () => {
  expect(SPARK_MONITORING_LABELS).toStrictEqual({
    slowQueriesEmptyState:
      "Spark keeps finished statements in the driver's web UI, which Studio does not read in this version.",
    sessionsEmptyState:
      "Spark Connect sessions are listed in the driver's web UI, which Studio does not read in this version. Studio's own sessions last one request each, except the one for the tree and the panels, which Studio keeps while the connection is open.",
    tablesRefused:
      "Spark keeps table statistics only where its catalog stores them, and Studio does not read them in this version.",
    storageRefused: "Spark reports no storage figure Studio can read in this version.",
  });
});
