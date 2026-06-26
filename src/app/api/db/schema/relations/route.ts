import { NextRequest } from "next/server";
import { handleSchemaRequest } from "@/lib/api/schema-route";

export const dynamic = "force-dynamic";

/**
 * Heavy relationship/index introspection (foreign keys + indexes), keyed by
 * table display name for async merge into /api/db/schema/list results. Kept
 * separate so its cost never blocks the table list. Returns [] for providers
 * that don't implement it.
 */
export async function POST(req: NextRequest) {
  return handleSchemaRequest(req, "api/db/schema/relations", async (provider) =>
    provider.getSchemaRelations ? provider.getSchemaRelations() : [],
  );
}
