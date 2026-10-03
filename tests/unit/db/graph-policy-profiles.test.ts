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
