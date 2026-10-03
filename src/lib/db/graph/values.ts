/**
 * Graph values as tagged JSON
 *
 * A Bolt result carries nodes, relationships and paths, which have no JSON form
 * of their own. The transport (`bolt/record-values.ts`) converts each one into a
 * plain object tagged with `"~graph"`, so a row is JSON-safe before it leaves the
 * server and the browser can still tell a node from a map that happens to hold
 * the same keys. The tag is also the hook a future graph view reads.
 *
 * This module holds only the forms and two pure helpers: recognising a tagged
 * value, and naming a result column after the one graph form its values share.
 * It is browser-safe: no driver import, no I/O.
 */

/** The key every graph form carries; its value names the form. */
export const GRAPH_TAG = "~graph";

export interface GraphNodeJson {
  readonly "~graph": "node";
  readonly elementId: string;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown>;
}

export interface GraphRelationshipJson {
  readonly "~graph": "relationship";
  readonly elementId: string;
  readonly type: string;
  readonly startNodeElementId: string;
  readonly endNodeElementId: string;
  readonly properties: Record<string, unknown>;
}

/** A path; a zero-length path is its start node and no relationship. */
export interface GraphPathJson {
  readonly "~graph": "path";
  readonly nodes: readonly GraphNodeJson[];
  readonly relationships: readonly GraphRelationshipJson[];
}

export type GraphValueJson = GraphNodeJson | GraphRelationshipJson | GraphPathJson;

/** An object created by a literal or `JSON.parse`, not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * True for a plain object tagged as one of the three forms with every required
 * field of the right primitive type. A user's map with a `~graph` key of any
 * other value, or with a missing field, is data and stays false.
 */
export function isGraphValueJson(value: unknown): value is GraphValueJson {
  if (!isPlainObject(value)) return false;
  switch (value[GRAPH_TAG]) {
    case "node":
      return typeof value.elementId === "string" && isStringArray(value.labels) && isPlainObject(value.properties);
    case "relationship":
      return (
        typeof value.elementId === "string" &&
        typeof value.type === "string" &&
        typeof value.startNodeElementId === "string" &&
        typeof value.endNodeElementId === "string" &&
        isPlainObject(value.properties)
      );
    case "path":
      return Array.isArray(value.nodes) && Array.isArray(value.relationships);
    default:
      return false;
  }
}

const FORM_NAMES = { node: "Node", relationship: "Relationship", path: "Path" } as const;

/**
 * "Node", "Relationship", "Path" when every non-null value has that form;
 * "Mixed" when graph values of several forms or graph and non-graph values mix;
 * undefined when no value is a graph value, which includes an empty or all-null
 * column.
 */
export function graphColumnType(values: readonly unknown[]): "Node" | "Relationship" | "Path" | "Mixed" | undefined {
  let form: GraphValueJson["~graph"] | undefined;
  let sawOther = false;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!isGraphValueJson(value)) {
      sawOther = true;
      continue;
    }
    if (form !== undefined && form !== value[GRAPH_TAG]) return "Mixed";
    form = value[GRAPH_TAG];
  }
  if (form === undefined) return undefined;
  return sawOther ? "Mixed" : FORM_NAMES[form];
}
