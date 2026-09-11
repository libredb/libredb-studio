import { NextRequest } from "next/server";
import { assertContainerDepth, handleObjectRequest, requireMethod, requireStringArray } from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * Per-kind counts for one container: what the tree draws its folder badges from (#789).
 *
 * The four states of `KindCount` travel over the wire unchanged. A kind missing from the record
 * is a kind the engine does not declare, `{ count: 0 }` is the engine answering none,
 * `{ unavailable }` carries the engine's own sentence for a refused read, and
 * `{ count, sampledFrom }` is a number the engine measured from a read that stopped short, so it
 * is a FLOOR rather than a total and the tree badges it with a trailing `+`. Collapsing any of
 * them into another here would be the defect this surface replaced, and the fourth is the one
 * most easily lost, because dropping `sampledFrom` leaves a number that still renders.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/counts", async (provider, body) => {
    const container = requireStringArray(body, "container");
    assertContainerDepth(provider, "container", container);
    return requireMethod(provider, "countObjects")(container);
  });
}
