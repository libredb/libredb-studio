import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  QueryError,
  isDatabaseError,
} from '@/lib/db';

interface TransactionProvider {
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  isInTransaction(): boolean;
  queryInTransaction(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; fields: string[]; rowCount: number; executionTime: number }>;
}

function isTransactionProvider(provider: unknown): provider is TransactionProvider {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    'beginTransaction' in provider &&
    'commitTransaction' in provider &&
    'rollbackTransaction' in provider
  );
}

export async function POST(req: NextRequest) {
  try {
    const { connection, action, sql, options = {} } = await req.json();

    if (!connection || !action) {
      return NextResponse.json(
        { error: 'Connection and action are required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);

    if (!isTransactionProvider(provider)) {
      return NextResponse.json(
        { error: 'Transaction control is not supported for this database type' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'begin': {
        await provider.beginTransaction();
        return NextResponse.json({ status: 'active', message: 'Transaction started' });
      }

      case 'commit': {
        await provider.commitTransaction();
        return NextResponse.json({ status: 'committed', message: 'Transaction committed' });
      }

      case 'rollback': {
        await provider.rollbackTransaction();
        return NextResponse.json({ status: 'rolled_back', message: 'Transaction rolled back' });
      }

      case 'query': {
        if (!sql) {
          return NextResponse.json(
            { error: 'SQL query is required for transaction query' },
            { status: 400 }
          );
        }

        // Apply limit for SELECT queries within transaction
        const prepared = provider.prepareQuery(sql, options);
        const result = await provider.queryInTransaction(prepared.query);

        const hasMore = result.rows.length === prepared.limit;

        return NextResponse.json({
          ...result,
          inTransaction: true,
          pagination: {
            limit: prepared.limit,
            offset: prepared.offset,
            hasMore,
            totalReturned: result.rows.length,
            wasLimited: prepared.wasLimited,
          },
        });
      }

      case 'status': {
        return NextResponse.json({
          inTransaction: provider.isInTransaction(),
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown transaction action: ${action}. Valid: begin, commit, rollback, query, status` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[API:transaction] Error:', error);

    if (error instanceof QueryError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
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
