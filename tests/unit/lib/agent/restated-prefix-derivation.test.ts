import { describe, expect, mock, test } from "bun:test";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";

/**
 * The restated-EXPLAIN strip follows the engine overlays, and the composer keeps no prefix list of its own.
 *
 * This file changes one overlay before anything that builds the strip is loaded: DuckDB declares a prefix no shipped
 * engine uses. A composer that spelled the prefixes itself would not strip it, so the case below fails against a
 * hard-coded strip.
 *
 * `mock.module` is process-wide, so the substitution comes first and the composer is imported dynamically below it;
 * the runner gives this file its own process.
 */

const TEST_ONLY_PREFIX = "EXPLAIN PLAN FOR";

// Captured as a plain object before the substitution: the namespace itself follows the replacement.
const REAL_DUCKDB = { ...DUCKDB };

mock.module("@/lib/agent/languages/sql/engines/duckdb", () => ({
  ...REAL_DUCKDB,
  DUCKDB_SERVER_OVERLAY: {
    ...REAL_DUCKDB.DUCKDB_SERVER_OVERLAY,
    dialect: {
      ...REAL_DUCKDB.DUCKDB_SERVER_OVERLAY.dialect,
      planEstimate: { kind: "prefix", prefix: TEST_ONLY_PREFIX },
    },
  },
}));

const { composeEstimatingExplain } = await import("@/lib/agent/composed-sql");

describe("the restated estimating prefix strip is derived from the overlays", () => {
  test("a prefix an overlay declares is stripped on every engine, though no shipped engine declares it", () => {
    expect(composeEstimatingExplain("duckdb", `${TEST_ONLY_PREFIX} SELECT 1`).sql).toBe(`${TEST_ONLY_PREFIX} SELECT 1`);
    expect(composeEstimatingExplain("postgres", `${TEST_ONLY_PREFIX} SELECT 1`)).toEqual(
      composeEstimatingExplain("postgres", "SELECT 1"),
    );
  });
});
