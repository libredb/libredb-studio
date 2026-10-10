/**
 * The S3 preview's words and its two outward shapes. Browser-safe: it imports
 * only the provider's browser-safe modules, the shared console modules, the engine-neutral shared modules and types.
 * Every preview sentence is one literal here; the console's `--max-rows` refusal imports it.
 */
import { quoteShellWord } from "@/lib/db/console/shell-words";
import { S3_SHOWN_NAME_CHARS } from "./constants";

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
