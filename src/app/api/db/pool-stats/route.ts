import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db/factory';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const connection = await resolveConnection(body, session);

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
    return createErrorResponse(error, { route: 'api/db/pool-stats' });
  }
}
