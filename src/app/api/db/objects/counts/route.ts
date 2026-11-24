import { NextRequest } from "next/server";
import { assertContainerAddress, handleObjectRequest, requireStringArray } from "@/lib/api/object-route";
import { objectTree } from "@/lib/api/object-tree";
import { scrubKindCounts } from "@/lib/db/operations/provider-text";

export const dynamic = "force-dynamic";

/**
 * Per-kind counts for one container: what the tree draws its folder badges from (#789).
 *
 * The four states of `KindCount` travel over the wire unchanged. A kind missing from the record
 * is a kind the engine does not declare, or one only the Keys panel enumerates
 * (`ObjectKindSpec.enumeratedBy`, #1089 3.4), which the provider leaves out;
 * `{ count: 0 }` is the engine answering none,
 * `{ unavailable }` carries the engine's own sentence for a refused read, and
 * `{ count, sampledFrom }` is a number the engine measured from a read that stopped short, so it
 * is a FLOOR rather than a total and the tree badges it with a trailing `+`. Collapsing any of
 * them into another here would be the defect this surface replaced, and the fourth is the one
 * most easily lost, because dropping `sampledFrom` leaves a number that still renders.
 *
 * The count is a host core tree call (`objectTree`, src/lib/api/object-tree.ts), under its own deadline and the
 * request's signal.
 *
 * The count runs on the connection's metadata session (`{ session: "metadata" }`), beside the editor's, so it never
 * waits for the editor's statements, except on a connection that serves one session (docs/providers/CONTRACT.md,
 * clause C-66).
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(
    req,
    "api/db/objects/counts",
    async (provider, body, context) => {
      const container = requireStringArray(body, "container");
      assertContainerAddress(provider, "container", container);
      return scrubKindCounts(
        context.scrub,
        await objectTree(provider, req.signal, context.route).countObjects(container),
      );
    },
    { session: "metadata" },
  );
}
