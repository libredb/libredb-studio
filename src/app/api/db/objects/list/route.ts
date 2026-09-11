import { NextRequest } from "next/server";
import {
  assertContainerDepth,
  handleObjectRequest,
  requireMethod,
  requireString,
  requireStringArray,
} from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * The objects of one kind in one container, names only (#789).
 *
 * A kind the engine does not declare is left to the provider rather than pre-checked here: the
 * provider owns the mapping from a kind id to a catalog and already refuses an unknown one with
 * the engine's own wording, and a second list of kind ids in this route would be a second place
 * for that mapping to drift.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/list", async (provider, body) => {
    const container = requireStringArray(body, "container");
    const kind = requireString(body, "kind");
    assertContainerDepth(provider, "container", container);
    return requireMethod(provider, "listObjects")(container, kind);
  });
}
