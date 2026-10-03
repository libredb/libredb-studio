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

/**
 * Every reason one spec's typed-target confirmation could not be asked for (spec 3.11). The target's own name is asked
 * on a per-row control only, so the spec must offer one; and it must not offer a whole-database card, which has no
 * target to name and, since the Operations tab asks on a card only for `"typed"`, would send with one click.
 */
function typedTargetProblems(spec: MaintenanceOperationSpec): string[] {
  const problems: string[] = [];
  if (!spec.perEntity) problems.push("perEntity is false, and the target's name is asked on a per-row control only");
  if (spec.global) problems.push("global is true, and a whole-database card has no target name to ask for");
  return problems;
}

/** Every reason one spec's typed confirmation could not be asked for; empty when it can, or when it asks for none. */
function typedConfirmationProblems(spec: MaintenanceOperationSpec): string[] {
  if (spec.confirmation === undefined) return [];
  if (spec.confirmation === "typed-target") return typedTargetProblems(spec);
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

/** A typed-target confirmation a per-row control can ask for (spec 3.11): the object's own name, on its row. */
const ASKS_FROM_ITS_ROW: MaintenanceOperationSpec = {
  label: "Load Object",
  perEntity: true,
  global: false,
  confirmation: "typed-target",
};

const ROW_ONLY = "perEntity is false, and the target's name is asked on a per-row control only";
const NO_CARD = "global is true, and a whole-database card has no target name to ask for";

describe("typedConfirmationProblems for a typed-target confirmation (spec 3.11)", () => {
  test("a spec that asks from its row has nothing wrong with it, with or without a title and description", () => {
    expect(typedConfirmationProblems(ASKS_FROM_ITS_ROW)).toEqual([]);
    expect(
      typedConfirmationProblems({ ...ASKS_FROM_ITS_ROW, title: "Load the object", description: "Loads it." }),
    ).toEqual([]);
  });

  test.each<[string, MaintenanceOperationSpec, string[]]>([
    ["perEntity: false", { ...ASKS_FROM_ITS_ROW, perEntity: false }, [ROW_ONLY]],
    ["global: true", { ...ASKS_FROM_ITS_ROW, global: true }, [NO_CARD]],
    [
      "perEntity: false and global: true",
      { ...ASKS_FROM_ITS_ROW, perEntity: false, global: true },
      [ROW_ONLY, NO_CARD],
    ],
  ])("refuses a typed-target confirmation with %s", (_label, spec, problems) => {
    expect(typedConfirmationProblems(spec)).toEqual(problems);
  });

  test("a typed confirmation is still held to its card, whatever a typed target allows", () => {
    expect(typedConfirmationProblems({ ...ASKS_FROM_ITS_CARD, perEntity: true })).toEqual([
      "perEntity is true, and no per-row control asks for a typed confirmation",
    ]);
  });
});

/**
 * Every reason one spec's preview could not be shown (spec 3.11). The preview is drawn by the per-row dialog and served
 * by the provider's `previewMaintenance`, so a spec that offers no row, or a provider without the method, declares a
 * preview nothing can show.
 */
function previewProblems(spec: MaintenanceOperationSpec, hasPreviewMethod: boolean): string[] {
  if (spec.preview !== true) return [];
  const problems: string[] = [];
  if (!spec.perEntity) problems.push("perEntity is false, and the preview is drawn by a per-row control only");
  if (!hasPreviewMethod) problems.push("the provider has no previewMaintenance to answer it");
  return problems;
}

describe("previewProblems (spec 3.11)", () => {
  test("a per-row preview from a provider that answers it has nothing wrong with it", () => {
    expect(previewProblems({ ...ASKS_FROM_ITS_ROW, preview: true }, true)).toEqual([]);
  });

  test("a spec that declares no preview is not held to the method", () => {
    expect(previewProblems(ASKS_FROM_ITS_ROW, false)).toEqual([]);
  });

  test("refuses a preview no row offers, and one no method answers", () => {
    expect(previewProblems({ ...ASKS_FROM_ITS_ROW, perEntity: false, preview: true }, false)).toEqual([
      "perEntity is false, and the preview is drawn by a per-row control only",
      "the provider has no previewMaintenance to answer it",
    ]);
  });
});

describe("every shipped provider's previews can be shown (spec 3.11)", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const specs = provider.getCapabilities().maintenanceOperationSpecs ?? {};
    const hasPreviewMethod = typeof provider.previewMaintenance === "function";
    const problems = Object.entries(specs).flatMap(([operation, spec]) =>
      spec === undefined ? [] : previewProblems(spec, hasPreviewMethod).map((problem) => `${operation}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });
});
