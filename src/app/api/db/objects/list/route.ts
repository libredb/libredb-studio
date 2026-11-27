import { NextRequest } from "next/server";
import { assertContainerAddress, handleObjectRequest, requireString, requireStringArray } from "@/lib/api/object-route";
import { objectTree } from "@/lib/api/object-tree";
import { providerTreeTarget } from "@/lib/api/session-target";

export const dynamic = "force-dynamic";

/**
 * The objects of one kind in one container, names only (#789).
 *
 * A kind the engine's object model does not state is not pre-checked here: the host core refuses it
 * before any call, as Studio's own refusal with outcome not-sent (`StudioObjectModelRefusal`,
 * docs/providers/CONTRACT.md, clause M-89), so no provider is asked for it, and a second check of
 * kind ids in this route would be a second place for that rule to drift.
 *
 * The listing is a host core tree call (`objectTree`, src/lib/api/object-tree.ts), under its own deadline and the
 * request's signal.
 *
 * The listing runs on the connection's metadata session (`{ session: "metadata" }`), beside the editor's, so it never
 * waits for the editor's statements, except on a connection that serves one session (docs/providers/CONTRACT.md,
 * clause C-66).
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(
    req,
    "api/db/objects/list",
    async (provider, body, context) => {
      const container = requireStringArray(body, "container");
      const kind = requireString(body, "kind");
      const tree = objectTree(providerTreeTarget(provider), req.signal, context.route);
      assertContainerAddress(tree.objectModel, provider.type, "container", container);
      return tree.listObjects(container, kind);
    },
    { session: "metadata" },
  );
}
