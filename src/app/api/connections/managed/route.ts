import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sessionRequiredBody } from "@/lib/api/session-ended";
import { getPendingSeeds, KUBERNETES_REVIEWED_ROLE, type ManagedConnection } from "@/lib/seed";
import { logger } from "@/lib/logger";
import { withoutSecretFields } from "@/lib/storage/connection-secrets";
import { SEED_CONFIG_UNREADABLE_REASON } from "@/hooks/use-connection-payload";
import { governanceEnabled } from "@/lib/governance/config";
import { GovernanceUnavailableError, visibleConnections } from "@/lib/governance/visible";

export const dynamic = "force-dynamic";

/**
 * How often a browser asks again under governance (docs/GOVERNANCE.md): a grant made or revoked in the control plane
 * reaches the list within seconds, while the snapshot it is read from is in process memory and costs nothing to ask.
 */
const GOVERNED_CACHE_HINT_MS = 10_000;

/**
 * The server-only markers are not part of this response's shape, so they are removed before anything reaches the
 * browser: the literal marker (src/lib/seed/types.ts) tells the server how to resolve a connection's values, the
 * Kubernetes Secret marker which Secret the access review asks about, the reserved role (src/lib/seed/roles.ts) that
 * sets a connection apart for that review, so a reviewed connection reaches the browser with no role, and the grant
 * level (src/lib/governance/visible.ts) which credential a governed record carries. The level itself is no secret and
 * goes out as `access`, so a client can say a connection is read only before a write fails.
 */
function withoutServerMarkers(conn: GovernedRecord): ManagedConnection {
  const { grantLevel, ...copy } = conn;
  delete copy.literal;
  delete copy.kubernetesSecret;
  copy.roles = copy.roles.filter((role) => role !== KUBERNETES_REVIEWED_ROLE);
  return grantLevel === undefined ? copy : { ...copy, access: grantLevel };
}

/** A listed record: a governed one carries the level of the credential it was resolved for. */
type GovernedRecord = ManagedConnection & { grantLevel?: "read" | "write" };

/** How long the browser may keep the list, in ms: `SEED_CACHE_TTL_MS`, 60000 by default, and 10000 under governance. */
function cacheHintMs(): number {
  if (governanceEnabled()) return GOVERNED_CACHE_HINT_MS;
  const rawTTL = Number(process.env.SEED_CACHE_TTL_MS);
  return Number.isFinite(rawTTL) ? rawTTL : 60_000;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
    }

    // Read in its own try, so the `reason` below is a claim about the seed
    // configuration and not a synonym for "this request failed" (B37). A browser told
    // only "500" cannot tell an unreadable seed file from a server that serves no
    // seeds, and it then reports the second — of connections this application seeds
    // itself. The outer catch keeps its unattributed 500 for everything else.
    let connections;
    try {
      connections = await visibleConnections(session);
    } catch (error) {
      // Under governance a snapshot that cannot be served is answered as such, never as an empty list a browser
      // would read as "nothing granted", and no seed configuration is read, so no other failure here is one.
      if (error instanceof GovernanceUnavailableError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
      }
      if (governanceEnabled()) throw error;
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
    // one is copied into the browser to be edited, so it keeps them. Every governed connection is
    // managed, so it never leaves with a credential.
    // A bearer session is a native client (src/lib/oidc-bearer.ts), which edits no connection and holds no database
    // credential, so an editable one reaches it without them too.
    const sanitized = connections
      .map(withoutServerMarkers)
      .map((conn) => (conn.managed || session.channel === "bearer" ? withoutSecretFields(conn) : conn));

    // Seed ids still being seeded asynchronously (e.g. the SQLite sample file
    // copy at boot) — clients poll while non-empty so the sample appears
    // without a page refresh. Always [] when embedded in platform, and under
    // governance, where no sample is seeded.
    return NextResponse.json({ connections: sanitized, cacheHint: cacheHintMs(), pendingSeeds: getPendingSeeds() });
  } catch (error) {
    logger.error("Failed to load managed connections", error, {
      route: "GET /api/connections/managed",
    });
    return NextResponse.json({ error: "Failed to load managed connections" }, { status: 500 });
  }
}
