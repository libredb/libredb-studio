import React from "react";
import { DatabaseConnection } from "@/lib/types";
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

export function ConnectionsList({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onDuplicateConnection,
  favoriteConnectionIds,
  onToggleFavoriteConnection,
  onAddConnection,
}: ConnectionsListProps) {
  // Favorited connections render together, above the rest, in their existing relative
  // order. The non-favorited group keeps exactly the order and behaviour it always has -
  // this only ever pulls entries out of it, never reorders or filters what remains.
  const favorites = favoriteConnectionIds?.size ? connections.filter((conn) => favoriteConnectionIds.has(conn.id)) : [];
  const rest = favoriteConnectionIds?.size
    ? connections.filter((conn) => !favoriteConnectionIds.has(conn.id))
    : connections;

  const renderItem = (conn: DatabaseConnection) => (
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
    />
  );

  return (
    <>
      {favorites.length > 0 && (
        <section className="mb-4">
          <SectionHeader label="Favorites" />
          <div className="space-y-0.5">{favorites.map(renderItem)}</div>
        </section>
      )}

      <section>
        <SectionHeader label="Connections" />

        <div className="space-y-0.5">
          {rest.length === 0 && connections.length === 0 ? (
            <div className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-2">
              <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                No database connections established yet.
              </p>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onAddConnection}>
                Add Connection
              </Button>
            </div>
          ) : (
            rest.map(renderItem)
          )}
        </div>
      </section>
    </>
  );
}
