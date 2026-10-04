# InfluxDB 2.9.1 captures

Image: `influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e`, the `influxdb2` service of `database-compose.yml`.
Captured 2026-10-04 by `tests/live/influxdb-evidence.ts`: 27 captures and 20 differential entries.
Principals: the operator token and the seed's read-only token for bucket `home`, both as `Authorization: Token`.

## Measured here

- K5, document framing (`group-by-room-partial`, `regex-from-partial`, `chunk_size` 2): one JSON document per chunk, each ending in a newline; a series continued in the next document carries `"partial":true` on the series and on the result.
- K7, the 64 KiB form POST (`form-64k-quotes`, `form-64k-multibyte`): both 65,536-byte texts answer 200 with the count 26 as a form body.
- K13, a NaN result (`nan`, `sqrt("temp" - 100)`): the value is `null` in a 200.
- R33, an infinite result (`infinity`, `log("temp", 1)`): the statement's own error, `{"results":[{"statement_id":0,"error":"json: unsupported value: +Inf"}]}`, in a 200.
- The differential corpus as the read token: one result per parsed statement, `database not found: studio_evidence_nowhere` then a second document `not executed` (both with `statement_id` 0), or, for the two `SHOW MEASUREMENTS` sources, an empty statement 0 and the hidden statement run as statement 1; `c1-nul-in-string` is a 400 parse error.
- `db-name-required`: a 200 whose statement error is `database name required`.
- `mispick-query-sql` and `mispick-configure-database`: a 200 `text/html` page, the 2.x UI, for both 3.x routes.
