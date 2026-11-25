import { NextResponse } from "next/server";
import { getOrCreateMetadataProvider, readProviderDeclarations } from "@/lib/db";
import type { DatabaseConnection } from "@/lib/types";
import { createErrorResponse } from "@/lib/api/errors";
import { type ProviderTextScrub, providerTextScrub, withheldProviderError } from "@/lib/db/operations/provider-text";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { providerMonitoring } from "@/lib/api/provider-monitoring";

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
  /**
   * `not-checked` is a connection whose provider declares `resumesBilledCompute`: a check would
   * resume compute the engine bills for, so the route sends it nothing and `latencyMs` is 0.
   */
  status: "healthy" | "degraded" | "error" | "not-checked";
  latencyMs: number;
  activeConnections?: number;
  databaseSize?: string;
  /**
   * The provider's own byte figure from `getOverview()`, or absent when the provider publishes
   * none (same absence-vs-zero contract as `DatabaseOverview.databaseSizeBytes`). The dashboard
   * sums this directly instead of re-parsing `databaseSize`'s display string, which had no branch
   * for "1 TB" or larger and silently counted such a database as 1 byte.
   */
  databaseSizeBytes?: number;
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
    return adminRequiredResponse();
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
        // Core's scrub of this item's resolved connection, held out here for the `catch` below: before the connection
        // resolves no provider ran.
        let scrub: ProviderTextScrub | undefined;
        try {
          /*
           * Every item goes through `resolveConnection`, the caller's own connections included: a
           * managed seed by its id, which injects the operator's credentials on the server, and
           * anything else as the inline record it is, which `resolveConnection` refuses while
           * ALLOW_CUSTOM_CONNECTIONS is off and resolves from the seed file when its id claims the
           * `seed:` namespace. This line used to hand an inline record straight to the factory, the
           * one path in the product that opened a caller's connection without passing that gate. A
           * refused item is reported as that item's error, beside the health of the rest.
           */
          const resolved = await resolveConnection(buildConnectionPayload(conn), guard.session);
          scrub = providerTextScrub(resolved, "any");
          const execution = editorExecutionContext(guard.session, resolved);
          /*
           * The capability is read through `readProviderDeclarations`, the provider-meta pattern, which
           * builds the provider without connecting it or opening its tunnel and hands back data: a
           * connection that resumes billed compute (a suspended Databend Cloud warehouse wakes on
           * any statement) is answered without a cached provider or a statement, since a check on
           * every dashboard refresh would keep it awake and billed. The factory logs its
           * "[DB] Creating <type> provider" line for this build, once per row on every refresh,
           * as provider-meta does; the declaration is read each time because an edit of the
           * connection can change it.
           */
          const declarations = await readProviderDeclarations(resolved, execution);
          if (declarations.capabilities.resumesBilledCompute) {
            return {
              connectionId: conn.id,
              connectionName: conn.name,
              type: conn.type,
              environment: conn.environment,
              status: "not-checked",
              latencyMs: 0,
            };
          }
          // Health and the overview are read on the connection's metadata session (docs/providers/CONTRACT.md, clause
          // C-66), opened under the posture the declarations were read with, so a row never waits for a connection the
          // editor's statements hold; each read goes through the monitoring facade and the host core (clause C-75)
          // under its own deadline, the statement timeout plus 10 s, and the request's signal.
          const provider = await getOrCreateMetadataProvider(resolved, {}, execution);
          const monitoring = providerMonitoring(provider, request.signal, "api/admin/fleet-health");
          const health = await monitoring.readHealth();
          const latencyMs = Date.now() - start;

          // Best-effort and outside the latency measurement above: the overview read is a second
          // round-trip this route did not previously make, and a provider that cannot answer it
          // (or has none of this data) must not turn a working connection into an error result.
          // It is read only where the session's engine offers the overview panel (FND-4): elsewhere
          // the overview is not a reading of the engine, so it is never asked for and no byte figure
          // is carried. An overview read stopped at its deadline or by the request is dropped the same way.
          const databaseSizeBytes = await monitoring
            .readOverview()
            .then((overview) => overview?.databaseSizeBytes)
            .catch(() => undefined);

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            type: conn.type,
            environment: conn.environment,
            status: latencyMs > 5000 ? "degraded" : "healthy",
            latencyMs,
            activeConnections: health.activeConnections,
            databaseSize: health.databaseSize,
            databaseSizeBytes,
          };
        } catch (err) {
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            type: conn.type,
            environment: conn.environment,
            status: "error",
            latencyMs: Date.now() - start,
            // A failure whose text holds a credential of the item's connection answers Studio's sentence naming its
            // class.
            error:
              err instanceof Error
                ? scrub === undefined
                  ? err.message
                  : (withheldProviderError(scrub, err)?.message ?? err.message)
                : "Connection failed",
          };
        }
      }),
    );

    return NextResponse.json({ results });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/admin/fleet-health" });
  }
}
