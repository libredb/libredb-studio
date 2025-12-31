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

type ChartType = 'bar' | 'line' | 'pie' | 'area';

interface FieldAnalysis {
  name: string;
  type: 'numeric' | 'categorical' | 'date' | 'unknown';
  uniqueValues: number;
  hasNulls: boolean;
  sample: unknown;
}

interface DataAnalysis {
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

function analyzeField(name: string, values: unknown[]): FieldAnalysis {
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

function analyzeData(result: QueryResult | null): DataAnalysis {
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

function formatNumber(value: number): string {
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
        <p key={index} className="text-sm" style={{ color: entry.color }}>
          {entry.name}: <span className="font-mono font-medium">{formatNumber(entry.value)}</span>
        </p>
      ))}
    </div>
  );
};

export function DataCharts({ result }: DataChartsProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const analysis = useMemo(() => analyzeData(result), [result]);

  const [chartType, setChartType] = useState<ChartType>(analysis.suggestedChartType);
  const [xAxis, setXAxis] = useState<string>('');
  const [yAxis, setYAxis] = useState<string[]>([]);

  // Initialize axis selections when analysis changes
  React.useEffect(() => {
    if (analysis.isVisualizable) {
      setChartType(analysis.suggestedChartType);

      // Set default X-axis
      const defaultX = analysis.categoricalFields[0] || analysis.dateFields[0] || analysis.fields[0]?.name || '';
      setXAxis(defaultX);

      // Set default Y-axis (first numeric field)
      if (analysis.numericFields.length > 0) {
        setYAxis([analysis.numericFields[0]]);
      }
    }
  }, [analysis]);

  const chartData = useMemo(() => {
    if (!result?.rows || !xAxis) return [];

    return result.rows.map(row => {
      const dataPoint: Record<string, unknown> = { [xAxis]: row[xAxis] };
      yAxis.forEach(field => {
        const value = row[field];
        dataPoint[field] = typeof value === 'number' ? value : Number(value) || 0;
      });
      return dataPoint;
    });
  }, [result, xAxis, yAxis]);

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
        <p className="text-sm font-medium mb-1">Cannot Visualize Data</p>
        <p className="text-xs text-zinc-600">{analysis.reason}</p>
      </div>
    );
  }

  const chartTypes: { type: ChartType; icon: React.ReactNode; label: string }[] = [
    { type: 'bar', icon: <BarChart3 className="w-4 h-4" />, label: 'Bar' },
    { type: 'line', icon: <LineChartIcon className="w-4 h-4" />, label: 'Line' },
    { type: 'pie', icon: <PieChartIcon className="w-4 h-4" />, label: 'Pie' },
    { type: 'area', icon: <AreaChartIcon className="w-4 h-4" />, label: 'Area' },
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
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider">X-Axis</span>
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
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">
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

        {/* Spacer */}
        <div className="flex-1" />

        {/* Export Button */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 text-[10px] font-bold uppercase text-zinc-500 hover:text-white gap-1">
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
          <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
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
            ) : (
              <PieChart margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                <Pie
                  data={chartData.slice(0, 10)} // Limit to 10 slices
                  dataKey={yAxis[0]}
                  nameKey={xAxis}
                  cx="50%"
                  cy="50%"
                  outerRadius="70%"
                  label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  labelLine={{ stroke: '#444' }}
                >
                  {chartData.slice(0, 10).map((entry, index) => (
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
      <div className="px-3 py-2 border-t border-white/5 bg-[#0a0a0a] flex items-center gap-4 text-[10px] text-zinc-600">
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
