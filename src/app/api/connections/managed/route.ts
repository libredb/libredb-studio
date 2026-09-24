import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getManagedConnections, getPendingSeeds } from "@/lib/seed";
import { logger } from "@/lib/logger";
import { withoutSecretFields } from "@/lib/storage/connection-secrets";
import { SEED_CONFIG_UNREADABLE_REASON } from "@/hooks/use-connection-payload";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // Read in its own try, so the `reason` below is a claim about the seed
    // configuration and not a synonym for "this request failed" (B37). A browser told
    // only "500" cannot tell an unreadable seed file from a server that serves no
    // seeds, and it then reports the second — of connections this application seeds
    // itself. The outer catch keeps its unattributed 500 for everything else.
    let connections;
    try {
      connections = await getManagedConnections([session.role]);
    } catch (error) {
      logger.error("Failed to load the seed configuration", error, {
        route: "GET /api/connections/managed",
      });
      return NextResponse.json(
        { error: "Failed to load managed connections", reason: SEED_CONFIG_UNREADABLE_REASON },
        { status: 500 },
      );
    }

    // A managed connection is opened by id (`buildConnectionPayload` sends `seed:<id>`), so the
    // browser needs none of its credentials: every field the storage layer classifies as secret
    // stays here, the API key pair and the TLS client key as well as the password. An editable
    // one is copied into the browser to be edited, so it keeps them.
    const sanitized = connections.map((conn) => (conn.managed ? withoutSecretFields(conn) : conn));

    const rawTTL = Number(process.env.SEED_CACHE_TTL_MS);
    const cacheTTL = Number.isFinite(rawTTL) ? rawTTL : 60_000;

    // Seed ids still being seeded asynchronously (e.g. the SQLite sample file
    // copy at boot) — clients poll while non-empty so the sample appears
    // without a page refresh. Always [] when embedded in platform.
    return NextResponse.json({ connections: sanitized, cacheHint: cacheTTL, pendingSeeds: getPendingSeeds() });
  } catch (error) {
    logger.error("Failed to load managed connections", error, {
      route: "GET /api/connections/managed",
    });
    return NextResponse.json({ error: "Failed to load managed connections" }, { status: 500 });
  }
}
