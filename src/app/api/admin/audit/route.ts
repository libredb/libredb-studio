import { getSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { emitAuditEvent, getServerAuditBuffer, sanitizeAuditInput, type AuditEventType } from "@/lib/audit";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * The role denial's audit line, in the same shape guardRoute uses for `no_session`. This route has
 * no guardRoute in front of it, so its 403 covers both "no session" and "wrong role" - only the
 * latter is recorded, because naming an anonymous caller's rejection `insufficient_role` would
 * both misname the reason and let an unauthenticated caller write the trail for free.
 *
 * Isolated in its own try/catch for the same reason guardRoute isolates its emit: the 403 is
 * already decided, and a broken audit sink must never turn a denial into an unrelated 500 - which
 * on GET, whose check sits inside the handler's try, is exactly what would otherwise happen.
 */
function auditRoleDenial(route: string, user: string, request: Request): void {
  try {
    emitAuditEvent({
      type: "permission_denied",
      action: "denied",
      target: route,
      user,
      result: "failure",
      reason: "insufficient_role",
      ip: clientAddress(request),
    });
  } catch (auditError) {
    logger.error("Failed to record permission_denied audit event", auditError, { route });
  }
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      if (session) auditRoleDenial("GET /api/admin/audit", session.username, request);
      return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") as AuditEventType | null;
    const limit = parseInt(searchParams.get("limit") || "100", 10);

    const buffer = getServerAuditBuffer();
    const events = type ? buffer.filter({ type }) : buffer.getRecent(limit);

    return NextResponse.json({ events, total: buffer.size });
  } catch (error) {
    return createErrorResponse(error, { route: "GET /api/admin/audit" });
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    if (session) auditRoleDenial("POST /api/admin/audit", session.username, request);
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  }

  try {
    // Sanitizes (sanitizeAuditInput), then pushes to the display buffer directly — deliberately
    // NOT emitAuditEvent. This body is fully client-supplied and none of type/result/reason is
    // validated at runtime (request.json() is `any`; the closed unions only exist at compile
    // time), so this route must never gain the authority to write the stdout channel the design
    // treats as authoritative. Granting that would let an admin session, or a stolen one, forge a
    // libredb.audit.v1 line indistinguishable from one the system generated. See task-4-brief.md:
    // this endpoint stays a display-only passthrough.
    const event = await request.json();
    const buffer = getServerAuditBuffer();
    const created = buffer.push(
      sanitizeAuditInput({
        ...event,
        user: session.username || "admin",
      }),
    );

    return NextResponse.json({ event: created });
  } catch (error) {
    return createErrorResponse(error, { route: "POST /api/admin/audit" });
  }
}
