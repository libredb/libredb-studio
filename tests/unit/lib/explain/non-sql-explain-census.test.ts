import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { getExplainStrategy } from "@/lib/explain";
import { readsSqlText } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

/**
 * The explain gates count statements only in SQL text (Firestore spec 3.2), so an engine whose text is not SQL and that
 * declares an explain format is one whose provider enforces one statement itself. That set is pinned by name, from each
 * provider's own unconnected capabilities, so a second such engine is a reviewed change.
 */
describe("the non-SQL engines that declare an explain format", () => {
  test("are exactly firestore, whose strategy sends no background plan", async () => {
    const population = SHIPPED_DATABASE_TYPES.filter((type) => !readsSqlText(type));
    // Vacuity, by name: a population without the engine this pins would certify nothing.
    expect(population).toContain("firestore");
    const providers = await Promise.all(population.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const declaring: DatabaseType[] = population.filter(
      (_type, index) => providers[index].getCapabilities().explainFormat !== undefined,
    );
    expect(declaring).toEqual(["firestore"]);
    expect(getExplainStrategy("firestore-explain")?.backgroundPlan).toBe(false);
  });
});
