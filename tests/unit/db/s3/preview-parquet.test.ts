/**
 * The S3 Parquet preview: what the preview decides before it reads any column data (footer, guards,
 * parsers, plan and summary), then the reads, the page pre-scan, the guarded decode and the process-wide decode slot.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { QueryError } from "@/lib/db/errors";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import type { S3PreviewCell } from "@/lib/db/providers/objectstore/s3/preview";
import {
  createDecodeSlots,
  DECODE_OVER_BUDGET,
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
import { inMiB } from "@/lib/db/providers/objectstore/s3/preview-render";
import {
  booleanRle,
  CODEC,
  ENCODING,
  int32Plain,
  PHYSICAL,
  type SyntheticChunk,
  syntheticParquet,
  withTail,
} from "../../../helpers/parquet-synthetic";
import { fakeReader, fixture, headOf } from "../../../helpers/s3-preview-reader";

const limits = (changes: Partial<typeof S3_PREVIEW_LIMITS> = {}) => ({ ...S3_PREVIEW_LIMITS, ...changes });

/** The leaf and value caps as the preview's sentences write them. */
const leafCapText = S3_PREVIEW_LIMITS.parquetMaxLeafColumns.toLocaleString("en-US");
const valueCapText = S3_PREVIEW_LIMITS.parquetMaxTotalValues.toLocaleString("en-US");

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

async function footerOf(object: Uint8Array, changes: Partial<ParquetPreviewInput> = {}): Promise<ParquetFooter> {
  const outcome = await readParquetFooter(inputFor(object, "f.parquet", changes).input, await loadParquetModules());
  if (outcome.kind !== "footer") throw new Error(`expected a footer, got ${JSON.stringify(outcome)}`);
  return outcome.footer;
}

const footerOutcome = async (object: Uint8Array, changes: Partial<ParquetPreviewInput> = {}): Promise<FooterOutcome> =>
  readParquetFooter(inputFor(object, "f.parquet", changes).input, await loadParquetModules());

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
    expect((await readParquetFooter(one.input, await loadParquetModules())).kind).toBe("footer");
    expect(one.reader.calls).toEqual([{ range: { kind: "suffix", length: object.length }, maxBytes: object.length }]);
    const two = inputFor(object, "fx-zstd.parquet", { limits: limits({ parquetTailBytes: 64 }) });
    const outcome = await readParquetFooter(two.input, await loadParquetModules());
    expect(outcome.kind === "footer" && outcome.footer.metadata.num_rows).toBe(BigInt(200));
    expect(two.reader.calls).toHaveLength(2);
    expect(two.reader.calls[0]).toEqual({ range: { kind: "suffix", length: 64 }, maxBytes: 64 });
    expect(two.reader.calls[1].range.kind).toBe("span");
  });

  test("an object under 12 bytes is not Parquet and is never read", async () => {
    const small = inputFor(new Uint8Array(11), "f.parquet");
    expect(await readParquetFooter(small.input, await loadParquetModules())).toEqual({ kind: "not-parquet" });
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
      `Showing 1 of 12 columns: the next column would take the first row group's read past ${inMiB(idFetch)} MiB, its decoded size past 32.00 MiB, its leaf columns past ${leafCapText} or its values past ${valueCapText}, the most a preview reads.`,
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
        `The first row group is too large to preview: its first column stores ${inMiB(Number(id?.total_compressed_size))} MiB (${inMiB(Number(id?.total_uncompressed_size))} MiB decoded), over the 0.00 MiB read and 32.00 MiB decode budgets, or holds more leaf columns or values than a preview reads. The schema, row count and first-row-group statistics are shown instead.`,
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
const settle = async (until: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 2_000 && !until(); tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each tick waits for the one before it.
    await Bun.sleep(1);
  }
};

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

  test("three BOOLEAN columns of half the value cap decode two; understated footer counts are refused by the pre-scan before decode", async () => {
    const { modules, calls } = await spiedModules();
    const two = await previewParquet(inputFor(threeBooleans(), "b.parquet").input, depsOf(modules));
    expect(two.kind === "parquet" && two.rows?.columns.map((column) => column.name)).toEqual(["b0", "b1"]);
    expect(two.kind === "parquet" && two.rows?.rows[0]).toEqual([true, true]);
    calls.read.length = 0;
    expect(await previewParquet(inputFor(threeBooleans(1), "b.parquet").input, depsOf(modules))).toEqual({
      kind: "refused",
      sentence: `A page of column b0 declares ${booleanValues.toLocaleString("en-US")} values, more than its column chunk holds or the preview allows, so the file is not previewed.`,
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
      sentence:
        "The pages of the columns to show declare 38.15 MiB decoded, over the 32.00 MiB a preview decodes, so the file is not previewed.",
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
      "A page of column id declares 13 values, more than its column chunk holds or the preview allows, so the file is not previewed.",
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

  test("the budget is spent by each call, and a call within it decodes", async () => {
    const compressors = guardedCompressors(10, await loadParquetModules());
    const stored = new Uint8Array(gzipSync(new TextEncoder().encode("hello")));
    expect(new TextDecoder().decode(compressors.GZIP?.(stored, 5))).toBe("hello");
    expect(() => compressors.GZIP?.(stored, 6)).toThrow(DECODE_OVER_BUDGET);
  });
});

describe("the process-wide decode slot", () => {
  /** Real modules whose decode waits on a gate per call, while `gated` holds. */
  async function gatedModules() {
    const real = await loadParquetModules();
    const started: number[] = [];
    const gates: (() => void)[] = [];
    const state = { gated: true };
    const modules: ParquetModules = {
      ...real,
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
    const deps = depsOf(modules, createDecodeSlots(2, 4));
    const object = fixture("fx-zstd.parquet");
    const runs = [0, 1, 2].map(() => previewParquet(inputFor(object, "f.parquet").input, deps));
    await settle(() => started.length === 2);
    await Bun.sleep(20);
    expect(started).toEqual([0, 1]);
    open(0);
    await settle(() => started.length === 3);
    expect(started).toEqual([0, 1, 2]);
    state.gated = false;
    open(1);
    open(2);
    expect((await Promise.all(runs)).map((each) => each.kind)).toEqual(["parquet", "parquet", "parquet"]);
  });

  test("with two decodes running and four waiting, the next preview gets R-PQ-BUSY and sends no GET after its pre-scan", async () => {
    const { modules, started, open, state } = await gatedModules();
    const deps = depsOf(modules, createDecodeSlots(2, 4));
    const object = fixture("fx-zstd.parquet");
    const runs = Array.from({ length: 6 }, () => previewParquet(inputFor(object, "f.parquet").input, deps));
    await settle(() => started.length === 2);
    await Bun.sleep(20);
    const busy = inputFor(object, "f.parquet");
    expect(await previewParquet(busy.input, deps)).toEqual({
      kind: "refused",
      sentence: "The server is decoding other Parquet previews; preview this object again in a moment.",
      notices: [],
    });
    expect(busy.reader.calls).toHaveLength(2);
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

  test("a preview aborted right after it acquires the slot releases it", async () => {
    const inner = createDecodeSlots(1, 4);
    const controller = new AbortController();
    const slots = {
      acquire: async (signal: AbortSignal) => {
        const release = await inner.acquire(signal);
        controller.abort();
        return release;
      },
    };
    const { modules, calls } = await spiedModules();
    const object = fixture("fx-zstd.parquet");
    await expect(
      previewParquet(inputFor(object, "f.parquet", { signal: controller.signal }).input, depsOf(modules, slots)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.read).toEqual([]);
    const again = await inner.acquire(new AbortController().signal);
    again();
  });
});
