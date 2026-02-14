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

  return (
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

        {table.rowCount !== undefined && (
          <span className="shrink-0 text-[9px] font-mono text-muted-foreground/70 whitespace-nowrap">
            {table.rowCount >= 1000 ? `${(table.rowCount / 1000).toFixed(1)}k` : table.rowCount}
          </span>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 w-6 h-6 hover:bg-accent"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => onTableClick?.(table.name)}>
              <Play className="w-3.5 h-3.5 mr-2 text-green-500" />
              {labels?.selectAction || 'Select Top 100'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onGenerateSelect?.(table.name)}>
              <Filter className="w-3.5 h-3.5 mr-2 text-blue-500" />
              {labels?.generateAction || 'Generate Query'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => copyToClipboard(table.name, `${labels?.entityName || 'Table'} name`)}>
              <Copy className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
              Copy Name
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onProfileTable?.(table.name)}>
              <BarChart3 className="w-3.5 h-3.5 mr-2 text-cyan-500" />
              Profile Table
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onGenerateCode?.(table.name)}>
              <Code className="w-3.5 h-3.5 mr-2 text-purple-500" />
              Generate Code
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onGenerateTestData?.(table.name)}>
              <Wand2 className="w-3.5 h-3.5 mr-2 text-amber-500" />
              Generate Test Data
            </DropdownMenuItem>
            {isAdmin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onOpenMaintenance?.('tables', table.name)}>
                  <Search className="w-3.5 h-3.5 mr-2 text-amber-500" />
                  {labels?.analyzeAction || 'Analyze Table'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenMaintenance?.('tables', table.name)}>
                  <Trash2 className="w-3.5 h-3.5 mr-2 text-blue-400" />
                  {labels?.vacuumAction || 'Vacuum Table'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
  );
});
