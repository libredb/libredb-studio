/**
 * The client session of one Databend statement (design 3.2, 3.4, 3.7).
 *
 * Every statement runs in a session of its own: one cached provider serves every caller, so `USE`, `SET`,
 * `SET ROLE`, `BEGIN` and temporary tables cannot carry over to the next statement. The session id is a fresh UUID
 * Studio chooses and sends as `x-databend-session` with the statement's POST, pages, final and kill; the server reads a
 * client-chosen id as an existing session, writes no session meta for it without a temporary table, and keeps its
 * state per user (UC3).
 *
 * This module holds what that needs and does no I/O: the per-statement ids, the register of Studio's own statements
 * in flight by query id, the header value, the warnings a statement's affect and echoed role give, and the end-open
 * plan that closes what a statement left open (a transaction with ROLLBACK, temporary tables with a logout, UC5). Ids
 * and the clock are inputs.
 */
import { serverWords } from "./errors";
import type { DatabendAffect, DatabendNotice } from "./transport";

/** The ids one statement carries: the query id of its POST, the session id, and the Cloud gateway's route hint. */
export interface StatementIds {
  /** 32 lower-case hex, used verbatim in the chain's paths (M15a, M15e). */
  readonly queryId: string;
  /** A UUID, echoed back in the first answer's `session_id`. */
  readonly sessionId: string;
  /** bendsql's `rh:<uuid v4>:<6-digit nonce>`; the query server never reads it. */
  readonly routeHint: string;
}

/** A new query id from one UUID of `newId`: its 32 hex digits. Each POST takes one, the ROLLBACK's included. */
export function newQueryId(newId: () => string): string {
  return newId().replaceAll("-", "");
}

/** The ids of one statement, from three UUIDs of `newId` and one draw of `random()` in [0, 1) for the nonce. */
export function statementIds(newId: () => string, random: number): StatementIds {
  const queryId = newQueryId(newId);
  const sessionId = newId();
  const nonce = String(Math.floor(random * 1_000_000)).padStart(6, "0");
  return { queryId, sessionId, routeHint: `rh:${newId()}:${nonce}` };
}

/**
 * Studio's own provider statements in flight, by query id (design 5.5). `system.processes` lists every running
 * statement under the query id it was sent with (`current_query_id`), and Studio draws each one from a random UUID,
 * so the query ids of its own statements tell them apart from every other client's, which no statement text can.
 */
export interface OwnStatements {
  /** Registers one statement's query id until its `end()`. */
  begin(queryId: string): OwnStatement;
}

export interface OwnStatement {
  /**
   * Every query id registered at any moment since this one began, its own included: a read of running statements
   * leaves out each, so a sibling that began before it, or ended before its answer arrived, is covered.
   */
  seen(): ReadonlySet<string>;
  end(): void;
}

/** A register of the query ids in flight; each id is a fresh UUID's, so no two statements share one. */
export function createOwnStatements(): OwnStatements {
  const inFlight = new Set<string>();
  /** One set per statement in flight: every query id registered since it began. */
  const watching = new Set<Set<string>>();
  return {
    begin(queryId) {
      inFlight.add(queryId);
      for (const seen of watching) seen.add(queryId);
      const seen = new Set(inFlight);
      watching.add(seen);
      return {
        seen: () => new Set(seen),
        end() {
          inFlight.delete(queryId);
          watching.delete(seen);
        },
      };
    },
  };
}

/**
 * The `x-databend-session` value: `{"id":<session id>,"last_refresh_time":<unix s>}` in URL-safe base64 with `=`
 * padding, the form Databend's `URL_SAFE` engine decodes (`json_header.rs`).
 */
export function sessionHeader(sessionId: string, nowMs: number): string {
  const json = JSON.stringify({ id: sessionId, last_refresh_time: Math.floor(nowMs / 1000) });
  return Buffer.from(json, "utf8").toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

export const USE_NOT_CARRIED =
  "USE succeeded, but each statement runs in its own session, so it does not carry over. Set Database on the connection, or qualify names.";

export const SETTINGS_NOT_CARRIED =
  "Each statement runs in its own session, so a session-level SET or UNSET does not carry over. SET GLOBAL and UNSET GLOBAL change the setting for every session.";

export function globalSettingsChangedWarning(keys: readonly string[]): string {
  return `SET GLOBAL changed ${keys.join(", ")} for every session, and the change persists.`;
}

export const ROLE_NOT_CARRIED = "SET ROLE does not carry over to the next statement.";

export const TRANSACTION_ENDED =
  "The statement left a transaction open, and each statement runs in its own session, so Studio rolled it back.";

export const TRANSACTION_MAY_STAY_OPEN = "The transaction may stay open until Databend's idle timeout (4 hours).";

export const TEMP_TABLES_DROPPED =
  "Each statement runs in its own session, so Studio ended it, which dropped the temporary tables it created.";

/**
 * The warnings of design 3.7 for one statement: its affect (USE, or SET and UNSET, where `UNSET GLOBAL` reports a
 * false flag), and a role echoed unlike the connect probe's. Either role null gives no role warning: the connect
 * probe itself has none to compare with. Each key SET GLOBAL changed is server text, so it passes `serverWords` with
 * the connection's `secretForms` before a sentence names it.
 */
export function sessionNotices(
  affect: DatabendAffect | null,
  role: string | null,
  probeRole: string | null,
  secretForms: readonly string[],
): DatabendNotice[] {
  const notices: DatabendNotice[] = [];
  if (affect?.type === "UseDB" || affect?.type === "UseCatalog") notices.push({ kind: "use-not-carried" });
  if (affect?.type === "ChangeSettings") {
    const globalKeys = affect.keys.filter((_key, index) => affect.isGlobals[index] === true);
    if (globalKeys.length < affect.keys.length) notices.push({ kind: "settings-not-carried" });
    if (globalKeys.length > 0) {
      notices.push({ kind: "global-settings-changed", keys: globalKeys.map((key) => serverWords(key, secretForms)) });
    }
  }
  if (role !== null && probeRole !== null && role !== probeRole) notices.push({ kind: "role-not-carried" });
  return notices;
}

/** What the last answer said about the session it ended in: its `txn_state` (null with no session) and keep-alive. */
export interface EndOpenInput {
  readonly txnState: string | null;
  readonly needKeepAlive: boolean;
}

/** One best-effort request of the end-open, each under its own 5 s. */
export type EndOpenStep = "kill" | "rollback" | "logout";

/**
 * What closes a statement's session, read from the server's flags and never from SQL text (design 3.4).
 *
 * An `Active` transaction is rolled back; a `Fail` one needs nothing, since only an `Active` one is kept. A session
 * that still needs keep-alive holds a temporary table, which a logout drops. `null` is a POST that may have reached
 * the server with no answer: the kill closes the statement, and one logout drops any temporary table it made, since
 * the session id is ours [X13]; this is the one exit whose close the plan includes, every other is the loop's.
 */
export function endOpenPlan(last: EndOpenInput | null): readonly EndOpenStep[] {
  if (last === null) return ["kill", "logout"];
  const steps: EndOpenStep[] = [];
  if (last.txnState === "Active") steps.push("rollback");
  if (last.needKeepAlive) steps.push("logout");
  return steps;
}

/**
 * The ROLLBACK POST body: the last echoed session verbatim, and a 2 s long poll, so the answer and its final link
 * fit inside the 5 s budget where the default 10 s poll would not [X13].
 */
export function rollbackBody(session: object): string {
  return JSON.stringify({ sql: "ROLLBACK", session, pagination: { wait_time_secs: 2 } });
}

/**
 * The transaction ended only when the ROLLBACK's own answer, `id` equal to the id it was sent under, reports
 * `AutoCommit`; anything else, no answer included, may leave it open until Databend's idle timeout (M18h).
 */
export function rollbackNotice(
  rollbackQueryId: string,
  answer: { readonly id: string; readonly txnState: string | null } | null,
): DatabendNotice {
  return answer?.id === rollbackQueryId && answer.txnState === "AutoCommit"
    ? { kind: "transaction-ended" }
    : { kind: "transaction-may-stay-open" };
}
