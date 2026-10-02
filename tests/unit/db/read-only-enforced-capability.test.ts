import { describe, expect, test } from "bun:test";
import { READ_ONLY_ENFORCED, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `READ_ONLY_ENFORCED` against what each provider declares (#1089).
 *
 * The map is static because its readers decide before any provider exists: the seed schema refuses
 * `readOnly: true` at load, `assertReadOnlyHonoured` refuses it before anything is built or dialled,
 * and the connection form draws its toggle, each from this map. So the failure that matters is the
 * map and the provider disagreeing: an engine that enforces the mode and is refused it, or one the
 * map calls enforcing whose provider writes anyway, which would list a connection as read-only and
 * send its writes. This census builds every shipped provider and holds the two equal.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a
 * constructor, the reading `CENSUS_CONNECTION` documents.
 */
describe("READ_ONLY_ENFORCED against each provider's own declaration (#1089)", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(READ_ONLY_ENFORCED).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s: the map answers what its provider declares", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(READ_ONLY_ENFORCED[type]).toBe(provider.getCapabilities().enforcesReadOnly === true);
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s declares the flag as the literal true or not at all", async (type) => {
    // The comparison above reads anything but `true` as not enforcing, so only this can tell a
    // provider that declared the flag some other way from one that left it out.
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect([undefined, true]).toContain(provider.getCapabilities().enforcesReadOnly);
  });
});
