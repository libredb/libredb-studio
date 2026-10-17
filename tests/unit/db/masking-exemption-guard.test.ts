import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
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
 * THE FLEET, AND WHAT EACH DECLARER IS ALLOWED TO REACH.
 *
 * Both halves are named sets. `DECLARERS` fails when an engine starts declaring the field without
 * anyone writing down what it touches; `REACH` fails when a declared pattern starts touching a
 * different protected name than the one it was accepted for.
 */
const DECLARERS: readonly DatabaseType[] = ["modbus"];
const REACH: Readonly<Record<string, readonly string[]>> = { modbus: ["address"] };

describe("maskingExemptColumns across the shipped providers", () => {
  test("the two named sets cannot drift apart", () => {
    // Written down separately, so this is the only thing keeping them one fact. While
    // `DECLARERS` is empty the two tests below iterate nothing and measure nothing; the sweep
    // immediately after is what makes them live, by failing the moment an engine declares the
    // field without being written down here.
    expect(Object.keys(REACH).sort()).toEqual([...DECLARERS].sort());
  });

  test("the declaring set is the one written down here", async () => {
    const declarers: string[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      if (capabilities.maskingExemptColumns !== undefined) declarers.push(type);
    }
    expect(declarers.sort()).toEqual([...DECLARERS].sort());
    // Measured: building every shipped provider takes about 2.1 s on an idle machine and over
    // 5 s under load, so the default 5 s timeout fails this test for the machine's reasons
    // rather than the fleet's. The sibling census (`column-profiling-capability.test.ts`) runs
    // the same sweep inside that default and is the test that will flake first.
  }, 30_000);

  test("each declarer reaches exactly the protected names it was accepted for", async () => {
    const reach: Record<string, string[]> = {};
    for (const type of DECLARERS) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      const declared = capabilities.maskingExemptColumns;
      expect({ type, declared: declared !== undefined }).toEqual({ type, declared: true });
      reach[type] = protectedNamesReachedBy(declared!.column);
    }
    expect(reach).toEqual(REACH as Record<string, string[]>);
  }, 30_000);

  test("every declarer gives a reason a reader can act on", async () => {
    for (const type of DECLARERS) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      const reason = capabilities.maskingExemptColumns?.reason ?? "";
      // An exemption with no reason is a hole dug in two steps: the column stops being masked and
      // the screen has nothing to answer "why is this one not masked" with.
      expect({ type, long: reason.trim().length > 20 }).toEqual({ type, long: true });
    }
  }, 30_000);
});
