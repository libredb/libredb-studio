"use client";

import React, { useState, useMemo, useRef, useCallback } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  ZAxis,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import { QueryResult } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  AreaChart as AreaChartIcon,
  Download,
  Settings2,
  TrendingUp,
  Hash,
  Calendar,
  Type,
  AlertCircle,
  Circle,
  BarChart2,
  Save,
  FolderOpen,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { storage } from '@/lib/storage';

// Chart colors matching CSS variables
const CHART_COLORS = [
  'hsl(217, 91%, 60%)',  // Blue
  'hsl(142, 71%, 45%)',  // Green
  'hsl(38, 92%, 50%)',   // Amber
  'hsl(270, 91%, 65%)',  // Purple
  'hsl(330, 81%, 60%)',  // Pink
  'hsl(199, 89%, 48%)',  // Cyan
  'hsl(24, 95%, 53%)',   // Orange
  'hsl(162, 63%, 41%)',  // Teal
];

type ChartType = 'bar' | 'line' | 'pie' | 'area' | 'scatter' | 'histogram' | 'stacked-bar' | 'stacked-area';

export type AggregationType = 'none' | 'sum' | 'avg' | 'count' | 'min' | 'max';
export type DateGrouping = 'hour' | 'day' | 'week' | 'month' | 'year';

export interface FieldAnalysis {
  name: string;
  type: 'numeric' | 'categorical' | 'date' | 'unknown';
  uniqueValues: number;
  hasNulls: boolean;
  sample: unknown;
}

export interface DataAnalysis {
  fields: FieldAnalysis[];
  numericFields: string[];
  categoricalFields: string[];
  dateFields: string[];
  suggestedChartType: ChartType;
  isVisualizable: boolean;
  reason?: string;
}

interface DataChartsProps {
  result: QueryResult | null;
}

export function analyzeField(name: string, values: unknown[]): FieldAnalysis {
  const nonNullValues = values.filter(v => v !== null && v !== undefined);
  const uniqueValues = new Set(nonNullValues).size;
  const sample = nonNullValues[0];

  // Check if numeric
  const numericCount = nonNullValues.filter(v => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)))).length;
  const isNumeric = numericCount > nonNullValues.length * 0.8;

  // Check if date
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}/,  // ISO date
    /^\d{2}\/\d{2}\/\d{4}/, // US date
    /^\d{2}\.\d{2}\.\d{4}/, // EU date
  ];
  const isDate = nonNullValues.some(v =>
    (typeof v === 'string' && datePatterns.some(p => p.test(v))) ||
    v instanceof Date
  );

  let type: FieldAnalysis['type'] = 'unknown';
  if (isDate) type = 'date';
  else if (isNumeric) type = 'numeric';
  else if (uniqueValues <= 50) type = 'categorical';

  return {
    name,
    type,
    uniqueValues,
    hasNulls: nonNullValues.length < values.length,
    sample,
  };
}

export function analyzeData(result: QueryResult | null): DataAnalysis {
  if (!result || !result.rows || result.rows.length === 0) {
    return {
      fields: [],
      numericFields: [],
      categoricalFields: [],
      dateFields: [],
      suggestedChartType: 'bar',
      isVisualizable: false,
      reason: 'No data to visualize',
    };
  }

  if (result.rows.length < 2) {
    return {
      fields: [],
      numericFields: [],
      categoricalFields: [],
      dateFields: [],
      suggestedChartType: 'bar',
      isVisualizable: false,
      reason: 'Need at least 2 rows for visualization',
    };
  }

  const fieldNames = result.fields || Object.keys(result.rows[0]);
  const fields = fieldNames.map(name =>
    analyzeField(name, result.rows.map(row => row[name]))
  );

  const numericFields = fields.filter(f => f.type === 'numeric').map(f => f.name);
  const categoricalFields = fields.filter(f => f.type === 'categorical').map(f => f.name);
  const dateFields = fields.filter(f => f.type === 'date').map(f => f.name);

  if (numericFields.length === 0) {
    return {
      fields,
      numericFields,
      categoricalFields,
      dateFields,
      suggestedChartType: 'bar',
      isVisualizable: false,
      reason: 'No numeric fields found for Y-axis',
    };
  }

  // Suggest chart type based on data
  let suggestedChartType: ChartType = 'bar';

  if (dateFields.length > 0) {
    suggestedChartType = 'line'; // Time series → line chart
  } else if (numericFields.length >= 2 && categoricalFields.length === 0) {
    suggestedChartType = 'scatter'; // 2+ numeric, no categorical → scatter
  } else if (categoricalFields.length > 0 && result.rows.length <= 10) {
    suggestedChartType = 'pie'; // Few categories → pie chart
  } else if (categoricalFields.length > 0) {
    suggestedChartType = 'bar'; // Many categories → bar chart
  }

  return {
    fields,
    numericFields,
    categoricalFields,
    dateFields,
    suggestedChartType,
    isVisualizable: true,
  };
}

export function formatNumber(value: number): string {
  if (Math.abs(value) >= 1000000) {
    return (value / 1000000).toFixed(1) + 'M';
  }
  if (Math.abs(value) >= 1000) {
    return (value / 1000).toFixed(1) + 'K';
  }
  return value.toLocaleString();
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  label?: string;
}

const CustomTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload || !payload.length) return null;

  return (
    <div className="bg-[#111] border border-white/10 rounded-lg px-3 py-2 shadow-xl">
      <p className="text-zinc-400 text-xs mb-1">{label}</p>
      {payload.map((entry, index) => (
        <p key={index} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: <span className="font-mono font-medium">{formatNumber(entry.value)}</span>
        </p>
      ))}
    </div>
  );
};

// Histogram bin calculation
export function computeHistogramBins(values: number[], buckets: number): { range: string; count: number; min: number; max: number }[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ range: `${min}`, count: values.length, min, max }];
  const binWidth = (max - min) / buckets;
  const bins = Array.from({ length: buckets }, (_, i) => ({
    range: `${(min + i * binWidth).toFixed(1)}-${(min + (i + 1) * binWidth).toFixed(1)}`,
    count: 0,
    min: min + i * binWidth,
    max: min + (i + 1) * binWidth,
  }));
  values.forEach(v => {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= buckets) idx = buckets - 1;
    bins[idx].count++;
  });
  return bins;
}

// Data aggregation helper
export function aggregateData(
  rows: Record<string, unknown>[],
  groupByField: string,
  metrics: { field: string; aggregation: AggregationType }[],
  dateGrouping?: DateGrouping
): Record<string, unknown>[] {
  if (metrics.every(m => m.aggregation === 'none')) return rows;

  const groups = new Map<string, Record<string, unknown>[]>();
  rows.forEach(row => {
    let key = String(row[groupByField] ?? '');
    if (dateGrouping && key) {
      key = groupByDate(key, dateGrouping);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  });

  return Array.from(groups.entries()).map(([key, groupRows]) => {
    const result: Record<string, unknown> = { [groupByField]: key };
    metrics.forEach(({ field, aggregation }) => {
      const values = groupRows.map(r => Number(r[field]) || 0);
      switch (aggregation) {
        case 'sum': result[field] = values.reduce((a, b) => a + b, 0); break;
        case 'avg': result[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; break;
        case 'count': result[field] = values.length; break;
        case 'min': result[field] = Math.min(...values); break;
        case 'max': result[field] = Math.max(...values); break;
        default: result[field] = values[0];
      }
    });
    return result;
  });
}

export function groupByDate(dateStr: string, grouping: DateGrouping): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  switch (grouping) {
    case 'hour': return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:00`;
    case 'day': return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    case 'week': { const d = new Date(date); d.setDate(d.getDate() - d.getDay()); return `W${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
    case 'month': return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
    case 'year': return `${date.getFullYear()}`;
    default: return dateStr;
  }
}

export function DataCharts({ result }: DataChartsProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const analysis = useMemo(() => analyzeData(result), [result]);

  const [chartType, setChartType] = useState<ChartType>(analysis.suggestedChartType);
  const [xAxis, setXAxis] = useState<string>('');
  const [yAxis, setYAxis] = useState<string[]>([]);
  const [scatterY, setScatterY] = useState<string>('');
  const [histogramBuckets, setHistogramBuckets] = useState(10);
  const [aggregation, setAggregation] = useState<AggregationType>('none');
  const [dateGrouping, setDateGrouping] = useState<DateGrouping | ''>('');

  // Saved charts state
  const [savedCharts, setSavedCharts] = useState<{ id: string; name: string; chartType: ChartType; xAxis: string; yAxis: string[]; aggregation: AggregationType; dateGrouping: string }[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Load saved charts from storage
  React.useEffect(() => {
    const charts = storage.getSavedCharts();
    if (charts.length > 0) {
      setSavedCharts(charts.map(c => ({
        id: c.id,
        name: c.name,
        chartType: c.chartType as ChartType,
        xAxis: c.xAxis,
        yAxis: c.yAxis,
        aggregation: (c.aggregation || 'none') as AggregationType,
        dateGrouping: c.dateGrouping || '',
      })));
    }
  }, []);

  // Initialize axis selections when analysis changes
  React.useEffect(() => {
    if (analysis.isVisualizable) {
      setChartType(analysis.suggestedChartType);

      const defaultX = analysis.categoricalFields[0] || analysis.dateFields[0] || analysis.fields[0]?.name || '';
      setXAxis(defaultX);

      if (analysis.numericFields.length > 0) {
        setYAxis([analysis.numericFields[0]]);
      }
      if (analysis.numericFields.length >= 2) {
        setScatterY(analysis.numericFields[1]);
      }
    }
  }, [analysis]);

  const chartData = useMemo(() => {
    if (!result?.rows) return [];

    // Histogram: special data preparation
    if (chartType === 'histogram' && yAxis.length > 0) {
      const values = result.rows.map(r => Number(r[yAxis[0]]) || 0).filter(v => !isNaN(v));
      return computeHistogramBins(values, histogramBuckets);
    }

    // Scatter: needs both axes as numeric
    if (chartType === 'scatter') {
      if (!xAxis || !scatterY) return [];
      return result.rows.map(row => ({
        [xAxis]: typeof row[xAxis] === 'number' ? row[xAxis] : Number(row[xAxis]) || 0,
        [scatterY]: typeof row[scatterY] === 'number' ? row[scatterY] : Number(row[scatterY]) || 0,
      }));
    }

    if (!xAxis) return [];

    const baseData = result.rows.map(row => {
      const dataPoint: Record<string, unknown> = { [xAxis]: row[xAxis] };
      yAxis.forEach(field => {
        const value = row[field];
        dataPoint[field] = typeof value === 'number' ? value : Number(value) || 0;
      });
      return dataPoint;
    });

    // Apply aggregation if set
    if (aggregation !== 'none' && yAxis.length > 0) {
      return aggregateData(
        baseData,
        xAxis,
        yAxis.map(f => ({ field: f, aggregation })),
        dateGrouping || undefined
      );
    }

    // Apply date grouping even without aggregation
    if (dateGrouping) {
      return aggregateData(
        baseData,
        xAxis,
        yAxis.map(f => ({ field: f, aggregation: 'sum' })),
        dateGrouping
      );
    }

    return baseData;
  }, [result, xAxis, yAxis, chartType, scatterY, histogramBuckets, aggregation, dateGrouping]);

  // Save chart config
  const handleSaveChart = useCallback(() => {
    if (!saveName.trim()) return;
    const newChart = {
      id: Date.now().toString(),
      name: saveName.trim(),
      chartType,
      xAxis,
      yAxis: [...yAxis],
      aggregation,
      dateGrouping: dateGrouping || '',
    };
    const updated = [...savedCharts, newChart];
    setSavedCharts(updated);
    storage.saveChart({
      id: newChart.id,
      name: newChart.name,
      chartType: newChart.chartType,
      xAxis: newChart.xAxis,
      yAxis: newChart.yAxis,
      aggregation: newChart.aggregation,
      dateGrouping: (newChart.dateGrouping || undefined) as DateGrouping | undefined,
      createdAt: new Date(),
    });
    setShowSaveDialog(false);
    setSaveName('');
  }, [saveName, chartType, xAxis, yAxis, aggregation, dateGrouping, savedCharts]);

  // Load saved chart config
  const loadSavedChart = useCallback((chart: typeof savedCharts[0]) => {
    setChartType(chart.chartType);
    setXAxis(chart.xAxis);
    setYAxis(chart.yAxis);
    setAggregation(chart.aggregation);
    setDateGrouping((chart.dateGrouping || '') as DateGrouping | '');
  }, []);

  // Delete saved chart
  const deleteSavedChart = useCallback((id: string) => {
    const updated = savedCharts.filter(c => c.id !== id);
    setSavedCharts(updated);
    storage.deleteChart(id);
  }, [savedCharts]);

  const exportChart = useCallback(async (format: 'png' | 'svg') => {
    if (!chartRef.current) return;

    if (format === 'png') {
      try {
        // Dynamic import for html2canvas
        const html2canvasModule = await import('html2canvas');
        const html2canvas = html2canvasModule.default as (element: HTMLElement, options?: { backgroundColor?: string; scale?: number }) => Promise<HTMLCanvasElement>;
        const canvas = await html2canvas(chartRef.current, {
          backgroundColor: '#080808',
          scale: 2,
        });
        const link = document.createElement('a');
        link.download = `chart_${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (error) {
        console.error('Failed to export PNG:', error);
      }
    } else {
      // SVG export - find the SVG element
      const svgElement = chartRef.current.querySelector('svg');
      if (svgElement) {
        const svgData = new XMLSerializer().serializeToString(svgElement);
        const blob = new Blob([svgData], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `chart_${Date.now()}.svg`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      }
    }
  }, []);

  const toggleYAxis = (field: string) => {
    setYAxis(prev => {
      if (prev.includes(field)) {
        return prev.filter(f => f !== field);
      }
      return [...prev, field];
    });
  };

  // Empty state
  if (!analysis.isVisualizable) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#080808] text-zinc-500">
        <TrendingUp className="w-12 h-12 mb-4 opacity-30" />
        <p className="text-xs font-medium mb-1">Cannot Visualize Data</p>
        <p className="text-xs text-zinc-600">{analysis.reason}</p>
      </div>
    );
  }

  const chartTypes: { type: ChartType; icon: React.ReactNode; label: string }[] = [
    { type: 'bar', icon: <BarChart3 className="w-4 h-4" />, label: 'Bar' },
    { type: 'line', icon: <LineChartIcon className="w-4 h-4" />, label: 'Line' },
    { type: 'pie', icon: <PieChartIcon className="w-4 h-4" />, label: 'Pie' },
    { type: 'area', icon: <AreaChartIcon className="w-4 h-4" />, label: 'Area' },
    { type: 'scatter', icon: <Circle className="w-4 h-4" />, label: 'Scatter' },
    { type: 'histogram', icon: <BarChart2 className="w-4 h-4" />, label: 'Histogram' },
    { type: 'stacked-bar', icon: <BarChart3 className="w-4 h-4" />, label: 'Stacked' },
    { type: 'stacked-area', icon: <AreaChartIcon className="w-4 h-4" />, label: 'Stack Area' },
  ];

  const getFieldIcon = (type: FieldAnalysis['type']) => {
    switch (type) {
      case 'numeric': return <Hash className="w-3 h-3" />;
      case 'date': return <Calendar className="w-3 h-3" />;
      case 'categorical': return <Type className="w-3 h-3" />;
      default: return <AlertCircle className="w-3 h-3" />;
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#080808]">
      {/* Config Bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-[#0a0a0a] flex-wrap">
        {/* Chart Type Selector */}
        <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
          {chartTypes.map(({ type, icon, label }) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
                chartType === type
                  ? "bg-blue-600 text-white"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
              )}
              title={label}
            >
              {icon}
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-white/10 hidden sm:block" />

        {/* X-Axis Selector */}
        {chartType !== 'pie' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600r">X-Axis</span>
            <Select value={xAxis} onValueChange={setXAxis}>
              <SelectTrigger className="h-7 w-[140px] text-xs bg-white/5 border-white/10">
                <SelectValue placeholder="Select field" />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-white/10">
                {analysis.fields.map(field => (
                  <SelectItem key={field.name} value={field.name} className="text-xs">
                    <div className="flex items-center gap-2">
                      {getFieldIcon(field.type)}
                      {field.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Y-Axis Selector (for pie, this becomes the value field) */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-600r">
            {chartType === 'pie' ? 'Value' : 'Y-Axis'}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs bg-white/5 border-white/10 gap-1">
                {yAxis.length > 0 ? yAxis.join(', ') : 'Select fields'}
                <Settings2 className="w-3 h-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-[#111] border-white/10">
              {analysis.numericFields.map(field => (
                <DropdownMenuItem
                  key={field}
                  onClick={() => chartType === 'pie' ? setYAxis([field]) : toggleYAxis(field)}
                  className={cn(
                    "text-xs cursor-pointer",
                    yAxis.includes(field) && "bg-blue-600/20 text-blue-400"
                  )}
                >
                  <Hash className="w-3 h-3 mr-2" />
                  {field}
                  {yAxis.includes(field) && <span className="ml-auto">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Scatter Y-axis */}
        {chartType === 'scatter' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600r">Y</span>
            <Select value={scatterY} onValueChange={setScatterY}>
              <SelectTrigger className="h-7 w-[120px] text-xs bg-white/5 border-white/10">
                <SelectValue placeholder="Y field" />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-white/10">
                {analysis.numericFields.filter(f => f !== xAxis).map(field => (
                  <SelectItem key={field} value={field} className="text-xs">{field}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Histogram buckets */}
        {chartType === 'histogram' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600r">Buckets</span>
            <Select value={String(histogramBuckets)} onValueChange={(v) => setHistogramBuckets(Number(v))}>
              <SelectTrigger className="h-7 w-[70px] text-xs bg-white/5 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-white/10">
                {[5, 10, 20, 50].map(n => (
                  <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Aggregation */}
        {chartType !== 'scatter' && chartType !== 'histogram' && chartType !== 'pie' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600r">Agg</span>
            <Select value={aggregation} onValueChange={(v) => setAggregation(v as AggregationType)}>
              <SelectTrigger className="h-7 w-[80px] text-xs bg-white/5 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-white/10">
                {(['none', 'sum', 'avg', 'count', 'min', 'max'] as const).map(a => (
                  <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Date Grouping */}
        {analysis.dateFields.length > 0 && chartType !== 'scatter' && chartType !== 'histogram' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600r">Group</span>
            <Select value={dateGrouping || 'none'} onValueChange={(v) => setDateGrouping(v === 'none' ? '' : v as DateGrouping)}>
              <SelectTrigger className="h-7 w-[80px] text-xs bg-white/5 border-white/10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#111] border-white/10">
                <SelectItem value="none" className="text-xs">None</SelectItem>
                {(['hour', 'day', 'week', 'month', 'year'] as const).map(g => (
                  <SelectItem key={g} value={g} className="text-xs capitalize">{g}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Save Chart */}
        {showSaveDialog ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="Chart name..."
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveChart()}
              className="h-7 px-2 text-xs bg-white/5 border border-white/10 rounded text-zinc-300 focus:outline-none focus:border-blue-500"
              autoFocus
            />
            <Button variant="ghost" size="sm" className="h-7 text-xs text-blue-400" onClick={handleSaveChart}>Save</Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-zinc-500" onClick={() => setShowSaveDialog(false)}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs text-zinc-500 hover:text-white gap-1" onClick={() => setShowSaveDialog(true)}>
              <Save className="w-3 h-3" /> Save
            </Button>
            {savedCharts.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-zinc-500 hover:text-white gap-1">
                    <FolderOpen className="w-3 h-3" /> Saved ({savedCharts.length})
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-[#111] border-white/10 max-h-48 overflow-auto">
                  {savedCharts.map(chart => (
                    <DropdownMenuItem key={chart.id} className="text-xs cursor-pointer flex items-center justify-between gap-4">
                      <span onClick={() => loadSavedChart(chart)}>{chart.name} <span className="text-zinc-600">({chart.chartType})</span></span>
                      <button onClick={(e) => { e.stopPropagation(); deleteSavedChart(chart.id); }} className="text-zinc-600 hover:text-red-400">
                        <X className="w-3 h-3" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

        {/* Export Button */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 text-xs font-medium text-zinc-500 hover:text-white gap-1">
              <Download className="w-3 h-3" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-[#111] border-white/10">
            <DropdownMenuItem onClick={() => exportChart('png')} className="text-xs cursor-pointer">
              Export as PNG
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportChart('svg')} className="text-xs cursor-pointer">
              Export as SVG
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Chart Area */}
      <div ref={chartRef} className="flex-1 p-4 min-h-0">
        {yAxis.length === 0 ? (
          <div className="h-full flex items-center justify-center text-zinc-600 text-xs">
            Select at least one numeric field for the chart
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chartType === 'bar' ? (
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: '#666', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: '#666', fontSize: 11 }}
                  tickFormatter={formatNumber}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} />
                {yAxis.map((field, index) => (
                  <Bar
                    key={field}
                    dataKey={field}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                    radius={[4, 4, 0, 0]}
                  />
                ))}
              </BarChart>
            ) : chartType === 'line' ? (
              <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: '#666', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: '#666', fontSize: 11 }}
                  tickFormatter={formatNumber}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} />
                {yAxis.map((field, index) => (
                  <Line
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stroke={CHART_COLORS[index % CHART_COLORS.length]}
                    strokeWidth={2}
                    dot={{ fill: CHART_COLORS[index % CHART_COLORS.length], strokeWidth: 0, r: 4 }}
                    activeDot={{ r: 6, strokeWidth: 0 }}
                  />
                ))}
              </LineChart>
            ) : chartType === 'area' ? (
              <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: '#666', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: '#666', fontSize: 11 }}
                  tickFormatter={formatNumber}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} />
                {yAxis.map((field, index) => (
                  <Area
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stroke={CHART_COLORS[index % CHART_COLORS.length]}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                    fillOpacity={0.3}
                    strokeWidth={2}
                  />
                ))}
              </AreaChart>
            ) : chartType === 'scatter' ? (
              <ScatterChart margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey={xAxis}
                  type="number"
                  tick={{ fill: '#666', fontSize: 11 }}
                  name={xAxis}
                  label={{ value: xAxis, position: 'bottom', fill: '#666', fontSize: 11 }}
                />
                <YAxis
                  dataKey={scatterY}
                  type="number"
                  tick={{ fill: '#666', fontSize: 11 }}
                  name={scatterY}
                  label={{ value: scatterY, angle: -90, position: 'insideLeft', fill: '#666', fontSize: 11 }}
                />
                <ZAxis range={[40, 200]} />
                <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                <Scatter
                  name={`${xAxis} vs ${scatterY}`}
                  data={chartData}
                  fill={CHART_COLORS[0]}
                  shape="circle"
                />
              </ScatterChart>
            ) : chartType === 'histogram' ? (
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey="range"
                  tick={{ fill: '#666', fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: '#666', fontSize: 11 }}
                  label={{ value: 'Count', angle: -90, position: 'insideLeft', fill: '#666', fontSize: 11 }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            ) : chartType === 'stacked-bar' ? (
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: '#666', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: '#666', fontSize: 11 }}
                  tickFormatter={formatNumber}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} />
                {yAxis.map((field, index) => (
                  <Bar
                    key={field}
                    dataKey={field}
                    stackId="stack"
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                  />
                ))}
              </BarChart>
            ) : chartType === 'stacked-area' ? (
              <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: '#666', fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: '#666', fontSize: 11 }}
                  tickFormatter={formatNumber}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} />
                {yAxis.map((field, index) => (
                  <Area
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stackId="stack"
                    stroke={CHART_COLORS[index % CHART_COLORS.length]}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                    fillOpacity={0.5}
                  />
                ))}
              </AreaChart>
            ) : (
              <PieChart margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                <Pie
                  data={chartData.slice(0, 10)}
                  dataKey={yAxis[0]}
                  nameKey={xAxis}
                  cx="50%"
                  cy="50%"
                  outerRadius="70%"
                  label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  labelLine={{ stroke: '#444' }}
                >
                  {chartData.slice(0, 10).map((_entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend />
              </PieChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* Footer Stats */}
      <div className="px-3 py-2 border-t border-white/5 bg-[#0a0a0a] flex items-center gap-4 text-xs text-zinc-600">
        <span>Rows: <span className="text-zinc-400 font-mono">{result?.rows.length || 0}</span></span>
        <span>Fields: <span className="text-zinc-400 font-mono">{analysis.fields.length}</span></span>
        <span>Numeric: <span className="text-zinc-400 font-mono">{analysis.numericFields.length}</span></span>
        {chartType === 'pie' && chartData.length > 10 && (
          <span className="text-amber-500">Showing top 10 values</span>
        )}
      </div>
    </div>
  );
}
