import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider, findOpenSingleWriterProvider, withOneShotTunnel } from "@/lib/db/factory";
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
      /*
        The handle already holding this connection's file, on an engine that admits
        only one (`ProviderCapabilities.singleWriterFile`; #498).

        This route is the third caller of that shape, after `test-connection` and the
        profiled acquisition, and it failed the same way: measured 2026-08-25 against
        the released 0.13.4 image with the built-in LibreDB sample connected, it
        answered HTTP 503 with the exclusive-lock message - so the Schema Diff tab's
        Snapshot button, its only caller, could not read a schema the sidebar was
        listing at that moment.

        A borrowed handle answers the one question this route asks, and it is NOT this
        route's to close: `borrowed` guards every disconnect below, because closing it
        would close the file under the session that opened it.
      */
      const borrowed = findOpenSingleWriterProvider(effective);
      // Declared inside the scope so a provider this route opened is always torn down
      // before the tunnel it runs over.
      let provider = borrowed;
      const release = async () => {
        const own = borrowed ? null : provider;
        provider = null;
        if (own) await own.disconnect();
      };
      try {
        if (!provider) {
          provider = await createDatabaseProvider(effective);
          await provider.connect();
        }

        const schema = await provider.getSchema();

        await release();

        return NextResponse.json({
          schema,
          connectionId: connection.id,
          connectionName: connection.name,
          databaseType: connection.type,
          timestamp: new Date().toISOString(),
        });
      } finally {
        // Only reached when the block above threw before its own release, and never
        // for a borrowed handle - which this route did not open and must not close.
        if (provider && !borrowed) {
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
