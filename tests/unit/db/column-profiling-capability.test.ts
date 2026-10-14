import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { offersColumnProfiling, type ProviderCapabilities } from "@/lib/db/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `supportsColumnProfiling` across every shipped provider.
 *
 * The opt-out withholds the column profiler from an SQL engine, whose profile is otherwise offered by the language
 * rule alone. Snowflake declares it because a profile's full-column scans bill a warehouse on every click and cannot
 * be cancelled, and Apache Spark because they run full-scan aggregate jobs on lake tables, on a cluster other users
 * share; declared anywhere else it would take the profiler from an engine where it costs nothing. So the declaring
 * set is held to `["snowflake", "spark"]`, read from the census connection, and every other provider leaves the
 * field absent.
 */
describe("supportsColumnProfiling across the shipped providers", () => {
  test("snowflake and spark are the declarers", async () => {
    const declarers: string[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      if (capabilities.supportsColumnProfiling !== undefined) declarers.push(type);
    }
    expect(declarers).toEqual(["snowflake", "spark"]);
  });

  test("snowflake declares false and is not offered the profiler", async () => {
    const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION.snowflake)).getCapabilities();
    expect(capabilities.supportsColumnProfiling).toBe(false);
    expect(offersColumnProfiling(capabilities)).toBe(false);
  });

  test("spark declares false and is not offered the profiler", async () => {
    const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION.spark)).getCapabilities();
    expect(capabilities.supportsColumnProfiling).toBe(false);
    expect(offersColumnProfiling(capabilities)).toBe(false);
  });
});

describe("offersColumnProfiling and the opt-out", () => {
  const sql = { queryLanguage: "sql" } as ProviderCapabilities;

  test("an SQL engine declaring false is not offered the profiler", () => {
    expect(offersColumnProfiling({ ...sql, supportsColumnProfiling: false })).toBe(false);
  });

  test("an SQL engine without the field keeps the SQL rule", () => {
    expect(offersColumnProfiling(sql)).toBe(true);
  });

  test("a non-SQL engine keeps its answer", () => {
    expect(offersColumnProfiling({ queryLanguage: "json" } as ProviderCapabilities)).toBe(true);
    expect(offersColumnProfiling({ queryLanguage: "promql" } as ProviderCapabilities)).toBe(false);
  });
});
