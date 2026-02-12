"use client";

import React, { useState, useRef } from 'react';
import { Loader2, Sparkles, RefreshCw, Play, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DatabaseConnection } from '@/lib/types';

interface AIAutopilotPanelProps {
  connection: DatabaseConnection | null;
  schemaContext: string;
  onExecuteQuery?: (query: string) => void;
}

export function AIAutopilotPanel({ connection, schemaContext, onExecuteQuery }: AIAutopilotPanelProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [report, setReport] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const runAutopilot = async () => {
    if (!connection) return;
    setIsLoading(true);
    setError(null);
    setReport('');

    try {
      // Fetch monitoring data in parallel
      const [monitoringRes] = await Promise.all([
        fetch('/api/db/monitoring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connection,
            options: {
              includeTables: true,
              includeIndexes: true,
              slowQueryLimit: 20,
            },
          }),
        }),
      ]);

      let monitoringData = null;
      if (monitoringRes.ok) {
        monitoringData = await monitoringRes.json();
      }

      // Build filtered schema
      let filteredSchema = '';
      if (schemaContext) {
        try {
          const tables = JSON.parse(schemaContext);
          filteredSchema = tables.slice(0, 30).map((t: { name: string; rowCount?: number; columns?: { name: string; type: string }[] }) => {
            const cols = t.columns?.slice(0, 6).map(c => `${c.name} (${c.type})`).join(', ') || '';
            return `${t.name} (${t.rowCount || 0} rows): ${cols}`;
          }).join('\n');
        } catch {
          filteredSchema = schemaContext.substring(0, 2000);
        }
      }

      // Call autopilot AI
      const response = await fetch('/api/ai/autopilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slowQueries: monitoringData?.slowQueries,
          indexStats: monitoringData?.indexes,
          tableStats: monitoringData?.tables,
          performanceMetrics: monitoringData?.performance,
          overview: monitoringData?.overview,
          schemaContext: filteredSchema,
          databaseType: connection.type,
        }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Autopilot analysis failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader');

      let fullResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullResponse += new TextDecoder().decode(value);
        setReport(fullResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // Simple markdown rendering (headers, bold, lists)
  const renderMarkdown = (text: string) => {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeContent = '';
    let codeBlockIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End of code block
          const blockIndex = codeBlockIdx++;
          const sql = codeContent.trim();
          elements.push(
            <div key={`code-${i}`} className="relative group my-2">
              <pre className="bg-[#050505] rounded-lg p-3 text-[11px] font-mono text-blue-300 overflow-x-auto whitespace-pre-wrap border border-white/5">
                {sql}
              </pre>
              <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => copyToClipboard(sql, blockIndex)}
                  className="p-1 rounded bg-white/10 hover:bg-white/20 text-zinc-400"
                  title="Copy"
                >
                  {copiedIndex === blockIndex ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
                {onExecuteQuery && (
                  <button
                    onClick={() => onExecuteQuery(sql)}
                    className="p-1 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-400"
                    title="Execute"
                  >
                    <Play className="w-3 h-3 fill-current" />
                  </button>
                )}
              </div>
            </div>
          );
          codeContent = '';
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeContent += line + '\n';
        continue;
      }

      // Headers
      if (line.startsWith('## ')) {
        elements.push(<h2 key={i} className="text-sm font-bold text-zinc-200 mt-4 mb-2">{line.slice(3)}</h2>);
      } else if (line.startsWith('### ')) {
        elements.push(<h3 key={i} className="text-xs font-bold text-zinc-300 mt-3 mb-1">{line.slice(4)}</h3>);
      } else if (line.startsWith('- ')) {
        const content = line.slice(2).replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>');
        elements.push(<li key={i} className="text-xs text-zinc-400 ml-4 leading-relaxed" dangerouslySetInnerHTML={{ __html: content }} />);
      } else if (line.match(/^\d+\.\s/)) {
        const content = line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>');
        elements.push(<li key={i} className="text-xs text-zinc-400 ml-4 leading-relaxed list-decimal" dangerouslySetInnerHTML={{ __html: content }} />);
      } else if (line.trim()) {
        const content = line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>');
        elements.push(<p key={i} className="text-xs text-zinc-400 leading-relaxed" dangerouslySetInnerHTML={{ __html: content }} />);
      } else {
        elements.push(<div key={i} className="h-2" />);
      }
    }

    return elements;
  };

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0a0a0a]">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-cyan-500/10">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">
            AI Performance Autopilot
          </span>
        </div>
        <button
          onClick={runAutopilot}
          disabled={isLoading || !connection}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-colors",
            isLoading
              ? "bg-cyan-600/20 text-cyan-400 cursor-wait"
              : "bg-cyan-600 hover:bg-cyan-500 text-white"
          )}
        >
          {isLoading ? (
            <><Loader2 className="w-3 h-3 animate-spin" /> Analyzing...</>
          ) : (
            <><RefreshCw className="w-3 h-3" /> {report ? 'Re-analyze' : 'Run Analysis'}</>
          )}
        </button>
      </div>

      {/* Content */}
      <div ref={reportRef} className="flex-1 overflow-auto p-4">
        {!report && !isLoading && !error && (
          <div className="flex flex-col items-center justify-center h-full opacity-40">
            <Sparkles className="w-8 h-8 mb-3" />
            <p className="text-sm font-medium">AI Performance Autopilot</p>
            <p className="text-[10px] text-zinc-500 mt-1">
              Click &quot;Run Analysis&quot; to get AI-powered optimization recommendations
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {report && (
          <div className="prose prose-invert prose-xs max-w-none">
            {renderMarkdown(report)}
          </div>
        )}
      </div>
    </div>
  );
}
