"use client";

import React, { useState } from 'react';
import { FileText, Loader2, Search, Sparkles, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableSchema } from '@/lib/types';

interface DatabaseDocsProps {
  schema: TableSchema[];
  schemaContext: string;
  databaseType?: string;
}

export function DatabaseDocs({ schema, schemaContext, databaseType }: DatabaseDocsProps) {
  const [search, setSearch] = useState('');
  const [aiDocs, setAiDocs] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredSchema = schema.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.columns?.some(c => c.name.toLowerCase().includes(search.toLowerCase()))
  );

  const generateAiDocs = async () => {
    setIsAiLoading(true);
    setError(null);
    setAiDocs('');

    try {
      let filteredSchemaStr = '';
      if (schemaContext) {
        try {
          const tables = JSON.parse(schemaContext);
          filteredSchemaStr = tables.slice(0, 50).map((t: { name: string; rowCount?: number; columns?: { name: string; type: string; isPrimary?: boolean; isNullable?: boolean }[] }) => {
            const cols = t.columns?.map(c =>
              `${c.name} (${c.type}${c.isPrimary ? ', PK' : ''}${c.isNullable === false ? ', NOT NULL' : ''})`
            ).join(', ') || '';
            return `Table: ${t.name} (${t.rowCount || 0} rows)\nColumns: ${cols}`;
          }).join('\n\n');
        } catch {
          filteredSchemaStr = schemaContext.substring(0, 5000);
        }
      }

      const response = await fetch('/api/ai/describe-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaContext: filteredSchemaStr,
          databaseType,
          mode: 'full',
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Documentation generation failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader');

      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += new TextDecoder().decode(value);
        setAiDocs(full);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsAiLoading(false);
    }
  };

  const exportMarkdown = () => {
    let md = `# Database Documentation\n\n`;
    md += `**Type:** ${databaseType || 'Unknown'}\n`;
    md += `**Tables:** ${schema.length}\n\n`;

    if (aiDocs) {
      md += `## AI Analysis\n\n${aiDocs}\n\n---\n\n`;
    }

    md += `## Table Reference\n\n`;

    for (const table of schema) {
      md += `### ${table.name}\n\n`;
      if (table.rowCount !== undefined) md += `Rows: ${table.rowCount.toLocaleString()}\n\n`;

      if (table.columns && table.columns.length > 0) {
        md += `| Column | Type | Primary | Nullable |\n|--------|------|---------|----------|\n`;
        for (const col of table.columns) {
          md += `| ${col.name} | ${col.type} | ${col.isPrimary ? 'Yes' : ''} | ${col.nullable !== false ? 'Yes' : 'No'} |\n`;
        }
        md += '\n';
      }
    }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'database-docs.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Simple markdown rendering for AI docs
  const renderMarkdown = (text: string) => {
    return text.split('\n').map((line, i) => {
      if (line.startsWith('## ')) return <h2 key={i} className="text-xs font-medium text-zinc-200 mt-4 mb-2">{line.slice(3)}</h2>;
      if (line.startsWith('### ')) return <h3 key={i} className="text-xs font-medium text-zinc-300 mt-3 mb-1">{line.slice(4)}</h3>;
      if (line.startsWith('- ')) {
        const content = line.slice(2).replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>');
        return <li key={i} className="text-xs text-zinc-400 ml-4 leading-relaxed" dangerouslySetInnerHTML={{ __html: content }} />;
      }
      if (line.match(/^\d+\.\s/)) {
        const content = line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>');
        return <li key={i} className="text-xs text-zinc-400 ml-4 leading-relaxed list-decimal" dangerouslySetInnerHTML={{ __html: content }} />;
      }
      if (line.trim()) {
        const content = line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-zinc-200">$1</strong>');
        return <p key={i} className="text-xs text-zinc-400 leading-relaxed" dangerouslySetInnerHTML={{ __html: content }} />;
      }
      return <div key={i} className="h-1.5" />;
    });
  };

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0a0a0a]">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-teal-500/10">
            <FileText className="w-3.5 h-3.5 text-teal-400" />
          </div>
          <span className="text-xs font-medium text-teal-400">
            Database Docs
          </span>
          <span className="text-[0.625rem] text-zinc-500 font-mono">{schema.length} tables</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={generateAiDocs}
            disabled={isAiLoading}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors",
              isAiLoading
                ? "bg-teal-600/20 text-teal-400 cursor-wait"
                : "bg-teal-600 hover:bg-teal-500 text-white"
            )}
          >
            {isAiLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {aiDocs ? 'Regenerate' : 'AI Describe'}
          </button>
          <button
            onClick={exportMarkdown}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 text-zinc-400 text-xs font-medium hover:bg-white/10 transition-colors"
          >
            <Download className="w-3 h-3" /> Export MD
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-white/5 bg-[#0a0a0a]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tables or columns..."
            className="w-full bg-[#111] border border-white/10 rounded-lg pl-7 pr-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-teal-500/30"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* AI Documentation Section */}
        {(aiDocs || isAiLoading) && (
          <div className="bg-teal-500/5 border border-teal-500/10 rounded-lg p-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-3.5 h-3.5 text-teal-400" />
              <span className="text-xs font-medium text-teal-400">
                AI-Generated Documentation
              </span>
              {isAiLoading && <Loader2 className="w-3 h-3 animate-spin text-teal-400" />}
            </div>
            {aiDocs && (
              <div className="prose prose-invert prose-xs max-w-none">
                {renderMarkdown(aiDocs)}
              </div>
            )}
          </div>
        )}

        {/* Table Reference */}
        <h3 className="text-xs font-medium text-zinc-400">Table Reference</h3>
        {filteredSchema.map(table => (
          <div key={table.name} className="bg-[#0a0a0a] border border-white/5 rounded-lg overflow-hidden">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-zinc-200">{table.name}</span>
                {table.rowCount !== undefined && (
                  <span className="text-xs text-zinc-500 font-mono">{table.rowCount.toLocaleString()} rows</span>
                )}
              </div>
              <span className="text-xs text-zinc-600">{table.columns?.length || 0} columns</span>
            </div>
            {table.columns && table.columns.length > 0 && (
              <div className="border-t border-white/5">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-zinc-500">
                      <th className="text-left px-3 py-1 font-normal">Column</th>
                      <th className="text-left px-3 py-1 font-normal">Type</th>
                      <th className="text-left px-3 py-1 font-normal">PK</th>
                      <th className="text-left px-3 py-1 font-normal">Nullable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.columns.map(col => (
                      <tr key={col.name} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                        <td className="px-3 py-1 text-zinc-300 font-mono">{col.name}</td>
                        <td className="px-3 py-1 text-zinc-500 font-mono">{col.type}</td>
                        <td className="px-3 py-1">
                          {col.isPrimary && <span className="text-amber-400 text-[0.625rem] font-medium">PK</span>}
                        </td>
                        <td className="px-3 py-1 text-zinc-600">{col.nullable !== false ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
