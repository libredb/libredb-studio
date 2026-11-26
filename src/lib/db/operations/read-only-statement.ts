/**
 * The one core call of the provider reads the agent hands a read budget that are not statements, and the one row and
 * byte hold of those reads and of the host core's read-only execute.
 *
 * Every statement the agent, the editor's hand-over replay and MCP's statement tools send reaches a provider's
 * `queryReadOnly` through the host core's read-only execute (`runReadOnlyExecute` in src/lib/api/read-only-execute.ts,
 * on the legacy bridge's read-only statement session), and no other module reads it, which
 * `tests/unit/db/operations/read-only-statement-callers.test.ts` holds. `holdReadOnlyRows` is the row and byte check
 * below, which `runReadOnlyReading` and the host core's read-only execute both read, so the measure, the order and the
 * sentences are one; the time below is the readings' own, since the host core's execute stops at its own deadline.
 * Each provider already refuses a result past the row or byte budget it is handed, and bounds its read by the budget's
 * timeout as its engine allows; this module holds the provider's answer to the same budget again, so the caps are
 * Studio's and not only a claim each provider makes. The agent's other budgeted reads, its catalog read on an engine
 * whose catalog is not a composed statement (`readCatalogReadOnly`) and the two cluster readings (`readClusterUsage`,
 * `readWorkloadProfile`), go through `runReadOnlyReading`, the same check over the rows the caller serves from an answer
 * that is not a `QueryResult`, and the same test holds each to its one agent caller:
 *
 * - **Rows.** An answer with more rows than the read's `maxRows` is refused in the row sentence every provider raises
 *   (`rowBudgetSentence`). A read whose rows are not data rows is held to the byte budget only (`maxRows: null`), as the
 *   host core's read-only execute holds an estimating plan (`mode: "estimate-plan"`), whose rows are the optimizer's
 *   operators (SQL Server's SHOWPLAN answers one per operator, 340 for an ordinary union of one view with itself). A
 *   reading documented with a row ceiling of its own is held to that ceiling instead (the cluster readings carry up to
 *   500 rows, above the run's 200).
 * - **Bytes.** The UTF-8 JSON bytes of each served row are summed (`measureRowBytes`, a bigint cell counting as its
 *   decimal text), stopping at the row that carries the sum past `maxResultBytes`, which is refused in the byte
 *   sentence (`byteBudgetSentence`); a row after that one is never serialised. The per-row sum is never more than the
 *   whole array's JSON, which adds brackets and commas, so no answer a provider admitted by measuring the rows it
 *   serves is refused here. It is the size of the rows a prompt, an MCP answer or a hand-over response carries, which
 *   is why MongoDB's BSON measure on the wire is followed by this one.
 * - **Time.** `runReadOnlyReading` stops waiting at `statementTimeoutMs` and refuses in the time sentence
 *   (`TIME_BUDGET_PREFIX`). The wait starts when the provider's read returns its promise, so it includes the provider's
 *   own connection checkout: a read refused here may not have started yet, and may still start once a connection
 *   frees, and a connection that failed to open after the timer is answered in the same time sentence. The abandoned
 *   call is not cancelled. It runs on until the engine's own deadline ends it, where the engine has one, and to its end
 *   where it has none. The provider's call is handed to the caller's `holdUntilSettled` as soon as it is made, so an
 *   agent run's `maxConcurrentExecutions` counts each read until its provider call settles, whenever this function
 *   answers. The abandoned call keeps a handler, so its late failure is never an unhandled rejection, and how it
 *   settled (answered or failed, the failure's class, and when) is written to the server log; the agent's three family
 *   readings above are the only reads that write that line, since every statement's stopped wait is the host core's
 *   and is logged there. A provider that runs a read synchronously on the event loop returns its promise only once the
 *   read has ended, so no timer bounds it, and its own check once the read returns stays the bound there.
 *
 * The refusals are the sentences the providers raise (`read-only-budget.ts`), raised as core's own budget classes, so
 * every reader, which decides a refusal by its class, reads this module's as a budget refusal whatever its words. A
 * reading that already refuses past its rows or bytes in sentences of its own (the cluster readings' advice to
 * narrow) hands them in, and core raises those.
 *
 * Before anything else, an engine Studio's review record does not list (`GRANTED_AGENT_EXECUTION_ENGINES` in
 * src/lib/db/claim-grants.ts) is refused by name with `PROFILE_ENGINE_NOT_REVIEWED` (`assertStatementsReviewed`), for
 * every budgeted reading, whatever the provider implements, so no budget is read, no provider call is made and nothing
 * is held. The gate keys on the connection type the caller declares (`type`), not on the provider handed over, so it
 * holds whatever acquirer handed the provider over only while every caller declares the type of the connection that
 * provider was acquired for, which every caller does today. The host core's read-only execute reads the same record
 * first for every agent, hand-over and MCP statement. The one composed statement that passes neither is plan mode's
 * statistics read on an engine whose catalog read is not a composed statement (`readStatisticsForGrounding` under
 * `agent-operations`, through the plain `query()` of the host core's composed statement session,
 * `runComposedStatement`), which stays on reviewed engines only because its composer belongs to an engine overlay, an
 * overlay needs a statement language, and the language census ties every language to the record.
 */

import { StudioByteBudgetRefusal, StudioRowBudgetRefusal, StudioTimeBudgetRefusal } from "@/lib/db/errors";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  measureRowBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/read-only-budget";
import { type ProviderTextScrub, scrubProviderText } from "@/lib/db/operations/provider-text";
import { assertStatementsReviewed } from "@/lib/db/statement-review";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { DatabaseType } from "@/lib/types";

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
  /** The calling connection's scrub, applied to the provider's error class name in the late-settlement log line. */
  readonly scrub: ProviderTextScrub;
  /** The read's own label, named in a refusal where a statement would be. */
  readonly statement: string;
  /** The budget the provider is handed; checked before `read` is made. */
  readonly budget: ReadOnlyStatementBudget;
  /**
   * Handed the provider's call as soon as it is made. A caller that accounts the call (an agent run's execution) keeps
   * it counted until the call settles, which after a time refusal is later than this function's own answer.
   */
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

/** Makes `call.read` and holds the rows it serves to `call.maxRows`, `call.budget.maxResultBytes` and its timeout. */
export async function runReadOnlyReading<T>(call: ReadOnlyReadingCall<T>): Promise<T> {
  const { type, statement, budget, maxRows } = call;
  // First, before the budget is read, the provider's read is made or the call is held: the connection type the caller
  // declares is refused by name here when it is off the review record, whatever acquirer handed the provider over.
  assertStatementsReviewed(type);
  assertReadOnlyBudget(budget, type);
  const answered = call.read();
  call.holdUntilSettled?.(answered);
  const answer = await withinStatementTimeout(answered, call);
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
