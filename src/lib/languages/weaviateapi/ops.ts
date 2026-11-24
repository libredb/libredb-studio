/**
 * The operation names of the Weaviate REST API Studio sends (#1566 spec 3.1): the console's routes in `routes.ts`'s
 * table order, then the three the provider writes itself. Pure and browser-safe, importing nothing: the provider's
 * client seam types its requests by them, and the route table gives each its method and path.
 */

/**
 * Every operation the client sends: the console's routes (`routes.ts`) first, in their table order, then the three
 * the console never names, the readiness probe of the health surface, the GraphQL read the encoder writes for a
 * server that serves no REST search (spec 3.3), and the key's own record the agent read-only profile proves a viewer
 * from (the provider's `metadata-read.ts`).
 */
export const WEAVIATE_OPS = [
  "meta",
  "schema",
  "collection",
  "shards",
  "tenants",
  "tenant",
  "aliases",
  "alias",
  "nodes",
  "collection_nodes",
  "objects",
  "object",
  "search_bm25",
  "search_hybrid",
  "search_near_vector",
  "search_near_object",
  "aggregate",
  "ready",
  "graphql",
  "own_info",
] as const;

export type WeaviateOp = (typeof WEAVIATE_OPS)[number];

/** The operations a console request may name: every operation but the three the provider writes itself. */
export type WeaviateConsoleOp = Exclude<WeaviateOp, "ready" | "graphql" | "own_info">;

/** The four search routes and the aggregate route: the operations that run over REST or GraphQL (spec 3.3). */
export type WeaviateSearchOp = "search_bm25" | "search_hybrid" | "search_near_vector" | "search_near_object";
export type WeaviateEncodedOp = WeaviateSearchOp | "aggregate";
