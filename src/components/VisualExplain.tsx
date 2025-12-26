"use client";

import React from 'react';
import { 
  Zap, 
  Search, 
  ArrowDown, 
  Layers, 
  Database,
  Info,
  Clock,
  LayoutGrid
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ExplainPlanNode {
  'Node Type'?: string;
  'Total Cost'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Relation Name'?: string;
  'Alias'?: string;
  'Filter'?: string;
  'Index Name'?: string;
  Plans?: ExplainPlanNode[];
  [key: string]: unknown;
}

interface VisualExplainProps {
  plan: Array<{ Plan: ExplainPlanNode }> | ExplainPlanNode | null | undefined;
}

const NodeIcon = ({ type }: { type: string }) => {
  if (type.includes('Scan')) return <Search className="w-4 h-4 text-emerald-400" />;
  if (type.includes('Join')) return <Layers className="w-4 h-4 text-blue-400" />;
  if (type.includes('Sort')) return <ArrowDown className="w-4 h-4 text-amber-400" />;
  if (type.includes('Limit')) return <LayoutGrid className="w-4 h-4 text-purple-400" />;
  if (type.includes('Aggregate')) return <Zap className="w-4 h-4 text-pink-400" />;
  return <Database className="w-4 h-4 text-zinc-400" />;
};

const ExplainNode = ({ node, depth = 0 }: { node: ExplainPlanNode, depth?: number }) => {
  const nodeType = node['Node Type'] || 'Unknown';
  const totalCost = node['Total Cost'];
  const actualRows = node['Actual Rows'];
  const actualTime = node['Actual Total Time'];
  const children = node['Plans'] || [];

  return (
    <div className="flex flex-col gap-3">
      <div 
        className={cn(
          "relative group p-4 rounded-xl border border-white/5 bg-[#0d0d0d] hover:bg-[#111] transition-all duration-300 shadow-xl",
          depth === 0 ? "border-blue-500/20 ring-1 ring-blue-500/10" : ""
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5 border border-white/5">
              <NodeIcon type={nodeType} />
            </div>
            <div>
              <h4 className="text-xs font-bold text-zinc-100 uppercase tracking-wider">{nodeType}</h4>
              <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                {node['Relation Name'] && <span className="text-emerald-500/80 mr-2">ON {node['Relation Name']}</span>}
                {node['Alias'] && <span className="text-zinc-600 italic">AS {node['Alias']}</span>}
              </p>
            </div>
          </div>
          
          <div className="flex flex-col items-end gap-1">
             <div className="flex items-center gap-2 px-2 py-0.5 rounded bg-zinc-900 border border-white/5">
                <Clock className="w-2.5 h-2.5 text-blue-400" />
                <span className="text-[10px] font-mono text-blue-400">{actualTime || 'N/A'}ms</span>
             </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
            <span className="block text-[8px] text-zinc-600 uppercase font-black tracking-widest">Rows</span>
            <span className="text-[10px] font-mono text-zinc-300">{actualRows || node['Plan Rows'] || 0}</span>
          </div>
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
            <span className="block text-[8px] text-zinc-600 uppercase font-black tracking-widest">Cost</span>
            <span className="text-[10px] font-mono text-zinc-300">{totalCost || 0}</span>
          </div>
          <div className="p-2 rounded bg-white/[0.02] border border-white/5">
             <span className="block text-[8px] text-zinc-600 uppercase font-black tracking-widest">Width</span>
             <span className="text-[10px] font-mono text-zinc-300">{node['Plan Width'] || 0}</span>
          </div>
        </div>

        {node['Filter'] && (
           <div className="mt-3 p-2 rounded bg-red-500/5 border border-red-500/10 flex items-start gap-2">
              <Info className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <span className="block text-[8px] text-red-400/80 uppercase font-black tracking-widest mb-0.5">Filter</span>
                <p className="text-[9px] font-mono text-red-300 break-all">{node['Filter']}</p>
              </div>
           </div>
        )}

        {node['Index Name'] && (
           <div className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/5 border border-emerald-500/10 w-fit">
              <Zap className="w-2.5 h-2.5 text-emerald-500" />
              <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-widest">Index: {node['Index Name']}</span>
           </div>
        )}
      </div>

      {children.length > 0 && (
        <div className="flex flex-col gap-6 ml-6 relative">
          <div className="absolute left-[-1.5rem] top-0 bottom-4 w-px bg-gradient-to-b from-white/10 to-transparent" />
          {children.map((child, idx: number) => (
            <div key={idx} className="relative">
              <div className="absolute left-[-1.5rem] top-8 w-6 h-px bg-white/10" />
              <ExplainNode node={child} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export function VisualExplain({ plan }: VisualExplainProps) {
  if (!plan || !Array.isArray(plan) || plan.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-zinc-500 bg-[#080808] p-12 text-center">
        <div className="p-4 rounded-full bg-white/5 mb-4">
           <Zap className="w-8 h-8 opacity-20" />
        </div>
        <h3 className="text-sm font-bold text-zinc-200 mb-2">No Plan Available</h3>
        <p className="text-xs max-w-xs leading-relaxed opacity-40">
          This connection type or query doesn&apos;t support visual explanation, or the plan data is missing.
        </p>
      </div>
    );
  }

  let rootPlan: ExplainPlanNode;
  if (Array.isArray(plan) && plan[0] && 'Plan' in plan[0]) {
    rootPlan = (plan[0] as { Plan: ExplainPlanNode }).Plan;
  } else if (Array.isArray(plan)) {
    // Fallback: if plan is array but doesn't have Plan property, use first element
    rootPlan = plan[0] as unknown as ExplainPlanNode;
  } else {
    rootPlan = plan as unknown as ExplainPlanNode;
  }

  return (
    <div className="h-full w-full bg-[#080808] overflow-auto custom-scrollbar p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-10 flex items-center justify-between">
           <div>
              <h2 className="text-xl font-black text-white uppercase tracking-tighter">Query execution plan</h2>
              <p className="text-xs text-zinc-500 mt-1 uppercase tracking-widest font-bold">Visual analyzer for Expert Engineers</p>
           </div>
           <div className="flex items-center gap-4">
              <div className="text-right">
                 <span className="block text-[9px] text-zinc-600 uppercase font-black tracking-widest mb-0.5">Total Time</span>
                 <span className="text-lg font-mono font-bold text-blue-400">
                   {Array.isArray(plan) && plan[0] && 'Execution Time' in plan[0] 
                     ? (plan[0] as { 'Execution Time': number })['Execution Time'] 
                     : rootPlan['Actual Total Time'] || 0} ms
                 </span>
              </div>
           </div>
        </div>

        <ExplainNode node={rootPlan} />
      </div>
    </div>
  );
}
