import { describe, expect, test } from "bun:test";
import { READS_FILE_ACCESS_POSTURE, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `READS_FILE_ACCESS_POSTURE` against what each provider declares (the non-admin DuckDB file-access
 * change).
 *
 * The map is static because its readers decide before any provider exists: `providerCacheKey` carries
 * the deny posture as a key segment so a denied and a full-reach handle of one connection never share
 * an entry, and `findOpenSingleWriterProvider` lends a handle only to a caller of its own posture.
 * Both run while computing the key to find or open a provider, so neither can ask one, and reading
 * `connection.type` at those call sites is forbidden by `CLAUDE.md`. So the failure that matters is
 * the map and the provider disagreeing: an engine whose provider opens under the posture that the map
 * leaves out would share one handle across postures, handing a denied caller a full-reach handle.
 * This census builds every shipped provider and holds the two equal.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor,
 * the reading `CENSUS_CONNECTION` documents.
 */
describe("READS_FILE_ACCESS_POSTURE against each provider's own declaration", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(READS_FILE_ACCESS_POSTURE).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s: the map answers what its provider declares", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(READS_FILE_ACCESS_POSTURE[type]).toBe(provider.getCapabilities().readsFileAccessPosture === true);
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s declares the flag as the literal true or not at all", async (type) => {
    // The comparison above reads anything but `true` as not having the posture, so only this can tell
    // a provider that declared the flag some other way from one that left it out.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect([undefined, true]).toContain(provider.getCapabilities().readsFileAccessPosture);
  });

  test("DuckDB is the engine that reads the posture, and it is the only one", () => {
    expect(READS_FILE_ACCESS_POSTURE.duckdb).toBe(true);
    const others = [...SHIPPED_DATABASE_TYPES].filter((type) => type !== "duckdb");
    expect(others.every((type) => READS_FILE_ACCESS_POSTURE[type] === false)).toBe(true);
  });
});
