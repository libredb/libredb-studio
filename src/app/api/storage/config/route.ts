/**
 * GET /api/storage/config
 * Returns storage configuration (public endpoint, no auth required).
 * Client uses this to discover if server-side storage is enabled at runtime.
 */

import { NextResponse } from 'next/server';
import { getStorageConfig } from '@/lib/storage/factory';
import { createErrorResponse } from '@/lib/api/errors';

export async function GET() {
  try {
    return NextResponse.json(getStorageConfig());
  } catch (error) {
    return createErrorResponse(error, { route: 'GET /api/storage/config' });
  }
}
