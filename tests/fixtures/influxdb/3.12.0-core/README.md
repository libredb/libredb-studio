# InfluxDB 3.12.0 Core captures

Image: `influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076`, the `influxdb3` service of `database-compose.yml`, and the same image as `influxdb3-filelimit` for the two `filelimit-*` captures.
Captured 2026-10-04 by `tests/live/influxdb-evidence.ts`: 53 captures and 21 differential entries, plus two synthetic captures: `ping-forbidden-synthetic.json`, written by hand, and `sql-truncated-mid-line.json`, sliced by the harness from `sql-truncated.json`.
Principal: the admin token as `Authorization: Bearer`; Core has no other.

## Measured here

- K5, document framing (`group-by-room-partial`, `regex-from-partial`, `chunk_size` 2): the JSON documents arrive back to back, with no newline between them; a series continued in the next document carries `"partial":true` on the series and on the result.
- K7, capture 15: both 65,536-byte texts answer 200 with the count 26 as a form POST (`form-64k-quotes`, `form-64k-multibyte`), and the quote-heavy text as a GET request target answers `414` with no body (`get-64k-414`).
- K10, a truncation after rows (`sql-truncated`, over `seed.sh bench`): `SELECT "i1" / ("i2" - 19999) AS "q" FROM "bulk" WHERE "host" = 'h00' AND "i2" >= 15000 ORDER BY "time"` answers 200 `application/jsonl`, streams whole lines, then resets the connection at the row whose divisor is zero.
  The cut point is a race: 6,016 bytes in this capture, from 1,216 to 40,034 bytes over sixty runs, and now and then nothing.
  The server flushes whole lines, so the cut lands on a line end: the 6,016-byte body ends with `{"q":0}` and a newline, and the capture says so with `cut: "line-end"` (R39).
  Measured on 2026-10-04: no cut inside a line in about 720 runs (curl, Python, and node with and without a paused reader); the harness sends this entry again only when nothing arrives, which happened 12 times in 200.
  Only a padded variant (`repeat('x', 4000)` per row) cut inside a line, 3 times in 40, at about 19 MB, too large to commit.
  `sql-truncated-mid-line` is therefore synthetic (R39): the first 6,011 bytes of this capture, cut in the middle of its last line (`{"q`), with the same request, status and content type, and a `synthetic` field naming the source and the offset.
  Unordered or over every host, the divisor fails before the first batch and the body is empty, as `sql-truncated-zero` (`SELECT co/(co-co) FROM home`) records.
- No truncation of `/query` was reproduced on this line: an integer or float division by zero answers 0 in InfluxQL, and an infinite value answers the top-level error below.
- K13, a NaN result (`nan`, `sqrt("temp" - 100)`): the value is `null` in a 200.
- R33, an infinite result (`infinity`, `log("temp", 1)`): a top-level `{"error":"json: unsupported value: +Inf"}` in a 200, with no `results`.
- K15, the file-limit error (`filelimit-sql`, `filelimit-influxql`): on `query_sql` a 500 with the plain text `External error: Query would scan 1 Parquet files, exceeding the file limit. ...`; on `/query` a 200 whose statement 0 carries that text after `datafusion error: `.
- K18, a cross-database table reference (`sql-cross-database`, `SELECT * FROM edge.iox.numbers` with `db=home`): a 400 with the plain text `Error during planning: table 'edge.iox.numbers' not found`.
- The differential corpus as admin: every text the Rust parser accepted ran the hidden statement as `statement_id` 1 after the database error of statement 0; `b5-nul` and the three `INTO` shapes are parse errors inside a 200 (`error in InfluxQL statement: parsing error: ...`).
- `two-statements`: both results of `SHOW DATABASES; SHOW DATABASES`, back to back (R19).
- `sql-schema-error`: a 500 with the plain text `Schema error: No field named nope. ...`; `sql-not-implemented`: a 405 `This feature is not implemented: Unsupported SQL statement: SHOW DATABASES`.
- `ping-anon`, `health-anon` and `unauthorized`: a 401 with no token.

## Write refusals (`write-refusal/`)

Image: the same `influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076`, the `influxdb3` service, seeded by `docker/influxdb/seed.sh`.
Captured 2026-10-29 by `tests/live/influxdb3-write-refusals.ts`: 43 statements and two token requests, 45 captures.
Request: each statement sent raw as `POST /api/v3/query_sql` with the JSON body `{"db":"home","q":<statement>,"format":"jsonl"}` and the admin token as `Authorization: Bearer`, with no read policy in front of it.

- Every write, DDL, COPY, SET, PREPARE and transaction statement is refused by the planner: a 400 `Error during planning: DML not supported: ...`, `DDL not supported: ...` or `Statement not supported: ...`, or a 405 `This feature is not implemented: ...`.
  None answers 200.
- That covers INSERT (VALUES, SELECT, into `system.queries`), CREATE TABLE (plain, AS, `SELECT ... INTO`), CREATE EXTERNAL TABLE, VIEW, SCHEMA, DATABASE, FUNCTION and INDEX, DROP TABLE, VIEW, SCHEMA, DATABASE and FUNCTION, DELETE, UPDATE, TRUNCATE, MERGE, COPY of a table and of a query, ALTER TABLE, SET, SET TIME ZONE, RESET, PREPARE, EXECUTE, DEALLOCATE, BEGIN, START TRANSACTION, COMMIT, ROLLBACK, VACUUM and ANALYZE TABLE.
- A write behind a read keyword is refused the same way: `EXPLAIN INSERT`, `EXPLAIN ANALYZE INSERT`, `EXPLAIN ANALYZE COPY` and `WITH ... INSERT`; a second statement is refused as one (`The context currently only supports a single SQL statement`).
- After each statement the script read the server back and found it unchanged: the databases, every table and column of each, the row counts of `home` and `edge`, the token table, and no file at any path a COPY or the external table named.
- `token-permissions`: the token table of `_internal` lists one token, `_admin`, with the permission `*:*:*`; Core mints only admin tokens (`influxdb3 create token` offers `--admin` alone).
- `token-resource-route`: the Enterprise route that mints a database-scoped token answers 404 `Not found` on Core.
  So no Core credential is read-only, and the boundary on this line is the planner's refusal above, never the token.
