"use client";

import React, { useState, useMemo, useRef, useCallback } from "react";
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
} from "recharts";
import { toast } from "sonner";
import { type AgentChartSpec, QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChartColumn,
  ChartLine as LineChartIcon,
  ChartPie as PieChartIcon,
  ChartArea as AreaChartIcon,
  Download,
  Settings2,
  TrendingUp,
  Hash,
  Calendar,
  Type,
  CircleAlert,
  Circle,
  ChartNoAxesColumn,
  Save,
  FolderOpen,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { storage } from "@/lib/storage";
import { chartTheme } from "@/lib/charts/palette";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { downloadBlob } from "@/lib/export/download";
import { logger } from "@/lib/logger";

type ChartType = "bar" | "line" | "pie" | "area" | "scatter" | "histogram" | "stacked-bar" | "stacked-area";

/*
  The forms that draw one mark per selected Y field, and so the only ones the palette
  cap can drop a series from. Histogram buckets `yAxis[0]` on its own and scatter draws
  X against its own Y, so a cap never applies to either — they keep the whole selection
  visible in the picker regardless, and must not carry the truncation note. The pie caps
  rows rather than fields and says so in its own note.
*/
const MULTI_SERIES_CHART_TYPES: ReadonlySet<ChartType> = new Set([
  "bar",
  "line",
  "area",
  "stacked-bar",
  "stacked-area",
]);

export type AggregationType = "none" | "sum" | "avg" | "count" | "min" | "max";
export type DateGrouping = "hour" | "day" | "week" | "month" | "year";

export interface FieldAnalysis {
  name: string;
  type: "numeric" | "categorical" | "date" | "unknown";
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
  /**
   * A chart somebody else chose — today, the one an agent run composed as its answer.
   *
   * Optional, and absent for every ordinary caller: a user who ran a query gets the
   * inferred chart they always got. When it is present the TYPE and the AXES come
   * from it rather than from `analyzeData`, because the specification's author knows
   * what was asked and the inference only knows what the data looks like. The
   * controls stay live: this seeds the view, it does not lock it.
   */
  spec?: AgentChartSpec | null;
}

/**
 * Whether a specification can be drawn over the result that actually arrived.
 *
 * The server refused a specification whose columns the artifact did not have, and
 * this asks the same question again of the delivered rows — two guards, because they
 * are checking two different things and the failure mode is silent: `Number(value) || 0`
 * below turns an absent or non-numeric column into a confident flat line of zeros
 * rather than into an error. A specification that does not survive this is dropped,
 * and the inference draws the chart instead.
 *
 * There is no series-split case to reject any more. This component draws several
 * series as several `y` columns and never had another way, so `AgentChartSpec` no
 * longer carries a `series` field for the contract to invite and this function to
 * throw away — a disagreement between four layers is now a field that does not exist.
 */
function specApplies(spec: AgentChartSpec, analysis: DataAnalysis): boolean {
  if (!analysis.fields.some((field) => field.name === spec.x)) return false;
  if (!spec.y.every((column) => analysis.numericFields.includes(column))) return false;
  // Scatter reads both axes as numbers, so a categorical x is the same failure.
  if (spec.type === "scatter" && !analysis.numericFields.includes(spec.x)) return false;
  return true;
}

export function analyzeField(name: string, values: unknown[]): FieldAnalysis {
  const nonNullValues = values.filter((v) => v !== null && v !== undefined);
  const uniqueValues = new Set(nonNullValues).size;
  const sample = nonNullValues[0];

  // Check if numeric
  const numericCount = nonNullValues.filter(
    (v) => typeof v === "number" || (typeof v === "string" && !isNaN(Number(v))),
  ).length;
  const isNumeric = numericCount > nonNullValues.length * 0.8;

  // Check if date
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}/, // ISO date
    /^\d{2}\/\d{2}\/\d{4}/, // US date
    /^\d{2}\.\d{2}\.\d{4}/, // EU date
  ];
  const isDate = nonNullValues.some(
    (v) => (typeof v === "string" && datePatterns.some((p) => p.test(v))) || v instanceof Date,
  );

  let type: FieldAnalysis["type"] = "unknown";
  if (isDate) type = "date";
  else if (isNumeric) type = "numeric";
  else if (uniqueValues <= 50) type = "categorical";

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
      suggestedChartType: "bar",
      isVisualizable: false,
      reason: "No data to visualize",
    };
  }

  if (result.rows.length < 2) {
    return {
      fields: [],
      numericFields: [],
      categoricalFields: [],
      dateFields: [],
      suggestedChartType: "bar",
      isVisualizable: false,
      reason: "Need at least 2 rows for visualization",
    };
  }

  const fieldNames = result.fields || Object.keys(result.rows[0]);
  const fields = fieldNames.map((name) =>
    analyzeField(
      name,
      result.rows.map((row) => row[name]),
    ),
  );

  const numericFields = fields.filter((f) => f.type === "numeric").map((f) => f.name);
  const categoricalFields = fields.filter((f) => f.type === "categorical").map((f) => f.name);
  const dateFields = fields.filter((f) => f.type === "date").map((f) => f.name);

  if (numericFields.length === 0) {
    return {
      fields,
      numericFields,
      categoricalFields,
      dateFields,
      suggestedChartType: "bar",
      isVisualizable: false,
      reason: "No numeric fields found for Y-axis",
    };
  }

  // Suggest chart type based on data
  let suggestedChartType: ChartType = "bar";

  if (dateFields.length > 0) {
    suggestedChartType = "line"; // Time series → line chart
  } else if (numericFields.length >= 2 && categoricalFields.length === 0) {
    suggestedChartType = "scatter"; // 2+ numeric, no categorical → scatter
  } else if (categoricalFields.length > 0 && result.rows.length <= 10) {
    suggestedChartType = "pie"; // Few categories → pie chart
  } else if (categoricalFields.length > 0) {
    suggestedChartType = "bar"; // Many categories → bar chart
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
    return (value / 1000000).toFixed(1) + "M";
  }
  if (Math.abs(value) >= 1000) {
    return (value / 1000).toFixed(1) + "K";
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
    <div className="bg-overlay border border-hairline-strong rounded-lg px-3 py-2 shadow-xl">
      <p className="text-fg-tertiary text-xs mb-1">{label}</p>
      {payload.map((entry, index) => (
        // The series colour rides a swatch, never the text. Some slots sit at
        // 2.07:1 against the light surface — legible as a mark, unreadable as a
        // label — and identity is carried by the swatch beside the name anyway.
        <p key={index} className="text-xs flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-[2px] shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-fg-secondary">{entry.name}:</span>
          <span className="font-mono font-medium text-fg">{formatNumber(entry.value)}</span>
        </p>
      ))}
    </div>
  );
};

interface PieSliceLabelProps {
  /** Text colour. Passed by the caller; everything else recharts injects. */
  ink: string;
  x?: number;
  y?: number;
  /** Recharts picks the anchor from which half of the pie the slice sits on. */
  textAnchor?: React.SVGAttributes<SVGTextElement>["textAnchor"];
  name?: string;
  percent?: number;
}

/**
 * The label on a pie slice.
 *
 * Handed to recharts as an ELEMENT (`label={<PieSliceLabel ink={…} />}`) rather
 * than a render function: recharts clones it with the computed geometry, which
 * keeps the component testable on its own and leaves no anonymous callback in the
 * JSX that only a rendered chart could reach.
 *
 * Returning `<text>` rather than a string is the whole point — given a string,
 * recharts paints the label in the SLICE's colour, and the low-contrast slots
 * become unreadable words on the light ground.
 */
export function PieSliceLabel({ ink, x, y, textAnchor, name = "", percent = 0 }: PieSliceLabelProps) {
  return (
    <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" fill={ink} fontSize={11}>
      {`${name} (${(percent * 100).toFixed(0)}%)`}
    </text>
  );
}

// Histogram bin calculation
export function computeHistogramBins(
  values: number[],
  buckets: number,
): { range: string; count: number; min: number; max: number }[] {
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
  values.forEach((v) => {
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
  dateGrouping?: DateGrouping,
): Record<string, unknown>[] {
  if (metrics.every((m) => m.aggregation === "none")) return rows;

  const groups = new Map<string, Record<string, unknown>[]>();
  rows.forEach((row) => {
    let key = String(row[groupByField] ?? "");
    if (dateGrouping && key) {
      key = groupByDate(key, dateGrouping);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  });

  return Array.from(groups.entries()).map(([key, groupRows]) => {
    const result: Record<string, unknown> = { [groupByField]: key };
    metrics.forEach(({ field, aggregation }) => {
      const values = groupRows.map((r) => Number(r[field]) || 0);
      switch (aggregation) {
        case "sum":
          result[field] = values.reduce((a, b) => a + b, 0);
          break;
        case "avg":
          result[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
          break;
        case "count":
          result[field] = values.length;
          break;
        case "min":
          result[field] = Math.min(...values);
          break;
        case "max":
          result[field] = Math.max(...values);
          break;
        default:
          result[field] = values[0];
      }
    });
    return result;
  });
}

export function groupByDate(dateStr: string, grouping: DateGrouping): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  switch (grouping) {
    case "hour":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:00`;
    case "day":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    case "week": {
      const d = new Date(date);
      d.setDate(d.getDate() - d.getDay());
      return `W${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    case "month":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    case "year":
      return `${date.getFullYear()}`;
    default:
      return dateStr;
  }
}

export function DataCharts({ result, spec = null }: DataChartsProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const analysis = useMemo(() => analyzeData(result), [result]);
  /** The supplied specification, or null when there is none this result can carry. */
  const appliedSpec = useMemo(() => (spec !== null && specApplies(spec, analysis) ? spec : null), [spec, analysis]);

  // Recharts paints an SVG canvas from JS values and cannot read the CSS tokens,
  // so the chart is the one surface that has to be handed its palette.
  const viz = chartTheme(useEffectiveTheme());
  const CHART_COLORS = viz.series;
  // The palette has one colour per slot; past that, a series or pie slice
  // would repeat an earlier colour and become indistinguishable from it. Cap
  // rendering at the palette size rather than silently reusing a colour, and
  // say so in the footer so a dropped series isn't mistaken for missing data
  // (it's still in the Results grid). With the cap in place every render site
  // indexes the palette directly: a wrapping index would only bring the colour
  // collision back, so `undefined` is the honest outcome if the cap ever slips.
  const MAX_SERIES = CHART_COLORS.length;

  // Recharts writes legend entries in the series colour. The coloured icon beside
  // each entry already carries identity, so the word itself goes back to ink —
  // otherwise the low-contrast slots become unreadable labels on the light ground.
  const legendProps = {
    formatter: (value: string) => <span style={{ color: viz.ink }}>{value}</span>,
  };

  const [chartType, setChartType] = useState<ChartType>(analysis.suggestedChartType);
  const [xAxis, setXAxis] = useState<string>("");
  const [yAxis, setYAxis] = useState<string[]>([]);
  const [scatterY, setScatterY] = useState<string>("");
  const [histogramBuckets, setHistogramBuckets] = useState(10);
  const [aggregation, setAggregation] = useState<AggregationType>("none");
  const [dateGrouping, setDateGrouping] = useState<DateGrouping | "">("");

  // Saved charts state, read once from the store the save/delete handlers below write back to.
  const [savedCharts, setSavedCharts] = useState(() =>
    storage.getSavedCharts().map((c) => ({
      id: c.id,
      name: c.name,
      chartType: c.chartType as ChartType,
      xAxis: c.xAxis,
      yAxis: c.yAxis,
      aggregation: (c.aggregation || "none") as AggregationType,
      dateGrouping: c.dateGrouping || "",
    })),
  );
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState("");

  /*
    The analysis and the specification these selections were derived from. Adjusting the
    state during render rather than in an effect means the chart never paints once with
    the previous result's axes; the condition is what stops it looping. Both `analysis`
    and `appliedSpec` are memos over the props, so they hold their identity until the
    props change and the condition goes false again on the very next pass.
  */
  const [derivedFrom, setDerivedFrom] = useState<{ a: DataAnalysis; s: AgentChartSpec | null } | null>(null);
  if (derivedFrom === null || derivedFrom.a !== analysis || derivedFrom.s !== appliedSpec) {
    setDerivedFrom({ a: analysis, s: appliedSpec });
    if (analysis.isVisualizable) {
      /*
        A specification that survived validation seeds the view instead of the
        inference: the type is the one its author chose, and the axes are the columns
        it named. The controls are untouched, so the user can still take the chart
        somewhere else from here.
      */
      if (appliedSpec !== null) {
        setChartType(appliedSpec.type);
        setXAxis(appliedSpec.x);
        setYAxis([...appliedSpec.y]);
        // Scatter draws x against ONE other column, held separately from `yAxis`.
        if (appliedSpec.type === "scatter") setScatterY(appliedSpec.y[0]);
      } else {
        setChartType(analysis.suggestedChartType);

        const defaultX = analysis.categoricalFields[0] || analysis.dateFields[0] || analysis.fields[0]?.name || "";
        setXAxis(defaultX);

        if (analysis.numericFields.length > 0) {
          setYAxis([analysis.numericFields[0]]);
        }
        if (analysis.numericFields.length >= 2) {
          setScatterY(analysis.numericFields[1]);
        }
      }
    }
  }

  const chartData = useMemo(() => {
    if (!result?.rows) return [];

    // Histogram: special data preparation
    if (chartType === "histogram" && yAxis.length > 0) {
      const values = result.rows.map((r) => Number(r[yAxis[0]]) || 0).filter((v) => !isNaN(v));
      return computeHistogramBins(values, histogramBuckets);
    }

    // Scatter: needs both axes as numeric
    if (chartType === "scatter") {
      if (!xAxis || !scatterY) return [];
      return result.rows.map((row) => ({
        [xAxis]: typeof row[xAxis] === "number" ? row[xAxis] : Number(row[xAxis]) || 0,
        [scatterY]: typeof row[scatterY] === "number" ? row[scatterY] : Number(row[scatterY]) || 0,
      }));
    }

    if (!xAxis) return [];

    const baseData = result.rows.map((row) => {
      const dataPoint: Record<string, unknown> = { [xAxis]: row[xAxis] };
      yAxis.forEach((field) => {
        const value = row[field];
        dataPoint[field] = typeof value === "number" ? value : Number(value) || 0;
      });
      return dataPoint;
    });

    // Apply aggregation if set
    if (aggregation !== "none" && yAxis.length > 0) {
      return aggregateData(
        baseData,
        xAxis,
        yAxis.map((f) => ({ field: f, aggregation })),
        dateGrouping || undefined,
      );
    }

    // Apply date grouping even without aggregation
    if (dateGrouping) {
      return aggregateData(
        baseData,
        xAxis,
        yAxis.map((f) => ({ field: f, aggregation: "sum" })),
        dateGrouping,
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
      dateGrouping: dateGrouping || "",
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
    setSaveName("");
  }, [saveName, chartType, xAxis, yAxis, aggregation, dateGrouping, savedCharts]);

  // Load saved chart config
  const loadSavedChart = useCallback((chart: (typeof savedCharts)[0]) => {
    setChartType(chart.chartType);
    setXAxis(chart.xAxis);
    setYAxis(chart.yAxis);
    setAggregation(chart.aggregation);
    setDateGrouping((chart.dateGrouping || "") as DateGrouping | "");
  }, []);

  // Delete saved chart
  const deleteSavedChart = useCallback(
    (id: string) => {
      const updated = savedCharts.filter((c) => c.id !== id);
      setSavedCharts(updated);
      storage.deleteChart(id);
    },
    [savedCharts],
  );

  const exportChart = useCallback(
    async (format: "png" | "svg") => {
      if (!chartRef.current) return;

      if (format === "png") {
        try {
          // snapdom lets the browser rasterize a DOM snapshot, so Tailwind 4's
          // oklch() colors export correctly (html2canvas could not parse them
          // and failed silently). Fonts stay unembedded: Monaco's cross-origin
          // CDN stylesheet breaks webfont CSS collection (SecurityError).
          const { snapdom } = await import("@zumer/snapdom");
          const capture = await snapdom(chartRef.current, {
            backgroundColor: viz.exportBackground,
            scale: 2,
            embedFonts: false,
          });
          const blob = await capture.toBlob({ type: "png" });
          if (!blob) throw new Error("PNG encoding produced no data");
          downloadBlob(blob, `chart_${Date.now()}.png`);
        } catch (error) {
          logger.warn("Chart PNG export failed", {
            route: "DataCharts",
            error: error instanceof Error ? error.message : String(error),
          });
          toast.error("PNG export failed", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // SVG export - find the SVG element
        const svgElement = chartRef.current.querySelector("svg");
        if (svgElement) {
          const svgData = new XMLSerializer().serializeToString(svgElement);
          downloadBlob(new Blob([svgData], { type: "image/svg+xml" }), `chart_${Date.now()}.svg`);
        }
      }
    },
    // `viz` is derived from the effective theme, and this list used to be empty:
    // after a theme toggle the PNG was still painted on the ground the chart was
    // first rendered on — a light chart exported onto near-black. Same defect the
    // ERD export fixed in #384, in the surface that comment points at.
    [viz.exportBackground],
  );

  const toggleYAxis = (field: string) => {
    setYAxis((prev) => {
      if (prev.includes(field)) {
        return prev.filter((f) => f !== field);
      }
      return [...prev, field];
    });
  };

  // Empty state
  if (!analysis.isVisualizable) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-sunken text-fg-muted">
        <TrendingUp className="w-12 h-12 mb-4 opacity-30" />
        <p className="text-xs font-medium mb-1">Cannot Visualize Data</p>
        <p className="text-xs text-fg-subtle">{analysis.reason}</p>
      </div>
    );
  }

  const chartTypes: { type: ChartType; icon: React.ReactNode; label: string }[] = [
    { type: "bar", icon: <ChartColumn strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Bar" },
    { type: "line", icon: <LineChartIcon strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Line" },
    { type: "pie", icon: <PieChartIcon strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Pie" },
    { type: "area", icon: <AreaChartIcon strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Area" },
    { type: "scatter", icon: <Circle strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Scatter" },
    { type: "histogram", icon: <ChartNoAxesColumn strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Histogram" },
    { type: "stacked-bar", icon: <ChartColumn strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Stacked" },
    { type: "stacked-area", icon: <AreaChartIcon strokeWidth={1.5} className="w-3.5 h-3.5" />, label: "Stack Area" },
  ];

  const getFieldIcon = (type: FieldAnalysis["type"]) => {
    switch (type) {
      case "numeric":
        return <Hash strokeWidth={1.5} className="w-3 h-3" />;
      case "date":
        return <Calendar className="w-3 h-3" />;
      case "categorical":
        return <Type strokeWidth={1.5} className="w-3 h-3" />;
      default:
        return <CircleAlert strokeWidth={1.5} className="w-3 h-3" />;
    }
  };

  const plottedYAxis = yAxis.slice(0, MAX_SERIES);
  const droppedYAxisCount = yAxis.length - plottedYAxis.length;

  return (
    <div className="h-full flex flex-col bg-sunken">
      {/* Config Bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hairline bg-surface flex-wrap">
        {/* Chart Type Selector */}
        <div className="flex items-center gap-1 bg-fill rounded-lg p-0.5">
          {chartTypes.map(({ type, icon, label }) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
                chartType === type ? "bg-blue-600 text-white" : "text-fg-muted hover:text-fg-secondary hover:bg-fill",
              )}
              title={label}
            >
              {icon}
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-fill-strong hidden sm:block" />

        {/* X-Axis Selector */}
        {chartType !== "pie" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">X-Axis</span>
            <Select value={xAxis} onValueChange={setXAxis}>
              <SelectTrigger className="h-7 w-[140px] text-xs bg-fill border-hairline-strong">
                <SelectValue placeholder="Select field" />
              </SelectTrigger>
              <SelectContent className="bg-overlay border-hairline-strong">
                {analysis.fields.map((field) => (
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
          <span className="text-xs text-fg-subtle">{chartType === "pie" ? "Value" : "Y-Axis"}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs bg-fill border-hairline-strong gap-1">
                {yAxis.length > 0 ? yAxis.join(", ") : "Select fields"}
                <Settings2 strokeWidth={1.5} className="w-3 h-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="bg-overlay border-hairline-strong">
              {analysis.numericFields.map((field) => (
                <DropdownMenuItem
                  key={field}
                  onClick={() => (chartType === "pie" ? setYAxis([field]) : toggleYAxis(field))}
                  className={cn("text-xs cursor-pointer", yAxis.includes(field) && "bg-blue-600/20 text-blue-400")}
                >
                  <Hash strokeWidth={1.5} className="w-3 h-3 mr-2" />
                  {field}
                  {yAxis.includes(field) && <span className="ml-auto">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Scatter Y-axis */}
        {chartType === "scatter" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">Y</span>
            <Select value={scatterY} onValueChange={setScatterY}>
              <SelectTrigger className="h-7 w-[120px] text-xs bg-fill border-hairline-strong">
                <SelectValue placeholder="Y field" />
              </SelectTrigger>
              <SelectContent className="bg-overlay border-hairline-strong">
                {analysis.numericFields
                  .filter((f) => f !== xAxis)
                  .map((field) => (
                    <SelectItem key={field} value={field} className="text-xs">
                      {field}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Histogram buckets */}
        {chartType === "histogram" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">Buckets</span>
            <Select value={String(histogramBuckets)} onValueChange={(v) => setHistogramBuckets(Number(v))}>
              <SelectTrigger className="h-7 w-[70px] text-xs bg-fill border-hairline-strong">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-overlay border-hairline-strong">
                {[5, 10, 20, 50].map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-xs">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Aggregation */}
        {chartType !== "scatter" && chartType !== "histogram" && chartType !== "pie" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">Agg</span>
            <Select value={aggregation} onValueChange={(v) => setAggregation(v as AggregationType)}>
              <SelectTrigger className="h-7 w-[80px] text-xs bg-fill border-hairline-strong">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-overlay border-hairline-strong">
                {(["none", "sum", "avg", "count", "min", "max"] as const).map((a) => (
                  <SelectItem key={a} value={a} className="text-xs">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Date Grouping */}
        {analysis.dateFields.length > 0 && chartType !== "scatter" && chartType !== "histogram" && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-subtle">Group</span>
            <Select
              value={dateGrouping || "none"}
              onValueChange={(v) => setDateGrouping(v === "none" ? "" : (v as DateGrouping))}
            >
              <SelectTrigger className="h-7 w-[80px] text-xs bg-fill border-hairline-strong">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-overlay border-hairline-strong">
                <SelectItem value="none" className="text-xs">
                  None
                </SelectItem>
                {(["hour", "day", "week", "month", "year"] as const).map((g) => (
                  <SelectItem key={g} value={g} className="text-xs capitalize">
                    {g}
                  </SelectItem>
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
              onKeyDown={(e) => e.key === "Enter" && handleSaveChart()}
              className="h-7 px-2 text-xs bg-fill border border-hairline-strong rounded text-fg-secondary focus:outline-none focus:border-blue-500"
              autoFocus
            />
            <Button variant="ghost" size="sm" className="h-7 text-xs text-blue-400" onClick={handleSaveChart}>
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-fg-muted"
              onClick={() => setShowSaveDialog(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-fg-muted hover:text-fg-bright gap-1"
              onClick={() => setShowSaveDialog(true)}
            >
              <Save strokeWidth={1.5} className="w-3 h-3" /> Save
            </Button>
            {savedCharts.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-fg-muted hover:text-fg-bright gap-1">
                    <FolderOpen strokeWidth={1.5} className="w-3 h-3" /> Saved ({savedCharts.length})
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-overlay border-hairline-strong max-h-48 overflow-auto">
                  {savedCharts.map((chart) => (
                    <DropdownMenuItem
                      key={chart.id}
                      onSelect={() => loadSavedChart(chart)}
                      className="text-xs cursor-pointer flex items-center justify-between gap-4"
                    >
                      <span>
                        {chart.name} <span className="text-fg-subtle">({chart.chartType})</span>
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSavedChart(chart.id);
                        }}
                        className="text-fg-subtle hover:text-red-400"
                      >
                        <X strokeWidth={1.5} className="w-3 h-3" />
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
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
            >
              <Download strokeWidth={1.5} className="w-3 h-3" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-overlay border-hairline-strong">
            <DropdownMenuItem onClick={() => exportChart("png")} className="text-xs cursor-pointer">
              Export as PNG
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportChart("svg")} className="text-xs cursor-pointer">
              Export as SVG
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Chart Area */}
      <div ref={chartRef} className="flex-1 p-4 min-h-0">
        {yAxis.length === 0 ? (
          <div className="h-full flex items-center justify-center text-fg-subtle text-xs">
            Select at least one numeric field for the chart
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chartType === "bar" ? (
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: viz.axis, fontSize: 11 }} tickFormatter={formatNumber} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} {...legendProps} />
                {plottedYAxis.map((field, index) => (
                  <Bar key={field} dataKey={field} fill={CHART_COLORS[index]} radius={[4, 4, 0, 0]} />
                ))}
              </BarChart>
            ) : chartType === "line" ? (
              <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: viz.axis, fontSize: 11 }} tickFormatter={formatNumber} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} {...legendProps} />
                {plottedYAxis.map((field, index) => (
                  <Line
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stroke={CHART_COLORS[index]}
                    strokeWidth={2}
                    dot={{ fill: CHART_COLORS[index], strokeWidth: 0, r: 4 }}
                    activeDot={{ r: 6, strokeWidth: 0 }}
                  />
                ))}
              </LineChart>
            ) : chartType === "area" ? (
              <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: viz.axis, fontSize: 11 }} tickFormatter={formatNumber} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} {...legendProps} />
                {plottedYAxis.map((field, index) => (
                  <Area
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stroke={CHART_COLORS[index]}
                    fill={CHART_COLORS[index]}
                    fillOpacity={0.3}
                    strokeWidth={2}
                  />
                ))}
              </AreaChart>
            ) : chartType === "scatter" ? (
              <ScatterChart margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey={xAxis}
                  type="number"
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  name={xAxis}
                  label={{ value: xAxis, position: "bottom", fill: viz.axis, fontSize: 11 }}
                />
                <YAxis
                  dataKey={scatterY}
                  type="number"
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  name={scatterY}
                  label={{ value: scatterY, angle: -90, position: "insideLeft", fill: viz.axis, fontSize: 11 }}
                />
                <ZAxis range={[40, 200]} />
                <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: "3 3" }} />
                <Scatter name={`${xAxis} vs ${scatterY}`} data={chartData} fill={CHART_COLORS[0]} shape="circle" />
              </ScatterChart>
            ) : chartType === "histogram" ? (
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey="range"
                  tick={{ fill: viz.axis, fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  label={{ value: "Count", angle: -90, position: "insideLeft", fill: viz.axis, fontSize: 11 }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="count" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            ) : chartType === "stacked-bar" ? (
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: viz.axis, fontSize: 11 }} tickFormatter={formatNumber} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} {...legendProps} />
                {plottedYAxis.map((field, index) => (
                  <Bar key={field} dataKey={field} stackId="stack" fill={CHART_COLORS[index]} />
                ))}
              </BarChart>
            ) : chartType === "stacked-area" ? (
              <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={viz.grid} />
                <XAxis
                  dataKey={xAxis}
                  tick={{ fill: viz.axis, fontSize: 11 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: viz.axis, fontSize: 11 }} tickFormatter={formatNumber} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20 }} {...legendProps} />
                {plottedYAxis.map((field, index) => (
                  <Area
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stackId="stack"
                    stroke={CHART_COLORS[index]}
                    fill={CHART_COLORS[index]}
                    fillOpacity={0.5}
                  />
                ))}
              </AreaChart>
            ) : (
              <PieChart margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                <Pie
                  data={chartData.slice(0, MAX_SERIES)}
                  dataKey={yAxis[0]}
                  nameKey={xAxis}
                  cx="50%"
                  cy="50%"
                  outerRadius="70%"
                  // `PieSliceLabel` defaults `percent` to 0, which is the same
                  // guard recharts 3 made necessary by typing it optional — an
                  // absent value would otherwise render the label "name (NaN%)".
                  label={<PieSliceLabel ink={viz.ink} />}
                  labelLine={{ stroke: viz.grid }}
                >
                  {chartData.slice(0, MAX_SERIES).map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS[index]} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend {...legendProps} />
              </PieChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* Footer Stats */}
      <div className="px-3 py-2 border-t border-hairline bg-surface flex items-center gap-4 text-xs text-fg-subtle">
        <span>
          Rows: <span className="text-fg-tertiary font-mono">{result?.rows.length || 0}</span>
        </span>
        <span>
          Fields: <span className="text-fg-tertiary font-mono">{analysis.fields.length}</span>
        </span>
        <span>
          Numeric: <span className="text-fg-tertiary font-mono">{analysis.numericFields.length}</span>
        </span>
        {chartType === "pie" && chartData.length > MAX_SERIES && (
          <span className="text-amber-500">Showing top {MAX_SERIES} values</span>
        )}
        {MULTI_SERIES_CHART_TYPES.has(chartType) && droppedYAxisCount > 0 && (
          <span className="text-amber-500">
            Showing first {MAX_SERIES} of {yAxis.length} series — see the Results grid for the rest
          </span>
        )}
      </div>
    </div>
  );
}
