import { NextRequest } from "next/server";
import { assertContainerDepth, handleObjectRequest, optionalStringArray } from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * The containers under `parent`, or the top level when `parent` is absent (#789).
 *
 * The depth check runs before the provider is called: a parent deeper than the engine declares
 * addresses a level the provider has no way to resolve, so it is a caller bug and a 400, not an
 * engine error. A parent exactly at the declared depth is passed through, because "this level has
 * no children" is a true answer an engine is allowed to give.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/containers", async (provider, body) => {
    const parent = optionalStringArray(body, "parent");
    if (parent !== undefined) assertContainerDepth(provider, "parent", parent);
    return provider.listContainers(parent);
  });
}
