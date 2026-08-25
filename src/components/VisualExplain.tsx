"use client";

import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  Zap,
  Search,
  ArrowDown,
  Layers,
  Database,
  Clock,
  LayoutGrid,
  TriangleAlert,
  CircleCheck,
  TrendingUp,
  HardDrive,
  Target,
  ChevronRight,
  Info,
  FileBraces,
  Activity,
  Sparkles,
  Play,
  LoaderCircle,
  ListTree,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExplainPlanNode, ExplainPlanResult, ExplainPlanInput, ExplainTreeNode } from "@/lib/explain/types";

export type { ExplainPlanResult } from "@/lib/explain/types";

interface VisualExplainProps {
  plan: ExplainPlanResult[] | ExplainPlanInput | null | undefined;
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
  type: "critical" | "warning" | "info";
  title: string;
  description: string;
  node?: string;
}

interface Insight {
  label: string;
  value: string;
  status: "good" | "warning" | "critical";
}

function analyzePlan(plan: ExplainPlanResult[]): PlanAnalysis {
  const warnings: Warning[] = [];
  const insights: Insight[] = [];
  let totalRows = 0;
  let nodeCount = 0;
  let bufferHits = 0;
  let bufferReads = 0;

  const rootPlan = plan?.[0]?.Plan;
  const executionTime = plan?.[0]?.["Execution Time"] || rootPlan?.["Actual Total Time"] || 0;
  const planningTime = plan?.[0]?.["Planning Time"] || 0;
  const totalCost = rootPlan?.["Total Cost"] || 0;

  // Recursive node analysis
  function analyzeNode(node: ExplainPlanNode, depth: number = 0) {
    if (!node) return;
    nodeCount++;

    const nodeType = node["Node Type"] || "";
    const actualRows = node["Actual Rows"] || 0;
    const planRows = node["Plan Rows"] || 0;
    const actualTime = node["Actual Total Time"] || 0;

    totalRows += actualRows;
    bufferHits += node["Shared Hit Blocks"] || 0;
    bufferReads += node["Shared Read Blocks"] || 0;

    // Check for Sequential Scan on large tables
    if (nodeType.includes("Seq Scan") && actualRows > 10000) {
      warnings.push({
        type: "warning",
        title: "Sequential Scan",
        description: `Full table scan on "${node["Relation Name"] || "table"}" (${formatNumber(actualRows)} rows). Consider adding an index.`,
        node: nodeType,
      });
    }

    // Check for row estimate mismatch
    if (planRows > 0 && actualRows > 0) {
      const ratio = actualRows / planRows;
      if (ratio > 10 || ratio < 0.1) {
        warnings.push({
          type: "info",
          title: "Estimate Mismatch",
          description: `Expected ${formatNumber(planRows)} rows, got ${formatNumber(actualRows)}. Statistics may be outdated.`,
          node: nodeType,
        });
      }
    }

    // Check for expensive sorts
    if (nodeType.includes("Sort") && actualTime > 100) {
      warnings.push({
        type: "warning",
        title: "Expensive Sort",
        description: `Sort operation took ${formatTime(actualTime)}. Consider adding an index for ordered access.`,
        node: nodeType,
      });
    }

    // Check for nested loops with high iterations
    const actualLoops = node["Actual Loops"] ?? 1;
    if (nodeType.includes("Nested Loop") && actualLoops > 1000) {
      warnings.push({
        type: "critical",
        title: "High Loop Count",
        description: `Nested loop executed ${formatNumber(actualLoops)} times. This could indicate an N+1 problem.`,
        node: nodeType,
      });
    }

    // Recurse into children
    (node["Plans"] || []).forEach((child) => analyzeNode(child, depth + 1));
  }

  if (rootPlan) {
    analyzeNode(rootPlan);
  }

  // Build insights
  insights.push({
    label: "Cache Hit Rate",
    value: bufferHits + bufferReads > 0 ? `${((bufferHits / (bufferHits + bufferReads)) * 100).toFixed(1)}%` : "N/A",
    status: bufferHits / (bufferHits + bufferReads || 1) > 0.95 ? "good" : "warning",
  });

  insights.push({
    label: "Operations",
    value: nodeCount.toString(),
    status: nodeCount > 20 ? "warning" : "good",
  });

  insights.push({
    label: "Execution",
    value: formatTime(executionTime),
    status: executionTime > 1000 ? "critical" : executionTime > 100 ? "warning" : "good",
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
  if (type.includes("Seq Scan")) return <Search strokeWidth={1.5} className="w-3.5 h-3.5 text-amber-400" />;
  if (type.includes("Index Scan") || type.includes("Index Only"))
    return <Target strokeWidth={1.5} className="w-3.5 h-3.5 text-emerald-400" />;
  if (type.includes("Scan")) return <Search strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />;
  if (type.includes("Join")) return <Layers strokeWidth={1.5} className="w-3.5 h-3.5 text-purple-400" />;
  if (type.includes("Sort")) return <ArrowDown strokeWidth={1.5} className="w-3.5 h-3.5 text-amber-400" />;
  if (type.includes("Limit")) return <LayoutGrid strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-tertiary" />;
  if (type.includes("Aggregate") || type.includes("Group"))
    return <Zap strokeWidth={1.5} className="w-3.5 h-3.5 text-pink-400" />;
  if (type.includes("Hash")) return <HardDrive strokeWidth={1.5} className="w-3.5 h-3.5 text-cyan-400" />;
  return <Database strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-muted" />;
};

const StatusBadge = ({ status }: { status: "good" | "warning" | "critical" }) => {
  return (
    <div
      className={cn(
        "w-2 h-2 rounded-full",
        status === "good" ? "bg-emerald-500" : status === "warning" ? "bg-amber-500" : "bg-red-500",
      )}
    />
  );
};

// Compact Plan Node
const PlanNode = ({ node, depth = 0, maxTime }: { node: ExplainPlanNode; depth?: number; maxTime: number }) => {
  const [expanded, setExpanded] = useState(depth < 2);
  const nodeType = node["Node Type"] || "Unknown";
  const actualTime = node["Actual Total Time"] || 0;
  const actualRows = node["Actual Rows"] || 0;
  const children = node["Plans"] || [];
  const isIndexScan = nodeType.includes("Index");
  const isSeqScan = nodeType.includes("Seq Scan");

  const timePercent = maxTime > 0 ? (actualTime / maxTime) * 100 : 0;

  return (
    <div className="relative">
      {/* Node */}
      <button
        type="button"
        aria-expanded={expanded}
        className={cn(
          // display:flex makes the button block-level with auto width, so the
          // depth margin is deducted from the available width (w-full would
          // overflow by depth * 20px)
          "text-left group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-all cursor-pointer hover:bg-fill",
          depth === 0 && "bg-fill-subtle",
        )}
        onClick={() => setExpanded(!expanded)}
        style={{ marginLeft: depth * 20 }}
      >
        {/* Expand icon */}
        {children.length > 0 && (
          <ChevronRight className={cn("w-3 h-3 text-fg-subtle transition-transform", expanded && "rotate-90")} />
        )}
        {children.length === 0 && <div className="w-3" />}

        {/* Icon */}
        <div
          className={cn("p-1 rounded", isSeqScan ? "bg-amber-500/10" : isIndexScan ? "bg-emerald-500/10" : "bg-fill")}
        >
          <NodeIcon type={nodeType} />
        </div>

        {/* Type & Table */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-fg truncate">{nodeType}</span>
            {node["Relation Name"] && (
              <span className="text-xs text-fg-muted font-mono truncate">{node["Relation Name"]}</span>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-xs font-mono">
          <span className="text-fg-muted w-16 text-right">{formatNumber(actualRows)} rows</span>
          <span
            className={cn(
              "w-16 text-right",
              timePercent > 50 ? "text-red-400" : timePercent > 20 ? "text-amber-400" : "text-fg-tertiary",
            )}
          >
            {formatTime(actualTime)}
          </span>
          {/* Time bar */}
          <div className="w-20 h-1.5 bg-fill rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                timePercent > 50 ? "bg-red-500" : timePercent > 20 ? "bg-amber-500" : "bg-blue-500",
              )}
              style={{ width: `${Math.min(timePercent, 100)}%` }}
            />
          </div>
        </div>
      </button>

      {/* Details on expand */}
      {expanded && (
        <div className="ml-8 pl-4 border-l border-hairline" style={{ marginLeft: depth * 20 + 32 }}>
          {/* Filter info */}
          {node["Filter"] && (
            <div className="flex items-start gap-2 py-1 text-xs">
              <span className="text-amber-500/70 font-medium shrink-0">Filter:</span>
              <span className="text-fg-muted font-mono break-all">{node["Filter"]}</span>
            </div>
          )}
          {/* Index info */}
          {node["Index Name"] && (
            <div className="flex items-center gap-2 py-1 text-xs">
              <span className="text-emerald-500/70 font-medium">Index:</span>
              <span className="text-emerald-400 font-mono">{node["Index Name"]}</span>
            </div>
          )}
          {/* Buffer stats */}
          {((node["Shared Hit Blocks"] ?? 0) > 0 || (node["Shared Read Blocks"] ?? 0) > 0) && (
            <div className="flex items-center gap-4 py-1 text-xs text-fg-subtle">
              {(node["Shared Hit Blocks"] ?? 0) > 0 && <span>Cache hits: {node["Shared Hit Blocks"]}</span>}
              {(node["Shared Read Blocks"] ?? 0) > 0 && <span>Disk reads: {node["Shared Read Blocks"]}</span>}
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

function countTreeNodes(node: ExplainTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countTreeNodes(child), 0);
}

// Generic tree renderer for dialects with no postgres-shaped cost/timing fields
// (e.g. SQLite's EXPLAIN QUERY PLAN). Mirrors PlanNode's indent/border/expand
// conventions but only shows metric badges when the node actually carries them
// — never fabricates "0 rows" / "0μs" for metric-less plans.
const TreeNodeView = ({ node, depth = 0 }: { node: ExplainTreeNode; depth?: number }) => {
  const [expanded, setExpanded] = useState(depth < 2);
  const children = node.children;
  const hasChildren = children.length > 0;
  const metrics = node.metrics;
  const hasMetrics =
    metrics !== undefined &&
    (metrics.actualRows !== undefined ||
      metrics.actualTimeMs !== undefined ||
      metrics.estRows !== undefined ||
      metrics.estCost !== undefined);

  const toggle = () => setExpanded((prev) => !prev);

  const rowContent = (
    <>
      {/* Expand icon */}
      {hasChildren ? (
        <ChevronRight className={cn("w-3 h-3 text-fg-subtle transition-transform", expanded && "rotate-90")} />
      ) : (
        <div className="w-3" />
      )}

      {/* Icon */}
      <div className="p-1 rounded bg-fill">
        <ListTree strokeWidth={1.5} className="w-3 h-3 text-fg-tertiary" />
      </div>

      {/* Label */}
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-fg truncate">{node.label}</span>
      </div>

      {/* Metric badges — only when the node actually carries metrics */}
      {hasMetrics && (
        <div className="flex items-center gap-4 text-xs font-mono">
          {metrics!.actualRows !== undefined && (
            <span className="text-fg-muted w-16 text-right">{formatNumber(metrics!.actualRows)} rows</span>
          )}
          {metrics!.estRows !== undefined && (
            <span className="text-fg-muted w-16 text-right">~{formatNumber(metrics!.estRows)} rows</span>
          )}
          {metrics!.actualTimeMs !== undefined && (
            <span className="text-fg-tertiary w-16 text-right">{formatTime(metrics!.actualTimeMs)}</span>
          )}
          {metrics!.estCost !== undefined && (
            <span className="text-fg-tertiary w-16 text-right">cost {formatNumber(metrics!.estCost)}</span>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="relative">
      {/* Expandable rows are native buttons; leaves are plain divs */}
      {hasChildren ? (
        <button
          type="button"
          className="text-left group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-all cursor-pointer hover:bg-fill"
          onClick={toggle}
          aria-expanded={expanded}
          style={{ marginLeft: depth * 20 }}
        >
          {rowContent}
        </button>
      ) : (
        <div
          className="group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-all"
          style={{ marginLeft: depth * 20 }}
        >
          {rowContent}
        </div>
      )}

      {/* Children */}
      {expanded && hasChildren && (
        <div className="ml-8 pl-4 border-l border-hairline" style={{ marginLeft: depth * 20 + 32 }}>
          {children.map((child, idx) => (
            <TreeNodeView key={idx} node={child} depth={depth + 1} />
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
  plan: unknown;
  query?: string;
  schemaContext?: string;
  databaseType?: string;
  onLoadQuery?: (query: string) => void;
}) {
  const [aiResponse, setAiResponse] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Nothing else observes a superseded stream: the parent remounts this component
  // (via its key) when the analysed (plan, query) pair changes, and the tab strip
  // unmounts it when the user leaves the AI tab. Either way the response would land
  // in a dead component, so cancel it. Reading the ref inside a callback that only
  // runs after commit — never during render — is the documented safe access.
  const abortInFlight = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);
  useEffect(() => abortInFlight, [abortInFlight]);

  const analyzeWithAI = useCallback(async () => {
    if (!query && !plan) return;

    setIsLoading(true);
    setAiResponse("");
    setError(null);
    setHasRun(true);

    // Abort previous request if any
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/ai/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query || "Unknown query",
          explainPlan: plan,
          schemaContext: schemaContext || "",
          databaseType: databaseType || "postgres",
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "AI analysis failed");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        setAiResponse(accumulated);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "AI analysis failed");
    } finally {
      setIsLoading(false);
    }
  }, [query, plan, schemaContext, databaseType]);

  // Simple markdown renderer for the AI response
  const renderMarkdown = (text: string) => {
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockLang = "";
    let codeBlockContent = "";

    lines.forEach((line, idx) => {
      if (line.startsWith("```")) {
        if (inCodeBlock) {
          // End code block
          const content = codeBlockContent;
          const isSql = codeBlockLang === "sql";
          elements.push(
            <div key={`code-${idx}`} className="my-3 relative group/code">
              <pre
                className={cn(
                  "text-xs font-mono p-3 rounded-lg overflow-x-auto border",
                  isSql
                    ? "bg-blue-500/5 border-blue-500/10 text-blue-300"
                    : "bg-fill-subtle border-hairline text-fg-tertiary",
                )}
              >
                {content}
              </pre>
              {isSql && onLoadQuery && (
                <button
                  onClick={() => onLoadQuery(content)}
                  className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1"
                >
                  <Play strokeWidth={1.5} className="w-3 h-3" /> Try This
                </button>
              )}
            </div>,
          );
          codeBlockContent = "";
          inCodeBlock = false;
        } else {
          // Start code block
          inCodeBlock = true;
          codeBlockLang = line.slice(3).trim();
          codeBlockContent = "";
        }
        return;
      }

      if (inCodeBlock) {
        codeBlockContent += (codeBlockContent ? "\n" : "") + line;
        return;
      }

      // Headers
      if (line.startsWith("## ")) {
        elements.push(
          <h2 key={idx} className="text-xs font-medium text-fg mt-4 mb-2 flex items-center gap-2">
            {line.slice(3)}
          </h2>,
        );
      } else if (line.startsWith("### ")) {
        elements.push(
          <h3 key={idx} className="text-xs font-medium text-fg-secondary mt-3 mb-1">
            {line.slice(4)}
          </h3>,
        );
      } else if (line.startsWith("- ")) {
        elements.push(
          <div key={idx} className="flex items-start gap-2 text-xs text-fg-tertiary leading-relaxed ml-2 my-0.5">
            <span className="text-fg-subtle mt-1 shrink-0">•</span>
            <span>{renderInlineFormatting(line.slice(2))}</span>
          </div>,
        );
      } else if (/^\d+\.\s/.test(line)) {
        const num = line.match(/^(\d+)\./)?.[1];
        elements.push(
          <div key={idx} className="flex items-start gap-2 text-xs text-fg-tertiary leading-relaxed ml-2 my-0.5">
            <span className="text-blue-400 font-medium mt-0 shrink-0 w-4">{num}.</span>
            <span>{renderInlineFormatting(line.replace(/^\d+\.\s*/, ""))}</span>
          </div>,
        );
      } else if (line.trim() === "") {
        elements.push(<div key={idx} className="h-1" />);
      } else {
        elements.push(
          <p key={idx} className="text-xs text-fg-tertiary leading-relaxed my-0.5">
            {renderInlineFormatting(line)}
          </p>,
        );
      }
    });

    return elements;
  };

  const renderInlineFormatting = (text: string): React.ReactNode => {
    // Bold **text**
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={i} className="text-fg font-medium">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code key={i} className="text-blue-400 bg-blue-500/10 px-1 rounded text-xs font-mono">
            {part.slice(1, -1)}
          </code>
        );
      }
      return part;
    });
  };

  // Not run yet state
  if (!hasRun) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/10 flex items-center justify-center mb-4">
          <Sparkles strokeWidth={1.5} className="w-7 h-7 text-purple-400" />
        </div>
        <h3 className="text-xs font-medium text-fg mb-1">AI Query Analysis</h3>
        <p className="text-xs text-fg-muted max-w-[280px] leading-relaxed mb-4">
          Get a plain-language explanation of your query&apos;s execution plan with concrete optimization suggestions.
        </p>
        <button
          onClick={analyzeWithAI}
          disabled={!query}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all",
            query
              ? "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/20"
              : "bg-fill text-fg-subtle cursor-not-allowed",
          )}
        >
          <Sparkles strokeWidth={1.5} className="w-3 h-3" />
          Analyze with AI
        </button>
        {!query && <p className="text-xs text-fg-subtle mt-2">Run a query first to enable AI analysis.</p>}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Re-analyze button */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-hairline bg-surface">
        <div className="flex items-center gap-2">
          <Sparkles strokeWidth={1.5} className="w-3 h-3 text-purple-400" />
          <span className="text-xs font-medium text-purple-400">AI Analysis</span>
        </div>
        <button
          onClick={analyzeWithAI}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-fg-tertiary hover:text-fg-bright hover:bg-fill transition-all"
        >
          {isLoading ? (
            <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" />
          ) : (
            <Sparkles strokeWidth={1.5} className="w-3 h-3" />
          )}
          {isLoading ? "Analyzing..." : "Re-analyze"}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/10 text-red-400 text-xs mb-4">
            <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
            {error}
          </div>
        )}

        {aiResponse && <div className="space-y-0">{renderMarkdown(aiResponse)}</div>}

        {isLoading && !aiResponse && (
          <div className="flex items-center gap-3 text-fg-muted text-xs">
            <LoaderCircle strokeWidth={1.5} className="w-3.5 h-3.5 animate-spin text-purple-400" />
            <span>Analyzing execution plan...</span>
          </div>
        )}

        {isLoading && aiResponse && (
          <div className="flex items-center gap-2 mt-2 text-fg-subtle text-xs">
            <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" />
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

type ExplainTab = "insights" | "tree" | "raw" | "ai";

// First entry is the kind's default tab. No "insights" for tree plans —
// analyzePlan's heuristics key off postgres-only fields (Actual Rows, Total
// Cost, buffer stats) that sqlite-queryplan and friends never produce.
const TREE_TABS = ["tree", "raw", "ai"] as const;
const POSTGRES_TABS = ["insights", "ai", "tree", "raw"] as const;

export function VisualExplain({ plan, query, schemaContext, databaseType, onLoadQuery }: VisualExplainProps) {
  // Normalize once: array (legacy) / tagged input / null|undefined -> ExplainPlanInput | null.
  // Non-empty legacy arrays are wrapped as postgres-json so the rest of the component only
  // ever deals with the tagged model; this reproduces the old empty-state guards exactly.
  const input: ExplainPlanInput | null = useMemo(() => {
    if (!plan) return null;
    if (Array.isArray(plan)) return plan.length > 0 ? { kind: "postgres-json", plan } : null;
    if (typeof plan !== "object" || !("kind" in plan)) return null;
    // A tagged-but-empty postgres plan is as empty as a legacy [] — same empty state.
    if (plan.kind === "postgres-json" && plan.plan.length === 0) return null;
    return plan;
  }, [plan]);

  const postgresPlan = input !== null && input.kind === "postgres-json" ? input.plan : null;
  const kind = input === null ? null : input.kind;

  const [activeTab, setActiveTab] = useState<ExplainTab>(kind === "tree" ? "tree" : "insights");

  const analysis = useMemo(() => {
    if (!postgresPlan) return null;
    return analyzePlan(postgresPlan);
  }, [postgresPlan]);

  // The exact value handed to AIExplainTab. Hoisted so the remount trigger below and
  // the prop at the call site can never key on different objects.
  const aiPlan = input === null ? null : input.kind === "tree" ? input.raw : postgresPlan;

  // BottomPanel keeps a single VisualExplain mounted across query-tab/connection
  // switches, so the plan kind can change without a remount. Resync the active tab
  // during render ("Adjusting some state when a prop changes") rather than in an
  // Effect: a stale tab that is unavailable for the new kind ("insights" on a tree
  // plan) would otherwise leave the content panel blank for a frame. The guard makes
  // this self-terminating — React retries the render, and syncedKind then matches.
  const [syncedKind, setSyncedKind] = useState(kind);
  if (kind !== null && kind !== syncedKind) {
    setSyncedKind(kind);
    const available: readonly ExplainTab[] = kind === "tree" ? TREE_TABS : POSTGRES_TABS;
    if (!available.includes(activeTab)) {
      setActiveTab(available[0]);
    }
  }

  // A mounted panel can switch plans without remounting, and AIExplainTab holds a whole
  // analysis for one (plan, query) pair. Bump a generation counter when either changes
  // and use it as the child's key, so React resets that state on the remount instead of
  // the child clearing itself one commit later — the old response never paints under the
  // new plan. A counter is needed because a key must be a primitive and aiPlan is not.
  const [analysed, setAnalysed] = useState<{ plan: unknown; query?: string; generation: number }>({
    plan: aiPlan,
    query,
    generation: 0,
  });
  if (analysed.plan !== aiPlan || analysed.query !== query) {
    setAnalysed((previous) => ({ plan: aiPlan, query, generation: previous.generation + 1 }));
  }

  // Empty state
  if (input === null) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-fg-muted bg-sunken p-12 text-center">
        <div className="w-12 h-12 rounded-xl bg-fill flex items-center justify-center mb-4">
          <Activity strokeWidth={1.5} className="w-6 h-6 text-fg-subtle" />
        </div>
        <h3 className="text-xs font-medium text-fg-secondary mb-1">No execution plan</h3>
        <p className="text-xs text-fg-subtle max-w-[240px]">
          Run a SELECT query to see its execution plan and performance insights.
        </p>
      </div>
    );
  }

  const rootPlan = postgresPlan?.[0]?.Plan;
  const tabs = input.kind === "tree" ? TREE_TABS : POSTGRES_TABS;

  return (
    <div className="h-full flex flex-col bg-sunken">
      {/* Header Stats */}
      <div className="px-4 py-3 border-b border-hairline bg-surface">
        <div className="flex items-center justify-between">
          {/* Quick stats */}
          {input.kind === "tree" ? (
            <div className="flex items-center gap-2">
              <Layers strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
              <span className="text-xs font-medium text-fg">{countTreeNodes(input.root)}</span>
              <span className="text-xs text-fg-subtle">nodes</span>
            </div>
          ) : (
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Clock strokeWidth={1.5} className="w-3 h-3 text-blue-400" />
                <span className="text-xs font-medium text-fg">{formatTime(analysis?.executionTime || 0)}</span>
                <span className="text-xs text-fg-subtle">execution</span>
              </div>
              <div className="flex items-center gap-2">
                <TrendingUp className="w-3 h-3 text-fg-muted" />
                <span className="text-xs font-medium text-fg-tertiary">{formatNumber(analysis?.totalRows || 0)}</span>
                <span className="text-xs text-fg-subtle">rows</span>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                <span className="text-xs font-medium text-fg-tertiary">{formatNumber(analysis?.totalCost || 0)}</span>
                <span className="text-xs text-fg-subtle">cost</span>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-fill rounded-lg p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-all",
                  activeTab === tab
                    ? tab === "ai"
                      ? "bg-purple-500/20 text-purple-300"
                      : "bg-fill-strong text-fg"
                    : "text-fg-muted hover:text-fg-secondary",
                )}
              >
                {tab === "insights" && <Zap strokeWidth={1.5} className="w-3 h-3 inline mr-1" />}
                {tab === "ai" && <Sparkles strokeWidth={1.5} className="w-3 h-3 inline mr-1" />}
                {tab === "tree" && <Layers strokeWidth={1.5} className="w-3 h-3 inline mr-1" />}
                {tab === "raw" && <FileBraces strokeWidth={1.5} className="w-3 h-3 inline mr-1" />}
                {tab === "ai" ? "AI Explain" : tab}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "ai" && (
          <AIExplainTab
            key={analysed.generation}
            plan={aiPlan}
            query={query}
            schemaContext={schemaContext}
            databaseType={databaseType}
            onLoadQuery={onLoadQuery}
          />
        )}

        {activeTab === "insights" && (
          <div className="p-4 space-y-4">
            {/* Warnings */}
            {analysis && analysis.warnings.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-fg-muted mb-2">Performance Issues</h3>
                {analysis.warnings.map((warning, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-lg border",
                      warning.type === "critical"
                        ? "bg-red-500/5 border-red-500/10"
                        : warning.type === "warning"
                          ? "bg-amber-500/5 border-amber-500/10"
                          : "bg-blue-500/5 border-blue-500/10",
                    )}
                  >
                    <div
                      className={cn(
                        "p-1 rounded",
                        warning.type === "critical"
                          ? "bg-red-500/10"
                          : warning.type === "warning"
                            ? "bg-amber-500/10"
                            : "bg-blue-500/10",
                      )}
                    >
                      {warning.type === "critical" ? (
                        <TriangleAlert strokeWidth={1.5} className="w-3 h-3 text-red-400" />
                      ) : warning.type === "warning" ? (
                        <TriangleAlert strokeWidth={1.5} className="w-3 h-3 text-amber-400" />
                      ) : (
                        <Info strokeWidth={1.5} className="w-3 h-3 text-blue-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4
                        className={cn(
                          "text-xs font-medium",
                          warning.type === "critical"
                            ? "text-red-300"
                            : warning.type === "warning"
                              ? "text-amber-300"
                              : "text-blue-300",
                        )}
                      >
                        {warning.title}
                      </h4>
                      <p className="text-xs text-fg-muted mt-0.5 leading-relaxed">{warning.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* No warnings */}
            {analysis && analysis.warnings.length === 0 && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                <div className="p-1 rounded bg-emerald-500/10">
                  <CircleCheck strokeWidth={1.5} className="w-3 h-3 text-emerald-400" />
                </div>
                <div>
                  <h4 className="text-xs font-medium text-emerald-300">Query looks good</h4>
                  <p className="text-xs text-fg-muted">No obvious performance issues detected.</p>
                </div>
              </div>
            )}

            {/* Metrics Grid */}
            <div className="grid grid-cols-3 gap-2">
              {analysis?.insights.map((insight, idx) => (
                <div key={idx} className="p-3 rounded-lg bg-fill-subtle border border-hairline">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={insight.status} />
                    <span className="text-[0.625rem] text-fg-muted font-medium">{insight.label}</span>
                  </div>
                  <span className="text-xs font-medium text-fg">{insight.value}</span>
                </div>
              ))}
            </div>

            {/* Plan tree preview */}
            <div>
              <h3 className="text-xs font-medium text-fg-muted mb-2">Execution Plan</h3>
              <div className="rounded-lg border border-hairline bg-fill-subtle p-2">
                {rootPlan && analysis && <PlanNode node={rootPlan} maxTime={analysis.executionTime || 1} />}
              </div>
            </div>
          </div>
        )}

        {activeTab === "tree" && (
          <div className="p-4">
            <div className="rounded-lg border border-hairline bg-fill-subtle p-2">
              {input.kind === "tree" && <TreeNodeView node={input.root} />}
              {input.kind !== "tree" && rootPlan && analysis && (
                <PlanNode node={rootPlan} maxTime={analysis.executionTime || 1} />
              )}
            </div>
          </div>
        )}

        {activeTab === "raw" && (
          <div className="p-4">
            <pre className="text-xs font-mono text-fg-tertiary bg-fill-subtle rounded-lg p-4 overflow-auto border border-hairline">
              {JSON.stringify(input.kind === "tree" ? input.raw : postgresPlan, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
