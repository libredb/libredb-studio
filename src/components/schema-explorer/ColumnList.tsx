import React from 'react';
import { TableSchema } from '@/lib/types';
import { Key, Hash } from 'lucide-react';

interface ColumnListProps {
  columns: TableSchema['columns'];
  indexes: TableSchema['indexes'];
}

export const ColumnList = React.memo(function ColumnList({ columns, indexes }: ColumnListProps) {
  return (
    <div className="pl-6 pr-2 py-1 space-y-0.5 border-l border-border/30 ml-3.5 mt-0.5 mb-1">
      {columns.map((column) => (
        <div
          key={column.name}
          className="flex items-center gap-2 py-1 px-2 rounded-sm group/col hover:bg-accent/20 cursor-default"
        >
          {column.isPrimary ? (
            <Key className="w-2.5 h-2.5 text-yellow-500/70" />
          ) : (
            <div className="w-2.5 h-2.5 flex items-center justify-center">
              <div className="w-1 h-1 rounded-full bg-muted-foreground/50" />
            </div>
          )}

          <span className="text-data text-muted-foreground flex-1 truncate group-hover/col:text-foreground">
            {column.name}
          </span>

          <span className="text-xs font-mono text-muted-foreground/60 uppercase group-hover/col:text-muted-foreground">
            {column.type.split('(')[0]}
          </span>
        </div>
      ))}
      {indexes.length > 0 && (
        <div className="pt-2 pb-1">
          <div className="flex items-center gap-1.5 px-2 mb-1">
            <Hash className="w-2.5 h-2.5 text-purple-500/40" />
            <span className="text-label uppercase tracking-wider font-bold text-muted-foreground">Indexes</span>
          </div>
          {indexes.map(idx => (
            <div key={idx.name} className="flex items-center gap-2 py-0.5 px-2">
              <div className="w-2.5 h-2.5" />
              <span className="text-xs text-muted-foreground italic truncate" title={Array.isArray(idx.columns) ? idx.columns.join(', ') : ''}>
                {idx.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
