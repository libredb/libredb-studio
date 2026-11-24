import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";

/**
 * The fixture engine of the removal tests (docs/providers/CONTRACT.md, clause M-70): `base` declared as `acmefoo`, the
 * id the FND-1 tests give a stored connection of an engine no provider serves, named "Acme Foo", with a connect budget
 * of 90 s.
 *
 * Every authored member differs from every shipped engine's, so its catalog entry is one no shipped engine has: adding
 * it to the admitted set adds exactly that entry, and removing it again is visible in every projection that read it.
 */
export function fixtureEngineDeclaration(base: EngineDeclaration): EngineDeclaration {
  return {
    ...base,
    id: "acmefoo",
    displayName: "Acme Foo",
    connection: { ...base.connection, connectBudgetMs: 90_000 },
  };
}
