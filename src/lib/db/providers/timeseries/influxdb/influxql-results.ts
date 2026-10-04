/**
 * A `/query` answer as a result (InfluxDB spec 3.4, 5.1 steps 10 and 11, 5.3 C5; E5).
 *
 * Every `/query` is sent chunked (I9), so a 200 body is one or more JSON documents: newline-separated on 1.x and
 * 2.x, back to back with no separator on 3.x, and a series cut by `chunk_size` continues in the next document with
 * `partial: true` on the series and its result (K5, the `group-by-room-partial` captures). 3.12.0 answers a chunked
 * read that matches nothing with zero bytes, which is an empty result.
 *
 * `shapeInfluxqlBody` reads the whole body in one order, each step over every document before the next:
 *
 * 1. split the documents, string-aware, in one linear pass;
 * 2. `quoteUnsafeIntegers` over each document, then `JSON.parse`, so an int64 or uint64 beyond 2^53 reaches the
 *    grid as its exact digits; a top-level `{"error"}` (an infinity on 1.x and 3.x, R33) is the server's error;
 * 3. C5: every document holds exactly one result, `statement_id` 0, and every document but the first follows a
 *    `partial: true` result. Anything else means the server ran a statement the policy did not see, which is
 *    reported and never shown as rows, even when an earlier result carries an error (3.12.0 answers a hidden
 *    statement as `statement_id` 1 after the first one's error, 2.9.1 as a second `statement_id` 0 document);
 * 4. a result's own `error` is the server's refusal, never an empty result;
 * 5. the series flatten into one grid and the row cut and cell budget apply, after the whole body is in.
 *
 * What the server sent wrong is an `InfluxAnswerShapeError`; errors.ts words it. No sentence is written here, and
 * no pattern reads the server's text (R40): the split is a character scan and the rest reads parsed values.
 */
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { QueryWarning } from "@/lib/types";
import { INFLUX_ERROR_SENTENCES, InfluxAnswerShapeError } from "./errors";

export interface InfluxShapeLimits {
  /** `INFLUX_ROW_CUT`. */
  readonly rowCut: number;
  /** `INFLUX_CELL_BUDGET`: rows times columns. */
  readonly cellBudget: number;
}

export interface ShapedResult {
  readonly fields: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  /** Either bound dropped rows; the provider reports it on `pagination.wasLimited`. */
  readonly cut: boolean;
  /** Engine notices only (R26): the server's `messages` and the last document's `partial` marker. */
  readonly warnings: readonly QueryWarning[];
}

/** The leading column of a result that spans more than one series name, and its name when a column claims that one. */
const MEASUREMENT_COLUMN = "measurement";
const MEASUREMENT_COLUMN_RENAMED = "measurement (series)";

const JSON_WHITESPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

function notJson(): InfluxAnswerShapeError {
  return new InfluxAnswerShapeError("not-json");
}

/**
 * Splits a `/query` body into its JSON documents: newline-separated (1.x, 2.x) or back to back (3.x). String-aware:
 * a brace inside a string does not end a document. Text between documents that is not whitespace, and a document
 * that never closes, are refused as not JSON; whether a document is valid JSON is `JSON.parse`'s to say.
 */
export function splitJsonDocuments(text: string): readonly string[] {
  const documents: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (depth === 0) {
      if (character === "{") {
        depth = 1;
        start = index;
      } else if (!JSON_WHITESPACE.has(character)) {
        throw notJson();
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) documents.push(text.slice(start, index + 1));
    }
  }
  if (depth !== 0) throw notJson();
  return documents;
}

interface Series {
  readonly name: string | undefined;
  readonly tags: Readonly<Record<string, string>>;
  readonly columns: readonly string[];
  readonly values: readonly (readonly unknown[])[];
}

interface Result {
  readonly statementId: unknown;
  readonly error: string | undefined;
  readonly series: readonly Series[];
  readonly messages: readonly string[];
  readonly partial: boolean;
}

/** A parsed document: the server's top-level error, or its results. */
type Document = { readonly error: string } | { readonly results: readonly Result[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** `value` as `T` when `accept` holds, `fallback` when it is absent; anything else is not an answer of `/query`. */
function optional<T>(value: unknown, accept: (value: unknown) => value is T, fallback: T): T {
  if (value === undefined) return fallback;
  if (!accept(value)) throw notJson();
  return value;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isRows = (value: unknown): value is readonly (readonly unknown[])[] => isArray(value) && value.every(isArray);
const isTags = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every(isString);

function readSeries(value: unknown): Series {
  if (!isRecord(value) || !isStringArray(value.columns)) throw notJson();
  return {
    name: optional(value.name, isString, undefined),
    tags: optional(value.tags, isTags, {}),
    columns: value.columns,
    values: optional(value.values, isRows, []),
  };
}

function readMessage(value: unknown): string {
  if (!isRecord(value) || typeof value.text !== "string") throw notJson();
  return value.text;
}

function readResult(value: unknown): Result {
  if (!isRecord(value)) throw notJson();
  return {
    statementId: value.statement_id,
    error: optional(value.error, isString, undefined),
    series: optional(value.series, isArray, []).map(readSeries),
    messages: optional(value.messages, isArray, []).map(readMessage),
    partial: value.partial === true,
  };
}

function readDocument(text: string): Document {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteUnsafeIntegers(text));
  } catch {
    throw notJson();
  }
  if (!isRecord(parsed)) throw notJson();
  if (typeof parsed.error === "string") return { error: parsed.error };
  if (!Array.isArray(parsed.results)) throw notJson();
  return { results: parsed.results.map(readResult) };
}

/**
 * The one result of every document, after C5; a top-level error is raised first. A document continues the
 * statement before it only when that statement's result was `partial: true` (K5); after a complete result, another
 * document is another statement, even when it says `statement_id` 0 as 2.9.1 frames the hidden one.
 */
function statementResults(documents: readonly Document[]): readonly Result[] {
  const results: (readonly Result[])[] = [];
  for (const document of documents) {
    if ("error" in document) throw new InfluxAnswerShapeError("top-level-error", document.error);
    results.push(document.results);
  }
  const shapeHolds = results.every(
    (entries, index) =>
      entries.length === 1 && entries[0].statementId === 0 && (index === 0 || results[index - 1][0].partial),
  );
  if (!shapeHolds) throw new InfluxAnswerShapeError("lexer-disagreement");
  const statements = results.map((entries) => entries[0]);
  const failed = statements.find((result) => result.error !== undefined);
  if (failed !== undefined) throw new InfluxAnswerShapeError("statement-error", failed.error);
  return statements;
}

/**
 * The grid's columns: a measurement column when the series span more than one name, the `GROUP BY` tag keys in
 * first-seen order, then the union of the series' columns in first-seen order. A `Set` keeps insertion order, so a
 * column named like an array index stays where it was first seen.
 */
function gridColumns(series: readonly Series[]): { readonly fields: readonly string[]; readonly lead?: string } {
  const tags = new Set(series.flatMap((entry) => Object.keys(entry.tags)));
  const columns = new Set(series.flatMap((entry) => entry.columns));
  const names = new Set(series.map((entry) => entry.name));
  if (names.size <= 1) return { fields: [...new Set([...tags, ...columns])] };
  const lead =
    tags.has(MEASUREMENT_COLUMN) || columns.has(MEASUREMENT_COLUMN) ? MEASUREMENT_COLUMN_RENAMED : MEASUREMENT_COLUMN;
  return { fields: [...new Set([lead, ...tags, ...columns])], lead };
}

/** One row, built from entries so a column named `__proto__` is an own property like any other. */
function gridRow(
  fields: readonly string[],
  series: Series,
  values: readonly unknown[],
  lead?: string,
): Record<string, unknown> {
  const cells = new Map<string, unknown>(fields.map((field) => [field, null]));
  if (lead !== undefined) cells.set(lead, series.name ?? null);
  for (const [key, value] of Object.entries(series.tags)) cells.set(key, value);
  series.columns.forEach((column, index) => {
    cells.set(column, values[index] ?? null);
  });
  return Object.fromEntries(cells);
}

/** The server's notices, once each in first-seen order, then the partial marker of the last document. */
function engineWarnings(statements: readonly Result[]): readonly QueryWarning[] {
  const messages = [...new Set(statements.flatMap((result) => result.messages))];
  const warnings: QueryWarning[] = messages.map((message) => ({ message }));
  if (statements.at(-1)?.partial === true) warnings.push({ message: INFLUX_ERROR_SENTENCES.partial as string });
  return warnings;
}

/** A `/query` 200 body as one grid (spec 5.1 step 10). Throws `InfluxAnswerShapeError`. */
export function shapeInfluxqlBody(text: string, limits: InfluxShapeLimits): ShapedResult {
  const statements = statementResults(splitJsonDocuments(text).map(readDocument));
  const series = statements.flatMap((result) => result.series);
  const { fields, lead } = gridColumns(series);
  const kept = Math.min(limits.rowCut, Math.floor(limits.cellBudget / Math.max(fields.length, 1)));
  const rows: Record<string, unknown>[] = [];
  let total = 0;
  for (const entry of series) {
    for (const values of entry.values) {
      total += 1;
      if (rows.length < kept) rows.push(gridRow(fields, entry, values, lead));
    }
  }
  return { fields, rows, cut: total > kept, warnings: engineWarnings(statements) };
}
