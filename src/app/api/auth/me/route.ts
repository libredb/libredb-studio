import * as auth from "@/lib/auth";
import { ACCOUNT_STORE_UNAVAILABLE_BODY } from "@/lib/api/account-store-error";
import { NextResponse } from "next/server";

export async function GET() {
  const readSession = (auth as { readSession?: () => Promise<auth.SessionReading> }).readSession;
  const reading: auth.SessionReading =
    typeof readSession === "function"
      ? await readSession()
      : await (async () => {
          const session = await auth.getSession();
          return session ? { kind: "authenticated" as const, session } : { kind: "anonymous" as const };
        })();

  if (reading.kind === "store_unavailable") {
    return NextResponse.json(ACCOUNT_STORE_UNAVAILABLE_BODY, { status: 503 });
  }
  if (reading.kind !== "authenticated") {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, user: reading.session });
}
