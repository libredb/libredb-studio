import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  QueryError,
  TimeoutError,
  isDatabaseError,
} from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const { connection, sql, options = {}, queryId } = await req.json();

    if (!connection || !sql) {
      return NextResponse.json(
        { error: 'Connection and query are required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const prepared = provider.prepareQuery(sql, options);

    // Pass queryId to provider for cancellation tracking
    const supportsCancel = 'cancelQuery' in provider;
    const result = supportsCancel && queryId
      ? await (provider as { query(sql: string, params?: unknown[], queryId?: string): Promise<typeof result> }).query(prepared.query, undefined, queryId)
      : await provider.query(prepared.query);

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

    // Check if query was cancelled
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('canceling statement') || errorMessage.includes('Query execution was interrupted')) {
      return NextResponse.json(
        { error: 'Query was cancelled', cancelled: true },
        { status: 499 }
      );
    }

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
