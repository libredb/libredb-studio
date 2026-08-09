import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import type { MonitoringOptions } from "@/lib/db/types";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

/**
 * POST /api/db/monitoring
 * Get comprehensive monitoring data for a database connection
 */
export async function POST(req: NextRequest) {
  // Moved ahead of body parsing, matching every other provider-reaching route: an unauthenticated
  // or rate-limited caller no longer gets a body parsed on its behalf, and gets the promised
  // denial audit instead of a 400 that never reached the guard.
  const guard = await guardRoute({ route: "POST /api/db/monitoring", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    // Handle empty or aborted requests
    let body;
    try {
      const text = await req.text();
      if (!text) {
        return NextResponse.json({ error: "Request body is empty" }, { status: 400 });
      }
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    const connection = await resolveConnection(body, guard.session);
    const { options } = body as { options?: MonitoringOptions };

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    const monitoringData = await provider.getMonitoringData(options);

    return NextResponse.json(monitoringData);
  } catch (error) {
    // Ignore aborted requests (client cancelled)
    if (
      error instanceof Error &&
      (error.message === "aborted" ||
        error.name === "AbortError" ||
        (error as NodeJS.ErrnoException).code === "ECONNRESET")
    ) {
      return new Response(null, { status: 499 }); // Client Closed Request
    }

    return createErrorResponse(error, { route: "api/db/monitoring" });
  }
}
