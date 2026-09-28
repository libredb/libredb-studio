import { NextResponse } from "next/server";
import { accountFailureResponse } from "@/lib/api/account-response";
import { withLoginBudget } from "@/lib/api/login-budget";
import { guardRoute } from "@/lib/api/require-session";
import { beginTotpEnrolment, confirmTotpEnrolment, disableOwnTotp, ownFactorStatus } from "@/lib/local-accounts";

const ROUTE = "POST /api/auth/totp";

type TotpAction = (request: Request, email: string, body: unknown) => Promise<Response>;

/**
 * The body's `action` picks one of these. A table rather than a chain of comparisons: every entry
 * already runs behind the session guard, and the checks that matter (the password, the code) are
 * made inside each one, never decided by which string the caller sent.
 */
const ACTIONS: Record<string, TotpAction> = {
  begin: async (request, email, body) =>
    NextResponse.json(await withLoginBudget(request, email, () => beginTotpEnrolment(email, body))),
  confirm: async (_request, email, body) => {
    const code =
      typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
    await confirmTotpEnrolment(email, code);
    return NextResponse.json({ ok: true });
  },
  disable: async (request, email, body) => {
    await withLoginBudget(request, email, () => disableOwnTotp(email, body));
    return NextResponse.json({ ok: true });
  },
};

export async function GET(request: Request) {
  const guard = await guardRoute({ route: "GET /api/auth/totp", bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    return NextResponse.json(await ownFactorStatus(guard.session.username));
  } catch (error) {
    return accountFailureResponse(error, "GET /api/auth/totp");
  }
}

export async function POST(request: Request) {
  const guard = await guardRoute({ route: ROUTE, bucket: "query", request });
  if ("response" in guard) return guard.response;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const action = typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
    const run = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!run) return NextResponse.json({ error: "action must be begin, confirm, or disable" }, { status: 400 });
    return await run(request, guard.session.username, body);
  } catch (error) {
    return accountFailureResponse(error, ROUTE);
  }
}
