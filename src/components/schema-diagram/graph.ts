import type { Edge, Node } from "@xyflow/react";
import type { DetailedObject } from "@/lib/db/detailed-object";
import { resolveObjectAddress } from "@/lib/db/object-address";
import { pathKey } from "@/lib/db/object-path";
import type { ColumnSchema, ForeignKeySchema } from "@/lib/types";

/** Maximum column rows rendered per table card before the "+N more" expander. */
export const MAX_VISIBLE_COLUMNS = 12;
/** Table-level handle ids used when column handles are unavailable (compact mode). */
export const TABLE_SOURCE_HANDLE = "__table-source";
export const TABLE_TARGET_HANDLE = "__table-target";

export interface TableNodeData extends Record<string, unknown> {
  table: DetailedObject;
  compact: boolean;
  visibleColumns: readonly ColumnSchema[];
  hiddenCount: number;
  sourceAnchors: string[];
  targetAnchors: string[];
}

export type TableFlowNode = Node<TableNodeData, "table">;

export interface FkEdgeData extends Record<string, unknown> {
  heuristic: boolean;
}

export type FkFlowEdge = Edge<FkEdgeData, "fk">;

export interface FkColumnMap {
  sources: Map<string, Set<string>>;
  targets: Map<string, Set<string>>;
}

export interface BuildGraphOptions {
  compact: boolean;
  expandedTables?: Set<string>;
}

export interface BuiltGraph {
  nodes: TableFlowNode[];
  edges: FkFlowEdge[];
  edgeCount: number;
  usedHeuristic: boolean;
}

/**
 * The object a foreign key's target SPELLING addresses, or null (#789, Task 36).
 *
 * Both maps below and both edge builders ask this one question, and the answer is the shared
 * rule in `object-address.ts` rather than a set of labels. `referencedTable` is written by
 * each provider in its own flat dialect: measured on the live SQL Server, one object's key
 * spells its target `app.customers` because it crosses a container while the object beside it
 * spells its own `customers` because it does not. A `Set` of labels answers false for the
 * first spelling and the edge disappeared with no error, and answers true for the second
 * against WHICHEVER namesake it happened to hold.
 *
 * The referencing object's own container is the tie-breaker, because that is how the engine
 * itself resolves an unqualified target. A spelling two objects answer to at the same rank
 * from neither of their containers resolves to nothing and draws no edge: this canvas states
 * that the database has a relation, and drawing one nobody declared is worse than leaving a
 * table with no line on it.
 */
function referencedObject(
  schema: readonly DetailedObject[],
  table: DetailedObject,
  fk: ForeignKeySchema,
): DetailedObject | null {
  const resolution = resolveObjectAddress(schema, (object) => object.path, fk.referencedTable, containerOf(table));
  return resolution.kind === "resolved" ? resolution.object : null;
}

/** The container an object sits in: its address without its own last segment. */
function containerOf(object: DetailedObject): readonly string[] {
  return object.path.slice(0, object.path.length - 1);
}

/**
 * Column names participating in FK relationships, per table, KEYED BY ADDRESS: `sources` are
 * a table's own FK columns, `targets` are its columns referenced by other tables. Only FKs
 * whose referenced object is in the schema and resolves to exactly one object count.
 *
 * The key is `pathKey` and never the label, which is the same key the node ids carry, so a
 * card's anchors cannot land on its namesake in another container.
 */
export function computeFkColumnMap(schema: readonly DetailedObject[]): FkColumnMap {
  const sources = new Map<string, Set<string>>();
  const targets = new Map<string, Set<string>>();

  for (const table of schema) {
    for (const fk of table.foreignKeys || []) {
      const referenced = referencedObject(schema, table, fk);
      if (referenced === null) continue;
      const sourceKey = pathKey(table.path);
      let sourceSet = sources.get(sourceKey);
      if (!sourceSet) {
        sourceSet = new Set();
        sources.set(sourceKey, sourceSet);
      }
      sourceSet.add(fk.columnName);
      const targetKey = pathKey(referenced.path);
      let targetSet = targets.get(targetKey);
      if (!targetSet) {
        targetSet = new Set();
        targets.set(targetKey, targetSet);
      }
      targetSet.add(fk.referencedColumn);
    }
  }

  return { sources, targets };
}

/**
 * Picks which columns a table card renders. Wide tables are hard-capped at
 * MAX_VISIBLE_COLUMNS with slots granted by priority: primary keys first,
 * then FK anchor columns, then the rest. Edges whose anchor column is capped
 * out fall back to table-level handles, so nothing dangles. Original column
 * order is preserved.
 */
export function selectVisibleColumns(
  table: DetailedObject,
  anchors: Set<string>,
  expanded: boolean,
): { visible: readonly ColumnSchema[]; hiddenCount: number } {
  const columns = table.columns || [];
  if (expanded || columns.length <= MAX_VISIBLE_COLUMNS) {
    return { visible: columns, hiddenCount: 0 };
  }

  const chosen = new Set<string>();
  const tiers: Array<(col: ColumnSchema) => boolean> = [
    (col) => col.isPrimary,
    (col) => anchors.has(col.name),
    () => true,
  ];
  for (const matches of tiers) {
    for (const col of columns) {
      if (chosen.size >= MAX_VISIBLE_COLUMNS) break;
      if (!chosen.has(col.name) && matches(col)) chosen.add(col.name);
    }
  }

  const visible = columns.filter((col) => chosen.has(col.name));
  return { visible, hiddenCount: columns.length - visible.length };
}

interface EdgeSpec {
  id: string;
  source: string;
  target: string;
  sourceColumn: string;
  targetColumn: string | null;
  heuristic: boolean;
}

function collectFkEdgeSpecs(schema: readonly DetailedObject[]): EdgeSpec[] {
  const specs: EdgeSpec[] = [];
  const seen = new Set<string>();
  for (const table of schema) {
    for (const fk of table.foreignKeys || []) {
      const referenced = referencedObject(schema, table, fk);
      if (referenced === null) continue;
      const source = pathKey(table.path);
      const target = pathKey(referenced.path);
      const id = `${source}.${fk.columnName}->${target}.${fk.referencedColumn}`;
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push({
        id,
        source,
        target,
        sourceColumn: fk.columnName,
        targetColumn: fk.referencedColumn,
        heuristic: false,
      });
    }
  }
  return specs;
}

/** The one object a heuristic spelling names, resolved by the same rule a declared key is. */
function heuristicTarget(
  schema: readonly DetailedObject[],
  table: DetailedObject,
  spelling: string,
): DetailedObject | null {
  const resolution = resolveObjectAddress(schema, (object) => object.path, spelling, containerOf(table));
  return resolution.kind === "resolved" ? resolution.object : null;
}

function collectHeuristicEdgeSpecs(schema: readonly DetailedObject[]): EdgeSpec[] {
  const specs: EdgeSpec[] = [];
  const seen = new Set<string>();
  for (const table of schema) {
    for (const col of table.columns || []) {
      if (!col.name.endsWith("_id")) continue;
      const base = col.name.slice(0, -3);
      // The same address rule the declared keys use, and for the same reason: a `customer_id`
      // in one container must find the `customers` of ITS container rather than whichever
      // namesake a name map happened to keep last.
      const target = heuristicTarget(schema, table, `${base}s`) || heuristicTarget(schema, table, base);
      const source = pathKey(table.path);
      if (!target || pathKey(target.path) === source) continue;
      const targetKey = pathKey(target.path);
      const id = `heuristic-${source}-${targetKey}-${col.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const targetPk = (target.columns || []).find((c) => c.isPrimary);
      specs.push({
        id,
        source,
        target: targetKey,
        sourceColumn: col.name,
        targetColumn: targetPk ? targetPk.name : null,
        heuristic: true,
      });
    }
  }
  return specs;
}

/**
 * Structural identity of a graph: same tables, same relationships, same
 * display mode. Cosmetic changes (expanding a table's column list) keep the
 * signature stable so layout and viewport are preserved.
 */
// Locale-independent, deterministic string order - the signature only needs
// a stable total order, not alphabetical semantics.
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function graphSignature(graph: Pick<BuiltGraph, "nodes" | "edges">, compact: boolean): string {
  // Sorted so the same logical structure yields the same signature even if
  // the schema arrives in a different order - array order must not force an
  // ELK re-run.
  const nodeIds = graph.nodes
    .map((n) => n.id)
    .sort(byCodeUnit)
    .join(",");
  const edgeIds = graph.edges
    .map((e) => e.id)
    .sort(byCodeUnit)
    .join(",");
  return `${compact ? "c" : "d"}::${nodeIds}::${edgeIds}`;
}

/** Initial grid placement used until (or in place of) the ELK layout result. */
function gridPosition(index: number, total: number, compact: boolean): { x: number; y: number } {
  const cols = Math.max(2, Math.ceil(Math.sqrt(total)));
  const colWidth = compact ? 260 : 320;
  const rowHeight = compact ? 120 : 420;
  return { x: (index % cols) * colWidth, y: Math.floor(index / cols) * rowHeight };
}

/**
 * Pure translation of a readonly DetailedObject[] into React Flow nodes and edges.
 * Selection/highlight state is deliberately NOT part of node identity — it
 * lives in the highlight store so selecting a table never rebuilds the graph.
 */
export function buildGraph(schema: readonly DetailedObject[], options: BuildGraphOptions): BuiltGraph {
  const { compact, expandedTables } = options;
  const { sources, targets } = computeFkColumnMap(schema);

  const fkSpecs = collectFkEdgeSpecs(schema);
  const specs = fkSpecs.length > 0 ? fkSpecs : collectHeuristicEdgeSpecs(schema);
  // "Used" means the fallback actually produced displayed edges - FK
  // definitions may exist yet be unusable (referencing tables outside the
  // current subset), and that still counts as heuristic display.
  const usedHeuristic = fkSpecs.length === 0 && specs.length > 0;

  // Heuristic edges also anchor rows, so fold them into the anchor sets.
  if (fkSpecs.length === 0) {
    for (const spec of specs) {
      if (!sources.has(spec.source)) sources.set(spec.source, new Set());
      sources.get(spec.source)?.add(spec.sourceColumn);
      if (spec.targetColumn) {
        if (!targets.has(spec.target)) targets.set(spec.target, new Set());
        targets.get(spec.target)?.add(spec.targetColumn);
      }
    }
  }

  const nodes: TableFlowNode[] = schema.map((table, index) => {
    // The ADDRESS is the node id, so two objects sharing a label in two containers are two
    // nodes. `table.name` gave them one id, which React Flow answers by dropping a node.
    const key = pathKey(table.path);
    const anchors = new Set([...(sources.get(key) || []), ...(targets.get(key) || [])]);
    const { visible, hiddenCount } = selectVisibleColumns(table, anchors, expandedTables?.has(key) ?? false);
    return {
      id: key,
      type: "table" as const,
      position: gridPosition(index, schema.length, compact),
      data: {
        table,
        compact,
        visibleColumns: visible,
        hiddenCount,
        // Sorted: FK declaration order must not change node data (TableNode
        // derives its handle re-measure signature from these).
        sourceAnchors: [...(sources.get(key) || [])].sort(byCodeUnit),
        targetAnchors: [...(targets.get(key) || [])].sort(byCodeUnit),
      },
    };
  });

  const visibleByTable = new Map(nodes.map((n) => [n.id, new Set(n.data.visibleColumns.map((c) => c.name))]));

  const edges: FkFlowEdge[] = specs.map((spec) => {
    const sourceVisible = !compact && visibleByTable.get(spec.source)?.has(spec.sourceColumn);
    const targetVisible =
      !compact && spec.targetColumn != null && visibleByTable.get(spec.target)?.has(spec.targetColumn);
    return {
      id: spec.id,
      source: spec.source,
      target: spec.target,
      sourceHandle: sourceVisible ? `${spec.sourceColumn}-right` : TABLE_SOURCE_HANDLE,
      targetHandle: targetVisible ? `${spec.targetColumn}-left` : TABLE_TARGET_HANDLE,
      type: "fk" as const,
      data: { heuristic: spec.heuristic },
    };
  });

  return { nodes, edges, edgeCount: edges.length, usedHeuristic };
}
