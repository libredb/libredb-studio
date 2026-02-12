import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  QueryError,
  TimeoutError,
  isDatabaseError,
} from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { connection, sql, options = {} } = await req.json();

    if (!connection || !sql) {
      return NextResponse.json(
        { error: 'Connection and query are required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const prepared = provider.prepareQuery(sql, options);
    const result = await provider.query(prepared.query);

    const hasMore = result.rows.length === prepared.limit;

    return NextResponse.json({
      ...result,
      pagination: {
        limit: prepared.limit,
        offset: prepared.offset,
        hasMore,
        totalReturned: result.rows.length,
        wasLimited: prepared.wasLimited,
      },
    });
  } catch (error) {
    console.error('[API:query] Error:', error);

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
