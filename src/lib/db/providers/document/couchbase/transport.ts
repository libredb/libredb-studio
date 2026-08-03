/**
 * Couchbase transport seam (issue #262, decision 2)
 *
 * Provider logic never talks to the cluster directly. It goes through this
 * interface, so adopting the official SDK later is an additive change (one new
 * file implementing the same contract) rather than a rewrite of the provider.
 *
 * The types below are deliberately NEUTRAL: they describe what a caller needs,
 * not how any single source encodes it. An HTTP implementation and a future SDK
 * implementation can both produce this shape without inventing fields. Keeping
 * the wire envelope out of this file is what makes the seam real - a guard test
 * asserts the envelope identifiers appear only in http-transport.ts.
 *
 * This file is purely structural: no I/O, no wire-format vocabulary.
 */

/** A single result row. Couchbase documents are JSON objects. */
export type CouchbaseRow = Record<string, unknown>;

/**
 * A fully qualified collection inside a bucket.
 * Couchbase nests cluster > bucket > scope > collection; the bucket is pinned
 * by the connection, so a keyspace only needs the lower three levels.
 */
export interface Keyspace {
  bucket: string;
  scope: string;
  collection: string;
}

/** A non-fatal notice the cluster attached to a completed statement. */
export interface CouchbaseWarning {
  code: number;
  message: string;
}

/**
 * Normalized outcome of one SQL++ statement.
 *
 * `fieldNames` is null when the source cannot tell which columns a statement
 * produced - a `SELECT *` projection nests whole documents under the keyspace
 * name and advertises only a wildcard, so the caller derives columns from the
 * rows instead.
 */
export interface CouchbaseQueryResult {
  rows: CouchbaseRow[];
  fieldNames: string[] | null;
  executionTimeMs: number;
  mutationCount: number;
  warnings: CouchbaseWarning[];
}

/**
 * Index freshness for a statement.
 *
 * The query service defaults to `not_bounded`, which reads the index in
 * whatever state it happens to be in. That is unacceptable for an interactive
 * editor: verified against Couchbase Server 8.0.2, a SELECT issued immediately
 * after an INSERT returned zero rows while COUNT(*) already returned three, and
 * the same SELECT returned three rows seconds later. The transport therefore
 * sends `request_plus` by default so a user always sees their own writes;
 * callers that prefer latency over freshness opt into `not_bounded`.
 */
export type CouchbaseScanConsistency = "not_bounded" | "request_plus";

/** Per-statement options. */
export interface QueryOpts {
  /** Positional parameters for `$1`-style placeholders. */
  args?: unknown[];
  /** Server-side statement timeout in milliseconds. */
  timeoutMs?: number;
  /** Reject any statement that would mutate data. */
  readonly?: boolean;
  /** Plan/timing detail the cluster should attach to the response. */
  profile?: "off" | "phases" | "timings";
  /** Override the read-your-writes default. */
  scanConsistency?: CouchbaseScanConsistency;
}

/**
 * The seam itself.
 *
 * `manage()` stays HTTP permanently: cluster and bucket runtime statistics
 * (`/pools/default`, `/pools/default/buckets/<bucket>`) have no SDK equivalent,
 * so overview, performance and storage metrics need it under any transport.
 */
export interface CouchbaseTransport {
  readonly kind: "http";
  query(stmt: string, o?: QueryOpts): Promise<CouchbaseQueryResult>;
  manage<T>(path: string): Promise<T>;
  /** SDK extension point: KV range scan. Not available over HTTP. */
  scanDocuments?(ks: Keyspace, limit: number, skip: number): Promise<CouchbaseRow[]>;
  close(): Promise<void>;
}

/**
 * Normalized transport failure.
 *
 * `code` is a single numeric space: SQL++ error codes (3000 syntax, 4000 no
 * index, 13014 missing credentials, ...) and HTTP codes (401, 403, 503) both
 * land here, so provider-level mapping has one thing to switch on. `retriable`
 * marks failures that are worth repeating (timeouts, CAS conflicts, a query
 * node that is not ready yet) as opposed to ones that need a user fix.
 */
export class CouchbaseError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "CouchbaseError";
    Object.setPrototypeOf(this, CouchbaseError.prototype);
  }
}
