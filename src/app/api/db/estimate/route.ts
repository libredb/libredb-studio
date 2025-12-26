import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  QueryError,
  TimeoutError,
  isDatabaseError,
} from '@/lib/db';
import { isSelectQuery } from '@/lib/db/utils/query-limiter';

export interface RowEstimateResult {
  estimatedRows: number;
  isLargeResult: boolean;
  warning?: string;
}

// Threshold for "large result" warning
const LARGE_RESULT_THRESHOLD = 10000;

export async function POST(req: NextRequest) {
  try {
    const { connection, sql } = await req.json();

    if (!connection || !sql) {
      return NextResponse.json(
        { error: 'Connection and SQL query are required' },
        { status: 400 }
      );
    }

    // Only estimate SELECT queries
    if (!isSelectQuery(sql)) {
      return NextResponse.json({
        estimatedRows: 0,
        isLargeResult: false,
      });
    }

    const provider = await getOrCreateProvider(connection);
    const dbType = connection.type;

    let estimatedRows = 0;

    if (dbType === 'postgres') {
      // PostgreSQL: EXPLAIN (FORMAT JSON) for row estimate
      const explainSql = `EXPLAIN (FORMAT JSON) ${sql}`;
      const result = await provider.query(explainSql);

      if (result.rows?.[0]?.['QUERY PLAN']?.[0]?.Plan) {
        estimatedRows = result.rows[0]['QUERY PLAN'][0].Plan['Plan Rows'] || 0;
      }
    } else if (dbType === 'mysql') {
      // MySQL: EXPLAIN for rows estimate
      const explainSql = `EXPLAIN ${sql}`;
      const result = await provider.query(explainSql);

      // Sum all rows from EXPLAIN output (for JOINs)
      if (result.rows?.length > 0) {
        estimatedRows = result.rows.reduce((sum: number, row: any) => {
          return sum + (parseInt(row.rows) || 0);
        }, 0);
      }
    } else if (dbType === 'sqlite') {
      // SQLite: EXPLAIN QUERY PLAN doesn't give row estimates easily
      // Use a rough estimate based on table stats if available
      // For now, return 0 (unknown)
      estimatedRows = 0;
    } else {
      // Demo or other types - no estimate
      estimatedRows = 0;
    }

    const isLargeResult = estimatedRows > LARGE_RESULT_THRESHOLD;
    const warning = isLargeResult
      ? `This query may return ~${formatNumber(estimatedRows)} rows. Consider adding filters or using LIMIT.`
      : undefined;

    return NextResponse.json({
      estimatedRows,
      isLargeResult,
      warning,
    });
  } catch (error) {
    console.error('[API:estimate] Error:', error);

    // For estimate errors, return 0 instead of failing
    // This way the query can still run even if estimate fails
    if (error instanceof QueryError) {
      return NextResponse.json({
        estimatedRows: 0,
        isLargeResult: false,
        error: 'Could not estimate row count',
      });
    }

    if (error instanceof TimeoutError) {
      return NextResponse.json({
        estimatedRows: 0,
        isLargeResult: false,
        error: 'Estimate timed out',
      });
    }

    if (isDatabaseError(error)) {
      return NextResponse.json({
        estimatedRows: 0,
        isLargeResult: false,
        error: 'Could not estimate row count',
      });
    }

    return NextResponse.json({
      estimatedRows: 0,
      isLargeResult: false,
    });
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}
