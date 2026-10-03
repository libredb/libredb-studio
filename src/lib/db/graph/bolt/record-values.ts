/**
 * Driver values to JSON-safe values (Neo4j provider spec 3.4, revisions SR1, SR16, SR18).
 *
 * A record from neo4j-driver-lite holds class instances: 64-bit `Integer`s, temporal
 * classes of Integers, points, typed arrays, nodes, relationships and paths. None of
 * them serialises faithfully (`JSON.stringify` writes an Integer as `{low, high}`, NaN as
 * null, a byte array as an object), so every value is converted here, on the server,
 * before a row leaves the transport.
 *
 * Classes are recognised by the driver's own predicates, never by duck typing, and in a
 * fixed order: an Integer is checked before any object, a temporal value before a map.
 * Nothing loses precision: an Integer past 2^53 becomes its exact decimal string, a
 * temporal value its ISO-8601 text with nanoseconds and zone, a non-finite float its
 * name. Nodes, relationships and paths become the tagged forms of `../values.ts`.
 *
 * The cell bound (SR16) keeps one value from sinking a response: a top-level cell whose
 * converted JSON would exceed 1 MiB, or nest deeper than 32 levels, is replaced by a
 * short string, and the transport adds a warning naming the column. The depth is checked
 * during conversion, so a deep value is abandoned at level 33 rather than converted
 * whole. Measured: one cell holding a list of 10,000 maps of an Integer and a Date converts,
 * serialises and measures in 17 to 33 ms (Bun 1.4.2).
 */
import {
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isNode,
  isPath,
  isPoint,
  isRelationship,
  isTime,
  type Node,
  type Relationship,
} from "neo4j-driver-lite";
import { GRAPH_TAG, type GraphNodeJson, type GraphPathJson, type GraphRelationshipJson } from "../values";

/** A top-level cell whose converted JSON is longer than this, in UTF-8 bytes, is replaced. */
export const MAX_CELL_JSON_BYTES = 1048576;
/** A top-level cell whose converted JSON nests arrays and objects deeper than this is replaced. */
export const MAX_CELL_DEPTH = 32;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** Thrown inside a bounded conversion the moment a container opens past the depth bound. */
class TooDeep extends Error {}

function number(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

function bigint(value: bigint): number | string {
  return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function properties(source: Record<string, unknown>, depth: number, limit: number): Record<string, unknown> {
  if (depth > limit) throw new TooDeep();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) out[key] = convert(source[key], depth + 1, limit);
  return out;
}

/** A node at `depth` holds its labels and properties one level down. */
function node(value: Node, depth: number, limit: number): GraphNodeJson {
  if (depth + 1 > limit) throw new TooDeep();
  return {
    [GRAPH_TAG]: "node",
    elementId: value.elementId,
    labels: [...value.labels],
    properties: properties(value.properties, depth + 1, limit),
  };
}

/** A relationship's depth is its properties', which `properties` checks. */
function relationship(value: Relationship, depth: number, limit: number): GraphRelationshipJson {
  return {
    [GRAPH_TAG]: "relationship",
    elementId: value.elementId,
    type: value.type,
    startNodeElementId: value.startNodeElementId,
    endNodeElementId: value.endNodeElementId,
    properties: properties(value.properties, depth + 1, limit),
  };
}

/**
 * `depth` is the nesting level a container opened here would have: 1 for a top-level
 * list, map or graph value. `limit` is the bound, `Infinity` for `toJsonValue`.
 */
function convert(value: unknown, depth: number, limit: number): unknown {
  if (value === null || value === undefined) return null;
  if (isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (typeof value === "bigint") return bigint(value);
  if (typeof value === "number") return number(value);
  if (typeof value !== "object") return value;

  if (isDate(value) || isDateTime(value) || isLocalDateTime(value) || isLocalTime(value) || isTime(value)) {
    return value.toString();
  }
  if (isDuration(value)) return value.toString();
  if (isPoint(value)) {
    if (depth > limit) throw new TooDeep();
    const point: Record<string, unknown> = {
      srid: convert(value.srid, depth + 1, limit),
      x: number(value.x),
      y: number(value.y),
    };
    if (value.z !== undefined) point.z = number(value.z);
    return point;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    if (depth > limit) throw new TooDeep();
    if (value instanceof Int8Array) return Array.from(value, (byte) => byte & 0xff);
    return Array.from(value as unknown as ArrayLike<number | bigint>, (item) =>
      typeof item === "bigint" ? bigint(item) : number(item),
    );
  }
  if (isNode(value)) return node(value, depth, limit);
  if (isRelationship(value)) return relationship(value, depth, limit);
  if (isPath(value)) {
    // The lists sit one level down and their members two; a node there checks the deepest level.
    const path: GraphPathJson = {
      [GRAPH_TAG]: "path",
      nodes: [node(value.start, depth + 2, limit), ...value.segments.map((s) => node(s.end, depth + 2, limit))],
      relationships: value.segments.map((s) => relationship(s.relationship, depth + 2, limit)),
    };
    return path;
  }
  if (Array.isArray(value)) {
    if (depth > limit) throw new TooDeep();
    return value.map((item) => convert(item, depth + 1, limit));
  }
  if (isPlainObject(value)) return properties(value, depth, limit);
  // A Vector (whose backing array is not its value), a UUID, an unbound relationship,
  // the driver's UnsupportedType for a type newer than 6.2.0, or any other class: the
  // text the driver writes for it.
  return String(value);
}

/** A driver value to its JSON-safe form (spec 3.4 table), recursively and without a bound. */
export function toJsonValue(value: unknown): unknown {
  return convert(value, 1, Number.POSITIVE_INFINITY);
}

export interface BoundedJsonCell {
  /** The converted value, or the string that replaced it. */
  readonly value: unknown;
  /** Present when the value was replaced: by its size, or by its depth. */
  readonly replaced?: "size" | "depth";
}

/** One top-level cell, converted and held to the cell bound (SR16). */
export function boundedJsonCell(value: unknown): BoundedJsonCell {
  let converted: unknown;
  try {
    converted = convert(value, 1, MAX_CELL_DEPTH);
  } catch (error) {
    if (error instanceof TooDeep) return { value: "<value nested too deeply>", replaced: "depth" };
    throw error;
  }
  // Every converted value is JSON: null, a boolean, a number, a string, or arrays and
  // plain objects of those.
  const bytes = Buffer.byteLength(JSON.stringify(converted), "utf8");
  if (bytes > MAX_CELL_JSON_BYTES) return { value: `<value too large: ${bytes} bytes>`, replaced: "size" };
  return { value: converted };
}
