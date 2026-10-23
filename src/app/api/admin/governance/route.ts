import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { auditRoleDenial, guardRoute, adminRequiredResponse } from "@/lib/api/require-session";
import { governanceEnabled } from "@/lib/governance/config";
import { type GovernanceStatus, governanceStatus } from "@/lib/governance/status";

const GET_ROUTE = "GET /api/admin/governance";

/** The body of a 200 answer, which the admin Overview card (GovernanceStatusCard) imports. */
export type GovernanceStatusResponse = { governance: GovernanceStatus | null };

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
 * The governance status for the admin Overview card (docs/GOVERNANCE.md#admin-status): the contract versions, the
 * freshness state, the snapshot's age, the latest load failure, the admitted and skipped rows and the keyring's key
 * ids. It names ids, levels, paths and codes only, never a definition value, an envelope, a credential or a statement.
 * With governance off it answers `{ governance: null }`.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, GET_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    const body: GovernanceStatusResponse = { governance: governanceEnabled() ? governanceStatus() : null };
    return NextResponse.json(body);
  } catch (error) {
    return createErrorResponse(error, { route: GET_ROUTE });
  }
}
