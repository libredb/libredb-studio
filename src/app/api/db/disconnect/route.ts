import { NextRequest, NextResponse } from "next/server";
import { removeProvider } from "@/lib/db/factory";
import { guardRoute } from "@/lib/api/require-session";
import { sessionOwner } from "@/lib/api/execution-context";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  // Shares the query bucket: a disconnect is cheap on its own, but rotating to it must not be a
  // way to keep hammering the provider layer after the query budget is spent.
  const guard = await guardRoute({ route: "POST /api/db/disconnect", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const { connectionId } = await req.json();

    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 });
    }

    // Under governance every user's providers are their own (spec 9.4), so the caller's disconnect removes only the
    // caller's: the owner the editor context names, the session's identity provider subject. Without governance there
    // is none, and every provider of the connection goes, as before.
    const owner = sessionOwner(guard.session);
    if (owner === undefined) await removeProvider(connectionId);
    else await removeProvider(connectionId, { owner });

    logger.info("[DB] Provider disconnected and removed from cache", { connectionId });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[DB] Error disconnecting provider", error, { route: "POST /api/db/disconnect" });
    return NextResponse.json({ success: false, error: "Failed to disconnect" }, { status: 500 });
  }
}
