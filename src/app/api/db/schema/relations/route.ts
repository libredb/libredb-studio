import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Heavy relationship/index introspection (foreign keys + indexes), keyed by
 * table display name for async merge into /api/db/schema/list results. Kept
 * separate so its cost never blocks the table list. Returns [] for providers
 * that don't implement it.
 */
export async function POST(req: NextRequest) {
  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }

    if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const connection = await resolveConnection(
      body.connectionId ? body : (body.connection ? body : { connection: body }),
      session,
    );

    if (!connection.type) {
      return NextResponse.json(
        { error: 'Valid connection configuration is required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const relations = provider.getSchemaRelations
      ? await provider.getSchemaRelations()
      : [];

    return NextResponse.json(relations);
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/schema/relations' });
  }
}
