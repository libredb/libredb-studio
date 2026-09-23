/**
 * Prometheus query results as grid rows (#1085, sections 5.3 and 5.4)
 *
 * Pure functions from the seam's PrometheusQueryData to the rows, fields and notices of a
 * QueryResult. Nothing here performs I/O or knows the wire: the envelope and the result-type names
 * are decoded in http-transport.ts, so every rule below is tested from hand-built seam values (3.5).
 *
 * Three rules fix every cell:
 *
 * - A time is float seconds on the wire and an ISO-8601 UTC string with milliseconds here, the form
 *   the chart tab recognises as a date and draws as a line (src/components/DataCharts.tsx).
 * - A finite value is a number. NaN, +Inf and -Inf stay the engine's text (maintainer decision,
 *   5.3): JSON would carry a NaN number as null, and in the wide matrix null already says "no
 *   sample at this instant".
 * - A native histogram stays the object the engine sent, for the grid's JSON renderer.
 *
 * Result shaping is a lookup from the result type to its shaper (3.5, open/closed), and every row
 * is built from entries rather than by assignment, because a label may be named `__proto__`.
 */
import type { QueryWarning } from "@/lib/types";
import { isLegacyLabelName, seriesNotation } from "./promql";
import {
  type PrometheusAnswer,
  type PrometheusQueryData,
  type PrometheusSample,
  type PrometheusSeries,
  PrometheusTransportError,
} from "./transport";

/**
 * The most cells one wide matrix holds, distinct instants times kept series (M3). A cell is one
 * sample slot of the grid, filled or null.
 *
 * The series cap alone does not bound a matrix, and neither does its sample count. The wide shape
 * gives each distinct instant a row, so a raw range over targets scraped at their own offsets holds
 * about samples times series cells: `up[1h]` over 200 targets is 48,000 samples and 9.6 million
 * cells. For a stepped subquery, whose series share their instants, the cells are about the
 * samples, and such a subquery is what M3 measures. Set by the live pass:
 * tests/fixtures/prometheus/README.md, section "Measurements", entry M3, records how.
 */
export const MATRIX_SAMPLE_BUDGET = 250_000;

export interface ShapeLimits {
  /**
   * Series kept from a vector or a matrix, in engine order: the provider passes DEFAULT_QUERY_LIMIT,
   * and the transport sends seriesLimit + 1 as `limit`.
   */
  readonly seriesLimit: number;
  /** The cells a wide matrix is held to, distinct instants times kept series: MATRIX_SAMPLE_BUDGET. */
  readonly sampleBudget: number;
}

export interface ShapedResult {
  readonly rows: Record<string, unknown>[];
  readonly fields: string[];
  readonly warnings: QueryWarning[]; // engine notices first, verbatim; then this provider's truncation notices
  readonly wasLimited: boolean;
}

/** The two fields this module writes beside the labels. No label is given either name. */
const TIMESTAMP_FIELD = "timestamp";
const VALUE_FIELD = "value";

/** The label that holds a series' metric name, placed first wherever labels are listed. */
const METRIC_NAME_LABEL = "__name__";

/** One field of one row. */
type Cell = readonly [field: string, value: unknown];

/** What a shaper returns; shapeQueryResult puts the engine's notices in front of its cuts. */
interface Table {
  readonly rows: Record<string, unknown>[];
  readonly fields: string[];
  /** This provider's truncation notices, one per bound that cut. */
  readonly cuts: QueryWarning[];
}

interface ShapeContext {
  readonly limits: ShapeLimits;
  /**
   * Whether the server's own `limit` cut the series: the seam's truncatedByServer, set by
   * http-transport.ts, the only file that spells the engine's sentence.
   */
  readonly serverCut: boolean;
}

/** The series a bound kept, and the notice it owes when it cut. */
interface Kept {
  readonly kept: readonly PrometheusSeries[];
  readonly cuts: QueryWarning[];
}

/** The seam member one result type arrives as. */
type ShapeOf<K extends PrometheusQueryData["shape"]> = Extract<PrometheusQueryData, { readonly shape: K }>;

type Shaper<K extends PrometheusQueryData["shape"]> = (data: ShapeOf<K>, context: ShapeContext) => Table;

/** The shaper for each result type the seam names (5.3). */
const SHAPERS: { readonly [K in PrometheusQueryData["shape"]]: Shaper<K> } = {
  vector: (data, context) => shapeVector(data.series, context),
  matrix: (data, context) => shapeMatrix(data.series, context),
  scalar: (data) => shapeInstant(data.sample, sampleCell(data.sample.value)),
  string: (data) => shapeInstant(data.sample, data.sample.value),
};

/**
 * The rows and fields of one answer, with the engine's notices verbatim and in its order, then one
 * notice for each bound that cut (5.4). `wasLimited` is true exactly when such a notice is present.
 */
export function shapeQueryResult(answer: PrometheusAnswer<PrometheusQueryData>, limits: ShapeLimits): ShapedResult {
  const serverCut = answer.truncatedByServer;
  const table = tableFor(answer.value, { limits, serverCut });
  return {
    rows: table.rows,
    fields: table.fields,
    warnings: [...answer.notices.map((notice) => ({ message: notice.message })), ...table.cuts],
    wasLimited: table.cuts.length > 0,
  };
}

/**
 * One field per label, in vector order: `__name__` first when present, the rest sorted by code
 * unit, each once. A legacy label name other than "timestamp" and "value" is the field itself; any
 * other name is JSON.stringify(name), which no legacy name ever equals, so no two labels share a
 * field and none takes a field this module writes.
 */
export function labelFieldNames(labelNames: readonly string[]): string[] {
  return vectorLabelOrder(labelNames).map(labelField);
}

/**
 * labelFieldNames(labelNames), then "timestamp" and "value": the one definition describeObject and
 * the vector shaper share, so a metric's columns in the tree are the fields of its instant query.
 */
export function vectorFieldNames(labelNames: readonly string[]): string[] {
  return [...labelFieldNames(labelNames), TIMESTAMP_FIELD, VALUE_FIELD];
}

/** Float seconds as an ISO-8601 UTC string with millisecond precision. */
export function formatSampleTime(seconds: number): string {
  return instantText(sampleMillis(seconds));
}

/** A finite number when the engine's text reads as one; the text itself otherwise ("NaN", "+Inf", "-Inf"). */
export function sampleCell(text: string): number | string {
  const value = Number(text);
  return Number.isFinite(value) ? value : text;
}

function tableFor(data: PrometheusQueryData, context: ShapeContext): Table {
  // Each entry takes exactly the member its key names, so the entry `data.shape` selects accepts
  // `data`. TypeScript cannot relate a union's tag to a lookup keyed by it, hence the one widening.
  const shaper = SHAPERS[data.shape] as (data: PrometheusQueryData, context: ShapeContext) => Table;
  return shaper(data, context);
}

/** A vector: one row per series, its labels, then timestamp and value (5.3). */
function shapeVector(held: readonly PrometheusSeries[], context: ShapeContext): Table {
  const { kept, cuts } = capSeries(held, context);
  const labelNames = kept.flatMap((series) => Object.keys(series.labels));
  const labels = vectorLabelOrder(labelNames).map((name) => ({ name, field: labelField(name) }));
  const rows = kept.map((series) => {
    const point = onlyPoint(series);
    return rowOf([
      ...labels.map(({ name, field }): Cell => [field, labelOf(series, name)]),
      [TIMESTAMP_FIELD, formatSampleTime(point.at)],
      [VALUE_FIELD, point.cell],
    ]);
  });
  return { rows, fields: vectorFieldNames(labelNames), cuts };
}

/** The one point of a vector series: the engine sends exactly one per series, and anything else is refused. */
function onlyPoint(series: PrometheusSeries): { readonly at: number; readonly cell: unknown } {
  const points = pointsIn(series);
  if (points !== 1) {
    throw new PrometheusTransportError(
      "protocol",
      `The server answered a vector series holding ${points} points; a vector holds exactly one per series.`,
    );
  }
  const [sample] = series.samples;
  if (sample !== undefined) return { at: sample.at, cell: sampleCell(sample.value) };
  const [point] = series.histograms;
  return { at: point.at, cell: point.histogram };
}

/**
 * A matrix, wide (5.3): one row per instant in the sorted union of every kept series' instants, and
 * one column per series, null where a series has no sample at that instant. A raw range selector
 * samples each series at its own scrape times, so its rows are sparse; a stepped subquery's align.
 */
function shapeMatrix(held: readonly PrometheusSeries[], context: ShapeContext): Table {
  const capped = capSeries(held, context);
  const { kept, cuts } = withinSampleBudget(capped.kept, context.limits.sampleBudget);
  const columns = seriesColumns(kept);
  const cellsByInstant = new Map<number, unknown[]>();
  const place = (column: number, at: number, cell: unknown): void => {
    const instant = sampleMillis(at);
    const cells = cellsByInstant.get(instant) ?? columns.map((): unknown => null);
    cells[column] = cell;
    cellsByInstant.set(instant, cells);
  };
  kept.forEach((series, column) => {
    for (const sample of series.samples) place(column, sample.at, sampleCell(sample.value));
    for (const point of series.histograms) place(column, point.at, point.histogram);
  });
  const rows = [...cellsByInstant.entries()]
    .sort(([left], [right]) => left - right)
    .map(([instant, cells]) =>
      rowOf([[TIMESTAMP_FIELD, instantText(instant)], ...columns.map((name, index): Cell => [name, cells[index]])]),
    );
  return { rows, fields: [TIMESTAMP_FIELD, ...columns], cuts: [...capped.cuts, ...cuts] };
}

/**
 * Each kept series' column name (5.3): the labels that tell the kept series apart, in PromQL label
 * notation, or `value` for a single series. A label tells them apart when its value differs among
 * them or some of them lack it; a lacking label reads as "", as seriesNotation writes it. Two
 * series with one label set would share a column, one overwriting the other, so that answer is
 * refused.
 */
function seriesColumns(kept: readonly PrometheusSeries[]): string[] {
  if (kept.length === 1) return [VALUE_FIELD];
  const distinguishing = vectorLabelOrder(kept.flatMap((series) => Object.keys(series.labels))).filter(
    (name) => new Set(kept.map((series) => labelOf(series, name) ?? "")).size > 1,
  );
  const columns = kept.map((series) => seriesNotation(series.labels, distinguishing));
  if (new Set(columns).size !== columns.length) {
    throw new PrometheusTransportError(
      "protocol",
      "The server answered a matrix holding two series with the same labels, so their columns could not be told apart.",
    );
  }
  return columns;
}

/** A scalar or a string: one row. A string result's value stays its text, "42" included. */
function shapeInstant(sample: PrometheusSample, value: number | string): Table {
  return {
    rows: [
      rowOf([
        [TIMESTAMP_FIELD, formatSampleTime(sample.at)],
        [VALUE_FIELD, value],
      ]),
    ],
    fields: [TIMESTAMP_FIELD, VALUE_FIELD],
    cuts: [],
  };
}

/**
 * The first `seriesLimit` series in engine order (5.4), with a notice when the answer held more
 * than that, or when the server's own limit had already cut it.
 *
 * The transport asks for seriesLimit + 1 series, so more than that with no truncation flag is
 * a server that ignored `limit` and sent everything: the one case with an exact total. Exactly
 * seriesLimit + 1 without the flag may be a cut whose notice the engine dropped, because it keeps
 * ten warnings (AsStrings, util/annotations/annotations.go), and a flagged answer held more than it
 * shows, by a number the server did not send; both are written as "more than".
 */
function capSeries(held: readonly PrometheusSeries[], context: ShapeContext): Kept {
  const { seriesLimit } = context.limits;
  const kept = held.slice(0, seriesLimit);
  if (!context.serverCut && held.length <= seriesLimit) return { kept, cuts: [] };
  const total =
    !context.serverCut && held.length > seriesLimit + 1
      ? formatCount(held.length)
      : `more than ${formatCount(context.serverCut ? held.length : seriesLimit)}`;
  return {
    kept,
    cuts: [
      {
        message: `Showing the first ${formatCount(kept.length)} of ${total} series. Narrow the selector or aggregate the result to see the rest.`,
      },
    ],
  };
}

/**
 * Whole series in engine order while the cells of the wide grid fit the budget (5.4), with a notice
 * naming what did not. The grid gives each distinct instant of the kept series a row, so its cells
 * are those instants times the kept series, filled or null, and a native histogram point takes one
 * cell like a float sample. A raw range over targets scraped at their own offsets makes nearly
 * every sample its own row, which is why the samples alone would undercount the grid. It stops at
 * the first series that does not fit even when a later one would, so what is kept is always the
 * first series of the answer, as the series cap keeps them.
 */
function withinSampleBudget(series: readonly PrometheusSeries[], budget: number): Kept {
  const instants = new Set<number>();
  let count = 0;
  for (const one of series) {
    const added = new Set(instantsOf(one).filter((instant) => !instants.has(instant)));
    if ((instants.size + added.size) * (count + 1) > budget) break;
    for (const instant of added) instants.add(instant);
    count += 1;
  }
  if (count === series.length) return { kept: series, cuts: [] };
  const allCells = new Set(series.flatMap(instantsOf)).size * series.length;
  return {
    kept: series.slice(0, count),
    cuts: [
      {
        message: `Showing ${formatCount(count)} of ${formatCount(series.length)} series and ${formatCount(instants.size * count)} of ${formatCount(allCells)} cells, because a matrix result is held to ${formatCount(budget)} cells. Use a larger step or a shorter range to see the rest.`,
      },
    ],
  };
}

/** A series' instants as the grid keys its rows: the engine's milliseconds of every float sample and histogram point. */
function instantsOf(series: PrometheusSeries): number[] {
  return [
    ...series.samples.map((sample) => sampleMillis(sample.at)),
    ...series.histograms.map((point) => sampleMillis(point.at)),
  ];
}

/**
 * A row from its cells, built from entries: `__proto__` is a legal label name, and assigned into an
 * object it would set the prototype, or vanish for a string.
 */
function rowOf(cells: readonly Cell[]): Record<string, unknown> {
  return Object.fromEntries(cells);
}

/**
 * A series' value for a label, or null when it lacks the label. Read as an own property, because
 * `constructor` is a legal label name and also a property every plain object inherits.
 */
function labelOf(series: PrometheusSeries, name: string): string | null {
  return Object.hasOwn(series.labels, name) ? series.labels[name] : null;
}

function pointsIn(series: PrometheusSeries): number {
  return series.samples.length + series.histograms.length;
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * The engine's integer milliseconds back out of its float seconds. Rounded, not truncated: they do
 * not always multiply back exactly (1073749647.001 * 1000 is 1073749647000.9999), and Date
 * truncates.
 */
function sampleMillis(seconds: number): number {
  return Math.round(seconds * 1000);
}

function instantText(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function vectorLabelOrder(labelNames: readonly string[]): string[] {
  const unique = new Set(labelNames);
  const rest = [...unique].filter((name) => name !== METRIC_NAME_LABEL).sort();
  return unique.has(METRIC_NAME_LABEL) ? [METRIC_NAME_LABEL, ...rest] : rest;
}

function labelField(name: string): string {
  return isLegacyLabelName(name) && name !== TIMESTAMP_FIELD && name !== VALUE_FIELD ? name : JSON.stringify(name);
}
