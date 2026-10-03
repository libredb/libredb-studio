/**
 * The Qdrant provider's client seam (vector-family spec 6.1): the 17 operations of the v1 console by their OpenAPI
 * operation ids, the request and the answer that cross the seam, the client every consumer is handed a slice of,
 * and the error an answer is classified into. No I/O: `rest-client.ts` is the one implementation, and the only
 * file that builds a path.
 *
 * A consumer never holds the whole client. It receives a `QdrantSend` typed to exactly the operations it calls, so
 * a module that reads collections cannot send a query, and a call-site test over a recording client holds the
 * slices at run time (3.13, interface segregation).
 */

/** The 17 OpenAPI operation ids of the v1 console (decision QD3), in the order the route table lists them. */
export const QDRANT_OPS = [
  "root",
  "get_collections",
  "get_collection",
  "collection_exists",
  "get_collections_aliases",
  "get_collection_aliases",
  "get_points",
  "get_point",
  "scroll_points",
  "count_points",
  "facet",
  "query_points",
  "query_batch_points",
  "query_points_groups",
  "get_optimizations",
  "list_snapshots",
  "collection_cluster_info",
] as const;

export type QdrantOp = (typeof QDRANT_OPS)[number];

export interface QdrantRequest {
  readonly op: QdrantOp;
  /** Path parameters, already checked by kind. */
  readonly params: Readonly<Record<string, string>>;
  /** Only keys the route declares; `timeout` is set by execute.ts. */
  readonly query: Readonly<Record<string, string>>;
  /** JSON text written by toJsonText, never JSON.stringify(JSON.parse(text)). */
  readonly body?: string;
}

export interface QdrantAnswer {
  readonly status: number;
  readonly contentType: string | null;
  /** The Retry-After header as received, cut to 64 characters; null when absent. */
  readonly retryAfter: string | null;
  readonly text: string;
}

export interface QdrantClient {
  send(request: QdrantRequest, signal: AbortSignal): Promise<QdrantAnswer>;
  close(): void;
}

/** The slice of the client a consumer is handed: `send`, narrowed to the operations it calls. */
export type QdrantSend<Ops extends QdrantOp> = (
  request: QdrantRequest & { readonly op: Ops },
  signal: AbortSignal,
) => Promise<QdrantAnswer>;

/**
 * One route as the path builder takes it: the method, the path template with each parameter as `{name}`, and the
 * query keys the route declares. `routes.ts` holds the 17 of them; the client is given the table when it is built
 * and can build no other path.
 */
export interface QdrantRouteTemplate {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: readonly string[];
}

export type QdrantRouteTemplates = Readonly<Record<QdrantOp, QdrantRouteTemplate>>;

/** What an answer that is not a success is, read from its status and its text (6.10). */
export type QdrantErrorCategory =
  | "unauthenticated" // 401: no key, or a key or JWT the server does not accept
  | "jwt-expired" // 403, plain text ExpiredSignature
  | "jwt-signature" // 403, plain text InvalidSignature
  | "forbidden" // any other 403
  | "collection-not-found" // 404 whose text says the collection does not exist
  | "not-found" // any other 404: a point, or a path the server does not serve
  | "input" // 400 and 422 that refuse the request as written
  | "strict-mode" // 400 "Bad request:", a collection's strict mode
  | "rate-limited" // 429
  | "timeout" // 500 "Timeout error: Operation", 408 "Timeout:"
  | "server" // any other 5xx but 503
  | "unavailable" // 503
  | "unexpected-status"; // an answer no row above reads

export class QdrantError extends Error {
  constructor(
    readonly category: QdrantErrorCategory,
    /** The server's own text: the `status.error` of a JSON body, else the body. Never shown before serverText. */
    readonly detail: string,
    readonly status: number,
    /** The Retry-After header of a 429 as received; null when absent, and on every other category. */
    readonly retryAfter: string | null = null,
  ) {
    super(`Qdrant answered HTTP ${status} (${category})`);
    this.name = "QdrantError";
    Object.setPrototypeOf(this, QdrantError.prototype);
  }
}
