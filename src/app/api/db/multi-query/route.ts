import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { splitExecutionUnits, unitIsModuleBody, type ExecutionUnit } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { isSelectQuery } from "@/lib/db/utils/query-limiter";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { consoleTextByteLimit } from "@/lib/db/destructive-commands";
import type { DatabaseType, QueryResult, QueryWarning } from "@/lib/types";
import { endsOpenQueryTransactions, newQueryCallScope } from "@/lib/db/types";
import type { DatabaseProvider, OpenQueryTransactionOutcome } from "@/lib/db/types";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";

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
 * Run one statement of the script and describe the outcome, including the error
 * when it failed — the loop decides what to do about it.
 *
 * Extracted from `POST` rather than inlined: with the two channels added, the
 * handler carried the whole per-statement dance (limiter decision, execution,
 * error shaping) inside its own control flow and crossed the cognitive-complexity
 * bar (PR #308 review).
 */
/**
 * The text the script's LAST unit is sent as: its last statement bounded when that statement
 * is a read, and everything else as written.
 *
 * A unit of several statements is a T-SQL batch sent as one request (#1312). Its last
 * statement is bounded and spliced back in place, so `SELECT 1; SELECT * FROM big` is as
 * bounded as it was when the two were separate requests - unless the batch is a module
 * definition (`CREATE PROCEDURE … AS …`), whose last statement is part of the body the
 * server stores, where a `TOP` would change the procedure rather than the result.
 */
function boundedText(
  provider: DatabaseProvider,
  unit: ExecutionUnit,
  dialect: DatabaseType,
  options: Record<string, unknown>,
): string {
  const tail = unit.statements[unit.statements.length - 1];
  if (!isSelectQuery(tail.sql, dialect)) return unit.sql;
  if (unit.statements.length > 1 && unitIsModuleBody(unit, resolveSqlGrammar(dialect))) return unit.sql;
  const { query } = provider.prepareQuery(tail.sql, options);
  return unit.sql.slice(0, tail.start - unit.start) + query + unit.sql.slice(tail.end - unit.start);
}

/**
 * What a unit's result shows. A batch that produced several result sets shows the last one
 * with rows (#1312), the rule the response applies across a script's statements below, so a
 * plain `SELECT * FROM a; SELECT * FROM b` shows what it showed when the two were separate
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
  const set = [...sets].reverse().find((candidate) => candidate.rows.length > 0) ?? sets[sets.length - 1];
  return { rows: set.rows, fields: set.fields, rowCount: set.rows.length, columnTypes: set.columnTypes };
}

async function runStatement(
  provider: DatabaseProvider,
  stmt: ExecutionUnit,
  index: number,
  isLast: boolean,
  dialect: DatabaseType,
  options: Record<string, unknown>,
  scope: string,
): Promise<StatementResult> {
  const startTime = performance.now();
  const identity = { index, sql: stmt.sql, startLine: stmt.startLine };

  try {
    // For the last statement that is a SELECT, apply limit. "Last statement
    // only" is this route's own policy; whether the statement IS a SELECT is
    // not — that reading is shared, and this route used to re-derive it with
    // `/^\s*SELECT\b/i`. `splitStatements` keeps each statement's leading
    // comments, so an annotated final SELECT failed that pattern and reached
    // the engine unprepared, which is the unbounded read the shared classifier
    // was made comment-tolerant to close (#281, #275). The shared reading also
    // types a `WITH` by the keyword its CTE list operates (#287), so a
    // read-only CTE is bounded here and a data-modifying one is not.
    const query = isLast ? boundedText(provider, stmt, dialect, options) : stmt.sql;

    // Every statement of the script runs under the SAME scope, which is what lets the
    // `finally` below end a transaction any of them left open — including one opened by a
    // statement whose own client is not the last one the script borrowed (D87). No params
    // and no queryId here: this route binds nothing and cancels nothing.
    const result = await provider.query(query, undefined, undefined, scope);
    const { columnTypes, ...shown } = shownSet(result, stmt);

    return {
      ...identity,
      status: "success",
      ...shown,
      // NaN and the infinities as words, which `JSON.stringify` would write as null
      // (`src/lib/non-finite.ts`). The main result reuses this array, so it carries them too.
      rows: rowsWithNonFiniteWords(shown.rows),
      executionTime: Math.round(performance.now() - startTime),
      ...carriedChannels({ warnings: result.warnings, columnTypes }),
    };
  } catch (error) {
    return {
      ...identity,
      status: "error",
      executionTime: Math.round(performance.now() - startTime),
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function POST(req: NextRequest) {
  const guard = await guardRoute({ route: "POST /api/db/multi-query", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();
    const { sql, options = {} } = body;

    const connection = await resolveConnection(body, guard.session);

    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
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

    const provider = await getOrCreateProvider(connection, {}, editorExecutionContext(guard.session));
    const results: StatementResult[] = [];
    let totalExecutionTime = 0;
    let openTransaction: OpenQueryTransactionOutcome = "none";
    // This request's own name for everything it runs, minted here and passed to every
    // statement and to the ender, so that the transaction ended below is one THIS script
    // left open and never another caller's (D87).
    const scope = newQueryCallScope();

    // MAY A SCRIPT LEAVE A TRANSACTION OPEN? No, and this finally is the answer.
    //
    // The provider this route borrows is cached per `connection.id` for the whole
    // process (`getOrCreateProvider`), so a transaction that outlives the request does
    // not belong to the person who opened it any more — it belongs to whoever borrows
    // the handle next. Measured 2026-09-13 through this route: `BEGIN; CREATE TABLE ...;
    // SELECT * FROM <missing>` broke out of the loop below and the transaction stayed
    // open. On PostgreSQL 17 the next request, a DIFFERENT user on POST /api/db/query,
    // answered HTTP 500 "current transaction is aborted, commands ignored until end of
    // transaction block", and so did POST /api/db/maintenance eight minutes later; on
    // SQLite and DuckDB the same script cost the next user's write silently.
    //
    // So the transaction ends here, whether the script failed or ran clean, and the
    // response says what became of it — a user who wrote BEGIN with no COMMIT is told.
    // It is a finally and not a line after the loop because the loop must not be able to
    // leave by any path that skips this.
    //
    // WHOSE transaction it ends is now named rather than hoped for: the provider is cached
    // per connection id and shared by every concurrent request on that stored connection,
    // and until D87 this call reached whichever client anybody had recorded last — measured
    // rolling a concurrent script's and an interactive session's work away. The `scope`
    // above is this request's own, and nothing it did not run on can be ended here.
    //
    // What it is NOT: a guard on the word BEGIN. The same shape arrives from a BEGIN
    // inside a statement the splitter cannot see through, so the leak is the missing
    // rollback and not the keyword. And it is not an unconditional ROLLBACK either:
    // measured on bun:sqlite 1.4.2 and DuckDB v1.5.5, a rollback with no transaction
    // active raises, so the provider is asked rather than told.
    try {
      for (let i = 0; i < statements.length; i++) {
        const outcome = await runStatement(
          provider,
          statements[i],
          i,
          i === statements.length - 1,
          connection.type,
          options,
          scope,
        );
        totalExecutionTime += outcome.executionTime;
        results.push(outcome);

        // Stop execution on error
        if (outcome.status === "error") break;
      }
    } finally {
      if (endsOpenQueryTransactions(provider)) {
        openTransaction = await provider.endOpenQueryTransaction(scope);
      }
    }

    // Return the last successful result with rows as the main result (for ResultsGrid)
    const lastResultWithRows = [...results]
      .reverse()
      .find((r) => r.status === "success" && r.rows && r.rows.length > 0);
    const hasError = results.some((r) => r.status === "error");

    return NextResponse.json({
      // Main result (for backward compatibility with ResultsGrid)
      rows: lastResultWithRows?.rows || [],
      fields: lastResultWithRows?.fields || [],
      rowCount: lastResultWithRows?.rowCount || 0,
      executionTime: totalExecutionTime,
      // The main result shows one statement's rows, so it carries that statement's
      // notices and declared types and no others. Merging every statement's
      // warnings here would attribute one run's notice to another run's rows.
      ...carriedChannels(lastResultWithRows),
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
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/multi-query" });
  }
}
