"use client";

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Columns3, GripVertical, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { QueryResult } from '@/lib/types';

interface PivotTableProps {
  result: QueryResult | null;
  onLoadQuery?: (query: string) => void;
}

type AggFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

const AGG_LABELS: Record<AggFunction, string> = {
  count: 'COUNT',
  sum: 'SUM',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
};

export function aggregate(values: unknown[], fn: AggFunction): string {
  const nums = values.map(v => Number(v)).filter(n => !isNaN(n));

  switch (fn) {
    case 'count': return String(values.length);
    case 'sum': return nums.length ? nums.reduce((a, b) => a + b, 0).toFixed(2) : '0';
    case 'avg': return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : '0';
    case 'min': return nums.length ? String(Math.min(...nums)) : '-';
    case 'max': return nums.length ? String(Math.max(...nums)) : '-';
  }
}

export function PivotTable({ result, onLoadQuery }: PivotTableProps) {
  const [rowField, setRowField] = useState<string | null>(null);
  const [colField, setColField] = useState<string | null>(null);
  const [valueField, setValueField] = useState<string | null>(null);
  const [aggFunction, setAggFunction] = useState<AggFunction>('count');
  const fields = result?.fields || [];
  const rows = useMemo(() => result?.rows || [], [result?.rows]);

  // Auto-detect fields on first render
  useEffect(() => {
    if (fields.length >= 2 && !rowField) {
      const strCol = fields.find(f => {
        const sample = rows[0]?.[f];
        return typeof sample === 'string';
      });
      if (strCol) setRowField(strCol);

      const numCol = fields.find(f => {
        const sample = rows[0]?.[f];
        return typeof sample === 'number';
      });
      if (numCol) setValueField(numCol);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.length]);

  // Compute pivot data
  const pivotData = useMemo(() => {
    if (!rowField || !rows.length) return null;

    // Group rows
    const groups = new Map<string, Map<string, unknown[]>>();
    const colValues = new Set<string>();

    for (const row of rows) {
      const rowKey = String(row[rowField] ?? 'NULL');
      const colKey = colField ? String(row[colField] ?? 'NULL') : '__all__';
      const value = valueField ? row[valueField] : 1;

      if (colField) colValues.add(colKey);

      if (!groups.has(rowKey)) groups.set(rowKey, new Map());
      const colMap = groups.get(rowKey)!;
      if (!colMap.has(colKey)) colMap.set(colKey, []);
      colMap.get(colKey)!.push(value);
    }

    const colKeys = colField ? Array.from(colValues).sort() : ['__all__'];

    // Build pivot rows
    const pivotRows: { rowKey: string; values: Map<string, string> }[] = [];
    for (const [rowKey, colMap] of groups) {
      const values = new Map<string, string>();
      for (const ck of colKeys) {
        const vals = colMap.get(ck) || [];
        values.set(ck, aggregate(vals, aggFunction));
      }
      pivotRows.push({ rowKey, values });
    }

    // Sort by row key
    pivotRows.sort((a, b) => a.rowKey.localeCompare(b.rowKey));

    return { colKeys, pivotRows };
  }, [rows, rowField, colField, valueField, aggFunction]);

  // Generate SQL
  const generateSQL = useCallback(() => {
    if (!rowField) return '';
    const select: string[] = [`"${rowField}"`];
    const groupBy: string[] = [`"${rowField}"`];

    if (colField) {
      // Use CASE WHEN for pivot columns
      const colKeys = pivotData?.colKeys || [];
      for (const ck of colKeys) {
        if (ck === '__all__') continue;
        const valExpr = valueField ? `"${valueField}"` : '1';
        select.push(
          `${AGG_LABELS[aggFunction]}(CASE WHEN "${colField}" = '${ck.replace(/'/g, "''")}' THEN ${valExpr} END) AS "${ck}"`
        );
      }
    } else {
      const valExpr = valueField ? `"${valueField}"` : '*';
      select.push(`${AGG_LABELS[aggFunction]}(${valExpr}) AS "${aggFunction}_value"`);
    }

    return `SELECT\n  ${select.join(',\n  ')}\nFROM your_table\nGROUP BY ${groupBy.join(', ')}\nORDER BY ${groupBy.join(', ')};`;
  }, [rowField, colField, valueField, aggFunction, pivotData]);

  if (!result || rows.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center opacity-30">
        <Columns3 className="w-8 h-8 mb-3" />
        <p className="text-sm font-medium">Pivot Table</p>
        <p className="text-xs text-zinc-500 mt-1">Execute a query to create pivot tables</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Config Bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5 bg-[#0a0a0a] flex-wrap">
        {/* Row Field */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 font-bold uppercase">Rows:</span>
          <select
            value={rowField || ''}
            onChange={e => setRowField(e.target.value || null)}
            className="bg-[#111] border border-white/10 rounded px-2 py-1 text-body text-zinc-300 outline-none"
          >
            <option value="">Select...</option>
            {fields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Column Field */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 font-bold uppercase">Columns:</span>
          <select
            value={colField || ''}
            onChange={e => setColField(e.target.value || null)}
            className="bg-[#111] border border-white/10 rounded px-2 py-1 text-body text-zinc-300 outline-none"
          >
            <option value="">None</option>
            {fields.filter(f => f !== rowField).map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Value Field */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 font-bold uppercase">Values:</span>
          <select
            value={valueField || ''}
            onChange={e => setValueField(e.target.value || null)}
            className="bg-[#111] border border-white/10 rounded px-2 py-1 text-body text-zinc-300 outline-none"
          >
            <option value="">Count</option>
            {fields.filter(f => f !== rowField && f !== colField).map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Aggregation */}
        <div className="flex items-center gap-1">
          {(Object.keys(AGG_LABELS) as AggFunction[]).map(fn => (
            <button
              key={fn}
              onClick={() => setAggFunction(fn)}
              className={cn(
                "px-1.5 py-0.5 rounded text-xs font-bold transition-colors",
                aggFunction === fn
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/20"
                  : "text-zinc-600 hover:text-zinc-400"
              )}
            >
              {AGG_LABELS[fn]}
            </button>
          ))}
        </div>

        {/* Generate SQL Button */}
        {onLoadQuery && rowField && (
          <button
            onClick={() => {
              const sql = generateSQL();
              if (sql) onLoadQuery(sql);
            }}
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-xs font-bold text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
          >
            <ArrowRight className="w-3 h-3" /> Generate SQL
          </button>
        )}
      </div>

      {/* Pivot Result */}
      <div className="flex-1 overflow-auto">
        {pivotData && pivotData.pivotRows.length > 0 ? (
          <table className="w-full text-body font-mono">
            <thead className="sticky top-0 z-10 bg-[#0d0d0d]">
              <tr>
                <th className="text-left px-3 py-2 text-zinc-500 border-b border-r border-white/5 font-bold uppercase tracking-wider">
                  {rowField}
                </th>
                {pivotData.colKeys.map(ck => (
                  <th key={ck} className="text-right px-3 py-2 text-zinc-500 border-b border-r border-white/5 font-bold">
                    {ck === '__all__' ? `${AGG_LABELS[aggFunction]}(${valueField || '*'})` : ck}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivotData.pivotRows.map((row, i) => (
                <tr key={i} className="hover:bg-blue-500/[0.03] border-b border-white/5">
                  <td className="px-3 py-1.5 text-zinc-300 border-r border-white/5 font-medium">
                    {row.rowKey}
                  </td>
                  {pivotData.colKeys.map(ck => (
                    <td key={ck} className="px-3 py-1.5 text-right text-amber-500/90 border-r border-white/5">
                      {row.values.get(ck) || '0'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center h-full opacity-30">
            <GripVertical className="w-6 h-6 mb-2" />
            <p className="text-xs">Select row and value fields to build pivot</p>
          </div>
        )}
      </div>

      {/* Status */}
      {pivotData && (
        <div className="px-4 py-1.5 border-t border-white/5 bg-[#0a0a0a] text-xs text-zinc-500 font-mono">
          {pivotData.pivotRows.length} groups • {pivotData.colKeys.length} columns • {AGG_LABELS[aggFunction]} aggregation
        </div>
      )}
    </div>
  );
}
