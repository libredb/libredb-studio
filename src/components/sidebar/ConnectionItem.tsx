import React from "react";
import { DatabaseConnection, ENVIRONMENT_LABELS } from "@/lib/types";
import { Lock, Trash2, Pencil, Copy, Star, GripVertical, FolderInput, Check } from "lucide-react";
import { getDBIcon } from "@/lib/db-ui-config";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NO_GROUPS: { id: string; name: string }[] = [];

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
   * The "Move to group" menu (#1170) appears only when a parent hands over `onMoveToGroup`.
   * `currentGroupId` marks the group the connection is in; null means Ungrouped.
   */
  groups?: { id: string; name: string }[];
  currentGroupId?: string | null;
  onMoveToGroup?: (connectionId: string, groupId: string | null) => void;
  onMoveToNewGroup?: (connectionId: string) => void;
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
  groups = NO_GROUPS,
  currentGroupId = null,
  onMoveToGroup,
  onMoveToNewGroup,
  draggable = false,
  isDragging = false,
  isDragOver = false,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: ConnectionItemProps) {
  return (
    <div
      // A real `<button>` cannot wrap the edit/duplicate/delete buttons below (nested
      // buttons are invalid HTML), so the row is a `role="button"` with keyboard support
      // instead. This replaces the `motion.div` that used to hide the same handlers.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="button"
      tabIndex={0}
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
      onKeyDown={(e) => {
        // Only the row's own keys: a keydown bubbling up from one of the buttons below
        // belongs to that button, and preventDefault here would cancel its activation.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(conn);
        }
      }}
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
        <div
          className="absolute left-0 w-1 h-4 rounded-r-full transition-all duration-200"
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
        {onMoveToGroup && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-1 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity hover:bg-brand-tint/20 hover:text-brand"
                aria-label="Move to group"
                title="Move to group"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <FolderInput strokeWidth={1.5} className="w-3 h-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {groups.map((group) => (
                <DropdownMenuItem key={group.id} onSelect={() => onMoveToGroup(conn.id, group.id)}>
                  <Check className={cn("w-3 h-3", currentGroupId !== group.id && "invisible")} />
                  {group.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => onMoveToGroup(conn.id, null)}>
                <Check className={cn("w-3 h-3", currentGroupId !== null && "invisible")} />
                Ungrouped
              </DropdownMenuItem>
              {onMoveToNewGroup && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onMoveToNewGroup(conn.id)}>New group...</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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
            aria-label="Edit connection"
            title="Edit connection"
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
            aria-label="Delete connection"
            title="Delete connection"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(conn.id);
            }}
          >
            <Trash2 strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
});
