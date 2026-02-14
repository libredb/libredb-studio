'use client';

import { useState, useCallback } from 'react';
import type { DatabaseConnection, QueryTab } from '@/lib/types';
import type { CellChange } from '@/components/ResultsGrid';
import { useToast } from '@/hooks/use-toast';

interface UseInlineEditingParams {
  activeConnection: DatabaseConnection | null;
  currentTab: QueryTab;
  executeQuery: (sql: string) => void;
}

export function useInlineEditing({
  activeConnection,
  currentTab,
  executeQuery,
}: UseInlineEditingParams) {
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<CellChange[]>([]);
  const { toast } = useToast();

  const handleCellChange = useCallback((change: CellChange) => {
    setPendingChanges(prev => {
      // Replace existing change for same cell, or add new
      const existing = prev.findIndex(c => c.rowIndex === change.rowIndex && c.columnId === change.columnId);
      if (existing >= 0) {
        // If reverting to original value, remove the change
        if (String(change.originalValue ?? '') === change.newValue) {
          return prev.filter((_, i) => i !== existing);
        }
        const updated = [...prev];
        updated[existing] = change;
        return updated;
      }
      // Don't add if no actual change
      if (String(change.originalValue ?? '') === change.newValue) return prev;
      return [...prev, change];
    });
  }, []);

  const handleApplyChanges = useCallback(async () => {
    if (!activeConnection || !currentTab.result || pendingChanges.length === 0) return;

    // Detect primary key column
    const pkColumn = currentTab.result.fields.find(f =>
      f.toLowerCase() === 'id' || f.toLowerCase().endsWith('_id')
    );

    if (!pkColumn) {
      toast({
        title: "Cannot Apply Changes",
        description: "No primary key column detected (id or *_id). Edit the SQL manually.",
        variant: "destructive",
      });
      return;
    }

    // Group changes by row
    const changesByRow = new Map<number, CellChange[]>();
    for (const change of pendingChanges) {
      const existing = changesByRow.get(change.rowIndex) || [];
      existing.push(change);
      changesByRow.set(change.rowIndex, existing);
    }

    // Detect table name from current tab or query
    const tableName = currentTab.name.replace(/^Query[:  ]*/, '') ||
      currentTab.query.match(/FROM\s+(\S+)/i)?.[1] || 'table_name';

    // Generate UPDATE statements
    const statements: string[] = [];
    for (const [rowIndex, changes] of changesByRow) {
      const row = currentTab.result.rows[rowIndex];
      const pkValue = row[pkColumn];
      const setClauses = changes.map(c => {
        const val = c.newValue === '' || c.newValue.toUpperCase() === 'NULL'
          ? 'NULL'
          : `'${c.newValue.replace(/'/g, "''")}'`;
        return `${c.columnId} = ${val}`;
      });
      const pkVal = typeof pkValue === 'number' ? pkValue : `'${pkValue}'`;
      statements.push(`UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${pkColumn} = ${pkVal};`);
    }

    const sql = statements.join('\n');
    // Execute the UPDATE(s)
    executeQuery(sql);
    setPendingChanges([]);
    setEditingEnabled(false);
    toast({
      title: "Changes Applied",
      description: `${statements.length} UPDATE statement(s) executed.`,
    });
  }, [activeConnection, currentTab, pendingChanges, executeQuery, toast]);

  const handleDiscardChanges = useCallback(() => {
    setPendingChanges([]);
  }, []);

  return {
    editingEnabled,
    setEditingEnabled,
    pendingChanges,
    handleCellChange,
    handleApplyChanges,
    handleDiscardChanges,
  };
}
