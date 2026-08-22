/**
 * POST /api/storage/migrate
 * Migrates localStorage data to server storage.
 * Client sends all its localStorage collections; server merges them.
 * Only works when server storage is enabled.
 */

import { NextRequest, NextResponse } from "next/server";
import { getStorageProvider } from "@/lib/storage/factory";
import type { StorageData } from "@/lib/storage/types";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";

export async function POST(request: NextRequest) {
  // See GET /api/storage for why the guard runs first and why this shares the "query" bucket.
  const guard = await guardRoute({ route: "POST /api/storage/migrate", bucket: "query", request });
  if ("response" in guard) return guard.response;

  try {
    const provider = await getStorageProvider();
    if (!provider) {
      return NextResponse.json({ error: "Server storage is not enabled" }, { status: 404 });
    }

    let body: Partial<StorageData>;
    try {
      body = (await request.json()) as Partial<StorageData>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    await provider.mergeData(guard.session.username, body);

    return NextResponse.json({ ok: true, migrated: Object.keys(body) });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/storage/migrate" });
  }
}
