import React from 'react';
import { DatabaseConnection, ENVIRONMENT_LABELS } from '@/lib/types';
import { Lock, Trash2, Pencil } from 'lucide-react';
import { getDBIcon } from '@/lib/db-ui-config';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface ConnectionItemProps {
  connection: DatabaseConnection;
  isActive: boolean;
  onSelect: (conn: DatabaseConnection) => void;
  onDelete: (id: string) => void;
  onEdit?: (conn: DatabaseConnection) => void;
}

export const ConnectionItem = React.memo(function ConnectionItem({
  connection: conn,
  isActive,
  onSelect,
  onDelete,
  onEdit,
}: ConnectionItemProps) {
  return (
    <motion.div
      initial={false}
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 text-sm relative overflow-hidden',
        isActive
          ? 'bg-blue-600/10 text-blue-400'
          : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
      )}
      onClick={() => onSelect(conn)}
    >
      {isActive && (
        <motion.div
          layoutId="active-indicator"
          className="absolute left-0 w-1 h-4 rounded-r-full"
          style={{ backgroundColor: conn.color || '#3b82f6' }}
        />
      )}
      <div
        className={cn(
          'p-1 rounded transition-colors',
          isActive ? 'bg-blue-500/20' : 'bg-muted group-hover:bg-accent'
        )}
      >
        {React.createElement(getDBIcon(conn.type), { className: 'w-3 h-3' })}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate block font-medium text-body">{conn.name}</span>
          {conn.environment && conn.environment !== 'other' && (
            <span
              className="text-micro uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-sm shrink-0"
              style={{
                color: conn.color || '#6b7280',
                backgroundColor: `${conn.color || '#6b7280'}15`,
              }}
            >
              {ENVIRONMENT_LABELS[conn.environment]}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
          {conn.managed && (
            <div
              data-testid={`managed-lock-${conn.seedId || conn.id}`}
              className="w-6 h-6 flex items-center justify-center text-amber-500/60"
              title="Managed by administrator"
            >
              <Lock className="w-3 h-3" />
            </div>
          )}
          {!conn.managed && onEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-blue-500/20 hover:text-blue-400"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(conn);
              }}
            >
              <Pencil className="w-3 h-3" />
            </Button>
          )}
          {!conn.managed && (
            <Button
              variant="ghost"
              size="icon"
              className="w-6 h-6 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20 hover:text-red-400"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(conn.id);
              }}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
    </motion.div>
  );
});
