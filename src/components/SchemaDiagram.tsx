"use client";

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getNodesBounds,
  useReactFlow,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { TableSchema } from "@/lib/types";
import { Download, Info, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";
import { DiagramActionsContext, type DiagramActions } from "./schema-diagram/diagram-context";
import { FkEdge } from "./schema-diagram/FkEdge";
import { TableNode } from "./schema-diagram/TableNode";
import { EXPORT_BACKGROUND, exportViewportImage } from "./schema-diagram/export";
import { buildGraph, graphSignature, type FkFlowEdge, type TableFlowNode } from "./schema-diagram/graph";
import { createHighlightStore, HighlightStoreProvider } from "./schema-diagram/highlight-store";
import { buildElkGraph, applyLayout } from "./schema-diagram/layout";
import { createLayoutEngine, type LayoutEngine } from "./schema-diagram/layout-engine";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";

// Module-scope identity: a fresh nodeTypes/edgeTypes object per render would
// remount every node (React Flow warns about exactly this).
const nodeTypes: NodeTypes = { table: TableNode };
const edgeTypes: EdgeTypes = { fk: FkEdge };

// Viewport culling pays off on large graphs but adds overhead on small ones;
// the minimap becomes noise (and rendering cost) past a few hundred tables.
const CULLING_THRESHOLD = 100;
const MINIMAP_THRESHOLD = 300;

/** Lets the exporting/layouting spinner paint before heavy synchronous work. */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

interface SchemaDiagramProps {
  schema: TableSchema[];
  onClose: () => void;
}

/**
 * @xyflow paints its own canvas and reads none of the CSS tokens, so the diagram
 * chrome is the second surface — after the charts — that has to be handed a
 * palette. Each mode is picked for its own ground: the minimap swatch in
 * particular cannot simply be flipped, since the dark blue that reads on a light
 * minimap disappears against the dark one.
 */
const DIAGRAM_THEME = {
  dark: {
    /** Dot grid. Recessive: it gives the eye a scale, it is not a feature. */
    background: "#1a1a1a",
    minimapNode: "#3987e5",
    minimapMask: "rgba(0,0,0,0.7)",
    minimapSurface: "#0d0d0d",
    minimapBorder: "rgba(255,255,255,0.1)",
  },
  light: {
    background: "#d4d4d8",
    minimapNode: "#2a78d6",
    minimapMask: "rgba(255,255,255,0.7)",
    minimapSurface: "#ffffff",
    minimapBorder: "rgba(9,9,11,0.14)",
  },
} as const;

function SchemaDiagramInner({ schema, onClose }: SchemaDiagramProps) {
  const mode = useEffectiveTheme();
  const diagram = DIAGRAM_THEME[mode];
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);
  const [compactMode, setCompactMode] = useState(false);
  const [expandedTables, setExpandedTables] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState<"png" | "svg" | null>(null);
  const [isLayouting, setIsLayouting] = useState(false);
  const reactFlowInstance = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutEngineRef = useRef<LayoutEngine | null>(null);
  const highlightStoreRef = useRef(createHighlightStore());
  const { toast } = useToast();

  // Filter tables by search (deferred so typing stays responsive on large schemas)
  const filteredSchema = useMemo(() => {
    if (!deferredQuery.trim()) return schema;
    const q = deferredQuery.toLowerCase();
    return schema.filter((t) => t.name.toLowerCase().includes(q));
  }, [schema, deferredQuery]);

  const graph = useMemo(
    () => buildGraph(filteredSchema, { compact: compactMode, expandedTables: new Set(expandedTables) }),
    [filteredSchema, compactMode, expandedTables],
  );

  // FK neighbors per table, for selection highlighting.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)?.add(edge.target);
      map.get(edge.target)?.add(edge.source);
    }
    return map;
  }, [graph.edges]);

  const [nodes, setNodes] = useState<TableFlowNode[]>(graph.nodes);
  const [edges, setEdges] = useState<FkFlowEdge[]>(graph.edges);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // Last known position per table: survives graph rebuilds so user drags and
  // ELK results are not thrown away by cosmetic changes (expand, re-renders).
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const lastLayoutSigRef = useRef<string | null>(null);

  const restorePositions = useCallback((graphNodes: TableFlowNode[]) => {
    return graphNodes.map((node) => {
      const position = positionsRef.current.get(node.id);
      return position ? { ...node, position } : node;
    });
  }, []);

  // Render immediately, then move nodes to their ELK positions once the
  // (worker-backed) layout resolves. ELK re-runs only when the graph
  // STRUCTURE changes (tables, relationships, compact mode) - including when
  // FK relations arrive from the async second-phase schema fetch. Cosmetic
  // rebuilds (expanding a table's columns) keep positions and viewport.
  useEffect(() => {
    if (graph.nodes.length === 0) {
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setIsLayouting(false);
      return;
    }

    const signature = graphSignature(graph, compactMode);
    // The signature is recorded only AFTER a layout completes - an effect
    // re-run that cancels an in-flight layout (e.g. useReactFlow identity
    // settling on mount) must run ELK again, not skip it.
    if (signature === lastLayoutSigRef.current) {
      setNodes(restorePositions(graph.nodes));
      setEdges(graph.edges);
      return;
    }

    let cancelled = false;
    setNodes(restorePositions(graph.nodes));
    setEdges(graph.edges);
    setIsLayouting(true);
    if (!layoutEngineRef.current) {
      layoutEngineRef.current = createLayoutEngine();
    }
    const elkGraph = buildElkGraph(graph.nodes, graph.edges);
    layoutEngineRef.current
      .layout(elkGraph)
      .then((result) => {
        if (cancelled) return;
        setIsLayouting(false);
        // Recorded for null results too: a known-failed layout must not be
        // retried on every cosmetic rebuild (only cancelled runs may retry).
        lastLayoutSigRef.current = signature;
        if (!result) return; // keep the grid fallback
        const layouted = applyLayout(graph.nodes, result);
        for (const node of layouted) {
          positionsRef.current.set(node.id, node.position);
        }
        setNodes(layouted);
        yieldToPaint().then(() => {
          if (!cancelled) reactFlowInstance.fitView({ padding: 0.15 });
        });
      })
      .catch(() => {
        if (cancelled) return;
        setIsLayouting(false);
        lastLayoutSigRef.current = signature;
      });

    return () => {
      cancelled = true;
    };
  }, [graph, compactMode, reactFlowInstance, restorePositions]);

  // Tear down the layout worker with the component. The ref is nulled so a
  // StrictMode remount creates a fresh engine instead of reusing a disposed
  // worker.
  useEffect(() => {
    return () => {
      void layoutEngineRef.current?.dispose();
      layoutEngineRef.current = null;
    };
  }, []);

  // Keep the highlight in sync with the graph: drop a selection that was
  // filtered out, and refresh the neighbor set when relationships change
  // under an active selection (FK data arrives asynchronously).
  useEffect(() => {
    if (!selectedNode) return;
    if (!graph.nodes.some((n) => n.id === selectedNode)) {
      setSelectedNode(null);
      highlightStoreRef.current.select(null);
      return;
    }
    highlightStoreRef.current.select(selectedNode, adjacency.get(selectedNode) ?? new Set());
  }, [graph, adjacency, selectedNode]);

  const onNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        positionsRef.current.set(change.id, change.position);
      }
    }
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const selectTable = useCallback(
    (table: string | null) => {
      setSelectedNode(table);
      highlightStoreRef.current.select(table, table ? (adjacency.get(table) ?? new Set()) : undefined);
    },
    [adjacency],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      selectTable(selectedNode === node.id ? null : node.id);
    },
    [selectTable, selectedNode],
  );

  const onPaneClick = useCallback(() => {
    selectTable(null);
  }, [selectTable]);

  const diagramActions = useMemo<DiagramActions>(
    () => ({
      toggleExpand: (table: string) => {
        setExpandedTables((current) => {
          const next = new Set(current);
          if (next.has(table)) {
            next.delete(table);
          } else {
            next.add(table);
          }
          return next;
        });
      },
    }),
    [],
  );

  const exportDiagram = useCallback(
    async (format: "png" | "svg") => {
      if (exporting) return;
      const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");
      if (!viewport || nodesRef.current.length === 0) {
        toast({ title: "Export failed", description: "There is no diagram to export.", variant: "destructive" });
        return;
      }

      setExporting(format);
      try {
        // Two paint yields: the first lets React commit the exporting state
        // (which also disables viewport culling so every node is in the DOM),
        // the second lets the newly mounted nodes paint before the snapshot.
        await yieldToPaint();
        await yieldToPaint();
        // Read nodes AFTER the yields: newly mounted (previously culled)
        // nodes report their measured dimensions during that window, and
        // bounds must include them.
        const bounds = getNodesBounds(nodesRef.current);
        // The file carries no page behind it, so it takes the ground of the
        // theme the diagram is being read in.
        await exportViewportImage(format, { viewport, bounds, background: EXPORT_BACKGROUND[mode] });
      } catch (error) {
        logger.warn("Diagram export failed", {
          route: "SchemaDiagram",
          format,
          error: error instanceof Error ? error.message : String(error),
        });
        toast({
          title: `${format.toUpperCase()} export failed`,
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        setExporting(null);
      }
    },
    [exporting, toast],
  );

  // Warn when the DISPLAYED graph runs on guesses: either the schema carries
  // no FK data at all, or the current (possibly filtered) view fell back to
  // dashed heuristic edges because no FK is usable within it.
  const schemaHasFkData = schema.some((t) => (t.foreignKeys || []).length > 0);
  const showHeuristicWarning = graph.usedHeuristic || !schemaHasFkData;
  const heuristicWarningText = graph.usedHeuristic
    ? `${schemaHasFkData ? "No usable FK relationships in this view." : "No FK data available."} Showing heuristic relationships (dashed).`
    : "No FK data available.";

  if (schema.length === 0) {
    return (
      <div className="absolute inset-0 z-50 bg-canvas flex flex-col items-center justify-center">
        <Loader2 strokeWidth={1.5} className="w-8 h-8 text-blue-500 animate-spin mb-4" />
        <p className="text-fg-muted text-xs">Generating ERD Diagram...</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="absolute inset-0 z-40 bg-canvas"
      ref={containerRef}
    >
      <HighlightStoreProvider value={highlightStoreRef.current}>
        <DiagramActionsContext.Provider value={diagramActions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            minZoom={0.05}
            maxZoom={2.5}
            onlyRenderVisibleElements={nodes.length > CULLING_THRESHOLD && exporting === null}
            nodesConnectable={false}
            // Drives @xyflow's OWN chrome (handles, attribution, control glyphs).
            colorMode={mode}
          >
            <Background color={diagram.background} gap={20} />
            {/* `fill-fg` rather than `fill-white`: the control glyphs are ink. */}
            <Controls showInteractive={false} className="bg-raised border-hairline-strong fill-fg" />
            {nodes.length <= MINIMAP_THRESHOLD && (
              <MiniMap
                pannable
                zoomable
                nodeColor={diagram.minimapNode}
                maskColor={diagram.minimapMask}
                style={{
                  backgroundColor: diagram.minimapSurface,
                  border: `1px solid ${diagram.minimapBorder}`,
                }}
              />
            )}

            {/* Close button */}
            <Panel position="top-right" className="p-4">
              <div className="flex items-center gap-2">
                {/* Export buttons */}
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-raised border-hairline-strong hover:bg-fill text-xs gap-1"
                  disabled={exporting !== null}
                  onClick={() => exportDiagram("png")}
                >
                  {exporting === "png" ? (
                    <Loader2 strokeWidth={1.5} className="w-3 h-3 animate-spin" />
                  ) : (
                    <Download strokeWidth={1.5} className="w-3 h-3" />
                  )}{" "}
                  PNG
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="bg-raised border-hairline-strong hover:bg-fill text-xs gap-1"
                  disabled={exporting !== null}
                  onClick={() => exportDiagram("svg")}
                >
                  {exporting === "svg" ? (
                    <Loader2 strokeWidth={1.5} className="w-3 h-3 animate-spin" />
                  ) : (
                    <Download strokeWidth={1.5} className="w-3 h-3" />
                  )}{" "}
                  SVG
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={`bg-raised border-hairline-strong hover:bg-fill text-xs ${compactMode ? "text-blue-400" : ""}`}
                  onClick={() => setCompactMode(!compactMode)}
                >
                  {compactMode ? "Detail" : "Compact"}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full bg-raised border-hairline-strong hover:bg-fill"
                  onClick={onClose}
                >
                  <X strokeWidth={1.5} className="w-3.5 h-3.5" />
                </Button>
              </div>
            </Panel>

            {/* Info panel with stats and search */}
            <Panel position="top-left" className="p-4">
              <div className="bg-raised/80 backdrop-blur-md border border-hairline-strong p-3 rounded-xl shadow-2xl space-y-2">
                <h3 className="text-xs font-medium text-fg mb-1 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  ERD Visualizer
                </h3>
                <div className="flex items-center gap-3 text-xs text-fg-muted">
                  <span>{filteredSchema.length} tables</span>
                  <span>{graph.edgeCount} relationships</span>
                  {isLayouting && (
                    <span className="flex items-center gap-1 text-fg-subtle">
                      <Loader2 strokeWidth={1.5} className="w-3 h-3 animate-spin" />
                      layout
                    </span>
                  )}
                </div>

                {/* Search */}
                <div className="relative">
                  <Search
                    strokeWidth={1.5}
                    className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-subtle"
                  />
                  <input
                    type="text"
                    placeholder="Filter tables..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 bg-fill border border-hairline-strong rounded text-xs text-fg-secondary placeholder:text-fg-subtle focus:outline-none focus:border-blue-500/50"
                  />
                </div>

                {/* No FK warning */}
                {showHeuristicWarning && (
                  <div className="flex items-start gap-1.5 text-[0.625rem] text-amber-500/80">
                    <Info strokeWidth={1.5} className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{heuristicWarningText}</span>
                  </div>
                )}

                {/* Selected node info */}
                {selectedNode && (
                  <div className="text-xs text-blue-400 border-t border-hairline pt-2">
                    Selected: <span className="font-mono font-medium">{selectedNode}</span>
                    <button onClick={() => selectTable(null)} className="ml-2 text-fg-subtle hover:text-fg-tertiary">
                      clear
                    </button>
                  </div>
                )}
              </div>
            </Panel>
          </ReactFlow>

          {/* Export overlay: covers the canvas while the live viewport
              transform is temporarily swapped for the fit-all capture. */}
          {exporting && (
            <div className="absolute inset-0 z-50 bg-canvas/85 flex flex-col items-center justify-center gap-2">
              <Loader2 strokeWidth={1.5} className="w-6 h-6 text-blue-500 animate-spin" />
              <p className="text-fg-muted text-xs">Exporting {exporting.toUpperCase()}...</p>
            </div>
          )}
        </DiagramActionsContext.Provider>
      </HighlightStoreProvider>
    </motion.div>
  );
}

export function SchemaDiagram({ schema, onClose }: SchemaDiagramProps) {
  return (
    <ReactFlowProvider>
      <SchemaDiagramInner schema={schema} onClose={onClose} />
    </ReactFlowProvider>
  );
}
