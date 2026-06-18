import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Fast structural schema (tables + columns + PKs), excluding the expensive
 * foreign-key/index introspection. Used by the schema explorer to render the
 * table tree immediately; relationships/indexes are fetched separately via
 * /api/db/schema/relations and merged in asynchronously.
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
    // Fall back to the full getSchema() for providers that don't implement the
    // fast path, so non-postgres databases keep working unchanged.
    const schema = provider.getSchemaList
      ? await provider.getSchemaList()
      : await provider.getSchema();

    return NextResponse.json(schema);
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/schema/list' });
  }
}
