import { NextResponse } from "next/server";
import { isAgentRuntimeEnabled } from "@/lib/agent/config";
import { getSession } from "@/lib/auth";

/**
 * GET /api/agent/config — whether this server runs agents (#329 T10a).
 *
 * The rail is a client component and `LIBREDB_AGENT_ENABLED` is server-side only,
 * so visibility is discovered at runtime the way the storage mode already is
 * (`src/hooks/use-storage-sync.ts` reads `/api/storage/config`). Reading it at
 * build time instead would answer for the build: the standalone pages are
 * statically prerendered, and the operator sets this variable on the container.
 *
 * Two differences from the storage probe, both deliberate:
 *
 *  - **A session is required.** T9 pinned that the flag check sits after the
 *    session check in every agent route, so an unauthenticated caller cannot learn
 *    whether an agent surface exists here. The rail only ever renders for a
 *    logged-in user, so nothing is lost.
 *  - **Only the flag is answered.** Not the durable backend, not the model
 *    provider: the browser needs to know whether to render a surface, and every
 *    other agent detail is an operator's business.
 *
 * The session is verified here with `getSession` rather than through `guardRoute`,
 * following `/api/connections/managed`: this route reaches no database and no model,
 * and metering a visibility probe out of the `ai` bucket would spend a run's budget
 * on rendering a panel.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // Only the flag, never `resolveAgentDurableBackend()`: that one refuses an
  // unsanctioned world by throwing, and a 500 here would be indistinguishable from
  // a server whose runtime is simply off — hiding the misconfiguration behind the
  // symptom an operator would be trying to diagnose. A bad backend fails where a
  // world is actually built, which is where it can be reported as itself.
  return NextResponse.json({ enabled: isAgentRuntimeEnabled() });
}
