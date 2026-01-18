import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  QueryError,
  TimeoutError,
  isDatabaseError,
} from '@/lib/db';
import {
  analyzeQuery,
  applyQueryLimit,
  DEFAULT_QUERY_LIMIT,
  MAX_UNLIMITED_ROWS,
} from '@/lib/db/utils/query-limiter';

export async function POST(req: NextRequest) {
  try {
    const { connection, sql, options = {} } = await req.json();

    if (!connection || !sql) {
      return NextResponse.json(
        { error: 'Connection and SQL query are required' },
        { status: 400 }
      );
    }

    // Options extraction with defaults
    const {
      limit = DEFAULT_QUERY_LIMIT,
      offset = 0,
      unlimited = false,
    } = options;

    // Unlimited mode için güvenlik limiti
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;

    // Query analizi ve limit uygulama
    const queryInfo = analyzeQuery(sql);
    let finalSql = sql;
    let wasLimited = false;

    // Sadece SELECT sorgularına limit uygula
    if (queryInfo.type === 'SELECT') {
      const limitResult = applyQueryLimit(sql, effectiveLimit, offset);
      finalSql = limitResult.sql;
      wasLimited = limitResult.wasLimited;
    }

    // Query execution
    const provider = await getOrCreateProvider(connection);
    const result = await provider.query(finalSql);

    // hasMore hesaplama: döndürülen satır sayısı === limit ise daha fazla olabilir
    const hasMore = result.rows.length === effectiveLimit;

    return NextResponse.json({
      ...result,
      pagination: {
        limit: effectiveLimit,
        offset,
        hasMore,
        totalReturned: result.rows.length,
        wasLimited,
      },
    });
  } catch (error) {
    console.error('[API:query] Error:', error);

    // Handle specific error types
    if (error instanceof QueryError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }

    if (error instanceof TimeoutError) {
      return NextResponse.json(
        { error: 'Query timed out. Please try a simpler query or increase timeout.' },
        { status: 408 }
      );
    }

    if (isDatabaseError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 500 }
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
