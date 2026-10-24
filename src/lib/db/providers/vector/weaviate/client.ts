/**
 * The Weaviate provider's client seam (#1566 spec 3.1): the operations the provider sends, the request and the
 * answer that cross the seam, the client every consumer is handed a slice of, and the error an answer is classified
 * into. No I/O: `rest-client.ts` is the one implementation, and the only file that builds a path.
 *
 * A consumer never holds the whole client. It receives a `WeaviateSend` typed to exactly the operations it calls,
 * so a module that reads the schema cannot send a search, and a call-site test over a recording client holds the
 * slices at run time.
 */

/**
 * Every operation the client sends: the console's routes (`routes.ts`) first, in their table order, then the two
 * the console never names, the readiness probe of the health surface and the GraphQL read the encoder writes for a
 * server that serves no REST search (spec 3.3).
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
] as const;

export type WeaviateOp = (typeof WEAVIATE_OPS)[number];

/** The operations a console request may name: every operation but the two the provider writes itself. */
export type WeaviateConsoleOp = Exclude<WeaviateOp, "ready" | "graphql">;

/** The four search routes and the aggregate route: the operations that run over REST or GraphQL (spec 3.3). */
export type WeaviateSearchOp = "search_bm25" | "search_hybrid" | "search_near_vector" | "search_near_object";
export type WeaviateEncodedOp = WeaviateSearchOp | "aggregate";

export interface WeaviateRequest {
  readonly op: WeaviateOp;
  /** Path parameters, already checked by kind. */
  readonly params: Readonly<Record<string, string>>;
  /** Only keys the route declares. */
  readonly query: Readonly<Record<string, string>>;
  /** JSON text written by toJsonText or JSON.stringify of a value Studio built, never a user's text as typed. */
  readonly body?: string;
}

export interface WeaviateAnswer {
  readonly status: number;
  readonly contentType: string | null;
  /** The Retry-After header as received, cut to 64 characters; null when absent. */
  readonly retryAfter: string | null;
  readonly text: string;
}

export interface WeaviateClient {
  send(request: WeaviateRequest, signal: AbortSignal): Promise<WeaviateAnswer>;
  close(): void;
}

/** The slice of the client a consumer is handed: `send`, narrowed to the operations it calls. */
export type WeaviateSend<Ops extends WeaviateOp> = (
  request: WeaviateRequest & { readonly op: Ops },
  signal: AbortSignal,
) => Promise<WeaviateAnswer>;

/** One route as the path builder takes it: the method, the path template with `{name}` parameters, the query keys. */
export interface WeaviateRouteTemplate {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: readonly string[];
}

export type WeaviateRouteTemplates = Readonly<Record<WeaviateOp, WeaviateRouteTemplate>>;

/**
 * What an answer that is not a success is, read from its status and the server's words (spec 5.6). A GraphQL answer
 * that carries `errors` is one too, whatever its status, because GraphQL answers its refusals under HTTP 200.
 */
export type WeaviateErrorCategory =
  | "unauthenticated" // 401: no key, or a key or token the server does not accept
  | "forbidden" // 403, an RBAC refusal naming the action
  | "graphql-scope" // the GraphQL introspection refusal of a role scoped to some collections
  | "collection-not-found" // 404 "could not find collection", or GraphQL "class ... does not exist"
  | "route-absent" // the router's 404 "path ... was not found": this server version has no such route
  | "not-found" // any other 404: an object or a tenant
  | "tenant-not-active" // 422 "tenant not active"
  | "rest-search-disabled" // 422 "rest search api is experimental and not enabled"
  | "graphql-disabled" // 422 "graphql api is disabled"
  | "result-limit" // 400 past QUERY_MAXIMUM_RESULTS
  | "tls-required" // 400 from the TLS listener: plain HTTP sent to a port that speaks TLS
  | "input" // any other 400 or 422, and a GraphQL error no row above reads
  | "rate-limited" // 429
  | "server" // any other 5xx but 503
  | "unavailable" // 503
  | "unexpected-status"; // an answer no row above reads

export class WeaviateError extends Error {
  constructor(
    readonly category: WeaviateErrorCategory,
    /** The server's own words: the `message` of its error body, else the body. Never shown before serverText. */
    readonly detail: string,
    readonly status: number,
    /** The Retry-After header of a 429 as received; null when absent, and on every other category. */
    readonly retryAfter: string | null = null,
  ) {
    super(`Weaviate answered HTTP ${status} (${category})`);
    this.name = "WeaviateError";
    Object.setPrototypeOf(this, WeaviateError.prototype);
  }
}
