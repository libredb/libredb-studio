/**
 * MCP's core call of a provider's read-only statement path (`DatabaseProvider.queryReadOnly`), the one core call of
 * the other provider reads the agent hands the same budget, and the one row and byte hold of both and of the host
 * core's read-only execute.
 *
 * Every MCP statement tool reaches a provider's `queryReadOnly` through `runReadOnlyStatement`; the agent's statement
 * path and the editor's hand-over replay reach it through the host core's read-only execute (`runReadOnlyExecute` in
 * src/lib/api/read-only-execute.ts, on the legacy bridge's read-only statement session), and no other module reads it,
 * which `tests/unit/db/operations/read-only-statement-callers.test.ts` holds. `holdReadOnlyRows` is the row and byte
 * check below, which `runReadOnlyReading` and the host core's read-only execute both read, so the measure, the order
 * and the sentences are one; the time below is MCP's and the readings', since the host core's execute stops at its
 * own deadline. Each provider already refuses a result past the row or byte budget it is handed, and bounds the
 * statement by the budget's timeout as its engine allows; this function holds the provider's answer to the same budget
 * again, so the caps are Studio's and not only a claim each provider makes. The agent's other budgeted reads, its
 * catalog read on an engine whose catalog is not a composed statement (`readCatalogReadOnly`) and the two cluster
 * readings (`readClusterUsage`, `readWorkloadProfile`), go through `runReadOnlyReading`, the same check over the rows
 * the caller serves from an answer that is not a `QueryResult`, and the same test holds each to its one agent caller;
 * `runReadOnlyStatement` is that function over `queryReadOnly`:
 *
 * - **Rows.** An answer with more rows than `maxResultRows` is refused in the row sentence every provider raises
 *   (`rowBudgetSentence`). An estimating plan (`mode: "estimate-plan"`) is held to the byte budget only: its rows are
 *   the optimizer's operators, not data rows (SQL Server's SHOWPLAN answers one per operator, 340 for an ordinary
 *   union of one view with itself), and SQL Server's provider exempts them from its row budget the same way. The mode
 *   is the caller's own choice (`composeEstimatingExplain`, `mongoInspectPlanTool`), not a provider's claim, and the
 *   exemption rests on the obligation `ReadOnlyStatementMode` states: a provider handed `"estimate-plan"` answers a
 *   plan or refuses, so the byte budget is then the only cap core holds that answer to. A reading documented with a
 *   row ceiling of its own is held to that ceiling instead (the cluster readings carry up to 500 rows, above the run's
 *   200).
 * - **Bytes.** The UTF-8 JSON bytes of each served row are summed (`measureRowBytes`, a bigint cell counting as its
 *   decimal text), stopping at the row that carries the sum past `maxResultBytes`, which is refused in the byte
 *   sentence (`byteBudgetSentence`); a row after that one is never serialised. The per-row sum is never more than the
 *   whole array's JSON, which adds brackets and commas, so no answer a provider admitted by measuring the rows it
 *   serves is refused here. It is the size of the rows a prompt, an MCP answer or a hand-over response carries, which
 *   is why MongoDB's BSON measure on the wire is followed by this one.
 * - **Time.** With `wait: "statement-timeout"` this function stops waiting at `statementTimeoutMs` and refuses in the
 *   time sentence (`TIME_BUDGET_PREFIX`). The wait starts when the provider's `queryReadOnly` returns its promise, so it
 *   includes the provider's own connection checkout: a statement refused here may not have started yet, and may still
 *   start once a connection frees, and a connection that failed to open after the timer is answered in the same time
 *   sentence. The abandoned call is not cancelled. It runs on until the engine's own deadline ends it, where the
 *   engine has one, and to its end where it has none (DuckDB, Db2 LUW, Cassandra, Elasticsearch and OpenSearch, the
 *   engine table in `docs/MCP.md` "Limits"); on a provider that runs its statements on one connection, as DuckDB does,
 *   a later statement on that connection waits behind it and can itself be refused in the time sentence without
 *   having run. The provider's call is handed to the caller's `holdUntilSettled` as soon as it is made, so an agent
 *   run's `maxConcurrentExecutions` counts each read until its provider call settles, whenever this function
 *   answers. The abandoned call keeps a handler, so its late failure is never an
 *   unhandled rejection, and how it settled (answered or failed, the failure's class, and when) is written to the
 *   server log. A provider that runs a statement synchronously on the event loop (LibreDB, SQLite without its worker)
 *   returns its promise only once the statement has ended, so no timer bounds it, and its own check once the statement
 *   returns stays the bound there. With `wait: "caller-deadline"` the caller already races its own deadline over this
 *   call (MCP's `raceDeadline`), so no second timer is set.
 *
 * The refusals are the sentences the providers raise (`read-only-budget.ts`), raised as core's own budget classes, so
 * every reader, which decides a refusal by its class, reads this function's as a budget refusal whatever its words. A
 * reading that already refuses past its rows or bytes in sentences of its own (the cluster readings' advice to
 * narrow) hands them in, and core raises those.
 *
 * Before anything else, an engine Studio's review record does not list (`AGENT_EXECUTION_ENGINES` in
 * src/lib/db/compatibility.ts) is refused by name with `PROFILE_ENGINE_NOT_REVIEWED` (`assertStatementsReviewed`), for a
 * statement and for every budgeted reading, whatever the provider implements, so no budget is read, no provider call
 * is made and nothing is held. The gate keys on the connection type the caller declares (`type`), not on the provider
 * handed over, so it holds whatever acquirer handed the provider over only while every caller declares the type of
 * the connection that provider was acquired for, which every caller does today. This is the one choke point every
 * MCP read-only statement passes, beside the acquisition's own reading of the record, and the host core's read-only
 * execute reads it first too, for every agent and hand-over statement. The one
 * composed statement that does not pass it is plan mode's statistics read on an engine whose catalog read is not a
 * composed statement (`readStatisticsForGrounding` under `agent-operations`, through `query()`), which stays on
 * reviewed engines only because its composer belongs to an engine overlay, an overlay needs a statement language, and
 * the language census ties every language to the record.
 *
 * A provider with no `queryReadOnly` on an engine the record lists is refused by name, in the words the
 * execution-profile acquisition uses; `query()` is never the fallback.
 */

import {
  StudioByteBudgetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
} from "@/lib/db/errors";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  measureRowBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/read-only-budget";
import { type ProviderTextScrub, scrubProviderText } from "@/lib/db/operations/provider-text";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import type { DatabaseProvider, ReadOnlyStatementBudget, ReadOnlyStatementMode } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { DatabaseType, QueryResult } from "@/lib/types";

/** One statement for a provider's read-only statement path, with the budget core holds its answer to. */
export interface ReadOnlyStatementCall {
  /**
   * The connection's type, named in a refusal. It decides the review-record gate, so it must be the type of the
   * connection the provider was acquired for.
   */
  readonly type: DatabaseType;
  /** The calling connection's scrub, applied to the provider's error class name in the late-settlement log line. */
  readonly scrub: ProviderTextScrub;
  readonly statement: string;
  readonly budget: ReadOnlyStatementBudget;
  readonly mode?: ReadOnlyStatementMode;
  /**
   * `"statement-timeout"`: this function stops waiting at `budget.statementTimeoutMs`. `"caller-deadline"`: the caller
   * already races its own deadline over this call, so a second timer is not set.
   */
  readonly wait: "statement-timeout" | "caller-deadline";
  /**
   * Handed the provider's call as soon as it is made. A caller that accounts the call (an agent run's execution,
   * `executeAuditedOperation`'s `holdUntilSettled`) keeps it counted until the call settles, which after a time
   * refusal is later than this function's own answer.
   */
  readonly holdUntilSettled?: (call: PromiseLike<unknown>) => void;
}

/**
 * One budgeted provider read that is not a statement (`readCatalogReadOnly`, `readClusterUsage`,
 * `readWorkloadProfile`), with the budget core holds the rows it serves to. Its answer is the provider's own shape, so
 * the caller names the rows it serves from it, and those rows, the ones a prompt carries, are what is measured.
 */
export interface ReadOnlyReadingCall<T> {
  /**
   * The connection's type, named in a refusal. It decides the review-record gate, so it must be the type of the
   * connection the read's provider was acquired for.
   */
  readonly type: DatabaseType;
  /** As `ReadOnlyStatementCall.scrub`. */
  readonly scrub: ProviderTextScrub;
  /** The read's own label, named in a refusal where a statement would be. */
  readonly statement: string;
  /** The budget the provider is handed; checked before `read` is made. */
  readonly budget: ReadOnlyStatementBudget;
  /** As `ReadOnlyStatementCall.wait`. */
  readonly wait: "statement-timeout" | "caller-deadline";
  /** As `ReadOnlyStatementCall.holdUntilSettled`. */
  readonly holdUntilSettled?: (call: PromiseLike<unknown>) => void;
  /** The provider's call, made once, after the budget is checked. */
  readonly read: () => Promise<T>;
  /** The rows the caller serves from the answer: none for an answer that carries no rows. */
  readonly servedRows: (answer: T) => readonly Record<string, unknown>[];
  /**
   * The most rows the read may serve: `budget.maxResultRows`, or a ceiling of the read's own where it has one, or
   * `null` for an answer held to the byte budget only (an estimating plan, whose rows are not data rows).
   */
  readonly maxRows: number | null;
  /** The refusal past `maxRows`, where the read raises one of its own; otherwise the row sentence. */
  readonly refuseRows?: (rows: number, allowed: number) => Error;
  /** The refusal past `maxResultBytes`, where the read raises one of its own; otherwise the byte sentence. */
  readonly refuseBytes?: (bytes: number, allowed: number) => Error;
}

/** Runs `call.statement` on the provider's read-only statement path and holds the answer to `call.budget`. */
export async function runReadOnlyStatement(
  provider: DatabaseProvider,
  call: ReadOnlyStatementCall,
): Promise<QueryResult> {
  const { type, statement, budget, mode } = call;
  return runReadOnlyReading({
    type,
    scrub: call.scrub,
    statement,
    budget,
    wait: call.wait,
    ...(call.holdUntilSettled === undefined ? {} : { holdUntilSettled: call.holdUntilSettled }),
    read: () => {
      if (typeof provider.queryReadOnly !== "function") {
        throw new StudioProfileRefusal(
          `Provider type "${type}" implements no read-only statement path (queryReadOnly)`,
          "PROFILE_UNSUPPORTED_BY_PROVIDER",
        );
      }
      return provider.queryReadOnly(statement, budget, mode);
    },
    servedRows: (result) => result.rows,
    // A plan's rows are the optimizer's operators, not data rows (SQL Server's SHOWPLAN answers one per operator), so
    // an estimating plan is held to the byte budget only, as SQL Server's provider holds it.
    maxRows: mode === "estimate-plan" ? null : budget.maxResultRows,
  });
}

/** Makes `call.read` and holds the rows it serves to `call.maxRows`, `call.budget.maxResultBytes` and its timeout. */
export async function runReadOnlyReading<T>(call: ReadOnlyReadingCall<T>): Promise<T> {
  const { type, statement, budget, maxRows } = call;
  // First, before the budget is read, the provider's read is made or the call is held: the connection type the caller
  // declares is refused by name here when it is off the review record, whatever acquirer handed the provider over.
  assertStatementsReviewed(type);
  assertReadOnlyBudget(budget, type);
  const answered = call.read();
  call.holdUntilSettled?.(answered);
  const answer = call.wait === "statement-timeout" ? await withinStatementTimeout(answered, call) : await answered;
  holdReadOnlyRows(call.servedRows(answer), {
    type,
    statement,
    maxRows,
    maxBytes: budget.maxResultBytes,
    ...(call.refuseRows === undefined ? {} : { refuseRows: call.refuseRows }),
    ...(call.refuseBytes === undefined ? {} : { refuseBytes: call.refuseBytes }),
  });
  return answer;
}

/** What `holdReadOnlyRows` holds served rows to, and the refusals it raises past each bound. */
export interface ReadOnlyRowsHold {
  /** The connection's type, named in a shared refusal. */
  readonly type: DatabaseType;
  /** The statement, or a reading's label, named in a shared refusal. */
  readonly statement: string;
  /** As `ReadOnlyReadingCall.maxRows`: `null` holds the rows to the byte budget only. */
  readonly maxRows: number | null;
  readonly maxBytes: number;
  /** As `ReadOnlyReadingCall.refuseRows`. */
  readonly refuseRows?: (rows: number, allowed: number) => Error;
  /** As `ReadOnlyReadingCall.refuseBytes`. */
  readonly refuseBytes?: (bytes: number, allowed: number) => Error;
}

/**
 * Holds `rows`, the rows a read serves, to `hold`: more rows than `maxRows` are refused in the row sentence, and the
 * UTF-8 JSON bytes of each row are summed (`measureRowBytes`), stopping at the row that carries the sum past
 * `maxBytes`, which is refused in the byte sentence; a row after that one is never serialised. The one hold of
 * `runReadOnlyReading` and of the agent's and the hand-over's read-only execute (`runReadOnlyExecute`), so the measure,
 * the order and the sentences are one.
 *
 * @throws {StudioRowBudgetRefusal} Past the rows, unless `refuseRows` raises its own.
 * @throws {StudioByteBudgetRefusal} Past the bytes, unless `refuseBytes` raises its own.
 */
export function holdReadOnlyRows(rows: readonly Record<string, unknown>[], hold: ReadOnlyRowsHold): void {
  const { type, statement, maxRows, maxBytes } = hold;
  if (maxRows !== null && rows.length > maxRows) {
    throw (hold.refuseRows ?? sharedRowRefusal(type, statement))(rows.length, maxRows);
  }
  let bytes = 0;
  for (const row of rows) {
    bytes += measureRowBytes(row);
    if (bytes > maxBytes) {
      throw (hold.refuseBytes ?? sharedByteRefusal(type, statement))(bytes, maxBytes);
    }
  }
}

function sharedRowRefusal(type: DatabaseType, statement: string): (rows: number, allowed: number) => Error {
  return (rows, allowed) => new StudioRowBudgetRefusal(rowBudgetSentence(rows, allowed), type, statement);
}

function sharedByteRefusal(type: DatabaseType, statement: string): (bytes: number, allowed: number) => Error {
  return (bytes, allowed) => new StudioByteBudgetRefusal(byteBudgetSentence(bytes, allowed), type, statement);
}

/**
 * `answered`, or the time refusal once `statementTimeoutMs` has passed; the timer is cleared on every path. When the
 * timer wins, how the abandoned call settles later is written to the server log (`logLateSettlement`).
 */
function withinStatementTimeout<T>(
  answered: Promise<T>,
  call: Pick<ReadOnlyReadingCall<T>, "type" | "scrub" | "statement" | "budget">,
): Promise<T> {
  const { statementTimeoutMs } = call.budget;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      logLateSettlement(answered, call.type, call.scrub, startedAt);
      reject(
        new StudioTimeBudgetRefusal(
          `${TIME_BUDGET_PREFIX}: no answer within ${statementTimeoutMs}ms`,
          call.type,
          call.statement,
        ),
      );
    }, statementTimeoutMs);
  });
  // Promise.race subscribes to `answered`, so a rejection that arrives after the timer won is handled, not unhandled.
  return Promise.race([answered, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * One server log line for a call this module stopped waiting for, once it settles, worded for a statement and a
 * reading alike: the connection type, whether it answered or failed, the failure's class and how long after the call
 * started it settled. A late failure can be the real cause the time refusal stood in for (a connection that never
 * opened, a pool with no free client), so it is recorded rather than dropped. The statement, a reading's label and the
 * error's message are never written, and the class names the kind of failure. The class name is set by whoever raised
 * the error, a provider included, so it passes core's scrub of provider text first.
 */
function logLateSettlement(
  answered: Promise<unknown>,
  type: DatabaseType,
  scrub: ProviderTextScrub,
  startedAt: number,
): void {
  const line = "A read-only call settled after Studio stopped waiting for it";
  answered.then(
    () => logger.warn(line, { provider: type, outcome: "answered", settledAfterMs: Date.now() - startedAt }),
    (error: unknown) =>
      logger.warn(line, {
        provider: type,
        outcome: "failed",
        errorClass: error instanceof Error ? scrubProviderText(scrub, error.name) : typeof error,
        settledAfterMs: Date.now() - startedAt,
      }),
  );
}
