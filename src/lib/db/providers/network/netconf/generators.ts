/**
 * The NETCONF dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`.
 */
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/**
 * One JSON read request for the clicked node.
 *
 * A node's path is `[datastore, module, node]` - what `listObjects` builds in
 * `src/lib/db/providers/network/netconf/index.ts` - and that is what the console's own parser
 * needs: the datastore by name, and the node written `module:node`, the module-qualified form
 * `parsePathArgument` reads. The bound goes into the text because the type declares
 * `supportsExternalQueryLimiting: false`; the number written is the parser's own default, so the
 * line states what an omitted bound would have done rather than changing it.
 *
 * A shorter path names no node. No shipped row reaches that arm - every object row this provider
 * lists carries all three segments - so rather than inventing a datastore or a module it writes
 * the request with an empty path, which the console refuses BY NAME ("this request names no
 * path"). The alternative, filling in a plausible module, would read a node nobody clicked.
 *
 * `offersCodeGeneration: false`, so `select` is never drawn; it answers the same request as
 * `table` rather than a sentence, because the request is correct wherever it lands.
 */
function netconfReadRequest(path: readonly string[]): string {
  const datastore = path[0] ?? "";
  const moduleName = path[1];
  const node = path.length > 2 ? path[path.length - 1] : undefined;
  const addressed = moduleName === undefined || node === undefined ? "" : `${moduleName}:${node}`;
  return JSON.stringify({ datastore, path: addressed, limit: 1000 }, null, 2);
}

/** A tree click and Generate Query both write the one read request for the clicked node. */
export const NETCONF_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path: readonly string[]) => netconfReadRequest(path),
  select: (path: readonly string[]) => netconfReadRequest(path),
});
