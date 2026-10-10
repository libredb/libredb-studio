/**
 * The two Parquet files of the S3 fixtures too large to commit: parquet/large/narrow-zstd.parquet (5 columns,
 * 1,000,000 rows) and parquet/large/wide-zstd.parquet (60 columns, 200,000 rows), the narrow and wide datasets the
 * preview's fetch budget was measured on, written with DuckDB's default row groups and zstd.
 *
 * One writer for both readers: tests/live/s3-seed-raw.ts seeds these files into studio-demo, and
 * tests/unit/db/s3/preview-parquet.test.ts previews the same files offline, so the k of row A39 that the unit case
 * asserts is the k of the seeded objects. Importing this module runs nothing.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

const NARROW = `SELECT i::INTEGER AS id,
  'customer_' || (i % 50000)::VARCHAR || '_' || substr(md5(i::VARCHAR), 1, 8) AS name,
  ((hash(i) % 1000000) / 100.0)::DOUBLE AS amount,
  (DATE '2020-01-01' + (i % 2000)::INTEGER) AS d,
  (i % 3 = 0) AS flag
FROM range(1000000) t(i)`;

function wideSql(): string {
  const columns: string[] = [];
  for (let k = 0; k < 60; k++) {
    switch (k % 5) {
      case 0:
        columns.push(`((i * ${k + 1}) % 1000003)::INTEGER AS c${k}_int`);
        break;
      case 1:
        columns.push(`substr(md5((i * 61 + ${k})::VARCHAR), 1, ${8 + (k % 17)}) AS c${k}_str`);
        break;
      case 2:
        columns.push(`((hash(i + ${k}) % 10000000) / 1000.0)::DOUBLE AS c${k}_dbl`);
        break;
      case 3:
        columns.push(`(DATE '2015-01-01' + ((i + ${k}) % 4000)::INTEGER) AS c${k}_date`);
        break;
      default:
        columns.push(`((i + ${k}) % 7 = 0) AS c${k}_bool`);
    }
  }
  return `SELECT ${columns.join(",\n  ")} FROM range(200000) t(i)`;
}

/** Writes both files under `<dir>/parquet/large/` with the repository's DuckDB. */
export async function writeLargeParquet(dir: string): Promise<void> {
  const large = path.join(dir, "parquet/large");
  mkdirSync(large, { recursive: true });
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await connection.run(
      `COPY (${NARROW}) TO '${path.join(large, "narrow-zstd.parquet")}' (FORMAT parquet, COMPRESSION zstd)`,
    );
    await connection.run(
      `COPY (${wideSql()}) TO '${path.join(large, "wide-zstd.parquet")}' (FORMAT parquet, COMPRESSION zstd)`,
    );
  } finally {
    connection.closeSync();
  }
}
