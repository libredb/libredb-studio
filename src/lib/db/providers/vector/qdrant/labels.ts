/**
 * The Qdrant provider's labels (vector-family spec 6.7).
 *
 * `statementLanguage` is what plan mode states after "Write it in" (`src/lib/agent/investigation.ts`), the one fact
 * about how a request is written that its prompt carries for this engine. It is generated from the route table and
 * the dialect (`routes.ts`), so the two cannot drift: every route of class `read` as `METHOD /template` in table
 * order, the comment markers, how a body is written with one example, how filters and ids are written, and a
 * refusal clause from the classes the console refuses. `tests/unit/db/qdrant/labels.test.ts` parses the route list
 * back out of it, runs its example through the real parser, and holds each refused class to a request line that
 * `refusedRouteSentence` refuses by what it is.
 *
 * Pure and browser-safe: it imports the route table and the label type only.
 */
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import type { ProviderLabels } from "@/lib/db/types";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "./routes";

/** The classes of routes the console refuses, in the words and the order of the sentence's refusal clause. */
export const QDRANT_REFUSED_CLASSES: readonly string[] = Object.freeze([
  "point and payload writes",
  "vector and index changes",
  "collection and alias changes",
  "snapshot create, download, upload and recover",
  "shard, peer and cluster changes",
  "search/matrix",
  "/telemetry",
  "/metrics",
]);

/** The example request the sentence gives: the documentation's own query, with names that fit the seeded `docs`. */
export const QDRANT_STATEMENT_EXAMPLE =
  'POST /collections/docs/points/query {"query": [0.1, 0.2], "using": "text", "filter": {"must": [{"key": "category", "match": {"value": "alpha"}}]}, "limit": 5}';

/** "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Every route of class `read`, in table order, as `METHOD /template`. */
export function qdrantReadRoutes(spec: ConsoleDialectSpec, routes: readonly RouteSpec[]): readonly string[] {
  return routes
    .filter((route) => route.class === "read")
    .map((route) => `${route.method} ${spec.pathPrefix}${route.template}`);
}

/** The sentence, generated from the dialect, the route table and the refused classes. */
export function qdrantStatementLanguage(
  spec: ConsoleDialectSpec,
  routes: readonly RouteSpec[],
  refused: readonly string[],
): string {
  return [
    `A Qdrant request, one per run: optional comment lines starting with ${spec.commentMarkers.join(" or ")}, then a line METHOD /path naming one of ${listText(qdrantReadRoutes(spec, routes))}, with every brace-enclosed segment replaced by a real name or id.`,
    `GET routes take no body; POST routes take one JSON object with that route's Qdrant REST body, for example ${QDRANT_STATEMENT_EXAMPLE}.`,
    "Filters are Qdrant must, should and must_not trees.",
    "Ids are unsigned integers written as plain numbers, or UUID strings.",
    `Not requests: ${listText(refused)}.`,
  ].join(" ");
}

export const QDRANT_LABELS: ProviderLabels = {
  entityName: "Collection",
  entityNamePlural: "Collections",
  rowName: "Point",
  rowNamePlural: "Points",
  selectAction: "Scroll Points",
  generateAction: "Generate Command",
  searchPlaceholder: "Search collections...",
  statementLanguage: qdrantStatementLanguage(QDRANT_CONSOLE, QDRANT_ROUTES, QDRANT_REFUSED_CLASSES),
  slowQueriesEmptyState:
    "Qdrant keeps slow requests behind a manage-only route that returns other clients' request bodies, which Studio does not read.",
  sessionsEmptyState:
    "Qdrant does not report client sessions over the routes Studio reads. For sessions, performance and storage, connect Studio to a Prometheus server that scrapes Qdrant's /metrics.",
  // What the rows of getTableStats are (spec 6.6, 6.7): the first 200 collections, each with Qdrant's estimate.
  tableStatsCaption:
    'The first 200 collections. Point counts are Qdrant\'s approximate points_count; POST /collections/{collection_name}/points/count with "exact": true is exact.',
  // Never rendered: Qdrant has no maintenance operation in this version (supportsMaintenance is false). Worded true anyway.
  analyzeAction: "Collection Statistics",
  vacuumAction: "Optimize Collection",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc:
    "Qdrant keeps no statistics to update; the Tables tab reads each collection's point count when it opens.",
  vacuumGlobalLabel: "Optimize",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Studio runs no Qdrant maintenance operation; Qdrant optimizes its segments on its own.",
};
