import type { FkFlowEdge, TableFlowNode } from "./graph";
import type { ElkGraphInput, ElkGraphOutput } from "./layout-engine";

/**
 * ELK "layered" options tuned for ER diagrams (informed by Liam ERD's
 * production option set and the reactflow.dev elkjs example): tall table
 * cards flow left-to-right, parallel FK edges merge, disconnected island
 * tables pack into a block instead of a strip.
 */
export const DEFAULT_ELK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "60",
  "elk.layered.spacing.nodeNodeBetweenLayers": "100",
  "elk.spacing.componentComponent": "80",
  "elk.layered.mergeEdges": "true",
  "elk.layered.considerModelOrder.strategy": "PREFER_EDGES",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.aspectRatio": "1.6",
};

const NODE_WIDTH = 264;
const COMPACT_NODE_WIDTH = 232;
const HEADER_HEIGHT = 37;
const ROW_HEIGHT = 25;
const LIST_PADDING = 8;
const MORE_ROW_HEIGHT = 24;

/**
 * Approximate rendered size of a table card. ELK needs dimensions before the
 * DOM exists; these mirror the TableNode styles closely enough for layout.
 */
export function estimateNodeSize(
  visibleRowCount: number,
  compact: boolean,
  hasMoreRow: boolean,
): { width: number; height: number } {
  if (compact) {
    return { width: COMPACT_NODE_WIDTH, height: HEADER_HEIGHT };
  }
  const listHeight = visibleRowCount * ROW_HEIGHT + LIST_PADDING + (hasMoreRow ? MORE_ROW_HEIGHT : 0);
  return { width: NODE_WIDTH, height: HEADER_HEIGHT + listHeight };
}

export function buildElkGraph(nodes: TableFlowNode[], edges: FkFlowEdge[]): ElkGraphInput {
  return {
    id: "root",
    layoutOptions: DEFAULT_ELK_OPTIONS,
    children: nodes.map((node) => {
      const { width, height } = estimateNodeSize(
        node.data.visibleColumns.length,
        node.data.compact,
        node.data.hiddenCount > 0,
      );
      return { id: node.id, width, height };
    }),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

/** Applies ELK positions immutably; nodes absent from the result are kept as-is. */
export function applyLayout(nodes: TableFlowNode[], layouted: ElkGraphOutput): TableFlowNode[] {
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of layouted.children || []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, position } : node;
  });
}
