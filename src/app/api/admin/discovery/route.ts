import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { isPlainHttpRequest } from "@/lib/api/request-scheme";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { readCookieSecureOverride } from "@/lib/auth";
import { governanceEnabled } from "@/lib/governance/config";
import { getDiscoveryStatus, type DiscoveryStatus } from "@/lib/seed/discovery-loader";
import { getKubernetesDiscoveryStatus, type KubernetesDiscoveryStatus } from "@/lib/seed/kubernetes-discovery-loader";

const GET_ROUTE = "GET /api/admin/discovery";

/**
 * The body of a 200 answer, which the admin Overview card (PlatformDiscoveryCard) imports: one status per platform
 * discovery source, null while that source is off, and the transport while any source is on.
 */
export interface DiscoveryResponse {
  /** The CapRover source. */
  discovery: DiscoveryStatus | null;
  /** The Kubernetes source. */
  kubernetesDiscovery: KubernetesDiscoveryStatus | null;
  transport?: { plainHttp: boolean; cookieSecureOff: boolean };
}

async function requireAdmin(request: Request, route: string) {
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard;
  if (guard.session.role !== "admin") {
    auditRoleDenial({ route, user: guard.session.username, request });
    return { response: adminRequiredResponse() };
  }
  return guard;
}

/**
 * Each platform discovery source's status for the admin Overview card: the CapRover source's, null when
 * SEED_DISCOVERY_PATH is unset, and the Kubernetes source's, null when SEED_KUBERNETES_DISCOVERY_PATH is unset. Both are
 * null under governance, which switches discovery off whatever those variables say, without asking either loader
 * (docs/SEED_CONNECTIONS.md, governance mode). transport drives a display warning only and never a security decision.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, GET_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    const [discovery, kubernetesDiscovery] = governanceEnabled()
      ? [null, null]
      : await Promise.all([getDiscoveryStatus(), getKubernetesDiscoveryStatus()]);
    const body: DiscoveryResponse =
      discovery === null && kubernetesDiscovery === null
        ? { discovery, kubernetesDiscovery }
        : {
            discovery,
            kubernetesDiscovery,
            transport: {
              plainHttp: isPlainHttpRequest(request),
              cookieSecureOff: readCookieSecureOverride() === false,
            },
          };
    return NextResponse.json(body);
  } catch (error) {
    return createErrorResponse(error, { route: GET_ROUTE });
  }
}
