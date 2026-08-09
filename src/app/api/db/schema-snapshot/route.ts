import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider } from "@/lib/db/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

export async function POST(request: NextRequest) {
  let provider = null;

  // Moved ahead of request.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/schema-snapshot", bucket: "query", request });
  if ("response" in guard) return guard.response;

  try {
    const body = await request.json();

    const connection = await resolveConnection(body, guard.session);

    provider = await createDatabaseProvider(connection);
    await provider.connect();

    const schema = await provider.getSchema();

    await provider.disconnect();
    provider = null;

    return NextResponse.json({
      schema,
      connectionId: connection.id,
      connectionName: connection.name,
      databaseType: connection.type,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        /* ignore */
      }
    }

    return createErrorResponse(error, { route: "api/db/schema-snapshot" });
  }
}
