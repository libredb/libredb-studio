/**
 * Which engines have a graph policy profile, as a population (#1722).
 *
 * WHY THIS FILE EXISTS. MEASURED by searching the suite: before it, `src/lib/db/graph-policy-profiles.ts`
 * was named by NO test at all. The record behind `graphPolicyProfileOf` is a
 * `Partial<Record<DatabaseType, ...>>`, so a new type id compiles without a row and the function
 * answers `undefined` for it. That is the right answer for every engine that is not a graph, and it
 * is also the right answer for a graph engine whose row someone forgot: the two are
 * indistinguishable without a population this file pins.
 *
 * It walks EVERY shipped type id rather than asserting about one, because the gap this closes is the
 * repository's and not one provider's: the file was unheld when MTConnect's registration measured it
 * (#1722), and the four registrations queued behind that one each add a type id this loop will reach.
 *
 * What it deliberately does NOT do is restate the profile's contents. The Cypher read policy, its
 * denied words and its allowed procedures are held by the graph provider's own suites, where a change
 * to them is a change to behaviour that has tests. Here the question is only which engines get one.
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { graphPolicyProfileOf } from "@/lib/db/graph-policy-profiles";

describe("the graph policy profile population", () => {
  test("the census population is the whole shipped fleet, driven and not typed", () => {
    // Asserted first: a short or empty list would make every loop below certify nothing.
    expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(30);
    expect(SHIPPED_DATABASE_TYPES).toContain("neo4j");
  });

  test("exactly one shipped engine has a profile, and it is the graph one", () => {
    const withProfile = SHIPPED_DATABASE_TYPES.filter((type) => graphPolicyProfileOf(type) !== undefined);
    expect(withProfile).toEqual(["neo4j"]);
  });

  test("every other engine answers undefined, each reached by name", () => {
    // Named one at a time rather than counted: a count is satisfied by any set of the right size.
    const unexpected = SHIPPED_DATABASE_TYPES.filter(
      (type) => type !== "neo4j" && graphPolicyProfileOf(type) !== undefined,
    ).map((type) => `${type} has a graph policy profile`);
    expect(unexpected).toEqual([]);
    // And the one this census was written for, by name: MTConnect reads an agent over HTTP, which is
    // not a graph, so the absence is the answer rather than an omission (#1722).
    expect(graphPolicyProfileOf("mtconnect")).toBeUndefined();
  });

  test("the profile that exists is a profile, so the population is not vacuously one of nothing", () => {
    const profile = graphPolicyProfileOf("neo4j");
    expect(profile?.engineLabel).toBe("Neo4j");
    // Three parts, named: a label, a read policy and a dialect. Their CONTENTS belong to the graph
    // provider's own suites, which is why nothing here restates them.
    expect(Object.keys(profile ?? {}).sort()).toEqual(["dialect", "engineLabel", "readPolicy"]);
  });

  test("no type at all answers undefined too, which is how the editor asks before a connection", () => {
    expect(graphPolicyProfileOf(undefined)).toBeUndefined();
  });

  /*
   * NOT COVERED HERE, ON PURPOSE: a name that is not a type id.
   *
   * MEASURED while writing this file: `graphPolicyProfileOf("constructor")` answers `Object` rather
   * than `undefined`, because the lookup is a plain index into a frozen object literal and not an
   * own-key read. The repository guards that hazard elsewhere - `context-snapshot.ts` says so where
   * it resolves a kind word - so this is a gap rather than a decision. It is NOT asserted here
   * either way: a test that pinned the current answer would bless it, and a test that pinned
   * `undefined` would fail until the source is fixed, which is a shared file and not this change's.
   * Its consequence was measured and is narrow: the only reader is the editor's Cypher completion
   * provider (`QueryEditor.tsx:647`, behind `language === CYPHER_LANGUAGE_ID`), and the policy that
   * actually refuses a write comes from the provider's own import of `NEO4J_POLICY_PROFILE`, never
   * from this lookup. Reported to the chain rather than fixed in passing.
   */
});
