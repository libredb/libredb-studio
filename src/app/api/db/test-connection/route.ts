import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider } from "@/lib/db/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

export async function POST(req: NextRequest) {
  let provider = null;

  try {
    const body = await req.json();

    const guard = await guardRoute({ route: "POST /api/db/test-connection", bucket: "query", request: req });
    if ("response" in guard) return guard.response;

    // Support both formats: { connectionId: "seed:X" }, { connection: {...} }, or bare connection object
    const connection = await resolveConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );

    if (!connection.type) {
      return NextResponse.json({ success: false, error: "Connection configuration is required" }, { status: 400 });
    }

    provider = await createDatabaseProvider(connection, { queryTimeout: 10000 });
    await provider.connect();

    // Run a lightweight query to verify the connection actually works
    const startTime = Date.now();
    await provider.getHealth();
    const latency = Date.now() - startTime;

    await provider.disconnect();
    provider = null;

    return NextResponse.json({
      success: true,
      message: "Connection successful",
      latency,
    });
  } catch (error) {
    // Ensure we disconnect on error
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        /* ignore */
      }
    }

    return createErrorResponse(error, { route: "api/db/test-connection" });
  }
}
