import { NextRequest } from "next/server";
import { objectSource, sourceModel } from "@/lib/api/object-source";
import {
  handleObjectRequest,
  offeredSourceEdits,
  requireObjectPath,
  requireSourceReader,
  requireString,
} from "@/lib/api/object-route";
import { providerSourceTarget } from "@/lib/api/session-target";
import { scrubSourceDocument } from "@/lib/db/operations/provider-text";

export const dynamic = "force-dynamic";

/**
 * One object's definition text, as a document of named parts (#789 Phase 2).
 *
 * The seventh route under this prefix and the first one that can answer nothing: every other
 * object method is required on `DatabaseProvider`, while `readObjectSource` is optional because
 * two engines in the fleet hold no kind with a definition text anywhere. `requireSourceReader` is
 * where that gap becomes a refusal a caller can read, in one branch of two conjuncts.
 *
 * `kind` is required in the body, not optional and not inferred, for the reason
 * `describe/route.ts` gives and one more the research measured: on MySQL, MariaDB and DuckDB one
 * name addresses more than one object of different kinds in one container, so a path alone reads
 * the wrong object.
 *
 * The read is a contract call (docs/providers/CONTRACT.md, clause C-115): one host core source call
 * (`objectSource` in src/lib/api/object-source.ts) on the legacy bridge's session of the editor's
 * provider (`providerSourceTarget`), which offers `objects.source` exactly where the provider
 * defines `readObjectSource`. The core holds the request to the session's object model, so a path
 * deeper than the model admits for its kind is refused before any call as Studio's object model
 * refusal, 400, outcome not-sent; the depth below that bound is the provider's to read. The core
 * reads the answer once with `checkSourceAnswer` and cuts it with `boundSourceAnswer`, so the route
 * checks and cuts nothing of its own, and an answer that is not the source document of its request
 * is Studio's own defect, 500, for a legacy provider.
 *
 * `limit` is NOT accepted from the caller: the bridge passes `SOURCE_CHARACTER_LIMIT` to the
 * provider, as this route always did, and the core cuts any text past it whatever the provider
 * answered. An unused request field would be a second way to reach one behaviour.
 *
 * The read waits until the connection's statement timeout plus ten seconds from its start, and
 * until the request's signal, so a caller that leaves stops the wait; a failure after that is
 * logged by kind and code.
 *
 * Whether the kind has source, and whether its parts may be edited, is read from the object model
 * the session states (`sourceModel`), the one the core holds the read to (clause M-89). The
 * document is scrubbed of the provider's sentences, then the route decides the edit affordance
 * (`offeredSourceEdits`).
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/source", async (provider, body, context) => {
    const path = requireObjectPath(body);
    const kind = requireString(body, "kind");
    const target = providerSourceTarget(provider);
    requireSourceReader(target.session, provider.type, kind);
    const document = await objectSource(target, req.signal, context.route).read(path, kind);
    return offeredSourceEdits(scrubSourceDocument(context.scrub, document), sourceModel(target.session));
  });
}
