import { describe, test, expect } from "bun:test";

// `data-masking.ts` guards on `typeof window !== "undefined"`, as its sibling test does.
if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub for the SSR guard
  globalThis.window = globalThis;
}
import { detectSensitiveColumnsFromConfig, maskValueByPattern, DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";

/**
 * THE ADDRESS RULE, PINNED BECAUSE NOTHING ELSE PINS IT.
 *
 * Measured on 2026-10-14: `builtin-address` occurred exactly ONCE in the repository, its own
 * definition in `src/lib/data-masking.ts`. No test and no document named it, so every property
 * below could have changed in silence — including the one that matters, that the rule still
 * fires at all.
 *
 * Why this rule earns its own file: what it protects is never in this repository. It matches a
 * column NAME, and the real postal address lives in the user's own `customers.address`, so no
 * search of our source can measure the cost of loosening it. The engine that made the question
 * urgent is Modbus, whose `address` column is a register number rather than a place
 * (`src/lib/db/providers/industrial/modbus/read.ts`); the exemption that engine needs must be
 * built BESIDE this rule, not by widening or narrowing it, and these tests are what will say so
 * if someone reaches for the rule instead.
 */

const rule = (field: string) => detectSensitiveColumnsFromConfig([field], DEFAULT_MASKING_CONFIG).get(field);

describe("the built-in address rule", () => {
  test("fires on a column named address, and the value does not survive it", () => {
    const pattern = rule("address");
    expect(pattern?.id).toBe("builtin-address");
    // A rule that matches but returns its input would pass every other assertion here.
    const masked = maskValueByPattern("221B Baker Street", pattern!);
    expect(masked).not.toBe("221B Baker Street");
    expect(masked).not.toContain("Baker");
  });

  /**
   * Every pattern the rule carries is named here rather than counted. A count says how many
   * survived, never WHICH, so a list that quietly loses `home_address` keeps a count-based
   * check green. Each name is its own case so a failure says which one went.
   */
  test.each(["address", "street", "street_address", "home_address", "billing_address", "shipping_address"])(
    "covers %s",
    (field) => {
      expect(rule(field)?.id).toBe("builtin-address");
    },
  );

  test("the patterns are anchored, so a column that merely ends in address is untouched", () => {
    // `^pattern$` in `detectSensitiveColumnsFromConfig`. This is what keeps the rule from
    // swallowing every column with the word in it, and what makes `address` itself the only
    // collision an engine can hit.
    for (const field of ["register_address", "mac_address", "addressing", "address_of_record"]) {
      expect({ field, rule: rule(field)?.id }).toEqual({ field, rule: undefined });
    }
  });

  test("a repeated column is masked like the column it repeats", () => {
    // A result numbers a repeated column `address (2)` (`uniqueFieldNames`); the masker resolves
    // the base name, so the second one cannot arrive unmasked.
    expect(rule("address (2)")?.id).toBe("builtin-address");
  });

  test("matching is on the name alone, with no type and no engine in reach", () => {
    // The signature takes `(fields: string[], config)` — there is no column type and no engine
    // identity here. Any exemption therefore has to be decided by the CALLER, and this test
    // fails the moment someone makes the rule itself engine-aware without saying so.
    const byName = detectSensitiveColumnsFromConfig(["address"], DEFAULT_MASKING_CONFIG);
    expect(byName.get("address")?.id).toBe("builtin-address");
    expect(byName.size).toBe(1);
  });
});
