import { describe, expect, test } from "bun:test";
import { collapseRows, filterRows, normalizeQuery, searchExpanded } from "@/components/object-tree/filter";
import type { TreeRowModel } from "@/components/object-tree/flatten";

/**
 * The filter over what the tree has read (U25). Rows are built by hand rather than walked, because
 * the cases here are about which rows SURVIVE and what they are told about their group, and a
 * hand-built list states the input the assertion is about.
 */
function r(id: string, kind: TreeRowModel["kind"], label: string, depth: number, expanded?: boolean): TreeRowModel {
  return { id, kind, label, depth, setSize: 0, posInSet: 0, expanded, path: [id] };
}

// app > Tables > orders (open, two columns), customers ; app > Views > order_summary ; audit (empty)
const tree: readonly TreeRowModel[] = [
  r("app", "container", "app", 0, true),
  r("app/table", "folder", "Tables", 1, true),
  r("app/orders/table", "object", "orders", 2, true),
  r("c:id", "column", "id", 3),
  r("c:total", "column", "total", 3),
  r("app/customers/table", "object", "customers", 2, false),
  r("app/view", "folder", "Views", 1, true),
  r("app/order_summary/view", "object", "order_summary", 2),
  r("audit", "container", "audit", 0, true),
];

function ids(rows: readonly TreeRowModel[]): string[] {
  return rows.map((row) => row.id);
}

describe("normalizeQuery", () => {
  test("trims and lower-cases, and whitespace alone is no filter", () => {
    expect(normalizeQuery("  ORD ")).toBe("ord");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("filterRows", () => {
  test("keeps each matching object, its ancestors and its open columns, case-insensitively", () => {
    const { rows, matches } = filterRows(tree, "ord");
    expect(ids(rows)).toEqual([
      "app",
      "app/table",
      "app/orders/table",
      "c:id",
      "c:total",
      "app/view",
      "app/order_summary/view",
    ]);
    expect(matches).toBe(2);
  });

  test("never matches a container, a folder or a column by its own name", () => {
    expect(filterRows(tree, "audit").matches).toBe(0);
    expect(filterRows(tree, "tables").matches).toBe(0);
    expect(filterRows(tree, "total").rows).toEqual([]);
  });

  test("recomputes aria-setsize and aria-posinset over the rendered groups", () => {
    const { rows } = filterRows(tree, "cust");
    expect(rows.map((row) => [row.id, row.setSize, row.posInSet])).toEqual([
      ["app", 1, 1],
      ["app/table", 1, 1],
      ["app/customers/table", 1, 1],
    ]);
    const both = filterRows(tree, "o").rows.filter((row) => row.depth === 2);
    expect(both.map((row) => [row.label, row.setSize, row.posInSet])).toEqual([
      ["orders", 2, 1],
      ["customers", 2, 2],
      ["order_summary", 1, 1],
    ]);
  });

  test("carries the matched range on the row, and only on the object", () => {
    const { rows } = filterRows(tree, "sum");
    expect(rows.find((row) => row.kind === "object")?.match).toEqual([6, 9]);
    expect(rows.filter((row) => row.match !== undefined)).toHaveLength(1);
  });

  test("a dotted capital I is found by a plain i, and highlighted on the right letters", () => {
    const istanbul = [r("x", "object", "İstanbul", 0)];
    expect(filterRows(istanbul, normalizeQuery("istanbul")).rows[0]?.match).toEqual([0, 8]);
    expect(filterRows(istanbul, normalizeQuery("İSTAN")).rows[0]?.match).toEqual([0, 5]);
    expect(filterRows(istanbul, normalizeQuery("stan")).rows[0]?.match).toEqual([1, 5]);
  });
});

describe("searchExpanded", () => {
  test("opens every known container and every READ folder, and keeps the real set", () => {
    const open = searchExpanded(
      new Set(["app/orders/table"]),
      [
        { path: ["app"], name: "app", level: 0 },
        { path: ["audit"], name: "audit", level: 0 },
      ],
      { "app/table": [] },
    );
    expect([...open].sort()).toEqual(["app", "app/orders/table", "app/table", "audit"]);
  });
});

describe("collapseRows", () => {
  test("keeps a collapsed row, closed, and hides everything under it", () => {
    const { rows } = filterRows(tree, "o");
    const closed = collapseRows(rows, new Set(["app/table"]));
    expect(closed.map((row) => [row.id, row.expanded])).toEqual([
      ["app", true],
      ["app/table", false],
      ["app/view", true],
      ["app/order_summary/view", undefined],
    ]);
  });

  test("collapsing nothing hands the rows back as they were", () => {
    const { rows } = filterRows(tree, "o");
    expect(collapseRows(rows, new Set())).toBe(rows);
  });
});
