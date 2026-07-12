import { describe, expect, test } from "bun:test";

import {
  MAX_VISIBLE_COLUMNS,
  TABLE_SOURCE_HANDLE,
  TABLE_TARGET_HANDLE,
  buildGraph,
  computeFkColumnMap,
  graphSignature,
  selectVisibleColumns,
} from "@/components/schema-diagram/graph";
import type { ColumnSchema, TableSchema } from "@/lib/types";

function makeTable(name: string, columns: Partial<ColumnSchema>[], foreignKeys: TableSchema["foreignKeys"] = []) {
  return {
    name,
    columns: columns.map((c, i) => ({
      name: c.name ?? `col_${i}`,
      type: c.type ?? "integer",
      nullable: c.nullable ?? true,
      isPrimary: c.isPrimary ?? false,
      defaultValue: c.defaultValue,
    })),
    indexes: [],
    foreignKeys,
    rowCount: 0,
  } as TableSchema;
}

const users = makeTable("users", [
  { name: "id", isPrimary: true },
  { name: "email", type: "varchar" },
]);
const orders = makeTable(
  "orders",
  [{ name: "id", isPrimary: true }, { name: "user_id" }, { name: "total", type: "numeric" }],
  [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
);

describe("computeFkColumnMap", () => {
  test("maps FK source columns and referenced target columns", () => {
    const { sources, targets } = computeFkColumnMap([users, orders]);
    expect(sources.get("orders")).toEqual(new Set(["user_id"]));
    expect(targets.get("users")).toEqual(new Set(["id"]));
    expect(sources.get("users")).toBeUndefined();
  });

  test("ignores FKs pointing at tables outside the schema", () => {
    const dangling = makeTable(
      "dangling",
      [{ name: "id", isPrimary: true }, { name: "ghost_id" }],
      [{ columnName: "ghost_id", referencedTable: "ghosts", referencedColumn: "id" }],
    );
    const { sources, targets } = computeFkColumnMap([dangling]);
    expect(sources.get("dangling")).toBeUndefined();
    expect(targets.size).toBe(0);
  });
});

describe("selectVisibleColumns", () => {
  const wide = makeTable(
    "wide",
    Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, isPrimary: i === 0 })),
  );

  test("returns all columns when table fits the cap", () => {
    const { visible, hiddenCount } = selectVisibleColumns(users, new Set(), false);
    expect(visible.map((c) => c.name)).toEqual(["id", "email"]);
    expect(hiddenCount).toBe(0);
  });

  test("caps wide tables at MAX_VISIBLE_COLUMNS and reports hidden count", () => {
    const { visible, hiddenCount } = selectVisibleColumns(wide, new Set(), false);
    expect(visible.length).toBe(MAX_VISIBLE_COLUMNS);
    expect(hiddenCount).toBe(30 - MAX_VISIBLE_COLUMNS);
  });

  test("always keeps primary-key and FK anchor columns visible", () => {
    const { visible } = selectVisibleColumns(wide, new Set(["c25"]), false);
    const names = visible.map((c) => c.name);
    expect(names).toContain("c0"); // PK
    expect(names).toContain("c25"); // FK anchor beyond the cap
    expect(visible.length).toBe(MAX_VISIBLE_COLUMNS);
  });

  test("preserves original column order", () => {
    const { visible } = selectVisibleColumns(wide, new Set(["c25"]), false);
    const names = visible.map((c) => c.name);
    const sorted = [...names].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    expect(names).toEqual(sorted);
  });

  test("hard-caps even when PK plus FK anchors exceed the cap, prioritizing PK then anchors", () => {
    const hub = makeTable("hub", [
      { name: "pk", isPrimary: true },
      ...Array.from({ length: 15 }, (_, i) => ({ name: `fk${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ name: `data${i}` })),
    ]);
    const anchors = new Set(Array.from({ length: 15 }, (_, i) => `fk${i}`));
    const { visible, hiddenCount } = selectVisibleColumns(hub, anchors, false);
    expect(visible.length).toBe(MAX_VISIBLE_COLUMNS);
    expect(visible.map((c) => c.name)).toContain("pk");
    // remaining slots go to FK anchors before plain data columns
    expect(visible.filter((c) => anchors.has(c.name)).length).toBe(MAX_VISIBLE_COLUMNS - 1);
    expect(visible.some((c) => c.name.startsWith("data"))).toBe(false);
    expect(hiddenCount).toBe(26 - MAX_VISIBLE_COLUMNS);
  });

  test("expanded shows every column", () => {
    const { visible, hiddenCount } = selectVisibleColumns(wide, new Set(), true);
    expect(visible.length).toBe(30);
    expect(hiddenCount).toBe(0);
  });
});

describe("buildGraph", () => {
  test("creates one table node per schema table with grid positions", () => {
    const { nodes } = buildGraph([users, orders], { compact: false });
    expect(nodes.length).toBe(2);
    for (const node of nodes) {
      expect(node.type).toBe("table");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
    const positions = new Set(nodes.map((n) => `${n.position.x},${n.position.y}`));
    expect(positions.size).toBe(2);
  });

  test("builds a column-anchored FK edge", () => {
    const { edges, edgeCount, usedHeuristic } = buildGraph([users, orders], { compact: false });
    expect(edgeCount).toBe(1);
    expect(usedHeuristic).toBe(false);
    const edge = edges[0];
    expect(edge.source).toBe("orders");
    expect(edge.target).toBe("users");
    expect(edge.sourceHandle).toBe("user_id-right");
    expect(edge.targetHandle).toBe("id-left");
    expect(edge.type).toBe("fk");
    expect(edge.data?.heuristic).toBe(false);
  });

  test("deduplicates repeated FK definitions", () => {
    const dup = makeTable(
      "dup",
      [{ name: "id", isPrimary: true }, { name: "user_id" }],
      [
        { columnName: "user_id", referencedTable: "users", referencedColumn: "id" },
        { columnName: "user_id", referencedTable: "users", referencedColumn: "id" },
      ],
    );
    const { edgeCount } = buildGraph([users, dup], { compact: false });
    expect(edgeCount).toBe(1);
  });

  test("skips FKs whose target table is not in the schema", () => {
    const { edgeCount } = buildGraph([orders], { compact: false });
    expect(edgeCount).toBe(0);
  });

  test("falls back to heuristic _id edges only when no real FK exists", () => {
    const posts = makeTable("posts", [{ name: "id", isPrimary: true }, { name: "user_id" }]);
    const bareUsers = makeTable("users", [{ name: "id", isPrimary: true }]);
    const { edges, usedHeuristic } = buildGraph([bareUsers, posts], { compact: false });
    expect(usedHeuristic).toBe(true);
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe("posts");
    expect(edges[0].target).toBe("users");
    expect(edges[0].data?.heuristic).toBe(true);
  });

  test("heuristic matches singular table names", () => {
    const author = makeTable("author", [{ name: "id", isPrimary: true }]);
    const books = makeTable("books", [{ name: "id", isPrimary: true }, { name: "author_id" }]);
    const { edges } = buildGraph([author, books], { compact: false });
    expect(edges.length).toBe(1);
    expect(edges[0].target).toBe("author");
  });

  test("usedHeuristic is true when FK definitions exist but none are usable in the subset", () => {
    // b HAS FK data, but it points outside the schema subset - the graph
    // falls back to heuristic edges and must say so.
    const a = makeTable(
      "customer",
      [{ name: "id", isPrimary: true }, { name: "region_id" }],
      [{ columnName: "region_id", referencedTable: "regions", referencedColumn: "id" }],
    );
    const b = makeTable(
      "invoices",
      [{ name: "id", isPrimary: true }, { name: "customer_id" }],
      [{ columnName: "customer_id", referencedTable: "archived_customers", referencedColumn: "id" }],
    );
    const { edges, usedHeuristic } = buildGraph([a, b], { compact: false });
    expect(usedHeuristic).toBe(true);
    expect(edges.length).toBe(1);
    expect(edges[0].data?.heuristic).toBe(true);
  });

  test("usedHeuristic is false when the fallback finds no matches", () => {
    const a = makeTable("alpha", [{ name: "id", isPrimary: true }]);
    const b = makeTable("beta", [{ name: "id", isPrimary: true }]);
    const { edges, usedHeuristic } = buildGraph([a, b], { compact: false });
    expect(usedHeuristic).toBe(false);
    expect(edges.length).toBe(0);
  });

  test("does not add heuristic edges when a real FK exists anywhere", () => {
    const posts = makeTable("posts", [{ name: "id", isPrimary: true }, { name: "user_id" }]);
    const { edges, usedHeuristic } = buildGraph([users, orders, posts], { compact: false });
    expect(usedHeuristic).toBe(false);
    expect(edges.length).toBe(1);
  });

  test("edges whose anchor column is capped out fall back to table-level handles", () => {
    // hub has 15 FK columns; only 11 fit next to the PK, so some FK edges
    // must anchor to the table header instead of a hidden row.
    const targets = Array.from({ length: 15 }, (_, i) => makeTable(`target_${i}`, [{ name: "id", isPrimary: true }]));
    const hub = makeTable(
      "hub",
      [{ name: "pk", isPrimary: true }, ...Array.from({ length: 15 }, (_, i) => ({ name: `fk${i}` }))],
      Array.from({ length: 15 }, (_, i) => ({
        columnName: `fk${i}`,
        referencedTable: `target_${i}`,
        referencedColumn: "id",
      })),
    );
    const { edges } = buildGraph([hub, ...targets], { compact: false });
    expect(edges.length).toBe(15);
    const rowAnchored = edges.filter((e) => e.sourceHandle !== TABLE_SOURCE_HANDLE);
    const tableAnchored = edges.filter((e) => e.sourceHandle === TABLE_SOURCE_HANDLE);
    expect(rowAnchored.length).toBe(MAX_VISIBLE_COLUMNS - 1);
    expect(tableAnchored.length).toBe(15 - (MAX_VISIBLE_COLUMNS - 1));
  });

  test("compact mode wires edges to table-level handles", () => {
    const { edges } = buildGraph([users, orders], { compact: true });
    expect(edges[0].sourceHandle).toBe(TABLE_SOURCE_HANDLE);
    expect(edges[0].targetHandle).toBe(TABLE_TARGET_HANDLE);
  });

  test("node data exposes visible columns, hidden count and FK anchors", () => {
    const wide = makeTable(
      "wide",
      [...Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`, isPrimary: i === 0 })), { name: "user_id" }],
      [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
    );
    const { nodes } = buildGraph([users, wide], { compact: false });
    const wideNode = nodes.find((n) => n.id === "wide")!;
    const visibleNames = wideNode.data.visibleColumns.map((c) => c.name);
    expect(visibleNames).toContain("user_id");
    expect(wideNode.data.hiddenCount).toBeGreaterThan(0);
    expect(wideNode.data.sourceAnchors).toContain("user_id");
    const usersNode = nodes.find((n) => n.id === "users")!;
    expect(usersNode.data.targetAnchors).toContain("id");
  });

  test("anchor arrays are sorted so FK declaration order cannot change node data", () => {
    const t1 = makeTable(
      "hub",
      [{ name: "id", isPrimary: true }, { name: "b_id" }, { name: "a_id" }],
      [
        { columnName: "b_id", referencedTable: "bees", referencedColumn: "id" },
        { columnName: "a_id", referencedTable: "ayes", referencedColumn: "id" },
      ],
    );
    const t2 = makeTable(
      "hub",
      [{ name: "id", isPrimary: true }, { name: "b_id" }, { name: "a_id" }],
      [
        { columnName: "a_id", referencedTable: "ayes", referencedColumn: "id" },
        { columnName: "b_id", referencedTable: "bees", referencedColumn: "id" },
      ],
    );
    const ayes = makeTable("ayes", [{ name: "id", isPrimary: true }]);
    const bees = makeTable("bees", [{ name: "id", isPrimary: true }]);
    const g1 = buildGraph([t1, ayes, bees], { compact: false });
    const g2 = buildGraph([t2, ayes, bees], { compact: false });
    const anchors1 = g1.nodes.find((n) => n.id === "hub")!.data.sourceAnchors;
    const anchors2 = g2.nodes.find((n) => n.id === "hub")!.data.sourceAnchors;
    expect(anchors1).toEqual(anchors2);
    expect(anchors1).toEqual([...anchors1].sort());
  });

  test("expandedTables reveals all columns for that table only", () => {
    const wide = makeTable(
      "wide",
      Array.from({ length: 30 }, (_, i) => ({ name: `c${i}`, isPrimary: i === 0 })),
    );
    const { nodes } = buildGraph([wide], { compact: false, expandedTables: new Set(["wide"]) });
    expect(nodes[0].data.visibleColumns.length).toBe(30);
    expect(nodes[0].data.hiddenCount).toBe(0);
  });

  test("undefined foreignKeys is tolerated", () => {
    const bare = { ...makeTable("bare", [{ name: "id", isPrimary: true }]) };
    delete (bare as Partial<TableSchema>).foreignKeys;
    const { nodes, edgeCount } = buildGraph([bare as TableSchema], { compact: false });
    expect(nodes.length).toBe(1);
    expect(edgeCount).toBe(0);
  });
});

describe("graphSignature", () => {
  test("is stable across rebuilds of the same structure", () => {
    const a = buildGraph([users, orders], { compact: false });
    const b = buildGraph([users, orders], { compact: false });
    expect(graphSignature(a, false)).toBe(graphSignature(b, false));
  });

  test("expanding a table does not change the signature", () => {
    const a = buildGraph([users, orders], { compact: false });
    const b = buildGraph([users, orders], { compact: false, expandedTables: new Set(["users"]) });
    expect(graphSignature(a, false)).toBe(graphSignature(b, false));
  });

  test("is order-insensitive: the same structure in a different order keeps the signature", () => {
    const a = buildGraph([users, orders], { compact: false });
    const b = buildGraph([orders, users], { compact: false });
    expect(graphSignature(a, false)).toBe(graphSignature(b, false));
  });

  test("changes when the table set, edge set or compact mode changes", () => {
    const base = graphSignature(buildGraph([users, orders], { compact: false }), false);
    expect(graphSignature(buildGraph([users], { compact: false }), false)).not.toBe(base);
    expect(graphSignature(buildGraph([users, orders], { compact: true }), true)).not.toBe(base);
    const noFk = { ...orders, foreignKeys: [] };
    expect(graphSignature(buildGraph([users, noFk], { compact: false }), false)).not.toBe(base);
  });
});
