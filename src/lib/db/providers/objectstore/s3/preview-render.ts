/**
 * The S3 preview's words and its two outward shapes. Browser-safe: it imports
 * only the provider's browser-safe modules, the shared console modules, the engine-neutral shared modules and types.
 * Every preview sentence is one literal here; the console's `--max-rows` refusal imports it.
 */
import { quoteShellWord } from "@/lib/db/console/shell-words";
import { applySourceBound, SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import type { ObjectSourcePart } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { S3_PREVIEW_LIMITS, S3_SHOWN_NAME_CHARS } from "./constants";
import type { ParquetSummary, S3Preview, S3PreviewCell, S3PreviewRows } from "./preview";
import { hexDump, hexRows, textLines } from "./preview-text";

/** Every notice and refusal of the preview, by id; placeholders are filled by `previewSentence`. */
export const S3_PREVIEW_SENTENCES = Object.freeze({
  "N-CUT": "The preview shows the first {shown} bytes of {size} bytes.",
  "N-NOT-UTF8": "The object is not UTF-8 text, so it is shown as hex.",
  "N-BLANK": "The object holds only blank characters, so it is shown as hex.",
  "N-JSON-INVALID": "The object is not valid JSON, so it is shown as text.",
  "N-JSON-CUT":
    "The JSON document is larger than the {n} bytes a preview reads, so it is shown as text and not parsed.",
  "N-LINE-CUT": "The last line was cut by the {n}-byte read and is not shown.",
  "N-NDJSON-BAD": "{k} line(s) are not JSON and are shown as text in column {col}.",
  "N-RECORD-CUT": "The last record was cut by the {n}-byte read and is not shown.",
  "N-CSV-QUOTE": "{k} field(s) have characters after their closing quote; they are shown as read.",
  "N-CSV-UNCLOSED": "The last record has a quote that is never closed; it is shown up to the end of the object.",
  "N-CSV-RAGGED":
    "{k} record(s) have a different number of fields from the header: missing fields are empty and extra fields are shown in columns named by position.",
  "N-ROWS": "The preview stops at {cap} rows.",
  "N-OUTPUT": "The preview stopped after {r} rows, at {cap} characters of cell text.",
  "N-CELLS": "{k} cell(s) were cut at {cap} characters.",
  "N-COLUMNS": "Showing the first {cap} of {n} columns.",
  "N-GZIP-EMPTY": "The object is gzip-compressed and its decoded content is empty.",
  "N-GZIP":
    "The object is gzip-compressed; the preview shows the first {d} bytes of its decoded content, from the first {f} stored bytes.",
  "N-GZIP-BAD": "The object is marked as gzip but its bytes are not gzip data, so its stored bytes are shown as hex.",
  "N-GZIP-NESTED": "The decoded content is itself gzip data; the preview decodes one layer, so it is shown as hex.",
  "N-ENC-OTHER":
    "The object is stored with Content-Encoding {coding}, which the preview does not decode, so its stored bytes are shown as hex.",
  "N-PQ-MAGIC":
    "The object does not end with the Parquet marker PAR1, so it is not a Parquet file; it is shown as hex.",
  "N-PQ-SOME-COLUMNS":
    "Showing {k} of {n} columns: the next column would take the first row group's read past {fetchBudget} MiB, its decoded size past {decodeBudget} MiB, its leaf columns past {leafCap} or its values past {valueCap}, the most a preview reads.",
  "N-PQ-MAX-COLUMNS": "Showing the first {k} of {n} columns, the most a preview shows.",
  "N-PQ-CODEC":
    "Column {c} is compressed with {codec} or stored in another file, which the preview cannot read, so the columns from it on are not shown.",
  "N-PQ-VARIANT":
    "Column {c} holds VARIANT values, which the preview does not decode, so the columns from it on are not shown.",
  "N-PQ-NONE-FIT":
    "The first row group is too large to preview: its first column stores {fetch} MiB ({decode} MiB decoded), over the {fetchBudget} MiB read and {decodeBudget} MiB decode budgets, or holds more leaf columns or values than a preview reads. The schema, row count and first-row-group statistics are shown instead.",
  "N-PQ-NO-ROWS": "The file holds no rows.",
  "N-PQ-RG0": "Rows come from the first row group, which holds {m} rows.",
  "N-PQ-DECIMAL": "Column {c} is DECIMAL({p},{s}): values with more than 15 significant digits are shown rounded.",
  "N-PQ-ENCODED":
    "A Parquet file stored compressed as a whole cannot be read by range, so the decoded bytes are shown as hex.",
  "N-PQ-SUMMARY": "{rows} rows in {groups} row group(s); statistics are the first row group's.",
  "N-HINT": "The console's preview command shows these rows as a grid: preview {path}",
  "R-PQ-FOOTER-BIG": "The Parquet footer is {n} bytes, over the {footerMax} bytes a preview reads.",
  "R-PQ-SCHEMA": "The Parquet schema is nested deeper or wider than the preview reads, so the file is not previewed.",
  "R-PQ-FOOTER-LONG": "The Parquet footer declares {n} bytes, more than the object holds.",
  "R-PQ-FOOTER-BAD": "The Parquet footer could not be read: {reason}.",
  "R-PQ-CHUNK-RANGE": "The Parquet footer places column {c} outside the file's data, so the file is not previewed.",
  "R-PQ-PAGES": "The pages of column {c} do not fill its column chunk, so the file is not previewed.",
  "R-PQ-PAGE-VALUES":
    "A page of column {c} declares {v} values, more than its column chunk holds or the preview allows, so the file is not previewed.",
  "R-PQ-PAGE-DECODE":
    "The pages of the columns to show declare {d} MiB decoded, over the {decodeBudget} MiB a preview decodes, so the file is not previewed.",
  "R-PQ-DECODE": "The Parquet data could not be decoded.",
  "R-PQ-BUSY": "The server is decoding other Parquet previews; preview this object again in a moment.",
  "R-PQ-NO-COLUMN": "The Parquet file has no top-level column {c}.",
  "R-PQ-COLUMN-CODEC":
    "Column {c} is compressed with {codec} or stored in another file, which the preview cannot read.",
  "R-PQ-COLUMN-VARIANT": "Column {c} holds VARIANT values, which the preview does not decode.",
  "R-PQ-COLUMNS-BIG":
    "The columns asked for store {fetch} MiB ({decode} MiB decoded) in {leaves} leaf columns and {values} values in the first row group, over the preview's {fetchBudget} MiB read, {decodeBudget} MiB decode, {leafCap} leaf columns or {valueCap} values; ask for fewer columns.",
  "R-COLUMN": "The preview has no column {c}.",
  "R-COLUMNS-LIST": "The column list names {c} twice or holds more than {cap} names.",
  "R-SCHEMA": "--schema applies only to a Parquet object.",
  "R-MAX-ROWS": "--max-rows takes a whole number from 1 to {cap}, the most rows a Studio result holds.",
  "R-ROWS": "The object's rows could not be built, so it is shown as text.",
} as const);

export type PreviewSentenceId = keyof typeof S3_PREVIEW_SENTENCES;

/** R-PQ-FOOTER-BAD when no guard reason applies (hyparquet's own parse threw): the same literal without its reason. */
export const FOOTER_BAD_BARE = S3_PREVIEW_SENTENCES["R-PQ-FOOTER-BAD"].replace(": {reason}", "");

/** The Source part and console warning of a 0-byte object. */
export const EMPTY_OBJECT_SENTENCE = "The object is empty: 0 bytes.";

/** What a sentence says in place of a name `quoteShellWord` cannot spell (a CR, a U+0000, a lone surrogate). */
export const UNSPELLABLE_NAME = "a name with a character a command line cannot spell";

/**
 * A sentence with its placeholders filled: numbers in en-US grouping, strings as given (MiB values arrive already
 * written by `inMiB`). A placeholder with no value is a defect in the caller and throws.
 */
export function previewSentence(id: PreviewSentenceId, values: Readonly<Record<string, string | number>> = {}): string {
  return S3_PREVIEW_SENTENCES[id].replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The preview sentence ${id} needs a value for {${name}}`);
    return typeof value === "number" ? value.toLocaleString("en-US") : value;
  });
}

/**
 * R-MAX-ROWS filled with `cap`: the one literal of the console's `--max-rows` refusal.
 * The console's parse calls it with S3_RESULT_MAX_ROWS and previewObject with the limits in force.
 */
export function previewMaxRowsSentence(cap: number): string {
  return previewSentence("R-MAX-ROWS", { cap });
}

/** A byte count in MiB with two decimals, as the preview's sentences write budgets and sizes. */
export function inMiB(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

/**
 * A name (key, column, header, JSON member) as a sentence spells it: `quoteShellWord`'s form cut at 120 characters
 * with "...", Oxia's shown-key rule; a name no command line can spell gets the fixed phrase instead.
 */
export function spellName(name: string): string {
  let spelled: string;
  try {
    spelled = quoteShellWord(name);
  } catch {
    return UNSPELLABLE_NAME;
  }
  const characters = Array.from(spelled);
  return characters.length > S3_SHOWN_NAME_CHARS ? `${characters.slice(0, S3_SHOWN_NAME_CHARS).join("")}...` : spelled;
}

/**
 * A refusal that is not a QueryError: it becomes the unavailable part or the sole warning. Thrown
 * inside the Parquet path and turned into the `refused` arm of `S3Preview` by `previewObject`.
 */
export class PreviewRefusal extends Error {
  constructor(readonly sentence: string) {
    super(sentence);
    this.name = "PreviewRefusal";
  }
}

/** A hint longer than this is not worth a part of the screen. */
const HINT_MAX_CHARS = 4_096;

/**
 * The whole path word of the console command that previews this object, `quoteShellWord("s3://bucket/key")`, never
 * cut; undefined when no command line can spell it or it is longer than 4,096 characters, since a cut command would
 * preview a different object.
 */
export function previewHint(bucket: string, key: string): string | undefined {
  let word: string;
  try {
    word = quoteShellWord(`s3://${bucket}/${key}`);
  } catch {
    return undefined;
  }
  return word.length > HINT_MAX_CHARS ? undefined : word;
}

type SourceParts = [ObjectSourcePart, ...ObjectSourcePart[]];
type Truncation = { readonly limit: number; readonly reason: string };

/** A text part, cut only by a caller's own limit; a cut read keeps its own truncation mark otherwise. */
function textPart(
  id: string,
  label: string,
  text: string,
  language: string,
  origin: "stored" | "rendered",
  limit: number | undefined,
  cut?: Truncation,
): ObjectSourcePart {
  const bound = applySourceBound(text, limit);
  const truncated = bound.truncated ?? cut;
  return {
    id,
    label,
    text: bound.text,
    language,
    form: "complete",
    origin,
    ...(truncated === undefined ? {} : { truncated }),
  };
}

function withNotes(
  first: ObjectSourcePart,
  second: ObjectSourcePart | undefined,
  notices: readonly string[],
  limit: number | undefined,
): SourceParts {
  const parts: SourceParts = [first];
  if (second !== undefined) parts.push(second);
  if (notices.length > 0)
    parts.push(textPart("preview-notes", "Preview notes", notices.join("\n"), "plaintext", "rendered", limit));
  return parts;
}

/**
 * `entries` as the JSON array `JSON.stringify(entries, null, 2)` writes at `indent`, over already-rendered cells only,
 * stopping before the entry that would take the array past `room` characters.
 */
function boundedArray(
  entries: readonly unknown[],
  indent: string,
  room: number,
): { readonly text: string; readonly kept: number } {
  const pieces: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const piece = JSON.stringify(entry, null, 2)
      .split("\n")
      .map((line) => `${indent}  ${line}`)
      .join("\n");
    const next = pieces.length === 0 ? indent.length + 4 + piece.length : length + 2 + piece.length;
    if (next > room) break;
    pieces.push(piece);
    length = next;
  }
  return { text: pieces.length === 0 ? "[]" : `[\n${pieces.join(",\n")}\n${indent}]`, kept: pieces.length };
}

/** The summary as two-space JSON whose labels say the statistics are the first row group's. */
function schemaText(summary: ParquetSummary): { readonly text: string; readonly kept: number } {
  const head = JSON.stringify(
    {
      rows: summary.rows,
      rowGroups: summary.rowGroups,
      createdBy: summary.createdBy,
      firstRowGroup: summary.firstRowGroup,
      columnsOfFirstRowGroup: [],
    },
    null,
    2,
  );
  const prefix = head.slice(0, -"[]\n}".length);
  const columns = boundedArray(
    summary.columns.map((column) => ({
      path: column.path,
      type: column.type,
      codec: column.codec,
      nullsInFirstRowGroup: column.nulls,
      minInFirstRowGroup: column.min,
      maxInFirstRowGroup: column.max,
      compressedBytes: column.compressedBytes,
      uncompressedBytes: column.uncompressedBytes,
    })),
    "  ",
    SOURCE_CHARACTER_LIMIT - prefix.length - 2,
  );
  return { text: `${prefix}${columns.text}\n}`, kept: columns.kept };
}

const keyedRows = (rows: S3PreviewRows): Record<string, S3PreviewCell>[] =>
  rows.rows.map((cells) => Object.fromEntries(rows.columns.map((column, index) => [column.name, cells[index]])));

const countCell = (cell: S3PreviewCell): string | number =>
  typeof cell === "number" || typeof cell === "string" ? cell : String(cell);

function parquetParts(
  preview: Extract<S3Preview, { kind: "parquet" }>,
  place: { readonly limit?: number },
): SourceParts {
  const notices = [...preview.notices];
  const schema = schemaText(preview.summary);
  if (schema.kept < preview.summary.columns.length) {
    notices.push(previewSentence("N-COLUMNS", { cap: schema.kept, n: preview.summary.columns.length }));
  }
  const schemaPart = textPart("schema", "Parquet schema", schema.text, "json", "rendered", place.limit);
  if (preview.rows === undefined) {
    const reason =
      preview.notices[0] ??
      previewSentence("N-PQ-SUMMARY", { rows: countCell(preview.summary.rows), groups: preview.summary.rowGroups });
    return withNotes(schemaPart, { id: "rows", label: "First rows", unavailable: reason }, notices, place.limit);
  }
  const rows = boundedArray(keyedRows(preview.rows), "", SOURCE_CHARACTER_LIMIT);
  if (rows.kept < preview.rows.rows.length)
    notices.push(previewSentence("N-OUTPUT", { r: rows.kept, cap: SOURCE_CHARACTER_LIMIT }));
  return withNotes(
    schemaPart,
    textPart("rows", "First rows", rows.text, "json", "rendered", place.limit),
    notices,
    place.limit,
  );
}

/**
 * The Source tab's parts of a preview, appended after the Metadata part: one to three, each
 * built to fit SOURCE_CHARACTER_LIMIT, so only a caller's own `limit` cuts one.
 */
export function previewSourceParts(
  preview: S3Preview,
  place: { readonly bucket: string; readonly key: string; readonly limit?: number },
): SourceParts {
  switch (preview.kind) {
    case "empty":
      return [{ id: "preview", label: "Preview", unavailable: preview.notices[0] ?? EMPTY_OBJECT_SENTENCE }];
    case "refused":
      return [{ id: "preview", label: "Preview", unavailable: preview.sentence }];
    case "hex":
      return withNotes(
        textPart(
          "preview",
          "Preview",
          hexDump(preview.bytes, preview.objectBytes),
          "plaintext",
          "rendered",
          place.limit,
        ),
        undefined,
        preview.notices,
        place.limit,
      );
    case "text": {
      const cut = preview.cut
        ? {
            limit: preview.shownBytes,
            reason:
              preview.notices[0] ?? previewSentence("N-CUT", { shown: preview.shownBytes, size: preview.objectBytes }),
          }
        : undefined;
      const rowsPossible =
        preview.format === "csv" ||
        preview.format === "tsv" ||
        preview.format === "ndjson" ||
        (preview.format === "json" && preview.language === "json");
      const path = rowsPossible ? previewHint(place.bucket, place.key) : undefined;
      const notices = path === undefined ? preview.notices : [...preview.notices, previewSentence("N-HINT", { path })];
      return withNotes(
        textPart("preview", "Preview", preview.text, preview.language, preview.origin, place.limit, cut),
        undefined,
        notices,
        place.limit,
      );
    }
    default:
      return parquetParts(preview, place);
  }
}

function grid(rows: S3PreviewRows, warnings: readonly string[], executionTime: number): QueryResult {
  const fields = rows.columns.map((column) => column.name);
  return {
    fields,
    rows: keyedRows(rows),
    rowCount: rows.rows.length,
    executionTime,
    columnTypes: Object.fromEntries(rows.columns.map((column) => [column.name, column.type])),
    ...(warnings.length > 0 ? { warnings: warnings.map((message) => ({ message })) } : {}),
  };
}

const bare = (message: string, executionTime: number): QueryResult => ({
  fields: [],
  rows: [],
  rowCount: 0,
  executionTime,
  warnings: [{ message }],
});

/**
 * The console grid of a preview: the rows of a row format or of Parquet; a text's lines; hex
 * rows of 16 bytes; a Parquet summary as one row per leaf column; an empty or refused preview as its sentence alone.
 */
export function previewQueryResult(preview: S3Preview, executionTime: number): QueryResult {
  const maxRows = S3_PREVIEW_LIMITS.maxRows;
  switch (preview.kind) {
    case "empty":
      return bare(preview.notices[0] ?? EMPTY_OBJECT_SENTENCE, executionTime);
    case "refused":
      return bare(preview.sentence, executionTime);
    case "hex": {
      const hex = hexRows(preview.bytes, maxRows);
      const columns = ["offset", "hex", "text"].map((name) => ({ name, type: "text" }));
      const warnings = hex.more ? [...preview.notices, previewSentence("N-ROWS", { cap: maxRows })] : preview.notices;
      return grid({ columns, rows: hex.rows }, warnings, executionTime);
    }
    case "text": {
      if (preview.rows !== undefined) return grid(preview.rows, preview.notices, executionTime);
      const lines = textLines(preview.text, maxRows);
      const columns = [
        { name: "line", type: "number" },
        { name: "text", type: "text" },
      ];
      return grid(
        { columns, rows: lines.lines.map((line, index) => [index + 1, line]) },
        preview.notices,
        executionTime,
      );
    }
    default: {
      if (preview.rows !== undefined) return grid(preview.rows, preview.notices, executionTime);
      const { summary } = preview;
      const columns = [
        { name: "column", type: "text" },
        { name: "type", type: "text" },
        { name: "codec", type: "text" },
        { name: "nulls", type: "json" },
        { name: "min", type: "json" },
        { name: "max", type: "json" },
        { name: "compressed_bytes", type: "number" },
        { name: "uncompressed_bytes", type: "number" },
      ];
      const rows = summary.columns.map((column) => [
        column.path,
        column.type,
        column.codec,
        column.nulls,
        column.min,
        column.max,
        column.compressedBytes,
        column.uncompressedBytes,
      ]);
      const warnings = [
        ...preview.notices,
        previewSentence("N-PQ-SUMMARY", { rows: countCell(summary.rows), groups: summary.rowGroups }),
      ];
      return grid({ columns, rows }, warnings, executionTime);
    }
  }
}
