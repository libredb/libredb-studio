import { describe, expect, test } from "bun:test";
import { summarisePlan } from "@/lib/agent/plan-summary";
import type { ExplainFormat } from "@/lib/db/types";
import { getExplainStrategy } from "@/lib/explain";

/**
 * The agent reads a plan only through the format's own strategy (`ExplainStrategy.agentReading`), so which formats
 * carry a reading, and which of the gate's two rules each one asks for, is pinned here. A format gains a reading only
 * in the change that verifies its reader against the engine's grammar, and that change moves this table on purpose.
 */
const READINGS: Readonly<Record<ExplainFormat, { costed: boolean } | null>> = {
  "postgres-json": { costed: true },
  "postgres-text": null,
  "postgres-text-analyze": null,
  "mysql-json": null,
  "mysql-text": null,
  "sqlite-queryplan": { costed: false },
  "couchbase-json": null,
  "clickhouse-json": null,
  "druid-native": null,
  "trino-json": null,
  "duckdb-json": null,
  "databend-text": null,
  "bigquery-dryrun": null,
  "snowflake-json": null,
  "firestore-explain": null,
  "spark-text": null,
};

const FORMATS = Object.keys(READINGS) as ExplainFormat[];

describe("the agent's plan readings live in the explain strategies", () => {
  test("only the verified formats carry a reading, each with its rule", () => {
    for (const format of FORMATS) {
      const reading = getExplainStrategy(format)?.agentReading;
      expect(reading === undefined ? null : { costed: reading.costed }, format).toEqual(READINGS[format]);
    }
  });

  test("summarisePlan answers exactly what the format's own reading answers", () => {
    const rows: Record<string, unknown>[][] = [
      [{ "QUERY PLAN": [{ Plan: { "Node Type": "Index Scan", "Plan Rows": 3, "Total Cost": 8.3 } }] }],
      [{ id: 2, parent: 0, notused: 0, detail: "SEARCH t USING INDEX ix (a=?)" }],
      [{ id: 2, parent: 0, notused: 0, detail: "SCAN t" }, { nothing: true }],
      [],
    ];
    for (const format of FORMATS) {
      const reading = getExplainStrategy(format)?.agentReading;
      for (const plan of rows) {
        expect(summarisePlan(format, plan), format).toEqual(
          reading === undefined ? { access: "unknown" } : reading.summarise(plan),
        );
      }
    }
  });

  test("each reading object is frozen, so no caller can change a reading's rule in place", () => {
    for (const format of FORMATS) {
      const reading = getExplainStrategy(format)?.agentReading;
      if (reading !== undefined) expect(Object.isFrozen(reading), format).toBe(true);
    }
  });
});
