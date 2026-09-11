/**
 * Expansion state to a flat list of rows, each carrying its own ARIA position (#789).
 *
 * Pure and DOM-free on purpose. The W3C tree pattern requires `aria-setsize` and
 * `aria-posinset` on every node exactly when the full node set is not in the DOM, which
 * is what virtualisation does, and none of react-window, react-virtuoso or TanStack
 * Virtual supplies them. Computing them in the row component would compute them from
 * what is currently mounted, which is the one thing that is wrong under a window. They
 * are computed here, per sibling group, before any row of that group is emitted, and the
 * row component takes all four numbers verbatim.
 */
import { isCountUnavailable } from "@/lib/db/object-kinds";
import type { Container, ContainerLevelSpec, DatabaseObject, KindCount, ObjectKindSpec } from "@/lib/db/types";

/**
 * One visible row.
 *
 * `id` is the path segments joined with `/`, plus the kind id on a folder and on an
 * object. Path alone is not an identity: paths are unique within a kind and deliberately
 * not across kinds, because at least one engine lets a table and a routine share a name
 * in one schema. Appending the kind is what keeps those two rows apart, and it is also
 * why a folder id can never collide with an object id under it: an object's path is
 * always strictly longer than the container path its folder hangs under.
 */
export interface TreeRowModel {
  readonly id: string;
  readonly kind: "container" | "folder" | "object";
  /**
   * What a person reads. A container's own name, the engine's plural for a folder, and
   * `DatabaseObject.name` for an object, which is NOT the last path segment: an
   * overloaded routine is addressed as `order_total(integer)` and labelled
   * `order_total`.
   */
  readonly label: string;
  /** `aria-level` is depth + 1. */
  readonly depth: number;
  /** `aria-setsize` among its own siblings, not among the visible rows. */
  readonly setSize: number;
  /** `aria-posinset`, 1-based. */
  readonly posInSet: number;
  /** Absent on a leaf, so `aria-expanded` is rendered only where it means something. */
  readonly expanded?: boolean;
  /** A formatted count from `countObjects`, never a loaded list's length. */
  readonly badge?: string;
  /** The engine's own sentence for a read it refused. */
  readonly unavailable?: string;
  /** The container path for a container and a folder, the object path for an object. */
  readonly path: readonly string[];
  /** Folder and object rows only. */
  readonly kindId?: string;
}

/**
 * Everything the walk reads. The three maps are keyed by row id, which is what lets the
 * caller cache per node without a second addressing scheme.
 *
 * A missing key and an empty array are different states and stay different: `objects`
 * holding no key for a folder means its contents have not been fetched, while holding
 * `[]` means the folder was fetched and is empty. Collapsing the two is what makes a
 * tree show a spinner forever or an empty folder wrongly.
 */
export interface FlattenTreeState {
  /** Every kind the provider declares, in declaration order, which is the folder order. */
  readonly kinds: readonly ObjectKindSpec[];
  /** Every container known so far, at every level, as a flat list addressed by `path`. */
  readonly containers: readonly Container[];
  /** Row ids the user has opened. */
  readonly expanded: ReadonlySet<string>;
  /** `countObjects` answers, keyed by the container path joined with `/`. */
  readonly counts: Readonly<Record<string, Record<string, KindCount>>>;
  /** `listObjects` answers, keyed by folder row id. */
  readonly objects: Readonly<Record<string, readonly DatabaseObject[]>>;
  /**
   * The provider's `containerLevels`, which decides where the kind folders sit.
   *
   * Absent means one level, which is the shape of seven engines and of every fixture
   * that predates this field. Five engines have no container at all (sqlite, libsql,
   * elasticsearch, opensearch, libredb) and pass `[]`, which puts the kind folders
   * themselves at the root under the empty container path. Five have two (postgres's
   * catalog level is not one of them: a connection pins the database), and there the
   * catalogs hold schemas and only the schemas hold folders.
   *
   * It has to be declared rather than inferred from the loaded containers: a catalog
   * whose schemas have not been fetched yet is indistinguishable from a leaf container
   * that holds objects, and guessing wrong draws folders that address nothing.
   */
  readonly containerLevels?: readonly ContainerLevelSpec[];
}

/**
 * A depth-first walk from a virtual root: containers, nested as deep as the engine
 * declares, then each leaf container's declared kinds in declaration order, then the
 * loaded objects of an expanded folder, then whatever an object's kind declares as its
 * own children.
 */
export function flattenTree(state: FlattenTreeState): readonly TreeRowModel[] {
  const rows: TreeRowModel[] = [];
  appendContainerChildren(state, rows, [], -1);
  return rows;
}

/** One pending row of a container's child group, built in full before any of it is emitted. */
type ContainerChild = { readonly container: Container } | { readonly spec: ObjectKindSpec };

/**
 * The rows one container level down, as ONE sibling group.
 *
 * Child containers and kind folders are counted together before either is emitted. A
 * consistent declaration never produces both at the same depth, since only the deepest
 * container level carries folders, but a row's `aria-setsize` has to describe the group
 * that is actually rendered rather than the group that was expected.
 *
 * The virtual root is `parentDepth === -1`, so an engine declaring zero container levels
 * satisfies `depth >= levels` immediately and its folders are the top group. That is the
 * same rule the deeper levels use and not a special case.
 */
function appendContainerChildren(
  state: FlattenTreeState,
  rows: TreeRowModel[],
  parentPath: readonly string[],
  parentDepth: number,
): void {
  const depth = parentDepth + 1;
  const levels = state.containerLevels?.length ?? 1;
  const children: readonly ContainerChild[] = [
    ...state.containers
      .filter((candidate) => isChildPath(parentPath, candidate.path))
      .map((container) => ({ container })),
    ...(depth >= levels ? state.kinds.map((spec) => ({ spec })) : []),
  ];

  children.forEach((child, index) => {
    if ("container" in child) appendContainer(state, rows, child.container, depth, children.length, index + 1);
    else appendFolder(state, rows, parentPath, child.spec, depth, children.length, index + 1);
  });
}

/**
 * Parentage is read off the path and not off `Container.level`, which carries the same
 * fact: a level-1 container is addressed `[catalog, schema]`, so its level is its path
 * length minus one. The path is already the row id, the counts key and the lookup key,
 * and giving one fact a second source is how the two drift.
 */
function isChildPath(parentPath: readonly string[], path: readonly string[]): boolean {
  return path.length === parentPath.length + 1 && parentPath.every((segment, index) => segment === path[index]);
}

function appendContainer(
  state: FlattenTreeState,
  rows: TreeRowModel[],
  container: Container,
  depth: number,
  setSize: number,
  posInSet: number,
): void {
  const id = container.path.join("/");
  const expanded = state.expanded.has(id);
  rows.push({
    id,
    kind: "container",
    label: container.name,
    depth,
    setSize,
    posInSet,
    expanded,
    path: container.path,
  });
  if (expanded) appendContainerChildren(state, rows, container.path, depth);
}

/**
 * A folder is drawn because the provider DECLARED the kind, never because a count
 * answered for it. The three states of `KindCount` are three different facts: an
 * undeclared kind has no folder at all, `{ count: 0 }` draws a zero badge, and a refused
 * read carries the engine's own sentence. A container whose counts have not arrived yet
 * therefore shows all of its folders with no badge, rather than growing them one at a
 * time as numbers land.
 *
 * A refused folder is a LEAF. Its contents were not merely unread, the engine declined
 * to answer for them, so offering a twisty that opens on nothing would turn a refusal
 * into an empty folder.
 */
function appendFolder(
  state: FlattenTreeState,
  rows: TreeRowModel[],
  parentPath: readonly string[],
  spec: ObjectKindSpec,
  depth: number,
  setSize: number,
  posInSet: number,
): void {
  const id = [...parentPath, spec.id].join("/");
  const { badge, unavailable } = formatCount(state.counts[parentPath.join("/")]?.[spec.id]);
  const expanded = unavailable === undefined ? state.expanded.has(id) : undefined;
  rows.push({
    id,
    kind: "folder",
    label: spec.labelPlural,
    depth,
    setSize,
    posInSet,
    expanded,
    badge,
    unavailable,
    path: parentPath,
    kindId: spec.id,
  });
  if (expanded === true) appendObjects(state, rows, id, depth);
}

/** `en-US` and not the viewer's locale, so a folder badge reads the same in every test and every screenshot. */
function formatCount(count: KindCount | undefined): { readonly badge?: string; readonly unavailable?: string } {
  if (count === undefined) return {};
  if (isCountUnavailable(count)) return { unavailable: count.unavailable };
  return { badge: count.count.toLocaleString("en-US") };
}

function appendObjects(state: FlattenTreeState, rows: TreeRowModel[], folderId: string, folderDepth: number): void {
  const objects = state.objects[folderId] ?? [];
  objects.forEach((object, index) => appendObject(state, rows, object, folderDepth + 1, objects.length, index + 1));
}

/**
 * Expandability comes from the DECLARATION and never from what happens to be cached: a
 * row that reads as a leaf until its own contents arrive can never be opened to fetch
 * them. So an object is expandable exactly when its kind declares `childKinds` that this
 * provider also declares in full, an Oracle package holding procedures being the case
 * this exists for, and it carries no badge of its own because a row count is an estimate
 * on most engines while a badge is a count.
 */
function appendObject(
  state: FlattenTreeState,
  rows: TreeRowModel[],
  object: DatabaseObject,
  depth: number,
  setSize: number,
  posInSet: number,
): void {
  const id = [...object.path, object.kind].join("/");
  const childSpecs = childKindSpecs(state, object.kind);
  const expanded = childSpecs.length > 0 ? state.expanded.has(id) : undefined;
  rows.push({
    id,
    kind: "object",
    label: object.name,
    depth,
    setSize,
    posInSet,
    expanded,
    path: object.path,
    kindId: object.kind,
  });
  if (expanded === true) {
    childSpecs.forEach((spec, index) =>
      appendFolder(state, rows, object.path, spec, depth + 1, childSpecs.length, index + 1),
    );
  }
}

/**
 * `childKinds` names ids, and only the declaration carries the plural a folder is
 * labelled with, so a child id this provider does not declare draws nothing. An object
 * of a kind that is not declared at all is a leaf for the same reason.
 */
function childKindSpecs(state: FlattenTreeState, kindId: string): readonly ObjectKindSpec[] {
  const childIds = state.kinds.find((spec) => spec.id === kindId)?.childKinds ?? [];
  return childIds.map((id) => state.kinds.find((spec) => spec.id === id)).filter((spec) => spec !== undefined);
}
