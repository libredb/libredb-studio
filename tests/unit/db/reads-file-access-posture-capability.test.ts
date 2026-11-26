import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const readsFileAccessPosture = legacyRegisterTable("readsFileAccessPosture");

/**
 * The file-access posture of every shipped engine's legacy row in the grant register, Studio's review of
 * `policy.readsFileAccessPosture`, against what each provider declares (the non-admin DuckDB file-access change).
 *
 * The grant is static because its readers decide before any provider exists: `providerCacheKey` carries
 * the deny posture as a key segment so a denied and a full-reach handle of one connection never share
 * an entry, and `findOpenSingleWriterProvider` lends a handle only to a caller of its own posture.
 * Both run while computing the key to find or open a provider, so neither can ask one, and reading
 * `connection.type` at those call sites is forbidden by `CLAUDE.md`. So the failure that matters is
 * the grant and the provider disagreeing: an engine whose provider opens under the posture that the grant
 * leaves out would share one handle across postures, handing a denied caller a full-reach handle.
 * This census builds every shipped provider and holds the two equal.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor,
 * the reading `CENSUS_CONNECTION` documents.
 */
describe("the legacy rows' file-access posture against each provider's own declaration", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s: the map answers what its provider declares", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(readsFileAccessPosture[type]).toBe(provider.getCapabilities().readsFileAccessPosture === true);
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s declares the flag as the literal true or not at all", async (type) => {
    // The comparison above reads anything but `true` as not having the posture, so only this can tell
    // a provider that declared the flag some other way from one that left it out.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect([undefined, true]).toContain(provider.getCapabilities().readsFileAccessPosture);
  });

  test("SQLite and DuckDB read the file-access posture", () => {
    expect(readsFileAccessPosture.duckdb).toBe(true);
    expect(readsFileAccessPosture.sqlite).toBe(true);
    const others = [...SHIPPED_DATABASE_TYPES].filter((type) => type !== "duckdb" && type !== "sqlite");
    expect(others.every((type) => readsFileAccessPosture[type] === false)).toBe(true);
  });
});
