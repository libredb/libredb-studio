import { NextRequest } from "next/server";
import { handleObjectRequest, requireMethod, requireObjectPath, requireString } from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * Columns, indexes and foreign keys for one object (#789).
 *
 * `kind` is required in the body, not optional and not inferred. The provider method takes it as
 * its second argument for the reason recorded on the epic: without it a provider has to guess what
 * it is holding from whatever the path's last segment happens to match in a catalog, and a routine
 * answering no columns because no relation is called `order_total(integer)` is correct only by
 * accident. The caller always has the kind, because an object is only ever reached through its
 * kind's folder.
 *
 * No depth check here. This is an object path, not a container path: its length is the container
 * depth plus one segment per nesting level, and how deep a kind nests is a per-kind fact the
 * provider's own declaration carries (a trigger nests under its table). The provider validates it
 * against that declaration.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/describe", async (provider, body) => {
    const path = requireObjectPath(body);
    const kind = requireString(body, "kind");
    return requireMethod(provider, "describeObject")(path, kind);
  });
}
