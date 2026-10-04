import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { isPlainHttpRequest } from "@/lib/api/request-scheme";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { readCookieSecureOverride } from "@/lib/auth";
import { getDiscoveryStatus, type DiscoveryStatus } from "@/lib/seed/discovery-loader";

const GET_ROUTE = "GET /api/admin/discovery";

/** The body of a 200 answer, which the admin Overview card (PlatformDiscoveryCard) imports. */
export type DiscoveryResponse =
  | { discovery: null }
  | { discovery: DiscoveryStatus; transport: { plainHttp: boolean; cookieSecureOff: boolean } };

async function requireAdmin(request: Request, route: string) {
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard;
  if (guard.session.role !== "admin") {
    auditRoleDenial({ route, user: guard.session.username, request });
    return { response: NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 }) };
  }
  return guard;
}

/**
 * The CapRover discovery source's status for the admin Overview card: null when SEED_DISCOVERY_PATH
 * is unset. transport drives a display warning only and never a security decision.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, GET_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    const discovery = await getDiscoveryStatus();
    const body: DiscoveryResponse =
      discovery === null
        ? { discovery: null }
        : {
            discovery,
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
