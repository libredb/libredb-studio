/**
 * The S3 Parquet preview: what the preview decides before it reads any column data (footer, guards,
 * parsers, plan and summary), then the reads, the page pre-scan, the guarded decode and the process-wide decode slot.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
  constants as zlibConstants,
  zstdCompressSync,
} from "node:zlib";
import { QueryError } from "@/lib/db/errors";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import type { S3PreviewCell } from "@/lib/db/providers/objectstore/s3/preview";
import {
  boundedLz4,
  boundedLz4Raw,
  boundedZlib,
  boundedZstd,
  createDecodeSlots,
  DECODE_OVER_BUDGET,
  type DecodeSlots,
  type FooterOutcome,
  guardedCompressors,
  loadParquetModules,
  type ParquetFooter,
  type ParquetModules,
  type ParquetPreviewInput,
  planParquet,
  PREVIEW_PARSERS,
  prescanChunk,
  previewParquet,
  readParquetFooter,
  summarizeParquet,
} from "@/lib/db/providers/objectstore/s3/preview-parquet";
import { inMiB, PreviewRefusal } from "@/lib/db/providers/objectstore/s3/preview-render";
import {
  booleanRle,
  CODEC,
  ENCODING,
  int32Plain,
  PHYSICAL,
  type SyntheticChunk,
  type SyntheticFile,
  syntheticParquet,
  withTail,
} from "../../../helpers/parquet-synthetic";
import { writeLargeParquet } from "../../../helpers/s3-large-parquet";
import { fakeReader, fixture, headOf } from "../../../helpers/s3-preview-reader";
import { THRIFT, type ThriftValue, thriftStruct, varint } from "../../../helpers/thrift-compact";

const limits = (changes: Partial<typeof S3_PREVIEW_LIMITS> = {}) => ({ ...S3_PREVIEW_LIMITS, ...changes });

/** The leaf and value caps as the preview's sentences write them. */
const leafCapText = S3_PREVIEW_LIMITS.parquetMaxLeafColumns.toLocaleString("en-US");
const valueCapText = S3_PREVIEW_LIMITS.parquetMaxTotalValues.toLocaleString("en-US");
/** The fetch and decode budgets as the preview's sentences write them. */
const fetchCapText = inMiB(S3_PREVIEW_LIMITS.parquetFetchBudget);
const decodeCapText = inMiB(S3_PREVIEW_LIMITS.parquetDecodeBudget);

/** A Parquet input over a fake reader that reads under the input's own signal. */
function inputFor(object: Uint8Array, key: string, changes: Partial<ParquetPreviewInput> = {}) {
  const reader = fakeReader(object);
  const signal = changes.signal ?? new AbortController().signal;
  const input: ParquetPreviewInput = {
    head: headOf(object, key),
    read: async (range, maxBytes) => (await reader.read(range, maxBytes, signal)).bytes,
    request: {},
    purpose: "console",
    limits: S3_PREVIEW_LIMITS,
    ...changes,
    signal,
  };
  return { reader, input };
}

/** Decode slots of their own for a footer read, so no test waits on the process-wide slot. */
const freeSlots = (): DecodeSlots => createDecodeSlots(2, 4);

async function footerOf(object: Uint8Array, changes: Partial<ParquetPreviewInput> = {}): Promise<ParquetFooter> {
  const outcome = await readParquetFooter(
    inputFor(object, "f.parquet", changes).input,
    await loadParquetModules(),
    freeSlots(),
  );
  if (outcome.kind !== "footer") throw new Error(`expected a footer, got ${JSON.stringify(outcome)}`);
  return outcome.footer;
}

const footerOutcome = async (object: Uint8Array, changes: Partial<ParquetPreviewInput> = {}): Promise<FooterOutcome> =>
  readParquetFooter(inputFor(object, "f.parquet", changes).input, await loadParquetModules(), freeSlots());

/** A one-page INT32 chunk of `values`, uncompressed unless a codec is named. */
const int32Chunk = (
  name: string,
  values: readonly number[],
  changes: Partial<SyntheticChunk> = {},
): SyntheticChunk => ({
  path: [name],
  type: PHYSICAL.INT32,
  pages: [{ kind: "data", numValues: values.length, body: int32Plain(values) }],
  ...changes,
});

/** Values per BOOLEAN column: two columns together reach the total value cap, so a third goes past it. */
const booleanValues = S3_PREVIEW_LIMITS.parquetMaxTotalValues / 2;

/** Three BOOLEAN columns of `booleanValues` RLE values each, in two pages of half that. */
const threeBooleans = (footerValues?: number): Uint8Array =>
  syntheticParquet({
    schema: [{ name: "schema", children: 3 }, ...["b0", "b1", "b2"].map((name) => ({ name, type: PHYSICAL.BOOLEAN }))],
    rowGroups: [
      {
        numRows: booleanValues,
        chunks: ["b0", "b1", "b2"].map((name) => ({
          path: [name],
          type: PHYSICAL.BOOLEAN,
          numValues: footerValues,
          pages: [0, 1].map(() => ({
            kind: "data" as const,
            numValues: booleanValues / 2,
            encoding: ENCODING.RLE,
            body: booleanRle(booleanValues / 2, true),
          })),
        })),
      },
    ],
  });

/** An INT32 column `id`, then a VARIANT group `v` of two BYTE_ARRAY leaves. */
const withVariant = (): Uint8Array =>
  syntheticParquet({
    schema: [
      { name: "schema", children: 2 },
      { name: "id", type: PHYSICAL.INT32 },
      { name: "v", children: 2, variant: true },
      { name: "metadata", type: PHYSICAL.BYTE_ARRAY },
      { name: "value", type: PHYSICAL.BYTE_ARRAY },
    ],
    rowGroups: [
      {
        numRows: 1,
        chunks: [
          int32Chunk("id", [7]),
          {
            path: ["v", "metadata"],
            type: PHYSICAL.BYTE_ARRAY,
            pages: [{ kind: "data", numValues: 1, body: Uint8Array.of(1, 0, 0, 0, 1) }],
          },
          {
            path: ["v", "value"],
            type: PHYSICAL.BYTE_ARRAY,
            pages: [{ kind: "data", numValues: 1, body: Uint8Array.of(1, 0, 0, 0, 0) }],
          },
        ],
      },
    ],
  });

describe("readParquetFooter", () => {
  test("a tail longer than the footer needs one GET; a footer longer than the tail needs two", async () => {
    const object = fixture("fx-zstd.parquet");
    const one = inputFor(object, "fx-zstd.parquet");
    expect((await readParquetFooter(one.input, await loadParquetModules(), freeSlots())).kind).toBe("footer");
    expect(one.reader.calls).toEqual([{ range: { kind: "suffix", length: object.length }, maxBytes: object.length }]);
    const two = inputFor(object, "fx-zstd.parquet", { limits: limits({ parquetTailBytes: 64 }) });
    const outcome = await readParquetFooter(two.input, await loadParquetModules(), freeSlots());
    expect(outcome.kind === "footer" && outcome.footer.metadata.num_rows).toBe(BigInt(200));
    expect(two.reader.calls).toHaveLength(2);
    expect(two.reader.calls[0]).toEqual({ range: { kind: "suffix", length: 64 }, maxBytes: 64 });
    expect(two.reader.calls[1].range.kind).toBe("span");
  });

  test("an object under 12 bytes is not Parquet and is never read", async () => {
    const small = inputFor(new Uint8Array(11), "f.parquet");
    expect(await readParquetFooter(small.input, await loadParquetModules(), freeSlots())).toEqual({
      kind: "not-parquet",
    });
    expect(small.reader.calls).toEqual([]);
  });

  test("no PAR1 at the end is not Parquet; a tail that covered the whole object is handed back for the hex dump", async () => {
    const whole = new TextEncoder().encode("id,name\n1,a\n2,b\n");
    expect(await footerOutcome(whole)).toEqual({ kind: "not-parquet", held: whole });
    expect(await footerOutcome(new Uint8Array(70_000))).toEqual({ kind: "not-parquet" });
  });

  test("a footer over the cap and a footer longer than the object are refused", async () => {
    expect(await footerOutcome(withTail(2_000_000, 64))).toEqual({
      kind: "refused",
      sentence: "The Parquet footer is 2,000,000 bytes, over the 1,048,576 bytes a preview reads.",
    });
    expect(await footerOutcome(withTail(100, 50))).toEqual({
      kind: "refused",
      sentence: "The Parquet footer declares 100 bytes, more than the object holds.",
    });
  });

  test("a footer the guard refuses names the guard's reason; one hyparquet cannot read says so bare", async () => {
    const magic = [0x50, 0x41, 0x52, 0x31];
    const guarded = Uint8Array.of(...magic, 0x1a, 0x00, 2, 0, 0, 0, ...magic);
    expect(await footerOutcome(guarded)).toEqual({
      kind: "refused",
      sentence: "The Parquet footer could not be read: an unknown Thrift type 10.",
    });
    const empty = Uint8Array.of(...magic, 0x00, 1, 0, 0, 0, ...magic);
    expect(await footerOutcome(empty)).toEqual({ kind: "refused", sentence: "The Parquet footer could not be read." });
  });

  test("a schema nested past the limit is refused with R-PQ-SCHEMA", async () => {
    const chain = Array.from({ length: S3_PREVIEW_LIMITS.parquetMaxSchemaDepth + 1 }, (_, index) => ({
      name: `g${index}`,
      children: 1,
    }));
    const object = syntheticParquet({
      schema: [{ name: "schema", children: 1 }, ...chain, { name: "x", type: PHYSICAL.INT32 }],
      rowGroups: [],
    });
    expect(await footerOutcome(object)).toEqual({
      kind: "refused",
      sentence: "The Parquet schema is nested deeper or wider than the preview reads, so the file is not previewed.",
    });
  });

  test("a first row group whose chunks do not match the schema's leaves is refused", async () => {
    const object = syntheticParquet({
      schema: [
        { name: "schema", children: 2 },
        { name: "a", type: PHYSICAL.INT32 },
        { name: "b", type: PHYSICAL.INT32 },
      ],
      rowGroups: [{ numRows: 1, chunks: [int32Chunk("a", [1])] }],
    });
    expect(await footerOutcome(object)).toEqual({ kind: "refused", sentence: "The Parquet footer could not be read." });
  });

  test("a first row group whose chunk paths differ from the schema's leaves, in schema order, is refused", async () => {
    const schema = [
      { name: "schema", children: 2 },
      { name: "a", type: PHYSICAL.INT32 },
      { name: "b", type: PHYSICAL.INT32 },
    ];
    const twice = syntheticParquet({
      schema,
      rowGroups: [{ numRows: 1, chunks: [int32Chunk("a", [1]), int32Chunk("a", [2])] }],
    });
    expect(await footerOutcome(twice)).toEqual({ kind: "refused", sentence: "The Parquet footer could not be read." });
    const swapped = syntheticParquet({
      schema,
      rowGroups: [{ numRows: 1, chunks: [int32Chunk("b", [1]), int32Chunk("a", [2])] }],
    });
    expect(await footerOutcome(swapped)).toEqual({
      kind: "refused",
      sentence: "The Parquet footer could not be read.",
    });
  });

  test("a chunk path one level deeper than its leaf, and a chunk with no metadata, are refused", async () => {
    const schema = [
      { name: "schema", children: 1 },
      { name: "a", type: PHYSICAL.INT32 },
    ];
    const deeper = syntheticParquet({
      schema,
      rowGroups: [{ numRows: 1, chunks: [int32Chunk("a", [1], { path: ["a", "x"] })] }],
    });
    expect(await footerOutcome(deeper)).toEqual({ kind: "refused", sentence: "The Parquet footer could not be read." });
    const real = await loadParquetModules();
    const withoutMeta: ParquetModules = {
      ...real,
      parquetMetadata: (...args: Parameters<ParquetModules["parquetMetadata"]>) => {
        const metadata = real.parquetMetadata(...args);
        const [chunk] = metadata.row_groups[0].columns;
        delete (chunk as { meta_data?: unknown }).meta_data;
        return metadata;
      },
    };
    const whole = syntheticParquet({ schema, rowGroups: [{ numRows: 1, chunks: [int32Chunk("a", [1])] }] });
    expect(await readParquetFooter(inputFor(whole, "f.parquet").input, withoutMeta, freeSlots())).toEqual({
      kind: "refused",
      sentence: "The Parquet footer could not be read.",
    });
  });

  test("two top-level columns of one name are refused before any plan", async () => {
    const object = syntheticParquet({
      schema: [
        { name: "schema", children: 2 },
        { name: "a", type: PHYSICAL.INT32 },
        { name: "a", type: PHYSICAL.INT32 },
      ],
      rowGroups: [{ numRows: 1, chunks: [int32Chunk("a", [1]), int32Chunk("a", [2])] }],
    });
    expect(await footerOutcome(object)).toEqual({
      kind: "refused",
      sentence: "The Parquet schema gives two columns of one group the same name, so the file is not previewed.",
    });
  });
});

describe("PREVIEW_PARSERS", () => {
  const parsers = PREVIEW_PARSERS as Required<typeof PREVIEW_PARSERS>;

  test("timestamps keep their full fraction and carry no Z", () => {
    expect(parsers.timestampFromMilliseconds(BigInt("1700000000123"))).toBe("2023-11-14T22:13:20.123");
    expect(parsers.timestampFromMicroseconds(BigInt("1700000000123456"))).toBe("2023-11-14T22:13:20.123456");
    expect(parsers.timestampFromNanoseconds(BigInt(1))).toBe("1970-01-01T00:00:00.000000001");
  });

  test("a timestamp before 1970 is floored, not truncated", () => {
    expect(parsers.timestampFromMicroseconds(BigInt(-1))).toBe("1969-12-31T23:59:59.999999");
    expect(parsers.timestampFromMilliseconds(BigInt(-1_500))).toBe("1969-12-31T23:59:58.500");
  });

  test("outside JavaScript's date range a timestamp is its count and unit", () => {
    expect(parsers.timestampFromMilliseconds(BigInt("9000000000000000"))).toBe("9000000000000000 ms");
    expect(parsers.timestampFromMicroseconds(BigInt("-9000000000000000000"))).toBe("-9000000000000000000 us");
    expect(parsers.timestampFromNanoseconds(BigInt("9000000000000000000000000"))).toBe("9000000000000000000000000 ns");
  });

  test("dates", () => {
    expect(parsers.dateFromDays(0)).toBe("1970-01-01");
    expect(parsers.dateFromDays(-1)).toBe("1969-12-31");
    expect(parsers.dateFromDays(200_000_000)).toBe("200000000 days");
  });

  test("strings are strict UTF-8 or stay bytes; JSON stays text; geometry stays bytes", () => {
    const utf8 = new TextEncoder().encode("é");
    expect(parsers.stringFromBytes(utf8)).toBe("é");
    expect(parsers.stringFromBytes(Uint8Array.of(0xff))).toEqual(Uint8Array.of(0xff));
    expect(parsers.stringFromBytes(undefined as unknown as Uint8Array)).toBeUndefined();
    expect(parsers.jsonFromBytes(new TextEncoder().encode('{"a":1}'))).toBe('{"a":1}');
    expect(parsers.geometryFromBytes(Uint8Array.of(1, 2))).toEqual(Uint8Array.of(1, 2));
    expect(parsers.geographyFromBytes(Uint8Array.of(3))).toEqual(Uint8Array.of(3));
    expect("uuidFromBytes" in PREVIEW_PARSERS).toBe(false);
  });
});

describe("planParquet", () => {
  test("leading mode takes every column of a small DuckDB file, rows as asked, with the DECIMAL notice", async () => {
    const footer = await footerOf(fixture("fx-zstd.parquet"));
    const plan = planParquet(footer, {}, "console", S3_PREVIEW_LIMITS);
    expect(plan.kind).toBe("rows");
    if (plan.kind !== "rows") return;
    expect(plan.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "amount",
      "d",
      "ts",
      "flag",
      "dec",
      "blob",
      "big",
      "s",
      "l",
      "maybe",
    ]);
    expect(plan.rowsToRead).toBe(100);
    expect(plan.notices).toContain(
      "Column dec is DECIMAL(18,2): values with more than 15 significant digits are shown rounded.",
    );
    expect(planParquet(footer, {}, "source", S3_PREVIEW_LIMITS)).toMatchObject({ rowsToRead: 100 });
    expect(planParquet(footer, { maxRows: 7 }, "console", S3_PREVIEW_LIMITS)).toMatchObject({ rowsToRead: 7 });
  });

  test("leading mode stops at the fetch budget with N-PQ-SOME-COLUMNS naming the limits in force", async () => {
    const footer = await footerOf(fixture("fx-zstd.parquet"));
    const first = planParquet(footer, { columns: ["id"] }, "console", S3_PREVIEW_LIMITS);
    const idFetch = first.kind === "rows" ? first.columns[0].fetch : 0;
    const plan = planParquet(footer, {}, "console", limits({ parquetFetchBudget: idFetch }));
    expect(plan.kind === "rows" && plan.columns.map((column) => column.name)).toEqual(["id"]);
    expect(plan.notices[0]).toBe(
      `Showing 1 of 12 columns: the next column would take the first row group's read past ${inMiB(idFetch)} MiB, its decoded size past ${decodeCapText} MiB, its leaf columns past ${leafCapText} or its values past ${valueCapText}, the most a preview reads.`,
    );
  });

  test("leading mode stops at maxColumns with N-PQ-MAX-COLUMNS", async () => {
    const plan = planParquet(await footerOf(fixture("fx-zstd.parquet")), {}, "console", limits({ maxColumns: 3 }));
    expect(plan.kind === "rows" && plan.columns).toHaveLength(3);
    expect(plan.notices[0]).toBe("Showing the first 3 of 12 columns, the most a preview shows.");
  });

  test("no column fits: the summary alone with N-PQ-NONE-FIT", async () => {
    const footer = await footerOf(fixture("fx-zstd.parquet"));
    const id = footer.metadata.row_groups[0].columns[0].meta_data;
    const plan = planParquet(footer, {}, "console", limits({ parquetFetchBudget: 1 }));
    expect(plan).toEqual({
      kind: "summary",
      notices: [
        `The first row group is too large to preview: its first column stores ${inMiB(Number(id?.total_compressed_size))} MiB (${inMiB(Number(id?.total_uncompressed_size))} MiB decoded), over the 0.00 MiB read and ${decodeCapText} MiB decode budgets, or holds more leaf columns or values than a preview reads. The schema, row count and first-row-group statistics are shown instead.`,
      ],
    });
  });

  test("the bigcells fixture shows its first column only", async () => {
    const plan = planParquet(await footerOf(fixture("bigcells-zstd.parquet")), {}, "console", S3_PREVIEW_LIMITS);
    expect(plan.kind === "rows" && plan.columns.map((column) => column.name)).toEqual(["id"]);
    expect(plan.notices[0]).toStartWith("Showing 1 of 2 columns:");
  });

  test("a codec the preview cannot read, or a chunk in another file, ends the leading run; explicit mode refuses", async () => {
    const lzo = await footerOf(
      syntheticParquet({
        schema: [
          { name: "schema", children: 2 },
          { name: "id", type: PHYSICAL.INT32 },
          { name: "z", type: PHYSICAL.INT32 },
        ],
        rowGroups: [{ numRows: 1, chunks: [int32Chunk("id", [1]), int32Chunk("z", [2], { codec: CODEC.LZO })] }],
      }),
    );
    expect(planParquet(lzo, {}, "console", S3_PREVIEW_LIMITS).notices).toEqual([
      "Column z is compressed with LZO or stored in another file, which the preview cannot read, so the columns from it on are not shown.",
    ]);
    expect(() => planParquet(lzo, { columns: ["z"] }, "console", S3_PREVIEW_LIMITS)).toThrow(
      new QueryError("Column z is compressed with LZO or stored in another file, which the preview cannot read.", "s3"),
    );
    const elsewhere = await footerOf(
      syntheticParquet({
        schema: [
          { name: "schema", children: 1 },
          { name: "id", type: PHYSICAL.INT32 },
        ],
        rowGroups: [{ numRows: 1, chunks: [int32Chunk("id", [1], { filePath: "other.parquet" })] }],
      }),
    );
    expect(planParquet(elsewhere, {}, "console", S3_PREVIEW_LIMITS)).toEqual({
      kind: "summary",
      notices: [
        "Column id is compressed with UNCOMPRESSED or stored in another file, which the preview cannot read, so the columns from it on are not shown.",
      ],
    });
  });

  test("a VARIANT column ends the leading run; explicit mode refuses it", async () => {
    const footer = await footerOf(withVariant());
    const plan = planParquet(footer, {}, "console", S3_PREVIEW_LIMITS);
    expect(plan.kind === "rows" && plan.columns.map((column) => column.name)).toEqual(["id"]);
    expect(plan.notices).toEqual([
      "Column v holds VARIANT values, which the preview does not decode, so the columns from it on are not shown.",
    ]);
    expect(() => planParquet(footer, { columns: ["id", "v"] }, "console", S3_PREVIEW_LIMITS)).toThrow(
      new QueryError("Column v holds VARIANT values, which the preview does not decode.", "s3"),
    );
  });

  test("explicit mode: an unknown name, and columns over the budgets, are refused before any GET", async () => {
    const footer = await footerOf(fixture("fx-zstd.parquet"));
    expect(() => planParquet(footer, { columns: ["nope"] }, "console", S3_PREVIEW_LIMITS)).toThrow(
      new QueryError("The Parquet file has no top-level column nope.", "s3"),
    );
    expect(() =>
      planParquet(footer, { columns: ["id", "name"] }, "console", limits({ parquetFetchBudget: 64 })),
    ).toThrow(
      new RegExp(
        `^The columns asked for store \\d+\\.\\d\\d MiB \\(\\d+\\.\\d\\d MiB decoded\\) in 2 leaf columns and 400 values in the first row group, over the preview's 0\\.00 MiB read, 32\\.00 MiB decode, ${leafCapText} leaf columns or ${valueCapText} values; ask for fewer columns\\.$`,
      ),
    );
  });

  test("the summed footer values stop leading mode: three BOOLEAN columns of half the value cap each show two", async () => {
    const plan = planParquet(await footerOf(threeBooleans()), {}, "console", S3_PREVIEW_LIMITS);
    expect(plan.kind === "rows" && plan.columns.map((column) => column.name)).toEqual(["b0", "b1"]);
    expect(plan.notices[0]).toStartWith("Showing 2 of 3 columns:");
  });

  test("a struct of parquetMaxLeafColumns + 1 leaves stops leading mode", async () => {
    const leaves = Array.from({ length: S3_PREVIEW_LIMITS.parquetMaxLeafColumns + 1 }, (_, index) => `c${index}`);
    const footer = await footerOf(
      syntheticParquet({
        schema: [
          { name: "schema", children: 2 },
          { name: "id", type: PHYSICAL.INT32 },
          { name: "s", children: leaves.length },
          ...leaves.map((name) => ({ name, type: PHYSICAL.INT32 })),
        ],
        rowGroups: [
          {
            numRows: 1,
            chunks: [int32Chunk("id", [1]), ...leaves.map((name) => int32Chunk(name, [1], { path: ["s", name] }))],
          },
        ],
      }),
    );
    const plan = planParquet(footer, {}, "console", S3_PREVIEW_LIMITS);
    expect(plan.kind === "rows" && plan.columns.map((column) => column.name)).toEqual(["id"]);
    expect(plan.notices[0]).toStartWith("Showing 1 of 2 columns:");
  });

  test("schemaOnly gives the summary with no notice; no rows gives N-PQ-NO-ROWS; a short first row group gives N-PQ-RG0", async () => {
    expect(
      planParquet(await footerOf(fixture("fx-zstd.parquet")), { schemaOnly: true }, "console", S3_PREVIEW_LIMITS),
    ).toEqual({
      kind: "summary",
      notices: [],
    });
    expect(planParquet(await footerOf(fixture("fx-empty.parquet")), {}, "console", S3_PREVIEW_LIMITS)).toEqual({
      kind: "summary",
      notices: ["The file holds no rows."],
    });
    const twoGroups = planParquet(await footerOf(fixture("fx-two-groups.parquet")), {}, "console", S3_PREVIEW_LIMITS);
    expect(twoGroups).toMatchObject({
      kind: "rows",
      rowsToRead: 50,
      rowsAsked: 100,
      notices: ["Rows come from the first row group, which holds 50 rows."],
    });
  });
});

describe("summarizeParquet", () => {
  test("a DuckDB file: counts, the writer, the first row group and its statistics", async () => {
    const { summary, notices } = summarizeParquet(await footerOf(fixture("fx-zstd.parquet")), S3_PREVIEW_LIMITS);
    expect(summary.rows).toBe(200);
    expect(summary.rowGroups).toBe(1);
    expect(summary.createdBy).toStartWith("DuckDB");
    expect(summary.firstRowGroup?.rows).toBe(200);
    expect(summary.columns).toHaveLength(13);
    expect(summary.columns[0]).toMatchObject({
      path: "id",
      type: "INT64 INT_64",
      codec: "ZSTD",
      nulls: 0,
      min: 0,
      max: 199,
    });
    expect(summary.columns.find((column) => column.path === "maybe")?.nulls).toBe(20);
    expect(notices).toEqual([]);
  });

  test("more leaves than maxColumns gives N-COLUMNS; cut statistics cells give N-CELLS with the summary cap", async () => {
    const footer = await footerOf(fixture("fx-zstd.parquet"));
    const few = summarizeParquet(footer, limits({ maxColumns: 5 }));
    expect(few.summary.columns).toHaveLength(5);
    expect(few.notices).toEqual(["Showing the first 5 of 13 columns."]);
    const cut = summarizeParquet(footer, limits({ summaryCellChars: 3 }));
    expect(cut.summary.createdBy).toBe("Duc");
    expect(cut.notices.at(-1)).toMatch(/^\d+ cell\(s\) were cut at 3 characters\.$/);
  });

  test("a column path longer than the summary cap is cut at it and counted in N-CELLS", async () => {
    const name = "a".repeat(10);
    const footer = await footerOf(
      syntheticParquet({
        schema: [
          { name: "schema", children: 1 },
          { name, type: PHYSICAL.INT32 },
        ],
        rowGroups: [{ numRows: 1, chunks: [int32Chunk(name, [1])] }],
      }),
    );
    const { summary, notices } = summarizeParquet(footer, limits({ summaryCellChars: 4 }));
    expect(summary.columns[0].path).toBe("aaaa");
    expect(notices).toEqual(["1 cell(s) were cut at 4 characters."]);
  });

  test("a console summary carries the request's row count for its grid, or the default; the Source tab's none", async () => {
    const object = fixture("fx-zstd.parquet");
    const run = async (changes: Partial<ParquetPreviewInput>) =>
      previewParquet(inputFor(object, "f.parquet", changes).input, depsOf(await loadParquetModules()));
    expect(await run({ request: { schemaOnly: true } })).toMatchObject({
      kind: "parquet",
      summaryRows: S3_PREVIEW_LIMITS.defaultRows,
    });
    expect(await run({ request: { schemaOnly: true, maxRows: 7 } })).toMatchObject({ summaryRows: 7 });
    const source = await run({ request: { schemaOnly: true }, purpose: "source" });
    expect(source.kind === "parquet" && "summaryRows" in source).toBe(false);
  });

  test("a leaf under a VARIANT element is typed group VARIANT, with no statistics", async () => {
    const { summary } = summarizeParquet(await footerOf(withVariant()), S3_PREVIEW_LIMITS);
    expect(summary.columns.map((column) => [column.path, column.type, column.nulls, column.min, column.max])).toEqual([
      ["id", "INT32", null, null, null],
      ["v.metadata", "group VARIANT", null, null, null],
      ["v.value", "group VARIANT", null, null, null],
    ]);
  });

  test("a file with no row group summarizes with no first row group, and plans the summary with N-PQ-NO-ROWS", async () => {
    const footer = await footerOf(
      syntheticParquet({
        schema: [
          { name: "schema", children: 1 },
          { name: "id", type: PHYSICAL.INT32 },
        ],
        rowGroups: [],
      }),
    );
    const { summary } = summarizeParquet(footer, S3_PREVIEW_LIMITS);
    expect(summary).toEqual({ rows: 0, rowGroups: 0, createdBy: null, firstRowGroup: null, columns: [] });
    expect(planParquet(footer, {}, "console", S3_PREVIEW_LIMITS)).toEqual({
      kind: "summary",
      notices: ["The file holds no rows."],
    });
  });
});

const expected = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../../fixtures/s3/preview/fx-expected.json"), "utf8"),
) as {
  columns: string[];
  rows: S3PreviewCell[][];
};

/** The real modules with parquetMetadata and parquetReadObjects wrapped to record their calls. */
async function spiedModules(
  change?: (options: Parameters<ParquetModules["parquetReadObjects"]>[0]) => Promise<unknown>,
) {
  const real = await loadParquetModules();
  const calls = { metadata: 0, read: [] as string[][] };
  const modules: ParquetModules = {
    ...real,
    parquetMetadata: (...args: Parameters<ParquetModules["parquetMetadata"]>) => {
      calls.metadata += 1;
      return real.parquetMetadata(...args);
    },
    parquetReadObjects: (async (options: Parameters<ParquetModules["parquetReadObjects"]>[0]) => {
      calls.read.push([...(options.columns ?? [])]);
      if (change !== undefined) return change(options);
      return real.parquetReadObjects(options);
    }) as ParquetModules["parquetReadObjects"],
  };
  return { modules, calls, real };
}

const depsOf = (modules: ParquetModules, slots = createDecodeSlots(2, 4)) => ({ modules: async () => modules, slots });
/** Waits a tick at a time until `until` holds; fails the test when it still does not after 2,000 ticks. */
const settle = async (until: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 2_000; tick += 1) {
    if (until()) return;
    // oxlint-disable-next-line no-await-in-loop -- each tick waits for the one before it.
    await Bun.sleep(1);
  }
  throw new Error("The awaited condition did not hold within 2,000 ticks");
};

/** Decode slots that count the previews that asked for a slot; one past the free slots is a queued waiter. */
function countingSlots(inner: DecodeSlots) {
  const asked = { count: 0 };
  const slots: DecodeSlots = {
    acquire(signal) {
      asked.count += 1;
      return inner.acquire(signal);
    },
  };
  return { slots, asked };
}

describe("previewParquet: reads and rows", () => {
  for (const codec of ["uncompressed", "snappy", "gzip", "zstd", "brotli", "lz4_raw"]) {
    test(`fx-${codec}: the first 100 rows equal fx-expected.json`, async () => {
      const object = fixture(`fx-${codec}.parquet`);
      const { input } = inputFor(object, `fx-${codec}.parquet`);
      const preview = await previewParquet(input);
      expect(preview.kind).toBe("parquet");
      if (preview.kind !== "parquet") return;
      expect(preview.rows?.columns.map((column) => column.name)).toEqual(expected.columns);
      expect(preview.rows?.rows).toEqual(expected.rows);
    });
  }

  test("a DuckDB file needs one tail GET and one GET for its contiguous chunks, within the fetch bound", async () => {
    const object = fixture("fx-zstd.parquet");
    const { input, reader } = inputFor(object, "fx-zstd.parquet");
    const footer = await footerOf(object);
    const plan = planParquet(footer, {}, "console", S3_PREVIEW_LIMITS);
    const fetch = plan.kind === "rows" ? plan.columns.reduce((sum, column) => sum + column.fetch, 0) : 0;
    await previewParquet(input);
    expect(reader.calls).toHaveLength(2);
    expect(reader.calls[0].range.kind).toBe("suffix");
    expect(reader.calls[1].range.kind).toBe("span");
    expect(reader.calls[1].maxBytes).toBe(fetch);
    const fetched = reader.calls.reduce((sum, call) => sum + call.maxBytes, 0);
    expect(fetched).toBeLessThanOrEqual(
      S3_PREVIEW_LIMITS.parquetTailBytes +
        S3_PREVIEW_LIMITS.parquetFooterMaxBytes +
        S3_PREVIEW_LIMITS.parquetFetchBudget,
    );
  });

  test("the Source tab reads sourceRows; a console --max-rows reads that many", async () => {
    const object = fixture("fx-zstd.parquet");
    const source = await previewParquet(
      inputFor(object, "f.parquet", { purpose: "source", limits: limits({ sourceRows: 3 }) }).input,
    );
    expect(source.kind === "parquet" && source.rows?.rows).toHaveLength(3);
    const asked = await previewParquet(inputFor(object, "f.parquet", { request: { maxRows: 5 } }).input);
    expect(asked.kind === "parquet" && asked.rows?.rows).toHaveLength(5);
    expect(asked.kind === "parquet" && asked.notices).toContain("The preview stops at 5 rows.");
  });

  test("the bigcells fixture shows its id column only, decoding nothing of the 200 MB column", async () => {
    const preview = await previewParquet(inputFor(fixture("bigcells-zstd.parquet"), "b.parquet").input);
    expect(preview.kind === "parquet" && preview.rows?.columns.map((column) => column.name)).toEqual(["id"]);
    expect(preview.kind === "parquet" && preview.rows?.rows.slice(0, 3)).toEqual([[0], [1], [2]]);
  });

  test("the summary and its notices come with the rows; a DECIMAL above 15 digits is named", async () => {
    const preview = await previewParquet(inputFor(fixture("fx-zstd.parquet"), "f.parquet").input);
    expect(preview.kind === "parquet" && preview.summary.rowGroups).toBe(1);
    expect(preview.kind === "parquet" && preview.notices).toContain(
      "Column dec is DECIMAL(18,2): values with more than 15 significant digits are shown rounded.",
    );
  });

  test("a summary-only plan, a refused footer and a file that is not Parquet pass through", async () => {
    expect(
      await previewParquet(inputFor(fixture("fx-zstd.parquet"), "f.parquet", { request: { schemaOnly: true } }).input),
    ).toMatchObject({
      kind: "parquet",
      notices: [],
    });
    expect(await previewParquet(inputFor(withTail(100, 50), "f.parquet").input)).toEqual({
      kind: "refused",
      sentence: "The Parquet footer declares 100 bytes, more than the object holds.",
      notices: [],
    });
    expect((await previewParquet(inputFor(new Uint8Array(70_000), "f.parquet").input)).kind).toBe("not-parquet");
  });
});

describe("previewParquet: what never reaches hyparquet", () => {
  test("a footer the guard refuses never reaches parquetMetadata", async () => {
    const { modules, calls } = await spiedModules();
    const magic = [0x50, 0x41, 0x52, 0x31];
    const object = Uint8Array.of(...magic, 0x1a, 0x00, 2, 0, 0, 0, ...magic);
    expect((await previewParquet(inputFor(object, "f.parquet").input, depsOf(modules))).kind).toBe("refused");
    expect(calls.metadata).toBe(0);
  });

  test("a schema nested past the limit never reaches parquetReadObjects, and the module never calls parquetSchema", async () => {
    const { modules, calls } = await spiedModules();
    const chain = Array.from({ length: S3_PREVIEW_LIMITS.parquetMaxSchemaDepth + 1 }, (_, index) => ({
      name: `g${index}`,
      children: 1,
    }));
    const object = syntheticParquet({
      schema: [{ name: "schema", children: 1 }, ...chain, { name: "x", type: PHYSICAL.INT32 }],
      rowGroups: [
        { numRows: 1, chunks: [{ ...int32Chunk("x", [1]), path: [...chain.map((element) => element.name), "x"] }] },
      ],
    });
    expect(await previewParquet(inputFor(object, "f.parquet").input, depsOf(modules))).toMatchObject({
      kind: "refused",
    });
    expect(calls.read).toEqual([]);
    const source = readFileSync(
      path.join(import.meta.dir, "../../../../src/lib/db/providers/objectstore/s3/preview-parquet.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/parquetSchema\s*\(/);
  });

  test("a VARIANT column is never passed to parquetReadObjects: leading mode stops before it, explicit mode refuses it", async () => {
    const { modules, calls } = await spiedModules();
    const leading = await previewParquet(inputFor(withVariant(), "v.parquet").input, depsOf(modules));
    expect(leading.kind === "parquet" && leading.rows?.rows).toEqual([[7]]);
    expect(leading.kind === "parquet" && leading.notices[0]).toBe(
      "Column v holds VARIANT values, which the preview does not decode, so the columns from it on are not shown.",
    );
    await expect(
      previewParquet(inputFor(withVariant(), "v.parquet", { request: { columns: ["v"] } }).input, depsOf(modules)),
    ).rejects.toThrow("Column v holds VARIANT values, which the preview does not decode.");
    expect(calls.read).toEqual([["id"]]);
  });

  test("two top-level columns of one name, a VARIANT group then a plain group, are refused before parquetReadObjects", async () => {
    const { modules, calls } = await spiedModules();
    const byteChunk = (leaf: string, last: number) => ({
      path: ["v", leaf],
      type: PHYSICAL.BYTE_ARRAY,
      pages: [{ kind: "data" as const, numValues: 1, body: Uint8Array.of(1, 0, 0, 0, last) }],
    });
    const object = syntheticParquet({
      schema: [
        { name: "schema", children: 2 },
        { name: "v", children: 2, variant: true },
        { name: "metadata", type: PHYSICAL.BYTE_ARRAY },
        { name: "value", type: PHYSICAL.BYTE_ARRAY },
        { name: "v", children: 2 },
        { name: "metadata", type: PHYSICAL.BYTE_ARRAY },
        { name: "value", type: PHYSICAL.BYTE_ARRAY },
      ],
      rowGroups: [
        {
          numRows: 1,
          chunks: [byteChunk("metadata", 1), byteChunk("value", 0), byteChunk("metadata", 1), byteChunk("value", 0)],
        },
      ],
    });
    expect(
      await previewParquet(inputFor(object, "v.parquet", { request: { columns: ["v"] } }).input, depsOf(modules)),
    ).toMatchObject({
      kind: "refused",
      sentence: "The Parquet schema gives two columns of one group the same name, so the file is not previewed.",
    });
    expect(calls.read).toEqual([]);
  });

  test("three BOOLEAN columns of half the value cap decode two; understated footer counts are refused by the pre-scan before decode", async () => {
    const { modules, calls } = await spiedModules();
    const two = await previewParquet(inputFor(threeBooleans(), "b.parquet").input, depsOf(modules));
    expect(two.kind === "parquet" && two.rows?.columns.map((column) => column.name)).toEqual(["b0", "b1"]);
    expect(two.kind === "parquet" && two.rows?.rows[0]).toEqual([true, true]);
    calls.read.length = 0;
    expect(await previewParquet(inputFor(threeBooleans(1), "b.parquet").input, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: `The data pages of column b0 declare ${booleanValues.toLocaleString("en-US")} values, more than its column chunk holds or the preview allows, so the file is not previewed.`,
      notices: [],
    });
    expect(calls.read).toEqual([]);
  });

  test("a chunk placed outside the data, pages that overrun their chunk, a page over the value cap and pages over the decode budget are refused", async () => {
    const { modules, calls } = await spiedModules();
    const one = (chunk: SyntheticChunk, type: number = PHYSICAL.INT32) =>
      syntheticParquet({
        schema: [
          { name: "schema", children: 1 },
          { name: chunk.path[0], type },
        ],
        rowGroups: [{ numRows: 1, chunks: [chunk] }],
      });
    const outcome = async (object: Uint8Array, changes: Partial<ParquetPreviewInput> = {}) =>
      previewParquet(inputFor(object, "f.parquet", changes).input, depsOf(modules));
    expect(await outcome(one(int32Chunk("id", [1], { dataPageOffset: 2 })))).toMatchObject({
      sentence: "The Parquet footer places column id outside the file's data, so the file is not previewed.",
    });
    const plain = one(int32Chunk("id", [1]));
    const actual = Number((await footerOf(plain)).metadata.row_groups[0].columns[0].meta_data?.total_compressed_size);
    expect(await outcome(one(int32Chunk("id", [1], { totalCompressedSize: actual - 1 })))).toMatchObject({
      sentence: "The pages of column id do not fill its column chunk, so the file is not previewed.",
    });
    // The page cap equals the chunk and total caps, so a page over it would never be planned; a lower page cap
    // isolates the page check.
    const pageCap = S3_PREVIEW_LIMITS.parquetMaxPageValues / 2;
    const overPage: SyntheticChunk = {
      path: ["b"],
      type: PHYSICAL.BOOLEAN,
      pages: [{ kind: "data", numValues: pageCap + 1, encoding: ENCODING.RLE, body: booleanRle(pageCap + 1, true) }],
    };
    expect(
      await outcome(one(overPage, PHYSICAL.BOOLEAN), { limits: limits({ parquetMaxPageValues: pageCap }) }),
    ).toMatchObject({
      sentence: `A page of column b declares ${(pageCap + 1).toLocaleString("en-US")} values, more than its column chunk holds or the preview allows, so the file is not previewed.`,
    });
    const overDecode = int32Chunk("id", [1], { totalUncompressedSize: 8 });
    const lying = { ...overDecode, pages: [{ ...overDecode.pages[0], uncompressedSize: 40_000_000 }] };
    expect(await outcome(one(lying))).toMatchObject({
      sentence: `The pages of the columns to show declare 38.15 MiB decoded, over the ${decodeCapText} MiB a preview decodes, so the file is not previewed.`,
    });
    expect(calls.read).toEqual([]);
  });

  test("a slice outside the planned ranges, or any other throw inside the decode, is R-PQ-DECODE", async () => {
    let message = "";
    const { modules } = await spiedModules(async (options) => {
      try {
        await options.file.slice(0, 4);
      } catch (error) {
        message = (error as Error).message;
      }
      throw new Error("boom");
    });
    expect(await previewParquet(inputFor(fixture("fx-zstd.parquet"), "f.parquet").input, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: "The Parquet data could not be decoded.",
      notices: [],
    });
    expect(message).toBe("The Parquet reader asked for bytes outside the planned ranges");
  });
});

describe("prescanChunk", () => {
  test("a dictionary page then three data pages whose values sum to the footer's passes", () => {
    const pages = syntheticParquet({
      schema: [
        { name: "schema", children: 1 },
        { name: "id", type: PHYSICAL.INT32 },
      ],
      rowGroups: [
        {
          numRows: 30,
          chunks: [
            {
              path: ["id"],
              type: PHYSICAL.INT32,
              pages: [
                { kind: "dictionary", numValues: 3, body: int32Plain([1, 2, 3]) },
                ...[0, 1, 2].map(() => ({ kind: "data" as const, numValues: 10, body: new Uint8Array(4) })),
              ],
            },
          ],
        },
      ],
    });
    const chunk = pages.subarray(4, pages.length - 8 - new DataView(pages.buffer).getUint32(pages.length - 8, true));
    const totals = { values: 0, decoded: 0 };
    expect(() => prescanChunk(chunk, 30, "id", S3_PREVIEW_LIMITS, totals)).not.toThrow();
    expect(totals.values).toBe(33);
  });

  test("dictionary pages count toward the total value cap", () => {
    const pages = syntheticParquet({
      schema: [
        { name: "schema", children: 1 },
        { name: "id", type: PHYSICAL.INT32 },
      ],
      rowGroups: [
        {
          numRows: 10,
          chunks: [
            {
              path: ["id"],
              type: PHYSICAL.INT32,
              pages: [
                { kind: "dictionary", numValues: 3, body: int32Plain([1, 2, 3]) },
                { kind: "data", numValues: 10, body: new Uint8Array(4) },
              ],
            },
          ],
        },
      ],
    });
    const chunk = pages.subarray(4, pages.length - 8 - new DataView(pages.buffer).getUint32(pages.length - 8, true));
    expect(() =>
      prescanChunk(chunk, 10, "id", limits({ parquetMaxTotalValues: 12 }), { values: 0, decoded: 0 }),
    ).toThrow(
      "The pages of the columns to show declare 13 values, more than a preview allows, so the file is not previewed.",
    );
  });

  test("data pages that sum past the footer's count are refused with the chunk's sentence", () => {
    expect(() => prescanChunk(dataChunk([6, 6]), 10, "id", S3_PREVIEW_LIMITS, { values: 0, decoded: 0 })).toThrow(
      new PreviewRefusal(
        "The data pages of column id declare 12 values, more than its column chunk holds or the preview allows, so the file is not previewed.",
      ),
    );
  });
});

/** The page bytes of a one-column INT32 file of the given data pages, as prescanChunk reads one chunk. */
function dataChunk(values: readonly number[]): Uint8Array {
  const pages = syntheticParquet({
    schema: [
      { name: "schema", children: 1 },
      { name: "id", type: PHYSICAL.INT32 },
    ],
    rowGroups: [
      {
        numRows: 10,
        chunks: [
          {
            path: ["id"],
            type: PHYSICAL.INT32,
            numValues: 10,
            pages: values.map((numValues) => ({ kind: "data" as const, numValues, body: new Uint8Array(4) })),
          },
        ],
      },
    ],
  });
  return pages.subarray(4, pages.length - 8 - new DataView(pages.buffer).getUint32(pages.length - 8, true));
}

describe("prescanChunk: negative page counts", () => {
  test("a page that declares a negative value count is refused", () => {
    expect(() => prescanChunk(dataChunk([10, -5]), 5, "id", S3_PREVIEW_LIMITS, { values: 0, decoded: 0 })).toThrow(
      new PreviewRefusal("The pages of column id do not fill its column chunk, so the file is not previewed."),
    );
  });

  test("a negative page count in the first chunk is refused before a later chunk is scanned", () => {
    const capped = limits({ parquetMaxTotalValues: 12 });
    const totals = { values: 0, decoded: 0 };
    expect(() => {
      prescanChunk(dataChunk([10, -8]), 2, "a", capped, totals);
      prescanChunk(dataChunk([10]), 10, "b", capped, totals);
    }).toThrow(new PreviewRefusal("The pages of column a do not fill its column chunk, so the file is not previewed."));
  });
});

describe("prescanChunk: the total across chunks", () => {
  test("two chunks of 8 values each pass alone and are refused together under a total cap of 12", () => {
    const capped = limits({ parquetMaxTotalValues: 12 });
    const totals = { values: 0, decoded: 0 };
    prescanChunk(dataChunk([8]), 10, "a", capped, totals);
    expect(totals.values).toBe(8);
    expect(() => prescanChunk(dataChunk([8]), 10, "b", capped, totals)).toThrow(
      new PreviewRefusal(
        "The pages of the columns to show declare 16 values, more than a preview allows, so the file is not previewed.",
      ),
    );
  });
});

describe("guardedCompressors", () => {
  test("each of the six codecs refuses a declared length over the budget left, legacy LZ4 included", async () => {
    const modules = await loadParquetModules();
    for (const codec of ["SNAPPY", "GZIP", "BROTLI", "ZSTD", "LZ4", "LZ4_RAW"] as const) {
      const compressors = guardedCompressors(10, modules);
      expect(() => compressors[codec]?.(new Uint8Array(1), 11), codec).toThrow(DECODE_OVER_BUDGET);
    }
  });

  test("a non-integer output length is refused before the codec runs, and the budget stays whole", async () => {
    const modules = await loadParquetModules();
    let calls = 0;
    const counting = (input: Uint8Array, outputLength: number): Uint8Array => {
      calls += 1;
      return modules.codecs.lz4Raw(input, outputLength);
    };
    const spied: ParquetModules = {
      ...modules,
      snappyUncompress: () => {
        calls += 1;
      },
      codecs: { gzip: counting, brotli: counting, zstd: () => new Uint8Array(0), lz4: counting, lz4Raw: counting },
    };
    for (const codec of ["SNAPPY", "GZIP", "BROTLI", "ZSTD", "LZ4", "LZ4_RAW"] as const) {
      const compressors = guardedCompressors(1_024, spied);
      for (const length of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
        expect(() => compressors[codec]?.(new Uint8Array(0), length), `${codec} ${length}`).toThrow(DECODE_OVER_BUDGET);
      }
      expect(() => compressors[codec]?.(new Uint8Array(0), 2 ** 31), codec).toThrow(DECODE_OVER_BUDGET);
    }
    expect(calls).toBe(0);
  });

  test("the budget is spent by each call, and a call within it decodes", async () => {
    const compressors = guardedCompressors(10, await loadParquetModules());
    const stored = new Uint8Array(gzipSync(new TextEncoder().encode("hello")));
    expect(new TextDecoder().decode(compressors.GZIP?.(stored, 5))).toBe("hello");
    expect(() => compressors.GZIP?.(stored, 6)).toThrow(DECODE_OVER_BUDGET);
  });
});

describe("boundedZlib", () => {
  const zeros = new Uint8Array(1_000_000);
  const codecs = [
    { name: "gzip", decode: boundedZlib(gunzipSync), packed: new Uint8Array(gzipSync(zeros)) },
    { name: "brotli", decode: boundedZlib(brotliDecompressSync), packed: new Uint8Array(brotliCompressSync(zeros)) },
  ];

  test("an output past the declared length stops at that length with DECODE_OVER_BUDGET", () => {
    for (const { name, decode, packed } of codecs) {
      expect(() => decode(packed, 1000), name).toThrow(DECODE_OVER_BUDGET);
    }
  });

  test("an output of exactly the declared length decodes to a Uint8Array of that length", () => {
    for (const { name, decode, packed } of codecs) {
      const output = decode(packed, 1_000_000);
      expect(output.length, name).toBe(1_000_000);
      expect(output, name).toBeInstanceOf(Uint8Array);
      expect(Buffer.isBuffer(output), name).toBe(false);
    }
  });

  test("an output shorter than the declared length is refused with DECODE_OVER_BUDGET", () => {
    for (const { name, decode, packed } of codecs) {
      expect(() => decode(packed, 1_000_001), name).toThrow(DECODE_OVER_BUDGET);
    }
  });

  test("a zero declared length decodes an empty stream and refuses a stream that holds bytes", () => {
    expect(boundedZlib(gunzipSync)(new Uint8Array(gzipSync(new Uint8Array(0))), 0)).toHaveLength(0);
    expect(boundedZlib(brotliDecompressSync)(new Uint8Array(brotliCompressSync(new Uint8Array(0))), 0)).toHaveLength(0);
    expect(() => boundedZlib(gunzipSync)(new Uint8Array(gzipSync(new Uint8Array(1))), 0)).toThrow(DECODE_OVER_BUDGET);
  });

  test("a corrupt stream throws zlib's own error, not DECODE_OVER_BUDGET", () => {
    for (const { name, decode } of codecs) {
      let message = "";
      try {
        decode(new Uint8Array([1, 2, 3]), 10);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, name).not.toBe("");
      expect(message, name).not.toBe(DECODE_OVER_BUDGET);
    }
  });
});

describe("the process-wide decode slot", () => {
  /** Real modules whose decode waits on a gate per call, while `gated` holds; footer parses are counted. */
  async function gatedModules() {
    const real = await loadParquetModules();
    const started: number[] = [];
    const gates: (() => void)[] = [];
    const state = { gated: true, footers: 0 };
    const modules: ParquetModules = {
      ...real,
      parquetMetadata: (...args: Parameters<ParquetModules["parquetMetadata"]>) => {
        state.footers += 1;
        return real.parquetMetadata(...args);
      },
      parquetReadObjects: (async (options: Parameters<ParquetModules["parquetReadObjects"]>[0]) => {
        const id = started.length;
        started.push(id);
        if (state.gated)
          await new Promise<void>((resolve) => {
            gates[id] = resolve;
          });
        return real.parquetReadObjects(options);
      }) as ParquetModules["parquetReadObjects"],
    };
    const open = (id: number): void => gates[id]?.();
    return { modules, started, open, state };
  }

  test("of three concurrent previews, two decode at once and the third starts only after one returns", async () => {
    const { modules, started, open, state } = await gatedModules();
    const { slots, asked } = countingSlots(createDecodeSlots(2, 4));
    const deps = depsOf(modules, slots);
    const object = fixture("fx-zstd.parquet");
    const runs = [0, 1, 2].map(() => previewParquet(inputFor(object, "f.parquet").input, deps));
    await settle(() => started.length === 2 && asked.count === 6);
    expect(started).toEqual([0, 1]);
    open(0);
    await settle(() => started.length === 3);
    expect(started).toEqual([0, 1, 2]);
    state.gated = false;
    open(1);
    open(2);
    expect((await Promise.all(runs)).map((each) => each.kind)).toEqual(["parquet", "parquet", "parquet"]);
  });

  test("with two decodes running and four waiting, the next preview gets R-PQ-BUSY at its footer parse and sends no GET after the tail", async () => {
    const { modules, started, open, state } = await gatedModules();
    const { slots, asked } = countingSlots(createDecodeSlots(2, 4));
    const deps = depsOf(modules, slots);
    const object = fixture("fx-zstd.parquet");
    const runs = Array.from({ length: 6 }, () => previewParquet(inputFor(object, "f.parquet").input, deps));
    await settle(() => started.length === 2 && asked.count === 12);
    const busy = inputFor(object, "f.parquet");
    expect(await previewParquet(busy.input, deps)).toEqual({
      kind: "refused",
      sentence: "The server is decoding other Parquet previews; preview this object again in a moment.",
      notices: [],
    });
    expect(busy.reader.calls).toHaveLength(1);
    expect(state.footers).toBe(6);
    state.gated = false;
    for (let id = 0; id < 6; id += 1) open(id);
    await Promise.all(runs);
  });

  test("a waiter whose signal aborts leaves the queue and rejects with the abort", async () => {
    const slots = createDecodeSlots(1, 4);
    const release = await slots.acquire(new AbortController().signal);
    const waiter = new AbortController();
    const waiting = slots.acquire(waiter.signal);
    waiter.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    release();
    const next = await slots.acquire(new AbortController().signal);
    next();
  });

  test("a decode that throws releases the slot: a following preview decodes", async () => {
    const slots = createDecodeSlots(1, 4);
    const failing = await spiedModules(async () => {
      throw new Error("boom");
    });
    const object = fixture("fx-zstd.parquet");
    expect((await previewParquet(inputFor(object, "f.parquet").input, depsOf(failing.modules, slots))).kind).toBe(
      "refused",
    );
    const working = await spiedModules();
    expect((await previewParquet(inputFor(object, "f.parquet").input, depsOf(working.modules, slots))).kind).toBe(
      "parquet",
    );
  });

  for (const [when, at] of [
    ["its footer parse", 1],
    ["its decode", 2],
  ] as const) {
    test(`a preview aborted right after it acquires the slot for ${when} releases it`, async () => {
      const inner = createDecodeSlots(1, 4);
      const controller = new AbortController();
      let acquired = 0;
      const slots = {
        acquire: async (signal: AbortSignal) => {
          const release = await inner.acquire(signal);
          acquired += 1;
          if (acquired === at) controller.abort();
          return release;
        },
      };
      const { modules, calls } = await spiedModules();
      const object = fixture("fx-zstd.parquet");
      await expect(
        previewParquet(inputFor(object, "f.parquet", { signal: controller.signal }).input, depsOf(modules, slots)),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(calls.metadata).toBe(at - 1);
      expect(calls.read).toEqual([]);
      const again = await inner.acquire(new AbortController().signal);
      again();
    });
  }

  test("a footer parse waits for a free slot while two decodes hold both", async () => {
    const { modules, started, open, state } = await gatedModules();
    const { slots, asked } = countingSlots(createDecodeSlots(2, 4));
    const deps = depsOf(modules, slots);
    const object = fixture("fx-zstd.parquet");
    const runs = [0, 1].map(() => previewParquet(inputFor(object, "f.parquet").input, deps));
    await settle(() => started.length === 2 && asked.count === 4);
    expect(state.footers).toBe(2);
    runs.push(previewParquet(inputFor(object, "f.parquet").input, deps));
    await settle(() => asked.count === 5);
    expect(state.footers).toBe(2);
    state.gated = false;
    open(0);
    await settle(() => state.footers === 3);
    open(1);
    expect((await Promise.all(runs)).map((each) => each.kind)).toEqual(["parquet", "parquet", "parquet"]);
  });

  test("a footer parse that throws releases its slot", async () => {
    const slots = createDecodeSlots(1, 0);
    const { modules } = await spiedModules();
    const failing: ParquetModules = {
      ...modules,
      parquetMetadata: () => {
        throw new Error("boom");
      },
    };
    const object = fixture("fx-zstd.parquet");
    expect(await previewParquet(inputFor(object, "f.parquet").input, depsOf(failing, slots))).toEqual({
      kind: "refused",
      sentence: "The Parquet footer could not be read.",
      notices: [],
    });
    const next = await slots.acquire(new AbortController().signal);
    next();
  });
});

describe("prescanChunk reads each page's count where hyparquet does", () => {
  test("a dictionary page whose field 7 count is over the page cap is refused, whatever a decoy field 5 says", () => {
    const header = thriftStruct([
      [1, { i32: 2 }],
      [2, { i32: 16 }],
      [3, { i32: 16 }],
      [5, { struct: [[1, { i32: 1 }]] }],
      [
        7,
        {
          struct: [
            [1, { i32: 50_000_000 }],
            [2, { i32: 0 }],
          ],
        },
      ],
    ]);
    const chunk = new Uint8Array([...header, ...new Uint8Array(16)]);
    expect(() => prescanChunk(chunk, 1, "a", S3_PREVIEW_LIMITS, { values: 0, decoded: 0 })).toThrow(
      new PreviewRefusal(
        "A page of column a declares 50,000,000 values, more than its column chunk holds or the preview allows, so the file is not previewed.",
      ),
    );
  });
});

describe("a codec id hyparquet has no name for", () => {
  /** One INT32 column whose chunk names codec id 8, past the format's table. */
  const unnamed = (): Uint8Array =>
    syntheticParquet({
      schema: [
        { name: "schema", children: 1 },
        { name: "a", type: PHYSICAL.INT32 },
      ],
      rowGroups: [{ numRows: 2, chunks: [int32Chunk("a", [1, 2], { codec: 8 })] }],
    });

  test("leading mode names it in N-PQ-CODEC, explicit mode in R-PQ-COLUMN-CODEC, and the summary shows the same name", async () => {
    const footer = await footerOf(unnamed());
    expect(planParquet(footer, {}, "source", S3_PREVIEW_LIMITS)).toEqual({
      kind: "summary",
      notices: [
        "Column a is compressed with an unknown codec or stored in another file, which the preview cannot read, so the columns from it on are not shown.",
      ],
    });
    expect(() => planParquet(footer, { columns: ["a"] }, "console", S3_PREVIEW_LIMITS)).toThrow(
      new QueryError(
        "Column a is compressed with an unknown codec or stored in another file, which the preview cannot read.",
        "s3",
      ),
    );
    expect(summarizeParquet(footer, S3_PREVIEW_LIMITS).summary.columns[0].codec).toBe("an unknown codec");
  });

  test("a preview of such a file answers with the summary for both purposes", async () => {
    const outcomes = await Promise.all(
      (["source", "console"] as const).map((purpose) =>
        previewParquet(inputFor(unnamed(), "u.parquet", { purpose }).input),
      ),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["parquet", "parquet"]);
  });
});

describe("the footer's list budget, before hyparquet parses the footer", () => {
  test("a schema list over parquetMaxLeafColumns times 8 elements is refused with R-PQ-SCHEMA and never reaches parquetMetadata", async () => {
    const { modules, calls } = await spiedModules();
    const width = S3_PREVIEW_LIMITS.parquetMaxLeafColumns * 8;
    const object = syntheticParquet({
      schema: [
        { name: "schema", children: width },
        ...Array.from({ length: width }, (_, index) => ({ name: `c${index}`, type: PHYSICAL.INT32 })),
      ],
      rowGroups: [],
    });
    expect(await previewParquet(inputFor(object, "w.parquet").input, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: "The Parquet schema is nested deeper or wider than the preview reads, so the file is not previewed.",
      notices: [],
    });
    expect(calls.metadata).toBe(0);
  });

  test("a footer whose lists declare more elements in all than the budget is refused and never reaches parquetMetadata", async () => {
    const { modules, calls } = await spiedModules();
    const small = limits({ parquetMaxLeafColumns: 1 });
    const budget = small.parquetMaxLeafColumns * 8 * 128;
    const object = syntheticParquet({
      schema: [
        { name: "schema", children: 1 },
        { name: "a", type: PHYSICAL.INT32 },
      ],
      rowGroups: Array.from({ length: Math.ceil(budget / 5) + 1 }, () => ({
        numRows: 1,
        chunks: [int32Chunk("a", [1])],
      })),
    });
    expect(await previewParquet(inputFor(object, "g.parquet", { limits: small }).input, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: `The Parquet footer could not be read: the lists declare more than ${budget.toLocaleString("en-US")} elements in all.`,
      notices: [],
    });
    expect(calls.metadata).toBe(0);
    const fewer = syntheticParquet({
      schema: [
        { name: "schema", children: 1 },
        { name: "a", type: PHYSICAL.INT32 },
      ],
      rowGroups: Array.from({ length: Math.floor((budget - 2) / 5) }, () => ({
        numRows: 1,
        chunks: [int32Chunk("a", [1])],
      })),
    });
    expect((await footerOutcome(fewer, { limits: small })).kind).toBe("footer");
  });
});

/** An LZ4 block of literals "abcd", a match of 8 at offset 4, then the literal "e": "abcdabcdabcde". */
const LZ4_BLOCK = Uint8Array.of(0x44, 0x61, 0x62, 0x63, 0x64, 4, 0, 0x10, 0x65);
const LZ4_TEXT = "abcdabcdabcde";
/** One Hadoop LZ4 frame: big-endian output and input lengths, then the block. */
const hadoopFrame = (block: Uint8Array, outputLength: number): number[] => {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, outputLength);
  new DataView(header.buffer).setUint32(4, block.length);
  return [...header, ...block];
};
/** A block whose one match runs `inputBytes` long through 255-valued length bytes, far past any small output. */
const longMatch = (inputBytes: number): Uint8Array => {
  const input = new Uint8Array(inputBytes).fill(255);
  input.set([0x1f, 0x41, 1, 0], 0);
  input[inputBytes - 1] = 0;
  return input;
};

describe("the bounded LZ4 decoders", () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  test("a raw block decodes to exactly its declared length", () => {
    expect(text(boundedLz4Raw(LZ4_BLOCK, 13))).toBe(LZ4_TEXT);
    expect(boundedLz4Raw(new Uint8Array(0), 0)).toHaveLength(0);
  });

  test("a match or a literal run that would pass the declared length stops with DECODE_OVER_BUDGET", () => {
    expect(() => boundedLz4Raw(LZ4_BLOCK, 12)).toThrow(DECODE_OVER_BUDGET);
    expect(() => boundedLz4Raw(LZ4_BLOCK, 3)).toThrow(DECODE_OVER_BUDGET);
  });

  test("an output shorter than the declared length is refused with DECODE_OVER_BUDGET", () => {
    expect(() => boundedLz4Raw(LZ4_BLOCK, 14)).toThrow(DECODE_OVER_BUDGET);
  });

  test("a match running far past the declared length is refused within a short time, raw and legacy alike", async () => {
    const modules = await loadParquetModules();
    const input = longMatch(4_000_000);
    for (const [name, decode] of [
      ["LZ4_RAW", modules.codecs.lz4Raw],
      ["LZ4", modules.codecs.lz4],
    ] as const) {
      const started = performance.now();
      expect(() => decode(input, 100), name).toThrow(DECODE_OVER_BUDGET);
      expect(performance.now() - started, name).toBeLessThan(500);
    }
  });

  test("malformed blocks throw an error of their own", () => {
    for (const block of [
      Uint8Array.of(0x50, 0x61),
      Uint8Array.of(0x04),
      Uint8Array.of(0x04, 0, 0),
      Uint8Array.of(0x10, 0x61, 5, 0),
      Uint8Array.of(0xf0),
      Uint8Array.of(0x1f, 0x61, 1, 0),
    ]) {
      let message = "";
      try {
        boundedLz4Raw(block, 100);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `${block}`).toBe("The LZ4 data is malformed");
    }
  });

  test("legacy LZ4 reads Hadoop frames, one or several, to exactly the declared length", () => {
    expect(text(boundedLz4(Uint8Array.from(hadoopFrame(LZ4_BLOCK, 13)), 13))).toBe(LZ4_TEXT);
    const two = Uint8Array.from([...hadoopFrame(LZ4_BLOCK, 13), ...hadoopFrame(LZ4_BLOCK, 13)]);
    expect(text(boundedLz4(two, 26))).toBe(LZ4_TEXT + LZ4_TEXT);
    expect(() => boundedLz4(Uint8Array.from(hadoopFrame(LZ4_BLOCK, 13)), 14)).toThrow(DECODE_OVER_BUDGET);
  });

  test("legacy LZ4 that is not Hadoop-framed decodes as one raw block", () => {
    expect(text(boundedLz4(LZ4_BLOCK, 13))).toBe(LZ4_TEXT);
    expect(text(boundedLz4(Uint8Array.of(0x10, 0x65), 1))).toBe("e");
    const misframed = Uint8Array.from([...hadoopFrame(LZ4_BLOCK, 5), 0x10, 0x65]);
    expect(() => boundedLz4(misframed, 13)).toThrow("The LZ4 data is malformed");
    const overlong = Uint8Array.from(hadoopFrame(LZ4_BLOCK, 99));
    expect(() => boundedLz4(overlong, 13)).toThrow("The LZ4 data is malformed");
  });
});

describe("leading mode drops the columns past the pre-scan's value total", () => {
  const names = ["a", "b", "c", "d"];
  /**
   * Four INT32 columns of 10 rows. Each chunk is a 3-value dictionary page then one PLAIN data page of 10
   * values, so the footer counts 10 values per column and the pages 13.
   */
  const dictionaryColumns = (): Uint8Array =>
    syntheticParquet({
      schema: [{ name: "schema", children: names.length }, ...names.map((name) => ({ name, type: PHYSICAL.INT32 }))],
      rowGroups: [
        {
          numRows: 10,
          chunks: names.map((name, column) => ({
            path: [name],
            type: PHYSICAL.INT32,
            pages: [
              { kind: "dictionary" as const, numValues: 3, body: int32Plain([1, 2, 3]) },
              {
                kind: "data" as const,
                numValues: 10,
                body: int32Plain(Array.from({ length: 10 }, (_, row) => column * 10 + row)),
              },
            ],
          })),
        },
      ],
    });
  const someColumns = (k: number, valueCap: number) =>
    `Showing ${k} of 4 columns: the next column would take the first row group's read past ${fetchCapText} MiB, its decoded size past ${decodeCapText} MiB, its leaf columns past ${leafCapText} or its values past ${valueCap}, the most a preview reads.`;

  test("the footer fits three columns, the pages of the third pass the value cap: two are shown and decoded", async () => {
    const capped = limits({ parquetMaxTotalValues: 30 });
    const object = dictionaryColumns();
    const plan = planParquet(await footerOf(object), {}, "console", capped);
    expect(plan.kind === "rows" && plan.columns.map((column) => column.name)).toEqual(["a", "b", "c"]);
    expect(plan.notices).toEqual([someColumns(3, 30)]);
    const { modules, calls } = await spiedModules();
    const outcome = await previewParquet(inputFor(object, "d.parquet", { limits: capped }).input, depsOf(modules));
    expect(calls.read).toEqual([["a", "b"]]);
    if (outcome.kind !== "parquet") throw new Error(`expected parquet, got ${JSON.stringify(outcome)}`);
    expect(outcome.rows?.columns.map((column) => column.name)).toEqual(["a", "b"]);
    expect(outcome.rows?.rows[0]).toEqual([0, 10]);
    expect(outcome.notices[0]).toBe(someColumns(2, 30));
    expect(outcome.notices.filter((notice) => notice.startsWith("Showing "))).toEqual([someColumns(2, 30)]);
  });

  test("the first column's dictionary and data pages pass the value cap: the summary with N-PQ-NONE-FIT", async () => {
    const capped = limits({ parquetMaxTotalValues: 12 });
    const object = dictionaryColumns();
    const footer = await footerOf(object);
    const a = footer.metadata.row_groups[0].columns[0].meta_data;
    const { modules, calls } = await spiedModules();
    const outcome = await previewParquet(inputFor(object, "d.parquet", { limits: capped }).input, depsOf(modules));
    expect(calls.read).toEqual([]);
    expect(outcome).toEqual({
      kind: "parquet",
      summary: summarizeParquet(footer, capped).summary,
      summaryRows: S3_PREVIEW_LIMITS.defaultRows,
      notices: [
        `The first row group is too large to preview: its first column stores ${inMiB(Number(a?.total_compressed_size))} MiB (${inMiB(Number(a?.total_uncompressed_size))} MiB decoded), over the ${fetchCapText} MiB read and ${decodeCapText} MiB decode budgets, or holds more leaf columns or values than a preview reads. The schema, row count and first-row-group statistics are shown instead.`,
        ...summarizeParquet(footer, capped).notices,
      ],
    });
  });

  test("explicit mode naming the same three columns is still refused, with the total's sentence", async () => {
    const capped = limits({ parquetMaxTotalValues: 30 });
    const { modules, calls } = await spiedModules();
    const outcome = await previewParquet(
      inputFor(dictionaryColumns(), "d.parquet", { limits: capped, request: { columns: ["a", "b", "c"] } }).input,
      depsOf(modules),
    );
    expect(outcome).toEqual({
      kind: "refused",
      sentence:
        "The pages of the columns to show declare 39 values, more than a preview allows, so the file is not previewed.",
      notices: [],
    });
    expect(calls.read).toEqual([]);
  });

  test("with no total cap of its own, a chunk's dictionary page still counts toward totals.values", async () => {
    const object = dictionaryColumns();
    const a = (await footerOf(object)).metadata.row_groups[0].columns[0].meta_data;
    const start = Number(a?.dictionary_page_offset);
    const chunk = object.subarray(start, start + Number(a?.total_compressed_size));
    const totals = { values: 20, decoded: 0 };
    expect(() =>
      prescanChunk(chunk, 10, "a", limits({ parquetMaxTotalValues: 12 }), totals, Number.POSITIVE_INFINITY),
    ).not.toThrow();
    expect(totals.values).toBe(33);
  });
});

describe("the two large DuckDB files the raw seed writes (row A39)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "s3-large-parquet-"));
    await writeLargeParquet(dir);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const someColumns = (k: number, n: number) =>
    `Showing ${k} of ${n} columns: the next column would take the first row group's read past ${fetchCapText} MiB, its decoded size past ${decodeCapText} MiB, its leaf columns past ${leafCapText} or its values past ${valueCapText}, the most a preview reads.`;

  for (const [file, n, kept] of [
    ["narrow-zstd.parquet", 5, ["id", "name", "amount", "d"]],
    ["wide-zstd.parquet", 60, ["c0_int", "c1_str", "c2_dbl", "c3_date"]],
  ] as const) {
    test(`${file}: at the shipped limits the preview keeps ${kept.length} of ${n} columns with N-PQ-SOME-COLUMNS`, async () => {
      const object = new Uint8Array(readFileSync(path.join(dir, "parquet/large", file)));
      const outcome = await previewParquet(inputFor(object, `parquet/large/${file}`).input);
      if (outcome.kind !== "parquet") throw new Error(`expected parquet, got ${JSON.stringify(outcome)}`);
      expect(outcome.rows?.columns.map((column) => column.name)).toEqual([...kept]);
      expect(outcome.rows?.rows).toHaveLength(S3_PREVIEW_LIMITS.defaultRows);
      expect(outcome.notices.filter((notice) => notice.startsWith("Showing "))).toEqual([someColumns(kept.length, n)]);
    }, 60_000);
  }
});

/** The bytes of one page header: a valid data page's facts and a 4-byte body, then `extra` before the stop byte. */
const headerWith = (extra: readonly number[]): Uint8Array => {
  const head = thriftStruct([
    [1, { i32: 0 }],
    [2, { i32: 4 }],
    [3, { i32: 4 }],
    [5, { struct: [[1, { i32: 1 }]] }],
  ]);
  return Uint8Array.from([...head.subarray(0, head.length - 1), ...extra, 0x00, 1, 2, 3, 4]);
};

/** An object that is the footer bytes given between the magic numbers, with no column data. */
function footerOnly(footer: Uint8Array): Uint8Array {
  const object = new Uint8Array(footer.length + 12);
  object.set([0x50, 0x41, 0x52, 0x31]);
  object.set(footer, 4);
  new DataView(object.buffer).setUint32(4 + footer.length, footer.length, true);
  object.set([0x50, 0x41, 0x52, 0x31], 8 + footer.length);
  return object;
}

/**
 * The footer shape that grows hyparquet's heap most per field: field 1 a list of 131,072 empty structs (the list
 * budget at the default caps), then `structs` empty struct fields, so the footer declares `structs + 1` fields.
 */
function listAndStructs(structs: number): Uint8Array {
  const elements = S3_PREVIEW_LIMITS.parquetMaxLeafColumns * 8 * 128;
  const body: number[] = [0x19, 0xfc, ...varint(elements), ...new Array<number>(elements).fill(0)];
  for (let field = 0; field < structs; field += 1) body.push(0x1c, 0x00);
  body.push(0x00);
  return footerOnly(Uint8Array.from(body));
}

/**
 * One INT64 column chunk laid out field for field as pyarrow 21 writes one with its default statistics (read from a
 * 60-column pyarrow footer): file_offset, then metadata with three encodings, the path, the codec, counts, sizes, page
 * offsets, min, max and null count with exactness flags, two encoding stats and size statistics. It declares 29
 * fields in about 113 bytes, the density of that footer's column chunks.
 */
const pyarrowChunk = (name: string): ThriftValue => {
  const eight = (value: number) => ({ binary: new Uint8Array(new BigInt64Array([BigInt(value)]).buffer) });
  const stat = (page: number, encoding: number, count: number): ThriftValue => ({
    struct: [
      [1, { i32: page }],
      [2, { i32: encoding }],
      [3, { i32: count }],
    ],
  });
  return {
    struct: [
      [2, { i64: 0 }],
      [
        3,
        {
          struct: [
            [1, { i32: PHYSICAL.INT64 }],
            [2, { list: { type: THRIFT.I32, items: [{ i32: 0 }, { i32: 3 }, { i32: 8 }] } }],
            [3, { list: { type: THRIFT.BINARY, items: [{ binary: name }] } }],
            [4, { i32: CODEC.SNAPPY }],
            [5, { i64: 200_000 }],
            [6, { i64: 1_216_224 }],
            [7, { i64: 828_855 }],
            [9, { i64: 1_241_456 }],
            [11, { i64: 828_841 }],
            [
              12,
              {
                struct: [
                  [1, eight(99_999)],
                  [2, eight(0)],
                  [3, { i64: 0 }],
                  [5, eight(99_999)],
                  [6, eight(0)],
                  [7, { bool: true }],
                  [8, { bool: true }],
                ],
              },
            ],
            [13, { list: { type: THRIFT.STRUCT, items: [stat(2, 0, 1), stat(0, 8, 10)] } }],
            [
              16,
              {
                struct: [
                  [2, { list: { type: THRIFT.I64, items: [] } }],
                  [3, { list: { type: THRIFT.I64, items: [{ i64: 0 }, { i64: 200_000 }] } }],
                ],
              },
            ],
          ],
        },
      ],
    ],
  };
};

/**
 * A file of `width` INT64 columns whose footer holds as many pyarrow-shaped row groups as fit in `bytes`, about
 * 260,000 fields at 1,024,000 bytes. No column data is present; only the footer is read.
 */
function pyarrowDensityFooter(width: number, bytes: number): Uint8Array {
  const names = Array.from({ length: width }, (_, index) => `c${String(index).padStart(2, "0")}`);
  const rowGroup: ThriftValue = {
    struct: [
      [1, { list: { type: THRIFT.STRUCT, items: names.map(pyarrowChunk) } }],
      [2, { i64: 72_973_440 }],
      [3, { i64: 200_000 }],
      [5, { i64: 4 }],
      [6, { i64: 49_731_300 }],
    ],
  };
  const footer = (groups: number): Uint8Array =>
    thriftStruct([
      [1, { i32: 2 }],
      [
        2,
        {
          list: {
            type: THRIFT.STRUCT,
            items: [
              {
                struct: [
                  [4, { binary: "schema" }],
                  [5, { i32: width }],
                ],
              },
              ...names.map(
                (name): ThriftValue => ({
                  struct: [
                    [1, { i32: PHYSICAL.INT64 }],
                    [3, { i32: 1 }],
                    [4, { binary: name }],
                  ],
                }),
              ),
            ],
          },
        },
      ],
      [3, { i64: groups * 200_000 }],
      [4, { list: { type: THRIFT.STRUCT, items: new Array<ThriftValue>(groups).fill(rowGroup) } }],
      [6, { binary: "parquet-cpp-arrow version 21.0.0" }],
      [7, { list: { type: THRIFT.STRUCT, items: names.map((): ThriftValue => ({ struct: [[1, { struct: [] }]] })) } }],
    ]);
  const one = footer(1).length;
  const perGroup = footer(2).length - one;
  return footerOnly(footer(1 + Math.floor((bytes - one) / perGroup)));
}

describe("the page header and footer field budgets", () => {
  const heapNow = (): number => {
    Bun.gc(true);
    return process.memoryUsage().heapUsed;
  };

  test("prescanChunk refuses a page header of 100,000 distinct boolean fields with R-PQ-PAGES, holding little heap", () => {
    const bytes = headerWith(new Array(100_000).fill(0x11));
    const before = heapNow();
    let caught: unknown;
    try {
      prescanChunk(bytes, 1, "id", S3_PREVIEW_LIMITS, { values: 0, decoded: 0 });
    } catch (error) {
      caught = error;
    }
    expect(heapNow() - before).toBeLessThan(4 * 1_048_576);
    expect(caught).toBeInstanceOf(PreviewRefusal);
    expect((caught as PreviewRefusal).sentence).toBe(
      "The pages of column id do not fill its column chunk, so the file is not previewed.",
    );
  });

  test("prescanChunk refuses a page header carrying a list of 100,000 elements with R-PQ-PAGES", () => {
    const bytes = headerWith([0x99, 0xfc, 0xa0, 0x8d, 0x06, ...new Array(100_000).fill(0)]);
    expect(() => prescanChunk(bytes, 1, "id", S3_PREVIEW_LIMITS, { values: 0, decoded: 0 })).toThrow(PreviewRefusal);
  });

  test("a footer of 262,145 distinct boolean fields is refused with R-PQ-FOOTER-BAD before parquetMetadata runs", async () => {
    const { modules, calls } = await spiedModules();
    const footer = new Uint8Array(262_146).fill(0x11);
    footer[262_145] = 0;
    expect(await previewParquet(inputFor(footerOnly(footer), "f.parquet").input, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: "The Parquet footer could not be read: the structs declare more than 262,144 fields in all.",
      notices: [],
    });
    expect(calls.metadata).toBe(0);
  });

  test("the costliest footer shape just above the field bound is refused before parquetMetadata runs; at the bound it is parsed", async () => {
    const above = await spiedModules();
    expect(await previewParquet(inputFor(listAndStructs(262_144), "f.parquet").input, depsOf(above.modules))).toEqual({
      kind: "refused",
      sentence: "The Parquet footer could not be read: the structs declare more than 262,144 fields in all.",
      notices: [],
    });
    expect(above.calls.metadata).toBe(0);
    const at = await spiedModules();
    await previewParquet(inputFor(listAndStructs(262_143), "f.parquet").input, depsOf(at.modules));
    expect(at.calls.metadata).toBe(1);
  });

  test("a footer of a real writer's density near the 1 MiB footer cap is admitted", async () => {
    const outcome = await footerOutcome(pyarrowDensityFooter(60, 1_024_000));
    expect(outcome.kind).toBe("footer");
    if (outcome.kind !== "footer") return;
    expect(outcome.footer.footerLength).toBeGreaterThan(1_000_000);
    expect(outcome.footer.footerLength).toBeLessThanOrEqual(1_024_000);
    expect(outcome.footer.shape.leaves).toHaveLength(60);
    expect(outcome.footer.metadata.row_groups.length * 60 * 29).toBeGreaterThan(250_000);
  });
});

/** One INT32 column `id` of one row: its file with `changes` to its chunk, and the file-level overrides given. */
const oneColumn = (changes: Partial<SyntheticChunk> = {}, file: Partial<SyntheticFile> = {}): Uint8Array =>
  syntheticParquet({
    schema: [
      { name: "schema", children: 1 },
      { name: "id", type: PHYSICAL.INT32 },
    ],
    rowGroups: [{ numRows: 1, chunks: [int32Chunk("id", [1], changes)] }],
    ...file,
  });

describe("the footer values the plan and the reads use", () => {
  const bare = { kind: "refused", sentence: "The Parquet footer could not be read." } as const;

  test("a footer with a negative total_uncompressed_size on one column is refused", async () => {
    expect(await footerOutcome(oneColumn({ totalUncompressedSize: -1 }))).toEqual(bare);
  });

  test("a footer whose num_values is past 2^53 is refused", async () => {
    expect(await footerOutcome(oneColumn({ numValues: 2 ** 53 + 2 }))).toEqual(bare);
    expect(await footerOutcome(oneColumn({ numValues: Number.MAX_SAFE_INTEGER }))).toMatchObject({ kind: "footer" });
  });

  test("a negative or non-i64 count of rows, offset or size is refused", async () => {
    expect(await footerOutcome(oneColumn({}, { numRowsValue: { i64: -1 } }))).toEqual(bare);
    expect(await footerOutcome(oneColumn({}, { numRowsValue: { i32: 1 } }))).toEqual(bare);
    const groupRows = (value: ThriftValue) =>
      oneColumn(
        {},
        {
          rowGroups: [{ numRows: 1, numRowsValue: value, chunks: [int32Chunk("id", [1])] }],
        },
      );
    expect(await footerOutcome(groupRows({ i64: -1 }))).toEqual(bare);
    expect(await footerOutcome(groupRows({ double: 1 }))).toEqual(bare);
    expect(await footerOutcome(oneColumn({ totalCompressedSize: -4 }))).toEqual(bare);
    expect(await footerOutcome(oneColumn({ dataPageOffset: -4 }))).toEqual(bare);
    expect(await footerOutcome(oneColumn({ metaFields: [[11, { i64: -4 }]] }))).toEqual(bare);
  });

  test("a footer whose data_page_offset is a binary is refused", async () => {
    expect(await footerOutcome(oneColumn({ metaFields: [[9, { binary: Uint8Array.of(4) }]] }))).toEqual(bare);
  });

  test("a footer whose total_compressed_size is encoded as a list is refused", async () => {
    const asList: ThriftValue = { list: { type: THRIFT.I64, items: [{ i64: 100 }] } };
    expect(await footerOutcome(oneColumn({ metaFields: [[7, asList]] }))).toEqual(bare);
  });

  test("a footer whose dictionary_page_offset is an i32 is refused", async () => {
    expect(await footerOutcome(oneColumn({ metaFields: [[11, { i32: 4 }]] }))).toEqual(bare);
  });

  test("two columns, one declaring a negative size, cannot together pass a cap the second exceeds alone", async () => {
    const { modules, calls } = await spiedModules();
    const object = syntheticParquet({
      schema: [
        { name: "schema", children: 2 },
        { name: "a", type: PHYSICAL.INT32 },
        { name: "b", type: PHYSICAL.INT32 },
      ],
      rowGroups: [
        {
          numRows: 1,
          chunks: [
            int32Chunk("a", [1], { totalUncompressedSize: -S3_PREVIEW_LIMITS.parquetDecodeBudget }),
            int32Chunk("b", [1], { totalUncompressedSize: S3_PREVIEW_LIMITS.parquetDecodeBudget + 1 }),
          ],
        },
      ],
    });
    const { reader, input } = inputFor(object, "f.parquet", { request: { columns: ["a", "b"] } });
    expect(await previewParquet(input, depsOf(modules))).toEqual({ ...bare, notices: [] });
    expect(reader.calls.filter((call) => call.range.kind === "span")).toEqual([]);
    expect(calls.read).toEqual([]);
  });
});

describe("an empty column chunk", () => {
  test("a 0-byte chunk in a planned column ends in R-PQ-CHUNK-RANGE with no span read", async () => {
    const { modules, calls } = await spiedModules();
    const object = oneColumn({ totalCompressedSize: 0 });
    const { reader, input } = inputFor(object, "f.parquet");
    // The production range reader refuses a span of no bytes as a defect; this one does the same.
    const strict: ParquetPreviewInput = {
      ...input,
      read: async (range, maxBytes) => {
        if (range.kind === "span" && range.end <= range.start)
          throw new Error("a span range must hold at least 1 byte");
        return input.read(range, maxBytes);
      },
    };
    expect(await previewParquet(strict, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: "The Parquet footer places column id outside the file's data, so the file is not previewed.",
      notices: [],
    });
    expect(reader.calls.filter((call) => call.range.kind === "span")).toEqual([]);
    expect(calls.read).toEqual([]);
  });
});

/** A zstd block header: 3 little-endian bytes of last flag, type (0 raw, 1 RLE, 2 compressed) and size. */
const zstdBlock = (type: number, size: number, last: boolean, body: readonly number[]): number[] => {
  const header = (size << 3) | (type << 1) | (last ? 1 : 0);
  return [header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff, ...body];
};
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** A single-segment zstd frame declaring `contentSize`, then the blocks given. */
const zstdFrame = (contentSize: number, blocks: readonly number[], options: { checksum?: boolean } = {}): number[] => {
  const checksum = options.checksum === true ? 0x04 : 0;
  let size: number[];
  let flag: number;
  if (contentSize < 256) {
    flag = 0;
    size = [contentSize];
  } else if (contentSize < 65_536 + 256) {
    flag = 1;
    size = [(contentSize - 256) & 0xff, (contentSize - 256) >> 8];
  } else {
    flag = 2;
    size = [contentSize & 0xff, (contentSize >> 8) & 0xff, (contentSize >> 16) & 0xff, contentSize >>> 24];
  }
  return [...ZSTD_MAGIC, (flag << 6) | 0x20 | checksum, ...size, ...blocks, ...(checksum ? [0, 0, 0, 0] : [])];
};
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const MiB = 1_048_576;

describe("the bounded zstd decoder", () => {
  test("a page of many concatenated RLE frames under a declared length of 1 MiB is refused with DECODE_OVER_BUDGET within a short time", async () => {
    const { codecs } = await loadParquetModules();
    const frame = zstdFrame(MiB, zstdBlock(1, MiB, true, [0x61]));
    const input = Uint8Array.from(Array.from({ length: 1_000 }, () => frame).flat());
    const started = performance.now();
    expect(() => boundedZstd(input, MiB, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    expect(performance.now() - started).toBeLessThan(1_000);
    const compressors = guardedCompressors(8 * MiB, await loadParquetModules());
    expect(() => compressors.ZSTD?.(input, MiB)).toThrow(DECODE_OVER_BUDGET);
  });

  test("a frame whose blocks regenerate fewer bytes than its declared content size is refused before it decodes", async () => {
    const { codecs } = await loadParquetModules();
    let calls = 0;
    const counting = (input: Uint8Array, output: Uint8Array): Uint8Array => {
      calls += 1;
      return codecs.zstd(input, output);
    };
    const short = Uint8Array.from(
      zstdFrame(
        1_024,
        zstdBlock(
          0,
          10,
          true,
          Array.from({ length: 10 }, () => 0x61),
        ),
      ),
    );
    expect(() => boundedZstd(short, 1_024, counting)).toThrow(DECODE_OVER_BUDGET);
    expect(calls).toBe(0);
  });

  test("a frame that declares no content size is refused before it decodes", async () => {
    const { codecs } = await loadParquetModules();
    let calls = 0;
    const counting = (input: Uint8Array, output: Uint8Array): Uint8Array => {
      calls += 1;
      return codecs.zstd(input, output);
    };
    const noSize = Uint8Array.from([...ZSTD_MAGIC, 0x00, 0x50, ...zstdBlock(1, MiB, true, [0x61])]);
    expect(() => boundedZstd(noSize, MiB, counting)).toThrow(DECODE_OVER_BUDGET);
    expect(calls).toBe(0);
  });

  test("a valid single frame, and two frames whose content sizes sum to the declared length, decode", async () => {
    const { codecs } = await loadParquetModules();
    const raw = zstdFrame(5, zstdBlock(0, 5, true, [...new TextEncoder().encode("hello")]));
    expect(text(boundedZstd(Uint8Array.from(raw), 5, codecs.zstd))).toBe("hello");
    const rle = zstdFrame(300, zstdBlock(1, 300, true, [0x78]), { checksum: true });
    const two = boundedZstd(Uint8Array.from([...raw, ...rle]), 305, codecs.zstd);
    expect(text(two)).toBe(`hello${"x".repeat(300)}`);
    const wide = zstdFrame(70_000, zstdBlock(1, 70_000, true, [0x79]));
    expect(boundedZstd(Uint8Array.from(wide), 70_000, codecs.zstd)).toEqual(new Uint8Array(70_000).fill(0x79));
    const compressors = guardedCompressors(1_024, await loadParquetModules());
    expect(text(compressors.ZSTD?.(Uint8Array.from(raw), 5) as Uint8Array)).toBe("hello");
  });

  test("a skippable frame is skipped by its length", async () => {
    const { codecs } = await loadParquetModules();
    const skippable = [0x5a, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3];
    const raw = zstdFrame(2, zstdBlock(0, 2, true, [0x6f, 0x6b]));
    expect(text(boundedZstd(Uint8Array.from([...skippable, ...raw]), 2, codecs.zstd))).toBe("ok");
  });

  test("frames or blocks that declare more than the declared length are refused, and so is a short output", async () => {
    const { codecs } = await loadParquetModules();
    const raw = zstdFrame(2, zstdBlock(0, 2, true, [0x6f, 0x6b]));
    expect(() => boundedZstd(Uint8Array.from([...raw, ...raw]), 3, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    expect(() => boundedZstd(Uint8Array.from(raw), 1, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    expect(() => boundedZstd(Uint8Array.from(raw), 3, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    const blocksOver = zstdFrame(4, [...zstdBlock(1, 3, false, [0x61]), ...zstdBlock(0, 2, true, [0x62, 0x63])]);
    expect(() => boundedZstd(Uint8Array.from(blocksOver), 4, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    const huge = [...ZSTD_MAGIC, 0xe0, 0, 0, 0, 0, 0, 0, 0, 1, ...zstdBlock(0, 0, true, [])];
    expect(() => boundedZstd(Uint8Array.from(huge), MiB, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    expect(boundedZstd(new Uint8Array(0), 0, codecs.zstd)).toEqual(new Uint8Array(0));
  });

  test("malformed frames throw an error of their own", async () => {
    const { codecs } = await loadParquetModules();
    const malformed = "The ZSTD data is malformed";
    const raw = zstdFrame(2, zstdBlock(0, 2, true, [0x6f, 0x6b]));
    const cases: readonly (readonly number[])[] = [
      [0x01, 0x02, 0x03],
      [0x00, 0x00, 0x00, 0x00],
      [...ZSTD_MAGIC],
      [...ZSTD_MAGIC, 0x28, 2],
      [...ZSTD_MAGIC, 0x80],
      [...ZSTD_MAGIC, 0x20, 2, 0x00],
      [...ZSTD_MAGIC, 0x20, 2, ...zstdBlock(3, 2, true, [0, 0])],
      [...ZSTD_MAGIC, 0x20, 2, ...zstdBlock(0, 2, true, [0])],
      [...ZSTD_MAGIC, 0x24, 2, ...zstdBlock(0, 2, true, [0, 0]), 0, 0],
      [0x5a, 0x2a, 0x4d, 0x18, 3, 0],
      [0x5a, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1],
      raw.slice(0, raw.length - 1),
    ];
    for (const input of cases) {
      expect(() => boundedZstd(Uint8Array.from(input), 2, codecs.zstd), input.join(",")).toThrow(malformed);
    }
  });

  test("compressed blocks whose sequences copy more than the frame's content size are refused before any decode", async () => {
    const modules = await loadParquetModules();
    let calls = 0;
    const counting = (input: Uint8Array, output: Uint8Array): Uint8Array => {
      calls += 1;
      return modules.codecs.zstd(input, output);
    };
    const one = Uint8Array.from(zstdFrame(1_024, zstdSequenceBlocks(10_000, 1)));
    const ten = Uint8Array.from(zstdFrame(1_024, zstdSequenceBlocks(1_000, 10)));
    for (const input of [one, ten]) {
      const started = performance.now();
      expect(() => boundedZstd(input, 1_024, counting)).toThrow(DECODE_OVER_BUDGET);
      expect(() => guardedCompressors(8 * MiB, modules).ZSTD?.(input, 1_024)).toThrow(DECODE_OVER_BUDGET);
      expect(performance.now() - started).toBeLessThan(250);
    }
    expect(calls).toBe(0);
  });

  test("a compressed block whose sequences copy exactly the frame's content size decodes, in the three-byte count form too", async () => {
    const { codecs } = await loadParquetModules();
    const sequences = 0x7f01;
    const blocks = zstdSequenceBlocks(sequences, 1, { matchCode: 0 });
    expect(blocks.slice(4, 7)).toEqual([0xff, 0x01, 0x00]);
    const input = Uint8Array.from(zstdFrame(3 * sequences, blocks));
    expect(boundedZstd(input, 3 * sequences, codecs.zstd)).toHaveLength(3 * sequences);
    const over = Uint8Array.from(zstdFrame(3 * sequences - 1, blocks));
    expect(() => boundedZstd(over, 3 * sequences - 1, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
  });

  test("a compressed block whose literals pass the frame's content size is refused before any decode", async () => {
    const { codecs } = await loadParquetModules();
    const literals = [0x50, ...new TextEncoder().encode("0123456789")];
    const block = zstdBlock(2, literals.length + 1, true, [...literals, 0x00]);
    expect(() => boundedZstd(Uint8Array.from(zstdFrame(5, block)), 5, codecs.zstd)).toThrow(DECODE_OVER_BUDGET);
    expect(text(boundedZstd(Uint8Array.from(zstdFrame(10, block)), 10, codecs.zstd))).toBe("0123456789");
  });

  test("sequences that take more literals than the block holds, or use a length or offset code the format does not define, are malformed", async () => {
    const { codecs } = await loadParquetModules();
    const malformed = "The ZSTD data is malformed";
    const cases: readonly (readonly number[])[] = [
      zstdSequenceBlocks(1, 1, { literalCode: 5, matchCode: 0 }),
      zstdSequenceBlocks(1, 1, { literalCode: 36, matchCode: 0 }),
      zstdSequenceBlocks(1, 1, { matchCode: 53 }),
      zstdSequenceBlocks(1, 1, { offsetCode: 32, matchCode: 0 }),
      zstdSequenceBlocks(1, 1, { modes: 0xfc }),
      zstdSequenceBlocks(1, 1, { modes: 0x55 }),
      zstdSequenceBlocks(1, 1, { matchCode: 0, lastByte: 0x00 }),
    ];
    for (const blocks of cases) {
      const input = Uint8Array.from(zstdFrame(1_024, blocks));
      expect(() => boundedZstd(input, 1_024, codecs.zstd), blocks.join(",")).toThrow(malformed);
    }
  });

  test("frames the zstd encoder writes decode to their input at every level, across blocks and frames", async () => {
    const { codecs } = await loadParquetModules();
    const random = seededBytes(20261010);
    const inputs = [
      new Uint8Array(0),
      new TextEncoder().encode("a single short line of text"),
      random.mixed(70_000),
      random.mixed(300_000),
      random.noise(150_000),
      random.letters(5_000),
      random.letters(200_000),
      new Uint8Array(400_000).fill(0x2a),
    ];
    for (const level of [-5, 1, 3, 9, 19]) {
      for (const input of inputs) {
        const frame = zstdCompressSync(input, {
          params: { [zlibConstants.ZSTD_c_compressionLevel]: level, [zlibConstants.ZSTD_c_checksumFlag]: 1 },
        });
        expect(boundedZstd(frame, input.length, codecs.zstd), `level ${level} size ${input.length}`).toEqual(input);
      }
    }
    const first = random.mixed(20_000);
    const second = random.mixed(30_000);
    const page = Uint8Array.from([...zstdCompressSync(first), ...zstdCompressSync(second)]);
    expect(boundedZstd(page, 50_000, codecs.zstd)).toEqual(Uint8Array.from([...first, ...second]));
  });
});

/**
 * Compressed blocks of `sequences` sequences each, with no literals and RLE tables of one literal length code, one
 * offset code and one match length code; the bitstream is its one closing byte, so every extra bit reads as zero.
 */
function zstdSequenceBlocks(
  sequences: number,
  count: number,
  codes: { literalCode?: number; offsetCode?: number; matchCode?: number; modes?: number; lastByte?: number } = {},
): number[] {
  const counted =
    sequences < 128
      ? [sequences]
      : sequences < 0x7f00
        ? [0x80 | (sequences >> 8), sequences & 0xff]
        : [0xff, (sequences - 0x7f00) & 0xff, (sequences - 0x7f00) >> 8];
  const body = [
    0x00,
    ...counted,
    codes.modes ?? 0x54,
    codes.literalCode ?? 0,
    codes.offsetCode ?? 0,
    codes.matchCode ?? 52,
    codes.lastByte ?? 0x01,
  ];
  return Array.from({ length: count }, (_, index) => zstdBlock(2, body.length, index === count - 1, body)).flat();
}

/** Fixed-seed bytes for the encoder round trip: noise, letters of a 16-letter alphabet, and text-like data of repeated phrases with noise between. */
function seededBytes(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const phrases = ["SELECT", " id, name ", "FROM orders", " WHERE ", "2026-10-10", "null", "\n"].map((phrase) =>
    new TextEncoder().encode(phrase),
  );
  return {
    noise: (size: number): Uint8Array => Uint8Array.from({ length: size }, () => next() & 0xff),
    letters: (size: number): Uint8Array => Uint8Array.from({ length: size }, () => 0x61 + (next() & 0x0f)),
    mixed: (size: number): Uint8Array => {
      const output = new Uint8Array(size);
      let at = 0;
      while (at < size) {
        const roll = next();
        const piece =
          roll % 5 === 0
            ? Uint8Array.from({ length: 1 + (roll % 13) }, () => next() & 0xff)
            : phrases[roll % phrases.length];
        output.set(piece.subarray(0, size - at), at);
        at += piece.length;
      }
      return output;
    },
  };
}
