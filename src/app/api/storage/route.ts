/**
 * GET /api/storage
 * Returns all storage data for the authenticated user.
 * Only works when server storage is enabled.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStorageProvider } from '@/lib/storage/factory';

export async function GET() {
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

  const data = await provider.getAllData(session.username);
  return NextResponse.json(data);
}
