import { NextRequest, NextResponse } from "next/server";
import { INVALID_REQUEST_BODY, readJsonObject } from "@/lib/api/json-object-body";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub } from "@/lib/db/operations/provider-text";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { editorProvider } from "@/lib/api/editor-provider";

export async function POST(request: NextRequest) {
  // Moved ahead of request.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/pool-stats", bucket: "query", request });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    // A body that is not a JSON object is a malformed request, refused before any connection resolves.
    const body = await readJsonObject(request);
    if (body === null) {
      return NextResponse.json({ error: INVALID_REQUEST_BODY }, { status: 400 });
    }

    const connection = await resolveConnection(body, guard.session);
    scrub = providerTextScrub(connection, "any");

    const provider = await editorProvider(guard.session, connection, requestCatalog(body));

    // Check if provider has getPoolStats
    if ("getPoolStats" in provider && typeof (provider as Record<string, unknown>).getPoolStats === "function") {
      const stats = (
        provider as {
          getPoolStats: () => { total: number; idle: number; active: number; waiting: number; max?: number };
        }
      ).getPoolStats();
      return NextResponse.json(stats);
    }

    // Fallback for providers without pool stats
    return NextResponse.json({
      total: 0,
      idle: 0,
      active: 0,
      waiting: 0,
      message: "Pool statistics not available for this provider",
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/pool-stats", scrub });
  }
}
