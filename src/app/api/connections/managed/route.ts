import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getManagedConnections, getPendingSeeds } from "@/lib/seed";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const connections = await getManagedConnections([session.role]);

    const sanitized = connections.map((conn) => {
      if (conn.managed) {
        const { password, connectionString, ...rest } = conn;
        return rest;
      }
      return conn;
    });

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
