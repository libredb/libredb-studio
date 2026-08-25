"use client";

import React, { memo, useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { Database, Hash, Key, Link2, Type } from "lucide-react";
import type { ColumnSchema } from "@/lib/types";
import { TABLE_SOURCE_HANDLE, TABLE_TARGET_HANDLE, type TableFlowNode } from "./graph";
import { useDiagramActions } from "./diagram-context";
import { useTableHighlighted } from "./highlight-store";

interface ColumnRowProps {
  column: ColumnSchema;
  isFk: boolean;
  hasSourceHandle: boolean;
  hasTargetHandle: boolean;
}

const ColumnRow = memo(function ColumnRow({ column, isFk, hasSourceHandle, hasTargetHandle }: ColumnRowProps) {
  const tooltip = [
    `${column.name}: ${column.type}`,
    column.isPrimary ? "PRIMARY KEY" : null,
    isFk ? "FOREIGN KEY" : null,
    column.nullable === false ? "NOT NULL" : null,
    column.defaultValue ? `Default: ${column.defaultValue}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className="relative flex items-center justify-between px-2 py-1 text-xs hover:bg-fill rounded transition-colors"
      title={tooltip}
    >
      {hasSourceHandle && (
        <Handle
          type="source"
          position={Position.Right}
          id={`${column.name}-right`}
          isConnectable={false}
          style={{ opacity: 0, right: -5 }}
        />
      )}
      {hasTargetHandle && (
        <Handle
          type="target"
          position={Position.Left}
          id={`${column.name}-left`}
          isConnectable={false}
          style={{ opacity: 0, left: -5 }}
        />
      )}

      <div className="flex items-center gap-2">
        {column.isPrimary ? (
          <Key strokeWidth={1.5} className="w-2.5 h-2.5 text-yellow-500" />
        ) : isFk ? (
          <Link2 strokeWidth={1.5} className="w-2.5 h-2.5 text-blue-400" />
        ) : column.type.toLowerCase().includes("int") ? (
          <Hash strokeWidth={1.5} className="w-2.5 h-2.5 text-fg-muted" />
        ) : (
          <Type strokeWidth={1.5} className="w-2.5 h-2.5 text-fg-muted" />
        )}
        <span
          className={
            column.isPrimary ? "text-yellow-500/90 font-medium" : isFk ? "text-blue-400/80" : "text-fg-tertiary"
          }
        >
          {column.name}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {column.nullable === false && <span className="text-[0.5rem] text-red-500/60">NN</span>}
        <span className="text-[0.625rem] text-fg-subtle font-mono uppercase">{column.type}</span>
      </div>
    </div>
  );
});

export const TableNode = memo(function TableNode({ id, data }: NodeProps<TableFlowNode>) {
  const highlighted = useTableHighlighted(id);
  const { toggleExpand } = useDiagramActions();
  const updateNodeInternals = useUpdateNodeInternals();
  const { table, compact, visibleColumns, hiddenCount, sourceAnchors, targetAnchors } = data;

  // The rendered handle set changes with compact mode, column visibility and
  // FK anchors (which arrive asynchronously via the second-phase relations
  // fetch). React Flow only measures handles on mount or when told to - a
  // missed re-measure means edges to the new handles silently never attach.
  // The signature is a string rather than the arrays themselves because those
  // are rebuilt on every buildGraph run, so depending on them would re-measure
  // on identity-only rebuilds. The effect READS it rather than merely listing
  // it: the signature IS the handle set the effect synchronises React Flow
  // against, and it always carries its three separators, so the guard is true
  // whenever the effect runs.
  const handleSignature = `${compact ? "c" : "d"}|${visibleColumns.length}|${sourceAnchors.join(",")}|${targetAnchors.join(",")}`;
  useEffect(() => {
    if (handleSignature) updateNodeInternals(id);
  }, [id, handleSignature, updateNodeInternals]);

  const sourceSet = new Set(sourceAnchors);
  const targetSet = new Set(targetAnchors);

  return (
    <div
      className={`bg-raised border rounded-lg overflow-hidden min-w-[200px] shadow-2xl transition-all ${
        highlighted ? "border-blue-500/60 ring-1 ring-blue-500/30" : "border-hairline-strong"
      }`}
    >
      <div className="relative bg-blue-600/10 px-3 py-2 border-b border-hairline flex items-center gap-2">
        <Handle
          type="target"
          position={Position.Left}
          id={TABLE_TARGET_HANDLE}
          isConnectable={false}
          style={{ opacity: 0, left: -5 }}
        />
        <Handle
          type="source"
          position={Position.Right}
          id={TABLE_SOURCE_HANDLE}
          isConnectable={false}
          style={{ opacity: 0, right: -5 }}
        />
        <Database strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-xs font-medium text-fg">{table.name}</span>
        <span className="text-[0.625rem] text-fg-subtle ml-auto">{table.columns?.length || 0} cols</span>
      </div>
      {!compact && (
        <div className="p-1">
          {visibleColumns.map((column) => (
            <ColumnRow
              key={column.name}
              column={column}
              isFk={sourceSet.has(column.name)}
              hasSourceHandle={sourceSet.has(column.name)}
              hasTargetHandle={targetSet.has(column.name)}
            />
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="w-full text-left px-2 py-1 text-[0.625rem] text-fg-muted hover:text-fg-secondary transition-colors"
              onClick={() => toggleExpand(table.name)}
            >
              +{hiddenCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
});
