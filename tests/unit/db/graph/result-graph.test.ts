/**
 * The result graph model (graph view spec, task G1)
 *
 * The Graph tab draws only what one statement returned. These tests pin the pure
 * half that turns rows into the picture: every graph value found in any cell,
 * through lists, maps and paths, deduplicated by `elementId` within the result;
 * a relationship kept only when both its endpoints are drawn; the node cap in
 * row order; the caption rule; label colours in order of first appearance; and
 * the masking hook, which every property passes through before a caption or an
 * export can see it.
 */
import { describe, expect, test } from "bun:test";
import { MAX_WALK_DEPTH, buildResultGraph, captionOf, hasGraphValues, paletteColor } from "@/lib/db/graph/result-graph";
import type { GraphNodeJson, GraphPathJson, GraphRelationshipJson } from "@/lib/db/graph/values";

function node(id: string, labels: string[] = ["Person"], properties: Record<string, unknown> = {}): GraphNodeJson {
  return { "~graph": "node", elementId: id, labels, properties };
}

function rel(
  id: string,
  start: string,
  end: string,
  type = "KNOWS",
  properties: Record<string, unknown> = {},
): GraphRelationshipJson {
  return {
    "~graph": "relationship",
    elementId: id,
    type,
    startNodeElementId: start,
    endNodeElementId: end,
    properties,
  };
}

function path(nodes: GraphNodeJson[], relationships: GraphRelationshipJson[]): GraphPathJson {
  return { "~graph": "path", nodes, relationships };
}

const a = node("n:a", ["Person"], { name: "Alice", email: "alice@example.com" });
const b = node("n:b", ["Person"], { name: "Bob" });
const c = node("n:c", ["Movie"], { title: "Heat" });
const ab = rel("r:ab", "n:a", "n:b");
const bc = rel("r:bc", "n:b", "n:c", "ACTED_IN");

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe("buildResultGraph: collection", () => {
  test("an empty result is an empty graph", () => {
    expect(buildResultGraph([], [], { maxNodes: 300 })).toEqual({
      nodes: [],
      relationships: [],
      totalNodes: 0,
      droppedRelationships: 0,
      labels: [],
      relationshipTypes: [],
    });
  });

  test("a result with no graph value is an empty graph", () => {
    const rows = [{ n: 1, s: "x", m: { k: [1, 2] }, z: null, u: undefined, t: true }];
    const graph = buildResultGraph(rows, ["n", "s", "m", "z", "u", "t"], { maxNodes: 300 });
    expect(graph.nodes).toEqual([]);
    expect(graph.relationships).toEqual([]);
    expect(graph.totalNodes).toBe(0);
  });

  test("a node and relationship carry their id, endpoints, caption and tagged value", () => {
    const graph = buildResultGraph([{ a, r: ab, b }], ["a", "r", "b"], { maxNodes: 300 });
    expect(graph.nodes[0]).toEqual({ id: "n:a", caption: "Alice", colorIndex: 0, value: a });
    expect(graph.relationships).toEqual([{ id: "r:ab", source: "n:a", target: "n:b", caption: "KNOWS", value: ab }]);
  });

  test("the same node in many rows and columns is drawn once, first copy kept", () => {
    const copy = node("n:a", ["Person"], { name: "Changed" });
    const rows = [
      { x: a, y: b },
      { x: copy, y: a },
    ];
    const graph = buildResultGraph(rows, ["x", "y"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a", "n:b"]);
    expect(graph.nodes[0].caption).toBe("Alice");
    expect(graph.totalNodes).toBe(2);
  });

  test("a relationship in a path and in its own column is drawn once", () => {
    const rows = [{ p: path([a, b], [ab]), r: ab }];
    const graph = buildResultGraph(rows, ["p", "r"], { maxNodes: 300 });
    expect(ids(graph.relationships)).toEqual(["r:ab"]);
    expect(graph.relationshipTypes).toEqual([{ type: "KNOWS", count: 1 }]);
  });

  test("walks lists, maps, nested lists and paths inside maps, in order", () => {
    const rows = [{ x: [a, { inner: [b, { deep: path([c], []) }] }] }];
    const graph = buildResultGraph(rows, ["x"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a", "n:b", "n:c"]);
  });

  test("a zero-length path is its one node", () => {
    const graph = buildResultGraph([{ p: path([c], []) }], ["p"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:c"]);
    expect(graph.relationships).toEqual([]);
  });

  test("a path's nodes and relationships are all drawn", () => {
    const graph = buildResultGraph([{ p: path([a, b, c], [ab, bc]) }], ["p"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a", "n:b", "n:c"]);
    expect(ids(graph.relationships)).toEqual(["r:ab", "r:bc"]);
  });

  test("a path member that is not the right graph form is ignored", () => {
    const fake = { "~graph": "path", nodes: [a, { name: "not a node" }, ab, 3], relationships: [ab, a, null] };
    const graph = buildResultGraph([{ p: fake }], ["p"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a"]);
    expect(graph.relationships).toEqual([]);
    expect(graph.droppedRelationships).toBe(1);
  });

  test("columns are read in field order, not in the row object's key order", () => {
    const graph = buildResultGraph([{ second: b, first: a }], ["first", "second"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a", "n:b"]);
  });

  test("a relationship listed before its endpoints is still drawn", () => {
    const graph = buildResultGraph([{ r: ab, a, b }], ["r", "a", "b"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a", "n:b"]);
    expect(ids(graph.relationships)).toEqual(["r:ab"]);
  });

  test("a self relationship is drawn when its one node is", () => {
    const loop = rel("r:aa", "n:a", "n:a");
    const graph = buildResultGraph([{ a, loop }], ["a", "loop"], { maxNodes: 300 });
    expect(ids(graph.relationships)).toEqual(["r:aa"]);
  });

  test("a string cell that the transport cut at 1 MiB is ignored", () => {
    const rows = [
      { p: "<value too large: 2097152 bytes>", a },
      { p: "<value nested too deeply>", a: b },
    ];
    const graph = buildResultGraph(rows, ["p", "a"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a", "n:b"]);
  });

  test("a string holding the JSON of a node is text, not a node", () => {
    const graph = buildResultGraph([{ s: JSON.stringify(a) }], ["s"], { maxNodes: 300 });
    expect(graph.nodes).toEqual([]);
  });

  test("a map with a ~graph key of another value is data and is walked as a map", () => {
    const graph = buildResultGraph([{ m: { "~graph": "vertex", inner: a } }], ["m"], { maxNodes: 300 });
    expect(ids(graph.nodes)).toEqual(["n:a"]);
  });
});

describe("buildResultGraph: dropped relationships", () => {
  test("a relationship whose endpoint the result does not hold is dropped and counted", () => {
    const graph = buildResultGraph([{ r: ab, b }], ["r", "b"], { maxNodes: 300 });
    expect(graph.relationships).toEqual([]);
    expect(graph.droppedRelationships).toBe(1);
    expect(ids(graph.nodes)).toEqual(["n:b"]);
  });

  test("a relationship-only result draws nothing and counts every distinct relationship once", () => {
    const rows = [{ r: ab }, { r: ab }, { r: bc }];
    const graph = buildResultGraph(rows, ["r"], { maxNodes: 300 });
    expect(graph.nodes).toEqual([]);
    expect(graph.droppedRelationships).toBe(2);
    expect(graph.relationshipTypes).toEqual([]);
  });
});

describe("buildResultGraph: node cap", () => {
  const many = Array.from({ length: 5 }, (_, i) => node(`n:${i}`, ["Item"], { name: `item ${i}` }));

  test("the first maxNodes distinct nodes in row order are drawn, totalNodes counts all", () => {
    const rows = many.map((n) => ({ n }));
    rows.splice(1, 0, { n: many[0] });
    const graph = buildResultGraph(rows, ["n"], { maxNodes: 3 });
    expect(ids(graph.nodes)).toEqual(["n:0", "n:1", "n:2"]);
    expect(graph.totalNodes).toBe(5);
  });

  test("a relationship to a node past the cap is dropped and counted", () => {
    const inside = rel("r:01", "n:0", "n:1");
    const outside = rel("r:14", "n:1", "n:4");
    const rows = [...many.map((n) => ({ n, r: null })), { n: null, r: inside }, { n: null, r: outside }];
    const graph = buildResultGraph(rows, ["n", "r"], { maxNodes: 3 });
    expect(ids(graph.relationships)).toEqual(["r:01"]);
    expect(graph.droppedRelationships).toBe(1);
  });

  test("the legend counts only drawn nodes", () => {
    const graph = buildResultGraph(
      many.map((n) => ({ n })),
      ["n"],
      { maxNodes: 2 },
    );
    expect(graph.labels).toEqual([{ label: "Item", count: 2, colorIndex: 0 }]);
  });

  test("a cap of zero draws no node", () => {
    const graph = buildResultGraph([{ a, r: ab, b }], ["a", "r", "b"], { maxNodes: 0 });
    expect(graph.nodes).toEqual([]);
    expect(graph.totalNodes).toBe(2);
    expect(graph.droppedRelationships).toBe(1);
  });

  test("a cap that is not a non-negative integer is refused", () => {
    for (const maxNodes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildResultGraph([], [], { maxNodes })).toThrow(/maxNodes/);
    }
  });
});

describe("buildResultGraph: legend and colours", () => {
  test("labels get colour slots in order of first appearance, counting every label of a node", () => {
    const multi = node("n:m", ["Actor", "Person"], { name: "Al" });
    const plain = node("n:p", [], { name: "x" });
    const rows = [{ x: c }, { x: multi }, { x: a }, { x: plain }];
    const graph = buildResultGraph(rows, ["x"], { maxNodes: 300 });
    expect(graph.labels).toEqual([
      { label: "Movie", count: 1, colorIndex: 0 },
      { label: "Actor", count: 1, colorIndex: 1 },
      { label: "Person", count: 2, colorIndex: 2 },
    ]);
    const byId = new Map(graph.nodes.map((n) => [n.id, n.colorIndex]));
    expect(byId.get("n:c")).toBe(0);
    expect(byId.get("n:m")).toBe(1);
    expect(byId.get("n:a")).toBe(2);
    expect(byId.get("n:p")).toBeNull();
  });

  test("relationship types are counted over drawn relationships, in order of first appearance", () => {
    const ac = rel("r:ac", "n:a", "n:c", "ACTED_IN");
    const ba = rel("r:ba", "n:b", "n:a");
    const rows = [{ p: path([a, b, c], [bc, ab]) }, { p: ac }, { p: ba }];
    const graph = buildResultGraph(rows, ["p"], { maxNodes: 300 });
    expect(graph.relationshipTypes).toEqual([
      { type: "ACTED_IN", count: 2 },
      { type: "KNOWS", count: 2 },
    ]);
  });
});

describe("paletteColor", () => {
  const palette = ["#1", "#2", "#3"];

  test("picks the slot, cycling when labels outnumber colours", () => {
    expect([0, 1, 2, 3, 4, 7].map((i) => paletteColor(i, palette))).toEqual(["#1", "#2", "#3", "#1", "#2", "#2"]);
  });

  test("a slot always has a colour, so a caller needs no cast", () => {
    const color: string = paletteColor(4, palette);
    expect(color).toBe("#2");
  });

  test("an unlabelled node gets no palette colour", () => {
    expect(paletteColor(null, palette)).toBeUndefined();
  });

  test("an empty palette is refused", () => {
    expect(() => paletteColor(0, [])).toThrow(/palette/);
  });
});

describe("buildResultGraph: masking hook", () => {
  const mask = (key: string, value: unknown) => (key === "email" ? "***" : value);

  test("a node with an email property never shows the raw value when masking is on", () => {
    const only = node("n:e", ["User"], { email: "alice@example.com" });
    const graph = buildResultGraph([{ a: only }], ["a"], { maxNodes: 300, mask });
    expect(JSON.stringify(graph)).not.toContain("alice@example.com");
    expect(graph.nodes[0].value.properties.email).toBe("***");
    expect(graph.nodes[0].caption).toBe("***");
  });

  test("relationship properties pass through the hook, and the input rows are not changed", () => {
    const secret = rel("r:s", "n:a", "n:b", "KNOWS", { email: "x@y.z", since: 2020 });
    const rows = [{ a, b, r: secret }];
    const graph = buildResultGraph(rows, ["a", "b", "r"], { maxNodes: 300, mask });
    expect(graph.relationships[0].value.properties).toEqual({ email: "***", since: 2020 });
    expect(graph.nodes[0].value.properties).toEqual({ name: "Alice", email: "***" });
    expect(secret.properties.email).toBe("x@y.z");
    expect(a.properties.email).toBe("alice@example.com");
  });

  test("the hook is told every column the element was found under, in the order they were met", () => {
    const seen: string[] = [];
    const record = (key: string, value: unknown, columns: readonly string[]) => {
      seen.push(`${key}:${columns.join(",")}`);
      return value;
    };
    const rows = [{ x: b, y: [b, bc], z: c }, { x: c }];
    buildResultGraph(rows, ["x", "y", "z"], { maxNodes: 300, mask: record });
    expect(seen).toEqual(["name:x,y", "title:z,x"]);
    const relationshipColumns: string[] = [];
    const role = rel("r:bc", "n:b", "n:c", "ACTED_IN", { role: "Hanna" });
    buildResultGraph([{ p: path([b, c], [role]), r: role }], ["p", "r"], {
      maxNodes: 300,
      mask: (key, value, columns) => {
        relationshipColumns.push(columns.join(","));
        return value;
      },
    });
    expect(relationshipColumns).toEqual(["p", "p", "p,r"]);
  });

  test("without a hook the properties are the returned ones", () => {
    const graph = buildResultGraph([{ a }], ["a"], { maxNodes: 300 });
    expect(graph.nodes[0].value.properties.email).toBe("alice@example.com");
  });
});

describe("captionOf", () => {
  const caption = (properties: Record<string, unknown>, labels: string[] = ["L"], id = "n:1") =>
    captionOf(node(id, labels, properties));

  test("prefers name, then title, then label", () => {
    expect(caption({ title: "T", label: "B", name: "N" })).toBe("N");
    expect(caption({ label: "B", title: "T" })).toBe("T");
    expect(caption({ other: "o", label: "B" })).toBe("B");
  });

  test("matches every key without case, the first in property order winning a tie", () => {
    expect(caption({ Title: "T", NAME: "N" })).toBe("N");
    expect(caption({ Name: "Upper", name: "lower" })).toBe("Upper");
    expect(caption({ LastNAME: "Lovelace", DESCRIPTION: "D" })).toBe("Lovelace");
  });

  test("then a key ending in name, then description", () => {
    expect(caption({ description: "D", firstName: "Ada" })).toBe("Ada");
    expect(caption({ x: 1, Description: "D" })).toBe("D");
  });

  test("then the first string property", () => {
    expect(caption({ age: 3, city: "Izmir", code: "c" })).toBe("Izmir");
  });

  test("a null, undefined or empty preferred property is skipped", () => {
    expect(caption({ name: null, title: undefined, label: "", city: "Izmir" })).toBe("Izmir");
  });

  test("a non-string preferred property is shown as text", () => {
    expect(caption({ name: 42 })).toBe("42");
    expect(caption({ name: false })).toBe("false");
    expect(caption({ name: { x: 1, y: 2 } })).toBe('{"x":1,"y":2}');
    expect(caption({ name: [1, 2] })).toBe("[1,2]");
  });

  test("then the first label, then the elementId", () => {
    expect(caption({ age: 3 }, ["Person", "Actor"])).toBe("Person");
    expect(caption({}, [], "4:abc:7")).toBe("4:abc:7");
  });

  test("truncates to 24 characters with an ellipsis", () => {
    expect(caption({ name: "a".repeat(24) })).toBe("a".repeat(24));
    expect(caption({ name: "b".repeat(25) })).toBe(`${"b".repeat(23)}…`);
  });

  test("truncation never splits a character outside the basic plane", () => {
    const text = `${"x".repeat(22)}\u{1F600}\u{1F600}\u{1F600}`;
    expect(caption({ name: text })).toBe(`${"x".repeat(22)}\u{1F600}…`);
  });

  test("truncation never splits a grapheme cluster", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const flag = "\u{1F1F9}\u{1F1F7}";
    expect(caption({ name: `${"x".repeat(22)}${family}${family}${family}` })).toBe(`${"x".repeat(22)}${family}…`);
    expect(caption({ name: `${"x".repeat(22)}${flag}${flag}${flag}` })).toBe(`${"x".repeat(22)}${flag}…`);
    expect(caption({ name: `${"x".repeat(23)}${flag}` })).toBe(`${"x".repeat(23)}${flag}`);
  });
});

describe("hasGraphValues", () => {
  test("is false for an empty or graph-free result", () => {
    expect(hasGraphValues([], [])).toBe(false);
    expect(hasGraphValues([{ n: 1, s: "<value too large: 9 bytes>", m: { k: [null] } }], ["n", "s", "m"])).toBe(false);
  });

  test("finds a top-level node, relationship or path", () => {
    expect(hasGraphValues([{ x: 1 }, { x: a }], ["x"])).toBe(true);
    expect(hasGraphValues([{ r: ab }], ["r"])).toBe(true);
    expect(hasGraphValues([{ p: path([c], []) }], ["p"])).toBe(true);
  });

  test("finds one inside lists and maps", () => {
    expect(hasGraphValues([{ x: [1, { deep: [ab] }] }], ["x"])).toBe(true);
  });

  test("counts only what can be drawn, so an empty path offers no tab", () => {
    expect(hasGraphValues([{ p: path([], []) }], ["p"])).toBe(false);
    expect(buildResultGraph([{ p: path([], []) }], ["p"], { maxNodes: 300 }).nodes).toEqual([]);
  });

  test("reads only the result's fields, as the drawing does, so it never offers a tab that draws nothing", () => {
    const rows = [{ x: 1, extra: a }];
    expect(hasGraphValues(rows, ["x"])).toBe(false);
    expect(buildResultGraph(rows, ["x"], { maxNodes: 300 }).nodes).toEqual([]);
  });
});

describe("walk depth", () => {
  function nestedIn(levels: number, inner: unknown): unknown {
    let cell = inner;
    for (let level = 0; level < levels; level += 1) cell = [cell];
    return cell;
  }

  test("a cell nested far deeper than any engine returns is walked without throwing", () => {
    expect(hasGraphValues([{ j: nestedIn(20000, 1) }], ["j"])).toBe(false);
    expect(buildResultGraph([{ j: nestedIn(20000, a) }], ["j"], { maxNodes: 300 }).nodes).toEqual([]);
  });

  test("a graph value is found down to the depth a Neo4j cell may reach, and not below it", () => {
    expect(hasGraphValues([{ j: nestedIn(MAX_WALK_DEPTH - 1, a) }], ["j"])).toBe(true);
    expect(hasGraphValues([{ j: nestedIn(MAX_WALK_DEPTH, a) }], ["j"])).toBe(false);
  });
});

describe("without Intl.Segmenter", () => {
  test("the module loads, finds graph values and still cuts captions by code point", async () => {
    const segmenter = Intl.Segmenter;
    Reflect.deleteProperty(Intl, "Segmenter");
    try {
      const fresh: typeof import("@/lib/db/graph/result-graph") = await import(
        "../../../../src/lib/db/graph/result-graph.ts?without-segmenter"
      );
      expect(fresh.hasGraphValues([{ x: a }], ["x"])).toBe(true);
      expect(fresh.captionOf(node("n:1", ["L"], { name: "Alice" }))).toBe("Alice");
      expect(fresh.captionOf(node("n:1", ["L"], { name: `${"x".repeat(23)}\u{1F600}\u{1F600}` }))).toBe(
        `${"x".repeat(23)}…`,
      );
    } finally {
      Intl.Segmenter = segmenter;
    }
  });
});
