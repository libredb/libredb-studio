import { NextRequest } from "next/server";
import {
  handleObjectRequest,
  INVENTORY_PAIR_LIMIT,
  ObjectRouteError,
  optionalStringArray,
  requireString,
  resolveKinds,
} from "@/lib/api/object-route";
import { enumerateContainers, kindsByContainer } from "@/lib/db/container-walk";
import { applicableKinds } from "@/lib/db/object-kinds";
import type { DatabaseObject } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * Name search across every container and the kinds each holds of those the object surface enumerates
 * (#789, #1089 3.4).
 *
 * NO PRODUCT CALLER TODAY, stated rather than left for the next reader to discover. The tree's
 * filter box is Phase 2; this route is the half that cannot be built in the browser, and it was
 * landed with the rest of the surface in Task 4 so the four routes share one request shape, one
 * error vocabulary and one test file. It is exercised by `tests/api/db-objects.test.ts` and by
 * nothing else, so its cost claims below are reasoned rather than measured against a real
 * consumer, and the Phase 2 task that wires it owes that measurement.
 *
 * Server side, because a lazily loaded tree has nothing local to filter: a search for
 * `order_summary` before the Views folder was ever expanded would answer nothing and read as
 * "not found", and a false-negative search is worse than no search at all.
 *
 * The scan is bounded by REFUSAL, never by a cut. A cut would produce exactly the false negatives
 * above, and a cap on the response would bound nothing that matters, because the cost of a search is
 * the scan and not the matches. So a search that would list more container and kind pairs than the
 * inventory's `INVENTORY_PAIR_LIMIT` is refused before its first listing, with the sentence telling the
 * caller to name fewer kinds, and every search under it answers every match. A container is paired
 * only with the kinds it holds (`Container.kinds`), so the bound counts listings that can be sent.
 *
 * Matching is on `name`, the display label, and not on the path's last segment. Those differ
 * exactly where the segment carries a disambiguated form the user never typed and never sees: an
 * overloaded PostgreSQL routine is named `order_total` and addressed `order_total(integer)`.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/search", async (provider, body) => {
    const term = requireString(body, "term").toLowerCase();
    const kinds = resolveKinds(provider, optionalStringArray(body, "kinds"));

    const enumerated = await enumerateContainers(provider);
    const kindsOf = kindsByContainer(enumerated);
    const pairs = enumerated.containers.flatMap((container) =>
      applicableKinds(kinds, kindsOf.get(JSON.stringify(container))).map((kind) => ({ container, kind: kind.id })),
    );
    if (pairs.length > INVENTORY_PAIR_LIMIT) {
      throw new ObjectRouteError(
        `this search would list ${pairs.length} container and kind pairs, more than the ${INVENTORY_PAIR_LIMIT} ` +
          'one search may list; name fewer kinds in "kinds"',
        400,
      );
    }
    const listObjects = provider.listObjects.bind(provider);

    // Sequential on purpose, and the `no-await-in-loop` warning is accepted here. Every listing
    // takes a client from one pool, so a `Promise.all` over containers times kinds would open as
    // many concurrent reads as the schema has folders and exhaust the pool on exactly the large
    // schemas this route exists to serve.
    const matches: DatabaseObject[] = [];
    for (const pair of pairs) {
      for (const object of await listObjects(pair.container, pair.kind)) {
        if (object.name.toLowerCase().includes(term)) matches.push(object);
      }
    }
    return matches;
  });
}
