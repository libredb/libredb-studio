import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  isDatabaseError,
  ConnectionError,
} from '@/lib/db';
import type { MonitoringOptions, DatabaseConnection } from '@/lib/db/types';

/**
 * POST /api/db/monitoring
 * Get comprehensive monitoring data for a database connection
 */
export async function POST(req: NextRequest) {
  try {
    // Handle empty or aborted requests
    let body;
    try {
      const text = await req.text();
      if (!text) {
        return NextResponse.json(
          { error: 'Request body is empty' },
          { status: 400 }
        );
      }
      body = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    const { connection, options } = body as {
      connection: DatabaseConnection;
      options?: MonitoringOptions;
    };

    if (!connection || !connection.type) {
      return NextResponse.json(
        { error: 'Valid connection configuration is required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const monitoringData = await provider.getMonitoringData(options);

    return NextResponse.json(monitoringData);
  } catch (error) {
    // Ignore aborted requests (client cancelled)
    if (error instanceof Error &&
        (error.message === 'aborted' ||
         error.name === 'AbortError' ||
         (error as NodeJS.ErrnoException).code === 'ECONNRESET')) {
      return new Response(null, { status: 499 }); // Client Closed Request
    }

    console.error('[API:monitoring] Error:', error);

    if (error instanceof ConnectionError) {
      return NextResponse.json(
        {
          error: `Connection failed: ${error.message}`,
          timestamp: new Date(),
          overview: {
            version: 'N/A',
            uptime: 'N/A',
            activeConnections: 0,
            maxConnections: 0,
            databaseSize: 'N/A',
            databaseSizeBytes: 0,
            tableCount: 0,
            indexCount: 0,
          },
          performance: {
            cacheHitRatio: 0,
          },
          slowQueries: [],
          activeSessions: [],
        },
        { status: 503 }
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
