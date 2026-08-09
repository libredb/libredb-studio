import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

/**
 * GET /api/db/health
 * Simple health check for load balancers and container orchestration (Render, K8s, etc.)
 * Returns 200 OK if the service is running
 */
export async function GET() {
  return NextResponse.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "libredb-studio",
  });
}

/**
 * POST /api/db/health
 * Detailed health check for a specific database connection
 */
export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/health", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();

    const connection = await resolveConnection(body, guard.session);

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    const health = await provider.getHealth();

    return NextResponse.json(health);
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/health" });
  }
}
