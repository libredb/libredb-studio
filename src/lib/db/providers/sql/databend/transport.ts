/**
 * Databend transport seam (design 2.2).
 *
 * Provider logic never talks to the query server directly. It goes through {@link DatabendTransport}, which takes one
 * statement and answers one completed {@link StatementOutcome}: everything the HTTP query API invented - `POST
 * /v1/query`, the `next_uri` chain, the long poll, `final` and `kill`, the client session, the gateway kinds - stays
 * inside `http-transport.ts` and the pure modules it calls, so nothing above this seam sees a page, a link or a
 * status code.
 *
 * Two protocol facts shape the types below, both measured on the pinned image:
 *
 * - A FAILED STATEMENT IS AN HTTP 200 with `state: "Failed"` and an in-body `error`, so a failure reaches the
 *   provider as a {@link DatabendError} of category `statement`, never as a status.
 * - EVERY CELL IS TEXT. In the `display` result mode a cell is a JSON string or `null` (a Boolean `"1"`, a Binary
 *   upper-case hex), so the outcome carries wire rows of `string | null` and the column types as Databend declared
 *   them; decoding them into Studio values is `decode.ts`'s (design section 4).
 *
 * Apart from the error class this file is purely structural: no I/O.
 */

/**
 * Who a statement is for, which decides its session settings and how a failure is classed.
 *
 * `"user"` is the editor's statement, sent with the user's own dialect settings. `"provider"` is a statement Studio
 * writes itself (the object tree, describe, source, monitoring, the connect probe), which also pins `sql_dialect`,
 * `quoted_ident_case_sensitive` and `timezone` (design 3.3), whose network failure is `network` where a user
 * statement's is `outcome-unknown` (design 3.11), and whose deadline is `timeout` whatever the kill answered, or
 * `unavailable`, the resuming outcome, on a named warehouse.
 */
export type StatementOrigin = "user" | "provider";

/** One statement to run, the only thing the provider hands the transport. */
export interface StatementRequest {
  /** One statement, sent as it is; the guard of `sql-text.ts` has already run (design 5.3). */
  readonly sql: string;
  readonly origin: StatementOrigin;
  /** The row cut of design 3.12: at most this many rows are kept, and one more read marks the result truncated. */
  readonly rowCut: number;
  /** The run's signal, the statement deadline already folded in; its abort is a cancel or a timeout (design 3.10). */
  readonly signal: AbortSignal;
}

/** One column of the answer's `schema`: its name, and its type exactly as Databend declared it (`Nullable(Int64)`). */
export interface DatabendColumn {
  readonly name: string;
  readonly type: string;
}

/** A wire cell in the `display` result mode: text, or `null` for SQL NULL (`format_null_as_str` pinned to `0`). */
export type DatabendCell = string | null;

/**
 * The budget of design 3.12 that ended a result early, first reached: the row cut, the 250,000 cells, or the 16 MiB
 * of answer text across pages. `limit` is that bound's value, in rows, cells or bytes.
 */
export interface DatabendTruncation {
  readonly bound: "rows" | "cells" | "bytes";
  readonly limit: number;
}

/**
 * What a statement changed in its session, from the answer's `affect`, which Databend sets only for USE and SET
 * (measured, M09). Each statement runs in a session of its own (design 3.7), so the provider turns each into the
 * warning that the change does not carry over. An affect of any other type is not carried.
 */
export type DatabendAffect =
  | { readonly type: "UseDB"; readonly name: string }
  | { readonly type: "UseCatalog"; readonly name: string }
  | {
      readonly type: "ChangeSettings";
      readonly keys: readonly string[];
      readonly values: readonly string[];
      /** One flag per key: true where `SET GLOBAL` changed it for every session. */
      readonly isGlobals: readonly boolean[];
    };

/**
 * Something the run did or found that is not the result itself, which the provider turns into a `QueryWarning`.
 *
 * - `use-not-carried`, `settings-not-carried`, `global-settings-changed` and `role-not-carried`: the session
 *   warnings of design 3.7, read from the affect and the echoed session; each key SET GLOBAL changed is already
 *   passed through `serverWords`.
 * - `transaction-ended`, `transaction-may-stay-open` and `temp-tables-dropped`: what the end-open of design 3.4 did
 *   with a statement that left a transaction or a temporary table open.
 * - `close-failed`: a best-effort final, ROLLBACK or logout that did not answer within its 5 s; a failed final of a
 *   complete result is this notice and never an error, which would report a committed write as failed.
 * - `close-refused`: a final, ROLLBACK or logout answered with something other than its acknowledgment: an error
 *   status, a gateway's refusal over HTTP 200, an answer the node transport refused to read (past the cap, under
 *   another content-encoding, a redirect, or cut short once it began), or a 200 of the ROLLBACK's chain that could not
 *   be read.
 * - `close-skipped`: a close that was never sent, because Databend had refused the sign-in on an earlier request of
 *   the statement and the run sends nothing after that (design 3.5).
 * - `result-mode`: the server echoed an `http_json_result_mode` other than `display` (design section 4), the mode
 *   already passed through `serverWords`.
 * - `server-warning`: one entry of an answer's `warnings`, which the poll loop of design 3.4 keeps, such as the
 *   warning for a setting name the server ignores; its text is already passed through `serverText`. A statement keeps
 *   its first 100 different ones.
 * - `warnings-left-out`: how many warnings Databend sent past the ones kept, counted and never kept (design 3.12).
 */
/** The closes a finished statement reports on: the kill is reported through the run's own outcome instead. */
export type DatabendCloseStep = "final" | "rollback" | "logout";

export type DatabendNotice =
  | { readonly kind: "use-not-carried" }
  | { readonly kind: "settings-not-carried" }
  | { readonly kind: "global-settings-changed"; readonly keys: readonly string[] }
  | { readonly kind: "role-not-carried" }
  | { readonly kind: "transaction-ended" }
  | { readonly kind: "transaction-may-stay-open" }
  | { readonly kind: "temp-tables-dropped" }
  | { readonly kind: "close-failed"; readonly step: DatabendCloseStep }
  | { readonly kind: "close-refused"; readonly step: DatabendCloseStep }
  | { readonly kind: "close-skipped"; readonly step: DatabendCloseStep }
  | { readonly kind: "result-mode"; readonly mode: string }
  | { readonly kind: "server-warning"; readonly text: string }
  | { readonly kind: "warnings-left-out"; readonly count: number };

/**
 * One completed statement.
 *
 * `schema` is the first non-empty one the answers carried (a `Starting` answer has none, M04b); `rows` are as wide as
 * it. A DML statement answers one row in a column `number of rows inserted|updated|deleted` (M08b), and DDL answers
 * `hasResultSet: false` with no schema (M24c), which is how the provider tells a statement with no result set from a
 * query that matched no row.
 */
export interface StatementOutcome {
  readonly schema: readonly DatabendColumn[];
  readonly rows: readonly (readonly DatabendCell[])[];
  /** `null` when every row the statement produced is here. */
  readonly truncated: DatabendTruncation | null;
  readonly notices: readonly DatabendNotice[];
  readonly hasResultSet: boolean;
  readonly affect: DatabendAffect | null;
  /**
   * A provider statement's only: the query ids of this process's own provider statements in flight at any moment
   * while it ran, its own included, which a read of running statements leaves out (design 5.5). A user statement is
   * never one of them, and its outcome has none.
   */
  readonly ownQueryIds?: ReadonlySet<string>;
}

/** The one door to the query server. */
export interface DatabendTransport {
  /** Runs one statement to its end, closing it on the server whatever happens; throws a {@link DatabendError}. */
  run(request: StatementRequest): Promise<StatementOutcome>;
  /** Cancels every run in flight, each with its own kill, and releases the sockets. */
  close(): Promise<void>;
}

/**
 * Every way a statement can fail, closed so each call site handles a known set (design 3.13).
 *
 * The first nine are Databend's own: `auth` (a refused or latched sign-in), `config` (Warehouse, Host or a setting
 * named wrong), `protocol` (an answer that did not follow the HTTP protocol), `unavailable` (a warehouse that did not
 * resume in time, Studio's own read that outlasted its deadline on a named warehouse, or Studio's statement slots that
 * stayed busy until a statement's deadline), `outcome-unknown` (the statement may have run), `timeout` (Studio's
 * deadline), `cancelled` (a cancel the server acknowledged, or one before anything was sent), `statement` (an in-body
 * error) and `server` (a non-200 answer before the end). The last five are the node transport's `TransportError`
 * kinds a provider statement surfaces as they are.
 */
export type DatabendErrorCategory =
  | "auth"
  | "config"
  | "protocol"
  | "unavailable"
  | "outcome-unknown"
  | "timeout"
  | "cancelled"
  | "statement"
  | "server"
  | "network"
  | "tls"
  | "redirect"
  | "encoding"
  | "too-large";

/** What a failure carries besides its category and sentence, each absent where the failure has none. */
export interface DatabendErrorDetails {
  /** Databend's error code (`1065`, `5100`), from the body or the gateway. */
  readonly code?: number;
  /** The HTTP status the failing answer had. */
  readonly status?: number;
  /** A `statement` failure's position in the statement text, from `--> SQL:<line>:<col>`. */
  readonly position?: number;
  /** Server text, already passed through `serverText` with the connection's secret forms. */
  readonly detail?: string;
  readonly cause?: unknown;
}

/**
 * A failed statement: exactly one category and the sentence the user reads.
 *
 * The message is the sentence as given, never built here, so every sentence stays an exported constant of the module
 * that classifies (design 3.13). The provider maps the category onto the house error classes at its boundary:
 * `auth` to `AuthenticationError`, `config` to `DatabaseConfigError`, `timeout` to `TimeoutError`, `cancelled` to
 * `QueryCancelledError`, `statement` and `too-large` to `QueryError`, the rest to `ConnectionError`.
 */
export class DatabendError extends Error {
  readonly code?: number;
  readonly status?: number;
  readonly position?: number;
  readonly detail?: string;

  constructor(
    readonly category: DatabendErrorCategory,
    message: string,
    details: DatabendErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "DatabendError";
    this.code = details.code;
    this.status = details.status;
    this.position = details.position;
    this.detail = details.detail;
  }
}
