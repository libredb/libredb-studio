'use client';

import React, { useState, useEffect } from 'react';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SchemaSnapshot } from '@/lib/types';

interface SnapshotTimelineProps {
  snapshots: SchemaSnapshot[];
  onCompare: (sourceId: string, targetId: string) => void;
  onDelete: (id: string) => void;
}

export function SnapshotTimeline({ snapshots, onCompare, onDelete }: SnapshotTimelineProps) {
  const [selected, setSelected] = useState<string[]>([]);

  const handleClick = (id: string) => {
    setSelected(prev => {
      if (prev.includes(id)) {
        return prev.filter(s => s !== id);
      }
      if (prev.length >= 2) {
        return [prev[1], id];
      }
      return [...prev, id];
    });
  };

  const canCompare = selected.length === 2;

  useEffect(() => {
    if (canCompare) {
      onCompare(selected[0], selected[1]);
    }
  }, [selected, canCompare, onCompare]);

  if (snapshots.length === 0) {
    return (
      <div className="flex items-center justify-center py-4 text-zinc-600 text-xs">
        No snapshots taken yet. Take a snapshot to start tracking schema changes.
      </div>
    );
  }

  const sorted = [...snapshots].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-2">
        <span className="text-xs uppercase text-zinc-500 font-bold">Timeline</span>
        {canCompare && (
          <span className="text-xs text-blue-400">Comparing 2 snapshots</span>
        )}
      </div>

      {/* Horizontal timeline */}
      <div className="relative flex items-center overflow-x-auto pb-2 px-2 gap-0">
        {/* Timeline line */}
        <div className="absolute top-[18px] left-4 right-4 h-[2px] bg-white/10" />

        {sorted.map((snapshot, idx) => {
          const isSelected = selected.includes(snapshot.id);
          const date = new Date(snapshot.createdAt);

          return (
            <div
              key={snapshot.id}
              className="relative flex flex-col items-center min-w-[100px] cursor-pointer group"
              onClick={() => handleClick(snapshot.id)}
            >
              {/* Dot */}
              <div className={cn(
                "w-4 h-4 rounded-full border-2 z-10 transition-all",
                isSelected
                  ? "bg-blue-500 border-blue-400 scale-125"
                  : "bg-[#0d0d0d] border-white/20 hover:border-white/40"
              )} />

              {/* Connector */}
              {idx < sorted.length - 1 && (
                <div className="absolute top-[7px] left-[50%] w-full h-[2px] bg-white/10" />
              )}

              {/* Label */}
              <div className={cn(
                "mt-2 text-center transition-colors",
                isSelected ? "text-blue-400" : "text-zinc-500 group-hover:text-zinc-300"
              )}>
                <div className="text-xs font-medium truncate max-w-[90px]">
                  {snapshot.label || snapshot.connectionName}
                </div>
                <div className="text-label text-zinc-600">
                  {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <Badge variant="secondary" className="text-label mt-1">
                  {snapshot.schema.length} tables
                </Badge>
              </div>

              {/* Delete button */}
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(snapshot.id); }}
                className="absolute -top-2 -right-1 p-0.5 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="w-2.5 h-2.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
