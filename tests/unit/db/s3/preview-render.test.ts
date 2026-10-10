/**
 * The preview's sentences: each is one literal in this module, filled from the
 * limits in force, never carrying stored bytes or a parser's message; names are spelled the way a
 * command line reads them, or by a fixed phrase when no command line can. Then the Source tab parts and the
 * console result built from a preview.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { isSourceDocumentShape } from "@/components/object-source/source-reader";
import { SOURCE_CHARACTER_LIMIT, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import { previewObject, type S3Preview } from "@/lib/db/providers/objectstore/s3/preview";
import {
  EMPTY_OBJECT_SENTENCE,
  FOOTER_BAD_BARE,
  inMiB,
  previewHint,
  previewMaxRowsSentence,
  previewQueryResult,
  previewSourceParts,
  S3_PREVIEW_SENTENCES,
  PreviewRefusal,
  previewSentence,
  spellName,
  UNSPELLABLE_NAME,
} from "@/lib/db/providers/objectstore/s3/preview-render";
import { fakeReader, fixture, headOf, PREVIEW_FIXTURES } from "../../../helpers/s3-preview-reader";

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

const place = { bucket: "sales", key: "data/rows.csv" };
const text = (changes: Partial<Extract<S3Preview, { kind: "text" }>> = {}): S3Preview => ({
  kind: "text",
  format: "csv",
  text: "id,name\n1,a\n",
  language: "plaintext",
  origin: "stored",
  shownBytes: 12,
  objectBytes: 12,
  cut: false,
  notices: [],
  ...changes,
});
const summary = {
  rows: 3,
  rowGroups: 1,
  createdBy: "DuckDB",
  firstRowGroup: { rows: 3, compressedBytes: 10, uncompressedBytes: 20 },
  columns: [
    { path: "id", type: "INT64", codec: "ZSTD", nulls: 0, min: 1, max: 3, compressedBytes: 10, uncompressedBytes: 20 },
  ],
};

describe("previewHint", () => {
  test("the whole path word, quoted when it needs quotes; none for an unspellable or over-long word", () => {
    expect(previewHint("sales", "a b")).toBe("'s3://sales/a b'");
    expect(previewHint("sales", "rows.csv")).toBe("s3://sales/rows.csv");
    expect(previewHint("sales", "a\rb")).toBeUndefined();
    expect(previewHint("sales", "a".repeat(5_000))).toBeUndefined();
  });
});

describe("previewSourceParts", () => {
  test("empty, the gzip-empty sentence, and a refusal are one unavailable Preview part", () => {
    expect(previewSourceParts({ kind: "empty", notices: [] }, place)).toEqual([
      { id: "preview", label: "Preview", unavailable: "The object is empty: 0 bytes." },
    ]);
    expect(
      previewSourceParts(
        { kind: "empty", notices: ["The object is gzip-compressed and its decoded content is empty."] },
        place,
      ),
    ).toEqual([
      {
        id: "preview",
        label: "Preview",
        unavailable: "The object is gzip-compressed and its decoded content is empty.",
      },
    ]);
    expect(
      previewSourceParts({ kind: "refused", sentence: "The Parquet data could not be decoded.", notices: [] }, place),
    ).toEqual([{ id: "preview", label: "Preview", unavailable: "The Parquet data could not be decoded." }]);
  });

  test("a CSV text: the stored text, then the notes with N-HINT; a key with a space is quoted; a key with a CR has no hint", () => {
    expect(previewSourceParts(text(), place)).toEqual([
      {
        id: "preview",
        label: "Preview",
        text: "id,name\n1,a\n",
        language: "plaintext",
        form: "complete",
        origin: "stored",
      },
      {
        id: "preview-notes",
        label: "Preview notes",
        text: "The console's preview command shows these rows as a grid: preview s3://sales/data/rows.csv",
        language: "plaintext",
        form: "complete",
        origin: "rendered",
      },
    ]);
    expect(previewSourceParts(text(), { bucket: "sales", key: "a b" })[1]).toMatchObject({
      text: "The console's preview command shows these rows as a grid: preview 's3://sales/a b'",
    });
    expect(previewSourceParts(text(), { bucket: "sales", key: "a\rb" })).toHaveLength(1);
    expect(previewSourceParts(text({ format: "text" }), place)).toHaveLength(1);
    expect(
      previewSourceParts(text({ format: "json", language: "json", origin: "rendered", text: '{\n  "a": 1\n}' }), place),
    ).toHaveLength(2);
    expect(previewSourceParts(text({ format: "json", language: "plaintext" }), place)).toHaveLength(1);
  });

  test("a cut read carries its first notice as the truncation reason; a caller's smaller limit cuts with its own reason", () => {
    const cut = text({
      cut: true,
      shownBytes: 12,
      objectBytes: 99,
      notices: ["The preview shows the first 12 bytes of 99 bytes."],
    });
    expect(previewSourceParts(cut, place)[0]).toMatchObject({
      truncated: { limit: 12, reason: "The preview shows the first 12 bytes of 99 bytes." },
    });
    expect(previewSourceParts(text(), { ...place, limit: 4 })[0]).toEqual({
      id: "preview",
      label: "Preview",
      text: "id,n",
      language: "plaintext",
      form: "complete",
      origin: "stored",
      truncated: { limit: 4, reason: sourceBoundTruncationReason(4) },
    });
  });

  test("with no caller limit and a whole read, no part carries truncated", () => {
    for (const part of previewSourceParts(text(), place)) expect("truncated" in part).toBe(false);
  });

  test("hex: the dump, plaintext, rendered, then its notes", () => {
    expect(
      previewSourceParts(
        {
          kind: "hex",
          bytes: Uint8Array.of(0x41),
          objectBytes: 1,
          notices: ["The object is not UTF-8 text, so it is shown as hex."],
        },
        place,
      ),
    ).toEqual([
      {
        id: "preview",
        label: "Preview",
        text: `00000000  41${" ".repeat(48)}|A|\n`,
        language: "plaintext",
        form: "complete",
        origin: "rendered",
      },
      {
        id: "preview-notes",
        label: "Preview notes",
        text: "The object is not UTF-8 text, so it is shown as hex.",
        language: "plaintext",
        form: "complete",
        origin: "rendered",
      },
    ]);
  });

  test("Parquet with rows: the schema and the first rows as two-space JSON, a __proto__ column kept as a key", () => {
    const parts = previewSourceParts(
      {
        kind: "parquet",
        summary,
        rows: {
          columns: [
            { name: "id", type: "INT64" },
            { name: "__proto__", type: "BYTE_ARRAY STRING" },
          ],
          rows: [[1, "x"]],
        },
        notices: [],
      },
      place,
    );
    expect(parts.map((part) => [part.id, part.label])).toEqual([
      ["schema", "Parquet schema"],
      ["rows", "First rows"],
    ]);
    const [schema, rows] = parts as unknown as [{ text: string; language: string; origin: string }, { text: string }];
    expect(schema.language).toBe("json");
    expect(schema.origin).toBe("rendered");
    expect(JSON.parse(schema.text)).toEqual({
      rows: 3,
      rowGroups: 1,
      createdBy: "DuckDB",
      firstRowGroup: { rows: 3, compressedBytes: 10, uncompressedBytes: 20 },
      columnsOfFirstRowGroup: [
        {
          path: "id",
          type: "INT64",
          codec: "ZSTD",
          nullsInFirstRowGroup: 0,
          minInFirstRowGroup: 1,
          maxInFirstRowGroup: 3,
          compressedBytes: 10,
          uncompressedBytes: 20,
        },
      ],
    });
    expect(schema.text).toBe(JSON.stringify(JSON.parse(schema.text), null, 2));
    expect(rows.text).toBe('[\n  {\n    "id": 1,\n    "__proto__": "x"\n  }\n]');
  });

  test("Parquet summary only: the rows part is unavailable with the reason the plan gave", () => {
    const parts = previewSourceParts({ kind: "parquet", summary, notices: ["The file holds no rows."] }, place);
    expect(parts[1]).toEqual({ id: "rows", label: "First rows", unavailable: "The file holds no rows." });
    expect(parts[2]).toMatchObject({ id: "preview-notes", text: "The file holds no rows." });
  });

  test("Parquet summary with no notice (a schema-only answer): the rows part says what the summary holds", () => {
    expect(previewSourceParts({ kind: "parquet", summary, notices: [] }, place)[1]).toEqual({
      id: "rows",
      label: "First rows",
      unavailable: "3 rows in 1 row group(s); statistics are the first row group's.",
    });
  });

  test("1,024 columns of 65,536-character statistics and 100 rows of 1,024 such cells stay within SOURCE_CHARACTER_LIMIT", () => {
    const long = "m".repeat(65_536);
    const columns = Array.from({ length: 1_024 }, (_, index) => ({
      path: `c${index}`,
      type: "BYTE_ARRAY",
      codec: "ZSTD",
      nulls: 0,
      min: long,
      max: long,
      compressedBytes: 1,
      uncompressedBytes: 1,
    }));
    const parts = previewSourceParts(
      {
        kind: "parquet",
        summary: { ...summary, columns },
        rows: {
          columns: columns.map((column) => ({ name: column.path, type: "BYTE_ARRAY" })),
          rows: Array.from({ length: 100 }, () => columns.map(() => long)),
        },
        notices: [],
      },
      place,
    );
    const [schema, rows, notes] = parts as { text: string }[];
    expect(schema.text.length).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
    expect(rows.text.length).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
    expect(() => JSON.parse(schema.text)).not.toThrow();
    expect(JSON.parse(rows.text)).toEqual([]);
    expect(notes.text).toMatch(
      /^Showing the first \d+ of 1,024 columns\.\nThe preview stopped after 0 rows, at 1,000,000 characters of cell text\.$/,
    );
  });
});

describe("previewQueryResult", () => {
  test("rows: fields, rows keyed by them, columnTypes, warnings only when there are notices", () => {
    const result = previewQueryResult(
      text({
        rows: {
          columns: [
            { name: "id", type: "text" },
            { name: "__proto__", type: "text" },
          ],
          rows: [["1", "a"]],
        },
        notices: ["N"],
      }),
      7,
    );
    expect(result).toEqual({
      fields: ["id", "__proto__"],
      rows: [
        Object.fromEntries([
          ["id", "1"],
          ["__proto__", "a"],
        ]),
      ],
      rowCount: 1,
      executionTime: 7,
      columnTypes: Object.fromEntries([
        ["id", "text"],
        ["__proto__", "text"],
      ]),
      warnings: [{ message: "N" }],
    });
    expect(Object.hasOwn(result.rows[0], "__proto__")).toBe(true);
    expect(
      "warnings" in previewQueryResult(text({ rows: { columns: [{ name: "a", type: "text" }], rows: [] } }), 1),
    ).toBe(false);
  });

  test("a text with no rows answers its lines", () => {
    expect(previewQueryResult(text({ text: "a\nb\n" }), 1)).toMatchObject({
      fields: ["line", "text"],
      rows: [
        { line: 1, text: "a" },
        { line: 2, text: "b" },
      ],
      columnTypes: { line: "number", text: "text" },
    });
  });

  test("hex: offset, hex and text columns of 16 bytes, at most 500 rows with N-ROWS", () => {
    const small = previewQueryResult({ kind: "hex", bytes: Uint8Array.of(0x41, 0x42), objectBytes: 2, notices: [] }, 1);
    expect(small).toMatchObject({
      fields: ["offset", "hex", "text"],
      rows: [{ offset: "00000000", hex: "41 42", text: "AB" }],
    });
    const large = previewQueryResult(
      { kind: "hex", bytes: new Uint8Array(65_536), objectBytes: 65_536, notices: [] },
      1,
    );
    expect(large.rowCount).toBe(500);
    expect(large.warnings).toEqual([{ message: "The preview stops at 500 rows." }]);
  });

  test("Parquet summary only: one row per leaf column, with N-PQ-SUMMARY", () => {
    expect(previewQueryResult({ kind: "parquet", summary, notices: [] }, 1)).toMatchObject({
      fields: ["column", "type", "codec", "nulls", "min", "max", "compressed_bytes", "uncompressed_bytes"],
      rows: [
        {
          column: "id",
          type: "INT64",
          codec: "ZSTD",
          nulls: 0,
          min: 1,
          max: 3,
          compressed_bytes: 10,
          uncompressed_bytes: 20,
        },
      ],
      warnings: [{ message: "3 rows in 1 row group(s); statistics are the first row group's." }],
    });
  });

  test("empty and refused: no columns, no rows, the sentence as the only warning", () => {
    expect(previewQueryResult({ kind: "empty", notices: [] }, 1)).toEqual({
      fields: [],
      rows: [],
      rowCount: 0,
      executionTime: 1,
      warnings: [{ message: "The object is empty: 0 bytes." }],
    });
    expect(
      previewQueryResult({ kind: "refused", sentence: "The Parquet data could not be decoded.", notices: [] }, 1)
        .warnings,
    ).toEqual([{ message: "The Parquet data could not be decoded." }]);
  });
});

describe("every fixture, end to end", () => {
  const names = readdirSync(PREVIEW_FIXTURES).sort();
  const metadata = {
    id: "metadata",
    label: "Metadata",
    text: "{}",
    language: "json",
    form: "complete",
    origin: "rendered",
  } as const;

  test("every Source document passes the Source reader's shape check, with and without a caller limit", async () => {
    for (const name of names) {
      const object = fixture(name);
      // oxlint-disable-next-line no-await-in-loop -- each fixture is previewed on its own, one after another, as the decode slot allows.
      const preview = await previewObject({
        head: headOf(object, name),
        reader: fakeReader(object),
        request: {},
        purpose: "source",
        signal: new AbortController().signal,
      });
      for (const limit of [undefined, 100]) {
        const document = {
          path: [`studio-demo/${name}`],
          kind: "object",
          parts: [metadata, ...previewSourceParts(preview, { bucket: "studio-demo", key: name, limit })],
        };
        expect(isSourceDocumentShape(document), `${name} with limit ${limit}`).toBe(true);
      }
    }
  });

  test("every console result keeps the QueryResult contract", async () => {
    for (const name of names) {
      const object = fixture(name);
      // oxlint-disable-next-line no-await-in-loop -- each fixture is previewed on its own, one after another, as the decode slot allows.
      const preview = await previewObject({
        head: headOf(object, name),
        reader: fakeReader(object),
        request: {},
        purpose: "console",
        signal: new AbortController().signal,
      });
      const result = previewQueryResult(preview, 1);
      expect(new Set(result.fields).size, name).toBe(result.fields.length);
      expect(
        result.fields.every((field) => field !== ""),
        name,
      ).toBe(true);
      for (const row of result.rows) expect(Object.keys(row).sort(), name).toEqual([...result.fields].sort());
      if (result.columnTypes !== undefined)
        expect(Object.keys(result.columnTypes).sort(), name).toEqual([...result.fields].sort());
      if (result.warnings !== undefined) expect(result.warnings.length, name).toBeGreaterThan(0);
    }
  });
});
