import React from 'react';
import { DatabaseConnection } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { ConnectionItem } from './ConnectionItem';

interface ConnectionsListProps {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  onSelectConnection: (conn: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onEditConnection?: (conn: DatabaseConnection) => void;
  onAddConnection: () => void;
}

export function ConnectionsList({
  connections,
  activeConnection,
  onSelectConnection,
  onDeleteConnection,
  onEditConnection,
  onAddConnection,
}: ConnectionsListProps) {
  return (
    <section>
      <div className="px-3 mb-2 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-[0.15em] text-muted-foreground">
          Connections
        </span>
        <div className="h-[1px] flex-1 bg-border/30 ml-3" />
      </div>

      <div className="space-y-0.5">
        {connections.length === 0 ? (
          <div className="px-3 py-6 text-center border border-dashed border-border/50 rounded-lg mx-2">
            <p className="text-body text-muted-foreground mb-3 leading-relaxed">
              No database connections established yet.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onAddConnection}
            >
              Add Connection
            </Button>
          </div>
        ) : (
          connections.map((conn) => (
            <ConnectionItem
              key={conn.id}
              connection={conn}
              isActive={activeConnection?.id === conn.id}
              onSelect={onSelectConnection}
              onDelete={onDeleteConnection}
              onEdit={onEditConnection}
            />
          ))
        )}
      </div>
    </section>
  );
}
