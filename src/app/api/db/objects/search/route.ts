import { NextRequest } from "next/server";
import {
  enumerateContainers,
  handleObjectRequest,
  optionalStringArray,
  requireMethod,
  requireString,
  resolveKinds,
} from "@/lib/api/object-route";
import type { DatabaseObject } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * Name search across every container and every declared kind (#789).
 *
 * Server side, because a lazily loaded tree has nothing local to filter: a search for
 * `order_summary` before the Views folder was ever expanded would answer nothing and read as
 * "not found", and a false-negative search is worse than no search at all.
 *
 * Deliberately UNCAPPED, unlike `inventory`, and that is the same rule rather than an exception to
 * it. A cap on the scan would produce exactly the false negatives above. A cap on the response
 * would bound nothing that matters, because every container and every kind has already been listed
 * by the time the filter runs; the cost of a search is the scan, not the matches. So this route
 * answers every match, and `inventory` is the surface that bounds the scan and says when it did.
 *
 * Matching is on `name`, the display label, and not on the path's last segment. Those differ
 * exactly where the segment carries a disambiguated form the user never typed and never sees: an
 * overloaded PostgreSQL routine is named `order_total` and addressed `order_total(integer)`.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/search", async (provider, body) => {
    const term = requireString(body, "term").trim().toLowerCase();
    const kinds = resolveKinds(provider, optionalStringArray(body, "kinds"));

    const containers = await enumerateContainers(provider);
    const listObjects = requireMethod(provider, "listObjects");

    // Sequential on purpose, and the `no-await-in-loop` warning is accepted here. Every listing
    // takes a client from one pool, so a `Promise.all` over containers times kinds would open as
    // many concurrent reads as the schema has folders and exhaust the pool on exactly the large
    // schemas this route exists to serve.
    const matches: DatabaseObject[] = [];
    for (const container of containers) {
      for (const kind of kinds) {
        for (const object of await listObjects(container, kind.id)) {
          if (object.name.toLowerCase().includes(term)) matches.push(object);
        }
      }
    }
    return matches;
  });
}
