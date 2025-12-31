"use client";

import React, { useMemo, useState } from 'react';
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
            <span className="text-[11px] font-medium text-zinc-200 truncate">{nodeType}</span>
            {node['Relation Name'] && (
              <span className="text-[10px] text-zinc-500 font-mono truncate">{node['Relation Name']}</span>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-[10px] font-mono">
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
            <div className="flex items-start gap-2 py-1 text-[10px]">
              <span className="text-amber-500/70 font-medium shrink-0">Filter:</span>
              <span className="text-zinc-500 font-mono break-all">{node['Filter']}</span>
            </div>
          )}
          {/* Index info */}
          {node['Index Name'] && (
            <div className="flex items-center gap-2 py-1 text-[10px]">
              <span className="text-emerald-500/70 font-medium">Index:</span>
              <span className="text-emerald-400 font-mono">{node['Index Name']}</span>
            </div>
          )}
          {/* Buffer stats */}
          {((node['Shared Hit Blocks'] ?? 0) > 0 || (node['Shared Read Blocks'] ?? 0) > 0) && (
            <div className="flex items-center gap-4 py-1 text-[10px] text-zinc-600">
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
// Main Component
// ============================================================================

export function VisualExplain({ plan }: VisualExplainProps) {
  const [activeTab, setActiveTab] = useState<'insights' | 'tree' | 'raw'>('insights');

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
              <span className="text-[13px] font-medium text-zinc-200">
                {formatTime(analysis?.executionTime || 0)}
              </span>
              <span className="text-[10px] text-zinc-600">execution</span>
            </div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-[13px] font-medium text-zinc-400">
                {formatNumber(analysis?.totalRows || 0)}
              </span>
              <span className="text-[10px] text-zinc-600">rows</span>
            </div>
            <div className="flex items-center gap-2">
              <HardDrive className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-[13px] font-medium text-zinc-400">
                {formatNumber(analysis?.totalCost || 0)}
              </span>
              <span className="text-[10px] text-zinc-600">cost</span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
            {(['insights', 'tree', 'raw'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-3 py-1 text-[10px] font-medium rounded-md transition-all uppercase tracking-wide",
                  activeTab === tab
                    ? "bg-white/10 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {tab === 'insights' && <Zap className="w-3 h-3 inline mr-1" />}
                {tab === 'tree' && <Layers className="w-3 h-3 inline mr-1" />}
                {tab === 'raw' && <FileJson className="w-3 h-3 inline mr-1" />}
                {tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'insights' && (
          <div className="p-4 space-y-4">
            {/* Warnings */}
            {analysis && analysis.warnings.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">
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
                        "text-[11px] font-medium",
                        warning.type === 'critical'
                          ? "text-red-300"
                          : warning.type === 'warning'
                          ? "text-amber-300"
                          : "text-blue-300"
                      )}>
                        {warning.title}
                      </h4>
                      <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">
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
                  <h4 className="text-[11px] font-medium text-emerald-300">Query looks good</h4>
                  <p className="text-[10px] text-zinc-500">No obvious performance issues detected.</p>
                </div>
              </div>
            )}

            {/* Metrics Grid */}
            <div className="grid grid-cols-3 gap-2">
              {analysis?.insights.map((insight, idx) => (
                <div key={idx} className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={insight.status} />
                    <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-medium">
                      {insight.label}
                    </span>
                  </div>
                  <span className="text-lg font-medium text-zinc-200">{insight.value}</span>
                </div>
              ))}
            </div>

            {/* Plan tree preview */}
            <div>
              <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">
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
            <pre className="text-[10px] font-mono text-zinc-400 bg-white/[0.02] rounded-lg p-4 overflow-auto border border-white/5">
              {JSON.stringify(plan, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}