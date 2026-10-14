import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * Which shipped providers declare `hasRunsInFlight()`, the answer the factory's idle sweep reads before it closes an
 * idle cached provider.
 *
 * A provider declares it when its `disconnect()` ends a statement still running, so that closing it while a run polls
 * would cancel a run somebody is waiting on. Snowflake declares it: its `disconnect()` cancels every statement still
 * running or waiting. Apache Spark declares it too: its `disconnect()` cancels every run and releases every session
 * it holds. A provider that starts to declare it flips its row here in the same change. Nothing here
 * connects: `createDatabaseProvider` builds each provider over `CENSUS_CONNECTION`.
 */
const DECLARES: Record<DatabaseType, boolean> = {
  ...Object.fromEntries(SHIPPED_DATABASE_TYPES.map((type) => [type, false])),
  snowflake: true,
  spark: true,
} as Record<DatabaseType, boolean>;

describe("hasRunsInFlight across the shipped providers", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s declares it only where the record says so", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(typeof provider.hasRunsInFlight === "function").toBe(DECLARES[type]);
  });

  test("every declarer's unconnected provider answers false without throwing", async () => {
    const declarers = await Promise.all(
      SHIPPED_DATABASE_TYPES.filter((candidate) => DECLARES[candidate]).map((type) =>
        createDatabaseProvider(CENSUS_CONNECTION[type]),
      ),
    );
    for (const provider of declarers) expect(provider.hasRunsInFlight?.()).toBe(false);
  });
});
