/**
 * The fleet census of maintenance declarations (FND-4): every provider is built through the real
 * `createDatabaseProvider`, unconnected, and its `getCapabilities()` is held against the `maintenance` list of the
 * engine's `ENGINE_FACETS` row. The two maintenance routes refuse an operation the row does not list before any
 * provider is built, so a row that listed fewer operations than its provider would refuse one the engine runs, and a
 * row that listed more would let a request reach a provider that refuses it.
 *
 * The provider's capability is the measurement here: the operations each engine offers were read from these
 * capabilities when the row gained its `maintenance` list. When the two disagree, the repair is to the row or to the
 * provider after a recorded measurement, never to this census.
 *
 * It lives under `tests/isolated/` for the reason `monitoring-panels-census.test.ts` gives: it needs the real
 * factory, which every file under `tests/api/` mocks, and the runner gives each test file a process of its own.
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

describe("maintenance declarations across the fleet", () => {
  test.each([...ALL])(
    "the %s row declares the maintenance operations its unconnected provider declares, in order",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      expect([...ENGINE_FACETS[type].maintenance]).toEqual(provider.getCapabilities().maintenanceOperations);
    },
  );

  test("supportsMaintenance is true exactly where an engine's row lists an operation", async () => {
    const providers = await Promise.all(ALL.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const supports = Object.fromEntries(
      ALL.map((type, at) => [type, providers[at].getCapabilities().supportsMaintenance]),
    );
    expect(supports).toEqual(Object.fromEntries(ALL.map((type) => [type, ENGINE_FACETS[type].maintenance.length > 0])));
  });
});
