import { NextRequest, NextResponse } from 'next/server';
import { createDatabaseProvider } from '@/lib/db/factory';
import type { DatabaseConnection } from '@/lib/types';

export async function POST(request: NextRequest) {
  let provider = null;

  try {
    const { connection } = await request.json() as { connection: DatabaseConnection };

    if (!connection) {
      return NextResponse.json({ error: 'Connection is required' }, { status: 400 });
    }

    provider = await createDatabaseProvider(connection);
    await provider.connect();

    const schema = await provider.getSchema();

    await provider.disconnect();
    provider = null;

    return NextResponse.json({
      schema,
      connectionId: connection.id,
      connectionName: connection.name,
      databaseType: connection.type,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (provider) {
      try { await provider.disconnect(); } catch { /* ignore */ }
    }

    const message = error instanceof Error ? error.message : 'Failed to fetch schema snapshot';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
