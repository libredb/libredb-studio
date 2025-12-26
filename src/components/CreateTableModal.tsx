"use client";

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { 
  Plus, 
  Trash2, 
  Table as TableIcon, 
  Type, 
  Settings2,
  Loader2
} from 'lucide-react';
import { toast } from 'sonner';

interface ColumnDefinition {
  name: string;
  type: string;
  isPrimary: boolean;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue: string;
}

interface CreateTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTableCreated: (sql: string) => void;
  dbType?: string;
}

const DATA_TYPES = [
  'VARCHAR(255)',
  'TEXT',
  'INTEGER',
  'BIGINT',
  'BOOLEAN',
  'TIMESTAMP',
  'DATE',
  'JSONB',
  'UUID',
  'DECIMAL(10,2)',
];

export function CreateTableModal({ isOpen, onClose, onTableCreated }: CreateTableModalProps) {
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<ColumnDefinition[]>([
    { name: 'id', type: 'SERIAL', isPrimary: true, isNullable: false, isUnique: true, defaultValue: '' }
  ]);
  const [isSubmitting] = useState(false);

  const addColumn = () => {
    setColumns([...columns, { 
      name: '', 
      type: 'VARCHAR(255)', 
      isPrimary: false, 
      isNullable: true, 
      isUnique: false, 
      defaultValue: '' 
    }]);
  };

  const removeColumn = (index: number) => {
    if (columns.length === 1) return;
    setColumns(columns.filter((_, i) => i !== index));
  };

  const updateColumn = (index: number, updates: Partial<ColumnDefinition>) => {
    setColumns(columns.map((col, i) => i === index ? { ...col, ...updates } : col));
  };

  const generateSQL = () => {
    if (!tableName.trim()) return '';

    const colDefs = columns.map(col => {
      let def = `${col.name} ${col.type}`;
      if (col.isPrimary) def += ' PRIMARY KEY';
      if (!col.isNullable && !col.isPrimary) def += ' NOT NULL';
      if (col.isUnique && !col.isPrimary) def += ' UNIQUE';
      if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
      return `  ${def}`;
    });

    return `CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`;
  };

  const handleCreate = async () => {
    if (!tableName.trim()) {
      toast.error('Table name is required');
      return;
    }

    const emptyCols = columns.filter(c => !c.name.trim());
    if (emptyCols.length > 0) {
      toast.error('All columns must have a name');
      return;
    }

    const sql = generateSQL();
    onTableCreated(sql);
    onClose();
    setTableName('');
    setColumns([{ name: 'id', type: 'SERIAL', isPrimary: true, isNullable: false, isUnique: true, defaultValue: '' }]);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl bg-zinc-950 border-white/10 text-zinc-100 p-0 overflow-hidden flex flex-col max-h-[90vh]">
        <DialogHeader className="px-6 py-4 border-b border-white/5 bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <TableIcon className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <DialogTitle className="text-xl font-bold tracking-tight">Create New Table</DialogTitle>
              <p className="text-xs text-zinc-500 mt-1 uppercase tracking-widest font-medium">Define schema structure</p>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
          {/* Table Name Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-blue-500/50" />
              <Label className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">General Settings</Label>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tableName" className="text-xs font-medium text-zinc-400">Table Name</Label>
              <Input
                id="tableName"
                placeholder="e.g. customers, orders, analytics_logs"
                value={tableName}
                onChange={(e) => setTableName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                className="bg-zinc-900 border-white/5 focus-visible:ring-blue-500/50"
              />
            </div>
          </div>

          {/* Columns Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Type className="w-4 h-4 text-emerald-500/50" />
                <Label className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Column Definitions</Label>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={addColumn}
                className="h-7 text-[10px] uppercase tracking-widest font-bold gap-2 hover:bg-emerald-500/10 hover:text-emerald-400"
              >
                <Plus className="w-3 h-3" /> Add Column
              </Button>
            </div>

            <div className="space-y-3">
              {columns.map((col, index) => (
                <div 
                  key={index} 
                  className="flex items-end gap-3 p-3 rounded-lg bg-zinc-900/30 border border-white/5 group hover:border-white/10 transition-colors"
                >
                  <div className="flex-1 space-y-2">
                    <Label className="text-[10px] text-zinc-500 uppercase font-bold">Column Name</Label>
                    <Input
                      value={col.name}
                      onChange={(e) => updateColumn(index, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                      placeholder="column_name"
                      className="h-8 text-xs bg-zinc-950 border-white/5"
                    />
                  </div>

                  <div className="w-40 space-y-2">
                    <Label className="text-[10px] text-zinc-500 uppercase font-bold">Type</Label>
                    <Select 
                      value={col.type} 
                      onValueChange={(val) => updateColumn(index, { type: val })}
                    >
                      <SelectTrigger className="h-8 text-xs bg-zinc-950 border-white/5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-zinc-950 border-white/10">
                        {DATA_TYPES.map(t => (
                          <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                        ))}
                        {col.isPrimary && <SelectItem value="SERIAL" className="text-xs text-yellow-500">SERIAL (Auto-Inc)</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-4 pb-2 px-2">
                    <div className="flex flex-col items-center gap-1.5" title="Primary Key">
                      <Label className="text-[8px] text-zinc-600 uppercase font-black">PK</Label>
                      <Checkbox 
                        checked={col.isPrimary} 
                        onCheckedChange={(checked) => updateColumn(index, { 
                          isPrimary: !!checked,
                          isNullable: checked ? false : col.isNullable 
                        })}
                        className="border-white/20 data-[state=checked]:bg-yellow-500 data-[state=checked]:border-yellow-500"
                      />
                    </div>
                    <div className="flex flex-col items-center gap-1.5" title="Nullable">
                      <Label className="text-[8px] text-zinc-600 uppercase font-black">Null</Label>
                      <Checkbox 
                        checked={col.isNullable} 
                        onCheckedChange={(checked) => updateColumn(index, { isNullable: !!checked })}
                        className="border-white/20 data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500"
                      />
                    </div>
                    <div className="flex flex-col items-center gap-1.5" title="Unique">
                      <Label className="text-[8px] text-zinc-600 uppercase font-black">Unq</Label>
                      <Checkbox 
                        checked={col.isUnique} 
                        onCheckedChange={(checked) => updateColumn(index, { isUnique: !!checked })}
                        className="border-white/20 data-[state=checked]:bg-purple-500 data-[state=checked]:border-purple-500"
                      />
                    </div>
                  </div>

                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-8 w-8 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 mb-0.5"
                    onClick={() => removeColumn(index)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Preview Section */}
          <div className="p-4 rounded-lg bg-black border border-white/5 font-mono">
             <div className="flex items-center justify-between mb-3">
               <div className="flex items-center gap-2">
                 <div className="w-2 h-2 rounded-full bg-blue-500" />
                 <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-widest">SQL Preview</span>
               </div>
               <span className="text-[9px] text-zinc-700">Auto-generated</span>
             </div>
             <pre className="text-xs text-blue-400/80 whitespace-pre-wrap leading-relaxed">
               {generateSQL() || '-- Name your table to see SQL'}
             </pre>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-white/5 bg-zinc-900/50">
          <Button variant="ghost" onClick={onClose} className="text-xs text-zinc-400 hover:text-white">
            Cancel
          </Button>
          <Button 
            onClick={handleCreate} 
            disabled={isSubmitting || !tableName}
            className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold gap-2 px-6"
          >
            {isSubmitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            CREATE TABLE
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
