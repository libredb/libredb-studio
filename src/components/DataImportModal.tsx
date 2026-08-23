"use client";

import React, { useState, useCallback, useRef, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import {
  Upload,
  FileSpreadsheet,
  FileBraces,
  FileText,
  Check,
  TriangleAlert,
  Table2,
  ArrowRight,
  LoaderCircle,
  X,
} from "lucide-react";
import type { DatabaseType, TableSchema } from "@/lib/types";
import { quoteLiteral } from "@/lib/sql/values";

interface DataImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (sql: string) => void;
  tables: TableSchema[];
  databaseType?: string;
}

export interface ParsedData {
  headers: string[];
  rows: string[][];
  totalRows: number;
}

type ImportStep = "upload" | "preview" | "configure" | "ready";

export function parseCSV(text: string): ParsedData {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return { headers: [], rows: [], totalRows: 0 };

  // Parse CSV with basic quote handling
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
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
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map((line) => parseLine(line));
  return { headers, rows, totalRows: rows.length };
}

export function parseJSON(text: string): ParsedData {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length === 0) return { headers: [], rows: [], totalRows: 0 };

  const headers = [...new Set(arr.flatMap((obj) => Object.keys(obj)))];
  const rows = arr.map((obj) =>
    headers.map((h) => {
      const val = obj[h];
      if (val === null || val === undefined) return "";
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    }),
  );

  return { headers, rows, totalRows: rows.length };
}

/**
 * The shapes a value must have to be written into a statement unquoted. They are
 * shared with `inferSqlType` on purpose: the type is inferred from a sample, so
 * the same test has to be applied again to each value that is emitted — one
 * predicate, used in both places, cannot drift from itself.
 */
const INTEGER_VALUE = /^-?\d+$/;
const NUMERIC_VALUE = /^-?\d+(\.\d+)?$/;
const BOOLEAN_VALUE = /^(true|false|0|1)$/i;

export function inferSqlType(values: string[]): string {
  const nonEmpty = values.filter((v) => v !== "" && v !== null);
  if (nonEmpty.length === 0) return "TEXT";

  const allIntegers = nonEmpty.every((v) => INTEGER_VALUE.test(v));
  if (allIntegers) return "INTEGER";

  const allNumbers = nonEmpty.every((v) => NUMERIC_VALUE.test(v));
  if (allNumbers) return "NUMERIC";

  const allBooleans = nonEmpty.every((v) => BOOLEAN_VALUE.test(v));
  if (allBooleans) return "BOOLEAN";

  return "TEXT";
}

/**
 * Quote an imported cell as a SQL literal for the dialect the import will run on.
 *
 * These statements are handed to `onImport`, which executes them, so a cell of the
 * uploaded file becomes SQL. Doubling the quote is enough only where a backslash
 * is data: on a backslash-escaping dialect a cell ending in one would escape the
 * closing quote and have the rest of the row read as statement text (#290).
 */
export function escapeSQL(value: string, dialect?: DatabaseType): string {
  if (value === "" || value === "null" || value === "NULL") return "NULL";
  return quoteLiteral(value, dialect);
}

export function generateImportSQL(
  parsedData: ParsedData | null,
  targetTable: string,
  createNewTable: boolean,
  newTableName: string,
  columnMapping: Record<string, string>,
  dialect?: DatabaseType,
): string {
  if (!parsedData) return "";

  const tableName = createNewTable ? newTableName || "imported_data" : targetTable;
  if (!tableName) return "";

  const statements: string[] = [];

  // One type per column, read from the first 100 rows and computed once. It used
  // to be re-inferred for every cell, which re-scanned that sample rows × columns
  // times for a single import.
  const columnTypes = parsedData.headers.map((_, idx) =>
    inferSqlType(parsedData.rows.slice(0, 100).map((r) => r[idx])),
  );

  // CREATE TABLE if new
  if (createNewTable) {
    const colDefs = parsedData.headers.map((h, idx) => {
      const colName = columnMapping[h] || h;
      return `  ${colName} ${columnTypes[idx]}`;
    });
    statements.push(`CREATE TABLE ${tableName} (\n${colDefs.join(",\n")}\n);`);
  }

  // INSERT statements (batch in groups of 100)
  const mappedHeaders = parsedData.headers.map((h) => columnMapping[h] || h);
  const batchSize = 100;

  for (let i = 0; i < parsedData.rows.length; i += batchSize) {
    const batch = parsedData.rows.slice(i, i + batchSize);
    const valueRows = batch.map((row) => {
      const values = row.map((val, idx) => {
        const sqlType = columnTypes[idx];
        if (val === "" || val === "NULL" || val === "null") return "NULL";
        // The type came from the first 100 rows, so every value after them is
        // outside the evidence for it. Each one is tested again by the same
        // predicate that typed the column, and one that fails falls through to a
        // quoted literal: unquoted text is statement grammar, and a row past the
        // sample used to be able to carry `0); DELETE FROM users; --` straight
        // into an import the user then executes (PR #304 review).
        if (sqlType === "BOOLEAN" && BOOLEAN_VALUE.test(val)) {
          return val.toLowerCase() === "true" || val === "1" ? "TRUE" : "FALSE";
        }
        if (sqlType === "INTEGER" && INTEGER_VALUE.test(val)) return val;
        if (sqlType === "NUMERIC" && NUMERIC_VALUE.test(val)) return val;
        // A value the engine will refuse for its column is better than one it
        // reads as SQL: the type error names the row, and nothing executes.
        return escapeSQL(val, dialect);
      });
      return `  (${values.join(", ")})`;
    });

    statements.push(`INSERT INTO ${tableName} (${mappedHeaders.join(", ")})\nVALUES\n${valueRows.join(",\n")};`);
  }

  return statements.join("\n\n");
}

export function DataImportModal({ isOpen, onClose, onImport, tables, databaseType }: DataImportModalProps) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState<"csv" | "json">("csv");
  const [targetTable, setTargetTable] = useState("");
  const [createNewTable, setCreateNewTable] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setStep("upload");
    setParsedData(null);
    setFileName("");
    setTargetTable("");
    setCreateNewTable(false);
    setNewTableName("");
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

    const ext = file.name.split(".").pop()?.toLowerCase();
    const isJSON = ext === "json";
    setFileType(isJSON ? "json" : "csv");

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = isJSON ? parseJSON(text) : parseCSV(text);

        if (data.headers.length === 0) {
          setError("No data found in file");
          return;
        }

        setParsedData(data);
        // Auto-map columns 1:1
        const mapping: Record<string, string> = {};
        data.headers.forEach((h) => {
          mapping[h] = h;
        });
        setColumnMapping(mapping);
        setStep("preview");
      } catch (err) {
        setError(`Failed to parse file: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const generatedSQL = useMemo(
    () =>
      generateImportSQL(
        parsedData,
        targetTable,
        createNewTable,
        newTableName,
        columnMapping,
        databaseType as DatabaseType | undefined,
      ),
    [parsedData, targetTable, createNewTable, newTableName, columnMapping, databaseType],
  );

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
      <DialogContent className="bg-surface border-hairline-strong text-fg max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload strokeWidth={1.5} className="w-5 h-5 text-blue-400" />
            {"Import Data"}
            {fileName && <span className="text-xs text-fg-muted font-normal ml-2">{fileName}</span>}
          </DialogTitle>
        </DialogHeader>

        {/* Step Indicator */}
        <div className="flex items-center gap-2 px-1 py-2">
          {(["upload", "preview", "configure", "ready"] as ImportStep[]).map((s, idx) => (
            <React.Fragment key={s}>
              <div
                className={cn(
                  "flex items-center gap-1.5 text-xs font-mediumr",
                  step === s
                    ? "text-blue-400"
                    : idx < ["upload", "preview", "configure", "ready"].indexOf(step)
                      ? "text-emerald-400"
                      : "text-fg-subtle",
                )}
              >
                <div
                  className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center text-[0.625rem]",
                    step === s
                      ? "bg-blue-500/20 border border-blue-500/40"
                      : idx < ["upload", "preview", "configure", "ready"].indexOf(step)
                        ? "bg-emerald-500/20 border border-emerald-500/40"
                        : "bg-fill border border-hairline-strong",
                  )}
                >
                  {idx < ["upload", "preview", "configure", "ready"].indexOf(step) ? (
                    <Check strokeWidth={1.5} className="w-3 h-3" />
                  ) : (
                    idx + 1
                  )}
                </div>
                <span className="hidden sm:inline">
                  {s === "upload" ? "Upload" : s === "preview" ? "Preview" : s === "configure" ? "Configure" : "Import"}
                </span>
              </div>
              {idx < 3 && <ArrowRight strokeWidth={1.5} className="w-3 h-3 text-fg-faint" />}
            </React.Fragment>
          ))}
        </div>

        <div className="flex-1 overflow-auto min-h-0">
          {/* Step 1: Upload */}
          {step === "upload" && (
            <div className="p-4">
              <button
                type="button"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-hairline-strong rounded-xl p-12 text-center cursor-pointer hover:border-blue-500/30 hover:bg-blue-500/5 transition-all"
              >
                <Upload strokeWidth={1.5} className="w-10 h-10 text-fg-subtle mx-auto mb-4" />
                <p className="text-xs text-fg-tertiary mb-1">Drop a file here or click to browse</p>
                <p className="text-xs text-fg-subtle">Supports CSV and JSON files</p>
                <div className="flex items-center justify-center gap-4 mt-4">
                  <div className="flex items-center gap-1.5 text-fg-muted">
                    <FileSpreadsheet strokeWidth={1.5} className="w-3.5 h-3.5" />
                    <span className="text-xs">CSV</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-fg-muted">
                    <FileBraces strokeWidth={1.5} className="w-3.5 h-3.5" />
                    <span className="text-xs">JSON</span>
                  </div>
                </div>
              </button>
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
                  <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span className="text-xs text-red-400">{error}</span>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Preview */}
          {step === "preview" && parsedData && (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {fileType === "json" ? (
                    <FileBraces strokeWidth={1.5} className="w-5 h-5 text-amber-400" />
                  ) : (
                    <FileText strokeWidth={1.5} className="w-5 h-5 text-emerald-400" />
                  )}
                  <div>
                    <p className="text-xs font-medium">{fileName}</p>
                    <p className="text-xs text-fg-muted">
                      {parsedData.totalRows} rows, {parsedData.headers.length} columns
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-fg-muted"
                  onClick={() => {
                    resetState();
                  }}
                >
                  <X strokeWidth={1.5} className="w-3 h-3 mr-1" /> Reset
                </Button>
              </div>

              {/* Preview Table */}
              <div className="border border-hairline rounded-lg overflow-auto max-h-60">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-raised">
                      {parsedData.headers.map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left text-xs uppercase text-fg-muted font-mono border-b border-hairline whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsedData.rows.slice(0, 10).map((row, idx) => (
                      <tr key={idx} className="border-b border-hairline hover:bg-fill-subtle">
                        {row.map((cell, cidx) => (
                          <td
                            key={cidx}
                            className="px-3 py-1.5 text-fg-secondary font-mono whitespace-nowrap max-w-[200px] truncate"
                          >
                            {cell || <span className="text-fg-subtle italic">NULL</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsedData.totalRows > 10 && (
                  <div className="text-center py-2 text-xs text-fg-subtle bg-raised">
                    ... and {parsedData.totalRows - 10} more rows
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-500 h-8 text-xs gap-1"
                  onClick={() => setStep("configure")}
                >
                  Configure Import <ArrowRight strokeWidth={1.5} className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Configure */}
          {step === "configure" && parsedData && (
            <div className="p-4 space-y-4">
              {/* Target Table */}
              <div className="space-y-2">
                <span className="text-xs text-fg-tertiary font-medium">Target Table</span>
                <div className="flex items-center gap-2">
                  <button
                    className={cn(
                      "flex-1 px-3 py-2 rounded-lg border text-xs text-left transition-all",
                      !createNewTable
                        ? "border-blue-500/40 bg-blue-500/10 text-blue-400"
                        : "border-hairline-strong text-fg-muted hover:bg-fill",
                    )}
                    onClick={() => setCreateNewTable(false)}
                  >
                    <Table2 strokeWidth={1.5} className="w-3.5 h-3.5 mb-1" />
                    {"Existing Table"}
                  </button>
                  <button
                    className={cn(
                      "flex-1 px-3 py-2 rounded-lg border text-xs text-left transition-all",
                      createNewTable
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                        : "border-hairline-strong text-fg-muted hover:bg-fill",
                    )}
                    onClick={() => setCreateNewTable(true)}
                  >
                    <FileSpreadsheet strokeWidth={1.5} className="w-3.5 h-3.5 mb-1" />
                    {"New Table"}
                  </button>
                </div>
              </div>

              {createNewTable ? (
                <div>
                  <label htmlFor="import-new-table-name" className="text-xs text-fg-tertiary">
                    New Table Name
                  </label>
                  <Input
                    id="import-new-table-name"
                    value={newTableName}
                    onChange={(e) => setNewTableName(e.target.value)}
                    placeholder="imported_data"
                    className="mt-1 bg-overlay border-hairline-strong text-xs h-9"
                  />
                </div>
              ) : (
                <div>
                  <label htmlFor="import-target-table" className="text-xs text-fg-tertiary">
                    Select Table
                  </label>
                  <select
                    id="import-target-table"
                    value={targetTable}
                    onChange={(e) => setTargetTable(e.target.value)}
                    className="w-full mt-1 bg-overlay border border-hairline-strong rounded-md px-3 py-2 text-xs text-fg-secondary outline-none focus:border-blue-500/40"
                  >
                    <option value="">-- Select a table --</option>
                    {tables.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Column Mapping */}
              <div className="space-y-2">
                <span className="text-xs text-fg-tertiary font-medium">Column Mapping</span>
                <div className="border border-hairline rounded-lg overflow-hidden">
                  <div className="bg-raised grid grid-cols-[1fr,auto,1fr] gap-2 px-3 py-1.5 text-xs text-fg-muted border-b border-hairline">
                    <span>Source Column</span>
                    <span></span>
                    <span>Target Column</span>
                  </div>
                  <div className="max-h-40 overflow-auto">
                    {parsedData.headers.map((header) => (
                      <div
                        key={header}
                        className="grid grid-cols-[1fr,auto,1fr] gap-2 items-center px-3 py-1.5 border-b border-hairline"
                      >
                        <span className="text-xs text-fg-secondary font-mono truncate">{header}</span>
                        <ArrowRight strokeWidth={1.5} className="w-3 h-3 text-fg-subtle" />
                        <Input
                          aria-label={`Target column for ${header}`}
                          value={columnMapping[header] || ""}
                          onChange={(e) => setColumnMapping((prev) => ({ ...prev, [header]: e.target.value }))}
                          className="h-7 text-xs bg-overlay border-hairline-strong"
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
                  className="h-8 text-xs text-fg-muted"
                  onClick={() => setStep("preview")}
                >
                  {"Back"}
                </Button>
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-500 h-8 text-xs gap-1"
                  onClick={() => setStep("ready")}
                  disabled={!createNewTable && !targetTable}
                >
                  Review SQL <ArrowRight strokeWidth={1.5} className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Ready / Review */}
          {step === "ready" && (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium">Ready to Import</p>
                  <p className="text-xs text-fg-muted mt-0.5">
                    {parsedData?.totalRows} rows into {createNewTable ? newTableName || "imported_data" : targetTable}
                  </p>
                </div>
                {databaseType && (
                  <span className="text-xs text-fg-muted bg-fill px-2 py-1 rounded">{databaseType}</span>
                )}
              </div>

              {/* SQL Preview */}
              <div className="border border-hairline rounded-lg bg-raised overflow-auto max-h-60">
                <pre className="p-3 text-xs text-fg-tertiary font-mono whitespace-pre-wrap">
                  {generatedSQL.substring(0, 3000)}
                  {generatedSQL.length > 3000 && "\n\n... (truncated for preview)"}
                </pre>
              </div>

              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-fg-muted"
                  onClick={() => setStep("configure")}
                >
                  {"Back"}
                </Button>
                <div className="flex gap-2">
                  {/*
                    `CopyButton` rather than a bare `navigator.clipboard.writeText` (B43):
                    that API is absent over plain HTTP off loopback — which several
                    distribution channels are — so the write threw inside this handler and
                    the user got no sign the clipboard was still empty.
                  */}
                  <CopyButton
                    text={generatedSQL}
                    testId="import-copy-sql"
                    label="Copy SQL"
                    className="h-8 px-3 gap-1.5 border border-hairline-strong text-xs rounded-md"
                  />
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-500 h-8 text-xs gap-1"
                    onClick={handleImport}
                    disabled={isImporting}
                  >
                    {isImporting ? (
                      <>
                        <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" /> Importing...
                      </>
                    ) : (
                      <>
                        <Upload strokeWidth={1.5} className="w-3 h-3" /> Execute Import
                      </>
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
