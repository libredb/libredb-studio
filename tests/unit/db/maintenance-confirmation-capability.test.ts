import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { MaintenanceOperationSpec } from "@/lib/db/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * A typed confirmation on a maintenance spec, held to the one place that asks for it (#1089, section 7.2).
 *
 * The Operations tab asks for the connection's name on a declared global card only, and its dialog takes its title
 * and its body from the spec's `title` and `description`. So a spec that declares `confirmation` beside
 * `perEntity: true` promises a question no per-row control asks, and one without `title` or `description` promises
 * a dialog with no words: the declaration would say the operation asks while nothing does.
 *
 * Nothing here connects: `createDatabaseProvider` builds each provider over `CENSUS_CONNECTION`'s unconnected
 * configuration, and `getCapabilities()` is a declaration.
 */

/** Every reason one spec's typed confirmation could not be asked for; empty when it can, or when it asks for none. */
function typedConfirmationProblems(spec: MaintenanceOperationSpec): string[] {
  if (spec.confirmation === undefined) return [];
  const problems: string[] = [];
  if (spec.perEntity) problems.push("perEntity is true, and no per-row control asks for a typed confirmation");
  if (!spec.title) problems.push("no title, which the typed dialog takes as its title");
  if (!spec.description) problems.push("no description, which the typed dialog takes as its body");
  return problems;
}

/** A typed confirmation the Operations tab can ask for: etcd's compaction, in its provider's words. */
const ASKS_FROM_ITS_CARD: MaintenanceOperationSpec = {
  label: "Compact history",
  title: "Compact history",
  description: "Removes every revision before the current one.",
  perEntity: false,
  global: true,
  confirmation: "typed",
};

describe("typedConfirmationProblems (#1089)", () => {
  test("a spec that asks from its declared card has nothing wrong with it", () => {
    expect(typedConfirmationProblems(ASKS_FROM_ITS_CARD)).toEqual([]);
  });

  test("a spec that asks for nothing is not held to the card's fields", () => {
    expect(typedConfirmationProblems({ label: "Vacuum Table", perEntity: true, global: true })).toEqual([]);
  });

  test.each<[string, MaintenanceOperationSpec, string]>([
    [
      "perEntity: true",
      { ...ASKS_FROM_ITS_CARD, perEntity: true },
      "perEntity is true, and no per-row control asks for a typed confirmation",
    ],
    ["no title", { ...ASKS_FROM_ITS_CARD, title: undefined }, "no title, which the typed dialog takes as its title"],
    ["an empty title", { ...ASKS_FROM_ITS_CARD, title: "" }, "no title, which the typed dialog takes as its title"],
    [
      "no description",
      { ...ASKS_FROM_ITS_CARD, description: undefined },
      "no description, which the typed dialog takes as its body",
    ],
    [
      "an empty description",
      { ...ASKS_FROM_ITS_CARD, description: "" },
      "no description, which the typed dialog takes as its body",
    ],
  ])("refuses a typed confirmation with %s", (_label, spec, problem) => {
    expect(typedConfirmationProblems(spec)).toEqual([problem]);
  });
});

describe("every shipped provider's typed confirmations can be asked for (#1089)", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const specs = provider.getCapabilities().maintenanceOperationSpecs ?? {};
    const problems = Object.entries(specs).flatMap(([operation, spec]) =>
      spec === undefined ? [] : typedConfirmationProblems(spec).map((problem) => `${operation}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });
});
