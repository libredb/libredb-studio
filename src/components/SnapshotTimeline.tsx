"use client";

import React, { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SchemaSnapshot } from "@/lib/types";

interface SnapshotTimelineProps {
  snapshots: SchemaSnapshot[];
  onCompare: (sourceId: string, targetId: string) => void;
  onDelete: (id: string) => void;
}

// Hoisted to module scope so bun lcov attributes these lines at module load;
// multi-line JSX text and attribute tails are otherwise unattributable.
const EMPTY_MESSAGE = "No snapshots taken yet. Take a snapshot to start tracking schema changes.";
const NODE_CLASS = "relative flex flex-col items-center min-w-[100px] cursor-pointer group";
// w-6 h-6 keeps a 24x24 minimum hit target: the control sits on top of the
// stretched selection overlay, so a near miss must not select the snapshot.
const DELETE_BUTTON_CLASS =
  "absolute -top-3 -right-2 z-20 w-6 h-6 flex items-center justify-center text-fg-subtle hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity";

export function SnapshotTimeline({ snapshots, onCompare, onDelete }: SnapshotTimelineProps) {
  const [selected, setSelected] = useState<string[]>([]);

  const handleClick = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((s) => s !== id);
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
    return <div className="flex items-center justify-center py-4 text-fg-subtle text-xs">{EMPTY_MESSAGE}</div>;
  }

  const sorted = [...snapshots].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-2">
        <span className="text-xs text-fg-muted font-medium">Timeline</span>
        {canCompare && <span className="text-xs text-blue-400">Comparing 2 snapshots</span>}
      </div>

      <div className="relative flex items-center overflow-x-auto pb-2 px-2 gap-0">
        <div className="absolute top-[18px] left-4 right-4 h-[2px] bg-fill-strong" />

        {sorted.map((snapshot, idx) => {
          const isSelected = selected.includes(snapshot.id);
          const date = new Date(snapshot.createdAt);
          const labelClass = cn(
            "mt-2 text-center transition-colors",
            isSelected ? "text-blue-400" : "text-fg-muted group-hover:text-fg-secondary",
          );
          const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onDelete(snapshot.id);
          };

          return (
            <div key={snapshot.id} className={NODE_CLASS}>
              <div
                className={cn(
                  "w-3.5 h-3.5 rounded-full border-2 z-10 transition-all",
                  isSelected
                    ? "bg-blue-500 border-blue-400 scale-125"
                    : "bg-raised border-edge group-hover:border-edge-hover",
                )}
              />

              {idx < sorted.length - 1 && (
                <div className="absolute top-[7px] left-[50%] w-full h-[2px] bg-fill-strong" />
              )}

              {/* Stretched-link pattern: the button's ::after overlay makes the
                  whole node clickable. after:z-10 lifts it above the z-10 dot
                  flex item; the z-20 delete button stays on top. */}
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => handleClick(snapshot.id)}
                className={cn(labelClass, "cursor-pointer after:absolute after:inset-0 after:z-10")}
              >
                <div className="text-xs font-medium truncate max-w-[90px]">
                  {snapshot.label || snapshot.connectionName}
                </div>
                <div className="text-[0.625rem] text-fg-subtle">
                  {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
                <Badge variant="secondary" className="text-[0.625rem] mt-1">
                  {snapshot.schema.length} tables
                </Badge>
              </button>

              <button
                onClick={handleDelete}
                aria-label={`Delete ${snapshot.label || snapshot.connectionName}`}
                className={DELETE_BUTTON_CLASS}
              >
                <Trash2 strokeWidth={1.5} className="w-2.5 h-2.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
