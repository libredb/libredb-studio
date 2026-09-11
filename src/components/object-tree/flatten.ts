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
import { containerDepth, isCountSampled, isCountUnavailable } from "@/lib/db/object-kinds";
import type { Container, DatabaseObject, KindCount, ObjectKindSpec } from "@/lib/db/types";

/**
 * One visible row.
 *
 * `id` is the path segments ESCAPED and joined with `/` (see `pathKey`), plus the kind id
 * on a folder and on an object. Path alone is not an identity: paths are unique within a
 * kind and deliberately not across kinds, because at least one engine lets a table and a
 * routine share a name in one schema. Appending the kind is what keeps those two rows
 * apart, and it is also why a folder id can never collide with an object id under it: an
 * object's path is always strictly longer than the container path its folder hangs under.
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
  /**
   * A formatted count from `countObjects`, never a loaded list's length.
   *
   * A bounded count carries a trailing `+`, because it is a floor: see `formatCount`.
   */
  readonly badge?: string;
  /**
   * Why the badge is a floor, in the provider's own words, and ABSENT on an exact count.
   *
   * Absent rather than a generic sentence on purpose: a title on every badge would make
   * the two indistinguishable to the one reader who most needs them apart, somebody
   * hovering to find out whether the number can be trusted.
   */
  readonly badgeTitle?: string;
  /** The engine's own sentence for a read it refused. */
  readonly unavailable?: string;
  /** The container path for a container and a folder, the object path for an object. */
  readonly path: readonly string[];
  /** Folder and object rows only. */
  readonly kindId?: string;
}

/**
 * Everything the walk reads. The two maps are keyed by row id, which is what lets the
 * caller cache per node without a second addressing scheme.
 */
export interface FlattenTreeState {
  /** Every kind the provider declares, in declaration order, which is the folder order. */
  readonly kinds: readonly ObjectKindSpec[];
  /** Every container known so far, at every level, as a flat list addressed by `path`. */
  readonly containers: readonly Container[];
  /** Row ids the user has opened. */
  readonly expanded: ReadonlySet<string>;
  /** `countObjects` answers, keyed by `pathKey` of the container path, so the root is `""`. */
  readonly counts: Readonly<Record<string, Record<string, KindCount>>>;
  /**
   * `listObjects` answers, keyed by folder row id.
   *
   * A missing key and an empty array are different states in here and the caller must keep
   * them apart: no key means the folder has not been fetched, `[]` means it was fetched and
   * is empty. They are NOT distinguishable in the output, since both render as a folder with
   * no child rows, so a spinner or an empty-folder message can only come from the cache that
   * owns this map.
   */
  readonly objects: Readonly<Record<string, readonly DatabaseObject[]>>;
  /**
   * How many container levels this engine nests its objects in, which decides where the
   * kind folders sit.
   *
   * Pass what `containerDepth()` in `src/lib/db/object-kinds.ts` answered for this
   * provider, which is why the type is that function's return type: `containerLevels` on
   * `ProviderCapabilities` says in its own doc to be read through that helper and never by
   * length, so that an absent declaration and an empty one cannot be answered differently
   * by two callers. `src/lib/api/object-route.ts` reads the same helper for the routes that
   * fill this state, and 0 there means one container whose path is empty, which is exactly
   * what 0 draws here.
   *
   * Required rather than defaulted. A default would be this module answering the question
   * the helper exists to answer, and the engines it would answer wrongly are the ones that
   * declare nothing: the per-engine inventory is on issue #789.
   *
   * It has to come from the declaration rather than be inferred from the loaded containers:
   * a catalog whose schemas have not been fetched yet is indistinguishable from a leaf
   * container that holds objects, and guessing wrong draws folders that address nothing.
   */
  readonly containerDepth: ReturnType<typeof containerDepth>;
}

/**
 * A depth-first walk from a virtual root: containers, nested as deep as the engine
 * declares, then each leaf container's declared kinds in declaration order, then the
 * loaded objects of an expanded folder. Objects are leaves, for the reason
 * `appendObject` records.
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
 * The virtual root is `parentDepth === -1`, so an engine whose declared container depth is
 * 0 satisfies the depth test immediately and its folders are the top group, hanging under
 * the empty container path. That is the same rule the deeper levels use and not a special
 * case, and it is the shape `enumerateContainers` in `src/lib/api/object-route.ts` already
 * answers for those engines.
 */
function appendContainerChildren(
  state: FlattenTreeState,
  rows: TreeRowModel[],
  parentPath: readonly string[],
  parentDepth: number,
): void {
  const depth = parentDepth + 1;
  const children: readonly ContainerChild[] = [
    ...state.containers
      .filter((candidate) => isChildPath(parentPath, candidate.path))
      .map((container) => ({ container })),
    ...(depth >= state.containerDepth ? state.kinds.map((spec) => ({ spec })) : []),
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

/**
 * A sequence of segments as ONE string, injectively: distinct sequences give distinct
 * keys, whatever the engine allows inside an identifier.
 *
 * This is the single encoder behind every id and every cache key in the tree, and it has
 * to be injective because a plain join is not. `a/b` is a legal quoted identifier on
 * PostgreSQL, MySQL and Oracle, and joining raw gave the container `["a/b"]` and the
 * `b` folder of container `["a"]` one string, so one row's twisty opened the other and
 * React warned about duplicate keys (#789). The same collision reached the counts cache,
 * where a two-level engine addresses `["a/b", "c"]` and `["a", "b/c"]` identically.
 *
 * The escape is percent-style and the ESCAPE CHARACTER IS ESCAPED FIRST, which is what
 * makes it injective rather than merely different in the reported case: without the first
 * replacement a container named `a%2Fb` would encode onto `a/b`'s key. Doubling the
 * separator instead would not work either, since `["a/", "b"]` and `["a", "/b"]` both
 * give `a///b`.
 *
 * Not `encodeURIComponent`, which throws `URIError` on a lone surrogate: a name arriving
 * from a driver is not guaranteed to be well-formed UTF-16, and a throw inside the walk
 * unmounts the whole tree rather than degrading one row. Not `JSON.stringify` either:
 * standing ruling 5g refuses it for path keys, and it would rewrite every ordinary id.
 *
 * An ordinary identifier holds neither character, so the common id is unchanged and still
 * readable: `app`, `app/table`, `app/orders/table`.
 */
export function pathKey(path: readonly string[]): string {
  return path.map((segment) => segment.replaceAll("%", "%25").replaceAll("/", "%2F")).join("/");
}

/**
 * A container row's id, which is the one thing a caller may need to name a row it has
 * not seen rendered yet.
 *
 * Exported because the tree's cache has to be able to OPEN a container the moment its
 * listing lands, before any row exists: `Container.isSessionDefault` is answered by the
 * engine and the active container is expanded on first paint (#789). The rule lives
 * here, beside the walk that emits the row, so the cache cannot hold a second copy of
 * it that drifts.
 *
 * A container row addresses exactly its path, so its id IS that path's key.
 */
export function containerRowId(path: readonly string[]): string {
  return pathKey(path);
}

function appendContainer(
  state: FlattenTreeState,
  rows: TreeRowModel[],
  container: Container,
  depth: number,
  setSize: number,
  posInSet: number,
): void {
  const id = containerRowId(container.path);
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
 * answered for it. The four states of `KindCount` are four different facts: an undeclared
 * kind has no folder at all, `{ count: 0 }` draws a zero badge, a refused read carries the
 * engine's own sentence, and `{ count, sampledFrom }` draws a bounded number. All four are
 * spelled out where they are rendered, in `formatCount` below. A container whose counts
 * have not arrived yet therefore shows all of its folders with no badge, rather than
 * growing them one at a time as numbers land.
 *
 * A refused folder is a LEAF. Its contents were not merely unread, the engine declined
 * to answer for them, so offering a twisty that opens on nothing would turn a refusal
 * into an empty folder. Every other folder is expandable whether or not its objects are
 * cached: a row that reads as a leaf until its contents arrive can never be opened to
 * fetch them.
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
  const id = pathKey([...parentPath, spec.id]);
  const { badge, badgeTitle, unavailable } = formatCount(state.counts[pathKey(parentPath)]?.[spec.id]);
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
    badgeTitle,
    unavailable,
    path: parentPath,
    kindId: spec.id,
  });
  if (expanded === true) appendObjects(state, rows, id, depth);
}

/**
 * One `KindCount` as the two strings a row can show, and the fourth state is why this is not
 * one line.
 *
 * `en-US` and not the viewer's locale, so a folder badge reads the same in every test and
 * every screenshot.
 *
 * A BOUNDED count is badged with a trailing `+` and nothing else: `1,204+`. The mark is in
 * the badge TEXT rather than in a colour, an icon or a title alone, because the badge text is
 * the only part of this row a screen reader reads out and a person scanning a column of
 * numbers sees. It reads as a floor in the same way a search result count does, which is the
 * fact: the provider counted what a capped read saw, so the engine holds AT LEAST this many.
 * `0+` is deliberate too, and it is not the same row as `0`: a bounded walk that saw nothing
 * has not proved the container is empty, and `{ count: 0 }` is exactly the claim that it is.
 *
 * The explanation goes in `badgeTitle`, never in the badge, because a badge column has room
 * for a number and the provider's sentence is a sentence. That leaves all four facts distinct
 * at a glance: no folder at all, `0`, the engine's refusal sentence in place of a number, and
 * a number with a `+`.
 */
function formatCount(count: KindCount | undefined): {
  readonly badge?: string;
  readonly badgeTitle?: string;
  readonly unavailable?: string;
} {
  if (count === undefined) return {};
  if (isCountUnavailable(count)) return { unavailable: count.unavailable };
  const badge = count.count.toLocaleString("en-US");
  if (!isCountSampled(count)) return { badge };
  return { badge: `${badge}+`, badgeTitle: `At least ${badge}: counted from ${count.sampledFrom}` };
}

function appendObjects(state: FlattenTreeState, rows: TreeRowModel[], folderId: string, folderDepth: number): void {
  const objects = state.objects[folderId] ?? [];
  objects.forEach((object, index) => appendObject(rows, object, folderDepth + 1, objects.length, index + 1));
}

/**
 * An object row is a LEAF, and that holds even for a kind that declares `childKinds`.
 *
 * The declaration is true: an Oracle package really does hold routines. What is missing is
 * a way to fill that folder. Both listing methods are container-scoped,
 * `countObjects(container)` and `listObjects(container, kind)`, and nothing on the
 * provider surface lists the children of one OBJECT, so a package's Procedures folder
 * would draw, never badge, and open on nothing. Inventing an object-scoped method across
 * every engine before the consumer that needs it exists is what this epic declined to do,
 * so the nesting lands with that method and not before. Tracked on issue #789.
 *
 * No badge either: `DatabaseObject.rowCount` is an estimate on most engines and a badge is
 * a count.
 */
function appendObject(
  rows: TreeRowModel[],
  object: DatabaseObject,
  depth: number,
  setSize: number,
  posInSet: number,
): void {
  rows.push({
    id: pathKey([...object.path, object.kind]),
    kind: "object",
    label: object.name,
    depth,
    setSize,
    posInSet,
    path: object.path,
    kindId: object.kind,
  });
}
