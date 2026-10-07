import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { getOperatorSourceStatus } from "@/lib/seed/operator-loader";
import type { OperatorSourceReport } from "@/lib/seed/sources/types";

const GET_ROUTE = "GET /api/admin/seed-sources";

/** The body of a 200 answer, which the admin Overview card (SeedSourcesCard) imports. */
export type SeedSourcesResponse = { sources: OperatorSourceReport[] };

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
 * Each enabled operator seed source's status for the admin Overview card (Spec A 5.3): its state, the
 * connections it listed, the ones it or the resolution skipped, and the names it ignored. A source that
 * failed is reported here with its error while GET /api/connections/managed answers 500 on the same error,
 * so an admin reads why without the server logs. Every message, skip and note names files, variables,
 * fields and ids only, never a value.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, GET_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    const body: SeedSourcesResponse = { sources: await getOperatorSourceStatus() };
    return NextResponse.json(body);
  } catch (error) {
    return createErrorResponse(error, { route: GET_ROUTE });
  }
}
