import { describe, expect, mock, test } from "bun:test";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";
import * as MYSQL from "@/lib/agent/languages/sql/engines/mysql";

/**
 * The restated-EXPLAIN strip follows the engine overlays, and the composer keeps no prefix list of its own.
 *
 * This file changes two overlays before anything that builds the strip is loaded: DuckDB declares a prefix no shipped
 * engine uses, and MySQL drops its `strippedWhenRestated: false`. A composer that spelled the prefixes itself would
 * strip neither, so both cases below fail against a hard-coded strip.
 *
 * `mock.module` is process-wide, so the substitution comes first and the composer is imported dynamically below it;
 * the runner gives this file its own process.
 */

const TEST_ONLY_PREFIX = "EXPLAIN PLAN FOR";

// Captured as plain objects before the substitution: the namespaces themselves follow the replacement.
const REAL_DUCKDB = { ...DUCKDB };
const REAL_MYSQL = { ...MYSQL };

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

mock.module("@/lib/agent/languages/sql/engines/mysql", () => ({
  ...REAL_MYSQL,
  MYSQL_SERVER_OVERLAY: {
    ...REAL_MYSQL.MYSQL_SERVER_OVERLAY,
    dialect: {
      ...REAL_MYSQL.MYSQL_SERVER_OVERLAY.dialect,
      planEstimate: { kind: "prefix", prefix: "EXPLAIN FORMAT=JSON" },
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

  test("a prefix whose overlay no longer opts out of the strip is stripped", () => {
    expect(composeEstimatingExplain("mysql", "EXPLAIN FORMAT=JSON SELECT 1").sql).toBe("EXPLAIN FORMAT=JSON SELECT 1");
    expect(composeEstimatingExplain("sqlite", "EXPLAIN FORMAT=JSON SELECT 1")).toEqual(
      composeEstimatingExplain("sqlite", "SELECT 1"),
    );
  });
});
