import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `supportsSqlFormat` across every shipped provider.
 *
 * The opt-out withholds the editor's Format action from an engine whose valid text the shared SQL formatter rewrites.
 * Apache Spark declares it, because both sql-formatter modes corrupt raw strings, backtick names and nested comments
 * alike; declared anywhere else it would take Format from an engine where it works. So the declaring set is held
 * to `["spark"]`, read from the census connection, and every other provider leaves the field absent.
 */
describe("supportsSqlFormat across the shipped providers", () => {
  test("spark is the one declarer", async () => {
    const declarers: string[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      if (capabilities.supportsSqlFormat !== undefined) declarers.push(type);
    }
    expect(declarers).toEqual(["spark"]);
  });

  test("spark declares false", async () => {
    const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION.spark)).getCapabilities();
    expect(capabilities.supportsSqlFormat).toBe(false);
  });
});
