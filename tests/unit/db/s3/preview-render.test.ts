/**
 * The preview's sentences: each is one literal in this module, filled from the
 * limits in force, never carrying stored bytes or a parser's message; names are spelled the way a
 * command line reads them, or by a fixed phrase when no command line can. Task 19 adds the Source parts and
 * the console result.
 */
import { describe, expect, test } from "bun:test";
import {
  EMPTY_OBJECT_SENTENCE,
  FOOTER_BAD_BARE,
  inMiB,
  previewMaxRowsSentence,
  S3_PREVIEW_SENTENCES,
  PreviewRefusal,
  previewSentence,
  spellName,
  UNSPELLABLE_NAME,
} from "@/lib/db/providers/objectstore/s3/preview-render";

describe("the preview's sentences, verbatim", () => {
  test("every sentence, exactly once, under its id", () => {
    expect({ ...S3_PREVIEW_SENTENCES }).toEqual({
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
      "N-GZIP-BAD":
        "The object is marked as gzip but its bytes are not gzip data, so its stored bytes are shown as hex.",
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
      "R-PQ-SCHEMA":
        "The Parquet schema is nested deeper or wider than the preview reads, so the file is not previewed.",
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
    });
    expect(Object.isFrozen(S3_PREVIEW_SENTENCES)).toBe(true);
  });

  test("the bare footer refusal, the empty object and the unspellable name", () => {
    expect(FOOTER_BAD_BARE).toBe("The Parquet footer could not be read.");
    expect(EMPTY_OBJECT_SENTENCE).toBe("The object is empty: 0 bytes.");
    expect(UNSPELLABLE_NAME).toBe("a name with a character a command line cannot spell");
  });
});

describe("previewSentence", () => {
  test("numbers are grouped the en-US way and strings are written as given", () => {
    expect(previewSentence("N-CUT", { shown: 1_000_000, size: 5_242_880 })).toBe(
      "The preview shows the first 1,000,000 bytes of 5,242,880 bytes.",
    );
    expect(previewSentence("R-MAX-ROWS", { cap: 500 })).toBe(
      "--max-rows takes a whole number from 1 to 500, the most rows a Studio result holds.",
    );
    expect(previewSentence("R-SCHEMA")).toBe("--schema applies only to a Parquet object.");
  });

  test("a value holding a replacement pattern is written literally", () => {
    expect(previewSentence("R-COLUMN", { c: "'$&$1'" })).toBe("The preview has no column '$&$1'.");
  });

  test("a missing value is a defect and throws, naming the sentence and the placeholder", () => {
    expect(() => previewSentence("N-CUT", { shown: 1 })).toThrow("The preview sentence N-CUT needs a value for {size}");
  });

  test("previewMaxRowsSentence is R-MAX-ROWS filled with the cap the caller holds", () => {
    expect(previewMaxRowsSentence(500)).toBe(
      "--max-rows takes a whole number from 1 to 500, the most rows a Studio result holds.",
    );
    expect(previewMaxRowsSentence(3)).toBe(
      "--max-rows takes a whole number from 1 to 3, the most rows a Studio result holds.",
    );
  });

  test("inMiB writes two decimals", () => {
    expect(inMiB(8_388_608)).toBe("8.00");
    expect(inMiB(33_554_432)).toBe("32.00");
    expect(inMiB(1_572_864)).toBe("1.50");
    expect(inMiB(64)).toBe("0.00");
  });
});

describe("spellName", () => {
  test("a bare name stays bare and a name with a space is quoted", () => {
    expect(spellName("amount")).toBe("amount");
    expect(spellName("first name")).toBe("'first name'");
  });

  test("a name past 120 characters is cut with ...", () => {
    expect(spellName("a".repeat(130))).toBe(`${"a".repeat(120)}...`);
  });

  test("a CSV header holding a CR, an NDJSON key U+0000 and a column named with a lone surrogate give the fixed phrase without a throw", () => {
    expect(spellName("a\rb")).toBe(UNSPELLABLE_NAME);
    expect(spellName("\u0000")).toBe(UNSPELLABLE_NAME);
    expect(spellName("x\ud800")).toBe(UNSPELLABLE_NAME);
  });
});

describe("PreviewRefusal", () => {
  test("carries its sentence as message and field", () => {
    const refusal = new PreviewRefusal("The Parquet data could not be decoded.");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.sentence).toBe("The Parquet data could not be decoded.");
    expect(refusal.message).toBe("The Parquet data could not be decoded.");
    expect(refusal.name).toBe("PreviewRefusal");
  });
});
