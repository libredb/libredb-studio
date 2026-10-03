/**
 * The graph layer's I/O seam (Neo4j provider spec 3.3).
 *
 * `GraphBaseProvider` and every engine profile depend on `GraphClient`, never on the
 * driver: `bolt-client.ts` is the one implementation, and tests implement the
 * interface with fakes or recorded results. The interface runs one literal statement
 * in a READ session and nothing else; there is no parameter, no explicit transaction
 * and no retrying transaction function, so a statement the read policy passed reaches
 * the server exactly once, as the text the user saw.
 *
 * Rows are JSON-safe when they leave the client (`record-values.ts`), so nothing above
 * this seam meets a driver value class.
 */

/** `summary.queryType`: read only, read and write, write only, schema write. */
export type GraphQueryType = "r" | "rw" | "w" | "s";

export interface GraphRunOptions {
  /** Undefined runs against the user's home database. */
  readonly database?: string;
  /** The Bolt transaction timeout; the client's own timer fires one second after it. */
  readonly timeoutMs: number;
  /** At most `maxRows + 1` records are read: the extra one only proves the cut. */
  readonly maxRows: number;
  /** An abort closes the session, which is how Neo4j cancels a running statement. */
  readonly signal?: AbortSignal;
  /** Transaction metadata, shown by `SHOW TRANSACTIONS` and in the query log. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface GraphRunResult {
  readonly fields: readonly string[];
  /** JSON-safe rows keyed by field. */
  readonly rows: readonly Record<string, unknown>[];
  /** True when a record beyond `maxRows` existed; the summary is then not read. */
  readonly truncated: boolean;
  /** `summary.queryType`, when the summary was read. */
  readonly queryType?: GraphQueryType;
  /** One sentence per column whose value was replaced by the cell bound (SR16); absent when none. */
  readonly warnings?: readonly string[];
}

export interface GraphServerInfo {
  readonly address: string;
  readonly agent: string;
  /** Bolt protocol version as `<major>.<minor>`. */
  readonly protocolVersion: string;
}

export interface GraphClient {
  verify(): Promise<GraphServerInfo>;
  run(statement: string, options: GraphRunOptions): Promise<GraphRunResult>;
  close(): Promise<void>;
}

export type GraphClientErrorCategory =
  | "auth"
  | "connection"
  | "tls"
  | "timeout"
  | "cancelled"
  | "access-mode"
  | "syntax"
  | "query";

/** A failure of the transport or the server, classified; the message is the server's own where it gave one. */
export class GraphClientError extends Error {
  // Declared, never defined as fields, so an absent code is an absent property under
  // every class-field semantics (Bun defines declared fields as undefined otherwise).
  declare readonly category: GraphClientErrorCategory;
  /** The server's or the driver's status code, e.g. `Neo.ClientError.Statement.AccessMode`. */
  declare readonly code?: string;
  constructor(category: GraphClientErrorCategory, message: string, code?: string) {
    super(message);
    this.name = "GraphClientError";
    this.category = category;
    if (code !== undefined) this.code = code;
  }
}

export interface BoltClientConfig {
  /** `bolt://`, `bolt+s://` or `bolt+ssc://` only: never a routing `neo4j` scheme. */
  readonly uri: string;
  readonly user?: string;
  readonly password?: string;
  /** PEM text of a CA to trust instead of the system store; needs a `bolt+s://` URI. */
  readonly trustedCertificatePem?: string;
  readonly connectionTimeoutMs: number;
  readonly userAgent: string;
}

export type GraphClientFactory = (config: BoltClientConfig) => GraphClient;
