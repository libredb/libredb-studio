/**
 * The result graph: what the Graph tab draws from one result
 *
 * The tab draws only what the statement returned, never a second query. This
 * module turns rows into that picture: every tagged graph value in any cell,
 * found through lists, maps and paths, deduplicated by `elementId` within the one
 * result (the id is stable only within one transaction, so never across results).
 * A relationship is drawn only when both its endpoints are drawn; the rest are
 * counted, so the view can say what it left out.
 *
 * Nodes are drawn in row order, then column order, then depth-first inside a
 * cell, up to `maxNodes`; `totalNodes` counts every distinct node the result
 * holds. Labels take colour slots in order of first appearance among drawn nodes,
 * and a node wears its first label's slot.
 *
 * The `mask` hook sees every property of every drawn element before a caption is
 * chosen, so a masked value never reaches a caption, the inspector or an export.
 *
 * Pure and browser-safe: no import beyond `values.ts`, no I/O, no canvas library.
 */
import { type GraphNodeJson, type GraphRelationshipJson, isGraphValueJson } from "@/lib/db/graph/values";

export interface GraphViewNode {
  readonly id: string;
  readonly caption: string;
  /** The first label's colour slot; null for a node with no label. */
  readonly colorIndex: number | null;
  /** The tagged form, with masked properties: what the inspector and the JSON export show. */
  readonly value: GraphNodeJson;
}

export interface GraphViewRelationship {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly caption: string;
  readonly value: GraphRelationshipJson;
}

export interface ResultGraph {
  readonly nodes: readonly GraphViewNode[];
  readonly relationships: readonly GraphViewRelationship[];
  /** Distinct nodes in the whole result, drawn or not. */
  readonly totalNodes: number;
  /** Distinct relationships left out because an endpoint is not drawn. */
  readonly droppedRelationships: number;
  readonly labels: readonly { label: string; count: number; colorIndex: number }[];
  readonly relationshipTypes: readonly { type: string; count: number }[];
}

export interface ResultGraphOptions {
  readonly maxNodes: number;
  /** Returns the value to show for one property; called for every property of every drawn element. */
  readonly mask?: (key: string, value: unknown) => unknown;
}

const CAPTION_LENGTH = 24;
const ELLIPSIS = "…";

/**
 * How deep the walk looks into a cell, the cell itself being depth 1. The Bolt
 * transport replaces a cell nested deeper than this (`MAX_CELL_DEPTH` in
 * `bolt/record-values.ts`, not imported here so this module stays browser-safe),
 * so every graph value an engine returns is found; another engine's JSON may nest
 * without limit, and the bound keeps that from overflowing the stack.
 */
export const MAX_WALK_DEPTH = 32;

/**
 * Every graph value in a cell, in depth-first order. A path yields its member
 * nodes and relationships, each checked, since `isGraphValueJson` checks only
 * that a path's two fields are arrays. A string is text even when it holds the
 * JSON of a graph value, which also covers a cell the transport replaced with a
 * "value too large" note.
 */
function* graphValuesIn(cell: unknown, depth = 1): Generator<GraphNodeJson | GraphRelationshipJson> {
  if (typeof cell !== "object" || cell === null || depth > MAX_WALK_DEPTH) return;
  if (isGraphValueJson(cell)) {
    if (cell["~graph"] !== "path") {
      yield cell;
      return;
    }
    const members: readonly unknown[] = [...cell.nodes, ...cell.relationships];
    for (const member of members) {
      if (isGraphValueJson(member) && member["~graph"] !== "path") yield member;
    }
    return;
  }
  for (const item of Array.isArray(cell) ? cell : Object.values(cell)) yield* graphValuesIn(item, depth + 1);
}

function maskProperties(
  properties: Record<string, unknown>,
  mask: ResultGraphOptions["mask"],
): Record<string, unknown> {
  if (!mask) return properties;
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, mask(key, value)]));
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

let graphemes: Intl.Segmenter | undefined;

/**
 * The visible characters of a text: grapheme clusters, so a cut never splits an
 * emoji sequence or a flag. Built on first use, never at module load, because a
 * browser inside the supported range may lack `Intl.Segmenter` (Firefox before
 * 125) and this module loads with the results panel for every engine; there the
 * cut falls back to code points, which still never splits a surrogate pair.
 */
function visibleCharacters(text: string): string[] {
  if (typeof Intl.Segmenter !== "function") return Array.from(text);
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

function truncate(text: string): string {
  const chars = visibleCharacters(text);
  return chars.length <= CAPTION_LENGTH ? text : `${chars.slice(0, CAPTION_LENGTH - 1).join("")}${ELLIPSIS}`;
}

/**
 * A node's caption: the first present property among `name`, `title`, `label`,
 * then a key ending in `name`, then `description`, then the first string
 * property, else the first label, else the elementId; at most 24 characters.
 * Every key comparison ignores case, and when two keys match one step (`Name`
 * and `name`), the first in property order wins. Null, undefined and the empty
 * string are not present.
 */
export function captionOf(node: Pick<GraphNodeJson, "elementId" | "labels" | "properties">): string {
  const present = Object.entries(node.properties).filter(([, value]) => value != null && value !== "");
  const keyed = (test: (key: string) => boolean) => present.find(([key]) => test(key.toLowerCase()));
  const found =
    keyed((key) => key === "name") ??
    keyed((key) => key === "title") ??
    keyed((key) => key === "label") ??
    keyed((key) => key.endsWith("name")) ??
    keyed((key) => key === "description") ??
    present.find(([, value]) => typeof value === "string");
  return truncate(found ? asText(found[1]) : (node.labels[0] ?? node.elementId));
}

/**
 * True when any field of any row holds a drawable graph value, down to
 * `MAX_WALK_DEPTH`: a node, a relationship, or a path with at least one member.
 * A path with no members draws nothing, so it offers no tab; Neo4j never returns
 * one. It reads the same fields `buildResultGraph` draws, so a tab it offers is
 * never empty.
 */
export function hasGraphValues(rows: readonly Record<string, unknown>[], fields: readonly string[]): boolean {
  return rows.some((row) => fields.some((field) => !graphValuesIn(row[field]).next().done));
}

/** The palette colour of a slot, cycling when labels outnumber colours; undefined for no slot. */
export function paletteColor(colorIndex: number, palette: readonly string[]): string;
export function paletteColor(colorIndex: number | null, palette: readonly string[]): string | undefined;
export function paletteColor(colorIndex: number | null, palette: readonly string[]): string | undefined {
  if (palette.length === 0) throw new Error("paletteColor needs a non-empty palette");
  return colorIndex === null ? undefined : palette[colorIndex % palette.length];
}

export function buildResultGraph(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
  options: ResultGraphOptions,
): ResultGraph {
  const { maxNodes, mask } = options;
  if (!Number.isInteger(maxNodes) || maxNodes < 0) {
    throw new Error(`maxNodes must be a non-negative integer, got ${maxNodes}`);
  }

  const allNodes = new Map<string, GraphNodeJson>();
  const allRelationships = new Map<string, GraphRelationshipJson>();
  for (const row of rows) {
    for (const field of fields) {
      for (const value of graphValuesIn(row[field])) {
        if (value["~graph"] === "node") {
          if (!allNodes.has(value.elementId)) allNodes.set(value.elementId, value);
        } else if (!allRelationships.has(value.elementId)) {
          allRelationships.set(value.elementId, value);
        }
      }
    }
  }

  const labelSlots = new Map<string, { label: string; count: number; colorIndex: number }>();
  const nodes: GraphViewNode[] = [];
  for (const original of [...allNodes.values()].slice(0, maxNodes)) {
    let colorIndex: number | null = null;
    for (const label of original.labels) {
      const slot = labelSlots.get(label) ?? { label, count: 0, colorIndex: labelSlots.size };
      slot.count += 1;
      labelSlots.set(label, slot);
      colorIndex ??= slot.colorIndex;
    }
    const value = { ...original, properties: maskProperties(original.properties, mask) };
    nodes.push({ id: value.elementId, caption: captionOf(value), colorIndex, value });
  }

  const drawn = new Set(nodes.map((node) => node.id));
  const typeCounts = new Map<string, number>();
  const relationships: GraphViewRelationship[] = [];
  let droppedRelationships = 0;
  for (const original of allRelationships.values()) {
    if (!drawn.has(original.startNodeElementId) || !drawn.has(original.endNodeElementId)) {
      droppedRelationships += 1;
      continue;
    }
    typeCounts.set(original.type, (typeCounts.get(original.type) ?? 0) + 1);
    relationships.push({
      id: original.elementId,
      source: original.startNodeElementId,
      target: original.endNodeElementId,
      caption: original.type,
      value: { ...original, properties: maskProperties(original.properties, mask) },
    });
  }

  return {
    nodes,
    relationships,
    totalNodes: allNodes.size,
    droppedRelationships,
    labels: [...labelSlots.values()],
    relationshipTypes: [...typeCounts].map(([type, count]) => ({ type, count })),
  };
}
