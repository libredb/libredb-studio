import { NextRequest } from "next/server";
import { handleObjectRequest, requireObjectPath, requireString } from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * Columns, indexes and foreign keys for one object (#789).
 *
 * THE OBJECT TREE IS THE CALLER, one read per EXPANDED object row. A reader opens the twisty on an
 * object whose kind declares `hasColumns`, the tree issues the `describe` arm of
 * `ObjectReadRequest` (`src/components/object-tree/use-tree-nodes.ts`), and the columns of this
 * answer are the rows drawn under it. This paragraph used to say the route had no product caller
 * and was exercised by `tests/api/db-objects.test.ts` and by nothing else, which was true until
 * the tree started reading it.
 *
 * ONE READ PER GESTURE IS NOT THE N+1 THAT WAS REMOVED, and the gesture is the whole difference.
 * The removed one was the inventory route's `includeColumns` over a WHOLE DATABASE, eagerly, up to
 * 5,000 sequential round trips with no user gesture behind any of them. This one is issued only
 * for a row somebody opened, is cached for the life of the connection's tree cache, and is NOT
 * re-issued when that row is collapsed and expanded again. The bound is the tree's expansion
 * state and never the size of the database.
 *
 * A REFRESH COSTS ONE DESCRIBE PER OPEN OBJECT ROW WHOSE LAST ONE HAS SETTLED. A `refreshToken`
 * bump re-issues over those rows, so the columns a DDL statement added appear, and DROPS the cached
 * detail of every collapsed one, so re-expanding reads again rather than drawing a column list that
 * statement invalidated.
 *
 * THE EXCEPTION IS A BUMP THAT ARRIVES WHILE THAT ROW'S DESCRIBE IS STILL IN FLIGHT, and this
 * paragraph used to claim otherwise. `run` keys each read by its slot and returns early when that
 * key is already in flight (`src/components/object-tree/use-tree-nodes.ts`, the `inFlight` guard),
 * so the bump issues nothing for that row: the pre-DDL answer lands afterwards, is stored, and is
 * drawn as current until the next bump. Nothing here is specific to a describe. `refresh` and that
 * guard both predate the tree reading this route, and the same race drops a container, count or
 * listing re-read; measured on the `list` slot with no kind declaring `hasColumns`, the stale
 * listing survives the bump exactly as the stale column list does. Filed rather than fixed here,
 * because teaching one slot kind to queue would make the describe the only read that survives the
 * race, which is a worse inconsistency than the race.
 *
 * The budget is SHARED and this route carries no bucket of its own: `handleObjectRequest` meters
 * every object route into the `query` bucket through its `guardRoute` call
 * (`src/lib/api/object-route.ts`), 120 requests per 60 seconds by default, shared with
 * `POST /api/db/query` and the storage sync routes. A reader with many rows open therefore spends
 * the same allowance their statements do.
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
