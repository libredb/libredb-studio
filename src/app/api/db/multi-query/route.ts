import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { splitStatements } from '@/lib/sql/statement-splitter';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';

export interface StatementResult {
  index: number;
  sql: string;
  startLine: number;
  status: 'success' | 'error';
  rows?: Record<string, unknown>[];
  fields?: string[];
  rowCount?: number;
  executionTime: number;
  error?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sql, options = {} } = body;

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const connection = await resolveConnection(body, session);

    if (!sql) {
      return NextResponse.json(
        { error: 'Connection and query are required' },
        { status: 400 }
      );
    }

    const statements = splitStatements(sql);

    if (statements.length === 0) {
      return NextResponse.json(
        { error: 'No valid SQL statements found' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const results: StatementResult[] = [];
    let totalExecutionTime = 0;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const startTime = performance.now();

      try {
        // For the last statement that is a SELECT, apply limit
        const isLastSelect = i === statements.length - 1 && /^\s*SELECT\b/i.test(stmt.sql);
        const prepared = isLastSelect
          ? provider.prepareQuery(stmt.sql, options)
          : { query: stmt.sql, wasLimited: false, limit: 0, offset: 0 };

        const result = await provider.query(prepared.query);
        const executionTime = Math.round(performance.now() - startTime);
        totalExecutionTime += executionTime;

        results.push({
          index: i,
          sql: stmt.sql,
          startLine: stmt.startLine,
          status: 'success',
          rows: result.rows,
          fields: result.fields,
          rowCount: result.rowCount,
          executionTime,
        });
      } catch (error) {
        const executionTime = Math.round(performance.now() - startTime);
        totalExecutionTime += executionTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        results.push({
          index: i,
          sql: stmt.sql,
          startLine: stmt.startLine,
          status: 'error',
          executionTime,
          error: errorMessage,
        });

        // Stop execution on error
        break;
      }
    }

    // Return the last successful result with rows as the main result (for ResultsGrid)
    const lastResultWithRows = [...results].reverse().find(r => r.status === 'success' && r.rows && r.rows.length > 0);
    const hasError = results.some(r => r.status === 'error');

    return NextResponse.json({
      // Main result (for backward compatibility with ResultsGrid)
      rows: lastResultWithRows?.rows || [],
      fields: lastResultWithRows?.fields || [],
      rowCount: lastResultWithRows?.rowCount || 0,
      executionTime: totalExecutionTime,
      // Multi-statement metadata
      multiStatement: true,
      statementCount: statements.length,
      executedCount: results.length,
      hasError,
      statements: results,
    });
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/multi-query' });
  }
}
