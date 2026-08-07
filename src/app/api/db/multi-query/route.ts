import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { splitStatements } from "@/lib/sql/statement-splitter";
import { isSelectQuery } from "@/lib/db/utils/query-limiter";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { getSession } from "@/lib/auth";
import type { DatabaseType, QueryWarning } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sql, options = {} } = body;

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const connection = await resolveConnection(body, session);

    if (!sql) {
      return NextResponse.json({ error: "Connection and query are required" }, { status: 400 });
    }

    const statements = splitStatements(sql);

    if (statements.length === 0) {
      return NextResponse.json({ error: "No valid SQL statements found" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    const results: StatementResult[] = [];
    let totalExecutionTime = 0;

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
      statementCount: statements.length,
      executedCount: results.length,
      hasError,
      statements: results,
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/multi-query" });
  }
}
