/**
 * Studio's engine catalog as a projection of a set of admitted engine declarations (docs/providers/CONTRACT.md, clause
 * M-70).
 *
 * The catalog answers which engines Studio ships, whether each is an engine the user already runs (`external`) or the
 * store Studio carries with it (`embedded`), and how long the host waits for an open of each: one entry per declaration,
 * holding its `location` and its `connection.connectBudgetMs`, keyed by its `id`. Those three members are the ones a
 * declaration authors (scripts/generate-engine-declarations.ts, `AUTHORED_MEMBERS`), so the catalog reads nothing the
 * declaration generator writes.
 *
 * The projection is pure: its keys are the ids in ascending code-unit order, so the same set gives the same catalog
 * whatever order it is admitted in, and removing a declaration gives exactly what a fresh build from the rest gives.
 * Two declarations of one id are refused by name before any entry is built.
 *
 * `scripts/generate-engine-catalog.ts` admits every committed declaration through the SDK's validator, projects the set
 * here and renders the result into `catalog.generated.ts`, the module Studio's readers read. A loader that admits a
 * provider package at run time projects its set through this same function.
 */
import type { ConnectBudget, EngineDeclaration, EngineLocation } from "@libredb/provider-sdk/manifest";

/** One engine's catalog entry: where the engine lives and its connect budget, null for the host's default. */
export interface CatalogEntry {
  readonly location: EngineLocation;
  readonly connectBudgetMs: ConnectBudget;
}

/** A catalog: one frozen entry per engine id, keyed in ascending code-unit order of the ids. */
export type EngineCatalog = Readonly<Record<string, CatalogEntry>>;

/**
 * The catalog of `declarations`, frozen with every entry.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
export function projectCatalog(declarations: readonly EngineDeclaration[]): EngineCatalog {
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) throw new Error(`The engine id ${JSON.stringify(declaration.id)} is declared twice.`);
    seen.add(declaration.id);
  }
  const ordered = [...declarations].sort((a, b) => (a.id < b.id ? -1 : 1));
  return Object.freeze(
    Object.fromEntries(
      ordered.map((declaration) => [
        declaration.id,
        Object.freeze({ location: declaration.location, connectBudgetMs: declaration.connection.connectBudgetMs }),
      ]),
    ),
  );
}
