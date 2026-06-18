import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';
import type { DatabaseProvider } from '@/lib/db/types';

/**
 * Shared request handling for the schema introspection routes
 * (/api/db/schema/list and /api/db/schema/relations). Both perform the same
 * body parsing, auth, connection resolution and error mapping; only the
 * provider call differs, supplied via `load`.
 */
export async function handleSchemaRequest(
  req: NextRequest,
  route: string,
  load: (provider: DatabaseProvider) => Promise<unknown>,
): Promise<NextResponse> {
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
    return NextResponse.json(await load(provider));
  } catch (error) {
    return createErrorResponse(error, { route });
  }
}
