import type { Edge, Node } from "@xyflow/react";
import type { ColumnSchema, TableSchema } from "@/lib/types";

/** Maximum column rows rendered per table card before the "+N more" expander. */
export const MAX_VISIBLE_COLUMNS = 12;
/** Table-level handle ids used when column handles are unavailable (compact mode). */
export const TABLE_SOURCE_HANDLE = "__table-source";
export const TABLE_TARGET_HANDLE = "__table-target";

export interface TableNodeData extends Record<string, unknown> {
  table: TableSchema;
  compact: boolean;
  visibleColumns: ColumnSchema[];
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
 * Column names participating in FK relationships, per table: `sources` are a
 * table's own FK columns, `targets` are its columns referenced by other
 * tables. Only FKs whose referenced table is present in the schema count.
 */
export function computeFkColumnMap(schema: TableSchema[]): FkColumnMap {
  const tableSet = new Set(schema.map((t) => t.name));
  const sources = new Map<string, Set<string>>();
  const targets = new Map<string, Set<string>>();

  for (const table of schema) {
    for (const fk of table.foreignKeys || []) {
      if (!tableSet.has(fk.referencedTable)) continue;
      let sourceSet = sources.get(table.name);
      if (!sourceSet) {
        sourceSet = new Set();
        sources.set(table.name, sourceSet);
      }
      sourceSet.add(fk.columnName);
      let targetSet = targets.get(fk.referencedTable);
      if (!targetSet) {
        targetSet = new Set();
        targets.set(fk.referencedTable, targetSet);
      }
      targetSet.add(fk.referencedColumn);
    }
  }

  return { sources, targets };
}

/**
 * Picks which columns a table card renders. Wide tables are capped at
 * MAX_VISIBLE_COLUMNS, but primary-key and FK anchor columns are never
 * dropped — edges must always have a visible row to attach to. Original
 * column order is preserved.
 */
export function selectVisibleColumns(
  table: TableSchema,
  anchors: Set<string>,
  expanded: boolean,
): { visible: ColumnSchema[]; hiddenCount: number } {
  const columns = table.columns || [];
  if (expanded || columns.length <= MAX_VISIBLE_COLUMNS) {
    return { visible: columns, hiddenCount: 0 };
  }

  const mustShow = new Set<string>();
  for (const col of columns) {
    if (col.isPrimary || anchors.has(col.name)) mustShow.add(col.name);
  }

  let fillBudget = Math.max(0, MAX_VISIBLE_COLUMNS - mustShow.size);
  const visible: ColumnSchema[] = [];
  for (const col of columns) {
    if (mustShow.has(col.name)) {
      visible.push(col);
    } else if (fillBudget > 0) {
      visible.push(col);
      fillBudget--;
    }
  }

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

function collectFkEdgeSpecs(schema: TableSchema[], tableSet: Set<string>): EdgeSpec[] {
  const specs: EdgeSpec[] = [];
  const seen = new Set<string>();
  for (const table of schema) {
    for (const fk of table.foreignKeys || []) {
      if (!tableSet.has(fk.referencedTable)) continue;
      const id = `${table.name}.${fk.columnName}->${fk.referencedTable}.${fk.referencedColumn}`;
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push({
        id,
        source: table.name,
        target: fk.referencedTable,
        sourceColumn: fk.columnName,
        targetColumn: fk.referencedColumn,
        heuristic: false,
      });
    }
  }
  return specs;
}

function collectHeuristicEdgeSpecs(schema: TableSchema[]): EdgeSpec[] {
  const byName = new Map(schema.map((t) => [t.name, t]));
  const specs: EdgeSpec[] = [];
  const seen = new Set<string>();
  for (const table of schema) {
    for (const col of table.columns || []) {
      if (!col.name.endsWith("_id")) continue;
      const base = col.name.slice(0, -3);
      const target = byName.get(`${base}s`) || byName.get(base);
      if (!target || target.name === table.name) continue;
      const id = `heuristic-${table.name}-${target.name}-${col.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const targetPk = (target.columns || []).find((c) => c.isPrimary);
      specs.push({
        id,
        source: table.name,
        target: target.name,
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
export function graphSignature(graph: Pick<BuiltGraph, "nodes" | "edges">, compact: boolean): string {
  const nodeIds = graph.nodes.map((n) => n.id).join(",");
  const edgeIds = graph.edges.map((e) => e.id).join(",");
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
 * Pure translation of a TableSchema[] into React Flow nodes and edges.
 * Selection/highlight state is deliberately NOT part of node identity — it
 * lives in the highlight store so selecting a table never rebuilds the graph.
 */
export function buildGraph(schema: TableSchema[], options: BuildGraphOptions): BuiltGraph {
  const { compact, expandedTables } = options;
  const tableSet = new Set(schema.map((t) => t.name));
  const { sources, targets } = computeFkColumnMap(schema);

  const fkSpecs = collectFkEdgeSpecs(schema, tableSet);
  const usedHeuristic = fkSpecs.length === 0 && schema.some((t) => (t.foreignKeys || []).length === 0);
  const specs = fkSpecs.length > 0 ? fkSpecs : collectHeuristicEdgeSpecs(schema);

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
    const anchors = new Set([...(sources.get(table.name) || []), ...(targets.get(table.name) || [])]);
    const { visible, hiddenCount } = selectVisibleColumns(table, anchors, expandedTables?.has(table.name) ?? false);
    return {
      id: table.name,
      type: "table" as const,
      position: gridPosition(index, schema.length, compact),
      data: {
        table,
        compact,
        visibleColumns: visible,
        hiddenCount,
        sourceAnchors: [...(sources.get(table.name) || [])],
        targetAnchors: [...(targets.get(table.name) || [])],
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

  return { nodes, edges, edgeCount: edges.length, usedHeuristic: usedHeuristic && edges.length > 0 };
}
