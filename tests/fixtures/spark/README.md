# Apache Spark captures

Answers Apache Spark gave to the provider's calls, written by `tests/live/spark-evidence.ts` from the services of `database-compose.yml`.
Each file is one RPC exchange: a `$captured` header whose request is written as the provider's codec reads it back, the outcome, and the decoded answer with every bytes field as `{"$bytes": "<base64>"}`, Arrow bodies byte for byte.
Client-chosen ids are written `<session>`, `<operation>` and `<tag>`, inside a `grpc-status-details-bin` too, whose Status message and ErrorInfo values are then re-encoded; the token is written `<token>`, and every Config value whose full key lies under `spark.sql.catalog.` `<value>`.
Every statement an entry runs before its capture that the replay sends is captured under its own name, and a FetchErrorDetails capture and its failure come from one run, so the errorIds pair.
Never edit a capture by hand: start the service, run `bun tests/live/spark-evidence.ts --setup <service>` and `--capture <service>`, or `--capture <service> <entry> ...` to retake the captures of some entries, then `--readme`.
A surface changed in the catalog needs no retake: `--surfaces` rewrites it in every capture without contacting a server, then `--readme` renders it.

## BUILT cases

The integration replay builds two cases from these captures and labels them: the version refusal (the 4.2.0 version answer rewritten to `3.5.9` and `4.0.4`) and a nested namespace listing (the `SHOW NAMESPACES` answer rewritten to multi-part spellings), because no catalog of the open-source fixture nests.

## Facts read from the captures

| Captures | Recorded |
|---|---|
| `4.2.0/config-catalog-keys`, `4.2.0/show-catalogs` | Config get_all keys: studio_unloaded; SHOW CATALOGS rows are in the Arrow answer |
| `4.2.0/session-conf-readback` | spark.sql.variable.substitute=false, spark.sql.execution.arrow.compression.codec=none, spark.sql.execution.arrow.useLargeVarTypes=false, spark.connect.session.resultChunking.maxChunkSize=4194304, spark.sql.execution.arrow.maxRecordsPerBatch=1000, spark.connect.progress.reportInterval=2s, spark.sql.connect.enrichError.enabled=true, spark.sql.legacy.keepCommandOutputSchema=false, spark.sql.debug.maxToStringFields=10000 |
| `4.2.0/large-var-types-refused` | outcome pass; the field types are in the Arrow schema |
| `4.2.0/use-namespace-current` | outcome pass; the rows are in the Arrow answer |
| `4.2.0/batch-rows` | row_count per batch: 1000, 1000, 500 |
| `4.2.0/negative-scale-decimal` | decimal(1,-10) |
| `4.1.3/session-conf-readback` | spark.sql.variable.substitute=false, spark.sql.execution.arrow.compression.codec=none, spark.sql.execution.arrow.useLargeVarTypes=false, spark.connect.session.resultChunking.maxChunkSize=4194304, spark.sql.execution.arrow.maxRecordsPerBatch=1000, spark.connect.progress.reportInterval=2s, spark.sql.connect.enrichError.enabled=true, spark.sql.legacy.keepCommandOutputSchema=false, spark.sql.debug.maxToStringFields=10000 |
| `4.1.3/large-var-types-refused` | outcome pass; the field types are in the Arrow schema |
| `4.1.3/use-namespace-current` | outcome pass; the rows are in the Arrow answer |
| `4.1.3/batch-rows` | row_count per batch: 1000, 1000, 500 |
| `4.1.3/negative-scale-decimal` | decimal(1,-10) |
| `4.2.0/proxy-silent-timeout` | outcome pass under the proxy's 300 s read timeout |
| `4.2.0/show-user-functions-quoted` | outcome pass; the names are in the Arrow answer |
| `4.2.0/command-over-batch-bound` | error 13, reason java.lang.AssertionError, errorClass none: assertion failed: remaining batches: 1 |
| `4.2.0/show-tables`, `show-views`, `show-user-functions`, `describe-table`, `describe-view`, `describe-table-struct30` | every statement the object surface issues on the studio namespace |

## 4.2.0

| Capture | Service | RPC | Surface | Outcome | Date | Runtime |
|---|---|---|---|---|---|---|
| `auth-no-token` | spark-auth | SparkConnectService/AnalyzePlan | a call without a token to a token server | error | 2026-10-13T11:07:21.213Z | bun 1.4.2 |
| `auth-wrong-token` | spark-auth | SparkConnectService/AnalyzePlan | a call with a wrong token | error | 2026-10-13T11:07:21.216Z | bun 1.4.2 |
| `batch-rows-command` | spark | SparkConnectService/ExecutePlan | 2,500 rows in batches of maxRecordsPerBatch: command step | pass | 2026-10-13T11:06:33.107Z | bun 1.4.2 |
| `batch-rows` | spark | SparkConnectService/ExecutePlan | 2,500 rows in batches of maxRecordsPerBatch: relation step | pass | 2026-10-13T11:06:33.175Z | bun 1.4.2 |
| `cancel-interrupt-command` | spark | SparkConnectService/ExecutePlan | Interrupt by tag of a running statement: command step | pass | 2026-10-13T11:06:33.877Z | bun 1.4.2 |
| `cancel-interrupt-relation` | spark | SparkConnectService/ExecutePlan | Interrupt by tag of a running statement: relation step | error | 2026-10-13T11:06:33.988Z | bun 1.4.2 |
| `cancel-interrupt` | spark | SparkConnectService/Interrupt | Interrupt by tag of a running statement | pass | 2026-10-13T11:06:33.988Z | bun 1.4.2 |
| `command-over-batch-bound` | spark-auth | SparkConnectService/ExecutePlan | a command answer above 0.7 times spark.connect.grpc.arrow.maxBatchSize=1m: command step | error | 2026-10-13T11:07:25.434Z | bun 1.4.2 |
| `compressed-lz4-command` | spark | SparkConnectService/ExecutePlan | a result after a session SET of the codec to lz4: command step | pass | 2026-10-13T11:06:35.473Z | bun 1.4.2 |
| `compressed-lz4-set` | spark | SparkConnectService/ExecutePlan | a result after a session SET of the codec to lz4: the statement run before it, command step | pass | 2026-10-13T11:06:35.465Z | bun 1.4.2 |
| `compressed-lz4` | spark | SparkConnectService/ExecutePlan | a result after a session SET of the codec to lz4: relation step | pass | 2026-10-13T11:06:35.515Z | bun 1.4.2 |
| `compressed-zstd-command` | spark | SparkConnectService/ExecutePlan | a result after a session SET of the codec to zstd: command step | pass | 2026-10-13T11:06:35.381Z | bun 1.4.2 |
| `compressed-zstd-set` | spark | SparkConnectService/ExecutePlan | a result after a session SET of the codec to zstd: the statement run before it, command step | pass | 2026-10-13T11:06:35.372Z | bun 1.4.2 |
| `compressed-zstd` | spark | SparkConnectService/ExecutePlan | a result after a session SET of the codec to zstd: relation step | pass | 2026-10-13T11:06:35.427Z | bun 1.4.2 |
| `config-catalog-keys` | spark | SparkConnectService/Config | tree: Config get_all of spark.sql.catalog., values written <value> | pass | 2026-10-13T11:06:35.545Z | bun 1.4.2 |
| `connect-current-namespace-studio` | spark | SparkConnectService/ExecutePlan | connect with a catalog and a namespace: SHOW CURRENT NAMESPACE on the metadata session, in studio: command step | pass | 2026-10-13T22:01:32.549Z | bun 1.4.2 |
| `connect-current-namespace` | spark | SparkConnectService/ExecutePlan | connect: SHOW CURRENT NAMESPACE on the metadata session: command step | pass | 2026-10-13T11:06:32.034Z | bun 1.4.2 |
| `connect-session-setup` | spark | SparkConnectService/Config | connect: the metadata session's Config set of nine pairs | pass | 2026-10-13T11:06:31.970Z | bun 1.4.2 |
| `connect-version` | spark | SparkConnectService/AnalyzePlan | connect: AnalyzePlan spark_version on a fresh session | pass | 2026-10-13T11:06:31.960Z | bun 1.4.2 |
| `describe-table-struct30` | spark | SparkConnectService/ExecutePlan | object surface: DESCRIBE TABLE wide_struct, its 30-field struct whole: command step | pass | 2026-10-13T21:14:02.510Z | bun 1.4.2 |
| `describe-table` | spark | SparkConnectService/ExecutePlan | object surface: DESCRIBE TABLE every_type: command step | pass | 2026-10-13T21:14:02.472Z | bun 1.4.2 |
| `describe-view` | spark | SparkConnectService/ExecutePlan | object surface: DESCRIBE TABLE every_type_view: command step | pass | 2026-10-13T21:14:02.493Z | bun 1.4.2 |
| `error-max-result-size-command` | spark-auth | SparkConnectService/ExecutePlan | a result above spark.driver.maxResultSize=4m: command step | pass | 2026-10-13T21:14:08.328Z | bun 1.4.2 |
| `error-max-result-size-details` | spark-auth | SparkConnectService/FetchErrorDetails | a result above spark.driver.maxResultSize=4m: FetchErrorDetails of its errorId | pass | 2026-10-13T21:14:09.106Z | bun 1.4.2 |
| `error-max-result-size` | spark-auth | SparkConnectService/ExecutePlan | a result above spark.driver.maxResultSize=4m: relation step | error | 2026-10-13T21:14:09.088Z | bun 1.4.2 |
| `error-missing-table-details` | spark | SparkConnectService/FetchErrorDetails | a missing table: FetchErrorDetails of its errorId | pass | 2026-10-13T21:14:02.233Z | bun 1.4.2 |
| `error-missing-table` | spark | SparkConnectService/ExecutePlan | a missing table: command step | error | 2026-10-13T21:14:02.226Z | bun 1.4.2 |
| `error-permission-denied-details` | spark | SparkConnectService/FetchErrorDetails | a file the server's user cannot read: FetchErrorDetails of its errorId | pass | 2026-10-13T11:06:33.848Z | bun 1.4.2 |
| `error-permission-denied` | spark | SparkConnectService/ExecutePlan | a file the server's user cannot read: command step | error | 2026-10-13T11:06:33.839Z | bun 1.4.2 |
| `error-syntax-details` | spark | SparkConnectService/FetchErrorDetails | a syntax error with ErrorInfo: FetchErrorDetails of its errorId | pass | 2026-10-13T11:06:33.526Z | bun 1.4.2 |
| `error-syntax` | spark | SparkConnectService/ExecutePlan | a syntax error with ErrorInfo: command step | error | 2026-10-13T11:06:33.504Z | bun 1.4.2 |
| `every-type-command` | spark | SparkConnectService/ExecutePlan | every-type SELECT: command step | pass | 2026-10-13T11:06:32.189Z | bun 1.4.2 |
| `every-type-relation` | spark | SparkConnectService/ExecutePlan | every-type SELECT: relation step | pass | 2026-10-13T11:06:32.699Z | bun 1.4.2 |
| `explain-formatted` | spark | SparkConnectService/ExecutePlan | EXPLAIN FORMATTED of a never-run SELECT: command step | pass | 2026-10-13T11:06:32.914Z | bun 1.4.2 |
| `large-var-types-refused-command` | spark | SparkConnectService/ExecutePlan | a SELECT after a session SET of useLargeVarTypes=true: command step | pass | 2026-10-13T11:06:32.946Z | bun 1.4.2 |
| `large-var-types-refused` | spark | SparkConnectService/ExecutePlan | a SELECT after a session SET of useLargeVarTypes=true: relation step | pass | 2026-10-13T11:06:33.007Z | bun 1.4.2 |
| `large-var-types-set` | spark | SparkConnectService/ExecutePlan | a SELECT after a session SET of useLargeVarTypes=true: the statement run before it, command step | pass | 2026-10-13T11:06:32.939Z | bun 1.4.2 |
| `negative-scale-decimal-command` | spark | SparkConnectService/ExecutePlan | 1E10BD under allowNegativeScaleOfDecimal: command step | pass | 2026-10-13T11:06:33.024Z | bun 1.4.2 |
| `negative-scale-decimal` | spark | SparkConnectService/ExecutePlan | 1E10BD under allowNegativeScaleOfDecimal: relation step | pass | 2026-10-13T11:06:33.078Z | bun 1.4.2 |
| `overview-app-conf` | spark | SparkConnectService/Config | overview: Config get_all of spark.app. | pass | 2026-10-13T11:06:35.804Z | bun 1.4.2 |
| `proxy-silent-timeout-command` | spark-tls | SparkConnectService/ExecutePlan | a silent run of about 15 s through the TLS proxy, under its 300 s read timeout: command step | pass | 2026-10-13T11:07:25.696Z | bun 1.4.2 |
| `proxy-silent-timeout` | spark-tls | SparkConnectService/ExecutePlan | a silent run of about 15 s through the TLS proxy, under its 300 s read timeout: relation step | pass | 2026-10-13T11:07:42.649Z | bun 1.4.2 |
| `release-session` | spark | SparkConnectService/ReleaseSession | ReleaseSession at the end of a request | pass | 2026-10-13T11:06:33.188Z | bun 1.4.2 |
| `request-session-setup` | spark | SparkConnectService/Config | a request session's Config set of seven pairs | pass | 2026-10-13T11:06:31.976Z | bun 1.4.2 |
| `row-budget-cut-command` | spark | SparkConnectService/ExecutePlan | 100,001 bigint rows, FROM-led, which the row budget cuts: command step | pass | 2026-10-13T11:06:33.202Z | bun 1.4.2 |
| `row-budget-cut` | spark | SparkConnectService/ExecutePlan | 100,001 bigint rows, FROM-led, which the row budget cuts: relation step | pass | 2026-10-13T11:06:33.335Z | bun 1.4.2 |
| `session-closed-show-catalogs` | spark | SparkConnectService/ExecutePlan | a metadata read on a released session: SHOW CATALOGS: command step | error | 2026-10-13T21:14:02.248Z | bun 1.4.2 |
| `session-closed` | spark | SparkConnectService/Config | a call on a released session | error | 2026-10-13T11:06:34.004Z | bun 1.4.2 |
| `session-conf-readback` | spark | SparkConnectService/Config | Config get of the nine keys after the setup | pass | 2026-10-13T11:06:32.144Z | bun 1.4.2 |
| `set-catalog` | spark | SparkConnectService/ExecutePlan | session setup step 2: SET CATALOG as a string literal: command step | pass | 2026-10-13T11:06:32.054Z | bun 1.4.2 |
| `show-catalogs` | spark | SparkConnectService/ExecutePlan | tree: SHOW CATALOGS: command step | pass | 2026-10-13T11:06:35.536Z | bun 1.4.2 |
| `show-create-table-missing-details` | spark | SparkConnectService/FetchErrorDetails | source: SHOW CREATE TABLE of a table that does not exist: FetchErrorDetails of its errorId | pass | 2026-10-13T21:14:02.574Z | bun 1.4.2 |
| `show-create-table-missing` | spark | SparkConnectService/ExecutePlan | source: SHOW CREATE TABLE of a table that does not exist: command step | error | 2026-10-13T21:14:02.569Z | bun 1.4.2 |
| `show-create-table` | spark | SparkConnectService/ExecutePlan | source: SHOW CREATE TABLE of a table: command step | pass | 2026-10-13T21:14:02.535Z | bun 1.4.2 |
| `show-create-view` | spark | SparkConnectService/ExecutePlan | source: SHOW CREATE TABLE of a view: command step | pass | 2026-10-13T21:14:02.557Z | bun 1.4.2 |
| `show-namespaces-unloaded-details` | spark | SparkConnectService/FetchErrorDetails | agent grounding walk: SHOW NAMESPACES IN studio_unloaded, a configured catalog Spark cannot load: FetchErrorDetails of its errorId | pass | 2026-10-13T22:17:46.490Z | bun 1.4.2 |
| `show-namespaces-unloaded` | spark | SparkConnectService/ExecutePlan | agent grounding walk: SHOW NAMESPACES IN studio_unloaded, a configured catalog Spark cannot load: command step | error | 2026-10-13T22:17:46.478Z | bun 1.4.2 |
| `show-namespaces` | spark | SparkConnectService/ExecutePlan | tree: SHOW NAMESPACES IN spark_catalog: command step | pass | 2026-10-13T11:06:35.573Z | bun 1.4.2 |
| `show-tables-default` | spark | SparkConnectService/ExecutePlan | overview: SHOW TABLES of the current namespace, for the table count: command step | pass | 2026-10-13T21:14:02.386Z | bun 1.4.2 |
| `show-tables-inline` | spark | SparkConnectService/ExecutePlan | a command answered inline with no Spark job: command step | pass | 2026-10-13T11:06:32.844Z | bun 1.4.2 |
| `show-tables` | spark | SparkConnectService/ExecutePlan | tree and object surface: SHOW TABLES: command step | pass | 2026-10-13T21:14:02.351Z | bun 1.4.2 |
| `show-user-functions-default` | spark | SparkConnectService/ExecutePlan | agent grounding walk: SHOW USER FUNCTIONS of the current namespace, for its count: command step | pass | 2026-10-13T22:17:46.536Z | bun 1.4.2 |
| `show-user-functions-quoted` | spark | SparkConnectService/ExecutePlan | function names that need quoting: command step | pass | 2026-10-13T21:14:02.438Z | bun 1.4.2 |
| `show-user-functions` | spark | SparkConnectService/ExecutePlan | tree and object surface: SHOW USER FUNCTIONS: command step | pass | 2026-10-13T21:14:02.422Z | bun 1.4.2 |
| `show-views-default` | spark | SparkConnectService/ExecutePlan | overview: SHOW VIEWS of the current namespace, for the table count: command step | pass | 2026-10-13T21:14:02.400Z | bun 1.4.2 |
| `show-views` | spark | SparkConnectService/ExecutePlan | tree and object surface: SHOW VIEWS: command step | pass | 2026-10-13T21:14:02.371Z | bun 1.4.2 |
| `substitution-off-command` | spark | SparkConnectService/ExecutePlan | SELECT '${x}' with substitution off: command step | pass | 2026-10-13T11:06:34.036Z | bun 1.4.2 |
| `substitution-off` | spark | SparkConnectService/ExecutePlan | SELECT '${x}' with substitution off: relation step | pass | 2026-10-13T11:06:35.332Z | bun 1.4.2 |
| `substitution-set` | spark | SparkConnectService/ExecutePlan | SELECT '${x}' with substitution off: the statement run before it, command step | pass | 2026-10-13T11:06:34.027Z | bun 1.4.2 |
| `temp-view-create` | spark | SparkConnectService/ExecutePlan | a temp view made by one statement, read by the next: the statement run before it, command step | pass | 2026-10-13T11:06:33.378Z | bun 1.4.2 |
| `temp-view-script-command` | spark | SparkConnectService/ExecutePlan | a temp view made by one statement, read by the next: command step | pass | 2026-10-13T11:06:33.406Z | bun 1.4.2 |
| `temp-view-script` | spark | SparkConnectService/ExecutePlan | a temp view made by one statement, read by the next: relation step | pass | 2026-10-13T11:06:33.491Z | bun 1.4.2 |
| `time-type-refused-command` | spark | SparkConnectService/ExecutePlan | a TIME literal with TIME values off: command step | pass | 2026-10-13T21:14:02.152Z | bun 1.4.2 |
| `time-type-refused-details` | spark | SparkConnectService/FetchErrorDetails | a TIME literal with TIME values off: FetchErrorDetails of its errorId | pass | 2026-10-13T21:14:02.209Z | bun 1.4.2 |
| `time-type-refused` | spark | SparkConnectService/ExecutePlan | a TIME literal with TIME values off: relation step | error | 2026-10-13T21:14:02.197Z | bun 1.4.2 |
| `tokenless-connect` | spark | SparkConnectService/AnalyzePlan | a tokenless server answers a call that carries a token | pass | 2026-10-13T11:06:32.148Z | bun 1.4.2 |
| `use-namespace-current` | spark | SparkConnectService/ExecutePlan | SHOW CURRENT NAMESPACE after USE NAMESPACE studio_unloaded: command step | pass | 2026-10-13T11:06:32.135Z | bun 1.4.2 |
| `use-namespace` | spark | SparkConnectService/ExecutePlan | session setup step 3: USE NAMESPACE: command step | pass | 2026-10-13T11:06:32.088Z | bun 1.4.2 |

## 4.1.3

| Capture | Service | RPC | Surface | Outcome | Date | Runtime |
|---|---|---|---|---|---|---|
| `batch-rows-command` | spark-4-1 | SparkConnectService/ExecutePlan | 2,500 rows in batches of maxRecordsPerBatch: command step | pass | 2026-10-13T11:07:13.520Z | bun 1.4.2 |
| `batch-rows` | spark-4-1 | SparkConnectService/ExecutePlan | 2,500 rows in batches of maxRecordsPerBatch: relation step | pass | 2026-10-13T11:07:13.588Z | bun 1.4.2 |
| `cancel-interrupt-command` | spark-4-1 | SparkConnectService/ExecutePlan | Interrupt by tag of a running statement: command step | pass | 2026-10-13T21:14:10.207Z | bun 1.4.2 |
| `cancel-interrupt-relation` | spark-4-1 | SparkConnectService/ExecutePlan | Interrupt by tag of a running statement: relation step | error | 2026-10-13T21:14:10.491Z | bun 1.4.2 |
| `cancel-interrupt` | spark-4-1 | SparkConnectService/Interrupt | Interrupt by tag of a running statement | pass | 2026-10-13T21:14:10.490Z | bun 1.4.2 |
| `config-catalog-keys` | spark-4-1 | SparkConnectService/Config | tree: Config get_all of spark.sql.catalog., values written <value> | pass | 2026-10-13T22:18:28.976Z | bun 1.4.2 |
| `connect-current-namespace-studio` | spark-4-1 | SparkConnectService/ExecutePlan | connect with a catalog and a namespace: SHOW CURRENT NAMESPACE on the metadata session, in studio: command step | pass | 2026-10-13T22:01:32.819Z | bun 1.4.2 |
| `connect-current-namespace` | spark-4-1 | SparkConnectService/ExecutePlan | connect: SHOW CURRENT NAMESPACE on the metadata session: command step | pass | 2026-10-13T11:07:12.242Z | bun 1.4.2 |
| `connect-session-setup` | spark-4-1 | SparkConnectService/Config | connect: the metadata session's Config set of nine pairs | pass | 2026-10-13T11:07:12.187Z | bun 1.4.2 |
| `connect-version` | spark-4-1 | SparkConnectService/AnalyzePlan | connect: AnalyzePlan spark_version on a fresh session | pass | 2026-10-13T11:07:12.180Z | bun 1.4.2 |
| `every-type-command` | spark-4-1 | SparkConnectService/ExecutePlan | every-type SELECT: command step | pass | 2026-10-13T11:07:12.387Z | bun 1.4.2 |
| `every-type-relation` | spark-4-1 | SparkConnectService/ExecutePlan | every-type SELECT: relation step | pass | 2026-10-13T11:07:13.018Z | bun 1.4.2 |
| `explain-formatted` | spark-4-1 | SparkConnectService/ExecutePlan | EXPLAIN FORMATTED of a never-run SELECT: command step | pass | 2026-10-13T11:07:13.297Z | bun 1.4.2 |
| `large-var-types-refused-command` | spark-4-1 | SparkConnectService/ExecutePlan | a SELECT after a session SET of useLargeVarTypes=true: command step | pass | 2026-10-13T11:07:13.344Z | bun 1.4.2 |
| `large-var-types-refused` | spark-4-1 | SparkConnectService/ExecutePlan | a SELECT after a session SET of useLargeVarTypes=true: relation step | pass | 2026-10-13T11:07:13.423Z | bun 1.4.2 |
| `large-var-types-set` | spark-4-1 | SparkConnectService/ExecutePlan | a SELECT after a session SET of useLargeVarTypes=true: the statement run before it, command step | pass | 2026-10-13T11:07:13.330Z | bun 1.4.2 |
| `negative-scale-decimal-command` | spark-4-1 | SparkConnectService/ExecutePlan | 1E10BD under allowNegativeScaleOfDecimal: command step | pass | 2026-10-13T11:07:13.439Z | bun 1.4.2 |
| `negative-scale-decimal` | spark-4-1 | SparkConnectService/ExecutePlan | 1E10BD under allowNegativeScaleOfDecimal: relation step | pass | 2026-10-13T11:07:13.496Z | bun 1.4.2 |
| `release-session` | spark-4-1 | SparkConnectService/ReleaseSession | ReleaseSession at the end of a request | pass | 2026-10-13T11:07:13.601Z | bun 1.4.2 |
| `request-session-setup` | spark-4-1 | SparkConnectService/Config | a request session's Config set of seven pairs | pass | 2026-10-13T11:07:12.191Z | bun 1.4.2 |
| `session-conf-readback` | spark-4-1 | SparkConnectService/Config | Config get of the nine keys after the setup | pass | 2026-10-13T11:07:12.347Z | bun 1.4.2 |
| `set-catalog` | spark-4-1 | SparkConnectService/ExecutePlan | session setup step 2: SET CATALOG as a string literal: command step | pass | 2026-10-13T11:07:12.266Z | bun 1.4.2 |
| `show-catalogs` | spark-4-1 | SparkConnectService/ExecutePlan | tree: SHOW CATALOGS: command step | pass | 2026-10-13T22:18:28.966Z | bun 1.4.2 |
| `show-namespaces-unloaded-details` | spark-4-1 | SparkConnectService/FetchErrorDetails | agent grounding walk: SHOW NAMESPACES IN studio_unloaded, a configured catalog Spark cannot load: FetchErrorDetails of its errorId | pass | 2026-10-13T22:18:29.042Z | bun 1.4.2 |
| `show-namespaces-unloaded` | spark-4-1 | SparkConnectService/ExecutePlan | agent grounding walk: SHOW NAMESPACES IN studio_unloaded, a configured catalog Spark cannot load: command step | error | 2026-10-13T22:18:29.028Z | bun 1.4.2 |
| `show-namespaces` | spark-4-1 | SparkConnectService/ExecutePlan | tree: SHOW NAMESPACES IN spark_catalog: command step | pass | 2026-10-13T22:18:28.999Z | bun 1.4.2 |
| `show-tables-default` | spark-4-1 | SparkConnectService/ExecutePlan | overview: SHOW TABLES of the current namespace, for the table count: command step | pass | 2026-10-13T22:18:29.065Z | bun 1.4.2 |
| `show-tables-inline` | spark-4-1 | SparkConnectService/ExecutePlan | a command answered inline with no Spark job: command step | pass | 2026-10-13T11:07:13.193Z | bun 1.4.2 |
| `show-user-functions-default` | spark-4-1 | SparkConnectService/ExecutePlan | agent grounding walk: SHOW USER FUNCTIONS of the current namespace, for its count: command step | pass | 2026-10-13T22:18:29.260Z | bun 1.4.2 |
| `show-views-default` | spark-4-1 | SparkConnectService/ExecutePlan | overview: SHOW VIEWS of the current namespace, for the table count: command step | pass | 2026-10-13T22:18:29.084Z | bun 1.4.2 |
| `time-type-refused-command` | spark-4-1 | SparkConnectService/ExecutePlan | a TIME literal with TIME values off: command step | pass | 2026-10-13T21:14:10.072Z | bun 1.4.2 |
| `time-type-refused-details` | spark-4-1 | SparkConnectService/FetchErrorDetails | a TIME literal with TIME values off: FetchErrorDetails of its errorId | pass | 2026-10-13T21:14:10.145Z | bun 1.4.2 |
| `time-type-refused` | spark-4-1 | SparkConnectService/ExecutePlan | a TIME literal with TIME values off: relation step | error | 2026-10-13T21:14:10.130Z | bun 1.4.2 |
| `tokenless-connect` | spark-4-1 | SparkConnectService/AnalyzePlan | a tokenless server answers a call that carries a token | pass | 2026-10-13T11:07:12.351Z | bun 1.4.2 |
| `use-namespace-current` | spark-4-1 | SparkConnectService/ExecutePlan | SHOW CURRENT NAMESPACE after USE NAMESPACE studio_unloaded: command step | pass | 2026-10-13T11:07:12.339Z | bun 1.4.2 |
| `use-namespace` | spark-4-1 | SparkConnectService/ExecutePlan | session setup step 3: USE NAMESPACE: command step | pass | 2026-10-13T11:07:12.300Z | bun 1.4.2 |
