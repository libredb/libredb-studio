import { describe, expect, test } from "bun:test";
import { MASKING_EXEMPT_COLUMNS, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { createDatabaseProvider } from "@/lib/db/factory";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `maskingExemptColumns` CANNOT BE A HOLE THE SIZE OF THE RULES IT EXEMPTS FROM.
 *
 * The field lets a provider say that one of its result columns carries no personal data although
 * a built-in rule matches its NAME: Modbus answers a column called `address` that is a zero-based
 * PDU register. The danger is the obvious one: a pattern like `.*` would exempt every column of
 * that engine from every rule, and nothing else in the app would say so.
 *
 * What makes that danger hard to catch is that the cost is NOT IN THIS REPOSITORY. The rules
 * protect the user's own `customers.address`, so no search of our source can measure what a wide
 * pattern would expose. That is why the guard below is behavioural rather than syntactic: it does
 * not look for the characters `.*`, it MEASURES which protected column names a pattern reaches.
 * `[\s\S]*` and `^.+$` are just as wide and carry neither of those characters.
 *
 * The measurement is a NAMED SET, never a count. A count says how many protected names an
 * exemption touches, never WHICH, and the one that matters is exactly the one a count hides.
 */

/**
 * Every column name the built-in rules protect, read from the rules themselves rather than
 * written out here: a rule added later is covered without anyone remembering this file.
 */
const PROTECTED_NAMES: readonly string[] = DEFAULT_MASKING_CONFIG.patterns
  .filter((pattern) => pattern.enabled)
  .flatMap((pattern) => pattern.columnPatterns);

/** The protected names an exemption pattern would reach, by name. */
function protectedNamesReachedBy(columnPattern: string): string[] {
  const exempt = new RegExp(columnPattern);
  return PROTECTED_NAMES.filter((name) => exempt.test(name)).sort();
}

describe("the exemption guard measures reach rather than spelling", () => {
  test("the protected set it measures against is not empty", () => {
    // A VACUITY FLOOR, not a tolerance: it asks only whether there is a haystack to measure
    // against, because an empty one makes every pattern look narrow. It deliberately does not pin
    // the exact count (68 when this was written), which would fail on every new rule; the two
    // names below are what pin that the set is the real one.
    expect(PROTECTED_NAMES.length).toBeGreaterThan(20);
    expect(PROTECTED_NAMES).toContain("address");
    expect(PROTECTED_NAMES).toContain("ssn");
  });

  test.each([".*", "^.*$", "[\\s\\S]*", "^.+$", "a|b|.*"])("a catch-all pattern (%s) is seen as wide", (wide) => {
    // Each of these reaches the whole protected set; none of them contains a literal `.*` that a
    // spelling check could rely on in every case.
    expect(protectedNamesReachedBy(wide).length).toBe(PROTECTED_NAMES.length);
  });

  test("the pattern Modbus needs reaches exactly one protected name", () => {
    expect(protectedNamesReachedBy("^address$")).toEqual(["address"]);
  });

  test("an unanchored pattern reaches into a rule it was never about", () => {
    // Measured, and worse than "it covers a few more": `address` without anchors reaches every
    // protected name CONTAINING it, and `ip_address` belongs to the IP rule, not the address one.
    // So an exemption written for one column of one engine silently crosses into a second rule.
    expect(protectedNamesReachedBy("address")).toEqual([
      "address",
      "billing_address",
      "home_address",
      "ip_address",
      "shipping_address",
      "street_address",
    ]);
  });

  test("a pattern naming a column no rule protects reaches nothing", () => {
    expect(protectedNamesReachedBy("^register$")).toEqual([]);
  });
});

/**
 * THE RECORD, AND WHAT EACH OF ITS EXEMPTING ROWS IS ALLOWED TO REACH.
 *
 * `MASKING_EXEMPT_COLUMNS` in `src/lib/db/compatibility.ts` is the declaring set: Studio's review record of each
 * engine's exemption, the row its producers of client capabilities answer in place of the provider's own, held equal to
 * every provider's declaration below. `REACH` is the reviewed reach: the protected names each exempting row was accepted
 * for, by name. The census fails when a provider starts declaring the field without its row being written down, and
 * `REACH` fails when a row starts touching a different protected name than the one it was accepted for.
 */
const REACH: Readonly<Record<string, readonly string[]>> = { modbus: ["address"] };

/** The record's rows that exempt something, by type id. */
const exemptingRows = (): [DatabaseType, { readonly column: string; readonly reason: string }][] =>
  SHIPPED_DATABASE_TYPES.flatMap((type) => {
    const row = MASKING_EXEMPT_COLUMNS[type];
    return row === null ? [] : [[type, row] as [DatabaseType, typeof row]];
  });

describe("MASKING_EXEMPT_COLUMNS against each provider's own declaration, and what each row may reach", () => {
  test("MASKING_EXEMPT_COLUMNS answers for every shipped type-id and for nothing else, and it and each of its rows are frozen", () => {
    expect(Object.keys(MASKING_EXEMPT_COLUMNS).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(Object.isFrozen(MASKING_EXEMPT_COLUMNS)).toBe(true);
    for (const [type, row] of exemptingRows())
      expect({ type, frozen: Object.isFrozen(row) }).toEqual({ type, frozen: true });
  });

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: MASKING_EXEMPT_COLUMNS is the exemption its provider declares, null where it declares none",
    async (type) => {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      expect(MASKING_EXEMPT_COLUMNS[type]).toStrictEqual(capabilities.maskingExemptColumns ?? null);
    },
  );

  test("the record's exempting rows and REACH cannot drift apart", () => {
    // Written down separately, so this is the only thing keeping them one fact: a row added to the record without
    // naming what it reaches fails here, and so does a REACH entry left behind by a row set back to null.
    const exempting: string[] = exemptingRows().map(([type]) => type);
    expect(exempting.sort()).toEqual(Object.keys(REACH).sort());
  });

  test("each exempting row reaches exactly the protected names it was accepted for", () => {
    const reach: Record<string, string[]> = {};
    for (const [type, row] of exemptingRows()) reach[type] = protectedNamesReachedBy(row.column);
    expect(reach).toEqual(REACH as Record<string, string[]>);
  });

  test("every exempting row gives a reason a reader can act on", () => {
    for (const [type, row] of exemptingRows()) {
      // An exemption with no reason is a hole dug in two steps: the column stops being masked and
      // the screen has nothing to answer "why is this one not masked" with.
      expect({ type, long: row.reason.trim().length > 20 }).toEqual({ type, long: true });
    }
  });
});
