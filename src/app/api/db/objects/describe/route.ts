import { NextRequest } from "next/server";
import { handleObjectRequest, requireObjectPath, requireString } from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * Columns, indexes and foreign keys for one object (#789).
 *
 * NO PRODUCT CALLER TODAY, stated rather than left for the next reader to discover. The details
 * pane a reader opens on a single row is Phase 2; Phase 1's consumers all read a WHOLE folder,
 * through `describeObjects` and the inventory route's `includeColumns`, because one call per
 * object was measured as an N+1 of up to 5000 round trips and removed. This route is the
 * single-object read that pane will want, landed with the rest of the surface in Task 4 so the
 * four routes share one request shape, one error vocabulary and one test file. It is exercised by
 * `tests/api/db-objects.test.ts` and by nothing else.
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
    return provider.describeObject(path, kind);
  });
}
