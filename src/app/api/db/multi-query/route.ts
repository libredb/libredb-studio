import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { getOrCreateProvider } from "@/lib/db";
import { splitExecutionUnits, type ExecutionUnit } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { createErrorResponse } from "@/lib/api/errors";
import { pageOptionError } from "@/lib/api/page-probe";
import { QueryCancelledError } from "@/lib/db/errors";
import {
  type ProviderTextScrub,
  providerTextScrub,
  withholdProviderError,
  withScrubbedWarnings,
} from "@/lib/db/operations/provider-text";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";
import { consoleTextByteLimit } from "@/lib/db/destructive-commands";
import type { DatabaseConnection, QueryResult, QueryWarning } from "@/lib/types";
import { openWithinCall, queryTimeoutError } from "@/lib/api/editor-query";
import { type EditorScript, openEditorScript } from "@/lib/api/editor-script";
import type { OpenQueryTransactionOutcome } from "@/lib/db/types";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { admitQueryExecution } from "@/lib/query-events/admission";
import { gateRun } from "@/lib/api/run-confirmation";
import { runConfirmationIssuerForSession } from "@/lib/api/run-confirmation-token";
import { queryEventStart } from "@/lib/query-events/build";
import {
  type QueryEventRequest,
  queryEventRequest,
  recordExecutedUnit,
  recordRefusedRequest,
  requestedConnectionId,
} from "@/lib/query-events/route-events";
import { uuidv7 } from "@/lib/query-events/uuidv7";

export interface StatementResult {
  index: number;
  sql: string;
  startLine: number;
  status: "success" | "error";
  rows?: Record<string, unknown>[];
  fields?: string[];
  rowCount?: number;
  executionTime: number;
  error?: string;
  /**
   * The two additive channels #273 gave the shared result, carried per statement
   * because that is where they are attributable: a notice belongs to the run that
   * produced it, and a declared type describes that run's own projection. Absent
   * when the engine reported none, never empty — the grid decides whether to
   * render anything from the field's presence alone (#285).
   */
  warnings?: QueryWarning[];
  columnTypes?: Record<string, string>;
}

/**
 * The channels a result carries beyond its rows, kept absent when the source has
 * none — the grid decides whether to render a section from the field's presence
 * alone, so an empty array would announce one with nothing in it (#285).
 *
 * Shared by the per-statement result and the main one, which is why it takes the
 * fields rather than a whole result: both shapes have exactly these two.
 */
function carriedChannels(source: Pick<StatementResult, "warnings" | "columnTypes"> | undefined) {
  return {
    ...(source?.warnings && { warnings: source.warnings }),
    ...(source?.columnTypes && { columnTypes: source.columnTypes }),
  };
}

/**
 * What a unit's result shows. A batch that produced several result sets shows the last one,
 * empty or not (#2286) - the same rule a script's statements follow since #2271, so a plain
 * `SELECT * FROM a; SELECT * FROM b` shows what it showed when the two were separate
 * requests. A unit that produced one set shows it.
 *
 * The count is the shown set's own rows in a batch of several statements: the engine's
 * `rowCount` there is the FIRST statement's (SQL Server's `rowsAffected[0]`), so
 * `INSERT INTO t VALUES (1),(2); SELECT * FROM t` would report 2 beside five rows. A batch
 * that returned no set at all keeps the engine's count, the only one it has.
 */
function shownSet(result: QueryResult, unit: ExecutionUnit) {
  const batch = unit.statements.length > 1;
  const sets = batch ? result.resultSets : undefined;
  if (sets === undefined) {
    const rowCount = batch && result.fields.length > 0 ? result.rows.length : result.rowCount;
    return { rows: result.rows, fields: result.fields, rowCount, columnTypes: result.columnTypes };
  }
  const set = sets[sets.length - 1];
  return { rows: set.rows, fields: set.fields, rowCount: set.rows.length, columnTypes: set.columnTypes };
}

/**
 * Where a script's units record their query events (docs/GOVERNANCE.md#query-events): one `multi-query` event per unit
 * that ran, with its index and the correlation id every unit of the request shares.
 */
interface UnitEvents {
  readonly request: QueryEventRequest;
  readonly connection: DatabaseConnection;
  readonly correlationId: string;
}

/**
 * A unit's statement error as the script answers it: the message of what core's scrub answers for it, so an error
 * whose text holds a credential of the connection answers the withheld sentence, and anything else that is not an
 * `Error` answers "Unknown error".
 */
function statementError(scrub: ProviderTextScrub, error: unknown): string {
  const answered = withholdProviderError(scrub, error);
  return answered instanceof Error ? answered.message : "Unknown error";
}

/**
 * Run one unit of the script through the editor's script facade and describe the outcome, including the error when it
 * failed: the loop decides what to do about it. The unit's text, and the bound the last one is sent with, are the
 * facade's to send (`openEditorScript`, src/lib/api/editor-script.ts); its answer is built here, from the provider's
 * result by reference, before the facade releases the unit's page.
 */
async function runStatement(
  script: EditorScript,
  stmt: ExecutionUnit,
  index: number,
  events: UnitEvents,
  scrub: ProviderTextScrub,
): Promise<StatementResult> {
  const startTime = performance.now();
  const started = queryEventStart();
  // The unit as the user wrote it, never with the bound added to the last one.
  const unit = {
    connection: events.connection,
    statement: stmt.sql,
    started,
    unitIndex: index,
    correlationId: events.correlationId,
  };
  const identity = { index, sql: stmt.sql, startLine: stmt.startLine };

  const outcome = await script.runUnit(index, (result: QueryResult): StatementResult => {
    const { columnTypes, ...shown } = shownSet(result, stmt);
    recordExecutedUnit(events.request, { ...unit, ended: { rowCount: shown.rowCount } });
    return {
      ...identity,
      status: "success",
      ...shown,
      // NaN and the infinities as words, which `JSON.stringify` would write as null
      // (`src/lib/non-finite.ts`). The main result reuses this array, so it carries them too.
      rows: rowsWithNonFiniteWords(shown.rows),
      executionTime: Math.round(performance.now() - startTime),
      // A warning field that holds a credential of the connection is withheld; the main result reuses these.
      ...carriedChannels({ warnings: withScrubbedWarnings(scrub, result).warnings, columnTypes }),
    };
  });
  if (outcome.kind === "answered") return outcome.value;
  // The last statement's bound, when an error names it, was already said to be Studio's by the facade.
  recordExecutedUnit(events.request, { ...unit, ended: { error: outcome.error } });
  return {
    ...identity,
    status: "error",
    executionTime: Math.round(performance.now() - startTime),
    error: statementError(scrub, outcome.error),
  };
}

/** What a script's run answers: every unit's outcome, their summed time, and what became of its transaction. */
interface ScriptRun {
  readonly results: StatementResult[];
  readonly totalExecutionTime: number;
  readonly openTransaction: OpenQueryTransactionOutcome;
}

/**
 * Runs the script's units in order, stopping at the first that fails or once the request has left, and ends its scope
 * once after the last unit it ran.
 *
 * MAY A SCRIPT LEAVE A TRANSACTION OPEN? No, and the finally below is the answer.
 *
 * The provider this route borrows is cached per `connection.id` for the whole
 * process (`getOrCreateProvider`), so a transaction that outlives the request does
 * not belong to the person who opened it any more: it belongs to whoever borrows
 * the handle next. Measured 2026-09-13 through this route: `BEGIN; CREATE TABLE ...;
 * SELECT * FROM <missing>` broke out of the loop below and the transaction stayed
 * open. On PostgreSQL 17 the next request, a DIFFERENT user on POST /api/db/query,
 * answered HTTP 500 "current transaction is aborted, commands ignored until end of
 * transaction block", and so did POST /api/db/maintenance eight minutes later; on
 * SQLite and DuckDB the same script cost the next user's write silently.
 *
 * So the transaction ends here, whether the script failed or ran clean, and the
 * response says what became of it: a user who wrote BEGIN with no COMMIT is told.
 * It is a finally and not a line after the loop because the loop must not be able to
 * leave by any path that skips this.
 *
 * WHOSE transaction it ends is now named rather than hoped for: the provider is cached
 * per connection id and shared by every concurrent request on that stored connection,
 * and until D87 this call reached whichever client anybody had recorded last, measured
 * rolling a concurrent script's and an interactive session's work away. The script's
 * scope is this request's own, minted by the facade when the script opened and sent with
 * every unit, and nothing it did not run on can be ended here.
 *
 * It ends through the host: the facade's `end` sends the scope to the legacy bridge's
 * `console.endScope` through the host core's endScope call, under a cleanup context of
 * its own that the request's leaving does not end, and waits for it at most 10 s
 * (docs/providers/CONTRACT.md, clauses C-60 and C-83). After a unit Studio stopped
 * waiting for, it ends once that unit's call settled, in the background, and the script
 * is answered with no `openTransaction`. A provider that ends nothing of its query path
 * is not offered the facet, is sent no scope, and is asked nothing.
 *
 * What it is NOT: a guard on the word BEGIN. The same shape arrives from a BEGIN
 * inside a statement the splitter cannot see through, so the leak is the missing
 * rollback and not the keyword. And it is not an unconditional ROLLBACK either:
 * measured on bun:sqlite 1.4.2 and DuckDB v1.5.5, a rollback with no transaction
 * active raises, so the provider is asked rather than told.
 */
async function runScript(
  script: EditorScript,
  units: readonly ExecutionUnit[],
  events: UnitEvents,
  scrub: ProviderTextScrub,
  signal: AbortSignal,
): Promise<ScriptRun> {
  const results: StatementResult[] = [];
  let totalExecutionTime = 0;
  let openTransaction: OpenQueryTransactionOutcome = "none";
  try {
    for (const [index, unit] of units.entries()) {
      if (index > 0 && signal.aborted) break;
      // Each unit runs after the one before it settled.
      // oxlint-disable-next-line no-await-in-loop -- a script's order is its meaning.
      const outcome = await runStatement(script, unit, index, events, scrub);
      totalExecutionTime += outcome.executionTime;
      results.push(outcome);
      // Stop execution on error
      if (outcome.status === "error") break;
    }
  } finally {
    const ended = await script.end();
    if (ended.offered) openTransaction = ended.openTransaction;
  }
  return { results, totalExecutionTime, openTransaction };
}

/**
 * Run a script, one execution unit at a time, and answer every unit's outcome.
 *
 * Each unit runs through the host core's console execute under its own deadline and the request's signal
 * (`openEditorScript`, src/lib/api/editor-script.ts; docs/providers/CONTRACT.md, clause C-83). A dropped request stops
 * the script: the unit in flight is answered at once as cancelled, the core sends its run's cancel once, and no further
 * unit starts. The request's one `queryId` is bound to each unit in turn, and a unit ends before the next begins, so at
 * most one run is registered under it at a time; that is also the id Stop posts to `POST /api/db/cancel`. A cancel is
 * idempotent: a second cancel of one id answers the run's end as the first did.
 *
 * The core cancels only the id this request bound, so it needs no owner check. `POST /api/db/cancel` keeps its
 * no-owner-check rule because a run id is a client-chosen value scoped to one provider instance, and adding an owner
 * to the run registry would change every cancel-capable engine.
 */
export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/multi-query", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // A request refused before any unit ran records one `refused` event (docs/GOVERNANCE.md#query-events): before its
  // connection resolved, or at the admission gate. What that event names is held out here for the `catch` below.
  const started = queryEventStart();
  const events = queryEventRequest("multi-query", guard.session, req);
  let requestedId: string | undefined;
  let resolved: DatabaseConnection | undefined;
  let submitted: string | null = null;
  let admitting = false;

  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(req);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }
    // `options` is handed on as the options record it names, as it was when the body was read untyped.
    const { sql, options = {}, queryId } = body as { options?: Record<string, unknown> } & Record<string, unknown>;
    requestedId = requestedConnectionId(body);
    submitted = typeof sql === "string" ? sql : null;

    const connection = await resolveConnection(body, guard.session);
    resolved = connection;

    // A `sql` that is present but not a string, a falsy one (0, false) included, is refused in words: a truthy one
    // reached the splitter and answered 500 with its own TypeError ("input.slice is not a function"). A missing
    // (null) or empty one keeps its answer.
    if (sql != null && typeof sql !== "string") {
      return NextResponse.json({ error: "sql must be a string" }, { status: 400 });
    }
    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
    }
    if (queryId !== undefined && typeof queryId !== "string") {
      return NextResponse.json({ error: "queryId must be a string" }, { status: 400 });
    }
    // The page bounds, held to the rule `POST /api/db/query` holds them to, before anything is split or acquired.
    const optionError = pageOptionError(options);
    if (optionError !== null) {
      return NextResponse.json({ error: optionError }, { status: 400 });
    }
    // The connection's statement timeout, which every unit's deadline is computed from, held to the query route's
    // rule before anything is split or acquired.
    const timeoutError = queryTimeoutError(connection.queryTimeout);
    if (timeoutError !== null) {
      return NextResponse.json({ error: timeoutError }, { status: 400 });
    }

    // A type that declares a console text bound runs one statement per request. The SQL splitter below would turn
    // one console text into several requests, so such a type is sent to the single-statement route before anything
    // is split or acquired.
    if (consoleTextByteLimit(connection.type) !== undefined) {
      return NextResponse.json(
        {
          error:
            "This connection type runs one statement per request: send it to POST /api/db/query, because this route would split its text into several requests.",
        },
        { status: 400 },
      );
    }

    // The resolved connection's dialect, not the compatibility default: this is the
    // one surface that EXECUTES what the splitter returns, so a fragment invented by
    // a reading the engine does not share is a statement the operator never wrote.
    // Measured on postgres 18, `/* a /* b *\/ ; DROP TABLE t; -- *\/ SELECT 1` is one
    // read there and the flat reading made its second fragment a bare DROP (S1).
    //
    // UNITS rather than statements: what one request carries is the dialect's to say, and
    // for T-SQL it is the whole batch between `GO` lines, so a `DECLARE @x` reaches the
    // server in the same request as the `SELECT @x` after it (#1312).
    const statements = splitExecutionUnits(sql, resolveSqlGrammar(connection.type));

    if (statements.length === 0) {
      return NextResponse.json({ error: "No valid SQL statements found" }, { status: 400 });
    }

    // The server's confirmation gate, over the whole submitted
    // script: after every field check, and before the admission gate and any provider, so a request it answers opens
    // nothing, runs nothing and records no query event.
    const gate = await gateRun({
      route: "multi-query",
      issuer: runConfirmationIssuerForSession(guard.session),
      connection,
      catalog: requestCatalog(body),
      sql,
      params: undefined,
      confirmation: body.confirmation,
      explain: false,
    });
    if (gate.kind === "answer") return NextResponse.json(gate.body, { status: gate.status });

    // Before the provider: a request the gate refuses opens nothing and runs nothing.
    admitting = true;
    admitQueryExecution();
    admitting = false;
    const unitEvents: UnitEvents = { request: events, connection, correlationId: uuidv7() };
    // Core's scrub of the providers this connection builds, over every provider text the script answers.
    const scrub = providerTextScrub(connection, "any");

    // The open is waited for within its engine's connect budget and while the request stays (`openWithinCall`): a
    // request that leaves while its connection opens is answered at once, and an open past its budget answers 504.
    const provider = await openWithinCall(req.signal, connection.type, (wait) =>
      editorProvider(guard.session, connection, requestCatalog(body), wait),
    );
    // A request already gone, before or while the provider was acquired, starts nothing.
    if (req.signal.aborted) throw new QueryCancelledError("The query was cancelled.");
    // The host core is read here, after the open and before any unit, outside every unit's own answer, so a script
    // run before the core is installed fails by name and sends nothing.
    const script = openEditorScript(provider, {
      units: statements,
      dialect: connection.type,
      options,
      ...(queryId === undefined ? {} : { queryId }),
      signal: req.signal,
      route: "api/db/multi-query",
    });
    const { results, totalExecutionTime, openTransaction } = await runScript(
      script,
      statements,
      unitEvents,
      scrub,
      req.signal,
    );

    // Return the last successful result as the main result (for ResultsGrid). A statement
    // that succeeded with no rows - an empty SELECT or a write - is the script's own
    // outcome (#2271); requiring rows here resurrected an earlier statement's data and
    // dropped the final one's columns.
    const activeResult = [...results].reverse().find((r) => r.status === "success");
    const hasError = results.some((r) => r.status === "error");

    return NextResponse.json({
      // Main result (for backward compatibility with ResultsGrid)
      rows: activeResult?.rows ?? [],
      fields: activeResult?.fields ?? [],
      rowCount: activeResult?.rowCount ?? 0,
      executionTime: totalExecutionTime,
      // The main result shows one statement's rows, so it carries that statement's
      // notices and declared types and no others. Merging every statement's
      // warnings here would attribute one run's notice to another run's rows.
      ...carriedChannels(activeResult),
      // Multi-statement metadata
      multiStatement: true,
      // Present only when there was a transaction to end, following the same rule as the
      // two channels above: the client renders the notice from the field's presence
      // alone, so an always-present "none" would announce something that did not happen.
      ...(openTransaction === "rolled-back" && { openTransaction }),
      statementCount: statements.length,
      executedCount: results.length,
      hasError,
      statements: results,
      ...(gate.unconfirmed && { confirmation: "unconfirmed" }),
    });
  } catch (error) {
    if (admitting || (resolved === undefined && error instanceof SeedConnectionError)) {
      recordRefusedRequest(events, { requestedId, connection: resolved, statement: submitted, started, error });
    }
    // Once the connection resolved, a provider may have run: its error answers with the connection's scrub.
    return createErrorResponse(error, {
      route: "api/db/multi-query",
      scrub: resolved === undefined ? undefined : providerTextScrub(resolved, "any"),
    });
  }
}
