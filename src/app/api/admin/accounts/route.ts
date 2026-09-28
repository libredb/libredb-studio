import { NextResponse } from "next/server";
import { accountFailureResponse } from "@/lib/api/account-response";
import { auditRoleDenial, guardRoute } from "@/lib/api/require-session";
import { createAccount, listPublicAccounts } from "@/lib/local-accounts";

const GET_ROUTE = "GET /api/admin/accounts";
const POST_ROUTE = "POST /api/admin/accounts";

async function requireAdmin(request: Request, route: string) {
  const guard = await guardRoute({ route, bucket: "query", request });
  if ("response" in guard) return guard;
  if (guard.session.role !== "admin") {
    auditRoleDenial({ route, user: guard.session.username, request });
    return { response: NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 }) };
  }
  return guard;
}

export async function GET(request: Request) {
  const guard = await requireAdmin(request, GET_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    return NextResponse.json({ accounts: await listPublicAccounts() });
  } catch (error) {
    return accountFailureResponse(error, GET_ROUTE);
  }
}

export async function POST(request: Request) {
  const guard = await requireAdmin(request, POST_ROUTE);
  if ("response" in guard) return guard.response;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const account = await createAccount(guard.session.username, body);
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    return accountFailureResponse(error, POST_ROUTE);
  }
}
