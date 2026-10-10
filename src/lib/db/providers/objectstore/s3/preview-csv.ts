/**
 * CSV and TSV rows of the S3 preview. Browser-safe and pure. The splitter reads RFC 4180 with
 * the spec's eight rules in one linear pass; the first record is always the header (no --no-header in v1).
 */
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import type { S3PreviewLimits } from "./constants";
import type { S3PreviewRequest, S3PreviewRows } from "./preview";
import { buildRows } from "./preview-cells";
import { previewSentence } from "./preview-render";

export interface CsvSplit {
  readonly records: readonly (readonly string[])[];
  /** Fields with characters after their closing quote (N-CSV-QUOTE). */
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
 * record is dropped if the read ended inside it. Stops after `maxRecords` complete records.
 */
export function splitCsv(
  text: string,
  delimiter: string,
  ended: boolean,
  maxRecords = Number.POSITIVE_INFINITY,
): CsvSplit {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let trailerCounted = false;
  let atFieldStart = true;
  let quoteTrailers = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 2;
      } else if (char === '"') {
        quoted = false;
        index += 1;
      } else {
        field += char;
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
      fields.push(field);
      field = "";
      atFieldStart = true;
      wasQuoted = false;
      trailerCounted = false;
      index += 1;
      continue;
    }
    if (char === "\n" || (char === "\r" && text[index + 1] === "\n")) {
      fields.push(field);
      records.push(fields);
      fields = [];
      field = "";
      atFieldStart = true;
      wasQuoted = false;
      trailerCounted = false;
      index += char === "\n" ? 1 : 2;
      if (records.length >= maxRecords) return { records, quoteTrailers, cutLast: false, unclosed: false };
      continue;
    }
    if (wasQuoted && !trailerCounted) {
      quoteTrailers += 1;
      trailerCounted = true;
    }
    field += char;
    atFieldStart = false;
    index += 1;
  }
  const pending = quoted || !atFieldStart || fields.length > 0 || field !== "";
  if (!pending) return { records, quoteTrailers, cutLast: false, unclosed: false };
  if (!ended) return { records, quoteTrailers, cutLast: true, unclosed: false };
  fields.push(field);
  records.push(fields);
  return { records, quoteTrailers, cutLast: false, unclosed: quoted };
}

const SNIFF_CANDIDATES: readonly string[] = [",", ";", "\t", "|"];

/**
 * The CSV delimiter: over the first `sniffRecords` complete records, the first of `,` `;` tab `|` with which every
 * record has the same field count and that count is above 1; else `,`.
 */
export function sniffDelimiter(text: string, ended: boolean, sniffRecords: number): string {
  for (const candidate of SNIFF_CANDIDATES) {
    const { records } = splitCsv(text, candidate, ended, sniffRecords);
    if (records.length > 0 && records[0].length > 1 && records.every((record) => record.length === records[0].length)) {
      return candidate;
    }
  }
  return ",";
}

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

/** CSV or TSV rows; a read whose first record is cut has no header and answers text rows instead. */
export function csvRows(input: RowsInput & { readonly format: "csv" | "tsv" }): RowsOutcome {
  const text = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
  const delimiter = input.format === "tsv" ? "\t" : sniffDelimiter(text, input.ended, input.limits.csvSniffRecords);
  const split = splitCsv(text, delimiter, input.ended, input.maxRows + 2);
  const cutNotice = previewSentence("N-RECORD-CUT", { n: input.readBytes });
  if (split.records.length === 0) return { kind: "text", notices: [cutNotice] };
  const header = split.records[0];
  const data = split.records.slice(1);
  const shown = data.slice(0, input.maxRows);
  const widest = shown.reduce((width, record) => Math.max(width, record.length), header.length);
  const extras = Array.from({ length: widest - header.length }, (_, offset) => `column ${header.length + offset + 1}`);
  const names = uniqueFieldNames([...header, ...extras]);
  const ragged = shown.filter((record) => record.length !== header.length).length;
  const built = buildRows(
    { names, typing: "text", rowCount: data.length, valueAt: (row, column) => data[row][column] ?? null },
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
