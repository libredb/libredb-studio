/**
 * Writes every S3 preview fixture into this directory. Run by hand, never in CI:
 *   bun tests/fixtures/s3/preview/generate.ts
 * Parquet through the repository's own @duckdb/node-api, except fx-two-groups.parquet (see README.md); text through
 * string literals and node:zlib; binary through a fixed-seed PRNG. fx-expected.json holds the first 100 rows of the
 * 12-column SELECT as the preview's cell table renders them, computed from the SELECT's own formulas.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import { int32Plain, PHYSICAL, syntheticParquet } from "../../../helpers/parquet-synthetic";

const DIR = import.meta.dir;
const out = (name: string): string => path.join(DIR, name);

/** The 12-column SELECT of the measurement script, over `rows` rows. */
const select = (rows: number): string => `SELECT i::BIGINT AS id, 'row-' || i AS name, i * 1.5 AS amount,
  DATE '2026-01-01' + (i % 365)::INTEGER AS d, TIMESTAMP '2026-01-01 00:00:00' + to_seconds(i) AS ts,
  (i % 2 = 0) AS flag, (i / 100)::DECIMAL(18,2) AS dec, ('\\x00\\x01'::BLOB) AS blob, 9007199254740993::BIGINT AS big,
  {'a': i, 'b': 'x'} AS s, [i, i + 1] AS l, CASE WHEN i % 10 = 0 THEN NULL ELSE i END AS maybe FROM range(${rows}) t(i)`;

const CODECS = ["uncompressed", "snappy", "gzip", "zstd", "brotli", "lz4_raw"];

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
await connection.run("SET threads = 1");
for (const codec of CODECS) {
  // oxlint-disable-next-line no-await-in-loop -- one connection on one thread writes one file at a time.
  await connection.run(
    `COPY (${select(200)}) TO '${out(`fx-${codec}.parquet`)}' (FORMAT parquet, COMPRESSION ${codec})`,
  );
}
await connection.run(`COPY (${select(200)} WHERE false) TO '${out("fx-empty.parquet")}' (FORMAT parquet)`);
await connection.run(
  `COPY (SELECT i::INTEGER AS id, repeat('a', 1000000) || i::VARCHAR AS s FROM range(200) t(i)) TO '${out("bigcells-zstd.parquet")}' (FORMAT parquet, COMPRESSION zstd)`,
);

writeFileSync(
  out("fx-two-groups.parquet"),
  syntheticParquet({
    schema: [
      { name: "schema", children: 1 },
      { name: "id", type: PHYSICAL.INT32 },
    ],
    rowGroups: [
      {
        numRows: 50,
        chunks: [
          {
            path: ["id"],
            type: PHYSICAL.INT32,
            pages: [{ kind: "data", numValues: 50, body: int32Plain(Array.from({ length: 50 }, (_, i) => i)) }],
          },
        ],
      },
      {
        numRows: 70,
        chunks: [
          {
            path: ["id"],
            type: PHYSICAL.INT32,
            pages: [{ kind: "data", numValues: 70, body: int32Plain(Array.from({ length: 70 }, (_, i) => 50 + i)) }],
          },
        ],
      },
    ],
    createdBy: "libredb-studio tests/helpers/parquet-synthetic.ts",
  }),
);

// DuckDB's own read of the schema it wrote: a DECIMAL column reaches the preview as hyparquet computes it,
// Number(unscaled) * 10 ** -scale (hyparquet convert.js:87-98), so the expected cell is computed the same way.
const schemaRows = (
  await connection.runAndReadAll(`SELECT name, converted_type, scale FROM parquet_schema('${out("fx-zstd.parquet")}')`)
).getRowObjectsJson() as { name: string; converted_type: string | null; scale: number | string | null }[];
const asStored = (value: number, name: string): number => {
  const row = schemaRows.find((each) => each.name === name);
  if (row?.converted_type !== "DECIMAL") return value;
  const scale = Number(row.scale);
  return Math.round(value * 10 ** scale) * 10 ** -scale;
};
const day = 86_400_000;
const start = Date.UTC(2026, 0, 1);
const expectedRow = (i: number): (string | number | boolean | null)[] => [
  i,
  `row-${i}`,
  asStored(i * 1.5, "amount"),
  new Date(start + (i % 365) * day).toISOString().slice(0, 10),
  `${new Date(start + i * 1_000).toISOString().slice(0, 19)}.000000`,
  i % 2 === 0,
  asStored(i / 100, "dec"),
  "0001 (2 bytes)",
  "9007199254740993",
  `{"a":"${i}","b":"x"}`,
  `["${i}","${i + 1}"]`,
  i % 10 === 0 ? null : i,
];
writeFileSync(
  out("fx-expected.json"),
  `${JSON.stringify(
    {
      columns: ["id", "name", "amount", "d", "ts", "flag", "dec", "blob", "big", "s", "l", "maybe"],
      rows: Array.from({ length: 100 }, (_, i) => expectedRow(i)),
    },
    null,
    1,
  )}\n`,
);

const rowsCsv = 'id,name,amount\n1,alpha,1.5\n2,beta,3\n3,"gamma, delta",4.5\n';
const rowsNdjson = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n{"id":3,"tags":["x"]}\n';
const texts: Readonly<Record<string, string>> = {
  "rows.csv": rowsCsv,
  "semicolon.csv": "id;name\n1;a\n2;b\n",
  "quoted.csv": 'id,note\n1,"line one\nline two"\n2,"say ""hi"""\n',
  "ragged.csv": "a,b,c\n1,2\n1,2,3,4\n",
  "bom.csv": "\uFEFFid,name\n1,a\n",
  "rows.tsv": "id\tname\n1\ta b\n2\tc,d\n",
  "rows.ndjson": rowsNdjson,
  "mixed.ndjson": '{"id":1}\n7\n"text"\nnot json\n\n{"value":2}\n',
  "doc.json": '{"service":"studio","ports":[3000,9000],"nested":{"ok":true}}',
  "array.json": '[{"id":1,"name":"a"},{"id":2,"name":"b"}]',
  "bigint.json": '{"id":9007199254740993,"small":5}',
  "utf8-cut.txt": "aé€\u{1F600}".repeat(10),
};
for (const [name, text] of Object.entries(texts)) writeFileSync(out(name), text);
writeFileSync(out("rows.ndjson.gz"), gzipSync(rowsNdjson));
writeFileSync(out("rows.csv.gz"), gzipSync(rowsCsv));

/** mulberry32, seed 42: the same 300 bytes on every run. */
let seed = 42;
const next = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % 256;
};
writeFileSync(out("binary.bin"), Uint8Array.from({ length: 300 }, next));
console.log("written", CODECS.length + 3, "Parquet files and", Object.keys(texts).length + 3, "other files");
