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
import { isLegacyLabelName, labelMatcher, seriesNotation } from "./promql";
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

/**
 * The most UTF-8 bytes the rows and fields of one vector or matrix result take as JSON, which is all
 * the query route sends of a result but its notices (5.4); those are a few hundred bytes, except the
 * one naming a series kept under `value`, which holds that series' name once.
 *
 * The response byte cap bounds the answer, and the series cap and the cell budget bound the grid's
 * rows and cells, but none of them bounds the result as sent, because every row repeats every field
 * name. A vector's fields are the union of its series' label names, null where a series lacks one,
 * and a wide matrix's are its column names, each spelling the labels that tell its series apart. So
 * a small answer can shape into a very large result: 500 series with 25 label names of their own
 * are about 200 KB on the wire, and 500 rows of 12,502 fields here. The route serialises the result
 * whole, into one JSON text and then its UTF-8 bytes, in the one process every user shares.
 *
 * Set by measurement: tests/fixtures/prometheus/README.md, section "Measurements", entry M14,
 * records how. Answers shaped against it, four of them cut by it and M3's subquery over the compose
 * server's label sets beside them, go through the provider and out as the query route sends a
 * result, in the image's runtime under its heap flag and the chart's memory limit, and each has to
 * complete while the rest of the process holds three quarters of the heap. The bodies of responses
 * waiting to be sent are outside the budget, and nothing bounds how many wait (`docs/BACKLOG.md`
 * D112).
 */
export const RESULT_BYTE_BUDGET = 16 * 1024 * 1024;

export interface ShapeLimits {
  /**
   * Series kept from a vector or a matrix, in engine order: the provider passes DEFAULT_QUERY_LIMIT,
   * and the transport sends seriesLimit + 1 as `limit`.
   */
  readonly seriesLimit: number;
  /** The cells a wide matrix is held to, distinct instants times kept series: MATRIX_SAMPLE_BUDGET. */
  readonly sampleBudget: number;
  /** The UTF-8 bytes a vector's or a matrix's rows and fields are held to as JSON: RESULT_BYTE_BUDGET. */
  readonly byteBudget: number;
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

/** What JSON writes for a cell with no sample, and for a label a vector series lacks. */
const NULL_BYTES = jsonBytes(null);

/** How to see the series a vector bound cut, whose rows are its series. */
const NARROW_ADVICE = "Narrow the selector or aggregate the result to see the rest.";

/** How to see the series the byte budget cut from a matrix, whose rows are its instants. */
const SHRINK_ADVICE =
  "Narrow the selector, aggregate the result, or use a larger step or a shorter range to see the rest.";

/** One field of one row. */
type Cell = readonly [field: string, value: unknown];

/** What a shaper returns; shapeQueryResult puts the engine's notices in front of its cuts. */
interface Table {
  readonly rows: Record<string, unknown>[];
  readonly fields: string[];
  /** This provider's truncation notices: one per bound that cut, and one naming a series kept under `value`. */
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

/** The series the matrix byte budget kept, with the name each one's column is written under. */
interface Columns extends Kept {
  readonly columns: readonly string[];
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
 * notice for each bound that cut (5.4), and one naming a series a cut left alone when the byte budget
 * writes it under `value`. `wasLimited` is true exactly when such a notice is present.
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

/**
 * A vector: one row per series, its labels, then timestamp and value (5.3). The fields are the label
 * names of the series kept, so a series a bound cut adds none.
 */
function shapeVector(held: readonly PrometheusSeries[], context: ShapeContext): Table {
  const capped = capSeries(held, context);
  const { kept, cuts } = withinVectorBytes(capped.kept, context.limits.byteBudget);
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
  return { rows, fields: vectorFieldNames(labelNames), cuts: [...capped.cuts, ...cuts] };
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
  const budgeted = withinSampleBudget(capped.kept, context.limits.sampleBudget);
  const { kept, columns, cuts } = withinMatrixBytes(budgeted.kept, held, context.limits.byteBudget);
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
  return { rows, fields: [TIMESTAMP_FIELD, ...columns], cuts: [...capped.cuts, ...budgeted.cuts, ...cuts] };
}

/**
 * The column names of two or more kept series (5.3): the labels that tell the kept series apart, in
 * PromQL label notation (ColumnLabels says which do). Two kept series with one label set would share
 * a column, one overwriting the other, so that answer is refused. A series kept alone is named by
 * withinMatrixBytes, which prices the name it writes.
 */
function seriesColumns(kept: readonly PrometheusSeries[]): string[] {
  const distinguishing = ColumnLabels.of(kept).distinguishing();
  const columns = kept.map((series) => seriesNotation(series.labels, distinguishing));
  if (new Set(columns).size !== columns.length) {
    throw new PrometheusTransportError(
      "protocol",
      "The server answered a matrix holding two series with the same labels, so their columns could not be told apart.",
    );
  }
  return columns;
}

/**
 * The name of a series kept alone (5.3): `value` when the answer held no other, else the labels that
 * tell it from every series the answer held, because the rest were cut and it has no other to be
 * told from.
 */
function loneColumn(series: PrometheusSeries, held: readonly PrometheusSeries[]): string {
  return held.length === 1 ? VALUE_FIELD : seriesNotation(series.labels, ColumnLabels.of(held).distinguishing());
}

/**
 * The labels that tell a list of series apart, and the bytes their column names take as JSON keys,
 * kept up one series at a time (5.3).
 *
 * A label tells the series apart when its value differs among them or some of them lack it, and an
 * empty value reads as a lacking one, since seriesNotation writes both `name=""`. So the labels that
 * tell none apart are the ones every series so far carries with one value, a set that only shrinks:
 * adding a series costs its own labels and that set, never the union of every name.
 *
 * A column name is one matcher per telling label, joined by commas inside braces, and JSON writes it
 * as a key in quotes, escaping it again. Over the telling labels D, the names of n series therefore
 * take n * (3 + the sum over D of a comma and `name=""`) bytes, plus what each matcher a series
 * writes with its own value takes past `name=""`. nameBytes sums that over every carried label and
 * then takes the shared ones back out: a shared label adds n times a comma and its one matcher to
 * the sum, which is n times what the shared sum holds for it.
 */
class ColumnLabels {
  private series = 0;
  /** Every label some series carries, with the bytes its `name=""` takes in a key. */
  private readonly carried = new Map<string, number>();
  /** The labels every series so far carries, each with its one value. */
  private readonly shared = new Map<string, string>();
  /** The sum over carried labels of a comma and `name=""`. */
  private absentBytes = 0;
  /** The sum over shared labels of a comma and the matcher each writes. */
  private sharedBytes = 0;
  /** The sum over every series' carried labels of what its matcher takes past `name=""`. */
  private valueBytes = 0;

  static of(series: readonly PrometheusSeries[]): ColumnLabels {
    const labels = new ColumnLabels();
    for (const one of series) labels.add(one);
    return labels;
  }

  add(series: PrometheusSeries): void {
    const own = new Map(Object.entries(series.labels).filter(([, value]) => value !== ""));
    for (const [name, value] of own) {
      let absent = this.carried.get(name);
      if (absent === undefined) {
        absent = matcherBytes(name, "");
        this.carried.set(name, absent);
        this.absentBytes += 1 + absent;
      }
      const written = matcherBytes(name, value);
      this.valueBytes += written - absent;
      if (this.series === 0) {
        this.shared.set(name, value);
        this.sharedBytes += 1 + written;
      }
    }
    if (this.series > 0) {
      for (const [name, value] of this.shared) {
        if (own.get(name) === value) continue;
        this.shared.delete(name);
        this.sharedBytes -= 1 + matcherBytes(name, value);
      }
    }
    this.series += 1;
  }

  /** The labels that tell the series apart, in vector order. */
  distinguishing(): string[] {
    return vectorLabelOrder([...this.carried.keys()]).filter((name) => !this.shared.has(name));
  }

  /**
   * The bytes of every series' column name as a JSON key, quotes included, for two series or more
   * that some label tells apart; two that none does are refused as one column, and one series alone
   * is named by loneColumn.
   */
  nameBytes(): number {
    return this.series * (3 + this.absentBytes - this.sharedBytes) + this.valueBytes;
  }
}

/** The UTF-8 bytes of `value` written as JSON, as the route sends it. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** The bytes a matcher takes inside a column name written as a JSON key, its escapes included. */
function matcherBytes(name: string, value: string): number {
  return jsonBytes(labelMatcher(name, value)) - 2;
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
        message: `Showing the first ${formatCount(kept.length)} of ${total} series. ${NARROW_ADVICE}`,
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

/**
 * Whole series in engine order while a vector's rows and fields fit the byte budget as JSON (5.4),
 * with a notice naming what did not. Each row is `{"label":cell,...,"timestamp":time,"value":cell}`
 * and holds a field for every label name of the series kept, null where its own series lacks it, so
 * a new name costs a cell in every row as well as its place in the fields. The count is exact, and
 * no row is built for it. It stops at the first series that does not fit, as the cell budget does.
 */
function withinVectorBytes(series: readonly PrometheusSeries[], budget: number): Kept {
  const labelNames = new Set<string>();
  // The fields, ["label",...,"timestamp","value"].
  let fieldBytes = 2 + jsonBytes(TIMESTAMP_FIELD) + 1 + jsonBytes(VALUE_FIELD);
  // Per row: the braces, each label field's key, colon, comma and null, then the timestamp's and the value's.
  let rowBytes = 2 + jsonBytes(TIMESTAMP_FIELD) + 2 + jsonBytes(VALUE_FIELD) + 1;
  // Per series: what its own label cells take past the null, its time and its value.
  let ownBytes = 0;
  let count = 0;
  for (const one of series) {
    const point = onlyPoint(one);
    for (const [name, value] of Object.entries(one.labels)) {
      if (!labelNames.has(name)) {
        labelNames.add(name);
        const key = jsonBytes(labelField(name));
        fieldBytes += key + 1;
        rowBytes += key + 2 + NULL_BYTES;
      }
      ownBytes += jsonBytes(value) - NULL_BYTES;
    }
    ownBytes += jsonBytes(formatSampleTime(point.at)) + jsonBytes(point.cell);
    const rows = count + 1;
    // The rows are joined by commas inside brackets.
    if (fieldBytes + rows + 1 + rows * rowBytes + ownBytes > budget) break;
    count += 1;
  }
  return withinBytes(series, count, budget, NARROW_ADVICE);
}

/**
 * Whole series in engine order while the wide grid's rows and fields fit the byte budget as JSON
 * (5.4), with a notice naming what did not, and the name each kept series' column is written under,
 * which shapeMatrix writes as given, so what is counted is what is written. Each row is
 * `{"timestamp":time,"column":cell,...}` with a cell for every kept series, null where it has no
 * sample at that instant, so a column name is written once per instant and once more in the fields.
 * The count is exact, and it builds no row, nor any name but a lone series' (ColumnLabels, loneColumn).
 *
 * Two or more series are named by the labels that tell them apart, a set that only grows as series
 * are added, so their grid only grows too, and they are kept while they fit. A series kept alone is
 * named against the whole answer instead, which can cost more than two named among themselves, so a
 * first series that does not fit alone does not end the walk: it is priced alone only when no two
 * series fit, and is then kept under that name when it fits, else under `value` with one notice
 * writing its name once rather than in every row. No series is kept only when even `value` does not
 * fit.
 */
function withinMatrixBytes(
  series: readonly PrometheusSeries[],
  held: readonly PrometheusSeries[],
  budget: number,
): Columns {
  const labels = new ColumnLabels();
  const instants = new Set<number>();
  // Every row's time, and what every sample and histogram point takes past the null it replaces.
  let cellBytes = 0;
  // The rows and cell bytes of the first series alone, priced below once its name is known.
  let alone = { rows: 0, cellBytes: 0 };
  let count = 0;
  for (const [index, one] of series.entries()) {
    labels.add(one);
    for (const instant of instantsOf(one)) {
      if (instants.has(instant)) continue;
      instants.add(instant);
      cellBytes += jsonBytes(instantText(instant));
    }
    for (const sample of one.samples) cellBytes += jsonBytes(sampleCell(sample.value)) - NULL_BYTES;
    for (const point of one.histograms) cellBytes += jsonBytes(point.histogram) - NULL_BYTES;
    if (index === 0) {
      alone = { rows: instants.size, cellBytes };
      continue;
    }
    if (gridBytes(index + 1, labels.nameBytes(), instants.size, cellBytes) > budget) break;
    count = index + 1;
  }
  if (count > 1) {
    const within = withinBytes(series, count, budget, SHRINK_ADVICE);
    return { ...within, columns: seriesColumns(within.kept) };
  }
  const [first] = series;
  if (first === undefined) return { kept: series, columns: [], cuts: [] };
  const fits = (name: string): boolean => gridBytes(1, jsonBytes(name), alone.rows, alone.cellBytes) <= budget;
  const name = loneColumn(first, held);
  if (fits(name)) return { ...withinBytes(series, 1, budget, SHRINK_ADVICE), columns: [name] };
  if (!fits(VALUE_FIELD)) return { ...withinBytes(series, 0, budget, SHRINK_ADVICE), columns: [] };
  const within = withinBytes(series, 1, budget, SHRINK_ADVICE);
  return { kept: within.kept, columns: [VALUE_FIELD], cuts: [...within.cuts, namedOnce(name, budget)] };
}

/**
 * The UTF-8 bytes of a wide grid's rows and fields as JSON: `columns` columns whose names take
 * `nameBytes` as keys, over `rows` rows whose times and cells take `cellBytes` past the nulls.
 */
function gridBytes(columns: number, nameBytes: number, rows: number, cellBytes: number): number {
  // The fields, ["timestamp","column",...].
  const fieldBytes = 2 + jsonBytes(TIMESTAMP_FIELD) + columns + nameBytes;
  // Per row: the braces, the timestamp's key and colon, and each column's comma, key, colon and null.
  const rowBytes = 2 + jsonBytes(TIMESTAMP_FIELD) + 1 + columns * (2 + NULL_BYTES) + nameBytes;
  // The rows are joined by commas inside brackets, and a grid with no instant is `[]`.
  return fieldBytes + (rows === 0 ? 2 : rows + 1 + rows * rowBytes + cellBytes);
}

/**
 * The notice for a series kept alone under `value` because the name that tells it from the rest of
 * the answer, written in every row, would not fit the byte budget: the notice writes that name once.
 * Those bytes are outside the budget, paid once rather than once per row, and they grow with the
 * label names of the whole answer, not of the series kept.
 */
function namedOnce(name: string, budget: number): QueryWarning {
  return {
    message: `Showing the series ${name} in the column named ${VALUE_FIELD}, because a result is held to ${formatCount(budget)} bytes and that name, written in every row, would not fit.`,
  };
}

/** The first `count` series, with the byte budget's notice when that is not all of them. */
function withinBytes(series: readonly PrometheusSeries[], count: number, budget: number, advice: string): Kept {
  if (count === series.length) return { kept: series, cuts: [] };
  return {
    kept: series.slice(0, count),
    cuts: [
      {
        message: `Showing ${formatCount(count)} of ${formatCount(series.length)} series, because a result is held to ${formatCount(budget)} bytes. ${advice}`,
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
