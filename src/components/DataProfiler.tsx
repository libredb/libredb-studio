"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, BarChart3, X, Hash, AlertCircle, Sparkles, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableSchema, DatabaseConnection } from '@/lib/types';
import { detectSensitiveColumns, maskValue } from '@/lib/data-masking';

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
}

export function DataProfiler({
  isOpen,
  onClose,
  tableName,
  tableSchema,
  connection,
  schemaContext,
  databaseType,
}: DataProfilerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [aiSummary, setAiSummary] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detect sensitive columns for masking sample values in profiler
  const sensitiveColumnNames = useMemo(() => {
    if (!tableSchema?.columns) return new Map();
    return detectSensitiveColumns(tableSchema.columns.map(c => c.name));
  }, [tableSchema]);

  useEffect(() => {
    if (isOpen && tableName && connection) {
      fetchProfile();
    }
    return () => {
      setProfile(null);
      setAiSummary('');
      setError(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, tableName]);

  const fetchProfile = async () => {
    if (!connection || !tableSchema) return;
    setIsLoading(true);
    setError(null);

    try {
      const columns = tableSchema.columns?.map(c => c.name) || [];
      const response = await fetch('/api/db/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection, tableName, columns }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Profile failed');
      }

      const data: ProfileData = await response.json();
      setProfile(data);

      // Trigger AI summary
      fetchAiSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAiSummary = async (data: ProfileData) => {
    setIsAiLoading(true);
    try {
      const profileSummary = data.columns.map(c =>
        `${c.name}: ${c.nullPercent}% null, ${c.distinctCount} distinct, min=${c.minValue || 'N/A'}, max=${c.maxValue || 'N/A'}`
      ).join('\n');

      const response = await fetch('/api/ai/describe-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaContext: `Table: ${tableName} (${data.totalRows} rows)\n\nColumn Profiles:\n${profileSummary}\n\nSchema:\n${schemaContext || ''}`,
          databaseType,
          mode: 'table',
        }),
      });

      if (!response.ok) return;

      const reader = response.body?.getReader();
      if (!reader) return;

      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += new TextDecoder().decode(value);
        setAiSummary(full);
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
      <div className="bg-[#111] border border-white/10 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-bold text-zinc-200">Data Profiler</span>
            <span className="text-xs text-zinc-500 font-mono">{tableName}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-zinc-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-zinc-500">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Profiling {tableName}...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {profile && (
            <>
              {/* Summary Stats */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[#0a0a0a] rounded-lg p-3 border border-white/5">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Total Rows</p>
                  <p className="text-lg font-bold text-zinc-200 mt-1">{profile.totalRows.toLocaleString()}</p>
                </div>
                <div className="bg-[#0a0a0a] rounded-lg p-3 border border-white/5">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Columns</p>
                  <p className="text-lg font-bold text-zinc-200 mt-1">{profile.columns.length}</p>
                </div>
                <div className="bg-[#0a0a0a] rounded-lg p-3 border border-white/5">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Avg Null %</p>
                  <p className="text-lg font-bold text-zinc-200 mt-1">
                    {profile.columns.length > 0
                      ? Math.round(profile.columns.reduce((sum, c) => sum + c.nullPercent, 0) / profile.columns.length)
                      : 0}%
                  </p>
                </div>
              </div>

              {/* Column Profiles */}
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Column Profiles</h3>
                {profile.columns.map((col) => (
                  <div key={col.name} className="bg-[#0a0a0a] rounded-lg p-3 border border-white/5">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Hash className="w-3 h-3 text-blue-400" />
                        <span className="text-xs font-bold text-zinc-200">{col.name}</span>
                        {col.type && (
                          <span className="text-[10px] text-zinc-500 font-mono">{col.type}</span>
                        )}
                        {sensitiveColumnNames.has(col.name) && (
                          <span title="Sensitive column - values masked"><Lock className="w-3 h-3 text-purple-400" /></span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-500">
                        {col.distinctCount.toLocaleString()} distinct
                      </span>
                    </div>

                    {col.error ? (
                      <p className="text-[10px] text-amber-400">{col.error}</p>
                    ) : (
                      <>
                        {/* Null bar */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                col.nullPercent > 50 ? "bg-red-500" :
                                col.nullPercent > 20 ? "bg-amber-500" :
                                "bg-emerald-500"
                              )}
                              style={{ width: `${100 - col.nullPercent}%` }}
                            />
                          </div>
                          <span className={cn(
                            "text-[10px] font-mono w-10 text-right",
                            col.nullPercent > 50 ? "text-red-400" :
                            col.nullPercent > 20 ? "text-amber-400" :
                            "text-emerald-400"
                          )}>
                            {col.nullPercent}% null
                          </span>
                        </div>

                        {/* Min/Max */}
                        <div className="flex gap-4 text-[10px]">
                          {col.minValue && (() => {
                            const rule = sensitiveColumnNames.get(col.name);
                            const display = rule
                              ? maskValue(col.minValue, rule)
                              : col.minValue.substring(0, 30);
                            return (
                              <span className="text-zinc-500">
                                min: <span className={cn("font-mono", rule ? "text-zinc-500 italic" : "text-zinc-400")}>{display}</span>
                              </span>
                            );
                          })()}
                          {col.maxValue && (() => {
                            const rule = sensitiveColumnNames.get(col.name);
                            const display = rule
                              ? maskValue(col.maxValue, rule)
                              : col.maxValue.substring(0, 30);
                            return (
                              <span className="text-zinc-500">
                                max: <span className={cn("font-mono", rule ? "text-zinc-500 italic" : "text-zinc-400")}>{display}</span>
                              </span>
                            );
                          })()}
                        </div>

                        {/* Sample Values */}
                        {col.sampleValues && col.sampleValues.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {col.sampleValues.map((val, i) => {
                              const rule = sensitiveColumnNames.get(col.name);
                              const display = rule
                                ? maskValue(val, rule)
                                : val.substring(0, 20);
                              return (
                                <span key={i} className={cn("text-[10px] px-1.5 py-0.5 bg-zinc-800 rounded font-mono", rule ? "text-zinc-500 italic" : "text-zinc-400")}>
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
                    <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">
                      AI Analysis
                    </span>
                    {isAiLoading && <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />}
                  </div>
                  {aiSummary && (
                    <div className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
                      {aiSummary}
                    </div>
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
