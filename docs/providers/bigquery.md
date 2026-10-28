# Google BigQuery Provider

> Google BigQuery support for LibreDB Studio over the BigQuery REST API v2 (`https://bigquery.googleapis.com`), with no Google SDK.
> Every statement is a `jobs.query` call through the shared `node:https` transport, and the access token comes from a service-account key, Application Default Credentials or the metadata server (Workload Identity).
> This document is the reference for the BigQuery provider: connection, credentials, seeding, query behaviour, the dry-run estimate, schema introspection and monitoring.

|                        |                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Status**             | Implemented                                                                                          |
| **Database type id**   | `bigquery`                                                                                           |
| **Family**             | SQL (`src/lib/db/providers/sql/bigquery/`)                                                           |
| **Driver**             | None: REST over the shared transport; `jose` (already a dependency) signs service-account assertions |
| **Query language**     | `sql` (GoogleSQL; legacy SQL is never used)                                                          |
| **Default port**       | None: the endpoint is always `bigquery.googleapis.com:443`                                           |
| **Connection string**  | Not supported                                                                                        |
| **EXPLAIN**            | `bigquery-dryrun`: a dry run that reports the bytes the statement would process, and bills nothing   |
| **Writes**             | Whatever the credentials allow; DML returns `numDmlAffectedRows` as the row count                    |
| **Transactions**       | Not exposed                                                                                          |
| **Maintenance**        | None                                                                                                 |
| **Query parameters**   | Not supported yet: a parameterized call is refused with a message                                    |
| **Query cancellation** | Not supported yet                                                                                    |

## 1. Concept mapping

| BigQuery          | Studio                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| Project           | The connection (`database` field)                                      |
| Dataset           | Container, one level, labelled "Dataset"                               |
| Table             | Object kind `table` (also EXTERNAL, SNAPSHOT and CLONE tables)         |
| View              | Object kind `view`                                                     |
| Materialized view | Object kind `materialized_view`                                        |
| Location          | Detected at connect and sent with every job ([§5.3](#53-job-location)) |

## 2. Files

| File                                                                         | Role                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/lib/db/providers/sql/bigquery/index.ts`                                 | The provider: capabilities, query, object surface, catalog cache, monitoring                       |
| `src/lib/db/providers/sql/bigquery/transport.ts`                             | The only file that knows the REST envelope: jobs, dry runs, paging, datasets, tables, cell decoding |
| `src/lib/db/providers/sql/bigquery/auth.ts`                                  | Credential resolution and the token source                                                          |
| `src/lib/explain/bigquery-dryrun.ts`                                         | The EXPLAIN strategy that turns a statement into a dry run                                          |
| `src/hooks/use-dry-run-estimate.ts`, `src/components/studio/DryRunBadge.tsx` | The live "This query will process N" badge in the editor                                            |

## 3. Connection

### 3.1 Fields

| Field            | Label                                    | Required | Meaning                                                                                                                                                         |
| ---------------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`       | Project ID                               | Yes      | The project jobs run in and datasets are listed from                                                                                                            |
| `schema`         | Default dataset                          | No       | Unqualified table names resolve here; it also decides the job location                                                                                          |
| `password`       | Service-account key JSON or access token | No       | The whole key file's JSON, or a bearer token. Empty means the server's own credentials ([§3.2](#32-credentials))                                                |
| `location`       | Location                                 | No       | Where jobs run, e.g. `EU`, `US`, `europe-west3`. Empty means detected ([§5.3](#53-job-location))                                                                |

Host and port are not shown: the connection form draws them only for engines that declare them.
The SSL / TLS and SSH tunnel panels are not shown either (`showSslPanel: false`, `showSshTunnel: false`): every request is HTTPS to `googleapis.com` checked against the system trust store, and a tunnel would forward one address of the several the provider reaches (the API, the token endpoint, the metadata server).

### 3.2 Credentials

The provider resolves credentials in this order:

1. **Service-account key JSON** in the `password` field. Always used when present, and needs no server setting. An `authorized_user` JSON (from `gcloud auth application-default login`) is accepted too.
2. **An access token** in the `password` field, e.g. the output of `gcloud auth print-access-token` (`ya29.…`, with or without a `Bearer ` prefix). It is used as-is: Google issues it for about an hour and the provider has no way to refresh it, so the connection fails with an authentication error once it expires and the token must be pasted again. Use it for short-lived access or a CI job, not for a saved connection.
3. **The server's own identity**, only when the server runs with `BIGQUERY_SERVER_CREDENTIALS=true` and only for an operator-seeded (`managed: true`) connection; a connection a user creates needs a key or an access token:
   1. the file named by `GOOGLE_APPLICATION_CREDENTIALS` (a named file that cannot be read is an error, not a fallback);
   2. gcloud's ADC file, `~/.config/gcloud/application_default_credentials.json`;
   3. the metadata server (`metadata.google.internal`, or `GCE_METADATA_HOST`), which is how GKE Workload Identity, GCE and Cloud Run hand out tokens.

The opt-in exists because a connection without a key would otherwise run as the server: every user who can add a connection would query with the pod's service account.
That is also why a keyless connection that is not operator-seeded is refused even with the flag on, and why the server forces `managed` to false on any connection a browser sends inline (`resolveConnection`), so a client cannot claim to be a seed.
Without the flag and without a key, the connection is refused with a message that names the variable.

`external_account` (Workload Identity Federation outside GKE) and `impersonated_service_account` credential files are refused with a message.

Tokens are cached and refreshed a minute before they expire, and concurrent callers share one refresh instead of each minting a grant.

A server credentials file that cannot be read is reported without its path (the path goes to the server log).
The provider cache key includes `location`, so changing it gets a new provider instead of the cached one.
The agent's connection identity includes it too, because a moved location is another catalog view: a held inventory is not served under the new location, so plan mode reads the catalog again, and a follow-up question does not carry the conversation over.
The shared transport treats `Authorization` as a connection header, so each token gets its own transport, and a replaced one closes once its in-flight requests finish.

The agent's own credential is a service-account key JSON in `agentPassword` alone, because BigQuery declares `agentCredential: "service-account-key"`: the provider mints that key's token itself, so Studio chooses the scope the token carries.
An `agentUser`, an access token or an `authorized_user` JSON as the agent password is refused before the provider connects, since Studio cannot choose the scope of a token minted elsewhere.
Today that token carries the same `https://www.googleapis.com/auth/bigquery` scope as the connection's, so the form gives the agent no read-only property yet; moving the agent token to the `cloud-platform.read-only` scope is left to the change that brings BigQuery into agent execution.

### 3.3 Required IAM

| Use                                      | Role                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| Run queries                              | `roles/bigquery.jobUser` on the project                       |
| Read data and metadata                   | `roles/bigquery.dataViewer` on the datasets or project        |
| Monitoring: jobs, slow queries, sessions | `bigquery.jobs.listAll`, e.g. `roles/bigquery.resourceViewer` |

A monitoring panel whose read is refused stays empty rather than failing.

### 3.4 GKE Workload Identity

1. Annotate the Kubernetes service account the Studio pod runs as with `iam.gke.io/gcp-service-account: <gsa>@<project>.iam.gserviceaccount.com`.
2. Grant `roles/iam.workloadIdentityUser` on that Google service account to `serviceAccount:<project>.svc.id.goog[<namespace>/<ksa>]`.
3. Give the Google service account the roles in [§3.3](#33-required-iam).
4. Set `BIGQUERY_SERVER_CREDENTIALS=true` on the Studio deployment and leave the connection's key empty.

Do not set `DB_HTTP_BLOCK_PRIVATE_HOSTS=true` on such a deployment: it blocks the metadata server's link-local address `169.254.169.254`.

### Connection string

`bigquery` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/sql/bigquery/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `bigquery` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/sql/bigquery/execution-ui.ts).

## 4. Seeding

A BigQuery connection is seeded like any other ([SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)).
Keep the key out of the file with an environment variable or a Vault reference:

```yaml
connections:
  # A key from the environment; works anywhere.
  - id: "bq-integration"
    name: "BigQuery integration"
    type: "bigquery"
    database: "example-integration"      # project id
    schema: "analytics"                  # optional default dataset
    location: "EU"                       # optional; detected when absent
    password: "${BQ_INTEGRATION_SA_JSON}"
    roles: ["admin", "user"]

  # No key: the server's own identity (Workload Identity on GKE).
  # Needs BIGQUERY_SERVER_CREDENTIALS=true on the server.
  - id: "bq-production"
    name: "BigQuery production"
    type: "bigquery"
    database: "example-production"
    roles: ["admin"]
    managed: true
```

Keep a seeded connection that carries a key `managed: true` (the default), so the key stays on the server.

## 5. Query behaviour

### 5.1 Execution

`jobs.query` is called with `useLegacySql: false`, the connection's query timeout as both `timeoutMs` and `jobTimeoutMs`, the default dataset and the job location.
An unfinished job is polled with `getQueryResults`, and `pageToken` is followed until the row cap.
When the call fails or is aborted after the job exists (a timeout, a cancel, a dropped connection), the provider sends a best-effort `jobs.cancel` for it, so an abandoned query stops billing.
A project id must look like a BigQuery project id (letters, digits, hyphens, and `:` or `.` for legacy domain-scoped ids), and `.` and `..` are refused, because the id is part of the request path.
A table-level `403` is a `QueryError` with BigQuery's own message; only a `401` is an authentication error.
A deadline is a timeout error, which the shared retry and classification logic recognises.

Every completed query carries an info notice: `Processed 1.2 GB, billed 1.2 GB (cache hit)`.

### 5.2 Cell decoding

| BigQuery type                    | Studio value                               |
| -------------------------------- | ------------------------------------------ |
| `INT64`, `NUMERIC`, `BIGNUMERIC` | String, so no precision is lost            |
| `FLOAT64`                        | Number                                     |
| `BOOL`                           | Boolean                                    |
| `TIMESTAMP`                      | ISO 8601 string, truncated to milliseconds |
| `STRUCT` / `RECORD`              | Object                                     |
| Repeated (`ARRAY`)               | Array                                      |
| Everything else                  | The string BigQuery sends                  |

Column types are reported as GoogleSQL text, e.g. `ARRAY<STRUCT<s STRING, n INT64>>`.

### 5.3 Job location

A job runs where its request says, and a request that names no location runs in `US` unless BigQuery can infer one from the referenced tables.
A statement that names no table, such as the connect probe or a half-typed dry run, would then miss a project whose data lives in `EU` or `europe-west3`.

The location comes from, in order:

1. the connection's `location` field, when set;
2. otherwise, at connect, the default dataset's location, when `schema` is set;
3. otherwise the location most of the project's datasets share (a dataset listed without a location counts for none).

A principal that may not list datasets still connects: the location is then left to BigQuery, which infers it from the referenced tables (an authentication failure still fails the connect).
Every job is sent with the location when there is one.
In a project with datasets in several regions, set `location` to the region you query.

### 5.4 SQL grammar

The statement reader that decides where a statement ends, whether a keyword is real and whether a run needs a confirmation prompt has a BigQuery grammar (`BIGQUERY_GRAMMAR` in [`src/lib/db/providers/sql/bigquery/sql-grammar.ts`](../../src/lib/db/providers/sql/bigquery/sql-grammar.ts), the `bigquery` row of the SQL grammar registry in `src/lib/db/sql-grammar/`), every fact of it measured with `jobs.query` dry runs on 2026-10-11:

- `#` and `--` start a line comment, `//` does not, and `/* … */` does not nest.
- A backslash escapes the next character in `'…'` and `"…"`; a doubled quote is not an escape (BigQuery answers "concatenated string literals must be separated by whitespace or comments").
- `'''…'''` and `"""…"""` are string literals that may hold lone quotes, semicolons and line feeds, so a `DROP` or a `;` inside one is text and no longer raises a confirmation prompt.
- A backslash escapes a backtick inside a backtick name (`` `a\`b` `` is one name), and a doubled backtick is a syntax error, so a `;` hidden behind an escaped backtick is split the way BigQuery runs it (`backtickBackslashEscapes`).
- `[…]` is an array literal or a subscript, never a name.

A script (`BEGIN … END`) is not split: the shared splitter does not model it.

`readsSqlText` is `true`: the editor text is GoogleSQL, and the provider extends `SQLBaseProvider`.
Redaction is `sql` with no name quote: a redacted statement keeps its words, and every literal and quoted run becomes `?`.

### 5.5 SQL writing

[`bigquery/sql-writing.ts`](../../src/lib/db/providers/sql/bigquery/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalBackslash` and read back by `unquoteBackslash`: every escape, the quote's included, is spelled with a backslash, and doubling is not part of the grammar.
A name is quoted by `identifierBacktickBackslash`: a backtick name escaped inside with a backslash, where a doubled backtick is not an escape but ends the name.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
GoogleSQL escapes the quote as `\'` and does not accept doubling.
GoogleSQL quotes a name in backticks and escapes inside it with a backslash; a doubled backtick is not an escape there, it ends the name.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryTextBackslash` for a binary cell, the `\x…` text every other surface shows, quoted with `literalBackslash`.

## 6. Dry run and cost estimate

BigQuery has no `EXPLAIN` statement.
The `bigquery-dryrun` strategy prefixes the statement with a marker comment, and the provider sends a marked statement with `dryRun: true`.
The dry run validates the statement and returns `totalBytesProcessed` without running it or billing anything.

The editor uses it twice:

- **Explain** renders "Dry run: 1.2 GB would be processed".
- **Live badge**: while the person types, a debounced dry run (800 ms) shows "This query will process 1.2 GB when run." in the editor's corner, or the validation error in red. It is drawn only for connections whose EXPLAIN strategy declares `liveEstimate: true`, which `bigquery-dryrun` alone does.

### 6.1 AI clients

The provider implements no `queryReadOnly`, so MCP `run_read_query` and agent mode refuse a BigQuery connection.
`list_connections`, `inspect_schema` and plan mode work, because they read the object surface and send no statement.

## 7. Schema introspection

Datasets come from `datasets.list`.
Tables, views and their columns come from two region-level `INFORMATION_SCHEMA` queries per location (`TABLES` and `COLUMNS`), cached for 5 minutes.
On a project with 3014 objects this took the inventory from 78 s (one `tables.get` per table) to under 10 s.

If a region's views are refused, or a region holds more than 2 million columns, the provider falls back to REST for that region's datasets only: `tables.list` per dataset (cached 30 s) and `tables.get` per table, at most 8 at a time, where a table that cannot be read loses its columns instead of failing the inventory.
`tables.get` reports the legacy type names (`INTEGER`, `FLOAT`, `BOOLEAN`), which the provider renames to the GoogleSQL ones `INFORMATION_SCHEMA` uses (`INT64`, `FLOAT64`, `BOOL`), so both paths describe a column alike.
A dataset that `datasets.list` names without a location is still listed; its tables come from REST.
A catalog where every region failed is cached for 60 s (a good one for 5 minutes), so a principal without `INFORMATION_SCHEMA` access does not re-read every region on each tree expansion.
A shared table listing or catalog read runs on its own deadline, and each caller waits on it with its own, so one caller's cancel does not fail another.
A DDL statement run through the editor (`CREATE`, `DROP`, `ALTER`) drops the cached catalog and table lists, as does a disconnect, so a new table shows up at the next refresh.

Each `INFORMATION_SCHEMA` query bills BigQuery's 10 MB minimum.

The shared inventory route reads at most 1000 container/kind pairs; with three kinds, a project with more than about 333 datasets is truncated and the later datasets have no autocomplete.

### 7.1 Autocomplete

Completion is shared by every SQL engine; BigQuery adds one behaviour:

- A table suggestion outside the default dataset is labelled and inserted as `dataset.table`, so one name held by many datasets reads as many tables. With no default dataset, every table is still inserted qualified, because the provider declares `tablesNeedContainer`: a bare table name is an error in BigQuery.

### 7.2 Object source (#789): not in this version

No kind declares `hasSource`, and the provider implements no `readObjectSource`, so the Source view is not offered.
BigQuery does publish a view's text in `INFORMATION_SCHEMA.VIEWS.view_definition`; reading it would make `view` and `materialized_view` source-bearing and take `bigquery` off the abstainer list in `tests/isolated/object-source-declarations.test.ts`.

### 7.3 Object edit (#789): not in this version

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: object edit is not implemented in this version, and BigQuery enforces no key, so a row edit would have no row identity.
The absence is `bigquery`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` holds that entry and this section together.

## 8. Monitoring

The monitoring panels read the region `INFORMATION_SCHEMA` views for the detected location; a failed read is not cached, so the next poll retries.
`JOBS_BY_PROJECT` reads are cached for 60 s, because the panel polls every 30 s and every read bills the 10 MB minimum.
`TABLE_STORAGE` reads are cached for 15 minutes: a project-wide read scans the whole view, which a dry run estimated at about 1.2 GB in a project with many datasets.
The view prunes by where `table_schema` sorts, so a read filtered to one dataset estimated between about 70 MB and the full 1.2 GB depending on its name; the recorded reads of `tests/live/bigquery-evidence.ts` billed 0 bytes.
The overview and the storage panel share one read, grouped by dataset.

| Panel           | Source                       | Notes                                                                   |
| --------------- | ---------------------------- | ----------------------------------------------------------------------- |
| Overview        | `TABLE_STORAGE`              | Logical size and table count; views have no storage and are not counted |
| Performance     | `JOBS_BY_PROJECT`, last hour | Cache-hit share of query jobs, and query jobs per second                |
| Slow queries    | `JOBS_BY_PROJECT`, last 24 h | Grouped by query text, ordered by total run time; `rows` is always 0    |
| Active sessions | `JOBS_BY_PROJECT`            | Jobs not yet `DONE`; the job id is the session id                       |
| Tables          | `TABLE_STORAGE`              | Rows and logical bytes, the largest 500                                 |
| Storage         | `TABLE_STORAGE`              | Logical bytes per dataset, from the overview's read                     |

Uptime, connections and indexes have no BigQuery counterpart and stay empty.

## 9. Tests

| Test                                             | Covers                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/db/bigquery/decode.test.ts`          | Cell decoding, the dry-run strategy, job location selection                                                                                                                     |
| `tests/integration/db/bigquery-provider.test.ts` | The provider, transport and auth end to end, replaying the live captures of `tests/fixtures/bigquery/`: connect, query, object surface (shared conformance), monitoring         |
| `tests/unit/db/bigquery/provider.test.ts`        | The provider over a fake transport                                                                                                                                              |
| `tests/unit/db/bigquery/transport.test.ts`       | The REST envelope: `jobs.query`, the dry run, paging, job cancel, token lanes                                                                                                   |
| `tests/unit/db/bigquery/credentials.test.ts`     | Credential resolution order and the server-credentials opt-in                                                                                                                   |
| `tests/unit/db/bigquery/token-source.test.ts`    | Token minting, caching and single-flight refresh                                                                                                                                |
| `tests/unit/sql-completions.test.ts`             | Qualified table labels                                                                                                                                                          |
| `tests/unit/sql/bigquery-grammar.test.ts`        | The BigQuery statement grammar: triple quotes, `#` comments, escapes, subscripts                                                                                                |
| `tests/live/bigquery-live-check.ts`              | Hand-run, against goccy/bigquery-emulator; not in `bun run test` (see below)                                                                                                    |
| `tests/live/bigquery-evidence.ts`                | Hand-run, against a live project; records and scrubs the captures the integration test replays ([`tests/fixtures/bigquery/README.md`](../../tests/fixtures/bigquery/README.md)) |

### 9.1 Live check against the emulator

[goccy/bigquery-emulator](https://github.com/goccy/bigquery-emulator) answers the REST API locally, and the server sends every API request to it when `BIGQUERY_EMULATOR_HOST` (`host:port`, plain HTTP) is set in the server's environment; it is never a connection field.
While it is set the server mints no token and sends no `authorization` header, whatever credential the connection holds; the password field is still required and still parsed, so put a placeholder access token (20 or more URL-safe characters) or a key JSON there; neither is sent.
`tests/live/bigquery-live-check.ts` runs the real provider and transport against it and exits non-zero on any failure:

```bash
docker run --rm -p 127.0.0.1:9050:9050 ghcr.io/goccy/bigquery-emulator:0.8.1 --project=demo-project --dataset=libredb_live
BIGQUERY_EMULATOR_HOST=127.0.0.1:9050 bun tests/live/bigquery-live-check.ts
```

It covers connect, `datasets.list`, `tables.list` and `tables.get` (tables, views and their columns), typed cells, a 12,000-row result, and a query across two pages: `jobs.query`, then `getQueryResults` with the page token.
The emulator's `jobs.query` answers every row and no `pageToken` (it ignores `maxResults`, `server/handler.go` at v0.8.1), so for the paging check the script puts a pass-through proxy in front of it that cuts the first answer at `maxResults` as BigQuery does; every later page is the emulator's own `getQueryResults` answer.

It does not cover, so these stay covered by the replayed captures only: dry runs and bytes processed (the emulator runs a `dryRun` query and reports no bytes), region-level `INFORMATION_SCHEMA` (refused, so the catalog comes from the REST fallback there), monitoring, job cancel, locations, and authentication (the emulator checks none, so none is sent).

## Migration DDL

[`BIGQUERY_MIGRATION_DDL`](../../src/lib/db/providers/sql/bigquery/migration-ddl.ts) is what the schema-diff migration generator writes for `bigquery`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
BigQuery runs each statement as its own job, and `BEGIN TRANSACTION` exists only inside a multi-statement script, so `transactionWrapper` is `null` (#284).
It has no foreign-key constraint this generator could write, so an added or dropped foreign key is a comment.
An added table declines its primary key in a comment after the `CREATE TABLE`, and a modified column is a comment naming the column.
Index changes are a comment too, because BigQuery's only indexes are search and vector indexes.
The fields it takes unchanged from `src/lib/db/migration-ddl/shared.ts` are `standardAddColumn`, `standardColumnDef`, `standardDropColumn` and `standardDropTable`.

Every refusal reason it can print, verbatim:

- "BigQuery widens a column with ALTER COLUMN ... SET DATA TYPE only along its coercion rules, and nothing else; write the change by hand."
- "BigQuery: Cannot generate index DDL. BigQuery has search and vector indexes only; write the index change by hand."
- "The engine has no foreign-key constraint."
- "BigQuery accepts a primary key only as PRIMARY KEY (...) NOT ENFORCED."
