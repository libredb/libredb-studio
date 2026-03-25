import { NextRequest, NextResponse } from 'next/server';
import { createDatabaseProvider } from '@/lib/db/factory';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';

export async function POST(request: NextRequest) {
  let provider = null;

  try {
    const body = await request.json();

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const connection = await resolveConnection(body, session);

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

    return createErrorResponse(error, { route: 'api/db/schema-snapshot' });
  }
}
