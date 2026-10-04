/**
 * The two label sets (SPEC 6.4): every field the spec words, verbatim, the maintenance triads present
 * and worded for InfluxDB though never rendered (the Prometheus pattern), and no field naming another engine.
 */
import { describe, expect, test } from "bun:test";
import { INFLUXDB3_LABELS, INFLUXQL_LABELS } from "@/lib/db/providers/timeseries/influxdb/labels";

const SESSIONS = "InfluxDB has no session list: every request stands alone.";

describe("INFLUXQL_LABELS", () => {
  test("the fields SPEC 6.4 words", () => {
    expect(INFLUXQL_LABELS).toMatchObject({
      entityName: "Measurement",
      entityNamePlural: "Measurements",
      rowName: "point",
      rowNamePlural: "points",
      selectAction: "Preview Newest Points",
      generateAction: "Generate Query",
      searchPlaceholder: "Search measurements...",
      statementLanguage:
        'InfluxQL: one SELECT, SHOW or EXPLAIN statement, no INTO, no Flux; name a measurement as "db".."measurement".',
      slowQueriesEmptyState:
        "InfluxDB keeps no query log Studio reads; 1.x SHOW QUERIES shows other users' statements and is not read.",
      sessionsEmptyState: SESSIONS,
    });
  });
});

describe("INFLUXDB3_LABELS", () => {
  test("the fields SPEC 6.4 words", () => {
    expect(INFLUXDB3_LABELS).toMatchObject({
      entityName: "Table",
      entityNamePlural: "Tables",
      rowName: "row",
      rowNamePlural: "rows",
      selectAction: "Preview Newest Rows",
      generateAction: "Generate Query",
      searchPlaceholder: "Search tables...",
      statementLanguage:
        "Apache DataFusion SQL as InfluxDB 3 runs it, not InfluxQL and not Flux: one SELECT, WITH, VALUES, SHOW, EXPLAIN or DESCRIBE statement; unquoted names fold to lower case; the time column is \"time\"; filter time with now() - INTERVAL '1 hour'.",
      slowQueriesEmptyState:
        "InfluxDB 3 records queries in a server-wide table that shows other users' statements and marks a streamed query finished early, so Studio does not read it.",
      sessionsEmptyState: SESSIONS,
    });
  });
});

describe.each([
  ["INFLUXQL_LABELS", INFLUXQL_LABELS],
  ["INFLUXDB3_LABELS", INFLUXDB3_LABELS],
])("%s", (_, labels) => {
  test("no table stats caption: there are no table stats", () => {
    expect(labels.tableStatsCaption).toBeUndefined();
  });

  test("the maintenance actions and global triads are present and name InfluxDB", () => {
    for (const field of ["analyzeAction", "vacuumAction"] as const) expect(labels[field].length).toBeGreaterThan(0);
    for (const field of ["analyzeGlobalLabel", "analyzeGlobalTitle", "vacuumGlobalLabel", "vacuumGlobalTitle"] as const)
      expect(labels[field].length).toBeGreaterThan(0);
    expect(labels.analyzeGlobalDesc).toContain("InfluxDB");
    expect(labels.vacuumGlobalDesc).toContain("InfluxDB");
  });

  test("no field names another engine", () => {
    const text = Object.values(labels).join("\n");
    expect(text).not.toMatch(/Postgre|MySQL|SQLite|Prometheus|Qdrant|PromQL|Mongo|Redis|ClickHouse|Oracle|SQL Server/i);
  });

  test("no field holds an em dash or an en dash", () => {
    expect(Object.values(labels).join("\n")).not.toMatch(/[\u2013\u2014]/);
  });
});
