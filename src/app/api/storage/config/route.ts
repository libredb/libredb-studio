/**
 * GET /api/storage/config
 * Returns storage configuration (public endpoint, no auth required).
 * Client uses this to discover if server-side storage is enabled at runtime.
 */

import { NextResponse } from 'next/server';
import { getStorageConfig } from '@/lib/storage/factory';

export async function GET() {
  return NextResponse.json(getStorageConfig());
}
