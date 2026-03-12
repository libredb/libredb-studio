import { NextRequest, NextResponse } from 'next/server';
import { createDatabaseProvider } from '@/lib/db/factory';
import { createErrorResponse } from '@/lib/api/errors';

export async function POST(req: NextRequest) {
  let provider = null;

  try {
    const connection = await req.json();

    if (!connection || !connection.type) {
      return NextResponse.json(
        { success: false, error: 'Connection configuration is required' },
        { status: 400 }
      );
    }

    // Demo connections always succeed
    if (connection.type === 'demo') {
      return NextResponse.json({ success: true, message: 'Demo connection is always available.' });
    }

    provider = await createDatabaseProvider(connection, { queryTimeout: 10000 });
    await provider.connect();

    // Run a lightweight query to verify the connection actually works
    const startTime = Date.now();
    await provider.getHealth();
    const latency = Date.now() - startTime;

    await provider.disconnect();
    provider = null;

    return NextResponse.json({
      success: true,
      message: 'Connection successful',
      latency,
    });
  } catch (error) {
    // Ensure we disconnect on error
    if (provider) {
      try { await provider.disconnect(); } catch { /* ignore */ }
    }

    return createErrorResponse(error, { route: 'api/db/test-connection' });
  }
}
