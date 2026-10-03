/**
 * The Neo4j provider's labels (Neo4j provider spec 6.3).
 *
 * `statementLanguage` is what plan mode states verbatim after "Write it in" (`src/lib/agent/investigation.ts`),
 * so it carries what the read policy enforces: one statement, no writes, no LOAD CSV, no APOC or GDS, the
 * procedures CALL may name (read from the profile, so the two cannot drift), the SHOW forms, and how a name
 * that is not a plain word is quoted.
 *
 * Neo4j offers none of the operations the legacy analyze and vacuum cards send, and the provider declares no
 * maintenance operation, so those cards are never rendered; they are worded true anyway, as etcd's are.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { NEO4J_POLICY_PROFILE } from "./profile";

/** "a, b and c". */
function listed(names: readonly string[]): string {
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const STATEMENT_LANGUAGE = [
  "Read-only Cypher for Neo4j 5: one statement per run, no writes, no LOAD CSV, no APOC or GDS.",
  `CALL is limited to ${listed(NEO4J_POLICY_PROFILE.readPolicy.allowedProcedures)}.`,
  "SHOW is limited to indexes, constraints, databases, procedures and functions.",
  "Only built-in functions can be called; parameters are not supported.",
  "Quote labels, relationship types and property names that are not plain words with backticks.",
].join(" ");

export function neo4jLabels(): ProviderLabels {
  return {
    // The noun plan mode counts the whole inventory under: labels, relationship types, indexes and constraints.
    entityName: "graph object",
    entityNamePlural: "graph objects",
    rowName: "node",
    rowNamePlural: "nodes",
    selectAction: "Match Nodes",
    generateAction: "Generate Cypher",
    searchPlaceholder: "Search labels and relationship types...",
    statementLanguage: STATEMENT_LANGUAGE,
    slowQueriesEmptyState:
      "Neo4j Community keeps no query log, and this version does not read the Enterprise query log.",
    sessionsEmptyState: "No transaction is running.",
    tableStatsCaption: "Node counts per label, from the count store.",
    analyzeAction: "Label Statistics",
    vacuumAction: "Compact Store",
    analyzeGlobalLabel: "Statistics",
    analyzeGlobalTitle: "Not available",
    analyzeGlobalDesc: "Neo4j keeps its counts in the count store; the Tables tab reads them when it opens.",
    vacuumGlobalLabel: "Compact",
    vacuumGlobalTitle: "Not available",
    vacuumGlobalDesc: "Neo4j connections are read-only in this version: no maintenance operation runs.",
  };
}
