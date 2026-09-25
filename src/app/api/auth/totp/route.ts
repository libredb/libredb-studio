import { NextResponse } from "next/server";
import { accountFailureResponse } from "@/lib/api/account-response";
import { guardRoute } from "@/lib/api/require-session";
import { beginTotpEnrolment, confirmTotpEnrolment, disableOwnTotp } from "@/lib/local-accounts";

const ROUTE = "POST /api/auth/totp";

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
    const email = guard.session.username;
    if (action === "begin") {
      return NextResponse.json(await beginTotpEnrolment(email));
    }
    if (action === "confirm") {
      const code =
        typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
      await confirmTotpEnrolment(email, code);
      return NextResponse.json({ ok: true });
    }
    if (action === "disable") {
      await disableOwnTotp(email);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "action must be begin, confirm, or disable" }, { status: 400 });
  } catch (error) {
    return accountFailureResponse(error, ROUTE);
  }
}
