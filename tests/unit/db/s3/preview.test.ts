/**
 * The S3 object preview: its limits, one name per shared number, and, from Task 18 on,
 * previewObject's dispatch and the checks every ranged answer passes before its bytes are used.
 */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { QueryError } from "@/lib/db/errors";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import * as consoleConstants from "@/lib/db/providers/objectstore/s3/console/constants";
import {
  S3_CELL_CHARS,
  S3_LIMITER_OPTIONS,
  S3_PARQUET_DECODE_QUEUE,
  S3_PARQUET_DECODE_SLOTS,
  S3_PREVIEW_DEFAULT_ROWS,
  S3_PREVIEW_LIMITS,
  S3_RESULT_MAX_ROWS,
} from "@/lib/db/providers/objectstore/s3/constants";
import {
  PREVIEW_DEPS,
  PREVIEW_READ_SENTENCES,
  previewObject,
  type S3PreviewRequest,
} from "@/lib/db/providers/objectstore/s3/preview";
import { previewSentence } from "@/lib/db/providers/objectstore/s3/preview-render";
import { fakeReader, fixture, headOf } from "../../../helpers/s3-preview-reader";

describe("the preview's limits", () => {
  test("defaultRows, maxRows and cellChars are the single definitions, and the console re-exports the same bindings", () => {
    expect(S3_PREVIEW_LIMITS.defaultRows).toBe(S3_PREVIEW_DEFAULT_ROWS);
    expect(S3_PREVIEW_LIMITS.maxRows).toBe(S3_RESULT_MAX_ROWS);
    expect(S3_PREVIEW_LIMITS.cellChars).toBe(S3_CELL_CHARS);
    expect(consoleConstants.S3_PREVIEW_DEFAULT_ROWS).toBe(S3_PREVIEW_DEFAULT_ROWS);
    expect(consoleConstants.S3_RESULT_MAX_ROWS).toBe(S3_RESULT_MAX_ROWS);
    expect(consoleConstants.S3_CELL_CHARS).toBe(S3_CELL_CHARS);
  });

  test("the object is frozen, so no caller widens a bound for the whole process", () => {
    expect(Object.isFrozen(S3_PREVIEW_LIMITS)).toBe(true);
  });

  test("a text read and a decoded gzip prefix always fit one Source part uncut", () => {
    expect(S3_PREVIEW_LIMITS.textFetchBytes).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
    expect(S3_PREVIEW_LIMITS.decodedTextBytes).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
  });

  test("the documented values, with the Parquet caps the decode heap measurement fixed", () => {
    expect({ ...S3_PREVIEW_LIMITS }).toEqual({
      textFetchBytes: 1_000_000,
      gzipFetchBytes: 1_000_000,
      decodedTextBytes: 1_000_000,
      hexBytes: 65_536,
      parquetTailBytes: 65_536,
      parquetFooterMaxBytes: 1_048_576,
      parquetFetchBudget: 8_388_608,
      parquetDecodeBudget: 33_554_432,
      parquetMaxPageValues: 524_288,
      parquetMaxChunkValues: 524_288,
      parquetMaxTotalValues: 524_288,
      parquetMaxLeafColumns: 128,
      parquetMaxSchemaDepth: 64,
      thriftMaxDepth: 32,
      sourceRows: 100,
      defaultRows: 100,
      maxRows: 500,
      cellChars: 65_536,
      summaryCellChars: 256,
      cellMaxDepth: 64,
      outputChars: 4_194_304,
      maxColumns: 1_024,
      csvSniffRecords: 20,
    });
  });

  test("two Parquet decodes run per process, and the queue equals the provider's request bound", () => {
    expect(S3_PARQUET_DECODE_SLOTS).toBe(2);
    expect(S3_PARQUET_DECODE_QUEUE).toBe(S3_LIMITER_OPTIONS.perProvider);
    expect(S3_PARQUET_DECODE_QUEUE).toBe(4);
  });
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const gz = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));
const shrink = (changes: Partial<typeof S3_PREVIEW_LIMITS>) => ({ ...S3_PREVIEW_LIMITS, ...changes });

async function run(
  object: Uint8Array,
  key: string,
  options: {
    readonly purpose?: "source" | "console";
    readonly request?: S3PreviewRequest;
    readonly head?: Partial<ReturnType<typeof headOf>>;
    readonly limits?: typeof S3_PREVIEW_LIMITS;
    readonly reader?: ReturnType<typeof fakeReader>;
    readonly signal?: AbortSignal;
  } = {},
) {
  const reader = options.reader ?? fakeReader(object);
  const preview = await previewObject({
    head: headOf(object, key, options.head),
    reader,
    request: options.request ?? {},
    purpose: options.purpose ?? "console",
    limits: options.limits,
    signal: options.signal ?? new AbortController().signal,
  });
  return { preview, reader };
}

describe("previewObject: dispatch by format and purpose", () => {
  test("CSV: the Source tab gets the stored text and no rows; the console gets rows", async () => {
    const object = fixture("rows.csv");
    const source = await run(object, "data/rows.csv", { purpose: "source" });
    expect(source.preview).toEqual({
      kind: "text",
      format: "csv",
      text: new TextDecoder().decode(object),
      language: "plaintext",
      origin: "stored",
      shownBytes: object.length,
      objectBytes: object.length,
      cut: false,
      notices: [],
    });
    const grid = await run(object, "data/rows.csv");
    expect(grid.preview.kind === "text" && grid.preview.rows?.rows).toEqual([
      ["1", "alpha", "1.5"],
      ["2", "beta", "3"],
      ["3", "gamma, delta", "4.5"],
    ]);
    expect(source.reader.calls).toEqual([{ range: { kind: "first", length: object.length }, maxBytes: object.length }]);
  });

  test("TSV, NDJSON and a JSON array give rows; a JSON document is re-indented for the Source tab", async () => {
    expect((await run(fixture("rows.tsv"), "rows.tsv")).preview).toMatchObject({
      format: "tsv",
      rows: {
        rows: [
          ["1", "a b"],
          ["2", "c,d"],
        ],
      },
    });
    expect((await run(fixture("rows.ndjson"), "rows.ndjson")).preview).toMatchObject({
      format: "ndjson",
      rows: { columns: [{ name: "id" }, { name: "name" }, { name: "tags" }] },
    });
    expect((await run(fixture("array.json"), "array.json")).preview).toMatchObject({
      format: "json",
      rows: {
        rows: [
          [1, "a"],
          [2, "b"],
        ],
      },
    });
    const doc = await run(fixture("doc.json"), "doc.json", { purpose: "source" });
    expect(doc.preview).toMatchObject({ kind: "text", format: "json", language: "json", origin: "rendered" });
    expect(doc.preview.kind === "text" && doc.preview.text).toBe(
      '{\n  "service": "studio",\n  "ports": [\n    3000,\n    9000\n  ],\n  "nested": {\n    "ok": true\n  }\n}',
    );
  });

  test("no extension: plain text gives line rows; JSON bytes are shown as json; a Content-Type hint places CSV", async () => {
    expect((await run(utf8("hello\nworld\n"), "notes")).preview).toMatchObject({
      format: "text",
      rows: {
        columns: [
          { name: "line", type: "number" },
          { name: "text", type: "text" },
        ],
        rows: [
          [1, "hello"],
          [2, "world"],
        ],
      },
    });
    expect((await run(utf8('{"a":1}'), "data")).preview).toMatchObject({ format: "json", language: "json" });
    expect(
      (await run(utf8("a,b\n1,2\n"), "export", { head: { contentType: "text/csv; charset=utf-8" } })).preview,
    ).toMatchObject({
      format: "csv",
      rows: { rows: [["1", "2"]] },
    });
  });

  test("bytes that are not text are a hex dump from the same read; blank text too; --format hex reads hexBytes", async () => {
    const binary = await run(fixture("binary.bin"), "binary.bin");
    expect(binary.preview).toMatchObject({
      kind: "hex",
      objectBytes: 300,
      notices: ["The object is not UTF-8 text, so it is shown as hex."],
    });
    expect(binary.reader.calls).toHaveLength(1);
    expect((await run(utf8("   \n\t"), "blank.txt")).preview).toMatchObject({
      kind: "hex",
      notices: ["The object holds only blank characters, so it is shown as hex."],
    });
    const forced = await run(fixture("rows.csv"), "rows.csv", { request: { format: "hex" } });
    expect(forced.preview).toMatchObject({ kind: "hex", notices: [] });
    expect(forced.reader.calls[0]).toEqual({
      range: { kind: "first", length: fixture("rows.csv").length },
      maxBytes: fixture("rows.csv").length,
    });
  });

  test("Parquet by extension, Parquet by magic bytes, and a .parquet key without PAR1", async () => {
    expect((await run(fixture("fx-zstd.parquet"), "parquet/fx-zstd.parquet")).preview.kind).toBe("parquet");
    const magic = await run(fixture("fx-zstd.parquet"), "parquet/noext");
    expect(magic.preview.kind).toBe("parquet");
    expect(magic.reader.calls.map((call) => call.range.kind)).toEqual(["first", "suffix", "span"]);
    expect((await run(fixture("rows.csv"), "wrong.parquet")).preview).toMatchObject({
      kind: "hex",
      notices: [
        "The object does not end with the Parquet marker PAR1, so it is not a Parquet file; it is shown as hex.",
      ],
    });
  });

  test("a text read shorter than the object is cut with N-CUT first, at a UTF-8 boundary", async () => {
    const object = fixture("utf8-cut.txt");
    const { preview } = await run(object, "utf8-cut.txt", { purpose: "source", limits: shrink({ textFetchBytes: 9 }) });
    expect(preview).toMatchObject({ kind: "text", cut: true, shownBytes: 6, text: "aé€" });
    expect(preview.notices[0]).toBe(`The preview shows the first 6 bytes of ${object.length} bytes.`);
  });

  test("gzip found by its magic bytes, invalid JSON, --format hex under gzip, and a cut first CSV record in the console", async () => {
    const magic = await run(gz(utf8("a,b\n1,2\n")), "export");
    expect(magic.preview).toMatchObject({ kind: "text", format: "text", cut: false });
    expect(magic.preview.notices[0]).toStartWith("The object is gzip-compressed;");
    expect((await run(utf8("{nope"), "bad.json")).preview).toMatchObject({
      kind: "text",
      format: "json",
      language: "plaintext",
      notices: ["The object is not valid JSON, so it is shown as text."],
      rows: { rows: [[1, "{nope"]] },
    });
    expect(
      (await run(gz(utf8("abc")), "a.txt", { head: { contentEncoding: "gzip" }, request: { format: "hex" } })).preview,
    ).toMatchObject({
      kind: "hex",
      objectBytes: 3,
    });
    expect(
      (await run(utf8("a".repeat(40)), "wide.csv", { limits: shrink({ textFetchBytes: 16 }) })).preview,
    ).toMatchObject({
      kind: "text",
      format: "csv",
      cut: true,
      rows: { columns: [{ name: "line" }, { name: "text" }], rows: [[1, "a".repeat(16)]] },
      notices: [
        "The preview shows the first 16 bytes of 40 bytes.",
        "The last record was cut by the 16-byte read and is not shown.",
      ],
    });
  });

  test("a 0-byte object sends no GET", async () => {
    const { preview, reader } = await run(new Uint8Array(0), "empty.csv");
    expect(preview).toEqual({ kind: "empty", notices: [] });
    expect(reader.calls).toEqual([]);
  });
});

describe("previewObject: every answer is checked before its bytes are used", () => {
  const object = utf8("id,name\n1,a\n");
  const rewrite = (change: (answer: Awaited<ReturnType<ReturnType<typeof fakeReader>["read"]>>) => object) =>
    fakeReader(object, { override: (_call, answer) => ({ ...answer, ...change(answer) }) as never });

  test("in the order of the table: ETag missing, ETag changed, size changed, start moved, bytes short", async () => {
    expect(Object.isFrozen(PREVIEW_READ_SENTENCES)).toBe(true);
    expect({ ...PREVIEW_READ_SENTENCES }).toEqual({
      noEtag:
        "The server sent no ETag with the object's bytes, so the preview cannot tell whether the object changed while it was read.",
      changed: "The object changed while it was previewed; preview it again.",
      range: "The server answered a different byte range from the one asked for, so the preview stopped.",
      short: "The server answered fewer bytes than the range asked for, so the preview stopped.",
    });
    await expect(run(object, "a.csv", { reader: rewrite(() => ({ etag: undefined })) })).rejects.toThrow(
      new QueryError(
        "The server sent no ETag with the object's bytes, so the preview cannot tell whether the object changed while it was read.",
        "s3",
      ),
    );
    await expect(run(object, "a.csv", { reader: rewrite(() => ({ etag: '"other"' })) })).rejects.toThrow(
      "The object changed while it was previewed; preview it again.",
    );
    await expect(run(object, "a.csv", { reader: rewrite((answer) => ({ total: answer.total + 1 })) })).rejects.toThrow(
      "The object changed while it was previewed; preview it again.",
    );
    await expect(run(object, "a.csv", { reader: rewrite(() => ({ start: 1 })) })).rejects.toThrow(
      "The server answered a different byte range from the one asked for, so the preview stopped.",
    );
    await expect(
      run(object, "a.csv", { reader: rewrite((answer) => ({ bytes: answer.bytes.subarray(1) })) }),
    ).rejects.toThrow("The server answered fewer bytes than the range asked for, so the preview stopped.");
  });

  test("a 200 from offset 0 is accepted and already cut to maxBytes; a 200 to a suffix read is refused", async () => {
    const long = utf8(`id\n${"1\n".repeat(100)}`);
    const accepted = await run(long, "a.csv", {
      reader: fakeReader(long, { ignoreRange: true }),
      limits: shrink({ textFetchBytes: 10 }),
    });
    expect(accepted.preview).toMatchObject({ kind: "text", cut: true, shownBytes: 10 });
    const parquet = fixture("fx-zstd.parquet");
    await expect(
      run(new Uint8Array([...parquet, ...new Uint8Array(70_000)]), "f.parquet", {
        reader: fakeReader(new Uint8Array([...parquet, ...new Uint8Array(70_000)]), { ignoreRange: true }),
      }),
    ).rejects.toThrow("The server answered a different byte range from the one asked for, so the preview stopped.");
  });

  test("a weak ETag and a multipart ETag, the same on the HEAD and the GET, pass unchanged", async () => {
    for (const etag of ['W/"5d41402abc4b2a76"', '"d41d8cd98f00b204e9800998ecf8427e-3"']) {
      // oxlint-disable-next-line no-await-in-loop -- each ETag is checked on its own, one after another.
      const { preview } = await run(object, "a.csv", { head: { etag }, reader: fakeReader(object, { etag }) });
      expect(preview.kind).toBe("text");
    }
  });

  test("an object that changes between the two GETs of one Parquet preview is refused", async () => {
    const parquet = fixture("fx-zstd.parquet");
    const reader = fakeReader(parquet, {
      override: (call, answer) => (call === 1 ? { ...answer, etag: '"changed"' } : answer),
    });
    await expect(run(parquet, "f.parquet", { reader })).rejects.toThrow(
      "The object changed while it was previewed; preview it again.",
    );
  });

  test("a signal aborted before the first GET sends nothing and rejects with the abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = fakeReader(object);
    await expect(run(object, "a.csv", { reader, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(reader.calls).toEqual([]);
  });
});

describe("previewObject: the gzip layer and other encodings", () => {
  test("gzip under Content-Encoding and under .gz: rows, with N-GZIP first", async () => {
    const csv = fixture("rows.csv");
    const encoded = await run(gz(csv), "data/rows.csv", { head: { contentEncoding: "gzip" } });
    expect(encoded.preview).toMatchObject({ kind: "text", format: "csv", cut: false });
    expect(encoded.preview.notices[0]).toBe(
      `The object is gzip-compressed; the preview shows the first ${csv.length} bytes of its decoded content, from the first ${gz(csv).length} stored bytes.`,
    );
    expect((await run(fixture("rows.ndjson.gz"), "rows.ndjson.gz")).preview).toMatchObject({
      format: "ndjson",
      rows: {
        rows: [
          [1, "a", null],
          [2, "b", null],
          [3, null, '["x"]'],
        ],
      },
    });
  });

  test("a gzip JSON object read whole is parsed; a cut stored prefix gives N-JSON-CUT", async () => {
    expect((await run(gz(fixture("doc.json")), "doc.json.gz")).preview).toMatchObject({
      format: "json",
      language: "json",
    });
    const big = gz(utf8(JSON.stringify(Array.from({ length: 2_000 }, (_, index) => ({ index })))));
    const { preview } = await run(big, "big.json.gz", {
      limits: shrink({ gzipFetchBytes: 512, decodedTextBytes: 1_000 }),
    });
    expect(preview).toMatchObject({ kind: "text", format: "json", language: "plaintext", cut: true });
    expect(preview.notices).toContain(
      "The JSON document is larger than the 1,000 bytes a preview reads, so it is shown as text and not parsed.",
    );
  });

  test("nested gzip, bytes that are not gzip, an empty decoded output, and Parquet under gzip", async () => {
    expect((await run(gz(gz(utf8("x"))), "a.gz")).preview).toMatchObject({
      kind: "hex",
      notices: ["The decoded content is itself gzip data; the preview decodes one layer, so it is shown as hex."],
    });
    expect((await run(fixture("rows.csv"), "rows.csv", { head: { contentEncoding: "gzip" } })).preview).toMatchObject({
      kind: "hex",
      notices: ["The object is marked as gzip but its bytes are not gzip data, so its stored bytes are shown as hex."],
    });
    expect((await run(gz(new Uint8Array(0)), "e.gz")).preview).toEqual({
      kind: "empty",
      notices: ["The object is gzip-compressed and its decoded content is empty."],
    });
    expect((await run(gz(fixture("fx-zstd.parquet")), "f.parquet.gz")).preview).toMatchObject({
      kind: "hex",
      notices: [
        "A Parquet file stored compressed as a whole cannot be read by range, so the decoded bytes are shown as hex.",
        "The preview stops at 100 rows.",
      ],
    });
  });

  test("another Content-Encoding is shown as stored bytes in hex", async () => {
    expect((await run(utf8("abc"), "a.txt", { head: { contentEncoding: "br" } })).preview).toMatchObject({
      kind: "hex",
      notices: [
        "The object is stored with Content-Encoding br, which the preview does not decode, so its stored bytes are shown as hex.",
      ],
    });
  });
});

describe("previewObject: the request is checked before any GET", () => {
  test("--max-rows 0, 501 and 1.5 are refused with R-MAX-ROWS", async () => {
    for (const maxRows of [0, 501, 1.5]) {
      const reader = fakeReader(fixture("rows.csv"));
      // oxlint-disable-next-line no-await-in-loop -- each value is checked on its own, against its own reader.
      await expect(run(fixture("rows.csv"), "rows.csv", { reader, request: { maxRows } })).rejects.toThrow(
        new QueryError("--max-rows takes a whole number from 1 to 500, the most rows a Studio result holds.", "s3"),
      );
      expect(reader.calls).toEqual([]);
    }
  });

  test("a repeated column name and more than maxColumns names are refused before any GET, each with its own sentence", async () => {
    const repeated = fakeReader(fixture("rows.csv"));
    await expect(
      run(fixture("rows.csv"), "rows.csv", { reader: repeated, request: { columns: ["id", "name", "id"] } }),
    ).rejects.toThrow("The column list names id twice.");
    expect(repeated.calls).toEqual([]);
    const many = fakeReader(fixture("rows.csv"));
    await expect(
      run(fixture("rows.csv"), "rows.csv", {
        reader: many,
        request: { columns: ["a", "b"] },
        limits: shrink({ maxColumns: 1 }),
      }),
    ).rejects.toThrow("The column list holds more than 1 name.");
    expect(many.calls).toEqual([]);
    await expect(
      run(fixture("rows.csv"), "rows.csv", {
        request: { columns: ["a", "b", "c"] },
        limits: shrink({ maxColumns: 2 }),
      }),
    ).rejects.toThrow("The column list holds more than 2 names.");
  });

  test("--schema on CSV is refused with R-SCHEMA before any GET, and on bytes that turn out not to be Parquet after", async () => {
    const reader = fakeReader(fixture("rows.csv"));
    await expect(run(fixture("rows.csv"), "rows.csv", { reader, request: { schemaOnly: true } })).rejects.toThrow(
      "--schema applies only to a Parquet object.",
    );
    expect(reader.calls).toEqual([]);
    await expect(run(fixture("rows.csv"), "noext", { request: { schemaOnly: true } })).rejects.toThrow(
      "--schema applies only to a Parquet object.",
    );
    expect((await run(fixture("fx-zstd.parquet"), "f.parquet", { request: { schemaOnly: true } })).preview.kind).toBe(
      "parquet",
    );
  });

  test("an unknown --columns name on a row format propagates as R-COLUMN", async () => {
    await expect(run(fixture("rows.csv"), "rows.csv", { request: { columns: ["zz"] } })).rejects.toThrow(
      "The preview has no column zz.",
    );
  });
});

describe("previewObject: a row builder that throws falls back to text rows", () => {
  test("R-ROWS, with the text's lines as the grid", async () => {
    const deps = {
      ...PREVIEW_DEPS,
      rows: {
        ...PREVIEW_DEPS.rows,
        csv: () => {
          throw new Error("builder defect");
        },
      },
    };
    const object = fixture("rows.csv");
    const preview = await previewObject(
      {
        head: headOf(object, "rows.csv"),
        reader: fakeReader(object),
        request: {},
        purpose: "console",
        signal: new AbortController().signal,
      },
      deps,
    );
    expect(preview).toMatchObject({
      kind: "text",
      format: "csv",
      rows: {
        columns: [{ name: "line" }, { name: "text" }],
        rows: [
          [1, "id,name,amount"],
          [2, "1,alpha,1.5"],
          [3, "2,beta,3"],
          [4, '3,"gamma, delta",4.5'],
        ],
      },
      notices: ["The object's rows could not be built, so it is shown as text."],
    });
  });
});

describe("previewObject: hex rows for the console", () => {
  const binary = new Uint8Array(65_536).fill(0xff);
  const hexColumns = [
    { name: "offset", type: "text" },
    { name: "hex", type: "text" },
    { name: "text", type: "text" },
  ];

  test("a console hex preview carries maxRows rows of 16 bytes and ends with N-ROWS at that cap", async () => {
    for (const request of [{ maxRows: 10 }, { maxRows: 10, format: "hex" as const }]) {
      // oxlint-disable-next-line no-await-in-loop -- each request is checked in turn against its own fake reader
      const { preview } = await run(binary, "blob.bin", { request });
      if (preview.kind !== "hex") throw new Error(`expected hex, got ${preview.kind}`);
      expect(preview.rows?.columns).toEqual(hexColumns);
      expect(preview.rows?.rows).toHaveLength(10);
      expect(preview.notices.at(-1)).toBe(previewSentence("N-ROWS", { cap: 10 }));
      expect(preview.notices.at(-1)).toBe("The preview stops at 10 rows.");
    }
  });

  test("with no maxRows the console hex preview carries defaultRows rows and N-ROWS at that cap", async () => {
    const { preview } = await run(binary, "blob.bin");
    if (preview.kind !== "hex") throw new Error(`expected hex, got ${preview.kind}`);
    expect(preview.rows?.rows).toHaveLength(100);
    expect(preview.notices.at(-1)).toBe(previewSentence("N-ROWS", { cap: 100 }));
  });

  test("the Source tab's hex preview carries no rows", async () => {
    const { preview } = await run(binary, "blob.bin", { purpose: "source", request: { maxRows: 10 } });
    expect(preview.kind).toBe("hex");
    expect("rows" in preview).toBe(false);
  });

  test("an object of 32 bytes or fewer gives at most two rows and no N-ROWS", async () => {
    const { preview } = await run(new Uint8Array(32).fill(0xff), "small.bin", { request: { maxRows: 10 } });
    if (preview.kind !== "hex") throw new Error(`expected hex, got ${preview.kind}`);
    expect(preview.rows?.rows.length).toBeLessThanOrEqual(2);
    expect(preview.notices).not.toContain(previewSentence("N-ROWS", { cap: 10 }));
  });
});
