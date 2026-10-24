/**
 * The Weaviate provider's labels (#1566 spec 6.3).
 *
 * `statementLanguage` is what plan mode states after "Write it in" (`src/lib/agent/investigation.ts`), the one fact
 * about how a request is written that its prompt carries for this engine. It is generated from the route table and
 * the dialect (`routes.ts`), so the two cannot drift: every route of class `read` as `METHOD /template` in table
 * order, the comment markers, how a body is written with one example, and what the console refuses.
 *
 * Pure and browser-safe: it imports the route table and the label type only.
 */
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import type { ProviderLabels } from "@/lib/db/types";
import { WEAVIATE_CONSOLE, WEAVIATE_ROUTES } from "./routes";

/** The classes of requests the console refuses, in the words and the order of the sentence's refusal clause. */
export const WEAVIATE_REFUSED_CLASSES: readonly string[] = Object.freeze([
  "object, schema, tenant and alias writes",
  "batch",
  "backups",
  "users and roles",
  "near-text and the other searches that send text or media to a model",
  "generative search and rerank",
  "hybrid with an alpha other than 0",
  "GraphQL written by hand",
]);

/** The example request the sentence gives, with names that fit the seeded `Article`. */
export const WEAVIATE_STATEMENT_EXAMPLE =
  'POST /v1/search/Article/bm25 {"query": "vector search", "where": {"path": ["category"], "operator": "Equal", "valueText": "alpha"}, "limit": 5, "returnMetadata": ["score"]}';

function listText(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Every route of class `read`, in table order, as `METHOD /template`. */
export function weaviateReadRoutes(spec: ConsoleDialectSpec, routes: readonly RouteSpec[]): readonly string[] {
  return routes
    .filter((route) => route.class === "read")
    .map((route) => `${route.method} ${spec.pathPrefix}${route.template}`);
}

/** The sentence, generated from the dialect, the route table and the refused classes. */
export function weaviateStatementLanguage(
  spec: ConsoleDialectSpec,
  routes: readonly RouteSpec[],
  refused: readonly string[],
): string {
  return [
    `A Weaviate REST request, one per run: optional comment lines starting with ${spec.commentMarkers.join(" or ")}, then a line METHOD /path naming one of ${listText(weaviateReadRoutes(spec, routes))}, with every brace-enclosed segment replaced by a real name or id.`,
    `GET routes take no body; POST routes take one JSON object with that route's Weaviate REST body, for example ${WEAVIATE_STATEMENT_EXAMPLE}.`,
    "Filters are Weaviate where objects with operator, path and one value key such as valueText or valueInt; And, Or and Not take operands.",
    'A multi-tenant collection needs its tenant: ?tenant= on a GET, "tenant" in a body.',
    `Not requests: ${listText(refused)}.`,
  ].join(" ");
}

export const WEAVIATE_LABELS: ProviderLabels = {
  entityName: "Collection",
  entityNamePlural: "Collections",
  rowName: "Object",
  rowNamePlural: "Objects",
  selectAction: "Read Objects",
  generateAction: "Generate Request",
  searchPlaceholder: "Search collections...",
  statementLanguage: weaviateStatementLanguage(WEAVIATE_CONSOLE, WEAVIATE_ROUTES, WEAVIATE_REFUSED_CLASSES),
  slowQueriesEmptyState: "Weaviate reports no slow-query log over the routes Studio reads.",
  sessionsEmptyState:
    "Weaviate does not report client sessions over the routes Studio reads. For performance and storage, connect Studio to a Prometheus server that scrapes Weaviate's metrics.",
  tableStatsCaption:
    "The first 200 single-tenant collections, each with its exact object count (aggregate meta.count). A multi-tenant collection is counted per tenant: POST /v1/aggregate/{collection} with a tenant.",
  // Never rendered: Weaviate has no maintenance operation in this version (supportsMaintenance is false). Worded true anyway.
  analyzeAction: "Collection Statistics",
  vacuumAction: "Compact Collection",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "Weaviate keeps no statistics to update; the Tables tab counts each collection when it opens.",
  vacuumGlobalLabel: "Compact",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Studio runs no Weaviate maintenance operation; Weaviate compacts its segments on its own.",
};
