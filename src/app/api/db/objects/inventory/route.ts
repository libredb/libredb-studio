import { NextRequest } from "next/server";
import {
  assertContainerDepth,
  enumerateContainers,
  handleObjectRequest,
  INVENTORY_LIMIT,
  INVENTORY_TRUNCATION_REASON,
  optionalBoolean,
  optionalContainerList,
  optionalStringArray,
  requireMethod,
  resolveKinds,
  type InventoryObject,
  type ObjectInventory,
} from "@/lib/api/object-route";

export const dynamic = "force-dynamic";

/**
 * The bulk inventory the agent, the diagram and the schema diff read (#789).
 *
 * A separate surface from the tree on purpose: conflating the two is what made a user browsing
 * 43,512 objects pay for the complete inventory only the agent wanted.
 *
 * `INVENTORY_LIMIT` is a constant in this module and never a caller parameter, so no caller can
 * ask for an unbounded read, and `truncated` is part of the contract rather than a courtesy: a
 * saturated slice handed over as a complete inventory makes its reader treat a missing table as an
 * absent one, which is the class of defect #414 measured against the agent.
 *
 * The limit bounds the SCAN, not just the response. Once it is reached no further listing runs,
 * which is also why `truncated` is reported when the limit lands exactly on a pair boundary with
 * pairs still unread: what was not scanned cannot be claimed as absent, and over-reporting
 * incompleteness is the only direction that is safe here.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/inventory", async (provider, body): Promise<ObjectInventory> => {
    const includeColumns = optionalBoolean(body, "includeColumns");
    const kinds = resolveKinds(provider, optionalStringArray(body, "kinds"));
    const named = optionalContainerList(body, "containers");
    named?.forEach((container) => assertContainerDepth(provider, "containers", container));

    const containers = named ?? (await enumerateContainers(provider));
    const listObjects = requireMethod(provider, "listObjects");
    // Resolved before the first listing rather than at the first object, so a provider that cannot
    // describe refuses immediately instead of after up to 5000 listings.
    const describeObject = includeColumns ? requireMethod(provider, "describeObject") : undefined;

    // Flattened to one loop so the limit is checked in one place per level. Nested loops would need
    // a label to leave both, and the outer check would otherwise re-enter for every later container.
    //
    // The scan below is sequential, and the `no-await-in-loop` warning is accepted for it: a
    // `Promise.all` would take one pool client per pair, and it could not stop at the limit either,
    // which is the whole point of the bound.
    const pairs = containers.flatMap((container) => kinds.map((kind) => ({ container, kind: kind.id })));

    const objects: InventoryObject[] = [];
    let truncated = false;
    for (const pair of pairs) {
      if (objects.length >= INVENTORY_LIMIT) {
        truncated = true;
        break;
      }
      for (const object of await listObjects(pair.container, pair.kind)) {
        if (objects.length >= INVENTORY_LIMIT) {
          truncated = true;
          break;
        }
        objects.push(
          describeObject === undefined
            ? object
            : { ...object, columns: (await describeObject(object.path, pair.kind)).columns },
        );
      }
    }

    return truncated
      ? { objects, truncated: { limit: INVENTORY_LIMIT, reason: INVENTORY_TRUNCATION_REASON } }
      : { objects };
  });
}
