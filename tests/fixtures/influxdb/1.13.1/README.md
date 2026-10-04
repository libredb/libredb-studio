# InfluxDB 1.13.1 captures

Image: `influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0`, the `influxdb1` service of `database-compose.yml`.
Captured 2026-10-04 by `tests/live/influxdb-evidence.ts`: 32 captures and 20 differential entries.
Principals: `admin` and `reader` (READ on `home`) over Basic; `token-without-user` sends the reader's password as `Authorization: Token <password>`.

## Measured here

- K5, document framing (`group-by-room-partial`, `regex-from-partial`, `chunk_size` 2): one JSON document per chunk, each ending in a newline; a series continued in the next document carries `"partial":true` on the series and on the result.
- K7, the 64 KiB form POST (`form-64k-quotes`, `form-64k-multibyte`): both 65,536-byte texts answer 200 with the count 26 as a form body.
- K13, a NaN result (`nan`, `sqrt("temp" - 100)`): the value is `null` in a 200.
- R33, an infinite result (`infinity`, `log("temp", 1)`): a top-level `{"error":"json: unsupported value: +Inf"}` in a 200, with no `results`.
- The differential corpus as the read principal: a 403 for every text the server parsed, naming its first statement as the server reprints it (`requires READ on studio_evidence_nowhere`), so the statement count is hidden; `c1-nul-in-string` is a 400 parse error.
- `two-databases-reader`: a 403 `requires READ on edge`; `two-databases-admin`: a 200 with the count 4.
- `token-without-user`: a 401 `unable to parse authentication credentials`.
- `mispick-query-sql` and `mispick-configure-database`: a 404 `404 page not found`.
