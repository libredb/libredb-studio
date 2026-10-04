# InfluxDB captures

What InfluxDB 1.13.1, 2.9.1 and 3.12.0 Core answered over `node:http` before any provider code ran, one request per file.
The InfluxDB providers' tests replay these files through `tests/helpers/influxdb-transport.ts`, a recording `NodeTransport` handed to the real client through the provider constructor's client factory; no test here reaches a live server, and none uses `mock.module()`.

## Where they come from

`tests/live/influxdb-evidence.ts` sends every request of the statement plan in `tests/live/influxdb-evidence-plan.ts` to the services of `docker/influxdb/README.md` and writes `<version>/<capture>.json` for each, plus `manifest.json`.
`tests/helpers/influxdb-fixtures.ts` is the one reader: `loadInfluxCapture(version, name)`, `loadDifferentialCorpus(version)` and `loadInfluxManifest()`.
Each capture records the image as `tag@digest`, the date, the request, the status, the content type and the body.
The credential is recorded as its scheme (`basic`, `token`, `bearer` or `none`), never as its value, and the harness refuses to write any file that holds a password, a token, a Basic `user:password` or its base64.
A body the server ended before its terminating chunk carries `cut` (`zero-byte` when nothing arrived, `mid-line` when it ends inside a line, `line-end` when it ends after whole lines) and `bytes`, the bytes received.

The two captures of the file-limit fixture (`influxdb3-filelimit`, the same 3.12.0 Core image started with `--query-file-limit 1`) are written under `3.12.0-core/` as `filelimit-sql` and `filelimit-influxql`.
Two captures were sent to no server, and each carries a `synthetic` field saying where it comes from.
`3.12.0-core/ping-forbidden-synthetic.json` is the one file written by hand: a 403 `/ping` as InfluxDB 3 Enterprise answers a database token, from the Enterprise doc its `synthetic` field names, because the pinned Core image cannot produce it.
`3.12.0-core/sql-truncated-mid-line.json` is written by the harness, never by hand: the first bytes of `sql-truncated`, cut in the middle of its last line by `midLineSlice` in `tests/live/influxdb-evidence-checks.ts`, with the source and the offset in its `synthetic` field (R39).
3.12.0 flushes whole lines, so its own truncation ends on a line end; see `3.12.0-core/README.md` on K10.
`nowhere-check` on each line is the read after the run: what the database `studio_evidence_nowhere`, which exists on no server, holds; the harness fails unless it holds no series.

## The harness never writes

Every statement except a differential corpus entry passes its type's policy (`evaluateInfluxql` or `evaluateInfluxSql`) before the first request is sent, and `tests/unit/live/influxdb-evidence-plan.test.ts` holds the plan to the same rule.
A corpus entry is a fixed part, a separator and the hidden statement `SHOW DATABASES`, aimed at `studio_evidence_nowhere`, and on 1.13.1 and 2.9.1 sent only as the read principal.
`docker/influxdb/seed.sh` is the only writer, and the harness neither imports nor runs it.

## The differential corpus

`<version>/differential/` holds the corpus as each server read it: twenty-five entries per line, and on 3.12.0 also `two-statements`, the multi-statement answer whose results arrive as back-to-back documents.
The five `r42-*` entries separate two statements with whitespace or a comment alone: 1.13.1 and 2.9.1 answer "found SHOW, expected ;", and 3.12.0 runs both (R42).
`tests/unit/db/influxdb/influxql-differential.test.ts` reads each capture for the server's parse error or its statements and first statement, and holds `evaluateInfluxql` to refusing every entry the server read as more than one statement or as a first statement that is not a read.

## Re-recording

Re-record when a pinned image or the plan changes, with every service healthy:

1. Reseed as `docker/influxdb/README.md` "Reseeding" says, because `preview-home` and `sql-preview-home` need a seed younger than an hour.
2. Run `docker/influxdb/seed.sh bench`, which `sql-truncated` reads.
3. Start the file-limit fixture as `docker/influxdb/README.md` says, seeded once with `seed.sh filelimit`.
4. Run `bun tests/live/influxdb-evidence.ts` from the repository root.

The harness reads the fixed test credentials from `database-compose.yml` and `docker/influxdb/seed.sh`, and the 2.x read-only token from the seed's volume, and prints none of them.
A re-run changes the dates, the seed-relative timestamps, and the length of `sql-truncated` and of its slice `sql-truncated-mid-line`, because the cut point is a race on the server; update each version's README when anything else changes.
