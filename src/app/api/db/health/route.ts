import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';

/**
 * GET /api/db/health
 * Simple health check for load balancers and container orchestration (Render, K8s, etc.)
 * Returns 200 OK if the service is running
 */
export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'libredb-studio',
  });
}

/**
 * POST /api/db/health
 * Detailed health check for a specific database connection
 */
export async function POST(req: NextRequest) {
  try {
    const { connection } = await req.json();

    if (!connection || !connection.type) {
      return NextResponse.json(
        { error: 'Valid connection configuration is required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const health = await provider.getHealth();

    return NextResponse.json(health);
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/health' });
  }
}
