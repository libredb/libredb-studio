import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";
import { graphPolicyProfileOf } from "@/lib/db/graph-policy-profiles";
import { NEO4J_ENGINE_PROFILE } from "@/lib/db/providers/graph/neo4j";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `graphPolicyProfileOf` against what each provider declares (Neo4j spec 6.5, SR6).
 *
 * The registry is partial, so a graph engine left out of it answers undefined, and the editor then
 * offers no completion after `CALL` or `SHOW` on that engine's connections without any other test
 * failing. This census builds every shipped provider and holds the registry to the providers that
 * declare `queryLanguage: "cypher"`: each has an entry, the entry is the policy half of the profile
 * the provider itself runs on, and no other engine has one.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a
 * constructor, the reading `CENSUS_CONNECTION` documents.
 */
async function providerProfileOf(type: (typeof SHIPPED_DATABASE_TYPES)[number]) {
  const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
  const cypher = provider.getCapabilities().queryLanguage === "cypher";
  // `profile` is protected on GraphBaseProvider; the census reads it to compare like with like.
  const own = cypher ? (provider as unknown as { profile: GraphPolicyProfile }).profile : undefined;
  return { cypher, own };
}

describe("graphPolicyProfileOf against each provider's own declaration (SR6)", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s: a profile exactly when the provider speaks Cypher", async (type) => {
    const { cypher, own } = await providerProfileOf(type);
    const registered = graphPolicyProfileOf(type);
    if (!cypher) {
      expect(registered).toBeUndefined();
      return;
    }
    expect(registered).toBeDefined();
    expect(registered?.engineLabel).toBe(own?.engineLabel);
    expect(registered?.readPolicy).toBe(own?.readPolicy);
    expect(registered?.dialect).toBe(own?.dialect);
  });

  test("Neo4j's entry is the policy half of NEO4J_ENGINE_PROFILE", () => {
    const registered = graphPolicyProfileOf("neo4j");
    expect(registered?.engineLabel).toBe(NEO4J_ENGINE_PROFILE.engineLabel);
    expect(registered?.readPolicy).toBe(NEO4J_ENGINE_PROFILE.readPolicy);
    expect(registered?.dialect).toBe(NEO4J_ENGINE_PROFILE.dialect);
  });
});

/*
 * BELOW: a population census added beside the cross-check above, not in place of it (#1722).
 *
 * WHAT HAPPENED, recorded because the mistake is instructive. The cross-check above could not LOAD
 * on the install this branch was measured against - 820 entries, `neo4j-driver-lite` absent - so the
 * runner reported the file as a failure with no tests, and the registration audit of #1722 read that
 * as "no test walks this record". It then REPLACED this file with a version that imports no provider.
 * The count of lines went up and the claim being held went down: the registry's agreement with each
 * provider's own declaration - `engineLabel`, `readPolicy`, `dialect`, through a real
 * `createDatabaseProvider` - was gone, and nothing else in the repository holds it (measured: of the
 * ten test files that name `readPolicy`, none builds a provider).
 *
 * A test that cannot run is a reason to fix the environment, never a reason to weaken the test. The
 * original is restored verbatim and what #1722 wrote is kept here, because the two ask different
 * questions: above, does the registry agree with the provider; below, is the population the whole
 * fleet and is the absence the answer for every engine that is not a graph.
 */
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
