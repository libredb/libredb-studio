"use client";

import React, { useMemo } from 'react';
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
  type NodeTypes
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TableSchema } from '@/lib/types';
import { Database, Hash, Type, Key, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

// Custom Node for Database Tables
interface TableNodeData extends Record<string, unknown> {
  table: TableSchema;
}

const TableNode = ({ data }: NodeProps<Node<TableNodeData>>) => {
  const table = (data.data as TableNodeData).table;
  return (
    <div className="bg-[#0d0d0d] border border-white/10 rounded-lg overflow-hidden min-w-[200px] shadow-2xl">
      <div className="bg-blue-600/10 px-3 py-2 border-b border-white/5 flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-xs font-bold text-zinc-100 uppercase tracking-wider">{table.name}</span>
      </div>
      <div className="p-1">
        {table.columns.map((col: { name: string; type: string; isPrimary: boolean }, idx: number) => (
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
              ) : col.type.toLowerCase().includes('int') ? (
                <Hash className="w-2.5 h-2.5 text-zinc-500" />
              ) : (
                <Type className="w-2.5 h-2.5 text-zinc-500" />
              )}
              <span className={col.isPrimary ? "text-yellow-500/90 font-medium" : "text-zinc-400"}>
                {col.name}
              </span>
            </div>
            <span className="text-[9px] text-zinc-600 font-mono uppercase">{col.type}</span>
          </div>
        ))}
      </div>
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

export function SchemaDiagram({ schema, onClose }: SchemaDiagramProps) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node<TableNodeData>[] = schema.map((table, index) => ({
      id: table.name,
      type: 'table' as const,
      position: { x: (index % 3) * 300, y: Math.floor(index / 3) * 400 },
      data: { table } as TableNodeData,
    }));

    // Simple edge detection based on naming conventions (e.g., user_id -> users.id)
    const edges: Edge[] = [];
    schema.forEach(table => {
      table.columns.forEach(col => {
        if (col.name.endsWith('_id')) {
          const targetTable = col.name.replace('_id', '') + 's';
          const target = schema.find(t => t.name === targetTable || t.name === col.name.replace('_id', ''));
          
          if (target) {
            edges.push({
              id: `${table.name}-${target.name}`,
              source: table.name,
              target: target.name,
              sourceHandle: `${col.name}-right`,
              targetHandle: `id-left`,
              animated: true,
              style: { stroke: '#3b82f6', strokeWidth: 1.5, opacity: 0.4 },
            });
          }
        }
      });
    });

    return { nodes, edges };
  }, [schema]);

  if (schema.length === 0) {
    return (
      <div className="absolute inset-0 z-50 bg-[#050505] flex flex-col items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-4" />
        <p className="text-zinc-500 text-sm">Generating ERD Diagram...</p>
      </div>
    );
  }

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
        fitView
        colorMode="dark"
      >
        <Background color="#1a1a1a" gap={20} />
        <Controls showInteractive={false} className="bg-[#0d0d0d] border-white/10 fill-white" />
        <Panel position="top-right" className="p-4">
          <Button 
            variant="outline" 
            size="icon" 
            className="rounded-full bg-[#0d0d0d] border-white/10 hover:bg-white/5"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </Button>
        </Panel>
        <Panel position="top-left" className="p-4">
          <div className="bg-[#0d0d0d]/80 backdrop-blur-md border border-white/10 p-3 rounded-xl shadow-2xl">
            <h3 className="text-xs font-bold text-white uppercase tracking-widest mb-1 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              ERD Visualizer
            </h3>
            <p className="text-[10px] text-zinc-500 max-w-[150px]">
              Visualizing {schema.length} tables and detected relationships.
            </p>
          </div>
        </Panel>
      </ReactFlow>
    </motion.div>
  );
}
