import { NextRequest, NextResponse } from "next/server";
import { removeProvider } from "@/lib/db/factory";
import { requireSession } from "@/lib/api/require-session";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  try {
    const { connectionId } = await req.json();

    if (!connectionId || typeof connectionId !== "string") {
      return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 });
    }

    await removeProvider(connectionId);

    logger.info("[DB] Provider disconnected and removed from cache", { connectionId });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[DB] Error disconnecting provider", { error: String(error) });
    return NextResponse.json({ success: false, error: "Failed to disconnect" }, { status: 500 });
  }
}
