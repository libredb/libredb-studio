import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";

/**
 * The repository directory of a statement language's core family module, `/`-joined from the repository root.
 *
 * The provider plugin program gives each statement language one core home for the vocabulary every provider of that
 * language reads (fnd8 D2): `src/lib/sql/` for `sql`, `src/lib/db/graph/cypher/` for `cypher`, and
 * `src/lib/languages/<language>/` for every other value of `AGENT_STATEMENT_LANGUAGE`.
 * docs/PROVIDER_IMPORTS.md, "Slices of PR 8", is the record of which modules have moved there; each language slice
 * reads the rule from here, so its tests and this one agree on where a family's module lives.
 *
 * The path is joined with `/` rather than `path.join`, so it compares equal to an import specifier on every platform.
 */
export function statementLanguageFamilyDirectory(language: AgentStatementLanguageId): string {
  if (language === "sql") return "src/lib/sql";
  if (language === "cypher") return "src/lib/db/graph/cypher";
  return `src/lib/languages/${language}`;
}
