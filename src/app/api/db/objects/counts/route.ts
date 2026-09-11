import { NextRequest } from "next/server";
import { assertContainerDepth, handleObjectRequest, requireMethod, requireStringArray } from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * Per-kind counts for one container: what the tree draws its folder badges from (#789).
 *
 * The three states of `KindCount` travel over the wire unchanged. A kind missing from the record
 * is a kind the engine does not declare, `{ count: 0 }` is the engine answering none, and
 * `{ unavailable }` carries the engine's own sentence for a refused read. Collapsing any of them
 * into another here would be the defect this surface replaced.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/counts", async (provider, body) => {
    const container = requireStringArray(body, "container");
    assertContainerDepth(provider, "container", container);
    return requireMethod(provider, "countObjects")(container);
  });
}
