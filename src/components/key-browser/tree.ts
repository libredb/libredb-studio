/**
 * The key tree a sampled walk is drawn as.
 *
 * A KEY SPACE IS A FLAT NAMESPACE, AND THIS IS THE ONLY STRUCTURE IN IT. Redis and etcd store keys
 * as opaque bytes: `app:cache:user:1` is not a path, it is a sixteen-byte name that happens to
 * contain three colons, and the server does not know that `app:cache:user` is a prefix of it. So
 * everything below is an ARRANGEMENT of names the caller already holds rather than a reading of
 * anything. The folders exist because the engine's declaration says which string separates them,
 * `:` on Redis and `/` on etcd, read through `keyScanShape` (spec 3.4), and no command can be given
 * a folder to answer for.
 *
 * IT IS BUILT FROM A SAMPLE, NOT FROM A CATALOG. A walk that stopped at a batch holds some of the
 * keys; a folder's count is therefore the number of keys THAT WALK SAW under it, and a prefix
 * whose keys all arrived in a later batch does not appear at all. That is the honest shape for a
 * bounded walk, and the reason this module takes an iterable rather than promising a total.
 *
 * DUPLICATES ARE ABSORBED. `SCAN` promises that a key present for the whole walk is returned at
 * least once and says nothing about at most — a rehashing table hands the same key back twice — so
 * a caller feeding successive pages in has to be able to, and a count that double-counted a repeat
 * would make the tree disagree with the progress bar beside it.
 */
import { escapeGlob } from "@/lib/query-generators";
import { keyScanShape, type KeyScanShape } from "@/lib/db/types";

/**
 * The shape a helper below reads when its caller hands none: what `keyScanShape` answers for a
 * declaration that sets none of its four optional fields, which is Redis's walk and every call these
 * helpers had before the fields existed (spec 3.4).
 *
 * READ THROUGH THE HELPER RATHER THAN RESTATED, so the defaults have one home and cannot drift from
 * the ones the route and the panel read. The batch sizes play no part in a shape, so any pair does.
 */
const UNDECLARED: KeyScanShape = keyScanShape({ defaultCount: 1, maxCount: 1 });

/**
 * What separates one segment from the next on a walk that declares no separator: Redis's `:`.
 *
 * A DECLARATION NOW, NOT A CONSTANT OF THIS MODULE. The server has no opinion on it, and while Redis
 * was the only engine with a walk this module fixed it. etcd's convention is `/`, so the separator is
 * read from the engine's declaration through `keyScanShape` and handed to each helper below as part
 * of its shape; this is the one a helper reads when it is handed none.
 */
export const KEY_SEPARATOR = UNDECLARED.separator;

/**
 * A path's identity as a map key.
 *
 * `JSON.stringify` rather than a join because a segment may contain any byte, the separator
 * included: `["a:b"]` and `["a", "b"]` are two different prefixes, and a joined key would collide
 * them onto one node's state.
 */
export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export interface KeyTreeNode {
  /**
   * This node's own segment. The ROOT carries the empty string and is not drawn as a row. A key that
   * begins with the separator gives the level below it an empty segment too, and that node IS drawn:
   * it is the separator's own root row, `/*` on etcd (spec 4.6).
   */
  readonly segment: string;
  /** Every segment from the root to this node, so a caller never re-derives one. */
  readonly path: readonly string[];
  /** Child segments: folders first, then leaves, each group in collator order. */
  readonly children: readonly KeyTreeNode[];
  /**
   * How many DISTINCT scanned keys sit at or under this node.
   *
   * At or under, not directly under: a folder says how much is inside it, which is the number a
   * reader can act on. A key that also has children (`app` beside `app:env`) is both.
   */
  readonly count: number;
  /** True when a scanned key ends exactly here. */
  readonly isKey: boolean;
  /**
   * Present, and `true`, only on a node the SERVER named as a folder: a prefix of a level page
   * (Keys panel levels, spec 3.4). Absent on every other node, so a tree built without folders is
   * byte-identical to the tree before the field existed. A server folder is a folder before anything
   * under it is listed, because the server said it holds something.
   */
  readonly serverFolder?: true;
}

interface MutableNode {
  segment: string;
  path: string[];
  readonly children: Map<string, MutableNode>;
  count: number;
  isKey: boolean;
  serverFolder: boolean;
}

/**
 * Folders before leaves, then by segment.
 *
 * `Intl.Collator` rather than `<`, for two reasons. It answers the EQUAL case internally, and a
 * comparator written as two `<`/`>` branches has no truthful answer for two equal segments — a
 * branch that cannot run, in a tree whose siblings are unique by construction. And `numeric` is on
 * so `user:2` sorts before `user:10`, which is how a person reads a list of numbered keys and not
 * how a byte comparison does.
 */
const collator = new Intl.Collator("en", { numeric: true });

function compareNodes(left: KeyTreeNode, right: KeyTreeNode): number {
  const byFolders = Number(isFolder(right)) - Number(isFolder(left));
  return byFolders !== 0 ? byFolders : collator.compare(left.segment, right.segment);
}

/**
 * Whether a node is drawn as a folder: it holds rows, or the server named it a folder (Keys panel
 * levels, spec 3.4). A server folder with nothing listed yet is still a folder, because listing it is
 * what opening it does.
 */
export function isFolder(node: KeyTreeNode): boolean {
  return node.children.length > 0 || node.serverFolder === true;
}

function createNode(segment: string, path: string[]): MutableNode {
  return { segment, path, children: new Map(), count: 0, isKey: false, serverFolder: false };
}

/** The child of `node` named `segment`, created on first use, so both walks of `buildKeyTree` share one path. */
function childNode(node: MutableNode, segment: string): MutableNode {
  let child = node.children.get(segment);
  if (child === undefined) {
    child = createNode(segment, [...node.path, segment]);
    node.children.set(segment, child);
  }
  return child;
}

/**
 * The segments of one key name, split on the shape's separator.
 *
 * An empty key is one empty segment rather than no segments, and a key that begins with the separator
 * starts with an empty segment: under `/`, `/a/b` is `["", "a", "b"]`, which `keyName` joins back.
 */
export function splitKey(key: string, shape: KeyScanShape = UNDECLARED): string[] {
  return key.split(shape.separator);
}

/**
 * A node's FULL name, the one every surface addresses its key by: its path joined on the separator.
 *
 * ONE JOIN FOR EVERY READER, which is the leading-separator fix (spec 4.6). Activation, a row's label
 * and title, and the filter all name a node through this, so none of them can rebuild `/a/b` as `a/b`,
 * which the filter did while it built each name by appending to a parent whose own name was empty. It
 * is `splitKey`'s inverse: the segments of any key join back to that key.
 */
export function keyName(path: readonly string[], shape: KeyScanShape = UNDECLARED): string {
  return path.join(shape.separator);
}

/**
 * The path whose LEVEL the panel's own walk lists, for the pattern it sent (Keys panel levels, spec 3.4).
 *
 * Every segment of the pattern but the last: the last is the part of a name the level is listed
 * under, so `sales/` gives `["sales"]`, `sales/2026/ord` gives `["sales", "2026"]`, and `sales`, a
 * pattern with no separator, lists the top level. The empty pattern is the top level too.
 */
export function levelScope(sent: string, shape: KeyScanShape): readonly string[] {
  return sent === "" ? [] : splitKey(sent, shape).slice(0, -1);
}

/**
 * Arrange scanned key names into a tree, merging duplicates.
 *
 * The input is an iterable because the caller has pages and not a list: successive `SCAN` batches
 * go in as they arrive, and the tree is rebuilt from what has accumulated. Rebuilding rather than
 * inserting into a live tree is what keeps this a pure function of the keys seen — a panel that
 * mutated one tree in place would have two sources of truth for its counts the moment a walk
 * restarted from cursor `"0"`.
 *
 * `folders` are the folder prefixes an engine that lists one level at a time answered (Keys panel
 * levels, spec 3.4). Each is a full prefix ending in the separator, so its path is every segment but
 * the last, empty one; every node on that path is created if absent and the last is marked a server
 * folder. A folder adds nothing to any `count`, which stays the distinct keys at or under a node.
 */
export function buildKeyTree(
  keys: Iterable<string>,
  shape: KeyScanShape = UNDECLARED,
  folders: Iterable<string> = [],
): KeyTreeNode {
  const root = createNode("", []);
  const seen = new Set<string>();

  for (const key of keys) {
    // A repeat from a rehashing `SCAN` must not be counted twice, or a folder's badge would drift
    // above the progress bar that is meant to account for it.
    if (seen.has(key)) continue;
    seen.add(key);

    let node = root;
    node.count += 1;
    for (const segment of splitKey(key, shape)) {
      node = childNode(node, segment);
      node.count += 1;
    }
    node.isKey = true;
  }

  for (const folder of folders) {
    let node = root;
    for (const segment of splitKey(folder, shape).slice(0, -1)) node = childNode(node, segment);
    node.serverFolder = true;
  }

  return toTreeNode(root);
}

function toTreeNode(node: MutableNode): KeyTreeNode {
  const children = [...node.children.values()].map(toTreeNode).sort(compareNodes);
  const built = { segment: node.segment, path: node.path, children, count: node.count, isKey: node.isKey };
  // The flag is added only where it is true, so a tree with no server folders has no such property.
  return node.serverFolder ? { ...built, serverFolder: true } : built;
}

/**
 * The rows a tree draws.
 *
 * TWO SHAPES RATHER THAN A NODE WITH A FLAG, because a "load more" row is not a key prefix at all:
 * it names no segment, holds no count and cannot be opened. Giving it a `KeyTreeNode` would mean
 * inventing a segment for it to display and a count for it to show — two lies to avoid one union.
 */
export type KeyTreeRow =
  | {
      readonly kind: "node";
      readonly node: KeyTreeNode;
      /** How deep the row sits, which is what its indentation is computed from. */
      readonly depth: number;
      /** True when the row can be opened. A node that is also a key is a folder as well as a key. */
      readonly folder: boolean;
      /**
       * This row's ARIA `aria-setsize`, the FULL sibling set it belongs to.
       *
       * Computed here rather than from what is drawn, because a window draws a slice: the pattern
       * wants the count of the whole set even when most of it is outside the DOM, and a number
       * derived from the mounted rows would change as the reader scrolls.
       */
      readonly setSize: number;
      /** This row's ARIA `aria-posinset`: 1-based, within `setSize`. */
      readonly posInSet: number;
    }
  | {
      readonly kind: "loadMore";
      /** The prefix this row would ask about. */
      readonly path: readonly string[];
      readonly depth: number;
      /** See the node arm: the whole sibling set, load-more row included. */
      readonly setSize: number;
      /** The load-more row is last in its set, which is why its set includes it. */
      readonly posInSet: number;
      /**
       * How many keys the walk is HOLDING under this prefix — the same `count` the folder above this
       * row draws.
       *
       * ON THE ROW BECAUSE THE PRESS IS ABOUT THAT NUMBER. A scoped page is filtered by the server and
       * then deduplicated here, so a press can legitimately come back holding only keys already in the
       * tree; a reader who cannot see the count the press is measured against reads that as a broken
       * button. It is the node's own count rather than a second walk of the list: the tree already
       * knows it.
       */
      readonly count: number;
    };

/**
 * The rows a tree draws, given which paths are open and which prefixes can be asked for more.
 *
 * A FLAT LIST RATHER THAN A COMPONENT THAT RECURSES INTO ITSELF, because the one thing a nested
 * renderer cannot state plainly is the depth — and the depth is the whole of a row's indentation.
 * A depth-first walk knows it for free, and the panel draws top to bottom without holding any of
 * the tree's shape.
 *
 * A `loadMore` ROW IS EMITTED AFTER A NODE'S CHILDREN, one level deeper than the node itself, so it
 * reads as "and there are more where these came from" rather than as one of them. It is emitted only
 * for a node that is OPEN: a collapsed folder has no children on screen for more to follow.
 */
export function flattenKeyTree(
  root: KeyTreeNode,
  isExpanded: (path: readonly string[]) => boolean,
  canLoadMore: (path: readonly string[]) => boolean = () => false,
): KeyTreeRow[] {
  const rows: KeyTreeRow[] = [];

  const walk = (node: KeyTreeNode, depth: number): void => {
    for (const child of node.children) {
      const folder = isFolder(child);
      rows.push({ kind: "node", node: child, depth, folder, setSize: 0, posInSet: 0 });
      if (!folder || !isExpanded(child.path)) continue;
      walk(child, depth + 1);
      if (canLoadMore(child.path)) {
        rows.push({
          kind: "loadMore",
          path: child.path,
          depth: depth + 1,
          count: child.count,
          setSize: 0,
          posInSet: 0,
        });
      }
    }
  };

  walk(root, 0);
  return numberSiblings(rows);
}

/**
 * The ARIA pair every row carries: the FULL set at its level, and its 1-based place in it.
 *
 * GROUPED BY DEPTH, which is the level `aria-level` speaks in, and not by parent - and that is the
 * whole reason this is a pass over the FINISHED list rather than arithmetic at each push. A load-more
 * row is drawn one level deeper than the folder it belongs to, so it shares a level with that
 * folder's children while being neither their parent's sibling nor their own: a set computed from the
 * node being walked would number it against the wrong rows, and the pair is exactly the thing a
 * screen reader is told when the window has hidden the rest. Grouping the flat list by depth gives
 * the set by construction, and numbering in emission order gives the place, with no row needing to
 * know what came before it.
 */
function numberSiblings(rows: KeyTreeRow[]): KeyTreeRow[] {
  // ITEM rows only. A load-more row is a BUTTON, and the ARIA set is the set of `treeitem`s: counting
  // it would have every sibling announcing a set one larger than the items a screen reader can reach,
  // and the button itself may not carry the pair at all (a button's role has no place for it).
  const setSize = new Map<number, number>();
  for (const row of rows) {
    if (row.kind === "loadMore") continue;
    setSize.set(row.depth, (setSize.get(row.depth) ?? 0) + 1);
  }

  const at = new Map<number, number>();
  return rows.map((row) => {
    if (row.kind === "loadMore") return row;
    const posInSet = (at.get(row.depth) ?? 0) + 1;
    at.set(row.depth, posInSet);
    return { ...row, posInSet, setSize: setSize.get(row.depth) ?? 0 };
  });
}

/**
 * Whether a key name sits UNDER a prefix, compared segment by segment.
 *
 * THIS IS A CORRECTNESS GUARD AND NOT A CONVENIENCE. A scoped walk under a `glob` declaration asks
 * the server for `MATCH <prefix><separator>*`, and `MATCH` is a glob with no escape: a segment that
 * itself contains `*`, `?` or `[` (Redis keys are arbitrary bytes, so they can) makes the pattern
 * match MORE than the prefix asked about. Nothing can be done about what the server sends back, so the
 * caller filters, and a filter that compared the joined strings would be wrong in the other direction,
 * because `app:env` and `app:envelope` share a prefix of characters and not of segments. A `prefix`
 * declaration's server answers the byte range exactly, and the same filter holds it to the segments.
 */
export function isUnderPrefix(key: string, prefix: readonly string[], shape: KeyScanShape = UNDECLARED): boolean {
  const segments = splitKey(key, shape);
  return prefix.length < segments.length && prefix.every((segment, index) => segments[index] === segment);
}

/**
 * The pattern that walks everything under a prefix, in the shape the engine declares.
 *
 * ONE PLACE, because two callers build this string (#427): the Sidebar's Browse Keys handoff, which
 * holds a row's NAME, and the Load more walk, which holds a path and asks `pathPattern` below. It
 * accepts the form the tree ADVERTISES as well as a bare prefix (a folder is drawn `user:*` or
 * `routes/*`), so a caller holding a row's own name need not know that the trailing separator and `*`
 * are not part of the prefix that name stands for.
 *
 * UNDER `glob` the two halves are not interchangeable: the PREFIX is data that may contain glob
 * metacharacters and is escaped, while the trailing `<separator>*` is the glob the pattern exists for
 * and never is. `user` and `user:*` both give `user:*`.
 *
 * UNDER `prefix` the pattern is the bare prefix plus the separator, unescaped and with no `*`, because
 * a prefix walk reads a byte range and every byte in it is data (spec 4.6): `/apisix/routes/*` and
 * the bare `/apisix/routes` both give `/apisix/routes/`. The separator is kept, because a prefix that
 * lost it would also walk `/apisix/routes-v2/`.
 *
 * IT READS A NAME, so it cannot tell a folder's advertised form from a bare name that ends in the
 * separator and `*` itself. A caller that holds the PATH has nothing to read, and asks `pathPattern`.
 */
export function prefixPattern(prefix: string, shape: KeyScanShape = UNDECLARED): string {
  const marker = `${shape.separator}*`;
  const bare = prefix.endsWith(marker) ? prefix.slice(0, -marker.length) : prefix;
  return shape.pattern === "prefix" ? `${bare}${shape.separator}` : `${escapeGlob(bare)}${marker}`;
}

/**
 * The pattern that walks everything under a PATH, which is what a folder's Load more holds.
 *
 * UNDER `prefix` IT IS THE PATH'S NAME AND THE SEPARATOR, with nothing read out of the name, because
 * every byte of a segment is data (spec 4.6): `["", "apisix"]` gives `/apisix/`, and the root row
 * `[""]` gives `/`. That is `prefixPattern`'s own rule for a bare prefix, and the reason it is not
 * asked here is the one path that rule misreads: a last segment of `*`. The folder `["", "a", "*"]`
 * is named `/a/*`, exactly the advertised form of the folder above it, so `prefixPattern` strips the
 * mark and answers `/a/`, and its Load more would page through the wrong folder's range. From the
 * path the pattern is `/a/*` and then the separator.
 *
 * UNDER `glob` IT IS `prefixPattern` OVER THE JOINED NAME, which is what Load more sent before a walk
 * declared its shape, so Redis's pattern is unchanged byte for byte: the prefix half escaped, the
 * folder mark not. That arm still reads a last segment of `*` as the folder mark, `a:*` for
 * `["a", "*"]`, as it always has.
 */
export function pathPattern(path: readonly string[], shape: KeyScanShape = UNDECLARED): string {
  const name = keyName(path, shape);
  return shape.pattern === "prefix" ? `${name}${shape.separator}` : prefixPattern(name, shape);
}

/**
 * What the pattern box sends for the text a reader typed in it (spec 4.6).
 *
 * UNDER `glob` IT IS THE TEXT ITSELF, the reader's own `MATCH` pattern, as it always was.
 *
 * UNDER `prefix` IT IS THE TEXT AS THE PREFIX, dropping only the `*` of a trailing separator and `*`,
 * the form a folder is drawn in, so `/apisix/routes/*` sends `/apisix/routes/`. Nothing else changes:
 * a `*` anywhere else is data, since a key may contain one, and nothing is trimmed, because a prefix
 * is bytes and ` a/` is not `a/`. The filter box keeps its own rule (`searchTerm`), which drops both
 * characters, because it is a substring match rather than a range.
 */
export function sentPattern(text: string, shape: KeyScanShape = UNDECLARED): string {
  if (shape.pattern !== "prefix") return text;
  return text.endsWith(`${shape.separator}*`) ? text.slice(0, -1) : text;
}

/**
 * The three names a row gives its node, in the declared separator (spec 4.6): the label drawn on it,
 * its title, and the name its twisty's `aria-label` announces.
 *
 * A ROW THAT IS A KEY SAYS THE KEY'S FULL NAME, because that is what activating it addresses; a row
 * that is only a prefix says its own segment with the folder mark, `<segment><separator>*`, and its
 * title says the whole prefix. A row that is both says both in its title, because a reader needs to
 * know both and the label can only say one.
 *
 * THE ROOT ROW NAMES ITSELF TOO. A key that begins with the separator has an empty first segment, so
 * the node `[""]` holds every such key and its full name is the empty string: its label and title keep
 * the folder mark (`/*`, which is also how the object tree labels the prefix `/`, and which a key
 * named `/` is not), and its twisty, which names a folder by its full name, names the separator
 * instead. No row's three names are empty but the empty key's own, which only Redis can hold and whose
 * label this rule does not touch.
 */
export function keyRowNames(
  node: KeyTreeNode,
  folder: boolean,
  shape: KeyScanShape = UNDECLARED,
): { readonly label: string; readonly title: string; readonly toggle: string } {
  const name = keyName(node.path, shape);
  const marker = `${shape.separator}*`;
  const label = folder && !node.isKey ? `${node.segment}${marker}` : name;
  const title = folder
    ? node.isKey
      ? `${name} is a key of this database and a prefix: ${name}${marker}`
      : `${name}${marker}`
    : name;
  return { label, title, toggle: name === "" ? shape.separator : name };
}

/**
 * The tree narrowed to what a term matches, keeping the ancestors that lead to a match.
 *
 * THE TERM IS TESTED AGAINST THE WHOLE KEY NAME AND AGAINST ONE SEGMENT, and the two are different
 * questions a reader asks in the same box. A single word (`cache`) names a segment and means "the
 * branch called that", which is why a matching segment keeps its WHOLE subtree: somebody who typed
 * `cache` is asking for everything under `cache`, not for the rows literally named `cache`. A term
 * with the separator in it (`queue:jobs:failed:2026:09:23`, or `/apisix/routes/1` under `/`) names a
 * PATH, and no segment can ever contain it, so a segment-only test answers "no match" for the one
 * input that most obviously identifies a key, which is the defect this rule exists to close.
 *
 * The counts are the FULL sample's, not the narrowed tree's. A folder saying `3` while two of its keys
 * are filtered out is the honest answer, since three keys are under it, and a count that fell to the
 * size of the current view would make the same folder read differently on every keystroke.
 */
export function filterKeyTree(root: KeyTreeNode, term: string, shape: KeyScanShape = UNDECLARED): KeyTreeNode {
  const needle = searchTerm(term, shape);
  if (needle === "") return root;
  // Nothing matched: the root survives with no children, so a caller has one shape to draw an empty
  // state over rather than a null to remember to check.
  return pruneKeyTree(root, needle, shape) ?? { ...root, children: [] };
}

/**
 * What the box's text asks for, once it is trimmed and taken out of the form the tree ADVERTISES.
 *
 * A FOLDER IS DRAWN AS `<segment><separator>*`, `app:*` or `apisix/*`, so a reader who copies one has
 * typed a name no key has: no key contains a `*` unless the key itself does, and `app:*` would answer
 * "no match" for exactly the branch the row above the box is showing. The trailing separator and `*`
 * are therefore dropped, and only that form: a `*` anywhere else stays literal, because a real key
 * segment may contain one (#427). Both characters go here, where the pattern box keeps the separator
 * (`sentPattern`), because this is a substring match and not a range.
 *
 * An empty result is NO FILTER rather than a term nothing matches, which is what the folder mark alone
 * and an all-whitespace box both mean.
 */
function searchTerm(term: string, shape: KeyScanShape): string {
  const trimmed = term.trim().toLowerCase();
  const marker = `${shape.separator}*`;
  return trimmed.endsWith(marker) ? trimmed.slice(0, -marker.length) : trimmed;
}

/**
 * How tall one row is, fixed because a window is arithmetic over a slice of them.
 *
 * 24 is the row this panel already draws (`h-6`). The object tree's own 28 is ITS number, and a
 * shared constant would be two trees agreeing on something neither of them needs to share — what has
 * to agree is the shape of `keyTreeWindow` and `treeWindow`, which is what the test pins.
 */
export const KEY_ROW_HEIGHT = 24;

/** Rows kept mounted beyond each edge of the viewport, so a scroll does not flash empty. */
const KEY_WINDOW_OVERSCAN = 4;

/**
 * The half-open row range to mount, for a tree drawn as a flat list.
 *
 * AN UNMEASURED BOX MOUNTS EVERYTHING IT HAS. Height 0 means the container has not been laid out
 * yet — it is `display:none`, or the panel was mounted hidden — and guessing a height there would
 * hide rows a reader cannot yet scroll to, behind a scrollbar they will not see. The object tree
 * answers the same fact differently (it mounts `2 * overscan` rows and waits for a scroll) because
 * its rows are windowed against a box it measures on every scroll; this panel takes the other side
 * deliberately: the honest reading of "I do not know how tall this is" is "show what I have".
 *
 * `focusIndex` shifts the window to CONTAIN that row rather than widening it, so a row the reader
 * has focused is never unmounted under them — focus cannot move to a node that is not in the DOM,
 * and losing focus mid-scroll is the one way virtualising a tree can make a keyboard reader worse
 * off than no virtualisation at all.
 */
export function keyTreeWindow(
  count: number,
  scrollTop: number,
  height: number,
  focusIndex = -1,
): readonly [number, number] {
  if (height <= 0) return [0, count];
  const size = Math.min(count, Math.ceil(height / KEY_ROW_HEIGHT) + KEY_WINDOW_OVERSCAN * 2);
  /*
   * CLAMPED TO ZERO ONCE, FOR BOTH BRANCHES BELOW, and that is a correctness rule rather than tidiness:
   * the overscan subtraction makes this negative anywhere in the first four rows, and a NEGATIVE window
   * start is not a window that begins early - `slice(-4, 14)` reads from the END of the list and, in a
   * list longer than fourteen rows, returns NOTHING. The panel then draws no rows at all, the database
   * row included, which is exactly what a reader sees after clicking a row near the top: the focus pin
   * below is asked for a window around that row, and the arithmetic handed it a negative start.
   */
  const byScroll = Math.max(Math.floor(scrollTop / KEY_ROW_HEIGHT) - KEY_WINDOW_OVERSCAN, 0);
  const nearEnd = Math.max(count - size, 0);
  const start =
    focusIndex < 0
      ? Math.min(byScroll, nearEnd)
      : Math.min(
          Math.max(byScroll, focusIndex - size + 1),
          Math.max(focusIndex, 0),
          // A focus index can outlive the rows it pointed into - a rescan or a collapse shrinks them
          // while the row is still focused - and an index past the end would otherwise push the whole
          // window off the list and blank the panel, so it is held to the last window start.
          nearEnd,
        );
  return [start, start + size];
}

/**
 * The node and the ancestors that lead to a match, or null.
 *
 * Each node is matched by its FULL name, the same `keyName` join every reader uses (spec 4.6). The
 * name used to be built by appending the segment to the parent's own name, and a parent whose name was
 * empty, the separator's root row, dropped the leading separator: `/a/b` was matched as `a/b`, so a
 * typed full key found nothing, and a Redis key `:foo` could not be found by its name either. One
 * join per node per keystroke is the cost, over a tree the panel holds to `HELD_KEY_LIMIT` keys.
 */
function pruneKeyTree(node: KeyTreeNode, needle: string, shape: KeyScanShape): KeyTreeNode | null {
  const name = keyName(node.path, shape);
  if (node.segment.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)) return node;

  const children = node.children
    .map((child) => pruneKeyTree(child, needle, shape))
    .filter((child): child is KeyTreeNode => child !== null);

  return children.length === 0 ? null : { ...node, children };
}
