import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider, withOneShotTunnel } from "@/lib/db/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

export async function POST(request: NextRequest) {
  // Moved ahead of request.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/schema-snapshot", bucket: "query", request });
  if ("response" in guard) return guard.response;

  try {
    const body = await request.json();

    const connection = await resolveConnection(body, guard.session);

    // Through the tunnel, never around it (#457): the grounding capture reads its
    // schema here, and this route builds its provider outside both provider caches,
    // so the tunnel is its own to open and close. See `withOneShotTunnel`.
    return await withOneShotTunnel(connection, async (effective) => {
      // Declared inside the scope so the provider is always torn down before the
      // tunnel it runs over.
      let provider = null;
      try {
        provider = await createDatabaseProvider(effective);
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
      } finally {
        // Only reached when the block above threw before its own disconnect.
        if (provider) {
          try {
            await provider.disconnect();
          } catch {
            /* ignore */
          }
        }
      }
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/schema-snapshot" });
  }
}
