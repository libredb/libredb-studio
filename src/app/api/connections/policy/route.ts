import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sessionRequiredBody } from "@/lib/api/session-ended";
import { customConnectionsAllowed } from "@/lib/config/custom-connections";

export const dynamic = "force-dynamic";

/**
 * GET /api/connections/policy - what this server lets a session do with connections of its own.
 *
 * The editor is a client component and `ALLOW_CUSTOM_CONNECTIONS` is server-side only, so the
 * answer is discovered at runtime, the way `/api/agent/config` and `/api/storage/config` are: the
 * standalone pages are prerendered, and the operator sets the variable on the running container.
 *
 * A session is required, through a bare `getSession()` like `GET /api/connections/managed`: the
 * answer reaches no database, and metering a probe the editor makes once per page load out of the
 * `query` bucket would spend a user's statement budget on drawing a sidebar. Its 401 carries the
 * AUTH_REQUIRED code, which `appFetch` answers by sending the tab to sign in.
 *
 * The answer only decides what the editor offers. The rule itself is enforced in
 * `resolveConnection`, on every route that builds a provider, whatever a client believes.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
  }
  return NextResponse.json({ customConnections: customConnectionsAllowed() });
}
