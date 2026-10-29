import { readSession } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ACCOUNT_STORE_UNAVAILABLE_BODY } from "@/lib/api/account-store-error";

export async function GET() {
  const reading = await readSession();
  if (reading.kind === "store_unavailable") {
    return NextResponse.json(ACCOUNT_STORE_UNAVAILABLE_BODY, { status: 503 });
  }
  if (reading.kind !== "authenticated") {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  // The session handle of an openshift session keys its token record: it never leaves the server in a body.
  const user = { ...reading.session };
  delete user.sessionHandle;
  return NextResponse.json({ authenticated: true, user });
}
