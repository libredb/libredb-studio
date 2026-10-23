/**
 * The ancestor chain a sticky scroll strip draws above a windowed tree.
 *
 * Pure and DOM-free, like `flatten.ts` and `filter.ts` next door, for the same reason: the strip is
 * derived from the row models the panel already holds, never from what happens to be mounted. That
 * distinction is the whole design. Rows are absolutely positioned and windowed, so most ancestors of
 * the first visible row are NOT in the DOM when the strip needs them, and a strip built from mounted
 * rows would be blank exactly when it is needed. It walks the flat list instead, which is complete by
 * construction.
 *
 * THE RULE, one sentence: pin the ancestors of the first visible row, root first, while they are
 * strictly above the viewport top. Every ancestor of the first visible row is above it, so it is
 * always fully scrolled off when the strip draws it - which is what makes "unpin the moment the real
 * row becomes visible" a property of the arithmetic rather than a second rule to remember. Scrolling
 * back up promotes an ancestor to first visible, and it drops out of the chain by the same step.
 */
export interface StickyRowLike {
  readonly depth: number;
}

/** One slot of the strip: a row to draw, or the ellipsis standing in for rows cut by the cap. */
export type StickyEntry = { readonly kind: "row"; readonly index: number } | { readonly kind: "gap" };

/**
 * Each row's nearest ancestor, as an index into the same flat list, or -1 for a root.
 *
 * A depth stack in one pass, because the naive scan backwards from every row is O(n) per row - a
 * folder with twelve thousand children under it makes that the whole list, on every scroll event.
 * Ancestors are the nearest preceding rows of strictly smaller depth, which is what a tree's
 * depth-first flatten guarantees.
 */
export function parentIndices(rows: readonly StickyRowLike[]): readonly number[] {
  const parents = new Array<number>(rows.length);
  const open: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const depth = rows[index].depth;
    while (open.length > 0 && rows[open[open.length - 1]].depth >= depth) open.pop();
    parents[index] = open.length > 0 ? open[open.length - 1] : -1;
    open.push(index);
  }
  return parents;
}

/**
 * How many strip rows fit: a share of the viewport, never more than a fixed count.
 *
 * A cap rather than "whatever the chain is", because a Keys panel nests without limit: forty levels
 * of prefix would otherwise replace the panel with its own path. Zero is a real answer for a viewport
 * too short to hold a share of one row, and the strip then draws nothing.
 */
export function stickyCap(height: number, rowHeight: number, share = 0.35, maxRows = 5): number {
  if (height <= 0 || rowHeight <= 0 || maxRows <= 0) return 0;
  return Math.min(maxRows, Math.floor((height * share) / rowHeight));
}

/**
 * The strip's slots for this scroll position, root first.
 *
 * `cap` comes from `stickyCap`; a chain longer than it keeps BOTH ends and cuts the middle, because
 * the two facts worth keeping are the root (which database this is) and the nearest parent (where in
 * it the reader is). The cut is drawn as one `gap` slot rather than silently, so a truncated strip
 * never reads as complete.
 */
export function stickyEntries(
  rows: readonly StickyRowLike[],
  parents: readonly number[],
  scrollTop: number,
  height: number,
  rowHeight: number,
  cap: number,
): readonly StickyEntry[] {
  if (height <= 0 || rowHeight <= 0 || rows.length === 0 || cap <= 0) return [];
  const top = Math.max(scrollTop, 0);
  const firstVisible = Math.min(Math.floor(top / rowHeight), rows.length - 1);
  const chain: number[] = [];
  // A row whose bottom edge is at or above the viewport top is fully scrolled off, and that is the
  // only state the strip may mirror. A partially visible ancestor cannot happen - it would be the
  // first visible row itself - so the test is exact rather than approximate.
  let cursor = parents[firstVisible];
  while (cursor >= 0 && (cursor + 1) * rowHeight <= top) {
    chain.push(cursor);
    cursor = parents[cursor];
  }
  if (chain.length === 0) return [];
  chain.reverse();
  if (chain.length <= cap) return chain.map((index) => ({ kind: "row", index }));
  // Two slots cannot hold root, ellipsis and a parent at once, so the cap degrades to the ends it
  // would have kept anyway; one slot keeps the nearest parent, the more useful half of the pair.
  if (cap === 1) return [{ kind: "row", index: chain[chain.length - 1] }];
  if (cap === 2) {
    return [
      { kind: "row", index: chain[0] },
      { kind: "row", index: chain[chain.length - 1] },
    ];
  }
  return [
    { kind: "row", index: chain[0] },
    { kind: "gap" },
    ...chain.slice(chain.length - (cap - 2)).map((index) => ({ kind: "row" as const, index })),
  ];
}

/**
 * Where to scroll so a pressed strip row is revealed BELOW the strip that will draw over the list.
 *
 * The row's own top edge is the obvious offset, and it is wrong: the row's ancestors pin exactly
 * there, so the strip paints on top of the row the press just revealed. Nor is subtracting the row's
 * own chain enough - at the new position the strip is recomputed from whichever row is then first
 * visible, and a row above the target may sit DEEPER than the target, pinning a longer chain that
 * covers the row again.
 *
 * So the walk takes the nearest row `at` at or above the target whose own chain is at most
 * `target - at` rows tall - short enough that the strip over `at` cannot reach the target - and
 * scrolls to `at`'s top edge. A root row qualifies at `at = target` itself and lands on its own top
 * edge, and the first row of a depth-stacked list is a root, so the walk always lands. A browser
 * clamps the value at the end of the list, which leaves the row visible at the bottom rather than
 * unreachable.
 */
export function revealOffset(rows: readonly StickyRowLike[], index: number, rowHeight: number): number {
  const target = Math.min(Math.max(index, 0), rows.length - 1);
  for (let at = target; at > 0; at -= 1) {
    const depth = rows[at]?.depth ?? 0;
    if (depth <= target - at) return at * rowHeight;
  }
  return 0;
}
