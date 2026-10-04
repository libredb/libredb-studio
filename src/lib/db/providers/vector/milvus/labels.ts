/**
 * The Milvus provider's labels.
 *
 * `statementLanguage` is what plan mode states verbatim after "Write it in" (`src/lib/agent/investigation.ts`), the one
 * fact about how a request is written that its prompt carries per engine. It is built by one function from routes.ts
 * through `routeListText`, never written by hand, so the sentence and the route table cannot drift: the read
 * routes in the table's order, two examples the real parser accepts, the count form, and what is not a request, Load
 * and Release among them, so a plan cannot draft one and the agent never loads.
 * `tests/unit/db/milvus/labels.test.ts` reads it whole against a golden text.
 *
 * Browser-safe: it imports the shared console modules and routes.ts only.
 */
import { routeListText } from "@/lib/db/console/completion";
import type { ProviderLabels } from "@/lib/db/types";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "./routes";

/** The two requests the sentence gives as examples: a filtered query and a search. */
export const MILVUS_STATEMENT_EXAMPLES: readonly [string, string] = [
  'POST /v2/vectordb/entities/query {"collectionName": "docs", "filter": "year > 2020", "outputFields": ["title"], "limit": 10}',
  'POST /v2/vectordb/entities/search {"collectionName": "docs", "annsField": "embedding", "data": [[0.1, 0.2]], "limit": 5}',
];

/** What the rows of getTableStats are: `TableStats` has no per-row label, so the caption says it. */
export const MILVUS_TABLE_STATS_CAPTION =
  'The first 200 collections of the database. Row counts are server estimates of flushed segments and do not subtract deletes; POST entities/query with outputFields ["count(*)"] is exact on a loaded collection.';

/** The read routes, in the route table's order, as `routeListText` lists them without their method. */
export function milvusReadRoutes(): readonly string[] {
  const listed = routeListText(MILVUS_CONSOLE, MILVUS_ROUTES, ["read"]);
  return listed === "" ? [] : listed.split(", ").map((entry) => entry.slice(entry.indexOf(" ") + 1));
}

/** "a, b and c". */
function spoken(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The statement language, from the route table. */
export function milvusStatementLanguage(): string {
  return [
    `A Milvus request, one per run: optional comment lines starting with #, then a line POST /v2/vectordb/<route> (POST <route> also works) naming one of ${spoken(milvusReadRoutes())}, then one JSON object with that route's Milvus REST v2 body keys, for example ${MILVUS_STATEMENT_EXAMPLES[0]} or ${MILVUS_STATEMENT_EXAMPLES[1]}.`,
    'Count rows with "outputFields": ["count(*)"] and no limit or offset.',
    "Filters are Milvus boolean expressions in the filter string.",
    "Query, get, count and search need a loaded collection.",
    "Not requests: writes, load, release, flush, compaction, users and roles, resource groups, snapshots and server-side functions.",
  ].join(" ");
}

export const MILVUS_LABELS: ProviderLabels = {
  entityName: "Collection",
  entityNamePlural: "Collections",
  rowName: "Entity",
  rowNamePlural: "Entities",
  selectAction: "Query Entities",
  generateAction: "Generate Command",
  searchPlaceholder: "Search collections...",
  statementLanguage: milvusStatementLanguage(),
  slowQueriesEmptyState: "Milvus keeps query statistics on its management port 9091, which Studio does not dial",
  sessionsEmptyState: "Milvus reports client sessions on its management port 9091, which Studio does not dial",
  tableStatsCaption: MILVUS_TABLE_STATS_CAPTION,
  // Never rendered: Milvus declares neither analyze nor vacuum, and its Load and Release are per-row controls worded
  // by their specs (maintenance.ts). Worded true anyway.
  analyzeAction: "Collection Statistics",
  vacuumAction: "Compact",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc:
    "Milvus keeps its own statistics; the Tables tab reads each collection's row-count estimate when it opens.",
  vacuumGlobalLabel: "Compact",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Compaction is not offered in this release; Load and Release are each collection's operations.",
};
