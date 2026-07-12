import { describe, expect, test } from "bun:test";

import { buildGraph } from "@/components/schema-diagram/graph";
import { DEFAULT_ELK_OPTIONS, applyLayout, buildElkGraph, estimateNodeSize } from "@/components/schema-diagram/layout";
import type { TableSchema } from "@/lib/types";

const schema: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "email", type: "varchar", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [],
    rowCount: 1,
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "user_id", type: "integer", nullable: false, isPrimary: false },
    ],
    indexes: [],
    foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
    rowCount: 1,
  },
];

describe("DEFAULT_ELK_OPTIONS", () => {
  test("uses the layered algorithm flowing right", () => {
    expect(DEFAULT_ELK_OPTIONS["elk.algorithm"]).toBe("layered");
    expect(DEFAULT_ELK_OPTIONS["elk.direction"]).toBe("RIGHT");
  });
});

describe("estimateNodeSize", () => {
  test("compact cards are shorter than detailed cards", () => {
    const compact = estimateNodeSize(5, true, false);
    const detailed = estimateNodeSize(5, false, false);
    expect(compact.height).toBeLessThan(detailed.height);
    expect(compact.width).toBeGreaterThan(0);
  });

  test("height grows with visible row count", () => {
    const small = estimateNodeSize(2, false, false);
    const large = estimateNodeSize(20, false, false);
    expect(large.height).toBeGreaterThan(small.height);
  });

  test("the +N more expander row adds height", () => {
    const without = estimateNodeSize(10, false, false);
    const withMore = estimateNodeSize(10, false, true);
    expect(withMore.height).toBeGreaterThan(without.height);
  });
});

describe("buildElkGraph", () => {
  test("maps nodes to sized elk children and edges to sources/targets", () => {
    const { nodes, edges } = buildGraph(schema, { compact: false });
    const elkGraph = buildElkGraph(nodes, edges);

    expect(elkGraph.id).toBe("root");
    expect(elkGraph.layoutOptions).toEqual(DEFAULT_ELK_OPTIONS);
    expect(elkGraph.children.length).toBe(2);
    for (const child of elkGraph.children) {
      expect(child.width).toBeGreaterThan(0);
      expect(child.height).toBeGreaterThan(0);
    }
    expect(elkGraph.edges).toEqual([{ id: "orders.user_id->users.id", sources: ["orders"], targets: ["users"] }]);
  });
});

describe("applyLayout", () => {
  test("returns a new array with elk positions applied", () => {
    const { nodes } = buildGraph(schema, { compact: false });
    const originalPositions = nodes.map((n) => n.position);

    const result = applyLayout(nodes, {
      id: "root",
      children: [
        { id: "users", x: 111, y: 222 },
        { id: "orders", x: 333, y: 444 },
      ],
    });

    expect(result).not.toBe(nodes);
    expect(result.find((n) => n.id === "users")?.position).toEqual({ x: 111, y: 222 });
    expect(result.find((n) => n.id === "orders")?.position).toEqual({ x: 333, y: 444 });
    // input must not be mutated
    nodes.forEach((n, i) => {
      expect(n.position).toBe(originalPositions[i]);
    });
  });

  test("nodes missing from the elk result keep their positions", () => {
    const { nodes } = buildGraph(schema, { compact: false });
    const result = applyLayout(nodes, { id: "root", children: [{ id: "users", x: 9, y: 9 }] });
    expect(result.find((n) => n.id === "orders")?.position).toEqual(nodes.find((n) => n.id === "orders")!.position);
  });
});
