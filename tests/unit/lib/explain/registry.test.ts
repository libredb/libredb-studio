import { describe, test, expect } from "bun:test";
import { getExplainStrategy } from "@/lib/explain";
import type { ExplainFormat } from "@/lib/db/types";

/**
 * Every registered format. A Record rather than an array so that adding a member to
 * `ExplainFormat` without listing it here is a compile error, the same way the registry
 * itself is exhaustive.
 */
const EVERY_FORMAT: Record<ExplainFormat, true> = {
  "postgres-json": true,
  "postgres-text": true,
  "postgres-text-analyze": true,
  "mysql-json": true,
  "mysql-text": true,
  "sqlite-queryplan": true,
  "couchbase-json": true,
  "clickhouse-json": true,
  "druid-native": true,
  "trino-json": true,
  "duckdb-json": true,
};

/**
 * The estimate is what the editor asks for in the background beside every run of a
 * SELECT, so no strategy may build an executing form for it. `postgres-json` once
 * ignored the mode and answered `EXPLAIN (ANALYZE, ...)`, which ran every SELECT twice
 * (#1311). `ANALYZE` is the word every dialect here uses for its executing form.
 */
describe("the estimate mode never executes", () => {
  test.each(Object.keys(EVERY_FORMAT) as ExplainFormat[])("%s builds no ANALYZE for an estimate", (format) => {
    const built = getExplainStrategy(format)?.buildSql("SELECT 1", "estimate");
    expect(built).toBeString();
    expect(built).not.toMatch(/\bANALY[SZ]E\b/i);
  });
});

describe("getExplainStrategy", () => {
  test("resolves postgres-json", () => {
    expect(getExplainStrategy("postgres-json")?.format).toBe("postgres-json");
  });

  test("resolves mysql-json", () => {
    expect(getExplainStrategy("mysql-json")?.format).toBe("mysql-json");
  });

  test("resolves postgres-text", () => {
    expect(getExplainStrategy("postgres-text")?.format).toBe("postgres-text");
  });

  test("resolves postgres-text-analyze", () => {
    expect(getExplainStrategy("postgres-text-analyze")?.format).toBe("postgres-text-analyze");
  });

  test("resolves mysql-text", () => {
    expect(getExplainStrategy("mysql-text")?.format).toBe("mysql-text");
  });

  test("returns null for undefined (provider without explain support)", () => {
    expect(getExplainStrategy(undefined)).toBeNull();
  });
});
