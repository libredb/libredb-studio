import { getSession } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import type { DatabaseConnection } from '@/lib/types';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';

export interface FleetHealthItem {
  connectionId: string;
  connectionName: string;
  type: string;
  environment?: string;
  status: 'healthy' | 'degraded' | 'error';
  latencyMs: number;
  activeConnections?: number;
  databaseSize?: string;
  error?: string;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== 'admin') {
    return NextResponse.json(
      { error: 'Unauthorized. Admin access required.' },
      { status: 403 }
    );
  }

  try {
    const { connections } = (await request.json()) as {
      connections: DatabaseConnection[];
    };

    if (!connections || !Array.isArray(connections)) {
      return NextResponse.json(
        { error: 'connections array is required' },
        { status: 400 }
      );
    }

    const results: FleetHealthItem[] = await Promise.all(
      connections.map(async (conn): Promise<FleetHealthItem> => {
        const start = Date.now();
        try {
          // Resolve managed seed connections (server-side credential injection)
          const resolved = conn.managed && conn.seedId
            ? await resolveConnection({ connectionId: `seed:${conn.seedId}` }, session!)
            : conn;
          const provider = await getOrCreateProvider(resolved);
          const health = await provider.getHealth();
          const latencyMs = Date.now() - start;

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            type: conn.type,
            environment: conn.environment,
            status: latencyMs > 5000 ? 'degraded' : 'healthy',
            latencyMs,
            activeConnections: health.activeConnections,
            databaseSize: health.databaseSize,
          };
        } catch (err) {
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            type: conn.type,
            environment: conn.environment,
            status: 'error',
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : 'Connection failed',
          };
        }
      })
    );

    return NextResponse.json({ results });
  } catch (error) {
    return createErrorResponse(error, { route: 'POST /api/admin/fleet-health' });
  }
}
