import { NextRequest } from "next/server";
import { ApiErrorCode } from "@/lib/api/error-codes";
import {
  handleObjectRequest,
  INVENTORY_PAIR_LIMIT,
  ObjectRouteError,
  optionalStringArray,
  requireString,
  resolveKinds,
} from "@/lib/api/object-route";
import { objectTree } from "@/lib/api/object-tree";
import { providerTreeTarget } from "@/lib/api/session-target";
import { enumerateContainers, kindsByContainer } from "@/lib/db/container-walk";
import { assertNotWholeServer } from "@/lib/db/catalog-scope";
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
 * caller to name fewer kinds and the code `INVENTORY_PAIR_LIMIT` carrying the bound and the pair count,
 * and every search under it answers every match. A container is paired
 * only with the kinds it holds (`Container.kinds`), so the bound counts listings that can be sent.
 *
 * Matching is on `name`, the display label, and not on the path's last segment. Those differ
 * exactly where the segment carries a disambiguated form the user never typed and never sees: an
 * overloaded PostgreSQL routine is named `order_total` and addressed `order_total(integer)`.
 *
 * Every read of the walk, each container listing and each object listing, is a host core tree call
 * (`objectTree`, src/lib/api/object-tree.ts) under a deadline of its own, and the request's signal
 * ends the walk at its next read.
 *
 * Every read of the walk runs on the connection's metadata session (`{ session: "metadata" }`), beside the editor's, so
 * it never waits for the editor's statements, except on a connection that serves one session
 * (docs/providers/CONTRACT.md, clause C-66).
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(
    req,
    "api/db/objects/search",
    async (provider, body, context) => {
      const term = requireString(body, "term").toLowerCase();
      const tree = objectTree(providerTreeTarget(provider), req.signal, context.route);
      const kinds = resolveKinds(tree.objectModel, provider.type, optionalStringArray(body, "kinds"));

      assertNotWholeServer(provider);
      const enumerated = await enumerateContainers(tree);
      const kindsOf = kindsByContainer(enumerated);
      const pairs = enumerated.containers.flatMap((container) =>
        applicableKinds(kinds, kindsOf.get(JSON.stringify(container))).map((kind) => ({ container, kind: kind.id })),
      );
      if (pairs.length > INVENTORY_PAIR_LIMIT) {
        throw new ObjectRouteError(
          `this search would list ${pairs.length} container and kind pairs, more than the ${INVENTORY_PAIR_LIMIT} ` +
            'one search may list; name fewer kinds in "kinds"',
          400,
          ApiErrorCode.INVENTORY_PAIR_LIMIT,
          { limit: INVENTORY_PAIR_LIMIT, pairs: pairs.length },
        );
      }
      const { listObjects } = tree;

      // Sequential on purpose, and the await says so where it stands. Every listing
      // takes a client from one pool, so a `Promise.all` over containers times kinds would open as
      // many concurrent reads as the schema has folders and exhaust the pool on exactly the large
      // schemas this route exists to serve.
      const matches: DatabaseObject[] = [];
      for (const pair of pairs) {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, so the walk never sends the pool a burst.
        for (const object of await listObjects(pair.container, pair.kind)) {
          if (object.name.toLowerCase().includes(term)) matches.push(object);
        }
      }
      return matches;
    },
    { session: "metadata" },
  );
}
