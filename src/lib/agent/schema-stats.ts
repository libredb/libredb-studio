/**
 * The run's ESTIMATED statistics, and the text that says honestly what they are
 * (plan-mode grounding design, 2026-08-15, work item 2).
 *
 * A plan run that knows a schema still cannot tell a six-row table from a six-million
 * row one, and the shape of a statement — which table to drive from, whether a join
 * needs an index, whether a `GROUP BY` is answerable at all — turns on exactly that.
 * The honest way to obtain it is NOT to count: `COUNT(DISTINCT col)` per column is a
 * full scan, and this mode's whole selling point is that it can be pointed at
 * production. Both served engines already hold the numbers, so this module reads
 * what they hold and refuses to improve on it.
 *
 * It is its own module rather than part of `context-snapshot.ts` for a reason that is
 * structural rather than tidiness: **statistics are not schema.**
 *
 *  - The snapshot's fingerprint is "everything a reader would call the schema and
 *    nothing else", and it is what makes a recorded inventory reusable. Folding an
 *    estimate into it would change the identity of a schema nobody changed, every
 *    time an `ANALYZE` ran, and a resumed run would re-read a catalog for nothing.
 *  - The snapshot is ALL-OR-NOTHING, because a half inventory that claims to be whole
 *    is worse than none. Statistics are the opposite: absence is the normal case
 *    (nobody has analysed that table yet), it is per-table, and it must be REPORTED
 *    rather than allowed to lose the inventory that was read successfully.
 *
 * Three honesty rules are enforced here and asserted in the tests, because the
 * standing defect class in this repository is claiming a precision you do not have:
 *
 *  1. Every number that reaches a model is labelled an estimate, and the two ways
 *     PostgreSQL spells "I do not know" — `reltuples` of -1 (never counted, PG14+)
 *     and `n_distinct` of 0 — become ABSENCE here rather than a number.
 *  2. A `n_distinct` ratio (negative, a fraction of the row count) is converted only
 *     where there is a row estimate to convert it against, and the result is labelled
 *     derived. Where there is not, it stays a ratio.
 *  3. A table with no statistics is LISTED as having none. Never omitted, never
 *     defaulted to zero: a model shown silence reads it as an empty table, which is
 *     the one wrong conclusion this whole block exists to prevent.
 *
 * The reads themselves are the server's own grounding calls through `tools.ts` — the
 * same audited, read-only, budgeted, policy-gated path as every catalog read. There
 * is no second path to an engine here.
 */

import { AgentComposedSqlError, type AgentCatalogSelector, composeStatisticsAvailabilityProbe } from "./composed-sql";
import { type AgentToolContext, readCatalogForGrounding, readStatementForGrounding } from "./tools";
import { fenceUntrustedContent } from "./untrusted-content";
import type { DatabaseType, TableSchema } from "@/lib/types";

/** Why a run has no statistics. All four are states the run continues from. */
export type AgentStatisticsUnavailableCode =
  /**
   * No verified statistics composition for this engine. The run has no size estimates
   * here; it may still be grounded in a schema — since #414 that is the ORDINARY case
   * on the twelve type-ids whose inventory comes from their own provider, where
   * `schemaKnown` is true and `statisticsShown` is false.
   */
  | "DIALECT_HAS_NO_STATISTICS"
  /** The engine holds no statistics at all yet: SQLite before its first `ANALYZE`. */
  | "STATISTICS_NEVER_COLLECTED"
  /** A read did not complete: refused, denied, out of budget, or a database error. */
  | "STATISTICS_READ_REFUSED"
  /** The read completed but its rows are no longer in the run's artifact store. */
  | "STATISTICS_RESULT_UNAVAILABLE";

/** One column's distribution, exactly as the engine reported it. Nothing is derived here. */
export interface AgentColumnEstimate {
  readonly column: string;
  /**
   * The engine's `n_distinct`. POSITIVE is a count of distinct values; NEGATIVE is a
   * ratio of the row count, which is PostgreSQL's way of describing a column whose
   * distinctness scales with the table. `null` is no estimate at all — including
   * PostgreSQL's literal 0, which means "unknown" and not "no distinct values".
   */
  readonly distinct: number | null;
  /** Fraction of rows that are NULL, 0..1, or `null` where the engine holds none. */
  readonly nullFraction: number | null;
}

export interface AgentTableEstimate {
  /** The engine's row estimate, or `null` where it has never counted this table. */
  readonly estimatedRows: number | null;
  /** Empty where the engine holds no per-column distribution — which is all of SQLite. */
  readonly columns: readonly AgentColumnEstimate[];
}

export type AgentSchemaStatistics =
  | {
      readonly kind: "read";
      readonly dialect: DatabaseType;
      /** Keyed by the same qualified name the inventory uses, so the two join. */
      readonly byTable: ReadonlyMap<string, AgentTableEstimate>;
    }
  | { readonly kind: "unavailable"; readonly reasonCode: AgentStatisticsUnavailableCode };

// ============================================================================
// Reading
// ============================================================================

const unavailable = (reasonCode: AgentStatisticsUnavailableCode): AgentSchemaStatistics => ({
  kind: "unavailable",
  reasonCode,
});

/**
 * A number an engine reported, or `null` when it reported nothing readable.
 *
 * Drivers disagree about the JavaScript type of a numeric column — `pg` returns
 * `numeric` as a string — so the text form is accepted, and anything that does not
 * read as a finite number becomes absence rather than a `NaN` that would later print
 * as a row count.
 */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);

/**
 * PostgreSQL's rows: one per (table, analysed column), and one per table with every
 * statistics column NULL where `pg_stats` has nothing — which the composed read's
 * LEFT JOIN guarantees, so a never-analysed table arrives rather than disappearing.
 *
 * `reltuples` of -1 is PostgreSQL 14+ saying the table has never been vacuumed or
 * analysed. It is read as absence. Older servers left 0 there instead, which is
 * indistinguishable from a genuinely empty table, and this code does not pretend to
 * tell those apart — an empty table and an uncounted one both come out as "roughly
 * 0 rows, estimated" on a server old enough to do that.
 */
function buildPostgresEstimates(rows: readonly Record<string, unknown>[]): Map<string, AgentTableEstimate> {
  const byTable = new Map<string, { estimatedRows: number | null; columns: AgentColumnEstimate[] }>();

  for (const row of rows) {
    const name = `${text(row.table_schema)}.${text(row.table_name)}`;
    const rawRows = numeric(row.estimated_rows);
    const entry = byTable.get(name) ?? { estimatedRows: rawRows === -1 ? null : rawRows, columns: [] };
    byTable.set(name, entry);

    const column = text(row.column_name);
    if (column === "") continue;
    const distinct = numeric(row.n_distinct);
    entry.columns.push({
      column,
      // 0 is PostgreSQL's "no estimate", not "no distinct values".
      distinct: distinct === 0 ? null : distinct,
      nullFraction: numeric(row.null_frac),
    });
  }

  return byTable;
}

/**
 * SQLite's rows: one per (table, index) from `sqlite_stat1`, plus one per table with
 * a NULL `stat` where the table has no analysed index at all.
 *
 * `stat`'s first field is the table's row count as of the last `ANALYZE`; the fields
 * after it are average rows per equal index prefix. Only the first is read. The
 * others describe an INDEX PREFIX rather than a column, so turning them into
 * per-column distinct counts would mean naming the index's leading column and
 * presenting a derived number where the engine reported an average — and this engine
 * holds NO null fraction at all, so the column half of the picture would still be
 * missing. The packing says that limit plainly instead of half-filling it.
 */
function buildSqliteEstimates(rows: readonly Record<string, unknown>[]): Map<string, AgentTableEstimate> {
  const byTable = new Map<string, AgentTableEstimate>();

  for (const row of rows) {
    const name = text(row.table_name);
    const estimatedRows = numeric(text(row.stat).split(" ")[0]);
    const held = byTable.get(name);
    // The first index that carries an estimate wins; a later NULL `stat` never
    // overwrites a reading with an absence.
    if (held !== undefined && held.estimatedRows !== null) continue;
    byTable.set(name, { estimatedRows, columns: [] });
  }

  return byTable;
}

const ESTIMATE_BUILDERS: Partial<
  Record<DatabaseType, (rows: readonly Record<string, unknown>[]) => Map<string, AgentTableEstimate>>
> = {
  postgres: buildPostgresEstimates,
  sqlite: buildSqliteEstimates,
};

/**
 * Reads what this engine estimates about its own tables, through the audited path.
 *
 * The SQLite probe is not optional and is not decoration: `sqlite_stat1` does not
 * exist until an explicit `ANALYZE` has run, and SQLite resolves table names when it
 * PREPARES a statement, so the statistics read fails outright on a database nobody
 * has analysed. That failure is a fact about the database, not about the run, and
 * running the probe first is what lets it be reported as "no statistics" instead of
 * as a database error the model would try to repair.
 *
 * The cost is therefore ONE statement on PostgreSQL and TWO on SQLite, out of the
 * same per-run statement budget every other read is drawn from.
 */
export async function readSchemaStatistics(context: AgentToolContext): Promise<AgentSchemaStatistics> {
  const dialect = context.connection.type;
  const build = ESTIMATE_BUILDERS[dialect];

  let probe: string | null;
  try {
    probe = composeStatisticsAvailabilityProbe(dialect);
  } catch (error) {
    // The composer owns the served-dialect decision, and an unserved one throws
    // rather than being answered `null`. Anything else is a defect, not a dialect.
    if (error instanceof AgentComposedSqlError) return unavailable("DIALECT_HAS_NO_STATISTICS");
    throw error;
  }
  // A dialect the composer serves but this module cannot read back yields nothing,
  // which is the safe direction — the same asymmetry `context-snapshot.ts` records
  // between composing a statement and building an inventory from its rows.
  if (build === undefined) return unavailable("DIALECT_HAS_NO_STATISTICS");

  const nowMs = context.clock?.() ?? Date.now();

  if (probe !== null) {
    const outcome = await readStatementForGrounding(context, { sql: probe, label: "statistics availability" });
    if (outcome.kind !== "completed") return unavailable("STATISTICS_READ_REFUSED");
    const artifact = context.artifacts.get(outcome.artifact.correlationId, nowMs);
    if (artifact === undefined) return unavailable("STATISTICS_RESULT_UNAVAILABLE");
    if (artifact.value.rows.length === 0) return unavailable("STATISTICS_NEVER_COLLECTED");
  }

  const selector: AgentCatalogSelector = { kind: "statistics" };
  const outcome = await readCatalogForGrounding(context, selector);
  if (outcome.kind !== "completed") return unavailable("STATISTICS_READ_REFUSED");
  const artifact = context.artifacts.get(outcome.artifact.correlationId, nowMs);
  if (artifact === undefined) return unavailable("STATISTICS_RESULT_UNAVAILABLE");

  return { kind: "read", dialect, byTable: build(artifact.value.rows) };
}

// ============================================================================
// Packing
// ============================================================================

/**
 * The bound on one packed statistics block, in characters.
 *
 * Half of the inventory's own bound, and deliberately so: the schema is what a
 * statement is written against, and the estimates only decide its shape. A database
 * whose statistics would not fit says how many tables it left out rather than
 * spending the window that the schema needs.
 */
export const AGENT_STATISTICS_PACK_MAX_CHARS = 3_000;

/** Per table, so one wide table cannot spend the whole block on itself. */
const MAX_COLUMNS_PER_TABLE = 8;

/**
 * What the server says about the numbers, ahead of the fence.
 *
 * Outside the fenced region because it is the SERVER speaking: the fence marks where
 * the server stopped talking and database content began, so the sentence that tells
 * the model how to read the content cannot sit inside it.
 *
 * Every clause is load-bearing and each answers a way a model has been observed to
 * over-read a number: that these are estimates, that they go stale, and — the one the
 * design is emphatic about — that a table listed with no statistics is a table of
 * UNKNOWN size and not an empty one.
 */
const STATISTICS_PREFACE = [
  "Estimated table statistics follow, read from this engine's own catalog while this run established its context. No table was scanned and no value was read out of any column.",
  "Every number below is the ENGINE'S OWN ESTIMATE, never an exact count: it was written when the table was last analysed, so it can be badly out of date, and it is missing entirely for a table that has never been analysed.",
  "A table listed below as having no statistics is a table whose size is UNKNOWN to you — it is not an empty table, and nothing here entitles you to call it small.",
].join(" ");

/** SQLite's absolute limit, said once rather than implied by a gap per column. */
const SQLITE_STATISTICS_LIMIT =
  "This engine records no per-column distinct count or null fraction at all, so none is shown for any column here, and none can be obtained without reading the data.";

const UNAVAILABLE_REASON: Readonly<Record<AgentStatisticsUnavailableCode, string>> = Object.freeze({
  DIALECT_HAS_NO_STATISTICS: "this engine does not hold statistics this run knows how to read",
  STATISTICS_NEVER_COLLECTED: "this database has never been analysed, so the engine holds no statistics at all",
  STATISTICS_READ_REFUSED: "the statistics read did not complete",
  STATISTICS_RESULT_UNAVAILABLE: "the statistics were read but this run no longer holds their rows",
});

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/**
 * One column's line. A NEGATIVE `n_distinct` is a ratio of the row count, and it is
 * converted only where there IS a row estimate to convert against — the result is
 * marked "derived" so the model can tell it from a number the engine stated, and
 * where there is no row estimate the ratio is reported as a ratio rather than turned
 * into a count nobody has.
 */
function renderColumn(estimate: AgentColumnEstimate, estimatedRows: number | null): string | null {
  const parts: string[] = [];
  const { distinct } = estimate;
  if (distinct !== null && distinct > 0) parts.push(`about ${Math.round(distinct)} distinct value(s), estimated`);
  else if (distinct !== null && distinct < 0 && estimatedRows !== null) {
    parts.push(`about ${Math.round(-distinct * estimatedRows)} distinct value(s), derived from the engine's ratio`);
  } else if (distinct !== null && distinct < 0) {
    parts.push(`about ${percent(-distinct)} of the row count distinct, which this engine has not estimated`);
  }
  if (estimate.nullFraction !== null) parts.push(`${percent(estimate.nullFraction)} null, estimated`);
  return parts.length === 0 ? null : `${estimate.column}: ${parts.join(", ")}`;
}

/**
 * How much of one table's estimates is rendered.
 *
 * `rows` exists for the `operations` workflow (#411), whose whole context is table
 * names and index names — it is told in the server's own voice that it has been shown
 * no columns, and a per-column distinct count in the block beside that sentence would
 * make the sentence false and would leak a column name out of a run whose documented
 * egress is identifiers of two kinds. What that workflow needs from the statistics is
 * the one thing `rows` keeps: which table is big enough to be worth a reading. Every
 * other workflow drafts a statement, and the shape of a statement is what a
 * distribution decides, so `rows-and-columns` stays the default.
 */
export type AgentStatisticsDetail = "rows-and-columns" | "rows";

/** One table's line, including the line that says it has no statistics. */
function renderTable(name: string, estimate: AgentTableEstimate | undefined, detail: AgentStatisticsDetail): string {
  if (estimate === undefined) return `${name}: no statistics recorded for this table; its size is unknown`;

  const columns: string[] = [];
  for (const column of detail === "rows" ? [] : estimate.columns.slice(0, MAX_COLUMNS_PER_TABLE)) {
    const rendered = renderColumn(column, estimate.estimatedRows);
    if (rendered !== null) columns.push(rendered);
  }
  // Not even the count of what was withheld, under `rows`: "+3 more column(s)" is a
  // statement about columns, and that rendering exists so a run told it has been shown
  // none is not shown one.
  const hidden =
    detail === "rows" ? 0 : estimate.columns.length - Math.min(estimate.columns.length, MAX_COLUMNS_PER_TABLE);
  if (hidden > 0) columns.push(`+${hidden} more column(s) with statistics not shown`);

  const rows =
    estimate.estimatedRows === null
      ? "no row estimate recorded; its size is unknown"
      : `roughly ${Math.round(estimate.estimatedRows)} row(s), estimated`;
  return columns.length === 0 ? `${name}: ${rows}` : `${name}: ${rows}; ${columns.join("; ")}`;
}

/**
 * The statistics, against the inventory they describe, as text for a prompt.
 *
 * Driven from the INVENTORY's table list rather than from the reading's keys, which
 * is what makes absence expressible at all: a table the engine holds nothing for gets
 * its own line saying so. A reading keyed on a table the inventory does not carry is
 * dropped — it is a table the model was never shown and cannot write about.
 *
 * Bounded by construction like `packContextForTask`: lines are added while the FENCED
 * result still fits, and what does not fit is NAMED as omitted rather than silently
 * dropped, so a model told nothing about 30 tables asks rather than assumes.
 *
 * `detail` is which of two readers is being written for, and `AgentStatisticsDetail`
 * says why there are two. It governs the unavailable sentence as well as the rendered
 * lines: a workflow that writes no statement must not be told what not to rest a
 * statement on, because a rule about an artifact the run cannot produce is a rule it
 * has to guess at (#350).
 */
export function packSchemaStatistics(
  tables: readonly TableSchema[],
  statistics: AgentSchemaStatistics,
  options: { readonly maxChars?: number; readonly detail?: AgentStatisticsDetail } = {},
): string {
  const detail = options.detail ?? "rows-and-columns";
  if (statistics.kind === "unavailable") {
    return [
      `No estimated table statistics are available to this run: ${UNAVAILABLE_REASON[statistics.reasonCode]}.`,
      detail === "rows"
        ? "So treat every table's size as unknown rather than as small, and rest nothing on how large a table is."
        : "So treat every table's size as unknown rather than as small, and do not write a statement whose correctness depends on how large a table is.",
    ].join("\n");
  }
  if (tables.length === 0) {
    return "Estimated table statistics were read for this run, but its inventory carries no tables, so there is nothing to report them against.";
  }

  // SQLite's per-column gap is not worth stating to a reader that is being shown no
  // column either way: it would be the only sentence about columns in a context whose
  // point is that it carries none.
  const dialectNote = statistics.dialect === "sqlite" && detail !== "rows" ? ` ${SQLITE_STATISTICS_LIMIT}` : "";
  const lead = `${STATISTICS_PREFACE}${dialectNote}\n`;
  const maxChars = (options.maxChars ?? AGENT_STATISTICS_PACK_MAX_CHARS) - lead.length;
  const source = {
    label: "estimated table statistics",
    operationId: "agent/schema-stats",
    reference: `${statistics.dialect} engine estimates`,
  };

  const close = (body: string, omitted: number): string =>
    omitted === 0 ? body : `${body}\n${omitted} further table(s) omitted; nothing here says anything about them.`;

  let body = "";
  let shown = 0;
  for (const table of tables) {
    const line = renderTable(table.name, statistics.byTable.get(table.name), detail);
    const candidate = body === "" ? line : `${body}\n${line}`;
    if (fenceUntrustedContent(close(candidate, tables.length - shown - 1), source).length > maxChars) break;
    body = candidate;
    shown += 1;
  }

  return `${lead}${fenceUntrustedContent(close(body, tables.length - shown), source)}`;
}
