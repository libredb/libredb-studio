import { describe, expect, test } from "bun:test";
import { DATABEND_KILL_SPEC, DATABEND_LABEL_SENTENCES, DATABEND_LABELS } from "@/lib/db/providers/sql/databend/labels";
import { DATABEND_DEFAULT_PORT } from "@/lib/db/providers/sql/databend/connection-options";
import { DatabendProvider } from "@/lib/db/providers/sql/databend/index";
import { type DatabaseConnection } from "@/lib/types";

/** The en dash and the em dash, built from their code points so this file holds neither. */
const DASHES = new RegExp("[\\u2013\\u2014]");

describe("DATABEND_LABELS", () => {
  test("every member, with no inherited PostgreSQL wording left", () => {
    expect(DATABEND_LABELS).toEqual({
      entityName: "Table",
      entityNamePlural: "Tables",
      rowName: "row",
      rowNamePlural: "rows",
      selectAction: "Select Top 50",
      generateAction: "Generate Query",
      analyzeAction: "Analyze Table",
      vacuumAction: "Vacuum Table",
      searchPlaceholder: "Search tables or columns...",
      analyzeGlobalLabel: "Run Analyze",
      analyzeGlobalTitle: "Not Run from Studio",
      analyzeGlobalDesc: DATABEND_LABEL_SENTENCES.analyzeGlobalDesc,
      vacuumGlobalLabel: "Run Vacuum",
      vacuumGlobalTitle: "Not Run from Studio",
      vacuumGlobalDesc: DATABEND_LABEL_SENTENCES.vacuumGlobalDesc,
      slowQueriesEmptyState: DATABEND_LABEL_SENTENCES.slowQueriesEmptyState,
      sessionsEmptyState: DATABEND_LABEL_SENTENCES.sessionsEmptyState,
      tableStatsCaption: DATABEND_LABEL_SENTENCES.tableStatsCaption,
    });
    expect(Object.isFrozen(DATABEND_LABELS)).toBe(true);
  });

  test("the slow-query state names system_history and its grant; the sessions state the warehouse-wide scope", () => {
    expect(DATABEND_LABELS.slowQueriesEmptyState).toContain("system_history.query_history");
    expect(DATABEND_LABELS.slowQueriesEmptyState).toContain("GRANT SELECT ON system_history.*");
    expect(DATABEND_LABELS.sessionsEmptyState).toContain("every user's");
    expect(DATABEND_LABELS.sessionsEmptyState).toContain("warehouse");
  });

  test("no wording names a PostgreSQL feature", () => {
    for (const text of Object.values(DATABEND_LABELS)) {
      expect(text).not.toMatch(/pg_stat|shared_buffers|dead rows|planner's statistics/);
    }
  });
});

describe("the sentences", () => {
  test("each is exported, ends with a full stop, and has no dash", () => {
    for (const sentence of Object.values(DATABEND_LABEL_SENTENCES)) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence).not.toMatch(DASHES);
    }
    expect(Object.keys(DATABEND_LABEL_SENTENCES).sort()).toEqual([
      "analyzeGlobalDesc",
      "sessionsEmptyState",
      "slowQueriesEmptyState",
      "tableStatsCaption",
      "vacuumGlobalDesc",
    ]);
  });
});

describe("DATABEND_KILL_SPEC", () => {
  test("the kill targets a session id from the Sessions panel, so it has no table or global control", () => {
    expect(DATABEND_KILL_SPEC).toEqual({ label: "Kill Query", perEntity: false, global: false });
    expect(Object.isFrozen(DATABEND_KILL_SPEC)).toBe(true);
  });
});

const CONNECTION: DatabaseConnection = {
  id: "databend-doc",
  name: "Databend",
  type: "databend",
  host: "localhost",
  port: DATABEND_DEFAULT_PORT,
  user: "root",
  createdAt: new Date(0),
};
const provider = new DatabendProvider(CONNECTION);
const capabilities = provider.getCapabilities();

describe("the declared capabilities and the kill card", () => {
  test("no table creation is declared, a warehouse resumes billed compute, four kinds are listed and the kill card is Kill Query", () => {
    expect(capabilities.createTable).toBeUndefined();
    expect(capabilities.resumesBilledCompute).toBeUndefined();
    expect(new DatabendProvider({ ...CONNECTION, warehouse: "wh" }).getCapabilities().resumesBilledCompute).toBe(true);
    const kinds = (capabilities.objectKinds ?? []).map((kind) => `\`${kind.id}\``);
    expect(kinds).toHaveLength(4);
    expect(DATABEND_KILL_SPEC.label).toBe("Kill Query");
  });
});
