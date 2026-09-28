import { NextResponse } from "next/server";
import { accountFailureResponse } from "@/lib/api/account-response";
import { readBoundedJson } from "@/lib/api/bounded-json";
import { withLoginBudget } from "@/lib/api/login-budget";
import { guardRoute } from "@/lib/api/require-session";
import { login, type UserPayload } from "@/lib/auth";
import { isRecord } from "@/lib/is-record";
import {
  beginPasskeyRegistration,
  completePasskeyRegistration,
  passkeyStatus,
  removeOwnPasskey,
  renameOwnPasskey,
} from "@/lib/passkey/management";
import { PASSKEY_BODY_MAX_BYTES } from "@/lib/passkey/policy";

export const dynamic = "force-dynamic";

const GET_ROUTE = "GET /api/auth/passkey";
const POST_ROUTE = "POST /api/auth/passkey";
const INVALID_BODY = "Invalid request body";
const TOO_LARGE = "Request body is too large";
const ACTION_INVALID = "action must be register-options, register-verify, rename or remove";

/** Every answer carries the owner's passkey list or a ceremony, so none may be cached. */
function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

type PasskeyAction = (request: Request, session: UserPayload, body: unknown) => Promise<NextResponse>;

/**
 * The body's `action` picks one of these, as on the TOTP route. The two that check the current
 * password run inside the login budgets, because each is a guessing surface.
 */
const ACTIONS: Record<string, PasskeyAction> = {
  "register-options": async (request, session, body) =>
    NextResponse.json({
      options: await withLoginBudget(request, session.username, () => beginPasskeyRegistration(session, body)),
    }),
  "register-verify": async (_request, session, body) =>
    NextResponse.json({ passkey: await completePasskeyRegistration(session, body) }),
  rename: async (_request, session, body) => NextResponse.json({ passkey: await renameOwnPasskey(session, body) }),
  remove: async (request, session, body) => {
    const next = await withLoginBudget(request, session.username, () => removeOwnPasskey(session, body));
    // The removal ended every session of the account; the caller's own continues on the new version.
    await login(session.role, session.username, next);
    return NextResponse.json({ ok: true });
  },
};

export async function GET(request: Request) {
  const guard = await guardRoute({ route: GET_ROUTE, bucket: "query", request });
  if ("response" in guard) return noStore(guard.response);
  try {
    return noStore(NextResponse.json(await passkeyStatus(guard.session)));
  } catch (error) {
    return noStore(accountFailureResponse(error, GET_ROUTE));
  }
}

export async function POST(request: Request) {
  const guard = await guardRoute({ route: POST_ROUTE, bucket: "query", request });
  if ("response" in guard) return noStore(guard.response);
  try {
    const read = await readBoundedJson(request, PASSKEY_BODY_MAX_BYTES);
    if (!read.ok) {
      return noStore(
        NextResponse.json({ error: read.status === 413 ? TOO_LARGE : INVALID_BODY }, { status: read.status }),
      );
    }
    const action = isRecord(read.body) ? read.body.action : undefined;
    const run = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
    if (!run) return noStore(NextResponse.json({ error: ACTION_INVALID }, { status: 400 }));
    return noStore(await run(request, guard.session, read.body));
  } catch (error) {
    return noStore(accountFailureResponse(error, POST_ROUTE));
  }
}
