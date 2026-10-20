import { describe, test, expect } from "bun:test";
import {
  parentIndices,
  revealOffset,
  stickyCap,
  stickyEntries,
  type StickyEntry,
  type StickyRowLike,
} from "@/components/sticky-rows";

const ROW = 28;

/** A flat list from depths alone, which is all the strip may read. */
function depths(...values: readonly number[]): readonly StickyRowLike[] {
  return values.map((depth) => ({ depth }));
}

function indices(entries: readonly StickyEntry[]): readonly (number | "gap")[] {
  return entries.map((entry) => (entry.kind === "row" ? entry.index : "gap"));
}

describe("parentIndices()", () => {
  test("an empty list has no parents", () => {
    expect(parentIndices([])).toEqual([]);
  });

  test("a root has no parent and children point at the nearest shallower row", () => {
    // 0
    //   1
    //     2
    //   3
    //     4
    expect(parentIndices(depths(0, 1, 2, 1, 2))).toEqual([-1, 0, 1, 0, 3]);
  });

  test("siblings share the parent and never point at each other", () => {
    expect(parentIndices(depths(0, 1, 1, 1))).toEqual([-1, 0, 0, 0]);
  });

  test("two roots keep separate chains", () => {
    expect(parentIndices(depths(0, 0, 1, 2, 1))).toEqual([-1, -1, 1, 2, 1]);
  });

  test("a column row hangs off the object that was opened", () => {
    // container > folder > object > column, column, and the next folder at depth 2
    expect(parentIndices(depths(0, 1, 2, 3, 3, 2))).toEqual([-1, 0, 1, 2, 2, 1]);
  });

  test("one pass over a long sibling run stays linear (twelve thousand under one folder)", () => {
    const rows = [
      ...depths(0, 1),
      ...Array.from({ length: 12_000 }, (): StickyRowLike => ({ depth: 2 })),
      ...depths(1),
    ];
    const parents = parentIndices(rows);
    expect(parents[2]).toBe(1);
    expect(parents[12_001]).toBe(1);
    expect(parents[12_002]).toBe(0);
  });
});

describe("stickyCap()", () => {
  test("an unmeasured viewport pins nothing", () => {
    expect(stickyCap(0, ROW)).toBe(0);
  });

  test("a viewport too short for a share of one row pins nothing", () => {
    expect(stickyCap(60, ROW)).toBe(0);
  });

  test("the share of the viewport is the first bound", () => {
    // 240 * 0.35 = 84, three 28px rows
    expect(stickyCap(240, ROW)).toBe(3);
  });

  test("the fixed count is the second bound", () => {
    // 800 * 0.35 = 280, ten rows by share, five by the cap
    expect(stickyCap(800, ROW)).toBe(5);
    // The Keys panel's shorter row: eleven by share, still five by the cap.
    expect(stickyCap(800, 24)).toBe(5);
  });
});

describe("stickyEntries()", () => {
  test("nothing to pin at the top of the list", () => {
    expect(stickyEntries(depths(0, 1, 2), [-1, 0, 1], 0, 600, ROW, 5)).toEqual([]);
  });

  test("an unmeasured or empty view draws nothing", () => {
    expect(stickyEntries(depths(0, 1), [-1, 0], 0, 0, ROW, 5)).toEqual([]);
    expect(stickyEntries([], [], 0, 600, ROW, 5)).toEqual([]);
  });

  test("the root is pinned once its child is the first visible row", () => {
    const rows = depths(0, 1, 1);
    const parents = parentIndices(rows);
    // Row 2 is the first visible row at 2.5 rows of scroll; its root is fully above the top.
    expect(indices(stickyEntries(rows, parents, 2.5 * ROW, 600, ROW, 5))).toEqual([0]);
  });

  test("a partially scrolled ancestor is already fully above, so it is pinned exactly while off screen", () => {
    const rows = depths(0, 1, 2);
    const parents = parentIndices(rows);
    // Row 1 sits at the viewport top: row 0's bottom edge equals the scroll offset, so row 0 is off.
    expect(indices(stickyEntries(rows, parents, ROW, 600, ROW, 5))).toEqual([0]);
    // Half a row earlier, row 1 is still the first visible row and row 0's bottom is below the top.
    expect(indices(stickyEntries(rows, parents, ROW / 2, 600, ROW, 5))).toEqual([]);
  });

  test("scrolling is root first, nearest parent last", () => {
    const rows = depths(0, 1, 2, 3);
    const parents = parentIndices(rows);
    expect(indices(stickyEntries(rows, parents, 3 * ROW, 600, ROW, 5))).toEqual([0, 1, 2]);
  });

  test("a chain longer than the cap keeps the root and the nearest parent, and says so", () => {
    const rows = depths(0, 1, 2, 3, 4, 5, 6);
    const parents = parentIndices(rows);
    // Seven levels deep: six ancestors, five slots.
    expect(indices(stickyEntries(rows, parents, 6 * ROW, 600, ROW, 5))).toEqual([0, "gap", 3, 4, 5]);
  });

  test("a two slot cap drops the ellipsis rather than the ends", () => {
    const rows = depths(0, 1, 2, 3, 4, 5, 6);
    const parents = parentIndices(rows);
    expect(indices(stickyEntries(rows, parents, 6 * ROW, 600, ROW, 2))).toEqual([0, 5]);
  });

  test("a one slot cap keeps the nearest parent", () => {
    const rows = depths(0, 1, 2);
    const parents = parentIndices(rows);
    expect(indices(stickyEntries(rows, parents, 2 * ROW, 600, ROW, 1))).toEqual([1]);
  });

  test("a zero cap is a viewport too short for the strip", () => {
    const rows = depths(0, 1, 2);
    const parents = parentIndices(rows);
    expect(stickyEntries(rows, parents, 2 * ROW, 600, ROW, 0)).toEqual([]);
  });

  test("a scroll past the end pins the last row's chain instead of an undefined row", () => {
    const rows = depths(0, 1);
    const parents = parentIndices(rows);
    // Ten thousand pixels past a two row list: the browser clamps, but the function may not read
    // rows[floor(scrollTop / rowHeight)] and find nothing.
    expect(indices(stickyEntries(rows, parents, 10_000, 600, ROW, 5))).toEqual([0]);
  });

  test("a load-more row under a folder pins that folder", () => {
    // The Keys tree emits a load-more row one level deeper than its folder; it is a leaf like a key.
    const rows = depths(0, 1, 2);
    const parents = parentIndices(rows);
    expect(indices(stickyEntries(rows, parents, 2.5 * ROW, 600, ROW, 5))).toEqual([0, 1]);
  });
});

describe("revealOffset()", () => {
  test("a row is revealed at its own top edge", () => {
    expect(revealOffset(0, ROW)).toBe(0);
    expect(revealOffset(12, ROW)).toBe(12 * ROW);
  });

  test("a negative index cannot scroll above the top", () => {
    expect(revealOffset(-3, ROW)).toBe(0);
  });
});
