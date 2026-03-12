/**
 * PUT /api/storage/[collection]
 * Updates a single storage collection for the authenticated user.
 * Only works when server storage is enabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStorageProvider } from '@/lib/storage/factory';
import { STORAGE_COLLECTIONS, type StorageCollection } from '@/lib/storage/types';
import { createErrorResponse } from '@/lib/api/errors';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ collection: string }> }
) {
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

    const { collection } = await params;

    if (!STORAGE_COLLECTIONS.includes(collection as StorageCollection)) {
      return NextResponse.json(
        { error: `Invalid collection: ${collection}` },
        { status: 400 }
      );
    }

    const body = await request.json();

    if (body.data === undefined || body.data === null) {
      return NextResponse.json(
        { error: 'Missing required field: data' },
        { status: 400 }
      );
    }

    await provider.setCollection(
      session.username,
      collection as StorageCollection,
      body.data
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return createErrorResponse(error, { route: 'PUT /api/storage/[collection]' });
  }
}
