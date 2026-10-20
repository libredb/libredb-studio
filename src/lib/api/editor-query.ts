import { bridgeAbortToCancel } from "@/lib/api/abort-cancel";
import { firstResultSet } from "@/lib/api/first-result-set";
import { pageOfProbe, pageOptionError, probePastPage } from "@/lib/api/page-probe";
import { consoleTextByteLimit, consoleTextOverLimit } from "@/lib/db/destructive-commands";
import { QueryCancelledError } from "@/lib/db/errors";
import { supportsQueryCancel } from "@/lib/db/query-cancel";
import { endsOpenQueryTransactions, newQueryCallScope } from "@/lib/db/types";
import type { DatabaseProvider, OpenQueryTransactionOutcome, QueryPrepareOptions } from "@/lib/db/types";
import { noteAppendedBound } from "@/lib/db/utils/query-limiter";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import type { DatabaseType, QueryPagination, QueryResult } from "@/lib/types";

/*
 * THE EDITOR QUERY'S PROVIDER-FACING STEPS, WITH NO NEXT IN THEM.
 *
 * Two callers run one statement through these two steps, in this order: `POST /api/db/query`
 * (`src/app/api/db/query/route.ts`) and the VS Code extension's backend child, whose `query/run`
 * re-does what the route does for one statement. `checkEditorQuery` holds the checks that run before
 * any provider resolves; `runEditorQuery` takes a provider the caller already resolved under its
 * posture and catalog, and runs it.
 *
 * What stays with each caller is what only that caller has: the session guard and rate limit, seed
 * resolution, the `sql` and `queryId` field checks, bound params, EXPLAIN, the `database` key-space
 * override, the admission gate, query events, how the provider is resolved, and how an error is
 * answered.
 */

/**
 * What `checkEditorQuery` reads: the statement as sent, the connection's type, and the page bounds as sent.
 * The statement is `unknown` because the route hands over its body field unchecked; the caller still owns
 * the `sql` and `queryId` field checks.
 */
export interface EditorQueryRequest {
  statement: unknown;
  type: DatabaseType;
  options: unknown;
}

/** A request refused before any provider resolves, with the status and sentence the route answers. */
export interface EditorQueryRefusal {
  status: 400 | 413;
  error: string;
}

/**
 * Why this request is refused, or null when neither check refuses it: the page bounds first, then the
 * console text bound of a connection type that declares one. Null does not mean the request can run:
 * only a type with a text bound has its statement held to a string here, so a new caller checks that the
 * statement and the `queryId` are strings itself before it calls `runEditorQuery`. The route checks only
 * that `sql` is present and that `queryId` is a string, as it did before this module existed.
 */
export function checkEditorQuery(request: EditorQueryRequest): EditorQueryRefusal | null {
  const optionError = pageOptionError(request.options);
  if (optionError !== null) return { status: 400, error: optionError };

  // A connection type that declares a console text bound is held to it here, before the bound parameters, the
  // provider and the statement cache are reached, so an oversize text opens no socket. The answer names the size
  // and the bound and never repeats the text. The bound is read from the type in the body, after the JSON has been
  // parsed: a streamed bound on the request itself would change every engine and is a separate decision.
  const textLimit = consoleTextByteLimit(request.type);
  if (textLimit !== undefined) {
    if (typeof request.statement !== "string") return { status: 400, error: "sql must be a string" };
    const over = consoleTextOverLimit(request.statement, textLimit);
    if (over !== undefined) return { status: 413, error: over };
  }
  return null;
}

/** One run of a statement that `checkEditorQuery` passed, on a provider the caller resolved. */
export interface EditorQueryRun {
  /** The text that runs: the route's EXPLAIN-built one, or the caller's own. */
  statement: string;
  /** The page bounds, already passed by `checkEditorQuery`. */
  options: QueryPrepareOptions;
  /** Bound params, bound to `statement` as written. */
  params?: unknown[];
  /** The id a provider tracks the run under and a cancel names it by. */
  queryId?: string;
  /** Aborted when the caller goes away; the run is then cancelled under `queryId`. */
  signal: AbortSignal;
  /** The label a failed cancel is logged under. */
  route: string;
}

/** The answer's body: the first result set's page, with `pagination` always present. */
export interface EditorQueryBody extends Omit<QueryResult, "resultSets" | "pagination"> {
  openTransaction?: "rolled-back";
  pagination: QueryPagination;
}

/** The body, and how many result sets the text produced, which the body itself does not carry. */
export interface EditorQueryAnswer {
  body: EditorQueryBody;
  resultSetCount: number;
}

/** Runs one statement on `provider` and answers its first result set's page. */
export async function runEditorQuery(provider: DatabaseProvider, run: EditorQueryRun): Promise<EditorQueryAnswer> {
  const { statement, options } = run;
  const prepared = provider.prepareQuery(statement, options);

  // The statement that runs asks for a row past the page (#1440); see `probePastPage`.
  const probe = probePastPage(provider, statement, options, prepared);

  // A SINGLE STATEMENT CAN LEAVE A TRANSACTION OPEN, SO THIS RUN ENDS IT (D74).
  //
  // MEASURED 2026-09-15 against PostgreSQL 18.4 through the query route with the real
  // provider and the real process-wide cache: a lone `BEGIN` answered 200 and released
  // its pooled client in status `T`, and the next request on the same cached provider,
  // which is any other signed-in user of that stored connection, ran its `CREATE TABLE`
  // inside that stranger's transaction, answered 200, and an independent reader saw no
  // such table. Driven the other way the loss is loud: a `BEGIN` followed by a statement
  // naming a missing relation leaves the client in `E` and the next request answers 500.
  //
  // This `finally` was tried once before and REVERTED, because the ender it calls named
  // one shared pointer: it rolled back whichever client anybody had recorded last, which
  // cost a concurrent `/api/db/multi-query` script its committed `CREATE TABLE` and an
  // interactive `POST /api/db/transaction` session its own. D87 fixed that in the
  // provider, where the borrowed client is in scope, and the `scope` minted here is what
  // names this run's own session: nothing this run did not run on can be ended.
  //
  // It is a `finally` and not a line after the call because the statement that poisons a
  // client is usually the one that threw, and the answer must not be able to leave by
  // a path that skips this.
  const scope = newQueryCallScope();
  let openTransaction: OpenQueryTransactionOutcome = "none";

  // Pass queryId to provider for cancellation tracking, and cancel it if the caller goes away while it runs.
  // A cancel is idempotent, and the bridge cancels only the id this run bound, so it needs no owner check;
  // the multi-query route's docblock (`src/app/api/db/multi-query/route.ts`) gives both rules in full.
  const supportsCancel = supportsQueryCancel(provider);
  const cancelId = supportsCancel ? run.queryId : undefined;
  // A caller already gone starts nothing.
  if (run.signal.aborted) throw new QueryCancelledError("The query was cancelled.");
  const release = bridgeAbortToCancel(run.signal, provider, cancelId, run.route);
  let result: Awaited<ReturnType<typeof provider.query>>;
  try {
    result = await provider.query(probe.query, run.params, cancelId, scope);
  } catch (error) {
    // An error that names the bound the limiter added says so, rather than pointing into text the user never wrote.
    throw noteAppendedBound(error, statement, probe.query);
  } finally {
    release();
    if (endsOpenQueryTransactions(provider)) {
      openTransaction = await provider.endOpenQueryTransaction(scope);
    }
  }

  // PAGE TWO IS ONLY OFFERED FOR A BOUND THIS LAYER APPLIED (#816).
  //
  // `wasLimited` is the limiter saying it rewrote the statement, and it is the only
  // thing that makes advancing the bound meaningful: a statement returned untouched
  // (one carrying the user's own `LIMIT 50`, or a ClickHouse query whose trailing
  // `FORMAT`/`SETTINGS` clause the limiter declines to cut into) runs the same way at
  // every offset. Without this conjunct such a statement, answering with exactly
  // `prepared.limit` rows, offered a Load More whose click re-ran it unchanged and
  // appended the rows already on screen, which the user cannot tell from new ones.
  //
  // One rule, per statement, with no branching on database type: if the bound is ours,
  // pagination is offered; if it is the user's, or the statement could not be
  // rewritten, it is not.
  //
  // The probe row is the proof (#1440): more than `prepared.limit` rows came back, so a next
  // page exists, and the page itself is cut back to the limit asked for.
  const { hasMore, rows: pageRows } = pageOfProbe(prepared, result.rows);
  const answered = firstResultSet(result);
  return {
    body: {
      ...answered,
      // The probe row is not part of the answer, so the count that names the rows is the page's.
      ...(hasMore && { rowCount: pageRows.length }),
      // NaN and the infinities as words: `JSON.stringify` would write each as null, which
      // the grid and every export then show as SQL NULL (`src/lib/non-finite.ts`).
      rows: rowsWithNonFiniteWords(pageRows),
      // Present only when there was a transaction to end, the way `/api/db/multi-query`
      // reports it, so an always-present "none" would announce something that did not happen.
      // `use-query-execution.ts` raises the notice off this field on BOTH paths; it used to raise
      // it only inside its `multiStatement` branch, which a lone statement never sets, so this
      // field was answered and never rendered for its whole first commit.
      ...(openTransaction === "rolled-back" && { openTransaction }),
      pagination: {
        limit: prepared.limit,
        offset: prepared.offset,
        hasMore,
        totalReturned: pageRows.length,
        // A bound the PROVIDER applied is reported too (#1085, section 5.4). A provider that cuts
        // its own result, as the Prometheus provider cuts a vector at its series cap, says so on
        // the result's own `pagination`, and the badge this field drives says "Studio bounded this
        // result", which is as true of that bound as of the limiter's. Only a `true` crosses, so a
        // provider cannot clear a filled bound this layer applied. A short page does not show
        // the limiter badge; `hasMore` above stays on
        // `prepared.wasLimited` alone, because an offset can only advance a bound this layer wrote.
        wasLimited: hasMore || result.pagination?.wasLimited === true,
      },
    },
    resultSetCount: result.resultSets?.length ?? 1,
  };
}
