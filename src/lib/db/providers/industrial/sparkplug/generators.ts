/**
 * The Sparkplug dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`.
 */
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/**
 * The read request for a clicked path: group, then edge node, then device, as far as the path goes.
 *
 * The window and the row limit are left out rather than written with their defaults: a number a user
 * did not choose, printed in the console they are about to run, reads as a measurement of something.
 */
function sparkplugReadRequest(path: readonly string[]): string {
  const [group, edgeNode, device] = path;
  const request: Record<string, string> = {};
  if (group !== undefined && group !== "") request.group = group;
  if (edgeNode !== undefined && edgeNode !== "") request.edgeNode = edgeNode;
  if (device !== undefined && device !== "") request.device = device;
  return JSON.stringify(request, null, 2);
}

/**
 * A tree click writes the read request for what was clicked, which is a JSON object rather than a statement: a
 * Sparkplug read names a group, an edge node and a device and takes a window, and there is nothing to compose. The
 * deeper the click the narrower the read, and a click on nothing reads every group, which is what an empty request
 * means.
 */
export const SPARKPLUG_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path: readonly string[]) => sparkplugReadRequest(path),
  select: (path: readonly string[]) => sparkplugReadRequest(path),
});
