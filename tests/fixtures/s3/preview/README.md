# S3 preview fixtures

The files the S3 object preview's unit tests read.
Every file is written by `generate.ts` in this directory, run by hand and never in CI:

    bun tests/fixtures/s3/preview/generate.ts

No file here was typed by hand, and no test writes into this directory.

## Provenance

| File | Made by | Content |
|---|---|---|
| `fx-uncompressed.parquet`, `fx-snappy.parquet`, `fx-gzip.parquet`, `fx-zstd.parquet`, `fx-brotli.parquet`, `fx-lz4_raw.parquet` | `@duckdb/node-api` as pinned in `package.json`, `COPY ... (FORMAT parquet, COMPRESSION <codec>)` of the 12-column SELECT in `generate.ts`, 200 rows, one thread | One file per codec; DuckDB writes `LZ4_RAW` for `lz4`, so legacy `LZ4` has no fixture |
| `fx-expected.json` | `generate.ts`, from the SELECT's own formulas and DuckDB's `parquet_schema` of `fx-zstd.parquet` | The first 100 rows as the preview renders them; a DECIMAL cell is `Number(unscaled) * 10 ** -scale`, as hyparquet computes it |
| `fx-two-groups.parquet` | `tests/helpers/parquet-synthetic.ts` | One INT32 column in two row groups of 50 and 70 rows; DuckDB flushes a row group only after a whole input vector, so it cannot write a first row group smaller than the 100 rows a preview asks for |
| `fx-empty.parquet` | DuckDB, the same SELECT with `WHERE false` | No rows |
| `bigcells-zstd.parquet` | DuckDB, 200 distinct 1 MB strings beside an id column, zstd | Small on the wire, 200 MB decoded: the plan shows the id column only |
| `rows.csv`, `semicolon.csv`, `quoted.csv`, `ragged.csv`, `bom.csv`, `rows.tsv` | literals | The CSV and TSV rules |
| `rows.ndjson`, `mixed.ndjson`, `doc.json`, `array.json`, `bigint.json` | literals | The JSON and NDJSON rules |
| `rows.ndjson.gz`, `rows.csv.gz` | `node:zlib` `gzipSync` of the literals | The gzip layer |
| `binary.bin` | mulberry32 with seed 42 | 300 bytes for the hex dump |
| `utf8-cut.txt` | literal with 2-, 3- and 4-byte characters | The UTF-8 back-off |

Thrift and page-header edge cases are built in test code, never committed here.
