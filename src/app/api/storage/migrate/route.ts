/**
 * POST /api/storage/migrate
 * Migrates localStorage data to server storage.
 * Client sends all its localStorage collections; server merges them.
 * Only works when server storage is enabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStorageProvider } from '@/lib/storage/factory';
import type { StorageData } from '@/lib/storage/types';
import { createErrorResponse } from '@/lib/api/errors';

export async function POST(request: NextRequest) {
  try {
    const provider = await getStorageProvider();
    if (!provider) {
      return NextResponse.json(
        { error: 'Server storage is not enabled' },
        { status: 404 }
      );
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as Partial<StorageData>;

    await provider.mergeData(session.username, body);

    return NextResponse.json({ ok: true, migrated: Object.keys(body) });
  } catch (error) {
    return createErrorResponse(error, { route: 'POST /api/storage/migrate' });
  }
}
