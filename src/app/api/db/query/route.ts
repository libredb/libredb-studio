import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';

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
      ? await (provider as unknown as { query(sql: string, params?: unknown[], queryId?: string): ReturnType<typeof provider.query> }).query(prepared.query, undefined, queryId)
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
    return createErrorResponse(error, { route: 'api/db/query' });
  }
}
