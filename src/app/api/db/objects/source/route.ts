import { NextRequest } from "next/server";
import {
  boundSourceDocument,
  handleObjectRequest,
  requireObjectPath,
  requireSourceReader,
  requireString,
} from "@/lib/api/object-route";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";

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
 * No depth check, for the reason `describe/route.ts` gives: this is an object path, not a
 * container path, and how deep a kind nests is a per-kind fact the provider's declaration carries.
 * Two engines have a kind at mixed depth.
 *
 * `limit` is NOT accepted from the caller in Phase 2 and the route always passes
 * `SOURCE_CHARACTER_LIMIT`. The argument exists on the provider method because that is where a
 * bound belongs and because the conformance helper drives the bounded arm with a small number. An
 * unused request field would be a second way to reach one behaviour. The route then applies the
 * same bound to the ANSWER rather than trusting it: a number passed to an implementation outside
 * our compiler, which the embedded seam's host is, is a request and not a bound.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(req, "api/db/objects/source", async (provider, body) => {
    const path = requireObjectPath(body);
    const kind = requireString(body, "kind");
    const read = requireSourceReader(provider, kind);
    return boundSourceDocument(await read(path, kind, SOURCE_CHARACTER_LIMIT), SOURCE_CHARACTER_LIMIT);
  });
}
