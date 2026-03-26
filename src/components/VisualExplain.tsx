"use client";

import React, { useMemo, useState, useCallback, useRef } from 'react';
import {
  Zap,
  Search,
  ArrowDown,
  Layers,
  Database,
  Clock,
  LayoutGrid,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  HardDrive,
  Target,
  ChevronRight,
  Info,
  FileJson,
  Activity,
  Sparkles,
  Play,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ExplainPlanNode = {
  Plan?: ExplainPlanNode;
  'Node Type'?: string;
  'Actual Rows'?: number;
  'Plan Rows'?: number;
  'Actual Total Time'?: number;
  'Total Cost'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Relation Name'?: string;
  'Actual Loops'?: number;
  Filter?: string;
  'Index Name'?: string;
  Plans?: ExplainPlanNode[];
};

export type ExplainPlanResult = {
  Plan?: ExplainPlanNode;
  'Execution Time'?: number;
  'Planning Time'?: number;
};

interface VisualExplainProps {
  plan: ExplainPlanResult[] | null | undefined;
  query?: string;
  schemaContext?: string;
  databaseType?: string;
  onLoadQuery?: (query: string) => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toFixed(0);
}


function formatTime(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${(ms * 1000).toFixed(0)}μs`;
}

// ============================================================================
// Analysis Functions
// ============================================================================

interface PlanAnalysis {
  totalTime: number;
  planningTime: number;
  executionTime: number;
  totalRows: number;
  totalCost: number;
  bufferHits: number;
  bufferReads: number;
  nodeCount: number;
  warnings: Warning[];
  insights: Insight[];
}

interface Warning {
  type: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  node?: string;
}

interface Insight {
  label: string;
  value: string;
  status: 'good' | 'warning' | 'critical';
}

function analyzePlan(plan: ExplainPlanResult[]): PlanAnalysis {
  const warnings: Warning[] = [];
  const insights: Insight[] = [];
  let totalRows = 0;
  let nodeCount = 0;
  let bufferHits = 0;
  let bufferReads = 0;

  const rootPlan = plan?.[0]?.Plan;
  const executionTime = plan?.[0]?.['Execution Time'] || rootPlan?.['Actual Total Time'] || 0;
  const planningTime = plan?.[0]?.['Planning Time'] || 0;
  const totalCost = rootPlan?.['Total Cost'] || 0;

  // Recursive node analysis
  function analyzeNode(node: ExplainPlanNode, depth: number = 0) {
    if (!node) return;
    nodeCount++;

    const nodeType = node['Node Type'] || '';
    const actualRows = node['Actual Rows'] || 0;
    const planRows = node['Plan Rows'] || 0;
    const actualTime = node['Actual Total Time'] || 0;

    totalRows += actualRows;
    bufferHits += node['Shared Hit Blocks'] || 0;
    bufferReads += node['Shared Read Blocks'] || 0;

    // Check for Sequential Scan on large tables
    if (nodeType.includes('Seq Scan') && actualRows > 10000) {
      warnings.push({
        type: 'warning',
        title: 'Sequential Scan',
        description: `Full table scan on "${node['Relation Name'] || 'table'}" (${formatNumber(actualRows)} rows). Consider adding an index.`,
        node: nodeType,
      });
    }

    // Check for row estimate mismatch
    if (planRows > 0 && actualRows > 0) {
      const ratio = actualRows / planRows;
      if (ratio > 10 || ratio < 0.1) {
        warnings.push({
          type: 'info',
          title: 'Estimate Mismatch',
          description: `Expected ${formatNumber(planRows)} rows, got ${formatNumber(actualRows)}. Statistics may be outdated.`,
          node: nodeType,
        });
      }
    }

    // Check for expensive sorts
    if (nodeType.includes('Sort') && actualTime > 100) {
      warnings.push({
        type: 'warning',
        title: 'Expensive Sort',
        description: `Sort operation took ${formatTime(actualTime)}. Consider adding an index for ordered access.`,
        node: nodeType,
      });
    }

    // Check for nested loops with high iterations
    const actualLoops = node['Actual Loops'] ?? 1;
    if (nodeType.includes('Nested Loop') && actualLoops > 1000) {
      warnings.push({
        type: 'critical',
        title: 'High Loop Count',
        description: `Nested loop executed ${formatNumber(actualLoops)} times. This could indicate an N+1 problem.`,
        node: nodeType,
      });
    }

    // Recurse into children
    (node['Plans'] || []).forEach((child) => analyzeNode(child, depth + 1));
  }

  if (rootPlan) {
    analyzeNode(rootPlan);
  }

  // Build insights
  insights.push({
    label: 'Cache Hit Rate',
    value: bufferHits + bufferReads > 0
      ? `${((bufferHits / (bufferHits + bufferReads)) * 100).toFixed(1)}%`
      : 'N/A',
    status: bufferHits / (bufferHits + bufferReads || 1) > 0.95 ? 'good' : 'warning',
  });

  insights.push({
    label: 'Operations',
    value: nodeCount.toString(),
    status: nodeCount > 20 ? 'warning' : 'good',
  });

  insights.push({
    label: 'Execution',
    value: formatTime(executionTime),
    status: executionTime > 1000 ? 'critical' : executionTime > 100 ? 'warning' : 'good',
  });

  return {
    totalTime: executionTime + planningTime,
    planningTime,
    executionTime,
    totalRows,
    totalCost,
    bufferHits,
    bufferReads,
    nodeCount,
    warnings,
    insights,
  };
}

// ============================================================================
// Components
// ============================================================================

const NodeIcon = ({ type }: { type: string }) => {
  if (type.includes('Seq Scan')) return <Search className="w-4 h-4 text-amber-400" />;
  if (type.includes('Index Scan') || type.includes('Index Only')) return <Target className="w-4 h-4 text-emerald-400" />;
  if (type.includes('Scan')) return <Search className="w-4 h-4 text-blue-400" />;
  if (type.includes('Join')) return <Layers className="w-4 h-4 text-purple-400" />;
  if (type.includes('Sort')) return <ArrowDown className="w-4 h-4 text-amber-400" />;
  if (type.includes('Limit')) return <LayoutGrid className="w-4 h-4 text-zinc-400" />;
  if (type.includes('Aggregate') || type.includes('Group')) return <Zap className="w-4 h-4 text-pink-400" />;
  if (type.includes('Hash')) return <HardDrive className="w-4 h-4 text-cyan-400" />;
  return <Database className="w-4 h-4 text-zinc-500" />;
};

const StatusBadge = ({ status }: { status: 'good' | 'warning' | 'critical' }) => {
  return <div className={cn('w-2 h-2 rounded-full', status === 'good' ? 'bg-emerald-500' : status === 'warning' ? 'bg-amber-500' : 'bg-red-500')} />;
};

// Compact Plan Node
const PlanNode = ({ node, depth = 0, maxTime }: { node: ExplainPlanNode; depth?: number; maxTime: number }) => {
  const [expanded, setExpanded] = useState(depth < 2);
  const nodeType = node['Node Type'] || 'Unknown';
  const actualTime = node['Actual Total Time'] || 0;
  const actualRows = node['Actual Rows'] || 0;
  const children = node['Plans'] || [];
  const isIndexScan = nodeType.includes('Index');
  const isSeqScan = nodeType.includes('Seq Scan');

  const timePercent = maxTime > 0 ? (actualTime / maxTime) * 100 : 0;

  return (
    <div className="relative">
      {/* Node */}
      <div
        className={cn(
          "group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-all cursor-pointer hover:bg-white/5",
          depth === 0 && "bg-white/[0.02]"
        )}
        onClick={() => setExpanded(!expanded)}
        style={{ marginLeft: depth * 20 }}
      >
        {/* Expand icon */}
        {children.length > 0 && (
          <ChevronRight className={cn("w-3 h-3 text-zinc-600 transition-transform", expanded && "rotate-90")} />
        )}
        {children.length === 0 && <div className="w-3" />}

        {/* Icon */}
        <div className={cn(
          "p-1 rounded",
          isSeqScan ? "bg-amber-500/10" : isIndexScan ? "bg-emerald-500/10" : "bg-white/5"
        )}>
          <NodeIcon type={nodeType} />
        </div>

        {/* Type & Table */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-body font-medium text-zinc-200 truncate">{nodeType}</span>
            {node['Relation Name'] && (
              <span className="text-xs text-zinc-500 font-mono truncate">{node['Relation Name']}</span>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-xs font-mono">
          <span className="text-zinc-500 w-16 text-right">{formatNumber(actualRows)} rows</span>
          <span className={cn(
            "w-16 text-right",
            timePercent > 50 ? "text-red-400" : timePercent > 20 ? "text-amber-400" : "text-zinc-400"
          )}>
            {formatTime(actualTime)}
          </span>
          {/* Time bar */}
          <div className="w-20 h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                timePercent > 50 ? "bg-red-500" : timePercent > 20 ? "bg-amber-500" : "bg-blue-500"
              )}
              style={{ width: `${Math.min(timePercent, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Details on expand */}
      {expanded && (
        <div className="ml-8 pl-4 border-l border-white/5" style={{ marginLeft: depth * 20 + 32 }}>
          {/* Filter info */}
          {node['Filter'] && (
            <div className="flex items-start gap-2 py-1 text-xs">
              <span className="text-amber-500/70 font-medium shrink-0">Filter:</span>
              <span className="text-zinc-500 font-mono break-all">{node['Filter']}</span>
            </div>
          )}
          {/* Index info */}
          {node['Index Name'] && (
            <div className="flex items-center gap-2 py-1 text-xs">
              <span className="text-emerald-500/70 font-medium">Index:</span>
              <span className="text-emerald-400 font-mono">{node['Index Name']}</span>
            </div>
          )}
          {/* Buffer stats */}
          {((node['Shared Hit Blocks'] ?? 0) > 0 || (node['Shared Read Blocks'] ?? 0) > 0) && (
            <div className="flex items-center gap-4 py-1 text-xs text-zinc-600">
              {(node['Shared Hit Blocks'] ?? 0) > 0 && <span>Cache hits: {node['Shared Hit Blocks']}</span>}
              {(node['Shared Read Blocks'] ?? 0) > 0 && <span>Disk reads: {node['Shared Read Blocks']}</span>}
            </div>
          )}

          {/* Children */}
          {children.map((child, idx) => (
            <PlanNode key={idx} node={child} depth={depth + 1} maxTime={maxTime} />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// AI Explain Tab Component
// ============================================================================

function AIExplainTab({
  plan,
  query,
  schemaContext,
  databaseType,
  onLoadQuery,
}: {
  plan: ExplainPlanResult[];
  query?: string;
  schemaContext?: string;
  databaseType?: string;
  onLoadQuery?: (query: string) => void;
}) {
  const [aiResponse, setAiResponse] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const analyzeWithAI = useCallback(async () => {
    if (!query && !plan) return;

    setIsLoading(true);
    setAiResponse('');
    setError(null);
    setHasRun(true);

    // Abort previous request if any
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query || 'Unknown query',
          explainPlan: plan,
          schemaContext: schemaContext || '',
          databaseType: databaseType || 'postgres',
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'AI analysis failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        setAiResponse(accumulated);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'AI analysis failed');
    } finally {
      setIsLoading(false);
    }
  }, [query, plan, schemaContext, databaseType]);


  // Simple markdown renderer for the AI response
  const renderMarkdown = (text: string) => {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockContent = '';

    lines.forEach((line, idx) => {
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          // End code block
          const content = codeBlockContent;
          const isSql = codeBlockLang === 'sql';
          elements.push(
            <div key={`code-${idx}`} className="my-3 relative group/code">
              <pre className={cn(
                "text-body font-mono p-3 rounded-lg overflow-x-auto border",
                isSql ? "bg-blue-500/5 border-blue-500/10 text-blue-300" : "bg-white/[0.02] border-white/5 text-zinc-400"
              )}>
                {content}
              </pre>
              {isSql && onLoadQuery && (
                <button
                  onClick={() => onLoadQuery(content)}
                  className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1"
                >
                  <Play className="w-3 h-3" /> Try This
                </button>
              )}
            </div>
          );
          codeBlockContent = '';
          inCodeBlock = false;
        } else {
          // Start code block
          inCodeBlock = true;
          codeBlockLang = line.slice(3).trim();
          codeBlockContent = '';
        }
        return;
      }

      if (inCodeBlock) {
        codeBlockContent += (codeBlockContent ? '\n' : '') + line;
        return;
      }

      // Headers
      if (line.startsWith('## ')) {
        elements.push(
          <h2 key={idx} className="text-body font-bold text-zinc-200 mt-4 mb-2 flex items-center gap-2">
            {line.slice(3)}
          </h2>
        );
      } else if (line.startsWith('### ')) {
        elements.push(
          <h3 key={idx} className="text-data font-semibold text-zinc-300 mt-3 mb-1">
            {line.slice(4)}
          </h3>
        );
      } else if (line.startsWith('- ')) {
        elements.push(
          <div key={idx} className="flex items-start gap-2 text-body text-zinc-400 leading-relaxed ml-2 my-0.5">
            <span className="text-zinc-600 mt-1 shrink-0">•</span>
            <span>{renderInlineFormatting(line.slice(2))}</span>
          </div>
        );
      } else if (/^\d+\.\s/.test(line)) {
        const num = line.match(/^(\d+)\./)?.[1];
        elements.push(
          <div key={idx} className="flex items-start gap-2 text-body text-zinc-400 leading-relaxed ml-2 my-0.5">
            <span className="text-blue-400 font-bold mt-0 shrink-0 w-4">{num}.</span>
            <span>{renderInlineFormatting(line.replace(/^\d+\.\s*/, ''))}</span>
          </div>
        );
      } else if (line.trim() === '') {
        elements.push(<div key={idx} className="h-1" />);
      } else {
        elements.push(
          <p key={idx} className="text-body text-zinc-400 leading-relaxed my-0.5">
            {renderInlineFormatting(line)}
          </p>
        );
      }
    });

    return elements;
  };

  const renderInlineFormatting = (text: string): React.ReactNode => {
    // Bold **text**
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="text-zinc-200 font-medium">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return <code key={i} className="text-blue-400 bg-blue-500/10 px-1 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
      }
      return part;
    });
  };

  // Not run yet state
  if (!hasRun) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/10 flex items-center justify-center mb-4">
          <Sparkles className="w-7 h-7 text-purple-400" />
        </div>
        <h3 className="text-sm font-semibold text-zinc-200 mb-1">AI Query Analysis</h3>
        <p className="text-body text-zinc-500 max-w-[280px] leading-relaxed mb-4">
          Get a plain-language explanation of your query&apos;s execution plan with concrete optimization suggestions.
        </p>
        <button
          onClick={analyzeWithAI}
          disabled={!query}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all",
            query
              ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/20"
              : "bg-white/5 text-zinc-600 cursor-not-allowed"
          )}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Analyze with AI
        </button>
        {!query && (
          <p className="text-xs text-zinc-600 mt-2">Run a query first to enable AI analysis.</p>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Re-analyze button */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-[#0a0a0a]">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-xs font-bold text-purple-400 uppercase tracking-wider">AI Analysis</span>
        </div>
        <button
          onClick={analyzeWithAI}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-all"
        >
          {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          {isLoading ? 'Analyzing...' : 'Re-analyze'}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/10 text-red-400 text-xs mb-4">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {aiResponse && (
          <div className="space-y-0">
            {renderMarkdown(aiResponse)}
          </div>
        )}

        {isLoading && !aiResponse && (
          <div className="flex items-center gap-3 text-zinc-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
            <span>Analyzing execution plan...</span>
          </div>
        )}

        {isLoading && aiResponse && (
          <div className="flex items-center gap-2 mt-2 text-zinc-600 text-xs">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Still generating...</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function VisualExplain({ plan, query, schemaContext, databaseType, onLoadQuery }: VisualExplainProps) {
  const [activeTab, setActiveTab] = useState<'insights' | 'tree' | 'raw' | 'ai'>('insights');

  const analysis = useMemo(() => {
    if (!plan || !Array.isArray(plan) || plan.length === 0) return null;
    return analyzePlan(plan);
  }, [plan]);

  // Empty state
  if (!plan || !Array.isArray(plan) || plan.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-zinc-500 bg-[#080808] p-12 text-center">
        <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-4">
          <Activity className="w-6 h-6 text-zinc-600" />
        </div>
        <h3 className="text-sm font-medium text-zinc-300 mb-1">No execution plan</h3>
        <p className="text-xs text-zinc-600 max-w-[240px]">
          Run a SELECT query to see its execution plan and performance insights.
        </p>
      </div>
    );
  }

  const rootPlan = plan[0]?.Plan;

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Header Stats */}
      <div className="px-4 py-3 border-b border-white/5 bg-[#0a0a0a]">
        <div className="flex items-center justify-between">
          {/* Quick stats */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-body font-medium text-zinc-200">
                {formatTime(analysis?.executionTime || 0)}
              </span>
              <span className="text-xs text-zinc-600">execution</span>
            </div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-body font-medium text-zinc-400">
                {formatNumber(analysis?.totalRows || 0)}
              </span>
              <span className="text-xs text-zinc-600">rows</span>
            </div>
            <div className="flex items-center gap-2">
              <HardDrive className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-body font-medium text-zinc-400">
                {formatNumber(analysis?.totalCost || 0)}
              </span>
              <span className="text-xs text-zinc-600">cost</span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
            {(['insights', 'ai', 'tree', 'raw'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-all uppercase tracking-wide",
                  activeTab === tab
                    ? tab === 'ai' ? "bg-purple-500/20 text-purple-300" : "bg-white/10 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {tab === 'insights' && <Zap className="w-3 h-3 inline mr-1" />}
                {tab === 'ai' && <Sparkles className="w-3 h-3 inline mr-1" />}
                {tab === 'tree' && <Layers className="w-3 h-3 inline mr-1" />}
                {tab === 'raw' && <FileJson className="w-3 h-3 inline mr-1" />}
                {tab === 'ai' ? 'AI Explain' : tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'ai' && (
          <AIExplainTab
            plan={plan}
            query={query}
            schemaContext={schemaContext}
            databaseType={databaseType}
            onLoadQuery={onLoadQuery}
          />
        )}

        {activeTab === 'insights' && (
          <div className="p-4 space-y-4">
            {/* Warnings */}
            {analysis && analysis.warnings.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">
                  Performance Issues
                </h3>
                {analysis.warnings.map((warning, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-lg border",
                      warning.type === 'critical'
                        ? "bg-red-500/5 border-red-500/10"
                        : warning.type === 'warning'
                        ? "bg-amber-500/5 border-amber-500/10"
                        : "bg-blue-500/5 border-blue-500/10"
                    )}
                  >
                    <div className={cn(
                      "p-1 rounded",
                      warning.type === 'critical'
                        ? "bg-red-500/10"
                        : warning.type === 'warning'
                        ? "bg-amber-500/10"
                        : "bg-blue-500/10"
                    )}>
                      {warning.type === 'critical' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                      ) : warning.type === 'warning' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                      ) : (
                        <Info className="w-3.5 h-3.5 text-blue-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className={cn(
                        "text-body font-medium",
                        warning.type === 'critical'
                          ? "text-red-300"
                          : warning.type === 'warning'
                          ? "text-amber-300"
                          : "text-blue-300"
                      )}>
                        {warning.title}
                      </h4>
                      <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                        {warning.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* No warnings */}
            {analysis && analysis.warnings.length === 0 && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                <div className="p-1 rounded bg-emerald-500/10">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                </div>
                <div>
                  <h4 className="text-body font-medium text-emerald-300">Query looks good</h4>
                  <p className="text-xs text-zinc-500">No obvious performance issues detected.</p>
                </div>
              </div>
            )}

            {/* Metrics Grid */}
            <div className="grid grid-cols-3 gap-2">
              {analysis?.insights.map((insight, idx) => (
                <div key={idx} className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={insight.status} />
                    <span className="text-label text-zinc-500 uppercase tracking-wider font-medium">
                      {insight.label}
                    </span>
                  </div>
                  <span className="text-lg font-medium text-zinc-200">{insight.value}</span>
                </div>
              ))}
            </div>

            {/* Plan tree preview */}
            <div>
              <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">
                Execution Plan
              </h3>
              <div className="rounded-lg border border-white/5 bg-white/[0.01] p-2">
                {rootPlan && analysis && (
                  <PlanNode node={rootPlan} maxTime={analysis.executionTime || 1} />
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'tree' && (
          <div className="p-4">
            <div className="rounded-lg border border-white/5 bg-white/[0.01] p-2">
              {rootPlan && analysis && (
                <PlanNode node={rootPlan} maxTime={analysis.executionTime || 1} />
              )}
            </div>
          </div>
        )}

        {activeTab === 'raw' && (
          <div className="p-4">
            <pre className="text-xs font-mono text-zinc-400 bg-white/[0.02] rounded-lg p-4 overflow-auto border border-white/5">
              {JSON.stringify(plan, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
