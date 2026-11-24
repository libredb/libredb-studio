/**
 * The fleet census of the inventory's configuration question (`DatabaseProvider.inventoryNeedsConfiguration`): every
 * provider is built through the real `createDatabaseProvider`, unconnected, and read for the member and its
 * capabilities' container levels.
 *
 * The legacy bridge answers the question on the tree's top-level `containers` listing (docs/providers/CONTRACT.md,
 * clauses C-50 and C-61), and the agent's grounding walk reads it there, on its first read. An engine with no container
 * level reads no top-level listing, so a provider that declared the member without a level would never be asked; this
 * census holds that none does.
 *
 * It lives under `tests/isolated/` for the reason `object-source-declarations.test.ts` gives: it needs the real
 * factory, which every file under `tests/api/` mocks, and the runner gives each test file a process of its own.
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

describe("the inventory's configuration question across the fleet", () => {
  test("every shipped provider that answers the inventory's configuration question declares a container level, so the grounding walk asks it on its top-level listing", async () => {
    const providers = await Promise.all(ALL.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const asking = ALL.filter((_type, at) => typeof providers[at].inventoryNeedsConfiguration === "function");
    const levelless = asking.filter(
      (type) => (providers[ALL.indexOf(type)].getCapabilities().containerLevels ?? []).length === 0,
    );

    expect(asking.length).toBeGreaterThan(0);
    expect(levelless).toEqual([]);
  });
});
