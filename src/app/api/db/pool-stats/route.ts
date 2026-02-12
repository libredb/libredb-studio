import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db/factory';
import type { DatabaseConnection } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const { connection } = await request.json() as { connection: DatabaseConnection };

    if (!connection) {
      return NextResponse.json({ error: 'Connection is required' }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);

    // Check if provider has getPoolStats
    if ('getPoolStats' in provider && typeof (provider as Record<string, unknown>).getPoolStats === 'function') {
      const stats = (provider as { getPoolStats: () => { total: number; idle: number; active: number; waiting: number } }).getPoolStats();
      return NextResponse.json(stats);
    }

    // Fallback for providers without pool stats
    return NextResponse.json({
      total: 0,
      idle: 0,
      active: 0,
      waiting: 0,
      message: 'Pool statistics not available for this provider',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch pool stats';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
