import { beforeAll, describe, expect, test } from "bun:test";
import * as zlib from "node:zlib";
import { SnowflakeError } from "@/lib/db/providers/sql/snowflake/errors";
import {
  readOversizedFirstAnswer,
  readResultRows,
  SNOWFLAKE_OVERSIZED_FIRST_READ_BYTES,
  SNOWFLAKE_FIRST_ANSWER_MAX_BYTES,
  SNOWFLAKE_RESULT_BYTE_BUDGET,
  SNOWFLAKE_ROWS_SENTENCES,
  type SnowflakeRawRow,
} from "@/lib/db/providers/sql/snowflake/rows";
import type { SnowflakeByteAnswer } from "@/lib/db/providers/sql/snowflake/transport";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { gzipRowsBomb } from "../../../helpers/snowflake-node-transport";

const COLUMNS = ["ID", "NAME"];

function noPartition(): Promise<SnowflakeByteAnswer> {
  throw new Error("no partition was expected");
}

function readFirst(firstData: unknown, columns: readonly string[] = COLUMNS) {
  return readResultRows({
    columns,
    firstData,
    partitionCount: 1,
    fetchPartition: noPartition,
    signal: new AbortController().signal,
  });
}

/** Rows whose JSON texts sum to exactly `bytes`, each `width` bytes but the last. */
function rowsOfBytes(bytes: number, width: number): SnowflakeRawRow[] {
  const rows: SnowflakeRawRow[] = [];
  // ["x...x"] is the cell plus 4 bytes.
  let left = bytes;
  while (left > 0) {
    const size = Math.min(width, left);
    rows.push(["x".repeat(size - 4)]);
    left -= size;
  }
  return rows;
}

/** The gzip framing a partition request may carry past the budget left, `rows.ts`'s own bound. */
const SNOWFLAKE_PARTITION_SLACK_BYTES = 65_536;
describe("constants and sentences", () => {
  test("the budget and the first answer cap", () => {
    expect(SNOWFLAKE_RESULT_BYTE_BUDGET).toBe(16_777_216);
    expect(SNOWFLAKE_FIRST_ANSWER_MAX_BYTES).toBe(25_165_824);
  });

  test("every sentence, exactly", () => {
    expect(SNOWFLAKE_ROWS_SENTENCES.firstTooLarge).toBe(
      "Snowflake's first result partition is larger than Studio reads (24 MiB). Add a LIMIT, or select fewer columns.",
    );
    expect(SNOWFLAKE_ROWS_SENTENCES.unreadable).toBe("Snowflake sent a result partition Studio could not read.");
    expect(SNOWFLAKE_ROWS_SENTENCES.encoding("br")).toBe(
      "Snowflake sent a result partition in an encoding Studio does not read (br).",
    );
    expect(SNOWFLAKE_ROWS_SENTENCES.nonString("NAME")).toBe(
      'Snowflake sent a cell that is not text in column "NAME", so the result is not shown.',
    );
    expect(SNOWFLAKE_ROWS_SENTENCES.byteCut(58_726)).toBe(
      "The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown. Snowflake reported 58,726 rows.",
    );
    // SF-031: Studio asks for at most 100,001 rows (rows_per_resultset), so Snowflake's numRows stops there: a count
    // that reached it is Studio's own request echoed, and the sentence says "more than 100,000" instead.
    for (const numRows of [100_001, 1_234_567]) {
      expect(SNOWFLAKE_ROWS_SENTENCES.byteCut(numRows)).toBe(
        "The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown. Snowflake reported more than 100,000 rows.",
      );
    }
    expect(SNOWFLAKE_ROWS_SENTENCES.byteCut(100_000)).toEndWith("Snowflake reported 100,000 rows.");
    expect(SNOWFLAKE_ROWS_SENTENCES.byteCut(null)).toBe(
      "The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown.",
    );
    expect(SNOWFLAKE_ROWS_SENTENCES.rowCut).toBe(
      "The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.",
    );
    expect(SNOWFLAKE_ROWS_SENTENCES.snowflakeCut).toBe(
      "Snowflake returned only part of this result because it is too large (391908), so only the rows it sent are shown. Add a LIMIT, or select fewer columns.",
    );
  });
});

describe("partition 0", () => {
  test("its rows are kept, nulls among them, and a single partition fetches nothing", async () => {
    const outcome = await readFirst([
      ["1", "a"],
      ["2", null],
    ]);
    expect(outcome).toEqual({
      rows: [
        ["1", "a"],
        ["2", null],
      ],
      cut: null,
    });
  });

  test("an empty data array is a whole, empty result", async () => {
    expect(await readFirst([])).toEqual({ rows: [], cut: null });
  });

  test("a 100,001st row marks the row cut and 100,000 rows are kept", async () => {
    const data = Array.from({ length: MAX_UNLIMITED_ROWS + 1 }, (_, i) => [String(i)]);
    const outcome = await readFirst(data, ["N"]);
    expect(outcome.cut).toBe("rows");
    expect(outcome.rows).toHaveLength(MAX_UNLIMITED_ROWS);
    expect(outcome.rows.at(-1)).toEqual([String(MAX_UNLIMITED_ROWS - 1)]);
  });

  test("exactly 100,000 rows and no partition left is whole", async () => {
    const data = Array.from({ length: MAX_UNLIMITED_ROWS }, (_, i) => [String(i)]);
    const outcome = await readFirst(data, ["N"]);
    expect(outcome.cut).toBeNull();
    expect(outcome.rows).toHaveLength(MAX_UNLIMITED_ROWS);
  });

  test("a 24 MiB partition 0 parses, and its rows past 16 MiB are cut", async () => {
    const cell = "y".repeat(1020);
    const data = Array.from({ length: Math.floor(SNOWFLAKE_FIRST_ANSWER_MAX_BYTES / 1024) }, () => [cell]);
    const text = JSON.stringify(data);
    expect(text.length).toBeGreaterThan(SNOWFLAKE_FIRST_ANSWER_MAX_BYTES - 1024 * 32);
    const outcome = await readFirst(JSON.parse(text), ["C"]);
    expect(outcome.cut).toBe("bytes");
    // Each row costs 1,024 bytes, so exactly 16,384 fit.
    expect(outcome.rows).toHaveLength(SNOWFLAKE_RESULT_BYTE_BUDGET / 1024);
  });

  test("a budget landing exactly on the last row is whole; one byte more is the cut", async () => {
    const exact = rowsOfBytes(SNOWFLAKE_RESULT_BYTE_BUDGET, 65_536);
    const whole = await readFirst(exact, ["C"]);
    expect(whole.cut).toBeNull();
    expect(whole.rows).toHaveLength(exact.length);

    const over = [...exact, ["z"]];
    const cut = await readFirst(over, ["C"]);
    expect(cut.cut).toBe("bytes");
    expect(cut.rows).toHaveLength(exact.length);
  });

  test("a cell that is not text is refused naming its column", async () => {
    const refusal = readFirst([
      ["1", "a"],
      ["2", 7],
    ]);
    await expect(refusal).rejects.toBeInstanceOf(SnowflakeError);
    await expect(refusal).rejects.toMatchObject({
      category: "query",
      message: SNOWFLAKE_ROWS_SENTENCES.nonString("NAME"),
    });
  });

  test("a cell past the named columns is refused by its position", async () => {
    await expect(readFirst([["1", "a", true]])).rejects.toMatchObject({
      message: SNOWFLAKE_ROWS_SENTENCES.nonString("3"),
    });
  });

  for (const [label, data] of [
    ["an object", {}],
    ["null", null],
    ["a string", "rows"],
    ["a row that is not an array", [["1"], "2"]],
  ] as const) {
    test(`a firstData of ${label} is refused as unreadable`, async () => {
      await expect(readFirst(data)).rejects.toMatchObject({
        category: "query",
        message: SNOWFLAKE_ROWS_SENTENCES.unreadable,
      });
    });
  }
});

interface Body {
  readonly bytes: Buffer;
  readonly contentEncoding?: string | null;
  readonly truncated?: boolean;
}

const answerOf = (body: Body): SnowflakeByteAnswer => ({
  status: 200,
  bytes: body.bytes,
  contentEncoding: body.contentEncoding ?? null,
  truncated: body.truncated ?? false,
  attempts: 1,
});

const gzip = (text: string): Body => ({ bytes: zlib.gzipSync(Buffer.from(text)), contentEncoding: "gzip" });
const identity = (text: string): Body => ({ bytes: Buffer.from(text) });

/** Gunzips into 64-byte output chunks, the smallest zlib allows, and counts what it inflated and how often it ran. */
function countingGunzip(chunkSize?: number) {
  const counter = { inflated: 0, built: 0 };
  return {
    counter,
    deps: {
      createGunzip: () => {
        counter.built += 1;
        const gunzip = zlib.createGunzip(chunkSize === undefined ? {} : { chunkSize });
        gunzip.on("data", (chunk: Buffer) => {
          counter.inflated += chunk.length;
        });
        return gunzip;
      },
    },
  };
}

/** Reads the bodies as partitions 1 to n after `firstData`, recording each fetch's index and bounds. */
async function readPartitions(
  bodies: readonly Body[],
  options: {
    readonly firstData?: unknown;
    readonly columns?: readonly string[];
    readonly chunkSize?: number;
    readonly signal?: AbortSignal;
  } = {},
) {
  const fetched: [number, number, number][] = [];
  const gunzip = countingGunzip(options.chunkSize ?? 64);
  const outcome = await readResultRows({
    columns: options.columns ?? COLUMNS,
    firstData: options.firstData ?? [],
    partitionCount: bodies.length + 1,
    fetchPartition: async (index, maxResponseBytes, truncateAt) => {
      fetched.push([index, maxResponseBytes, truncateAt]);
      return answerOf(bodies[index - 1] as Body);
    },
    signal: options.signal ?? new AbortController().signal,
    deps: gunzip.deps,
  });
  return { outcome, fetched, counter: gunzip.counter };
}

const unreadableRefusal = { category: "query", message: SNOWFLAKE_ROWS_SENTENCES.unreadable };

describe("the row reader", () => {
  const cases: [string, string][] = [
    [
      "multi-byte characters split across chunks",
      JSON.stringify(Array.from({ length: 40 }, (_, i) => [`é漢🙂${i}`, "🙂".repeat(i)])),
    ],
    [
      "escaped quotes, backslashes and unicode escapes",
      '[["a\\"b","c\\\\d"],["\\u00e9\\ud83d\\ude42",null],["\\/\\b\\f\\n\\r\\t",""]]',
    ],
    ["brackets and commas inside strings", '[["[","]"],["],[","{\\"data\\":[]}"]]'],
    ["whitespace between every token", ' [ \n [ "a" , null ] ,\r\n\t[ null , "b" ] ] \n'],
    ["an empty bare array", "[]"],
    ["empty rows", "[[],[]]"],
  ];
  for (const [label, text] of cases) {
    test(`equals JSON.parse over 64-byte chunks: ${label}`, async () => {
      const { outcome } = await readPartitions([gzip(text)]);
      expect(outcome).toEqual({ rows: JSON.parse(text), cut: null });
    });
  }

  test("an envelope is read from its data key, every other key skipped", async () => {
    const text =
      '{"other":[[1]],"n":12, "t":true ,"s":"x\\"]}y","data":[["a"],["b",null]],"more":{"x":[],"data":[["no"]]},"z":null}';
    const { outcome } = await readPartitions([gzip(text)]);
    expect(outcome).toEqual({ rows: JSON.parse(text).data, cut: null });
  });

  test("a cell that is not text is refused naming its column, in a gzip or a text body", async () => {
    for (const [body, column] of [
      [gzip('[["a","b"],["c",7]]'), "NAME"],
      [identity("[[true]]"), "ID"],
      [identity('[["a","b",{}]]'), "3"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time keeps each failure attributable.
      await expect(readPartitions([body])).rejects.toMatchObject({
        category: "query",
        message: SNOWFLAKE_ROWS_SENTENCES.nonString(column),
      });
    }
  });

  const malformed: [string, string][] = [
    ["an unfinished document", '[["a"]'],
    ["a number for the document", "5"],
    ["data that is not an array", '{"data":5}'],
    ["an object with no data key", '{"x":1}'],
    ["an empty object", "{}"],
    ["a key that is not a string", "{data:[]}"],
    ["a key with no colon", '{"data" []}'],
    ["a key with no value", '{"x":,"data":[]}'],
    ["two values with no comma", '{"data":[] "x":1}'],
    ["a row that is not an array", '["a"]'],
    ["two rows with no comma", '[["a"]["b"]]'],
    ["a trailing comma between rows", '[["a"],]'],
    ["two cells with no comma", '[["a" "b"]]'],
    ["a missing cell", '[["a",,"b"]]'],
    ["a trailing comma in a row", '[["a",]]'],
    ["a literal that is not null", "[[nul]]"],
    ["a bad escape", '[["\\x"]]'],
    ["a raw control character", '[["a\u0001"]]'],
    ["text after the document", '[["a"]] x'],
    ["a scalar closing with a bracket", '{"x":1]'],
  ];
  for (const [label, text] of malformed) {
    test(`refuses ${label} as unreadable`, async () => {
      await expect(readPartitions([identity(text)])).rejects.toMatchObject(unreadableRefusal);
    });
  }

  test("refuses bytes that are not UTF-8, and a body cut inside a character", async () => {
    await expect(
      readPartitions([{ bytes: Buffer.from([0x5b, 0x5b, 0x22, 0xff, 0x22, 0x5d, 0x5d]) }]),
    ).rejects.toMatchObject(unreadableRefusal);
    const cut = Buffer.from('[["é"]]').subarray(0, 4);
    await expect(readPartitions([{ bytes: cut }])).rejects.toMatchObject(unreadableRefusal);
  });
});

describe("the partition loop", () => {
  test("fetches exactly partitionCount - 1 partitions in order, bounded by the bytes left and the slack", async () => {
    const { outcome, fetched } = await readPartitions([gzip('[["a"]]'), identity('[["bb"]]'), gzip("[]")], {
      firstData: [["0"]],
    });
    expect(outcome).toEqual({ rows: [["0"], ["a"], ["bb"]], cut: null });
    // ["0"] costs 5, [["a"] 6, [["bb"] 7.
    const first = SNOWFLAKE_RESULT_BYTE_BUDGET - 5 + SNOWFLAKE_PARTITION_SLACK_BYTES;
    expect(fetched).toEqual([
      [1, first, first],
      [2, first - 6, first - 6],
      [3, first - 13, first - 13],
    ]);
  });

  test("a row cut in partition 0 fetches nothing", async () => {
    const firstData = Array.from({ length: MAX_UNLIMITED_ROWS }, () => ["r"]);
    const { outcome, fetched } = await readPartitions([gzip('[["a"]]')], { firstData, columns: ["C"] });
    expect(outcome.cut).toBe("rows");
    expect(outcome.rows).toHaveLength(MAX_UNLIMITED_ROWS);
    expect(fetched).toEqual([]);
  });

  test("the row cut spans partitions", async () => {
    const firstData = Array.from({ length: MAX_UNLIMITED_ROWS - 1 }, () => ["r"]);
    const { outcome } = await readPartitions([gzip('[["a"],["b"]]'), gzip("[]")], { firstData, columns: ["C"] });
    expect(outcome.cut).toBe("rows");
    expect(outcome.rows).toHaveLength(MAX_UNLIMITED_ROWS);
    expect(outcome.rows.at(-1)).toEqual(["a"]);
  });

  test("a budget spent exactly by partition 0 with a partition left is the cut, and fetches nothing", async () => {
    const firstData = rowsOfBytes(SNOWFLAKE_RESULT_BYTE_BUDGET, 65_536);
    const { outcome, fetched } = await readPartitions([gzip("[]")], { firstData, columns: ["C"] });
    expect(outcome.cut).toBe("bytes");
    expect(fetched).toEqual([]);
  });

  test("an aborted signal stops the loop with its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    await expect(readPartitions([gzip("[]")], { signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("the encoding rule", () => {
  const text = '[["a",null],["é",""]]';
  const rows = JSON.parse(text);

  for (const [label, body] of [
    ["a gzip partition", gzip(text)],
    ["a GZIP partition", { ...gzip(text), contentEncoding: " GZIP " }],
    ["an identity partition with no encoding", identity(text)],
    ["an identity partition named identity", { ...identity(text), contentEncoding: "identity" }],
    ["a gzip body with no encoding header", { bytes: zlib.gzipSync(Buffer.from(text)) }],
  ] as const) {
    test(`${label} decodes`, async () => {
      const { outcome } = await readPartitions([body]);
      expect(outcome).toEqual({ rows, cut: null });
    });
  }

  test("a br partition is refused by name before any decoding", async () => {
    const gunzip = countingGunzip();
    const refusal = readResultRows({
      columns: COLUMNS,
      firstData: [],
      partitionCount: 2,
      fetchPartition: async () => answerOf({ bytes: zlib.gzipSync(Buffer.from(text)), contentEncoding: "br" }),
      signal: new AbortController().signal,
      deps: gunzip.deps,
    });
    await expect(refusal).rejects.toMatchObject({
      category: "query",
      message: SNOWFLAKE_ROWS_SENTENCES.encoding("br"),
    });
    expect(gunzip.counter.built).toBe(0);
    await expect(readPartitions([{ ...identity(text), contentEncoding: "gzip, br" }])).rejects.toMatchObject({
      message: SNOWFLAKE_ROWS_SENTENCES.encoding("gzip, br"),
    });
  });

  test("a gzip header on a body that is not gzip is refused as unreadable", async () => {
    await expect(readPartitions([{ ...identity(text), contentEncoding: "gzip" }])).rejects.toMatchObject(
      unreadableRefusal,
    );
    await expect(readPartitions([{ bytes: Buffer.alloc(0), contentEncoding: "gzip" }])).rejects.toMatchObject(
      unreadableRefusal,
    );
  });

  test("the production gunzip is used when no deps are given", async () => {
    const outcome = await readResultRows({
      columns: COLUMNS,
      firstData: [],
      partitionCount: 2,
      fetchPartition: async () => answerOf(gzip(text)),
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ rows, cut: null });
  });
});

describe("cut bodies", () => {
  const rows = Array.from({ length: 2_000 }, (_, i) => [`row ${i} ${"v".repeat(i % 50)}`, null]);
  const text = JSON.stringify(rows);

  test("a gzip body cut mid-stream with truncated ends as the cut, its partial row dropped", async () => {
    const whole = zlib.gzipSync(Buffer.from(text));
    const bytes = whole.subarray(0, Math.floor(whole.length / 2));
    const { outcome } = await readPartitions([{ bytes, contentEncoding: "gzip", truncated: true }, gzip("[]")]);
    expect(outcome.cut).toBe("bytes");
    expect(outcome.rows.length).toBeGreaterThan(0);
    expect(outcome.rows.length).toBeLessThan(rows.length);
    expect(outcome.rows).toEqual(rows.slice(0, outcome.rows.length));
  });

  test("the same bytes without truncated are refused as unreadable", async () => {
    const whole = zlib.gzipSync(Buffer.from(text));
    const bytes = whole.subarray(0, Math.floor(whole.length / 2));
    await expect(readPartitions([{ bytes, contentEncoding: "gzip" }])).rejects.toMatchObject(unreadableRefusal);
  });

  test("a text body cut inside a row and a character with truncated keeps the rows before it", async () => {
    const bytes = Buffer.from('[["a"],["b"],["é');
    const { outcome } = await readPartitions([{ bytes: bytes.subarray(0, bytes.length - 1), truncated: true }]);
    expect(outcome).toEqual({ rows: [["a"], ["b"]], cut: "bytes" });
  });

  test("a whole body reported truncated is still the cut", async () => {
    const { outcome } = await readPartitions([{ ...identity('[["a"]]'), truncated: true }]);
    expect(outcome).toEqual({ rows: [["a"]], cut: "bytes" });
  });
});

describe("the budget across streamed partitions", () => {
  test("a last streamed row landing exactly on the budget, with no partition left, is whole", async () => {
    const firstData = rowsOfBytes(SNOWFLAKE_RESULT_BYTE_BUDGET - 100, 65_536);
    // [["x...x"] costs the 95 x's plus 5.
    const body = `[["${"x".repeat(95)}"]]`;
    const whole = await readPartitions([gzip(body)], { firstData, columns: ["C"] });
    expect(whole.outcome.cut).toBeNull();
    expect(whole.outcome.rows).toHaveLength(firstData.length + 1);

    const over = await readPartitions([gzip(`[["${"x".repeat(96)}"]]`)], { firstData, columns: ["C"] });
    expect(over.outcome.cut).toBe("bytes");
    expect(over.outcome.rows).toHaveLength(firstData.length);
  });

  test("a cell larger than the budget stops at the chunk that passes it", async () => {
    const { outcome } = await readPartitions([identity(`[["${"c".repeat(SNOWFLAKE_RESULT_BYTE_BUDGET + 1)}"]]`)]);
    expect(outcome).toEqual({ rows: [], cut: "bytes" });
  });

  test("text outside the rows past the budget and the slack stops the read", async () => {
    const filler = "f".repeat(SNOWFLAKE_RESULT_BYTE_BUDGET + SNOWFLAKE_PARTITION_SLACK_BYTES);
    const { outcome } = await readPartitions([identity(`{"data":[["a"]],"other":"${filler}"}`)]);
    expect(outcome).toEqual({ rows: [["a"]], cut: "bytes" });
  });

  describe("the counted bomb", () => {
    let bomb: Buffer;
    let buildMs = 0;

    // Deflating 1 GiB takes about 4 s on an idle machine and past bun's 5 s hook default on a loaded one.
    beforeAll(async () => {
      const started = performance.now();
      bomb = await gzipRowsBomb(1024 ** 3);
      buildMs = performance.now() - started;
    }, 60_000);

    test("a 1 GiB bomb as partition 1 inflates no more than the budget and one gunzip chunk, and is cut", async () => {
      console.log(`bomb: ${bomb.length} compressed bytes, built in ${Math.round(buildMs)} ms`);
      expect(bomb.length).toBeLessThan(SNOWFLAKE_RESULT_BYTE_BUDGET);
      const { outcome, counter } = await readPartitions([{ bytes: bomb, contentEncoding: "gzip" }], {
        columns: ["C"],
        chunkSize: zlib.constants.Z_DEFAULT_CHUNK,
      });
      expect(outcome.cut).toBe("bytes");
      expect(counter.inflated).toBeGreaterThan(SNOWFLAKE_RESULT_BYTE_BUDGET - 16_384);
      expect(counter.inflated).toBeLessThanOrEqual(SNOWFLAKE_RESULT_BYTE_BUDGET + zlib.constants.Z_DEFAULT_CHUNK);
      // Every row costs 1,005 bytes: the first with the opening bracket, each later one with its comma.
      expect(outcome.rows.length).toBe(Math.floor(SNOWFLAKE_RESULT_BYTE_BUDGET / 1_005));
      expect(outcome.rows[0]).toEqual(["0".repeat(1_000)]);
    }, 30_000);
  });
});

describe("an oversized first answer read as a stream (SF-032)", () => {
  const meta = {
    numRows: 5000,
    format: "jsonv2",
    partitionInfo: [{ rowCount: 4096, uncompressedSize: 41_000_000 }],
    rowType: [
      { name: "N", type: "fixed", precision: 38, scale: 0, length: null },
      { name: 'P"A{D}', type: "text", precision: null, scale: null, length: 10000 },
    ],
  };
  const answerOf = (text: string, truncated: boolean, gzip = false): SnowflakeByteAnswer => ({
    status: 200,
    bytes: gzip ? zlib.gzipSync(Buffer.from(text)) : Buffer.from(text),
    contentEncoding: gzip ? "gzip" : null,
    truncated,
    attempts: 1,
  });
  // Snowflake's key order, as the trial answered it: the metadata, then the rows, then the status fields.
  const head = `{"resultSetMetaData" : ${JSON.stringify(meta, null, 1)},"data":[`;

  test("a cut body keeps the metadata whole and the rows before the cut, declared as the byte cut", async () => {
    const text = `${head}["0","${"x".repeat(100)}"],["1","yy"],["2","zz`;
    const { meta: read, outcome } = await readOversizedFirstAnswer(answerOf(text, true));
    expect(read).toEqual(meta);
    expect(outcome).toEqual({
      rows: [
        ["0", "x".repeat(100)],
        ["1", "yy"],
      ],
      cut: "bytes",
    });
  });

  test("a whole gzip body reads every row, skipping the fields after them", async () => {
    const text = `${head}["0","a"],["1",null]],"code":"090001","statementHandle":"h","message":"ok"}`;
    const { meta: read, outcome } = await readOversizedFirstAnswer(answerOf(text, false, true));
    expect(read).toEqual(meta);
    expect(outcome).toEqual({
      rows: [
        ["0", "a"],
        ["1", null],
      ],
      cut: null,
    });
  });

  test("metadata longer than one read slice is captured across the slices", async () => {
    const wide = {
      ...meta,
      rowType: Array.from({ length: 2000 }, (_, i) => ({ name: `C${i}`, type: "text", length: 1 })),
    };
    const row = JSON.stringify(Array.from({ length: 2000 }, () => "v"));
    const text = `{"resultSetMetaData":${JSON.stringify(wide)},"data":[${row}]}`;
    expect(text.length).toBeGreaterThan(65_536);
    const { meta: read, outcome } = await readOversizedFirstAnswer(answerOf(text, false));
    expect(read).toEqual(wide);
    expect(outcome.rows).toHaveLength(1);
  });

  test("a non-text cell names its column from the captured metadata", async () => {
    const refused = readOversizedFirstAnswer(answerOf(`${head}["0",7]]}`, false));
    await expect(refused).rejects.toThrow(SNOWFLAKE_ROWS_SENTENCES.nonString('P"A{D}'));
  });

  test("a body cut inside the metadata, one with none, or metadata that is not an object is still refused", async () => {
    for (const text of [
      '{"resultSetMetaData":{"numRows":1,"rowType":[{"name":"N"',
      '{"data":[["1"]]}',
      '{"resultSetMetaData":"text","data":[["1"]]}',
      '{"resultSetMetaData":[1],"data":[["1"]]}',
    ]) {
      const refused = readOversizedFirstAnswer(answerOf(text, text.endsWith('"N"')));
      await expect(refused).rejects.toThrow(SnowflakeError);
    }
    await expect(readOversizedFirstAnswer(answerOf('{"data":[["1"]]}', false))).rejects.toThrow(
      SNOWFLAKE_ROWS_SENTENCES.firstTooLarge,
    );
  });

  test("metadata the skipper passes over but JSON does not parse is refused as unreadable", async () => {
    for (const text of [
      '{"resultSetMetaData":{"a":1,,},"data":[["1"]]}',
      '{"resultSetMetaData":{"a" 1},"data":[["1"]]}',
      '{"resultSetMetaData":{"rowType":[01]},"data":[["1"]]}',
    ]) {
      const refused = readOversizedFirstAnswer(answerOf(text, false));
      await expect(refused).rejects.toMatchObject(unreadableRefusal);
    }
  });

  test("a scalar or string value before the metadata is skipped, and unnamed columns are numbered", async () => {
    const text = `{"code" : 1 ,"message":"a}b","resultSetMetaData":{"rowType":[{"type":"text"},null]},"data":[["a","b"]]}`;
    const { meta: read, outcome } = await readOversizedFirstAnswer(answerOf(text, false));
    expect(read).toEqual({ rowType: [{ type: "text" }, null] });
    expect(outcome.rows).toEqual([["a", "b"]]);
    const refused = readOversizedFirstAnswer(
      answerOf(`{"resultSetMetaData":{"rowType":[{"type":"text"},null]},"data":[["a",1]]}`, false),
    );
    await expect(refused).rejects.toThrow(SNOWFLAKE_ROWS_SENTENCES.nonString("2"));
  });

  test("the read asks for the budget plus the partition slack", () => {
    expect(SNOWFLAKE_OVERSIZED_FIRST_READ_BYTES).toBe(SNOWFLAKE_RESULT_BYTE_BUDGET + SNOWFLAKE_PARTITION_SLACK_BYTES);
  });
});
