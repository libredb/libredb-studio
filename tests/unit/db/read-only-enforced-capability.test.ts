import { describe, expect, test } from "bun:test";
import { READ_ONLY_ENFORCED, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { summarizeWriteReach } from "@/lib/db/write-reach";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `READ_ONLY_ENFORCED` against what each provider declares (#1089).
 *
 * The map is static because its readers decide before any provider exists: `assertReadOnlyHonoured`
 * refuses `readOnly: true` before anything is built or dialled, and the seed schema and the connection
 * form read `WRITE_REACH`, from which the map is derived. So the failure that matters is the map and the
 * provider disagreeing: an engine that enforces the mode and is refused it, or one the map calls
 * enforcing whose provider writes anyway, which would list a connection as read-only and send its
 * writes. This census builds every shipped provider and holds the map to the summary of its
 * `writeReach`, the provider's only answer: true exactly where that summary is not `open`.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a
 * constructor, the reading `CENSUS_CONNECTION` documents.
 */
describe("READ_ONLY_ENFORCED against each provider's own declaration (#1089)", () => {
  test("answers for every shipped type-id and for nothing else", () => {
    expect(Object.keys(READ_ONLY_ENFORCED).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: the map answers whether its provider's write reach is not open",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      expect(READ_ONLY_ENFORCED[type]).toBe(summarizeWriteReach(provider.getCapabilities().writeReach) !== "open");
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s declares no second read-only flag beside its write reach",
    async (type) => {
      // The write reach is the provider's one answer; a key spread in under the removed name would be a second one
      // that nothing holds equal to it.
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      expect(Object.keys(provider.getCapabilities())).not.toContain("enforcesReadOnly");
    },
  );
});
