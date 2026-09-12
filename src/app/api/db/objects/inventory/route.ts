import { NextRequest } from "next/server";
import {
  assertContainerDepth,
  dedupePaths,
  handleObjectRequest,
  INVENTORY_LIMIT,
  INVENTORY_PAIR_LIMIT,
  INVENTORY_TRUNCATION_REASON,
  optionalContainerList,
  optionalStringArray,
  PAIR_TRUNCATION_REASON,
  resolveKinds,
  type ObjectInventory,
} from "@/lib/api/object-route";
import { enumerateContainers } from "@/lib/db/container-walk";
import type { DatabaseObject } from "@/lib/db/types";

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
 * returned (`INVENTORY_LIMIT`). NOT bounded: one listing. The loop awaits the whole array
 * `listObjects` answers before it can truncate anything, so a single kind holding 43,000 objects is
 * fully materialised in the provider and in this process whatever these limits say. Bounding that
 * needs a limit argument on the provider method itself, which is not something this route can do
 * from the outside; it is Task 24's open item, alongside bulk column reading.
 *
 * No `includeColumns`. It was implemented here as one `describeObject` per object, up to 5000
 * sequential round trips, which is an N+1 the epic should not ship, and the alternative is a fifth
 * bulk provider method invented across seventeen providers before any consumer has stated what it
 * needs. Task 24 owns re-introducing bulk column reading with a measured design once the agent's
 * grounding requirement is known.
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
    let truncated: ObjectInventory["truncated"] =
      pairs.length > scanned.length ? { limit: INVENTORY_PAIR_LIMIT, reason: PAIR_TRUNCATION_REASON } : undefined;

    const objects: DatabaseObject[] = [];
    for (const pair of scanned) {
      if (objects.length >= INVENTORY_LIMIT) {
        // Overwrites a pair-limit reason where both bit. The object limit is the one the reader can
        // see reflected in `objects.length`, so it is the one that explains what they are holding;
        // either way the answer says the inventory is incomplete, which is what a reader must act on.
        truncated = { limit: INVENTORY_LIMIT, reason: INVENTORY_TRUNCATION_REASON };
        break;
      }
      for (const object of await listObjects(pair.container, pair.kind)) {
        if (objects.length >= INVENTORY_LIMIT) {
          truncated = { limit: INVENTORY_LIMIT, reason: INVENTORY_TRUNCATION_REASON };
          break;
        }
        objects.push(object);
      }
    }

    // `truncated` is reported when a limit lands exactly on a boundary with work still unread: what
    // was not scanned cannot be claimed as absent, and over-reporting incompleteness is the only
    // safe direction here. Both optional fields are SPREAD rather than assigned `undefined`, since
    // an omitted key and an explicit `undefined` are the same bytes on the wire and a reader
    // testing `"defaultContainer" in body` must see the absence.
    const { defaultContainer } = enumerated;
    return {
      objects,
      ...(truncated === undefined ? {} : { truncated }),
      ...(defaultContainer === undefined ? {} : { defaultContainer }),
    };
  });
}
