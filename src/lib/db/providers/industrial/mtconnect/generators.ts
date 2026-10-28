/**
 * The MTConnect dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`.
 */
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/** The device's `current`, with the clicked item named in a comment where the path holds one. */
function mtconnectCurrentRequest(path: readonly string[]): string {
  const device = path[0];
  if (device === undefined || device === "") {
    return "# A request names a device from the tree.\nGET /current";
  }
  const item = path.length > 1 ? path[path.length - 1] : undefined;
  const route = `GET /${encodeURIComponent(device)}/current`;
  return item === undefined ? route : `# ${item}: one row of this answer\n${route}`;
}

/**
 * MTConnect writes one request line, the route MEASURED to answer the clicked row.
 *
 * A path is `[device]` for a device and `[device, dataItemId]` for an item under it, and the route
 * that answers either is the device's `current`: one row per observation of that device, the
 * clicked item's among them. The item is named in a comment above the line rather than written
 * into a `path=` filter, because the filter would be an XPath predicate on `@id` and THAT WAS NOT
 * MEASURED: `@type` and `@category` predicates were run against the pinned agent and answered 200,
 * an `@id` one was not, and a generator is not the place to find out. The comment marker is the
 * dialect's own `#`, which the provider's guard drops before it reads the route.
 *
 * `offersCodeGeneration: false`, so `select` is never drawn; it answers the same line as `table`
 * rather than a sentence, because the line is correct wherever it lands.
 */
export const MTCONNECT_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path: readonly string[]) => mtconnectCurrentRequest(path),
  select: (path: readonly string[]) => mtconnectCurrentRequest(path),
});
