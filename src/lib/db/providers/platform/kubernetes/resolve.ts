/**
 * kubectl's resource name resolution over the discovery index.
 *
 * `TYPE`, `TYPE.group` and `TYPE.version.group` (a `TYPE.v1.` form names the core group). Within the group and
 * version the text names, an exact plural or singular wins, compared without case; then a short name, compared with
 * case; then a kind, without case; then a category, with case, which answers every resource that declares it. Where
 * two resources match the same way, the first in discovery order wins, core before the groups, as kubectl's priority
 * order does. So `pods`, `Pod`, `PODS`, `po`, `deploy.apps` and `pod.v1.` resolve, and `PO`, `Deploy` and `ALL` do not.
 */
import type { IndexedResource, ResourceIndex } from "./discovery";

export type Resolution =
  | { readonly kind: "resource"; readonly resource: IndexedResource }
  | { readonly kind: "category"; readonly resources: readonly IndexedResource[] }
  | { readonly kind: "unknown" };

const VERSION = /^v[0-9]+((alpha|beta)[0-9]+)?$/;

interface Filter {
  readonly name: string;
  readonly group?: string;
  readonly version?: string;
}

/** The filters a text names, the fully specified one first, as kubectl tries it first. */
function filtersOf(text: string): readonly Filter[] {
  const parts = text.split(".");
  if (parts.length === 1) return [{ name: text }];
  const [name, second] = parts;
  const grouped: Filter = { name, group: parts.slice(1).join(".") };
  if (parts.length >= 3 && VERSION.test(second))
    return [{ name, version: second, group: parts.slice(2).join(".") }, grouped];
  return [grouped];
}

function inFilter(entry: IndexedResource, filter: Filter): boolean {
  return (
    (filter.group === undefined || entry.group === filter.group) &&
    (filter.version === undefined || entry.version === filter.version)
  );
}

function resolveIn(index: ResourceIndex, filter: Filter): IndexedResource | undefined {
  const candidates = index.resources.filter((entry) => inFilter(entry, filter));
  const lower = filter.name.toLowerCase();
  return (
    candidates.find((entry) => entry.resource === lower || entry.singular === lower) ??
    candidates.find((entry) => entry.shortNames.includes(filter.name)) ??
    candidates.find((entry) => entry.kind.toLowerCase() === lower)
  );
}

export function resolveResource(index: ResourceIndex, text: string): Resolution {
  if (text === "") return { kind: "unknown" };
  for (const filter of filtersOf(text)) {
    const resource = resolveIn(index, filter);
    if (resource !== undefined) return { kind: "resource", resource };
  }
  if (!text.includes(".")) {
    const resources = index.resources.filter((entry) => entry.categories.includes(text));
    if (resources.length > 0) return { kind: "category", resources };
  }
  return { kind: "unknown" };
}
