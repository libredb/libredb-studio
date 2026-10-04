import { NextResponse } from "next/server";
import { accountFailureResponse } from "@/lib/api/account-response";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { login } from "@/lib/auth";
import { changeAccount, removeAccount } from "@/lib/local-accounts";

const PATCH_ROUTE = "PATCH /api/admin/accounts/[email]";
const DELETE_ROUTE = "DELETE /api/admin/accounts/[email]";

async function requireAdmin(request: Request, route: string) {
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard;
  if (guard.session.role !== "admin") {
    auditRoleDenial({ route, user: guard.session.username, request });
    return { response: NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 }) };
  }
  return guard;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ email: string }> }) {
  const guard = await requireAdmin(request, PATCH_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    const { email } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { account, sessionVersion } = await changeAccount(guard.session.username, email, body);
    // Changing your own role or password ends your other sessions, not the one making the change.
    if (account.email.toLowerCase() === guard.session.username.toLowerCase() && !account.disabled) {
      await login(account.role, account.email, sessionVersion);
    }
    return NextResponse.json({ account });
  } catch (error) {
    return accountFailureResponse(error, PATCH_ROUTE);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ email: string }> }) {
  const guard = await requireAdmin(request, DELETE_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    const { email } = await params;
    await removeAccount(guard.session.username, email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return accountFailureResponse(error, DELETE_ROUTE);
  }
}
