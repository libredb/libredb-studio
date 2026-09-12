import { NextRequest } from "next/server";
import {
  assertContainerDepth,
  dedupePaths,
  handleObjectRequest,
  INVENTORY_LIMIT,
  INVENTORY_PAIR_LIMIT,
  INVENTORY_TRUNCATION_REASON,
  optionalBoolean,
  optionalContainerList,
  optionalStringArray,
  PAIR_TRUNCATION_REASON,
  resolveKinds,
  type ObjectInventory,
} from "@/lib/api/object-route";
import { enumerateContainers } from "@/lib/db/container-walk";
import type { DatabaseObject, ObjectDetail } from "@/lib/db/types";

export const dynamic = "force-dynamic";

/**
 * The bulk inventory the agent, the diagram and the schema diff read (#789).
 *
 * A separate surface from the tree on purpose: conflating the two is what made a user browsing
 * 43,512 objects pay for the complete inventory only the agent wanted.
 *
 * Both limits are constants in `src/lib/api/object-route.ts` and neither is a caller parameter, so
 * no caller can ask for an unbounded read, and `truncated` is part of the contract rather than a
 * courtesy: a saturated slice handed over as a complete inventory makes its reader treat a missing
 * table as an absent one, which is the class of defect #414 measured against the agent.
 *
 * WHAT IS AND IS NOT BOUNDED, precisely, because an earlier version of this comment overstated it.
 * Bounded: the number of listings issued (`INVENTORY_PAIR_LIMIT`) and the number of objects
 * returned (`INVENTORY_LIMIT`).
 *
 * NOT bounded, and there are two of them. One listing: the loop awaits the whole array
 * `listObjects` answers before it can truncate anything, so a single kind holding 43,000 objects is
 * fully materialised in the provider and in this process whatever these limits say. Bounding that
 * needs a limit argument on the provider method itself, which is not something this route can do
 * from the outside; it is Task 24's open item, alongside bulk column reading.
 *
 * And the CONTAINER ENUMERATION, which neither limit reaches. `enumerateContainers` walks every
 * level before the first pair exists: one `listContainers()` at the top, then one call per parent
 * at every level below, so a two-level engine with 5,000 catalogs issues 5,001 round trips and only
 * then meets `INVENTORY_PAIR_LIMIT`. The pair limit truncates the SCAN, never the walk. Bounding
 * the walk belongs in `container-walk.ts`, which the agent's grounding inventory shares, so it is
 * one decision for both readers rather than a cap invented here. Filed rather than guessed at (#789).
 *
 * `includeColumns` is back, and it is a DIFFERENT read from the one that was removed. The first
 * spelling called `describeObject` once per object, up to 5000 sequential round trips, and was
 * taken out as an N+1 this epic should not ship. This one calls `describeObjects` once per
 * container-and-kind PAIR: the same pairs the listing loop already walks, bounded by the same
 * `INVENTORY_PAIR_LIMIT`, so asking for columns at most doubles the round trips rather than
 * multiplying them by the object count. It exists because the flat schema reading that used to
 * carry columns is gone, and the object browser, the diagram, the docs page and the schema diff
 * all draw columns.
 *
 * The per-read bound handed to `describeObjects` is what is left of the object budget, so a
 * provider cannot return more detail than this route is willing to carry, and a provider that
 * bounded its own read says so in its own `truncated` - which is joined into this answer, because
 * a short column read is exactly as much a bounded inventory as a short listing.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/inventory", async (provider, body): Promise<ObjectInventory> => {
    const kinds = resolveKinds(provider, optionalStringArray(body, "kinds"));
    const named = optionalContainerList(body, "containers");
    named?.forEach((container) => assertContainerDepth(provider, "containers", container));

    // Deduplicated before the fan-out is built, not after: a repeated container costs one full
    // listing round trip per kind, and a body may name the same one any number of times.
    //
    // The enumeration also answers which container the SESSION is in, off the same walk and at
    // no extra round trip. A body that NAMED its containers skips the walk, so there is no
    // default to report and none is invented (#789).
    const enumerated = named === undefined ? await enumerateContainers(provider) : { containers: named };
    const containers = dedupePaths(enumerated.containers);
    const listObjects = provider.listObjects.bind(provider);

    // Flattened to one loop so each limit is checked in one place. Nested loops would need a label
    // to leave both, and the outer check would otherwise re-enter for every later container.
    //
    // The scan below is sequential, and the `no-await-in-loop` warning is accepted for it: a
    // `Promise.all` would take one pool client per pair, and it could not stop at either limit,
    // which is the whole point of the bounds.
    const pairs = containers.flatMap((container) => kinds.map((kind) => ({ container, kind: kind.id })));
    const scanned = pairs.slice(0, INVENTORY_PAIR_LIMIT);

    // Reported the same way an object overflow is, rather than as a 400, and the choice matters for
    // the enumerated case: an engine that genuinely has more containers than this is not a caller
    // mistake, and refusing to answer it at all is worse than answering part of it and saying so.
    // One answer shape for "this inventory is incomplete" is also the only thing its reader, the
    // agent, has to handle.
    const pairBound: ObjectInventory["truncated"] =
      pairs.length > scanned.length ? { limit: INVENTORY_PAIR_LIMIT, reason: PAIR_TRUNCATION_REASON } : undefined;
    /** Set when the object budget ran out, which is the bound the caller can see for itself. */
    let objectBound: ObjectInventory["truncated"];
    /** The provider's own bound on a column read, in the provider's own words. */
    let columnBound: ObjectInventory["truncated"];

    const includeColumns = optionalBoolean(body, "includeColumns");
    const describeObjects = provider.describeObjects.bind(provider);

    const objects: DatabaseObject[] = [];
    const details: ObjectDetail[] = [];
    for (const pair of scanned) {
      if (objects.length >= INVENTORY_LIMIT) {
        objectBound = { limit: INVENTORY_LIMIT, reason: INVENTORY_TRUNCATION_REASON };
        break;
      }
      const before = objects.length;
      for (const object of await listObjects(pair.container, pair.kind)) {
        if (objects.length >= INVENTORY_LIMIT) {
          objectBound = { limit: INVENTORY_LIMIT, reason: INVENTORY_TRUNCATION_REASON };
          break;
        }
        objects.push(object);
      }
      // Only for a pair that actually named something, and bounded by what is left of the object
      // budget: describing a folder this read already had to cut short would buy columns for
      // objects the caller is not being given.
      if (includeColumns && objects.length > before) {
        const batch = await describeObjects(pair.container, pair.kind, objects.length - before);
        details.push(...batch.details);
        // The provider's own bound, kept in the provider's own words. It is reported even when the
        // listing above fitted, because a complete list of objects whose columns were cut is still
        // an incomplete answer, and a reader that trusted it would read a missing column as an
        // absent one. The LAST one wins among column bounds: they are all the same statement about
        // the same read, and only the precedence below decides whether any of them is reported.
        if (batch.truncated !== undefined) columnBound = batch.truncated;
      }
    }

    /**
     * Which bound is REPORTED when more than one bit, in one expression rather than by whichever
     * assignment ran last (#789).
     *
     * A missing OBJECT outranks a missing COLUMN, and the reason is what the reader does with the
     * answer: the agent treats an object it was not shown as an object the database does not hold
     * (#414), while a short column read still names every object it holds. So the object limit
     * first, because it is the one the caller can see reflected in `objects.length`; then the pair
     * limit, which also means objects are missing, whole containers and kinds of them; then the
     * provider's own column bound, which costs columns only.
     *
     * Either way the answer says the inventory is incomplete, which is the one thing a reader must
     * act on; the precedence decides only which sentence explains it.
     */
    const truncated = objectBound ?? pairBound ?? columnBound;

    // `truncated` is reported when a limit lands exactly on a boundary with work still unread: what
    // was not scanned cannot be claimed as absent, and over-reporting incompleteness is the only
    // safe direction here. Both optional fields are SPREAD rather than assigned `undefined`, since
    // an omitted key and an explicit `undefined` are the same bytes on the wire and a reader
    // testing `"defaultContainer" in body` must see the absence.
    const { defaultContainer } = enumerated;
    return {
      objects,
      ...(includeColumns ? { details } : {}),
      ...(truncated === undefined ? {} : { truncated }),
      ...(defaultContainer === undefined ? {} : { defaultContainer }),
    };
  });
}
