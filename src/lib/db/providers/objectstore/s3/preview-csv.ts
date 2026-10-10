/**
 * CSV and TSV rows of the S3 preview. Browser-safe and pure. The splitter reads RFC 4180 in one
 * linear pass; the first record is always the header. A record keeps at most `maxColumns` times 8 fields: the
 * fields past that are counted but never stored or named, so a hostile header of a million delimiters costs the
 * work of 8,192 columns, not a million generated column names.
 */
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import type { S3PreviewLimits } from "./constants";
import type { S3PreviewRequest, S3PreviewRows } from "./preview";
import { buildRows } from "./preview-cells";
import { previewSentence } from "./preview-render";

export interface CsvSplit {
  /** Each record's first `maxFields` fields. */
  readonly records: readonly (readonly string[])[];
  /** Each record's true field count, the fields past `maxFields` included. */
  readonly fieldCounts: readonly number[];
  /** Fields with characters after their closing quote, in kept records only (N-CSV-QUOTE). */
  readonly quoteTrailers: number;
  /** The read ended inside the last record, which was dropped (N-RECORD-CUT). */
  readonly cutLast: boolean;
  /** The whole object ended inside a quoted field, kept as read (N-CSV-UNCLOSED). */
  readonly unclosed: boolean;
}

/**
 * Records of `text` split on `delimiter`: a record ends at LF or CRLF outside quotes (a lone CR is data); a field that
 * begins with `"` is quoted, `""` inside it is one quote and it ends at the next lone quote; characters after the
 * closing quote are appended and counted; a quote inside an unquoted field is data. When `ended` is false the last
 * record is dropped if the read ended inside it. Stops after `maxRecords` complete records. Trailing characters are
 * counted per record and added to `quoteTrailers` only for the first `keptRecords` records kept, so a dropped cut
 * record, or a record read only to learn that more rows exist, adds nothing. A field past the first `maxFields` of
 * its record is counted in `fieldCounts` but its characters are never collected, and its trailing characters are not
 * counted, since it is never shown.
 */
export function splitCsv(
  text: string,
  delimiter: string,
  ended: boolean,
  maxRecords = Number.POSITIVE_INFINITY,
  keptRecords = maxRecords,
  maxFields = Number.POSITIVE_INFINITY,
): CsvSplit {
  const records: string[][] = [];
  const fieldCounts: number[] = [];
  let fields: string[] = [];
  let skipped = 0;
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let trailerCounted = false;
  let atFieldStart = true;
  let quoteTrailers = 0;
  let recordTrailers = 0;
  const skipping = (): boolean => fields.length >= maxFields;
  const endField = (): void => {
    if (skipping()) skipped += 1;
    else fields.push(field);
    field = "";
  };
  const keepRecord = (): void => {
    endField();
    records.push(fields);
    fieldCounts.push(fields.length + skipped);
    if (records.length <= keptRecords) quoteTrailers += recordTrailers;
    recordTrailers = 0;
    fields = [];
    skipped = 0;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        if (!skipping()) field += '"';
        index += 2;
      } else if (char === '"') {
        quoted = false;
        index += 1;
      } else {
        if (!skipping()) field += char;
        index += 1;
      }
      continue;
    }
    if (atFieldStart && char === '"') {
      quoted = true;
      wasQuoted = true;
      atFieldStart = false;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      atFieldStart = true;
      wasQuoted = false;
      trailerCounted = false;
      index += 1;
      continue;
    }
    if (char === "\n" || (char === "\r" && text[index + 1] === "\n")) {
      keepRecord();
      atFieldStart = true;
      wasQuoted = false;
      trailerCounted = false;
      index += char === "\n" ? 1 : 2;
      if (records.length >= maxRecords) return { records, fieldCounts, quoteTrailers, cutLast: false, unclosed: false };
      continue;
    }
    if (wasQuoted && !trailerCounted && !skipping()) {
      recordTrailers += 1;
      trailerCounted = true;
    }
    if (!skipping()) field += char;
    atFieldStart = false;
    index += 1;
  }
  const pending = quoted || !atFieldStart || fields.length > 0 || skipped > 0 || field !== "";
  if (!pending) return { records, fieldCounts, quoteTrailers, cutLast: false, unclosed: false };
  if (!ended) return { records, fieldCounts, quoteTrailers, cutLast: true, unclosed: false };
  keepRecord();
  return { records, fieldCounts, quoteTrailers, cutLast: false, unclosed: quoted };
}

const SNIFF_CANDIDATES: readonly string[] = [",", ";", "\t", "|"];

/**
 * The CSV delimiter: over the first `sniffRecords` complete records, the first of `,` `;` tab `|` with which every
 * record has the same true field count and that count is above 1; else `,`. Each record keeps at most `maxFields`
 * fields while it is read, as in `splitCsv`.
 */
export function sniffDelimiter(
  text: string,
  ended: boolean,
  sniffRecords: number,
  maxFields = Number.POSITIVE_INFINITY,
): string {
  for (const candidate of SNIFF_CANDIDATES) {
    const { fieldCounts } = splitCsv(text, candidate, ended, sniffRecords, sniffRecords, maxFields);
    if (
      fieldCounts.length > 0 &&
      fieldCounts[0] > 1 &&
      fieldCounts.every((fieldCount) => fieldCount === fieldCounts[0])
    ) {
      return candidate;
    }
  }
  return ",";
}

/** The fields a record keeps: eight per shown column, the ratio the Parquet schema walk bounds its elements by. */
const FIELDS_PER_COLUMN = 8;

export type RowsOutcome =
  | { readonly kind: "rows"; readonly rows: S3PreviewRows; readonly notices: readonly string[] }
  | { readonly kind: "text"; readonly notices: readonly string[] };

/** What every row builder reads: the shown text, whether the whole object (or decoded stream) was read, and bounds. */
export interface RowsInput {
  readonly text: string;
  readonly ended: boolean;
  /** The bytes a read takes (textFetchBytes, or decodedTextBytes under gzip), named by the cut notices. */
  readonly readBytes: number;
  readonly request: S3PreviewRequest;
  readonly maxRows: number;
  readonly limits: S3PreviewLimits;
}

/**
 * CSV or TSV rows; a read with no complete first record has no header and answers text rows instead, with
 * N-RECORD-CUT only when the read did not end. Trailing characters are counted over the header and the shown rows.
 * Each record keeps at most `maxColumns` times 8 fields: only those are named (so a column past them cannot be
 * selected by name and is refused like any unknown one), while N-COLUMNS and the ragged count use the true counts.
 */
export function csvRows(input: RowsInput & { readonly format: "csv" | "tsv" }): RowsOutcome {
  const text = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
  const maxFields = input.limits.maxColumns * FIELDS_PER_COLUMN;
  const delimiter =
    input.format === "tsv" ? "\t" : sniffDelimiter(text, input.ended, input.limits.csvSniffRecords, maxFields);
  const split = splitCsv(text, delimiter, input.ended, input.maxRows + 2, input.maxRows + 1, maxFields);
  const cutNotice = previewSentence("N-RECORD-CUT", { n: input.readBytes });
  if (split.records.length === 0) return { kind: "text", notices: input.ended ? [] : [cutNotice] };
  const header = split.records[0];
  const data = split.records.slice(1);
  const shown = data.slice(0, input.maxRows);
  const shownCounts = split.fieldCounts.slice(1, input.maxRows + 1);
  const widest = shown.reduce((width, record) => Math.max(width, record.length), header.length);
  const extras = Array.from({ length: widest - header.length }, (_, offset) => `column ${header.length + offset + 1}`);
  const names = uniqueFieldNames([...header, ...extras]);
  const headerCount = split.fieldCounts[0];
  const columnCount = shownCounts.reduce((width, fieldCount) => Math.max(width, fieldCount), headerCount);
  const ragged = shownCounts.filter((fieldCount) => fieldCount !== headerCount).length;
  const built = buildRows(
    {
      names,
      typing: "text",
      rowCount: data.length,
      valueAt: (row, column) => data[row][column] ?? null,
      columnCount,
    },
    input.request.columns,
    input.maxRows,
    input.limits,
  );
  const notices: string[] = [];
  if (split.quoteTrailers > 0) notices.push(previewSentence("N-CSV-QUOTE", { k: split.quoteTrailers }));
  if (split.unclosed) notices.push(previewSentence("N-CSV-UNCLOSED"));
  if (split.cutLast) notices.push(cutNotice);
  if (ragged > 0) notices.push(previewSentence("N-CSV-RAGGED", { k: ragged }));
  return { kind: "rows", rows: built.rows, notices: [...notices, ...built.notices] };
}
