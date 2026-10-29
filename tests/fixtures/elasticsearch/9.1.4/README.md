# Elasticsearch 9.1.4 captures

## Write refusals (`write-refusal/`)

Image: `docker.elastic.co/elasticsearch/elasticsearch:9.1.4`, the `elasticsearch` service of `database-compose.yml` (single node, security disabled), seeded per section 11.4 of `docs/providers/elasticsearch.md`.
Captured 2026-10-29 by `tests/live/elasticsearch-write-refusals.ts`: 20 statements, 20 captures.
Request: each statement sent raw as `POST /_sql?format=json` with the JSON body `{"query":<statement>}` and no credential, so no privilege stands between the statement and the grammar.

- Every write and DDL statement is refused by the grammar: a 400 `parsing_exception`, "mismatched input '<verb>' expecting {'(', 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}".
  None answers 200.
- That covers INSERT (VALUES and SELECT), UPDATE, DELETE (with and without WHERE), CREATE TABLE (plain and AS), CREATE INDEX, CREATE VIEW, DROP TABLE, DROP INDEX, ALTER TABLE (ADD COLUMN and RENAME), TRUNCATE and MERGE.
- A write behind a read keyword is refused the same way: `EXPLAIN INSERT`, `DEBUG DELETE`, `WITH ... INSERT` and `SELECT ... INTO`; a second statement after `;` is refused as one ("mismatched input ';'").
- After each statement the script read the cluster back and found it unchanged: the index listing with its document counts, every mapping, the aliases, the composable templates and the ingest pipelines.
