import { NextResponse } from "next/server";
import { accountFailureResponse } from "@/lib/api/account-response";
import { clientAddress } from "@/lib/api/client-address";
import { consumeRateLimit, peekRateLimit, RateLimitError } from "@/lib/api/rate-limit";
import { guardRoute } from "@/lib/api/require-session";
import { hmacHex } from "@/lib/auth-compare";
import {
  AccountError,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableOwnTotp,
  ownFactorStatus,
} from "@/lib/local-accounts";

const ROUTE = "POST /api/auth/totp";

/**
 * begin and disable check the current password (and disable a current code), which makes this
 * route a guessing surface. It spends the login route's two budgets, keyed the same way, so the
 * guesses a caller gets are the same whichever route they use.
 */
async function withLoginBudget<T>(request: Request, email: string, run: () => Promise<T>): Promise<T> {
  const budgets = [
    { bucket: "login_client", key: clientAddress(request) },
    { bucket: "login_account", key: hmacHex(email.toLowerCase()) },
  ] as const;
  for (const { bucket, key } of budgets) {
    const decision = peekRateLimit(bucket, key);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  }
  try {
    return await run();
  } catch (error) {
    if (error instanceof AccountError && error.status === 401) {
      for (const { bucket, key } of budgets) consumeRateLimit(bucket, key);
    }
    throw error;
  }
}

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
