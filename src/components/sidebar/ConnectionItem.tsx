import React from "react";
import { DatabaseConnection, ENVIRONMENT_LABELS } from "@/lib/types";
import { Lock, Trash2, Pencil, Copy, Star, GripVertical } from "lucide-react";
import { getDBIcon } from "@/lib/db-ui-config";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface ConnectionItemProps {
  connection: DatabaseConnection;
  isActive: boolean;
  onSelect: (conn: DatabaseConnection) => void;
  onDelete: (id: string) => void;
  onEdit?: (conn: DatabaseConnection) => void;
  onDuplicate?: (conn: DatabaseConnection) => void;
  isFavorite?: boolean;
  onToggleFavorite?: (id: string) => void;
  /**
   * Reordering is opt-in per render: the handle and the `draggable` wiring appear only when
   * a parent hands over a drag id, so a caller that has not wired reordering (or a list of
   * exactly one connection, which `ConnectionsList` withholds it for) gets the pre-#748
   * markup unchanged.
   */
  draggable?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragEnter?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
}

export const ConnectionItem = React.memo(function ConnectionItem({
  connection: conn,
  isActive,
  onSelect,
  onDelete,
  onEdit,
  onDuplicate,
  isFavorite = false,
  onToggleFavorite,
  draggable = false,
  isDragging = false,
  isDragOver = false,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: ConnectionItemProps) {
  return (
    <motion.div
      initial={false}
      draggable={draggable}
      onDragStart={draggable ? () => onDragStart?.() : undefined}
      onDragEnter={draggable ? () => onDragEnter?.() : undefined}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDragEnd={draggable ? () => onDragEnd?.() : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              onDrop?.();
            }
          : undefined
      }
      className={cn(
        "group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 text-xs relative overflow-hidden",
        isActive ? "bg-brand-solid/10 text-brand" : "hover:bg-accent/50 text-muted-foreground hover:text-foreground",
        isDragging && "opacity-40",
        isDragOver && "ring-1 ring-inset ring-brand-solid/50",
      )}
      onClick={() => onSelect(conn)}
    >
      {draggable && (
        <span
          data-testid={`drag-handle-${conn.id}`}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          title="Drag to reorder"
        >
          <GripVertical strokeWidth={1.5} className="w-3 h-3" />
        </span>
      )}
      {isActive && (
        <motion.div
          layoutId="active-indicator"
          className="absolute left-0 w-1 h-4 rounded-r-full"
          style={{ backgroundColor: conn.color || "#3b82f6" }}
        />
      )}
      <div
        className={cn(
          "p-1 rounded transition-colors",
          isActive ? "bg-brand-tint/20" : "bg-muted group-hover:bg-accent",
        )}
      >
        {React.createElement(getDBIcon(conn.type), { className: "w-3 h-3" })}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate block font-medium text-xs">{conn.name}</span>
          {conn.environment && conn.environment !== "other" && (
            <span
              className="text-[0.5rem] font-medium px-1.5 py-0.5 rounded-sm shrink-0"
              style={{
                color: conn.color || "#6b7280",
                backgroundColor: `${conn.color || "#6b7280"}15`,
              }}
            >
              {ENVIRONMENT_LABELS[conn.environment]}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        {onToggleFavorite && (
          <button
            className={cn(
              "p-1 rounded transition-opacity hover:bg-warning/10 hover:text-warning",
              isFavorite
                ? "text-warning opacity-100"
                : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            )}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(conn.id);
            }}
          >
            <Star strokeWidth={1.5} className={cn("w-3 h-3", isFavorite && "fill-current")} />
          </button>
        )}
        {conn.managed && (
          <div
            data-testid={`managed-lock-${conn.seedId || conn.id}`}
            className="flex items-center justify-center text-warning/60"
            title="Managed by administrator"
          >
            <Lock strokeWidth={1.5} className="w-3 h-3" />
          </div>
        )}
        {!conn.managed && onEdit && (
          <button
            className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-brand-tint/20 hover:text-brand"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(conn);
            }}
          >
            <Pencil strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
        {!conn.managed && onDuplicate && (
          <button
            className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-brand-tint/20 hover:text-brand"
            aria-label="Duplicate connection"
            title="Duplicate connection"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate(conn);
            }}
          >
            <Copy strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
        {!conn.managed && (
          <button
            className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger-tint/20 hover:text-danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(conn.id);
            }}
          >
            <Trash2 strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
      </div>
    </motion.div>
  );
});
