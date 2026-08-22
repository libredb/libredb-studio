import { NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import type { DatabaseConnection } from "@/lib/types";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { logger } from "@/lib/logger";

/**
 * The widest fan-out one request may ask for. guardRoute bounds how OFTEN this route is called,
 * not how WIDE a single call is: without this, one admin-authenticated POST opened as many
 * provider connections concurrently as its body named, and the rate limiter counted one request.
 * A fleet dashboard names tens of connections, so 100 is well clear of real use; the bound is
 * stated in the 400 so an operator who hits it can see what happened.
 */
const MAX_FLEET_CONNECTIONS = 100;

export interface FleetHealthItem {
  connectionId: string;
  connectionName: string;
  type: string;
  environment?: string;
  status: "healthy" | "degraded" | "error";
  latencyMs: number;
  activeConnections?: number;
  databaseSize?: string;
  error?: string;
}

export async function POST(request: Request) {
  // Shares the "query" bucket with every other database-reaching route, same as
  // db/maintenance: an admin session (or a stolen one) fanning this out repeatedly is the same
  // resource-exhaustion threat as hammering /api/db/query, just through an admin-only door.
  // Authentication now yields 401 (was folded into a blanket 403 before); role is checked
  // separately below so "no session" and "wrong role" stay distinguishable.
  const guard = await guardRoute({ route: "POST /api/admin/fleet-health", bucket: "query", request });
  if ("response" in guard) return guard.response;

  if (guard.session.role !== "admin") {
    auditRoleDenial({ route: "POST /api/admin/fleet-health", user: guard.session.username, request });
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }

  try {
    const { connections } = (await request.json()) as {
      connections: DatabaseConnection[];
    };

    if (!connections || !Array.isArray(connections)) {
      return NextResponse.json({ error: "connections array is required" }, { status: 400 });
    }

    if (connections.length > MAX_FLEET_CONNECTIONS) {
      return NextResponse.json(
        { error: `Too many connections: at most ${MAX_FLEET_CONNECTIONS} may be health-checked per request` },
        { status: 400 },
      );
    }

    const results: FleetHealthItem[] = await Promise.all(
      connections.map(async (conn): Promise<FleetHealthItem> => {
        const start = Date.now();
        try {
          // Resolve managed seed connections (server-side credential injection)
          const resolved =
            conn.managed && conn.seedId
              ? await resolveConnection({ connectionId: `seed:${conn.seedId}` }, guard.session)
              : conn;
          const provider = await getOrCreateProvider(resolved);
          const health = await provider.getHealth();
          const latencyMs = Date.now() - start;

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            type: conn.type,
            environment: conn.environment,
            status: latencyMs > 5000 ? "degraded" : "healthy",
            latencyMs,
            activeConnections: health.activeConnections,
            databaseSize: health.databaseSize,
          };
        } catch (err) {
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            type: conn.type,
            environment: conn.environment,
            status: "error",
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : "Connection failed",
          };
        }
      }),
    );

    return NextResponse.json({ results });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/admin/fleet-health" });
  }
}
