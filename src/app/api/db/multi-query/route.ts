import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { isSelectQuery } from "@/lib/db/utils/query-limiter";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import type { DatabaseType, QueryWarning } from "@/lib/types";
import type { DatabaseProvider, OpenQueryTransactionOutcome } from "@/lib/db/types";

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
async function runStatement(
  provider: DatabaseProvider,
  stmt: { sql: string; startLine: number },
  index: number,
  isLast: boolean,
  dialect: DatabaseType,
  options: Record<string, unknown>,
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
    const prepared =
      isLast && isSelectQuery(stmt.sql, dialect)
        ? provider.prepareQuery(stmt.sql, options)
        : { query: stmt.sql, wasLimited: false, limit: 0, offset: 0 };

    const result = await provider.query(prepared.query);

    return {
      ...identity,
      status: "success",
      rows: result.rows,
      fields: result.fields,
      rowCount: result.rowCount,
      executionTime: Math.round(performance.now() - startTime),
      ...carriedChannels(result),
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

/**
 * Whether this provider can end a transaction its own `query()` path left open.
 *
 * A runtime shape check, the same one `POST /api/db/transaction` uses for the
 * interactive session: the method is optional on `DatabaseProvider` because only a
 * provider that can name the session its statements ran on can answer truthfully
 * (`endOpenQueryTransaction`'s declaration argues why). `postgres`, `sqlite` and
 * `duckdb` implement it; on the rest this route leaves the handle exactly as it found
 * it, because inventing a rollback there would be guessing at another engine's state.
 */
function endsOpenTransactions(
  provider: DatabaseProvider,
): provider is DatabaseProvider & Required<Pick<DatabaseProvider, "endOpenQueryTransaction">> {
  return typeof provider.endOpenQueryTransaction === "function";
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

    // The resolved connection's dialect, not the compatibility default: this is the
    // one surface that EXECUTES what the splitter returns, so a fragment invented by
    // a reading the engine does not share is a statement the operator never wrote.
    // Measured on postgres 18, `/* a /* b *\/ ; DROP TABLE t; -- *\/ SELECT 1` is one
    // read there and the flat reading made its second fragment a bare DROP (S1).
    const statements = splitStatements(sql, resolveSqlGrammar(connection.type));

    if (statements.length === 0) {
      return NextResponse.json({ error: "No valid SQL statements found" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    const results: StatementResult[] = [];
    let totalExecutionTime = 0;
    let openTransaction: OpenQueryTransactionOutcome = "none";

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
        );
        totalExecutionTime += outcome.executionTime;
        results.push(outcome);

        // Stop execution on error
        if (outcome.status === "error") break;
      }
    } finally {
      if (endsOpenTransactions(provider)) {
        openTransaction = await provider.endOpenQueryTransaction();
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
