import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sessionRequiredBody } from "@/lib/api/session-ended";
import { customConnectionsAllowed } from "@/lib/config/custom-connections";
import { governanceEnabled } from "@/lib/governance/config";
import { runtimeSetting } from "@/lib/governance/settings";

/**
 * What Studio captures when the control plane set no valid `queryLog.statementCapture`: the default
 * docs/GOVERNANCE.md#runtime-settings gives.
 */
const DEFAULT_STATEMENT_CAPTURE = "none";

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
 * Under governance (`GOVERNANCE_SOURCE`, docs/GOVERNANCE.md) the answer adds `governance: true`, so
 * the connection list can tell a user with no grants that an administrator grants access, and
 * `statementCapture`, the active `queryLog.statementCapture` (docs/GOVERNANCE.md#grants-and-the-connection-list), so
 * the editor can tell a user that statements are recorded in full. Without governance both fields are absent and the
 * answer is the one it always was.
 *
 * The answer only decides what the editor offers. The rule itself is enforced in
 * `resolveConnection`, on every route that builds a provider, whatever a client believes.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(sessionRequiredBody("Authentication required"), { status: 401 });
  }
  const customConnections = customConnectionsAllowed();
  if (!governanceEnabled()) return NextResponse.json({ customConnections });
  const statementCapture = runtimeSetting("queryLog.statementCapture") ?? DEFAULT_STATEMENT_CAPTURE;
  return NextResponse.json({ customConnections, governance: true, statementCapture });
}
