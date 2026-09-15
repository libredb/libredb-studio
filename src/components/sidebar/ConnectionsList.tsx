import React, { useCallback, useState } from "react";
import { DatabaseConnection } from "@/lib/types";
import { applyConnectionOrder } from "@/lib/connection-order";
import { Button } from "@/components/ui/button";
import { ConnectionItem } from "./ConnectionItem";

interface ConnectionsListProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: DatabaseConnection) => void;
  onDuplicateConnection?: (conn: DatabaseConnection) => void;
  /** Connection ids the user has starred. Renders as a "Favorites" group above the rest. */
  favoriteConnectionIds?: Set<string>;
  onToggleFavoriteConnection?: (id: string) => void;
  /** The user's saved custom order (#748). Absent means reordering is not wired up. */
  connectionOrder?: string[];
  /** Persists a new full order after a drag-and-drop completes. */
  onReorderConnections?: (order: string[]) => void;
  onAddConnection: () => void;
}

/** Section header matching the "Connections" label + divider style already used below. */
function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 mb-2 flex items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="h-[1px] flex-1 bg-border/30 ml-3" />
    </div>
  );
}

/** Whether two connections render in the same section: both favorited, or neither. */
function inSameSection(favoriteConnectionIds: Set<string> | undefined, a: string, b: string): boolean {
  return (favoriteConnectionIds?.has(a) ?? false) === (favoriteConnectionIds?.has(b) ?? false);
}

export function ConnectionsList({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onDuplicateConnection,
  favoriteConnectionIds,
  onToggleFavoriteConnection,
  connectionOrder,
  onReorderConnections,
  onAddConnection,
}: ConnectionsListProps) {
  const ordered = applyConnectionOrder(connections, connectionOrder ?? []);
  const reorderable = onReorderConnections !== undefined;

  // Favorited connections render together, above the rest. Both sections are cut from the
  // one saved order, so each keeps the user's order within itself.
  const favorites = favoriteConnectionIds?.size ? ordered.filter((conn) => favoriteConnectionIds.has(conn.id)) : [];
  const rest = favoriteConnectionIds?.size ? ordered.filter((conn) => !favoriteConnectionIds.has(conn.id)) : ordered;

  // Drag state lives here, not in ConnectionItem: a drop needs the full ordered list to
  // compute the new order, and only this component holds it.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const clearDragState = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const handleDrop = (targetId: string) => {
    // A drop across the Favorites/Connections boundary is ignored. The dragged row stays in
    // its own section either way, so accepting it would only change the saved order in a way
    // nothing on screen shows.
    if (draggedId !== null && draggedId !== targetId && inSameSection(favoriteConnectionIds, draggedId, targetId)) {
      const ids = ordered.map((c) => c.id);
      const fromIndex = ids.indexOf(draggedId);
      const toIndex = ids.indexOf(targetId);
      if (fromIndex !== -1 && toIndex !== -1) {
        const reordered = [...ids];
        const [moved] = reordered.splice(fromIndex, 1);
        reordered.splice(toIndex, 0, moved);
        onReorderConnections?.(reordered);
      }
    }
    clearDragState();
  };

  const renderItem = (conn: DatabaseConnection, section: DatabaseConnection[]) => (
    <ConnectionItem
      key={conn.id}
      connection={conn}
      isActive={activeConnection?.id === conn.id}
      onSelect={onSelectConnection}
      onDelete={onDeleteConnection}
      onEdit={onEditConnection}
      onDuplicate={onDuplicateConnection}
      isFavorite={favoriteConnectionIds?.has(conn.id) ?? false}
      onToggleFavorite={onToggleFavoriteConnection}
      draggable={reorderable && section.length > 1}
      isDragging={draggedId === conn.id}
      isDragOver={
        dragOverId === conn.id &&
        draggedId !== null &&
        draggedId !== conn.id &&
        inSameSection(favoriteConnectionIds, draggedId, conn.id)
      }
      onDragStart={() => setDraggedId(conn.id)}
      onDragEnter={() => setDragOverId(conn.id)}
      onDragEnd={clearDragState}
      onDrop={() => handleDrop(conn.id)}
    />
  );

  return (
    <>
      {favorites.length > 0 && (
        <section className="mb-4">
          <SectionHeader label="Favorites" />
          <div className="space-y-0.5">{favorites.map((conn) => renderItem(conn, favorites))}</div>
        </section>
      )}

      {(rest.length > 0 || connections.length === 0) && (
        <section>
          <SectionHeader label="Connections" />

          <div className="space-y-0.5">
            {connections.length === 0 ? (
              <div className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-2">
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  No database connections established yet.
                </p>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAddConnection}>
                  Add Connection
                </Button>
              </div>
            ) : (
              rest.map((conn) => renderItem(conn, rest))
            )}
          </div>
        </section>
      )}
    </>
  );
}
