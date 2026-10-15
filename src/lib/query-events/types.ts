/**
 * The query event model of governance contract v1 (spec 7.2, 7.9): what Studio records of each unit it runs under
 * governance, and the row of `query_events_v1` that `buildQueryEvent()` in `build.ts` makes of it.
 *
 * A route describes an executed unit with a `QueryEventInput`: who ran it, on which connection, the statement as the
 * user submitted it, how it ended and when it started. The input has no field for a bind parameter value, a result
 * row or a credential, and the builder copies only the fields named here, so none of them can reach a row even when a
 * caller hands it an object that carries them.
 *
 * Types only: nothing here runs.
 */
import type { ExplainMode } from "@/lib/explain";
import type { RuntimeSettingValues } from "@/lib/governance/settings";
import type { DatabaseType } from "@/lib/types";

/**
 * Which surface ran the unit (docs/GOVERNANCE.md, "Query events"). The column is an open vocabulary checked by format
 * only, so a control plane shows a source it does not know as it is; these are the sources of this release.
 */
export type QueryEventSource =
  | "editor"
  | "multi-query"
  | "transaction"
  | "object-edit"
  | "maintenance"
  | "profile"
  | "key-scan";

/** How the unit ended. `refused` is a request Studio turned away before the unit ran. */
export type QueryEventStatus = "success" | "error" | "cancelled" | "refused";

/** What `analyzeQuery()` reads a statement as, and `OTHER` for every engine whose statements are not SQL. */
export type StatementType = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "DDL" | "OTHER";

/** The modes of the runtime setting `queryLog.statementCapture`. */
export type StatementCapture = RuntimeSettingValues["queryLog.statementCapture"];

/**
 * Where an interactive transaction stood after the unit: `open` for a statement run inside it, and the outcome that
 * ended it for the one terminal event. An open vocabulary in the contract, like `source`.
 */
export type TransactionOutcome = "open" | "committed" | "rolled-back" | "timed-out";

/** The level of the credential the unit ran with: the caller's grant level, or `read` where a path always reads. */
export type AccessLevel = "read" | "write";

/**
 * When a unit started, on both clocks: the wall clock dates the event, and the monotonic clock times it, because a
 * wall clock that NTP steps while the unit runs would lengthen or shorten a duration measured on it.
 */
export interface QueryEventStart {
  /** `Date.now()` when the unit started. */
  readonly wallClockMs: number;
  /** `performance.now()` when the unit started. */
  readonly monotonicMs: number;
}

/** Who ran the unit. */
export interface QueryEventPrincipal {
  /** The session's identity provider subject, the key grants name (spec 3.2 D2). */
  readonly subject: string;
  /** The session's username, a display label only. */
  readonly username: string;
  readonly role: "admin" | "user";
}

/**
 * The connection the unit ran on, as the route resolved it, or only the id the request named when Studio refused the
 * request before the connection resolved, such as a connection the caller holds no grant on.
 */
export interface QueryEventConnection {
  /** Studio's id of the connection, `seed:<connection id>`, as resolved or as requested. */
  readonly id: string;
  readonly name: string | null;
  /** The engine that runs the statement; null only when the connection did not resolve. */
  readonly engine: DatabaseType | null;
  /** The level of the credential the connection opened with; null only when the connection did not resolve. */
  readonly accessLevel: AccessLevel | null;
}

/** One executed unit, or one refused request, as a route describes it. */
export interface QueryEventInput {
  readonly source: QueryEventSource;
  readonly principal: QueryEventPrincipal;
  readonly connection: QueryEventConnection;
  /** The text the user submitted, never a statement Studio built around it; null when the unit has no text. */
  readonly statement: string | null;
  readonly status: QueryEventStatus;
  /**
   * What the unit is when its route knows it better than its text says, such as a profile, which reads aggregates of
   * user data though its text is the profiled object's path; absent, it is read from the text.
   */
  readonly statementType?: StatementType;
  /** `queryEventStart()` before the unit ran. */
  readonly started: QueryEventStart;
  /** The plan mode the request asked for, for a plan request only. */
  readonly explain?: ExplainMode;
  /** The rows the unit returned or changed, when the engine reported a count. */
  readonly rowCount?: number;
  /** The unit's position among the units of one request, from 0. */
  readonly unitIndex?: number;
  /** The SQLSTATE, the driver's code, or the API code of a refusal. */
  readonly errorCode?: string;
  /** The error text, which only capture `full` stores. */
  readonly errorMessage?: string;
  /** Shared by every event of one request or one plan. */
  readonly correlationId?: string;
  /** Shared by every event of one interactive transaction. */
  readonly transactionId?: string;
  readonly transactionOutcome?: TransactionOutcome;
  /** The client address the request came from, as `clientAddress()` reads it: a hint, never an identity. */
  readonly clientIp?: string;
}

/** What a row keeps of its statement: the runtime settings `queryLog.statementCapture` and `maxStatementBytes`. */
export interface QueryEventPolicy {
  readonly statementCapture: StatementCapture;
  /** The most UTF-8 bytes a stored statement keeps. */
  readonly maxStatementBytes: number;
}

/** What a row says about the Studio instance that records it. */
export interface QueryEventContext {
  /** `GOVERNANCE_INSTANCE_ID`, the id the heartbeat reports this instance under. */
  readonly studioInstance: string;
}

/**
 * A row of `query_events_v1`: one key per column of the manifest, in the order every insert binds them. Times are
 * ISO 8601 strings in UTC, as the manifest's sample rows give them.
 */
export interface QueryEventRow {
  readonly event_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly contract_version: number;
  readonly studio_instance: string;
  readonly subject: string;
  readonly username: string | null;
  readonly session_role: QueryEventPrincipal["role"];
  readonly connection_id: string;
  readonly connection_name: string | null;
  readonly engine: DatabaseType | null;
  readonly access_level: AccessLevel | null;
  readonly source: QueryEventSource;
  readonly statement_type: StatementType;
  readonly explain: "plan" | "analyze" | null;
  readonly statement_capture: StatementCapture;
  readonly statement: string | null;
  readonly statement_truncated: boolean;
  readonly statement_fingerprint: string | null;
  readonly unit_index: number | null;
  readonly row_count: number | null;
  readonly duration_ms: number;
  readonly status: QueryEventStatus;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly correlation_id: string | null;
  readonly transaction_id: string | null;
  readonly transaction_outcome: TransactionOutcome | null;
  readonly client_ip: string | null;
}
