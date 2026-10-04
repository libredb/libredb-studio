/**
 * What the Graph tab hands its canvas (graph view spec, task G3)
 *
 * The pure half of the view: the masking hook built from the grid's own rule, the
 * Cytoscape elements and stylesheet, the notices, the accessible name and the JSON
 * export. The component test drives these through a canvas; these pin them alone.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_GRAPH_NODES,
  capNotice,
  droppedNotice,
  graphAriaLabel,
  graphElements,
  graphJson,
  graphMask,
  graphStylesheet,
  propertyText,
} from "@/components/results-graph/graph-canvas";
import { chartTheme } from "@/lib/charts/palette";
import { DEFAULT_MASKING_CONFIG, detectSensitiveColumnsFromConfig, maskValueByPattern } from "@/lib/data-masking";
import { buildResultGraph, paletteColor } from "@/lib/db/graph/result-graph";
import type { GraphNodeJson, GraphRelationshipJson } from "@/lib/db/graph/values";

function node(id: string, labels: string[], properties: Record<string, unknown> = {}): GraphNodeJson {
  return { "~graph": "node", elementId: id, labels, properties };
}

function rel(id: string, start: string, end: string, type = "KNOWS"): GraphRelationshipJson {
  return {
    "~graph": "relationship",
    elementId: id,
    type,
    startNodeElementId: start,
    endNodeElementId: end,
    properties: { since: 2020 },
  };
}

const alice = node("1", ["Person"], { name: "Alice", email: "alice@example.com" });
const bob = node("2", ["Person", "Admin"], { name: "Bob" });
const anon = node("3", []);
const knows = rel("1", "1", "2");
const rows = [{ a: alice, r: knows, b: bob, c: anon }];
const graph = buildResultGraph(rows, ["a", "r", "b", "c"], { maxNodes: MAX_GRAPH_NODES });

describe("graphMask", () => {
  test("is absent when masking is not in force, so every value is drawn as stored", () => {
    expect(graphMask(DEFAULT_MASKING_CONFIG, false)).toBeUndefined();
  });

  test("masks a property whose key the config flags, with the grid's own masker", () => {
    const mask = graphMask(DEFAULT_MASKING_CONFIG, true);
    const pattern = detectSensitiveColumnsFromConfig(["email"], DEFAULT_MASKING_CONFIG).get("email");
    if (!mask || !pattern) throw new Error("expected a mask and an email pattern");
    expect(mask("email", "alice@example.com", [])).toBe(maskValueByPattern("alice@example.com", pattern));
    expect(mask("email", "alice@example.com", [])).not.toContain("alice@example.com");
    // A second call for the same key answers from the cache with the same result.
    expect(mask("email", "bob@example.com", [])).toBe(maskValueByPattern("bob@example.com", pattern));
  });

  test("leaves an unflagged key and a missing value as they are, as the grid does", () => {
    const mask = graphMask(DEFAULT_MASKING_CONFIG, true);
    if (!mask) throw new Error("expected a mask");
    expect(mask("name", "Alice", [])).toBe("Alice");
    expect(mask("name", "Bob", [])).toBe("Bob");
    expect(mask("email", null, [])).toBeNull();
    expect(mask("email", undefined, [])).toBeUndefined();
  });

  test("masks every property of an element found under a column the grid masks, with that column's pattern", () => {
    const mask = graphMask(DEFAULT_MASKING_CONFIG, true);
    const secret = detectSensitiveColumnsFromConfig(["secret"], DEFAULT_MASKING_CONFIG).get("secret");
    if (!mask || !secret) throw new Error("expected a mask and a secret pattern");
    expect(mask("value", "hunter2-RAW", ["secret"])).toBe(maskValueByPattern("hunter2-RAW", secret));
    expect(mask("name", "Alice", ["n", "secret"])).toBe(maskValueByPattern("Alice", secret));
    expect(mask("count", 42, ["secret"])).toBe(maskValueByPattern(42, secret));
    expect(mask("name", null, ["secret"])).toBeNull();
    // Under an unflagged column the key decides, as before.
    expect(mask("name", "Alice", ["n"])).toBe("Alice");
  });

  test("a node under a flagged column never shows a raw property in its caption or its value", () => {
    const secretNode = node("8", ["Secret"], { value: "hunter2-RAW", owner: "alice" });
    const masked = buildResultGraph([{ secret: secretNode }], ["secret"], {
      maxNodes: MAX_GRAPH_NODES,
      mask: graphMask(DEFAULT_MASKING_CONFIG, true),
    });
    const text = JSON.stringify(masked);
    expect(text).not.toContain("hunter2-RAW");
    expect(text).not.toContain("alice");
    expect(masked.nodes[0].value.labels).toEqual(["Secret"]);
    expect(masked.nodes[0].value.elementId).toBe("8");
  });

  test("a masked node never shows the raw value in its caption or its value", () => {
    const masked = buildResultGraph([{ n: node("9", ["User"], { email: "carol@example.com" }) }], ["n"], {
      maxNodes: MAX_GRAPH_NODES,
      mask: graphMask(DEFAULT_MASKING_CONFIG, true),
    });
    expect(JSON.stringify(masked)).not.toContain("carol@example.com");
  });
});

describe("graphElements", () => {
  test("prefixes ids by kind, so a node and a relationship that share an id never collide", () => {
    const elements = graphElements(graph);
    expect(elements.map((element) => element.data.id)).toEqual(["n:1", "n:2", "n:3", "r:1"]);
    expect(elements[3]).toEqual({
      group: "edges",
      data: { id: "r:1", source: "n:1", target: "n:2", caption: "KNOWS" },
    });
  });

  test("carries the caption and the colour slot, and leaves the slot out for a node with no label", () => {
    const [first, second, third] = graphElements(graph);
    expect(first).toEqual({ group: "nodes", data: { id: "n:1", caption: "Alice", colorIndex: 0 } });
    expect(second.data).toEqual({ id: "n:2", caption: "Bob", colorIndex: 0 });
    expect(third.data).toEqual({ id: "n:3", caption: "3" });
  });
});

describe("graphStylesheet", () => {
  const selectors = (sheet: ReturnType<typeof graphStylesheet>) =>
    sheet.map((block) => ("selector" in block ? block.selector : ""));

  test("gives every label slot its palette colour, cycling past the palette", () => {
    const theme = chartTheme("dark");
    const sheet = graphStylesheet(theme, 10);
    for (let slot = 0; slot < 10; slot += 1) {
      const block = sheet.find((entry) => "selector" in entry && entry.selector === `node[colorIndex = ${slot}]`);
      expect(block && "style" in block ? block.style : undefined).toEqual({
        "background-color": paletteColor(slot, theme.series),
      });
    }
    expect(paletteColor(8, theme.series)).toBe(theme.series[0]);
  });

  test("draws text in the ink, never in a series colour, and arrows on every relationship", () => {
    for (const mode of ["dark", "light"] as const) {
      const theme = chartTheme(mode);
      const sheet = graphStylesheet(theme, 1);
      const style = (selector: string) => {
        const block = sheet.find((entry) => "selector" in entry && entry.selector === selector);
        return block && "style" in block ? (block.style as Record<string, unknown>) : {};
      };
      expect(style("node").color).toBe(theme.ink);
      expect(style("node").label).toBe("data(caption)");
      expect(style("edge").color).toBe(theme.ink);
      expect(style("edge").label).toBe("data(caption)");
      expect(style("edge")["target-arrow-shape"]).toBe("triangle");
      expect(style("edge")["text-background-color"]).toBe(theme.exportBackground);
      expect(style("node:selected")["border-color"]).toBe(theme.ink);
      expect(style("edge:selected")["line-color"]).toBe(theme.ink);
    }
  });

  test("a node is a modest fixed disc, captioned below in a fixed size that never runs into a neighbour", () => {
    for (const mode of ["dark", "light"] as const) {
      const theme = chartTheme(mode);
      const [first] = graphStylesheet(theme, 0);
      expect("style" in first ? first.style : undefined).toEqual({
        "background-color": theme.axis,
        label: "data(caption)",
        color: theme.ink,
        "font-size": 10,
        "text-valign": "bottom",
        "text-margin-y": 4,
        "text-wrap": "ellipsis",
        "text-max-width": "90px",
        "text-background-color": theme.exportBackground,
        "text-background-opacity": 0.85,
        "text-background-padding": "1px",
        width: 28,
        height: 28,
      });
    }
  });

  test("has no slot rule when nothing carries a label", () => {
    expect(selectors(graphStylesheet(chartTheme("light"), 0))).toEqual([
      "node",
      "edge",
      "node:selected",
      "edge:selected",
    ]);
  });
});

describe("notices and the accessible name", () => {
  test("the cap notice is absent while every node is drawn", () => {
    expect(capNotice(graph)).toBeNull();
  });

  test("the cap notice states the drawn and total counts in the pinned wording", () => {
    const many = Array.from({ length: MAX_GRAPH_NODES + 5 }, (_, index) => ({ n: node(`${index}`, ["N"]) }));
    const capped = buildResultGraph(many, ["n"], { maxNodes: MAX_GRAPH_NODES });
    expect(capNotice(capped)).toBe(
      "Showing 300 of 305 nodes. The graph draws at most 300 nodes; the Results tab holds every row.",
    );
  });

  test("the dropped notice counts relationships left out for a missing endpoint", () => {
    expect(droppedNotice(graph)).toBeNull();
    const one = buildResultGraph([{ r: knows }], ["r"], { maxNodes: MAX_GRAPH_NODES });
    expect(droppedNotice(one)).toBe("1 relationship is not drawn because an endpoint is not among the drawn nodes.");
    const two = buildResultGraph([{ r: knows, s: rel("2", "2", "1") }], ["r", "s"], { maxNodes: MAX_GRAPH_NODES });
    expect(droppedNotice(two)).toBe("2 relationships are not drawn because an endpoint is not among the drawn nodes.");
  });

  test("the accessible name counts what is drawn, in the singular where it is one", () => {
    expect(graphAriaLabel(graph)).toBe("Graph of 3 nodes and 1 relationship");
    const lone = buildResultGraph([{ n: alice }], ["n"], { maxNodes: MAX_GRAPH_NODES });
    expect(graphAriaLabel(lone)).toBe("Graph of 1 node and 0 relationships");
  });
});

describe("graphJson and propertyText", () => {
  test("the JSON export holds the drawn elements in their tagged forms", () => {
    expect(JSON.parse(graphJson(graph))).toEqual({ nodes: [alice, bob, anon], relationships: [knows] });
  });

  test("a property reads as itself when it is text and as JSON otherwise", () => {
    expect(propertyText("Alice")).toBe("Alice");
    expect(propertyText(42)).toBe("42");
    expect(propertyText(null)).toBe("null");
    expect(propertyText({ "~type": "date", value: "2026-10-03" })).toBe('{"~type":"date","value":"2026-10-03"}');
  });
});
