"use client";

import React, { useState, useEffect } from 'react';
import { ShieldAlert, ShieldCheck, AlertTriangle, Loader2, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SafetyAnalysis {
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  warnings: {
    type: string;
    severity: string;
    message: string;
    detail: string;
  }[];
  affectedRows: string;
  cascadeEffects: string;
  recommendation: string;
}

interface QuerySafetyDialogProps {
  isOpen: boolean;
  query: string;
  schemaContext: string;
  databaseType?: string;
  onClose: () => void;
  onProceed: () => void;
  /** Optional API adapter: when provided, bypasses the built-in /api/ai/query-safety fetch. */
  onAnalyzeSafety?: (params: { query: string; schemaContext: string }) => Promise<SafetyAnalysis>;
}

function parseSafetyResponse(text: string): SafetyAnalysis | null {
  try {
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    // Try parsing the entire text as JSON
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

const RISK_CONFIG = {
  safe: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: ShieldCheck, label: 'Safe' },
  low: { color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', icon: ShieldCheck, label: 'Low Risk' },
  medium: { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: AlertTriangle, label: 'Medium Risk' },
  high: { color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/20', icon: ShieldAlert, label: 'High Risk' },
  critical: { color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', icon: ShieldAlert, label: 'Critical Risk' },
};

export function QuerySafetyDialog({
  isOpen,
  query,
  schemaContext,
  databaseType,
  onClose,
  onProceed,
  onAnalyzeSafety,
}: QuerySafetyDialogProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<SafetyAnalysis | null>(null);
  const [rawResponse, setRawResponse] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && query) {
      analyzeQuery();
    }
    return () => {
      setAnalysis(null);
      setRawResponse('');
      setError(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query]);

  const analyzeQuery = async () => {
    setIsAnalyzing(true);
    setError(null);

    try {
      let filteredSchema = '';
      if (schemaContext) {
        try {
          const tables = JSON.parse(schemaContext);
          filteredSchema = tables.slice(0, 30).map((t: { name: string; rowCount?: number; columns?: { name: string; type: string }[] }) => {
            const cols = t.columns?.slice(0, 8).map(c => `${c.name} (${c.type})`).join(', ') || '';
            return `${t.name} (${t.rowCount || 0} rows): ${cols}`;
          }).join('\n');
        } catch {
          filteredSchema = schemaContext.substring(0, 2000);
        }
      }

      if (onAnalyzeSafety) {
        // Platform adapter: use callback instead of fetch
        const result = await onAnalyzeSafety({ query, schemaContext: filteredSchema });
        setAnalysis(result);
      } else {
        // Default: existing fetch behavior
        const response = await fetch('/api/ai/query-safety', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, schemaContext: filteredSchema, databaseType }),
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Analysis failed');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No reader');

        let fullResponse = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullResponse += new TextDecoder().decode(value);
          setRawResponse(fullResponse);
        }

        const parsed = parseSafetyResponse(fullResponse);
        if (parsed) {
          setAnalysis(parsed);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  if (!isOpen) return null;

  const risk = analysis ? RISK_CONFIG[analysis.riskLevel] || RISK_CONFIG.medium : null;
  const RiskIcon = risk?.icon || ShieldAlert;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#111] border border-white/10 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <ShieldAlert strokeWidth={1.5} className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-medium text-zinc-200">Query Safety Check</span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-zinc-500">
            <X strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Query Preview */}
        <div className="px-5 py-3 bg-[#0a0a0a] border-b border-white/5">
          <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap max-h-24 overflow-auto">
            {query.length > 300 ? query.substring(0, 300) + '...' : query}
          </pre>
        </div>

        {/* Analysis */}
        <div className="px-5 py-4 max-h-80 overflow-auto">
          {isAnalyzing && (
            <div className="flex items-center justify-center gap-2 py-8 text-zinc-500">
              <Loader2 strokeWidth={1.5} className="w-5 h-5 animate-spin" />
              <span className="text-xs">Analyzing query safety...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400">
              {error}
            </div>
          )}

          {analysis && risk && (
            <div className="space-y-3">
              {/* Risk Badge */}
              <div className={cn("flex items-center gap-2 px-3 py-2 rounded-lg", risk.bg, "border", risk.border)}>
                <RiskIcon className={cn("w-5 h-5", risk.color)} />
                <div>
                  <span className={cn("text-xs font-medium", risk.color)}>{risk.label}</span>
                  <p className="text-xs text-zinc-400 mt-0.5">{analysis.summary}</p>
                </div>
              </div>

              {/* Warnings */}
              {analysis.warnings?.length > 0 && (
                <div className="space-y-2">
                  {analysis.warnings.map((w, i) => (
                    <div key={i} className={cn(
                      "px-3 py-2 rounded-lg border text-xs",
                      w.severity === 'critical' ? 'bg-red-500/5 border-red-500/20' :
                      w.severity === 'warning' ? 'bg-amber-500/5 border-amber-500/20' :
                      'bg-blue-500/5 border-blue-500/20'
                    )}>
                      <p className="font-medium text-zinc-300">{w.message}</p>
                      <p className="text-zinc-500 mt-0.5">{w.detail}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Affected Rows */}
              {analysis.affectedRows && analysis.affectedRows !== 'none' && (
                <div className="text-xs">
                  <span className="text-zinc-500">Affected rows: </span>
                  <span className="text-zinc-300 font-mono">{analysis.affectedRows}</span>
                </div>
              )}

              {/* Cascade */}
              {analysis.cascadeEffects && analysis.cascadeEffects !== 'none' && (
                <div className="text-xs">
                  <span className="text-zinc-500">Cascade effects: </span>
                  <span className="text-zinc-300">{analysis.cascadeEffects}</span>
                </div>
              )}

              {/* Recommendation */}
              {analysis.recommendation && (
                <div className="bg-[#0a0a0a] rounded-lg p-3 border border-white/5">
                  <p className="text-xs font-medium text-zinc-500r mb-1">Recommendation</p>
                  <p className="text-xs text-zinc-300">{analysis.recommendation}</p>
                </div>
              )}
            </div>
          )}

          {/* Show raw response if parsing failed */}
          {!isAnalyzing && !analysis && rawResponse && !error && (
            <div className="text-xs text-zinc-400 whitespace-pre-wrap">{rawResponse}</div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/5 bg-[#0a0a0a]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-white/5 text-zinc-400 text-xs font-medium hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onProceed}
            disabled={isAnalyzing}
            className={cn(
              "px-4 py-2 rounded-lg text-white text-xs font-medium transition-colors flex items-center gap-1.5",
              analysis?.riskLevel === 'critical' || analysis?.riskLevel === 'high'
                ? "bg-red-600 hover:bg-red-500"
                : "bg-blue-600 hover:bg-blue-500",
              isAnalyzing && "opacity-50 cursor-not-allowed"
            )}
          >
            <Play strokeWidth={1.5} className="w-3 h-3 fill-current" />
            {analysis?.riskLevel === 'critical' ? 'Execute Anyway' :
             analysis?.riskLevel === 'high' ? 'Proceed with Caution' :
             'Execute Query'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Detect if a query is potentially dangerous and should trigger safety analysis.
 */
export function isDangerousQuery(query: string): boolean {
  const normalized = query.trim().toUpperCase();

  // Dangerous patterns
  const patterns = [
    /^\s*DELETE\b/i,
    /^\s*DROP\b/i,
    /^\s*TRUNCATE\b/i,
    /^\s*ALTER\b/i,
    /\bUPDATE\b[\s\S]*?\bSET\b/i,
    /^\s*GRANT\b/i,
    /^\s*REVOKE\b/i,
  ];

  // Check for UPDATE/DELETE without WHERE (most dangerous)
  if (/^\s*DELETE\b/i.test(normalized) && !/\bWHERE\b/.test(normalized)) return true;
  if (/\bUPDATE\b[\s\S]*?\bSET\b/i.test(normalized) && !/\bWHERE\b/.test(normalized)) return true;

  return patterns.some(p => p.test(query));
}
