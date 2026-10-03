/**
 * What the Graph tab hands its canvas, and what it says about it
 *
 * The pure half of the view: the masking hook built from the grid's own rule, the
 * Cytoscape elements and stylesheet, the notices, the accessible name and the JSON
 * export. Nothing here touches the canvas library, so all of it is tested alone.
 */
import type { ElementDefinition, StylesheetJson } from "@/components/results-graph/cytoscape-host";
import type { ChartTheme } from "@/lib/charts/palette";
import {
  type MaskingConfig,
  type MaskingPattern,
  detectSensitiveColumnsFromConfig,
  maskValueByPattern,
} from "@/lib/data-masking";
import { type ResultGraph, type ResultGraphOptions, paletteColor } from "@/lib/db/graph/result-graph";

/** The most nodes the tab draws; the Results tab holds the rest. */
export const MAX_GRAPH_NODES = 300;

/**
 * The masking hook for `buildResultGraph`, or none when masking is not in force.
 *
 * The grid's rule, both halves of it. The grid masks a whole cell when its column
 * name is flagged, so every property of an element found under such a column is
 * masked with that column's pattern (the first flagged one, in the order met).
 * Elsewhere the rule applies per property: a node's properties sit inside one
 * cell, so a key the config flags is masked with the grid's masker. A missing
 * value stays missing. Labels, type and elementId are not properties and stay.
 */
export function graphMask(config: MaskingConfig, inForce: boolean): ResultGraphOptions["mask"] {
  if (!inForce) return undefined;
  const patterns = new Map<string, MaskingPattern | undefined>();
  const patternOf = (name: string) => {
    if (!patterns.has(name)) patterns.set(name, detectSensitiveColumnsFromConfig([name], config).get(name));
    return patterns.get(name);
  };
  return (key, value, columns) => {
    if (value === null || value === undefined) return value;
    const pattern = columns.map(patternOf).find((found) => found !== undefined) ?? patternOf(key);
    return pattern ? maskValueByPattern(value, pattern) : value;
  };
}

/** The canvas id of a node; ids are prefixed by kind, since an engine may number nodes and relationships alike. */
export function nodeKey(id: string): string {
  return `n:${id}`;
}

export function relationshipKey(id: string): string {
  return `r:${id}`;
}

/** The drawn elements, in the model's order; a node with no label carries no colour slot. */
export function graphElements(graph: ResultGraph): ElementDefinition[] {
  return [
    ...graph.nodes.map((node) => ({
      group: "nodes" as const,
      data: {
        id: nodeKey(node.id),
        caption: node.caption,
        ...(node.colorIndex === null ? {} : { colorIndex: node.colorIndex }),
      },
    })),
    ...graph.relationships.map((relationship) => ({
      group: "edges" as const,
      data: {
        id: relationshipKey(relationship.id),
        source: nodeKey(relationship.source),
        target: nodeKey(relationship.target),
        caption: relationship.caption,
      },
    })),
  ];
}

/**
 * The stylesheet for one theme: one rule per label slot in use, coloured from the
 * chart palette. Text is drawn in the ink and never in a series colour, which the
 * palette forbids, and relationship captions sit on the export ground so a line
 * never runs through them.
 */
export function graphStylesheet(theme: ChartTheme, labelCount: number): StylesheetJson {
  const slots = Array.from({ length: labelCount }, (_, slot) => ({
    selector: `node[colorIndex = ${slot}]`,
    style: { "background-color": paletteColor(slot, theme.series) },
  }));
  return [
    {
      selector: "node",
      style: {
        "background-color": theme.axis,
        label: "data(caption)",
        color: theme.ink,
        "font-size": 10,
        "text-valign": "bottom",
        "text-margin-y": 4,
        width: 28,
        height: 28,
      },
    },
    ...slots,
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": theme.axis,
        "target-arrow-color": theme.axis,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        label: "data(caption)",
        color: theme.ink,
        "font-size": 8,
        "text-rotation": "autorotate",
        "text-background-color": theme.exportBackground,
        "text-background-opacity": 1,
        "text-background-padding": "1px",
      },
    },
    { selector: "node:selected", style: { "border-width": 3, "border-color": theme.ink } },
    { selector: "edge:selected", style: { width: 3, "line-color": theme.ink, "target-arrow-color": theme.ink } },
  ];
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function graphAriaLabel(graph: ResultGraph): string {
  return `Graph of ${counted(graph.nodes.length, "node")} and ${counted(graph.relationships.length, "relationship")}`;
}

/** Said whenever the cap left nodes out, so a partial picture never reads as the whole result. */
export function capNotice(graph: ResultGraph): string | null {
  if (graph.totalNodes <= graph.nodes.length) return null;
  return `Showing ${graph.nodes.length} of ${graph.totalNodes} nodes. The graph draws at most ${MAX_GRAPH_NODES} nodes; the Results tab holds every row.`;
}

export function droppedNotice(graph: ResultGraph): string | null {
  const dropped = graph.droppedRelationships;
  if (dropped === 0) return null;
  return `${counted(dropped, "relationship")} ${dropped === 1 ? "is" : "are"} not drawn because an endpoint is not among the drawn nodes.`;
}

/** The JSON export: the drawn elements in their tagged forms, masked as drawn. */
export function graphJson(graph: ResultGraph): string {
  return JSON.stringify(
    {
      nodes: graph.nodes.map((node) => node.value),
      relationships: graph.relationships.map((relationship) => relationship.value),
    },
    null,
    2,
  );
}

/** One property value as the inspector shows it. */
export function propertyText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
