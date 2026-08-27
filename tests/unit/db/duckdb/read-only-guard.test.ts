/**
 * Unit tests for the DuckDB read-only statement guard (issue #424, #328).
 *
 * The guard exists because `access_mode: 'READ_ONLY'` is NOT a filesystem sandbox.
 * Measured on DuckDB v1.5.5 through a handle whose `INSERT` was refused in the same
 * session: `COPY (SELECT 1) TO '<path>'` wrote the file, `EXPORT DATABASE '<path>'`
 * wrote the directory, `INSTALL`/`LOAD` worked, and `read_text('/etc/hostname')`
 * returned the contents of a file outside the database entirely.
 *
 * The guard is DEFENCE IN DEPTH rather than the boundary: what actually stops those
 * forms is `enable_external_access: 'false'`, passed beside `access_mode` when the
 * read-only handle is opened. That matters to these tests, because a name denylist has
 * blind spots and the last block below pins them rather than leaving the list looking
 * exhaustive.
 *
 * These tests pin the guard's reading of the TEXT. The integration suite proves the
 * other half - that a refused statement leaves nothing on disk, and that the forms
 * below reach nothing even when the guard is blind to them - against a real read-only
 * handle.
 */

import { describe, expect, test } from "bun:test";
import { assertReadOnlyStatementIsBounded } from "@/lib/db/providers/sql/duckdb";
import { QueryError } from "@/lib/db/errors";

/** Every form measured escaping a read-only handle, in the shape a caller would write. */
const MEASURED_ESCAPES: ReadonlyArray<[label: string, sql: string]> = [
  ["COPY to a CSV file", "COPY (SELECT 1) TO '/tmp/leak.csv' (FORMAT CSV)"],
  ["COPY a table to Parquet", "COPY users TO '/tmp/leak.parquet' (FORMAT PARQUET)"],
  ["COPY FROM a file", "COPY users FROM '/tmp/in.csv'"],
  ["EXPORT DATABASE", "EXPORT DATABASE '/tmp/exp'"],
  ["IMPORT DATABASE", "IMPORT DATABASE '/tmp/exp'"],
  ["INSTALL an extension", "INSTALL httpfs"],
  ["LOAD an extension", "LOAD json"],
  ["ATTACH another database", "ATTACH '/tmp/side.duckdb' AS side"],
  ["DETACH the granted database", "DETACH warehouse"],
  ["read_csv_auto on a system file", "SELECT * FROM read_csv_auto('/etc/hostname')"],
  ["read_csv on a system file", "SELECT * FROM read_csv('/etc/hostname')"],
  ["sniff_csv on a system file", "SELECT * FROM sniff_csv('/etc/hostname')"],
  ["read_text on a system file", "SELECT * FROM read_text('/etc/hostname')"],
  ["read_blob on a system file", "SELECT * FROM read_blob('/etc/shadow')"],
  ["glob over a system directory", "SELECT * FROM glob('/etc/*')"],
  ["read_parquet", "SELECT * FROM read_parquet('/tmp/x.parquet')"],
  ["parquet_scan", "SELECT * FROM parquet_scan('/tmp/x.parquet')"],
  ["read_json", "SELECT * FROM read_json('/tmp/x.json')"],
  ["read_json_auto", "SELECT * FROM read_json_auto('/tmp/x.json')"],
  ["read_ndjson", "SELECT * FROM read_ndjson('/tmp/x.ndjson')"],
  ["read_ndjson_auto", "SELECT * FROM read_ndjson_auto('/tmp/x.ndjson')"],
  ["read_xlsx", "SELECT * FROM read_xlsx('/tmp/x.xlsx')"],
  ["delta_scan", "SELECT * FROM delta_scan('/tmp/delta')"],
  ["iceberg_scan", "SELECT * FROM iceberg_scan('/tmp/iceberg')"],
  // Every one of these reaches a file too, and every one was missing from the first
  // version of this list. `duckdb-provider.test.ts` now derives the set from the live
  // `duckdb_functions()` catalog so the next omission fails a test instead of shipping.
  ["read_json_objects", "SELECT * FROM read_json_objects('/tmp/x.json')"],
  ["read_json_objects_auto", "SELECT * FROM read_json_objects_auto('/tmp/x.json')"],
  ["read_ndjson_objects", "SELECT * FROM read_ndjson_objects('/tmp/x.ndjson')"],
  ["read_duckdb, which is ATTACH by another name", "SELECT * FROM read_duckdb('/tmp/other.duckdb')"],
  ["parquet_metadata", "SELECT * FROM parquet_metadata('/tmp/x.parquet')"],
  ["parquet_file_metadata", "SELECT * FROM parquet_file_metadata('/tmp/x.parquet')"],
  ["parquet_kv_metadata", "SELECT * FROM parquet_kv_metadata('/tmp/x.parquet')"],
  ["parquet_full_metadata", "SELECT * FROM parquet_full_metadata('/tmp/x.parquet')"],
  ["parquet_schema", "SELECT * FROM parquet_schema('/tmp/x.parquet')"],
  ["parquet_bloom_probe", "SELECT * FROM parquet_bloom_probe('/tmp/x.parquet', 'c', 1)"],
  [
    "json_execute_serialized_sql, which carries a whole statement in a literal",
    "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT * FROM read_text(''/etc/hostname'')'))",
  ],
];

describe("assertReadOnlyStatementIsBounded", () => {
  test.each(MEASURED_ESCAPES)("refuses %s", (_label, sql) => {
    expect(() => assertReadOnlyStatementIsBounded(sql)).toThrow(QueryError);
  });

  test("the refusal names the construct and says why the access mode does not cover it", () => {
    expect(() => assertReadOnlyStatementIsBounded("COPY (SELECT 1) TO '/tmp/leak.csv'")).toThrow(
      /Read-only execution refused COPY[\s\S]*not the filesystem around it/,
    );
  });

  test("case does not matter: the reader compares whole words, upper-cased", () => {
    expect(() => assertReadOnlyStatementIsBounded("copy (select 1) to '/tmp/leak.csv'")).toThrow(QueryError);
    expect(() => assertReadOnlyStatementIsBounded("select * from Read_Text('/etc/hostname')")).toThrow(QueryError);
  });

  test("a forbidden form hiding after a semicolon is still refused", () => {
    // Only the FIRST statement of a multi-statement string is executed (measured), so
    // this one could not have run - but the guard reads the whole string rather than
    // relying on that, because the reason the tail does not run lives in the driver.
    expect(() => assertReadOnlyStatementIsBounded("SELECT 1; COPY (SELECT 1) TO '/tmp/leak.csv'")).toThrow(QueryError);
  });

  // The complement, and the reason the guard is a code-word reader rather than a
  // regex: a keyword the statement merely MENTIONS is not the statement doing it.
  const ALLOWED = [
    ["a plain projection", "SELECT id, name FROM customers"],
    ["DuckDB's FROM-first syntax", "FROM customers LIMIT 10"],
    ["a CTE", "WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent"],
    ["SUMMARIZE", "SUMMARIZE customers"],
    ["a catalog read", "SELECT * FROM duckdb_tables()"],
    ["a storage read through CALL", "CALL pragma_storage_info('customers')"],
    ["EXPLAIN", "EXPLAIN (FORMAT JSON) SELECT 1"],
    ["a column literally named copy", 'SELECT "copy" FROM documents'],
    ["a string value that names a forbidden word", "SELECT * FROM audit WHERE action = 'COPY'"],
    ["a line comment mentioning one", "SELECT 1 -- do not COPY this anywhere"],
    ["a block comment mentioning one", "/* EXPORT DATABASE is refused */ SELECT 1"],
    ["a word merely beginning with one", "SELECT loaded, copied, globs FROM stats"],
    ["a dollar-quoted literal naming one", "SELECT $tag$INSTALL httpfs$tag$ AS note"],
  ] as const;

  test.each(ALLOWED)("allows %s", (_label, sql) => {
    expect(() => assertReadOnlyStatementIsBounded(sql)).not.toThrow();
  });

  test("refuses text it cannot read rather than guessing what follows", () => {
    // An unterminated literal means the span reader has no reliable view of the rest
    // of the statement, so a guard that guessed there could be walked straight past.
    expect(() => assertReadOnlyStatementIsBounded("SELECT 'unterminated")).toThrow(
      /unterminated string or comment[\s\S]*does not guess/,
    );
  });

  test("the unreadable-text refusal is a QueryError like every other refusal", () => {
    expect(() => assertReadOnlyStatementIsBounded("SELECT /* unterminated")).toThrow(QueryError);
  });
});

/**
 * What a name denylist cannot see - pinned rather than left implicit.
 *
 * Each of these was measured EXECUTING through this provider's read-only profile when
 * the denylist was the only control: `"read_text"('/etc/hostname')` returned
 * `{"content":"..."}` in the same run in which the unquoted spelling was refused. They
 * are refused today by `enable_external_access: 'false'`, engine-side, which is why
 * that flag - not this function - is the boundary.
 *
 * These assertions are deliberately `not.toThrow`. If a future matcher DOES see one of
 * these forms, the test fails and this comment has to be rewritten - which is the point:
 * nobody should be able to believe the list is exhaustive by accident.
 * `duckdb-provider.test.ts` holds the other half, where each of these reaches no file.
 */
describe("the guard's blind spots, and why the engine option is the boundary", () => {
  const INVISIBLE_TO_A_NAME_LIST = [
    ["a quoted function name", `SELECT * FROM "read_text"('/etc/hostname')`],
    ["a quoted, schema-qualified function name", `SELECT * FROM main."read_text"('/etc/hostname')`],
    ["a quoted glob", `SELECT * FROM "glob"('/etc/*')`],
    ["a quoted read_csv_auto", `SELECT * FROM "read_csv_auto"('/etc/hostname')`],
    ["a bare path, which DuckDB's replacement scan reads as read_csv_auto", "SELECT * FROM '/tmp/x.csv'"],
    ["a bare parquet path", "SELECT * FROM '/tmp/x.parquet'"],
  ] as const;

  test.each(INVISIBLE_TO_A_NAME_LIST)("the guard does not see %s", (_label, sql) => {
    expect(() => assertReadOnlyStatementIsBounded(sql)).not.toThrow();
  });

  test("the unquoted spelling of the same call IS seen, so the blindness is the quoting", () => {
    // The control that keeps the block above from being a list of statements the guard
    // was never going to refuse in the first place.
    expect(() => assertReadOnlyStatementIsBounded("SELECT * FROM read_text('/etc/hostname')")).toThrow(QueryError);
    expect(() => assertReadOnlyStatementIsBounded("SELECT * FROM glob('/etc/*')")).toThrow(QueryError);
    expect(() => assertReadOnlyStatementIsBounded("SELECT * FROM read_csv_auto('/etc/hostname')")).toThrow(QueryError);
  });
});
