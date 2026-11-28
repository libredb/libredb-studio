import { NextRequest } from "next/server";
import { assertContainerDepth, handleObjectRequest, optionalStringArray } from "@/lib/api/object-route";
import { objectTree } from "@/lib/api/object-tree";

export const dynamic = "force-dynamic";

/**
 * The containers under `parent`, or the top level when `parent` is absent (#789).
 *
 * The depth check runs before the provider is called: a parent deeper than the engine declares
 * addresses a level the provider has no way to resolve, so it is a caller bug and a 400, not an
 * engine error. A parent exactly at the declared depth is passed through, because "this level has
 * no children" is a true answer an engine is allowed to give.
 *
 * The listing is a host core tree call (`objectTree`, src/lib/api/object-tree.ts), under its own deadline and the
 * request's signal.
 *
 * The listing runs on the record's metadata session (`{ reads: "tree" }`), a provider package's through its package,
 * beside the editor's, so it never waits for the editor's statements, except on a connection that serves one session
 * (docs/providers/CONTRACT.md, clause C-66).
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(
    req,
    "api/db/objects/containers",
    async (target, body, context) => {
      const parent = optionalStringArray(body, "parent");
      const tree = objectTree(target, req.signal, context.route);
      if (parent !== undefined) assertContainerDepth(tree.objectModel, context.engine.id, "parent", parent);
      return tree.listContainers(parent);
    },
    { reads: "tree" },
  );
}
