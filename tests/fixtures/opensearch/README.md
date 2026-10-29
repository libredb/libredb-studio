# OpenSearch captures

Each capture is what a stock single node answered one request sent raw over HTTP, with no credential and no Studio check in front of it.
Every node ran with security disabled (`DISABLE_SECURITY_PLUGIN=true`), seeded per section 11.4 of `docs/providers/opensearch.md` (`probe_orders`, `probe_shapes`, `probe_buckets` and the alias `probe_orders_alias`).

## Write refusals (`<version>/write-refusal/`)

Captured 2026-10-29 by `tests/live/opensearch-write-refusals.ts` on `opensearchproject/opensearch:3.8.0` and `opensearchproject/opensearch:2.19.4`: 22 statements each, sent as `POST /_plugins/_sql` with the JSON body `{"query":<statement>}`.

- Every write and DDL statement is refused, and none answers 200.
  INSERT (VALUES and SELECT), UPDATE, CREATE TABLE (plain and AS), CREATE INDEX, CREATE VIEW, DROP TABLE, DROP INDEX, ALTER TABLE (ADD COLUMN and RENAME), TRUNCATE and MERGE each answer 400 `SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE, SHOW or DESCRIBE: <statement>".
- A write behind a read keyword is refused the same way: `EXPLAIN DELETE` and `WITH ... DELETE`.
- A second statement after `;` behind a SELECT is refused as one, 400 `ParserException`, "Illegal SQL expression".
- DELETE (with and without WHERE) differs by version.
  3.8.0 refuses it with `SQLFeatureNotSupportedException`, the same answer as INSERT: the 3.8.0 plugin's dispatcher has no DELETE branch left, although its refusal still names DELETE.
  2.19.4 refuses it with `SQLFeatureDisabledException`, "DELETE clause is disabled by default and will be deprecated. Using the plugins.sql.delete.enabled setting to enable it".
- Three statements answer 200 as plain reads, and the cluster reads back the same after each: `SELECT * INTO <name> FROM probe_orders` returns the rows and creates nothing, and `DESCRIBE TABLES LIKE ...` and `SHOW TABLES LIKE ...` with `; DELETE FROM probe_orders` behind them answer the catalog command and run no DELETE.
- After each statement the script read the cluster back and found it unchanged: the index listing with its document counts, every mapping, the aliases and the templates.
  The node's own bookkeeping indices (a leading `.`, and the query-insights `top_queries-` indices, which every statement adds to) are left out of that comparison.
- `legacyRoute` records the plugin's older route, `/_opendistro/_sql`.
  3.8.0 does not serve it ("no handler found"); 2.19.4 serves it, and each statement answered there exactly as on `/_plugins/_sql`.

## The delete setting (`<version>/delete-setting/`)

The same run then reads `plugins.sql.delete.enabled` (`GET /_cluster/settings?include_defaults=true&filter_path=*.plugins.sql.delete.enabled`), tries to turn it on, and sends `DELETE FROM` a name no index holds (`libredb_wr_no_such_index`) and a scratch index of one document, with the setting off and after the attempt to turn it on.
The script resets the setting and removes the scratch index afterwards.

- 3.8.0: the setting does not exist.
  The read answers `{}`, the write is refused 400 `settings_exception`, "transient setting [plugins.sql.delete.enabled], not recognized", and both DELETEs are refused before and after with `SQLFeatureNotSupportedException`; the scratch index keeps its document.
- 2.19.4: the setting reads `false` by default, and both DELETEs are refused with `SQLFeatureDisabledException`.
  Turned on, the setting reads `true`, the DELETE on the scratch index answers 200 with `deleted_rows` 1 and the index is left with no document, and the DELETE on the missing name answers HTTP 200 carrying an `IndexNotFoundException` error body.
