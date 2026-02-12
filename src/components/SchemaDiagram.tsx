"use client";

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  NodeProps,
  Edge,
  Node,
  Panel,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  type NodeTypes
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TableSchema } from '@/lib/types';
import { Database, Hash, Type, Key, Loader2, X, Download, Search, Info, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

// Custom Node for Database Tables
interface TableNodeData extends Record<string, unknown> {
  table: TableSchema;
  highlighted?: boolean;
  compact?: boolean;
}

const TableNode = ({ data }: NodeProps<Node<TableNodeData>>) => {
  if (!data) return null;
  const nodeData = data as TableNodeData;
  const table = nodeData.table;
  if (!table) return null;

  const isHighlighted = nodeData.highlighted;
  const isCompact = nodeData.compact;

  // Show FK icon for columns that are foreign keys
  const fkColumns = new Set((table.foreignKeys || []).map(fk => fk.columnName));

  return (
    <div className={`bg-[#0d0d0d] border rounded-lg overflow-hidden min-w-[200px] shadow-2xl transition-all ${
      isHighlighted ? 'border-blue-500/60 ring-1 ring-blue-500/30' : 'border-white/10'
    }`}>
      <div className="bg-blue-600/10 px-3 py-2 border-b border-white/5 flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-xs font-bold text-zinc-100 uppercase tracking-wider">{table.name}</span>
        <span className="text-[9px] text-zinc-600 ml-auto">{table.columns?.length || 0} cols</span>
      </div>
      {!isCompact && (
        <div className="p-1">
          {table.columns?.map((col: { name: string; type: string; isPrimary: boolean; nullable?: boolean; defaultValue?: string }, idx: number) => {
            const isFk = fkColumns.has(col.name);
            return (
              <div key={idx} className="flex items-center justify-between px-2 py-1 text-[10px] hover:bg-white/5 rounded transition-colors group relative">
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`${col.name}-right`}
                  style={{ opacity: 0, right: -5 }}
                />
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`${col.name}-left`}
                  style={{ opacity: 0, left: -5 }}
                />

                <div className="flex items-center gap-2">
                  {col.isPrimary ? (
                    <Key className="w-2.5 h-2.5 text-yellow-500" />
                  ) : isFk ? (
                    <Link2 className="w-2.5 h-2.5 text-blue-400" />
                  ) : col.type.toLowerCase().includes('int') ? (
                    <Hash className="w-2.5 h-2.5 text-zinc-500" />
                  ) : (
                    <Type className="w-2.5 h-2.5 text-zinc-500" />
                  )}
                  <span className={
                    col.isPrimary ? "text-yellow-500/90 font-medium" :
                    isFk ? "text-blue-400/80" :
                    "text-zinc-400"
                  }>
                    {col.name}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {col.nullable === false && <span className="text-[8px] text-red-500/60">NN</span>}
                  <span className="text-[9px] text-zinc-600 font-mono uppercase">{col.type}</span>
                </div>

                {/* Hover tooltip */}
                <div className="absolute left-full ml-2 top-0 z-50 hidden group-hover:block">
                  <div className="bg-[#1a1a1a] border border-white/10 rounded px-2 py-1 text-[9px] whitespace-nowrap shadow-xl">
                    <div className="text-zinc-300">{col.name}: <span className="text-zinc-500">{col.type}</span></div>
                    {col.isPrimary && <div className="text-yellow-500">Primary Key</div>}
                    {isFk && <div className="text-blue-400">Foreign Key</div>}
                    {col.nullable === false && <div className="text-red-400">NOT NULL</div>}
                    {col.defaultValue && <div className="text-zinc-500">Default: {col.defaultValue}</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const nodeTypes: NodeTypes = {
  table: TableNode,
} as NodeTypes;

interface SchemaDiagramProps {
  schema: TableSchema[];
  onClose: () => void;
}

function SchemaDiagramInner({ schema, onClose }: SchemaDiagramProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [compactMode, setCompactMode] = useState(false);
  const reactFlowInstance = useReactFlow();
  const layoutInitRef = useRef(false);

  // Filter tables by search
  const filteredSchema = useMemo(() => {
    if (!searchQuery.trim()) return schema;
    const q = searchQuery.toLowerCase();
    return schema.filter(t => t.name.toLowerCase().includes(q));
  }, [schema, searchQuery]);

  // Build nodes and edges from real FK data
  const { nodes, edges, edgeCount } = useMemo(() => {
    const tableSet = new Set(filteredSchema.map(t => t.name));

    // ELK-style hierarchical layout: tables with more relations go first
    const relationCount = new Map<string, number>();
    filteredSchema.forEach(table => {
      const fkCount = (table.foreignKeys || []).length;
      relationCount.set(table.name, (relationCount.get(table.name) || 0) + fkCount);
      (table.foreignKeys || []).forEach(fk => {
        if (tableSet.has(fk.referencedTable)) {
          relationCount.set(fk.referencedTable, (relationCount.get(fk.referencedTable) || 0) + 1);
        }
      });
    });

    // Sort by relation count for better layout
    const sorted = [...filteredSchema].sort((a, b) =>
      (relationCount.get(b.name) || 0) - (relationCount.get(a.name) || 0)
    );

    // Grid layout with spacing
    const cols = Math.max(2, Math.ceil(Math.sqrt(sorted.length)));
    const colWidth = compactMode ? 250 : 300;
    const rowHeight = compactMode ? 80 : 400;

    const nodes: Node<TableNodeData>[] = sorted.map((table, index) => ({
      id: table.name,
      type: 'table' as const,
      position: { x: (index % cols) * colWidth, y: Math.floor(index / cols) * rowHeight },
      data: {
        table,
        highlighted: selectedNode === table.name ||
          (selectedNode ? filteredSchema.some(t =>
            t.name === selectedNode && (t.foreignKeys || []).some(fk => fk.referencedTable === table.name)
          ) || filteredSchema.some(t =>
            t.name === table.name && (t.foreignKeys || []).some(fk => fk.referencedTable === selectedNode)
          ) : false),
        compact: compactMode,
      } as TableNodeData,
    }));

    // Build edges from real foreignKeys data
    const edges: Edge[] = [];
    const edgeIds = new Set<string>();

    filteredSchema.forEach(table => {
      (table.foreignKeys || []).forEach(fk => {
        if (!tableSet.has(fk.referencedTable)) return;
        const edgeId = `${table.name}.${fk.columnName}->${fk.referencedTable}.${fk.referencedColumn}`;
        if (edgeIds.has(edgeId)) return;
        edgeIds.add(edgeId);

        const isHighlighted = selectedNode === table.name || selectedNode === fk.referencedTable;

        edges.push({
          id: edgeId,
          source: table.name,
          target: fk.referencedTable,
          sourceHandle: `${fk.columnName}-right`,
          targetHandle: `${fk.referencedColumn}-left`,
          animated: isHighlighted,
          label: '1:N',
          labelStyle: { fill: '#666', fontSize: 9 },
          labelBgStyle: { fill: '#0d0d0d', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          style: {
            stroke: isHighlighted ? '#3b82f6' : '#3b82f6',
            strokeWidth: isHighlighted ? 2 : 1.5,
            opacity: selectedNode ? (isHighlighted ? 1 : 0.15) : 0.4,
          },
        });
      });
    });

    // Fallback: if no FK data, use heuristic for _id columns
    if (edges.length === 0) {
      filteredSchema.forEach(table => {
        table.columns.forEach(col => {
          if (col.name.endsWith('_id')) {
            const targetTable = col.name.replace('_id', '') + 's';
            const target = filteredSchema.find(t => t.name === targetTable || t.name === col.name.replace('_id', ''));
            if (target) {
              const edgeId = `heuristic-${table.name}-${target.name}-${col.name}`;
              if (!edgeIds.has(edgeId)) {
                edgeIds.add(edgeId);
                const isHighlighted = selectedNode === table.name || selectedNode === target.name;
                edges.push({
                  id: edgeId,
                  source: table.name,
                  target: target.name,
                  sourceHandle: `${col.name}-right`,
                  targetHandle: `id-left`,
                  animated: isHighlighted,
                  label: '1:N?',
                  labelStyle: { fill: '#666', fontSize: 9, fontStyle: 'italic' },
                  labelBgStyle: { fill: '#0d0d0d', fillOpacity: 0.8 },
                  labelBgPadding: [4, 2] as [number, number],
                  style: {
                    stroke: '#6b7280',
                    strokeWidth: 1,
                    strokeDasharray: '4 2',
                    opacity: selectedNode ? (isHighlighted ? 0.8 : 0.1) : 0.3,
                  },
                });
              }
            }
          }
        });
      });
    }

    return { nodes, edges, edgeCount: edges.length };
  }, [filteredSchema, selectedNode, compactMode]);

  // Attempt ELK layout
  useEffect(() => {
    if (layoutInitRef.current || nodes.length === 0) return;
    layoutInitRef.current = true;

    // Try to import and use elkjs for better layout
    import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => {
      const elk = new ELK();
      const graph = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.spacing.nodeNode': '80',
          'elk.layered.spacing.nodeNodeBetweenLayers': '120',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        },
        children: nodes.map(n => ({
          id: n.id,
          width: compactMode ? 220 : 240,
          height: compactMode ? 60 : Math.max(80, 50 + (n.data.table?.columns?.length || 0) * 22),
        })),
        edges: edges.map(e => ({
          id: e.id,
          sources: [e.source],
          targets: [e.target],
        })),
      };

      elk.layout(graph).then(layoutedGraph => {
        const updates = (layoutedGraph.children || []).map(node => ({
          id: node.id,
          position: { x: node.x || 0, y: node.y || 0 },
        }));

        // Apply positions
        updates.forEach(update => {
          const nodeIdx = nodes.findIndex(n => n.id === update.id);
          if (nodeIdx >= 0) {
            nodes[nodeIdx] = { ...nodes[nodeIdx], position: update.position };
          }
        });

        // layout ready
        // Fit view after layout
        setTimeout(() => {
          reactFlowInstance.fitView({ padding: 0.2 });
        }, 100);
      }).catch(() => {
        // layout ready
      });
    }).catch(() => {
      // elkjs not available, use grid layout
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(prev => prev === node.id ? null : node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const exportDiagram = useCallback(async (format: 'png' | 'svg') => {
    const container = document.querySelector('.react-flow') as HTMLElement;
    if (!container) return;

    if (format === 'png') {
      try {
        const html2canvasModule = await import('html2canvas');
        const html2canvas = html2canvasModule.default as (element: HTMLElement, options?: { backgroundColor?: string; scale?: number }) => Promise<HTMLCanvasElement>;
        const canvas = await html2canvas(container, { backgroundColor: '#050505', scale: 2 });
        const link = document.createElement('a');
        link.download = `erd_${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (error) {
        console.error('Failed to export PNG:', error);
      }
    } else {
      const svgElement = container.querySelector('svg');
      if (svgElement) {
        const svgData = new XMLSerializer().serializeToString(svgElement);
        const blob = new Blob([svgData], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `erd_${Date.now()}.svg`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      }
    }
  }, []);

  if (schema.length === 0) {
    return (
      <div className="absolute inset-0 z-50 bg-[#050505] flex flex-col items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-4" />
        <p className="text-zinc-500 text-sm">Generating ERD Diagram...</p>
      </div>
    );
  }

  const hasForeignKeys = schema.some(t => (t.foreignKeys || []).length > 0);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="absolute inset-0 z-40 bg-[#050505]"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        colorMode="dark"
      >
        <Background color="#1a1a1a" gap={20} />
        <Controls showInteractive={false} className="bg-[#0d0d0d] border-white/10 fill-white" />
        <MiniMap
          nodeColor="#1e40af"
          maskColor="rgba(0,0,0,0.7)"
          style={{ backgroundColor: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)' }}
        />

        {/* Close button */}
        <Panel position="top-right" className="p-4">
          <div className="flex items-center gap-2">
            {/* Export buttons */}
            <Button
              variant="outline"
              size="sm"
              className="bg-[#0d0d0d] border-white/10 hover:bg-white/5 text-xs gap-1"
              onClick={() => exportDiagram('png')}
            >
              <Download className="w-3 h-3" /> PNG
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="bg-[#0d0d0d] border-white/10 hover:bg-white/5 text-xs gap-1"
              onClick={() => exportDiagram('svg')}
            >
              <Download className="w-3 h-3" /> SVG
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={`bg-[#0d0d0d] border-white/10 hover:bg-white/5 text-xs ${compactMode ? 'text-blue-400' : ''}`}
              onClick={() => { setCompactMode(!compactMode); layoutInitRef.current = false; }}
            >
              {compactMode ? 'Detail' : 'Compact'}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="rounded-full bg-[#0d0d0d] border-white/10 hover:bg-white/5"
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </Panel>

        {/* Info panel with stats and search */}
        <Panel position="top-left" className="p-4">
          <div className="bg-[#0d0d0d]/80 backdrop-blur-md border border-white/10 p-3 rounded-xl shadow-2xl space-y-2">
            <h3 className="text-xs font-bold text-white uppercase tracking-widest mb-1 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              ERD Visualizer
            </h3>
            <div className="flex items-center gap-3 text-[10px] text-zinc-500">
              <span>{filteredSchema.length} tables</span>
              <span>{edgeCount} relationships</span>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
              <input
                type="text"
                placeholder="Filter tables..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 bg-white/5 border border-white/10 rounded text-[10px] text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50"
              />
            </div>

            {/* No FK warning */}
            {!hasForeignKeys && (
              <div className="flex items-start gap-1.5 text-[9px] text-amber-500/80">
                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                <span>No FK data available. Showing heuristic relationships (dashed).</span>
              </div>
            )}

            {/* Selected node info */}
            {selectedNode && (
              <div className="text-[10px] text-blue-400 border-t border-white/5 pt-2">
                Selected: <span className="font-mono font-bold">{selectedNode}</span>
                <button onClick={() => setSelectedNode(null)} className="ml-2 text-zinc-600 hover:text-zinc-400">clear</button>
              </div>
            )}
          </div>
        </Panel>
      </ReactFlow>
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
