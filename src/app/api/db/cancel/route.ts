import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';
import { resolveConnection } from '@/lib/seed/resolve-connection';
import { getSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { queryId } = body;

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const connection = await resolveConnection(body, session);

    if (!queryId) {
      return NextResponse.json(
        { error: 'Connection and queryId are required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);

    // Check if provider supports cancellation
    if (!('cancelQuery' in provider) || typeof (provider as Record<string, unknown>).cancelQuery !== 'function') {
      return NextResponse.json(
        { error: 'Query cancellation is not supported for this database type', cancelled: false },
        { status: 400 }
      );
    }

    const cancelled = await (provider as { cancelQuery(queryId: string): Promise<boolean> }).cancelQuery(queryId);

    return NextResponse.json({ cancelled });
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/cancel' });
  }
}
