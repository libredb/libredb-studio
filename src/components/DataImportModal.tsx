"use client";

import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Upload,
  FileSpreadsheet,
  FileJson,
  FileText,
  Check,
  AlertTriangle,
  Table2,
  ArrowRight,
  Loader2,
  X,
} from 'lucide-react';
import type { TableSchema } from '@/lib/types';

interface DataImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (sql: string) => void;
  tables: TableSchema[];
  databaseType?: string;
}

interface ParsedData {
  headers: string[];
  rows: string[][];
  totalRows: number;
}

type ImportStep = 'upload' | 'preview' | 'configure' | 'ready';

function parseCSV(text: string): ParsedData {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return { headers: [], rows: [], totalRows: 0 };

  // Parse CSV with basic quote handling
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inQuotes) {
        inQuotes = true;
      } else if (ch === '"' && inQuotes) {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(line => parseLine(line));
  return { headers, rows, totalRows: rows.length };
}

function parseJSON(text: string): ParsedData {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) return { headers: [], rows: [], totalRows: 0 };

  const headers = [...new Set(arr.flatMap(obj => Object.keys(obj)))];
  const rows = arr.map(obj => headers.map(h => {
    const val = obj[h];
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }));

  return { headers, rows, totalRows: rows.length };
}

function inferSqlType(values: string[]): string {
  const nonEmpty = values.filter(v => v !== '' && v !== null);
  if (nonEmpty.length === 0) return 'TEXT';

  const allIntegers = nonEmpty.every(v => /^-?\d+$/.test(v));
  if (allIntegers) return 'INTEGER';

  const allNumbers = nonEmpty.every(v => /^-?\d+(\.\d+)?$/.test(v));
  if (allNumbers) return 'NUMERIC';

  const allBooleans = nonEmpty.every(v => /^(true|false|0|1)$/i.test(v));
  if (allBooleans) return 'BOOLEAN';

  return 'TEXT';
}

function escapeSQL(value: string): string {
  if (value === '' || value === 'null' || value === 'NULL') return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

export function DataImportModal({ isOpen, onClose, onImport, tables, databaseType }: DataImportModalProps) {
  const [step, setStep] = useState<ImportStep>('upload');
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<'csv' | 'json'>('csv');
  const [targetTable, setTargetTable] = useState('');
  const [createNewTable, setCreateNewTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setStep('upload');
    setParsedData(null);
    setFileName('');
    setTargetTable('');
    setCreateNewTable(false);
    setNewTableName('');
    setColumnMapping({});
    setError(null);
    setIsImporting(false);
  }, []);

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleFileSelect = useCallback((file: File) => {
    setError(null);
    setFileName(file.name);

    const ext = file.name.split('.').pop()?.toLowerCase();
    const isJSON = ext === 'json';
    setFileType(isJSON ? 'json' : 'csv');

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = isJSON ? parseJSON(text) : parseCSV(text);

        if (data.headers.length === 0) {
          setError('No data found in file');
          return;
        }

        setParsedData(data);
        // Auto-map columns 1:1
        const mapping: Record<string, string> = {};
        data.headers.forEach(h => { mapping[h] = h; });
        setColumnMapping(mapping);
        setStep('preview');
      } catch (err) {
        setError(`Failed to parse file: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const generatedSQL = useMemo(() => {
    if (!parsedData) return '';

    const tableName = createNewTable ? (newTableName || 'imported_data') : targetTable;
    if (!tableName) return '';

    const statements: string[] = [];

    // CREATE TABLE if new
    if (createNewTable) {
      const colDefs = parsedData.headers.map(h => {
        const colValues = parsedData.rows.slice(0, 100).map(r => r[parsedData.headers.indexOf(h)]);
        const sqlType = inferSqlType(colValues);
        const colName = columnMapping[h] || h;
        return `  ${colName} ${sqlType}`;
      });
      statements.push(`CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`);
    }

    // INSERT statements (batch in groups of 100)
    const mappedHeaders = parsedData.headers.map(h => columnMapping[h] || h);
    const batchSize = 100;

    for (let i = 0; i < parsedData.rows.length; i += batchSize) {
      const batch = parsedData.rows.slice(i, i + batchSize);
      const valueRows = batch.map(row => {
        const values = row.map((val, idx) => {
          const sqlType = inferSqlType(parsedData.rows.slice(0, 100).map(r => r[idx]));
          if (val === '' || val === 'NULL' || val === 'null') return 'NULL';
          if (sqlType === 'INTEGER' || sqlType === 'NUMERIC' || sqlType === 'BOOLEAN') {
            if (sqlType === 'BOOLEAN') return val.toLowerCase() === 'true' || val === '1' ? 'TRUE' : 'FALSE';
            return val;
          }
          return escapeSQL(val);
        });
        return `  (${values.join(', ')})`;
      });

      statements.push(
        `INSERT INTO ${tableName} (${mappedHeaders.join(', ')})\nVALUES\n${valueRows.join(',\n')};`
      );
    }

    return statements.join('\n\n');
  }, [parsedData, targetTable, createNewTable, newTableName, columnMapping]);

  const handleImport = () => {
    if (!generatedSQL) return;
    setIsImporting(true);
    onImport(generatedSQL);
    setTimeout(() => {
      handleClose();
    }, 200);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="bg-[#0a0a0a] border-white/10 text-zinc-100 max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-blue-400" />
            Import Data
            {fileName && (
              <span className="text-xs text-zinc-500 font-normal ml-2">
                {fileName}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Step Indicator */}
        <div className="flex items-center gap-2 px-1 py-2">
          {(['upload', 'preview', 'configure', 'ready'] as ImportStep[]).map((s, idx) => (
            <React.Fragment key={s}>
              <div className={cn(
                "flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
                step === s ? "text-blue-400" : idx < ['upload', 'preview', 'configure', 'ready'].indexOf(step) ? "text-emerald-400" : "text-zinc-600"
              )}>
                <div className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center text-[9px]",
                  step === s ? "bg-blue-500/20 border border-blue-500/40" :
                  idx < ['upload', 'preview', 'configure', 'ready'].indexOf(step) ? "bg-emerald-500/20 border border-emerald-500/40" :
                  "bg-white/5 border border-white/10"
                )}>
                  {idx < ['upload', 'preview', 'configure', 'ready'].indexOf(step) ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    idx + 1
                  )}
                </div>
                <span className="hidden sm:inline">{s === 'upload' ? 'Upload' : s === 'preview' ? 'Preview' : s === 'configure' ? 'Configure' : 'Import'}</span>
              </div>
              {idx < 3 && <ArrowRight className="w-3 h-3 text-zinc-700" />}
            </React.Fragment>
          ))}
        </div>

        <div className="flex-1 overflow-auto min-h-0">
          {/* Step 1: Upload */}
          {step === 'upload' && (
            <div className="p-4">
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-white/10 rounded-xl p-12 text-center cursor-pointer hover:border-blue-500/30 hover:bg-blue-500/5 transition-all"
              >
                <Upload className="w-10 h-10 text-zinc-600 mx-auto mb-4" />
                <p className="text-sm text-zinc-400 mb-1">
                  Drop a file here or click to browse
                </p>
                <p className="text-xs text-zinc-600">
                  Supports CSV and JSON files
                </p>
                <div className="flex items-center justify-center gap-4 mt-4">
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <FileSpreadsheet className="w-4 h-4" />
                    <span className="text-[10px]">CSV</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <FileJson className="w-4 h-4" />
                    <span className="text-[10px]">JSON</span>
                  </div>
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json,.tsv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
              />
              {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span className="text-xs text-red-400">{error}</span>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Preview */}
          {step === 'preview' && parsedData && (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {fileType === 'json' ? (
                    <FileJson className="w-5 h-5 text-amber-400" />
                  ) : (
                    <FileText className="w-5 h-5 text-emerald-400" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{fileName}</p>
                    <p className="text-[10px] text-zinc-500">
                      {parsedData.totalRows} rows, {parsedData.headers.length} columns
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-zinc-500"
                  onClick={() => { resetState(); }}
                >
                  <X className="w-3 h-3 mr-1" /> Reset
                </Button>
              </div>

              {/* Preview Table */}
              <div className="border border-white/5 rounded-lg overflow-auto max-h-60">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#0d0d0d]">
                      {parsedData.headers.map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-zinc-500 font-mono border-b border-white/5 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsedData.rows.slice(0, 10).map((row, idx) => (
                      <tr key={idx} className="border-b border-white/5 hover:bg-white/[0.02]">
                        {row.map((cell, cidx) => (
                          <td key={cidx} className="px-3 py-1.5 text-zinc-300 font-mono whitespace-nowrap max-w-[200px] truncate">
                            {cell || <span className="text-zinc-600 italic">NULL</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedData.totalRows > 10 && (
                  <div className="text-center py-2 text-[10px] text-zinc-600 bg-[#0d0d0d]">
                    ... and {parsedData.totalRows - 10} more rows
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-500 h-8 text-xs gap-1"
                  onClick={() => setStep('configure')}
                >
                  Configure Import <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Configure */}
          {step === 'configure' && parsedData && (
            <div className="p-4 space-y-4">
              {/* Target Table */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-400 font-medium">Target Table</label>
                <div className="flex items-center gap-2">
                  <button
                    className={cn(
                      "flex-1 px-3 py-2 rounded-lg border text-xs text-left transition-all",
                      !createNewTable ? "border-blue-500/40 bg-blue-500/10 text-blue-400" : "border-white/10 text-zinc-500 hover:bg-white/5"
                    )}
                    onClick={() => setCreateNewTable(false)}
                  >
                    <Table2 className="w-4 h-4 mb-1" />
                    Existing Table
                  </button>
                  <button
                    className={cn(
                      "flex-1 px-3 py-2 rounded-lg border text-xs text-left transition-all",
                      createNewTable ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-white/10 text-zinc-500 hover:bg-white/5"
                    )}
                    onClick={() => setCreateNewTable(true)}
                  >
                    <FileSpreadsheet className="w-4 h-4 mb-1" />
                    New Table
                  </button>
                </div>
              </div>

              {createNewTable ? (
                <div>
                  <label className="text-xs text-zinc-400">New Table Name</label>
                  <Input
                    value={newTableName}
                    onChange={(e) => setNewTableName(e.target.value)}
                    placeholder="imported_data"
                    className="mt-1 bg-[#111] border-white/10 text-sm h-9"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs text-zinc-400">Select Table</label>
                  <select
                    value={targetTable}
                    onChange={(e) => setTargetTable(e.target.value)}
                    className="w-full mt-1 bg-[#111] border border-white/10 rounded-md px-3 py-2 text-sm text-zinc-300 outline-none focus:border-blue-500/40"
                  >
                    <option value="">-- Select a table --</option>
                    {tables.map(t => (
                      <option key={t.name} value={t.name}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Column Mapping */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-400 font-medium">Column Mapping</label>
                <div className="border border-white/5 rounded-lg overflow-hidden">
                  <div className="bg-[#0d0d0d] grid grid-cols-[1fr,auto,1fr] gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-white/5">
                    <span>Source Column</span>
                    <span></span>
                    <span>Target Column</span>
                  </div>
                  <div className="max-h-40 overflow-auto">
                    {parsedData.headers.map(header => (
                      <div key={header} className="grid grid-cols-[1fr,auto,1fr] gap-2 items-center px-3 py-1.5 border-b border-white/5">
                        <span className="text-xs text-zinc-300 font-mono truncate">{header}</span>
                        <ArrowRight className="w-3 h-3 text-zinc-600" />
                        <Input
                          value={columnMapping[header] || ''}
                          onChange={(e) => setColumnMapping(prev => ({ ...prev, [header]: e.target.value }))}
                          className="h-7 text-xs bg-[#111] border-white/10"
                          placeholder={header}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-zinc-500"
                  onClick={() => setStep('preview')}
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-500 h-8 text-xs gap-1"
                  onClick={() => setStep('ready')}
                  disabled={!createNewTable && !targetTable}
                >
                  Review SQL <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Ready / Review */}
          {step === 'ready' && (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Ready to Import</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">
                    {parsedData?.totalRows} rows into {createNewTable ? newTableName || 'imported_data' : targetTable}
                  </p>
                </div>
                {databaseType && (
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500 bg-white/5 px-2 py-1 rounded">
                    {databaseType}
                  </span>
                )}
              </div>

              {/* SQL Preview */}
              <div className="border border-white/5 rounded-lg bg-[#0d0d0d] overflow-auto max-h-60">
                <pre className="p-3 text-xs text-zinc-400 font-mono whitespace-pre-wrap">
                  {generatedSQL.substring(0, 3000)}
                  {generatedSQL.length > 3000 && '\n\n... (truncated for preview)'}
                </pre>
              </div>

              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-zinc-500"
                  onClick={() => setStep('configure')}
                >
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs border-white/10"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedSQL);
                    }}
                  >
                    Copy SQL
                  </Button>
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-500 h-8 text-xs gap-1"
                    onClick={handleImport}
                    disabled={isImporting}
                  >
                    {isImporting ? (
                      <><Loader2 className="w-3 h-3 animate-spin" /> Importing...</>
                    ) : (
                      <><Upload className="w-3 h-3" /> Execute Import</>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
