import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateProvider } from '@/lib/db';
import { createErrorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    if (!body || body.trim() === '') {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }

    const connection = JSON.parse(body);

    if (!connection || !connection.type) {
      return NextResponse.json(
        { error: 'Valid connection configuration is required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);

    return NextResponse.json({
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
    });
  } catch (error) {
    return createErrorResponse(error, { route: 'api/db/provider-meta' });
  }
}
