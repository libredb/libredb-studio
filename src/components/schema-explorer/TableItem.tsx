import React from 'react';
import { TableSchema } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import {
  Search,
  Table as TableIcon,
  Play,
  ChevronRight,
  Filter,
  MoreVertical,
  Copy,
  Trash2,
  Code,
  BarChart3,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
import { ColumnList } from './ColumnList';

interface TableItemProps {
  table: TableSchema;
  isExpanded: boolean;
  onToggle: () => void;
  labels?: ProviderMetadata['labels'];
  isAdmin: boolean;
  onTableClick?: (tableName: string) => void;
  onGenerateSelect?: (tableName: string) => void;
  onProfileTable?: (tableName: string) => void;
  onGenerateCode?: (tableName: string) => void;
  onGenerateTestData?: (tableName: string) => void;
  onOpenMaintenance?: (tab?: 'global' | 'tables' | 'sessions', table?: string) => void;
}

function renderMenuItems(
  table: TableSchema,
  labels: TableItemProps['labels'],
  isAdmin: boolean,
  callbacks: {
    onTableClick?: (tableName: string) => void;
    onGenerateSelect?: (tableName: string) => void;
    onProfileTable?: (tableName: string) => void;
    onGenerateCode?: (tableName: string) => void;
    onGenerateTestData?: (tableName: string) => void;
    onOpenMaintenance?: (tab?: 'global' | 'tables' | 'sessions', table?: string) => void;
  },
  copyToClipboard: (text: string, label: string) => void,
  Item: React.ComponentType<{ onClick?: () => void; children: React.ReactNode }>,
  Separator: React.ComponentType,
): React.ReactNode {
  return (
    <>
      <Item onClick={() => callbacks.onTableClick?.(table.name)}>
        <Play className="w-3.5 h-3.5 mr-2 text-green-500" />
        {labels?.selectAction || 'Select Top 100'}
      </Item>
      <Item onClick={() => callbacks.onGenerateSelect?.(table.name)}>
        <Filter className="w-3.5 h-3.5 mr-2 text-blue-500" />
        {labels?.generateAction || 'Generate Query'}
      </Item>
      <Item onClick={() => copyToClipboard(table.name, `${labels?.entityName || 'Table'} name`)}>
        <Copy className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
        Copy Name
      </Item>
      <Separator />
      <Item onClick={() => callbacks.onProfileTable?.(table.name)}>
        <BarChart3 className="w-3.5 h-3.5 mr-2 text-cyan-500" />
        Profile Table
      </Item>
      <Item onClick={() => callbacks.onGenerateCode?.(table.name)}>
        <Code className="w-3.5 h-3.5 mr-2 text-purple-500" />
        Generate Code
      </Item>
      <Item onClick={() => callbacks.onGenerateTestData?.(table.name)}>
        <Wand2 className="w-3.5 h-3.5 mr-2 text-amber-500" />
        Generate Test Data
      </Item>
      {isAdmin && (
        <>
          <Separator />
          <Item onClick={() => callbacks.onOpenMaintenance?.('tables', table.name)}>
            <Search className="w-3.5 h-3.5 mr-2 text-amber-500" />
            {labels?.analyzeAction || 'Analyze Table'}
          </Item>
          <Item onClick={() => callbacks.onOpenMaintenance?.('tables', table.name)}>
            <Trash2 className="w-3.5 h-3.5 mr-2 text-blue-400" />
            {labels?.vacuumAction || 'Vacuum Table'}
          </Item>
        </>
      )}
    </>
  );
}

export const TableItem = React.memo(function TableItem({
  table,
  isExpanded,
  onToggle,
  labels,
  isAdmin,
  onTableClick,
  onGenerateSelect,
  onProfileTable,
  onGenerateCode,
  onGenerateTestData,
  onOpenMaintenance,
}: TableItemProps) {
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const callbacks = { onTableClick, onGenerateSelect, onProfileTable, onGenerateCode, onGenerateTestData, onOpenMaintenance };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex flex-col">
          <div
            className={cn(
              'flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-all',
              isExpanded ? 'bg-accent/50' : 'hover:bg-accent/30'
            )}
            onClick={onToggle}
          >
            <motion.div
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.2 }}
              className="shrink-0"
            >
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            </motion.div>

            <TableIcon
              className={cn(
                'w-3.5 h-3.5 shrink-0 transition-colors',
                isExpanded ? 'text-blue-400' : 'text-muted-foreground group-hover:text-foreground'
              )}
            />

            <span
              className={cn(
                'truncate min-w-0 flex-1 text-[13px] font-medium transition-colors',
                isExpanded ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
              )}
            >
              {table.name}
            </span>

            <div className="shrink-0 relative w-8 h-6 flex items-center justify-center">
              {table.rowCount !== undefined && (
                <span className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-muted-foreground/70 whitespace-nowrap opacity-100 group-hover:opacity-0 transition-opacity pointer-events-none">
                  {table.rowCount >= 1000 ? `${(table.rowCount / 1000).toFixed(1)}k` : table.rowCount}
                </span>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute inset-0 w-full h-full opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 focus-within:opacity-100 transition-opacity hover:bg-accent"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreVertical className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {renderMenuItems(table, labels, isAdmin, callbacks, copyToClipboard, DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <AnimatePresence>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <ColumnList columns={table.columns} indexes={table.indexes} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {renderMenuItems(table, labels, isAdmin, callbacks, copyToClipboard, ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  );
});
