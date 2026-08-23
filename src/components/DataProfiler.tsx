"use client";

import { useState, useEffect, useMemo } from "react";
import { LoaderCircle, ChartColumn, X, Hash, CircleAlert, Sparkles, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { TableSchema, DatabaseConnection } from "@/lib/types";
import { detectSensitiveColumns, maskValue } from "@/lib/data-masking";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";

interface ColumnProfile {
  name: string;
  type?: string;
  totalRows: number;
  nullCount: number;
  nullPercent: number;
  distinctCount: number;
  minValue?: string;
  maxValue?: string;
  sampleValues?: string[];
  error?: string;
}

interface ProfileData {
  tableName: string;
  totalRows: number;
  columns: ColumnProfile[];
}

interface DataProfilerProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  tableSchema: TableSchema | null;
  connection: DatabaseConnection | null;
  schemaContext?: string;
  databaseType?: string;
  /** Optional API adapter: when provided, bypasses the built-in /api/db/profile fetch. */
  onProfile?: (params: { connectionId: string; tableName: string }) => Promise<ProfileData>;
  /** Optional API adapter: when provided, bypasses the built-in /api/ai/describe-schema fetch. */
  onDescribeSchema?: (params: { tableName: string; schemaContext: string }) => Promise<string>;
}

export function DataProfiler({
  isOpen,
  onClose,
  tableName,
  tableSchema,
  connection,
  schemaContext,
  databaseType,
  onProfile,
  onDescribeSchema,
}: DataProfilerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [aiSummary, setAiSummary] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect sensitive columns for masking sample values in profiler
  const sensitiveColumnNames = useMemo(() => {
    if (!tableSchema?.columns) return new Map();
    return detectSensitiveColumns(tableSchema.columns.map((c) => c.name));
  }, [tableSchema]);

  useEffect(() => {
    if (isOpen && tableName && connection) {
      fetchProfile();
    }
    return () => {
      setProfile(null);
      setAiSummary("");
      setError(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, tableName]);

  /*
    Escape closes the modal.

    U4: `/api/db/profile` can fail for any provider (#427 measured it on Redis,
    where the route answered 400 for every key-prefix row), and the card that
    failure renders was a dead end - this shell is hand-rolled rather than a
    `ui/dialog`, so nothing bound Escape for it and the header control was the only
    exit. Swapping the shell for the Radix primitive would bring Escape along, but
    it also portals the card out of the subtree `[data-studio-workspace]` styles by
    descendant selector, and re-homing the embedded surface's chrome is a larger
    change than a dismiss fix should make.

    Registered on `document`, following CommandPalette's shortcut effect
    (src/components/CommandPalette.tsx:79): the card takes no focus of its own when
    it opens, so a handler on the card would never see the key. Bound only while
    open, so a closed profiler - of which the tree holds one per surface - is not a
    listener that swallows Escape from whatever else is on screen.
  */
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const fetchProfile = async () => {
    if (!connection || !tableSchema) return;
    setIsLoading(true);
    setError(null);

    try {
      let data: ProfileData;

      if (onProfile) {
        // Platform adapter: use callback instead of fetch
        data = await onProfile({ connectionId: connection.id, tableName });
      } else {
        // Default: existing fetch behavior
        const columns = tableSchema.columns?.map((c) => c.name) || [];
        const response = await fetch("/api/db/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The seed id for a managed connection: the browser's copy has had its
          // password and connection string stripped, so the object cannot be
          // resolved to a database from a cold provider cache.
          body: JSON.stringify({ ...buildConnectionPayload(connection), tableName, columns }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Profile failed");
        }

        data = await response.json();
      }

      setProfile(data);

      // Trigger AI summary
      fetchAiSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAiSummary = async (data: ProfileData) => {
    setIsAiLoading(true);
    try {
      const profileSummary = data.columns
        .map(
          (c) =>
            `${c.name}: ${c.nullPercent}% null, ${c.distinctCount} distinct, min=${c.minValue || "N/A"}, max=${c.maxValue || "N/A"}`,
        )
        .join("\n");

      const fullSchemaContext = `Table: ${tableName} (${data.totalRows} rows)\n\nColumn Profiles:\n${profileSummary}\n\nSchema:\n${schemaContext || ""}`;

      if (onDescribeSchema) {
        // Platform adapter: use callback instead of fetch
        const result = await onDescribeSchema({ tableName, schemaContext: fullSchemaContext });
        setAiSummary(result);
      } else {
        // Default: existing fetch behavior
        const response = await fetch("/api/ai/describe-schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schemaContext: fullSchemaContext,
            databaseType,
            mode: "table",
          }),
        });

        if (!response.ok) return;

        const reader = response.body?.getReader();
        if (!reader) return;

        let full = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          full += new TextDecoder().decode(value);
          setAiSummary(full);
        }
      }
    } catch {
      // AI summary is optional, don't show error
    } finally {
      setIsAiLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-overlay border border-hairline-strong rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        {/*
          `shrink-0` and `relative z-10`, and the title row `min-w-0` with the table
          name truncating: the card is `overflow-hidden`, so a header that shrinks or
          overflows takes its close control out of reach along with it - and the names
          that overflow it are exactly the ones the profile route fails on (a Redis key
          prefix is a whole glob, not an identifier).
        */}
        <div className="relative z-10 shrink-0 flex items-center justify-between gap-2 px-5 py-3 border-b border-hairline">
          <div className="flex min-w-0 items-center gap-2">
            <ChartColumn strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
            <span className="text-xs font-medium text-fg shrink-0">Data Profiler</span>
            <span className="text-xs text-fg-muted font-mono truncate">{tableName}</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close data profiler"
            className="shrink-0 p-1 rounded hover:bg-fill text-fg-muted"
          >
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-fg-muted">
              <LoaderCircle strokeWidth={1.5} className="w-5 h-5 animate-spin" />
              <span className="text-xs">Profiling {tableName}...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400 flex items-center gap-2">
              <CircleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
              {error}
            </div>
          )}

          {profile && (
            <>
              {/* Summary Stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-surface rounded-lg p-3 border border-hairline">
                  <p className="text-xs font-medium text-fg-muted">Total Rows</p>
                  <p className="text-xs font-medium text-fg mt-1">{profile.totalRows.toLocaleString()}</p>
                </div>
                <div className="bg-surface rounded-lg p-3 border border-hairline">
                  <p className="text-xs font-medium text-fg-muted">Columns</p>
                  <p className="text-xs font-medium text-fg mt-1">{profile.columns.length}</p>
                </div>
                <div className="bg-surface rounded-lg p-3 border border-hairline">
                  <p className="text-xs font-medium text-fg-muted">Avg Null %</p>
                  <p className="text-xs font-medium text-fg mt-1">
                    {profile.columns.length > 0
                      ? Math.round(profile.columns.reduce((sum, c) => sum + c.nullPercent, 0) / profile.columns.length)
                      : 0}
                    %
                  </p>
                </div>
              </div>

              {/* Column Profiles */}
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-fg-tertiary">Column Profiles</h3>
                {profile.columns.map((col) => (
                  <div key={col.name} className="bg-surface rounded-lg p-3 border border-hairline">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Hash strokeWidth={1.5} className="w-3 h-3 text-blue-400" />
                        <span className="text-xs font-medium text-fg">{col.name}</span>
                        {col.type && <span className="text-xs text-fg-muted font-mono">{col.type}</span>}
                        {sensitiveColumnNames.has(col.name) && (
                          <span title="Sensitive column - values masked">
                            <Lock strokeWidth={1.5} className="w-3 h-3 text-purple-400" />
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-fg-muted">{col.distinctCount.toLocaleString()} distinct</span>
                    </div>

                    {col.error ? (
                      <p className="text-xs text-amber-400">{col.error}</p>
                    ) : (
                      <>
                        {/* Null bar */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="flex-1 h-1.5 bg-overlay rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                col.nullPercent > 50
                                  ? "bg-red-500"
                                  : col.nullPercent > 20
                                    ? "bg-amber-500"
                                    : "bg-emerald-500",
                              )}
                              style={{ width: `${100 - col.nullPercent}%` }}
                            />
                          </div>
                          <span
                            className={cn(
                              "text-xs font-mono w-10 text-right",
                              col.nullPercent > 50
                                ? "text-red-400"
                                : col.nullPercent > 20
                                  ? "text-amber-400"
                                  : "text-emerald-400",
                            )}
                          >
                            {col.nullPercent}% null
                          </span>
                        </div>

                        {/* Min/Max */}
                        <div className="flex gap-4 text-xs">
                          {col.minValue &&
                            (() => {
                              const rule = sensitiveColumnNames.get(col.name);
                              const display = rule ? maskValue(col.minValue, rule) : col.minValue.substring(0, 30);
                              return (
                                <span className="text-fg-muted">
                                  min:{" "}
                                  <span className={cn("font-mono", rule ? "text-fg-muted italic" : "text-fg-tertiary")}>
                                    {display}
                                  </span>
                                </span>
                              );
                            })()}
                          {col.maxValue &&
                            (() => {
                              const rule = sensitiveColumnNames.get(col.name);
                              const display = rule ? maskValue(col.maxValue, rule) : col.maxValue.substring(0, 30);
                              return (
                                <span className="text-fg-muted">
                                  max:{" "}
                                  <span className={cn("font-mono", rule ? "text-fg-muted italic" : "text-fg-tertiary")}>
                                    {display}
                                  </span>
                                </span>
                              );
                            })()}
                        </div>

                        {/* Sample Values */}
                        {col.sampleValues && col.sampleValues.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {col.sampleValues.map((val, i) => {
                              const rule = sensitiveColumnNames.get(col.name);
                              const display = rule ? maskValue(val, rule) : val.substring(0, 20);
                              return (
                                <span
                                  key={i}
                                  className={cn(
                                    "text-xs px-1.5 py-0.5 bg-overlay rounded font-mono",
                                    rule ? "text-fg-muted italic" : "text-fg-tertiary",
                                  )}
                                >
                                  {display}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* AI Summary */}
              {(aiSummary || isAiLoading) && (
                <div className="bg-cyan-500/5 border border-cyan-500/10 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Sparkles strokeWidth={1.5} className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-xs font-medium text-cyan-400">AI Analysis</span>
                    {isAiLoading && <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin text-cyan-400" />}
                  </div>
                  {aiSummary && (
                    <div className="text-xs text-fg-tertiary leading-relaxed whitespace-pre-wrap">{aiSummary}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
