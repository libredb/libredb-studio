/**
 * GET /api/storage
 * Returns all storage data for the authenticated user.
 * Only works when server storage is enabled.
 */

import { NextRequest, NextResponse } from "next/server";
import { getStorageProvider } from "@/lib/storage/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { guardRoute } from "@/lib/api/require-session";

export async function GET(request: NextRequest) {
  // Ahead of the provider lookup, like POST /api/db/health: an unauthenticated caller gets no work
  // done on its behalf, and one 401 shape covers the whole API. The "query" bucket is the one that
  // fits - a server-storage read reaches the SQLite or PostgreSQL storage backend - and it is
  // deliberately shared with the db/ routes rather than given its own budget.
  const guard = await guardRoute({ route: "GET /api/storage", bucket: "query", request });
  if ("response" in guard) return guard.response;

  try {
    const provider = await getStorageProvider();
    if (!provider) {
      return NextResponse.json({ error: "Server storage is not enabled" }, { status: 404 });
    }

    const data = await provider.getAllData(guard.session.username);
    return NextResponse.json(data);
  } catch (error) {
    return createErrorResponse(error, { route: "GET /api/storage" });
  }
}
