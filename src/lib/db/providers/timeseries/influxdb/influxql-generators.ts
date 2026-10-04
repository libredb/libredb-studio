/**
 * InfluxQL generators (SPEC 6.6, I20, E6).
 *
 * Pure, and shipped to the browser. A tree click on a measurement writes a time-windowed, newest-first
 * preview, and Generate Query writes the same read followed by example lines as comments. Every name
 * goes through `influxql-quote.ts`, so the whole text, comment lines included, passes `evaluateInfluxql`
 * as one read that names only the clicked database; the provider runs its policy on this text as on any
 * other (no trusted internal path, C6).
 *
 * The `LIMIT` is written in the text because the `influxdb` type declares no external limiting, and an
 * InfluxQL `LIMIT` acts per series, which the first comment line says. That line is also the empty-preview
 * explanation: no provider-side label exists (R26).
 */
import type { ColumnSchema } from "@/lib/types";
import { influxqlSource, quoteInfluxqlIdentifier } from "./influxql-quote";

/** Held equal to `PREVIEW_PAGE_SIZE` (`src/hooks/use-tab-manager.ts`) by a test. */
export const INFLUXQL_PREVIEW_LIMIT = 50;

/**
 * The preview window (K1, measured on 3.12.0 Core 2026-10-04): one hour answers on the default file limit
 * over 25 h of data, and on the `--query-file-limit 1` fixture over 80 h of data it answers with no row where
 * any wider window reaching a persisted file meets the file-limit error. Not measured: one hour over more than
 * 72 h of data at the default file limit.
 */
export const INFLUXQL_PREVIEW_WINDOW = "1h";

/** The field types an aggregate example can average; `SHOW FIELD KEYS` spells them so. */
const NUMERIC_FIELD_TYPES: ReadonlySet<string> = new Set(["float", "integer"]);

function sourceOf(path: readonly string[]): { database: string; measurement: string } {
  if (path.length !== 2) {
    throw new RangeError(`An InfluxQL preview path is [database, measurement]; received ${path.length} segment(s)`);
  }
  return { database: path[0], measurement: path[1] };
}

function previewText(database: string, measurement: string): string {
  return (
    `-- Newest points of the last hour, LIMIT ${INFLUXQL_PREVIEW_LIMIT} per series. No row means no point is newer: widen ${INFLUXQL_PREVIEW_WINDOW} below.\n` +
    `SELECT * FROM ${influxqlSource(database, measurement)} WHERE time > now() - ${INFLUXQL_PREVIEW_WINDOW} ORDER BY time DESC LIMIT ${INFLUXQL_PREVIEW_LIMIT}`
  );
}

/** path = [database, measurement]; the SPEC 6.6 preview. */
export function influxqlTableQuery(path: readonly string[]): string {
  const { database, measurement } = sourceOf(path);
  return previewText(database, measurement);
}

/**
 * path = [database, measurement]; columns from `describeObject` (type "tag", "time" or a field type). The
 * examples name the first float or integer field and the first tag, else `"value"` and `"tag"`.
 */
export function influxqlSelectQuery(path: readonly string[], columns: readonly ColumnSchema[]): string {
  const { database, measurement } = sourceOf(path);
  const source = influxqlSource(database, measurement);
  const field = quoteInfluxqlIdentifier(
    columns.find((column) => NUMERIC_FIELD_TYPES.has(column.type))?.name ?? "value",
  );
  const tag = quoteInfluxqlIdentifier(columns.find((column) => column.type === "tag")?.name ?? "tag");
  const quotedDatabase = quoteInfluxqlIdentifier(database);
  const quotedMeasurement = quoteInfluxqlIdentifier(measurement);
  return [
    previewText(database, measurement),
    "-- A wider window: WHERE time > now() - 1d",
    `-- One point per minute: SELECT mean(${field}) FROM ${source} WHERE time > now() - ${INFLUXQL_PREVIEW_WINDOW} GROUP BY time(1m)`,
    `-- Another retention policy: SELECT * FROM ${quotedDatabase}."<rp>".${quotedMeasurement} (SHOW RETENTION POLICIES ON ${quotedDatabase} lists them)`,
    // K16: 3.12.0 Core answers SHOW TAG VALUES over a default time window, so a tag of older data needs the clause.
    `-- Tag values: SHOW TAG VALUES ON ${quotedDatabase} FROM ${quotedMeasurement} WITH KEY = ${tag} (on InfluxDB 3 add WHERE time > 0)`,
    "-- For the Charts tab: ORDER BY time ASC, and choose time as the x axis.",
  ].join("\n");
}
