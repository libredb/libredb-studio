import { NextRequest, NextResponse } from "next/server";
import { createDatabaseProvider, withOneShotTunnel } from "@/lib/db/factory";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";

export async function POST(req: NextRequest) {
  // Moved ahead of req.json(): an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/test-connection", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await req.json();

    // Support both formats: { connectionId: "seed:X" }, { connection: {...} }, or bare connection object
    const connection = await resolveConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );

    if (!connection.type) {
      return NextResponse.json({ success: false, error: "Connection configuration is required" }, { status: 400 });
    }

    // Through the tunnel, never around it (#457). This route builds its provider
    // directly rather than through `getOrCreateProvider`, so it does not inherit that
    // path's tunnel handling and has to ask for it. `withOneShotTunnel` owns the
    // tunnel's whole lifetime because nothing here is cached, so no eviction would
    // ever close a pooled one - and every failed test click would strand it.
    return await withOneShotTunnel(connection, async (effective) => {
      // Declared inside the scope so the provider is always torn down before the
      // tunnel it runs over, on the success and the failure path alike.
      let provider = null;
      try {
        provider = await createDatabaseProvider(effective, { queryTimeout: 10000 });
        // The connection itself: every provider's connect() reaches the server and is
        // refused by a wrong host, port, credential or database - the SQL ones borrow a
        // pooled client, and the HTTP ones send a probe statement. So a connect that
        // returns is the fact this route exists to establish.
        await provider.connect();

        /*
          The health read is a SECOND fact, and conflating the two is the defect this
          replaced: `getHealth()` is the richest surface a provider has, so a failure
          here is worth telling the user about - but it is not the connection.

          Measured 2026-08-24 against scylladb/scylla:2026.2.4: eight of the Cassandra
          provider's surfaces answer and `getHealth()` threw `Keyspace system_views does
          not exist`, because ScyllaDB has no such keyspace. This route answered
          `success: false`, the dialog gates its save on that answer, and a ScyllaDB
          connection could not be created at all. StarRocks and SingleStore sit on the
          same gate for reasons of their own.

          So a health failure after a successful connect is reported as a degraded
          success, carrying the server's own sentence. `latency` is omitted with it: the
          elapsed time of a read that failed is not a round trip.
        */
        const startTime = Date.now();
        try {
          await provider.getHealth();
        } catch (healthError) {
          await provider.disconnect();
          provider = null;

          return NextResponse.json({
            success: true,
            degraded: true,
            message: `Connected, but this server answered no health data: ${
              healthError instanceof Error ? healthError.message : String(healthError)
            }`,
          });
        }
        const latency = Date.now() - startTime;

        await provider.disconnect();
        provider = null;

        return NextResponse.json({
          success: true,
          message: "Connection successful",
          latency,
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
    return createErrorResponse(error, { route: "api/db/test-connection" });
  }
}
