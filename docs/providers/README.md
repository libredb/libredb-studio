# Database Provider Reference

This folder holds the **prime (canonical) reference for each database provider** in LibreDB Studio.
There is exactly one document per provider, named by the provider's canonical **type-id** and kept
in lockstep with the code (see the tri-sync rule in [`../../CLAUDE.md`](../../CLAUDE.md)).

| Provider | type-id | Family | Driver | Query language | Reference |
|----------|---------|--------|--------|----------------|-----------|
| PostgreSQL | `postgres` | SQL | `pg` | SQL | [postgres.md](./postgres.md) |
| MySQL | `mysql` | SQL | `mysql2` | SQL | [mysql.md](./mysql.md) |
| Oracle | `oracle` | SQL | `oracledb` (Thin) | SQL | [oracle.md](./oracle.md) |
| Microsoft SQL Server | `mssql` | SQL | `mssql` | SQL (T-SQL) | [mssql.md](./mssql.md) |
| SQLite | `sqlite` | SQL (embedded) | `bun:sqlite` (Bun) / `node:sqlite` (Node) | SQL | [sqlite.md](./sqlite.md) |
| Redis | `redis` | Key-Value | `ioredis` | JSON | [redis.md](./redis.md) |
| MongoDB | `mongodb` | Document | `mongodb` | JSON (MQL) | [mongodb.md](./mongodb.md) |
| Couchbase | `couchbase` | Document | none (HTTP: Query + management REST) | SQL (SQL++) | [couchbase.md](./couchbase.md) |
| ClickHouse | `clickhouse` | SQL | none (HTTP interface) | SQL | [clickhouse.md](./clickhouse.md) |
| Apache Druid | `druid` | SQL (analytics) | none (HTTP: SQL endpoint) | SQL (Calcite) | [druid.md](./druid.md) |
| Elasticsearch | `elasticsearch` | SQL (search) | none (HTTP: `_sql` + REST) | SQL (Elasticsearch SQL) | [elasticsearch.md](./elasticsearch.md) |
| OpenSearch | `opensearch` | SQL (search) | none (HTTP: `_plugins/_sql` + REST) | SQL (OpenSearch SQL plugin) | [opensearch.md](./opensearch.md) |
| Apache Trino | `trino` | SQL (federated query engine) | none (HTTP: the client protocol, `POST /v1/statement`) | SQL (Trino) | [trino.md](./trino.md) |
| Apache Cassandra | `cassandra` | SQL (wide-column) | `cassandra-driver` (pure JS) | SQL-shaped (CQL) | [cassandra.md](./cassandra.md) |
| LibreDB | `libredb` | Embedded (Key-Value) | `@libredb/libredb` | JSON (command grammar) | [libredb.md](./libredb.md) |

## Conventions

- **Filename = canonical type-id** (`postgres.md`, `mssql.md`, …), mirroring the source file
  (`src/lib/db/providers/<family>/<type-id>.ts`, or a `<type-id>/` directory when a provider is
  split across modules, as Couchbase, ClickHouse, Druid, Trino and Cassandra are). The official product name (e.g.
  "SQL Server") is used only in each doc's title and prose. **One directory may serve two type-ids**
  — `providers/sql/search/` is `elasticsearch` and `opensearch` — and each type-id still gets its own
  document, because the tri-sync invariant is per type-id and each doc is the prime reference for its
  own product's measured behaviour.
- **Each doc mirrors the code.** Every `file:line` citation is verified, and the per-provider triad
  — code, this doc, and `tests/integration/db/<type-id>-provider.test.ts` — must stay in sync in the
  same PR (the *provider tri-sync invariant*).
- Each doc follows the same ~15-section shape: Overview → Architecture → Design decisions →
  Connection → Query interface → Schema → Monitoring → Maintenance → Capabilities & labels → Error
  handling → Testing → Usage → Known limitations → References.

## Wire-compatible engines

These engines have **no provider of their own**. Each one speaks the wire protocol of a driver
above, so it connects through that driver unchanged — pick the driver's button in the connection
dialog and the engine works. The connection dialog says so too, from the same data
([`src/lib/db/compatibility.ts`](../../src/lib/db/compatibility.ts)).

A name appears here **only after a live probe** ran against a real instance of it through the real
provider ([issue #424](https://github.com/libredb/libredb-studio/issues/424), Phase 0). The version
column is what that server reported; it is not a supported range. "Connects" is not "supported", so
the support column records how much of the product actually worked:

- **Full** — every introspection surface answered. Caveats may still note data that is present but
  inaccurate.
- **Partial** — the editor works; parts of the object browser or the monitoring dashboard are blank.
- **Query editor only** — SQL runs and nothing else does. Usable, but not as a managed database.

| Engine | Connect as | Support | Probed version | What to expect |
|--------|-----------|---------|----------------|----------------|
| MariaDB | `mysql` | Full | 12.3.2-MariaDB-ubu2404 | Behaves as MySQL throughout. The version shown is MariaDB's full build string, passed through as the server gave it. **`performance_schema` ships OFF** (`@@performance_schema` = 0), so the cache-hit, queries-per-second and buffer-pool figures are absent and the slow-query list is empty until the server is started with `performance_schema=ON`; the tables exist either way, so nothing fails, it simply measures nothing. The schema tree, sizes, row counts, sessions and `EXPLAIN FORMAT=JSON` come from `information_schema` and are unaffected. Only 12.3 was probed; the 10.x `information_schema` surface was not. |
| TiDB | `mysql` | Full | 8.0.11-TiDB-v8.5.1 | All surfaces answer. A freshly loaded table reads **0 rows and 0 B until TiDB's background statistics catch up** — they correct themselves, with no `ANALYZE`. Max connections reads 0 (TiDB's default, meaning unlimited), the slow-query panel is always empty (TiDB's slow log lives in `information_schema.SLOW_QUERY`), and storage stats list a phantom `InnoDB` entry. The Explain panel does not work either — TiDB rejects `EXPLAIN FORMAT='json'` — though the query itself runs normally. Probed on a standalone `--store=unistore` server only; PD + TiKV was not probed. |
| Vitess | `mysql` | Full | 8.0.43-Vitess (Vitess 24.0.2) | All fifteen surfaces answer and the browser is clean: 2 objects for 2 user tables. **Row counts and total size are exact**, checked against the engine (2000 rows read as 2000; 163840 bytes as 163840), and a foreign key is both read back and enforced. Two things do not work. **A running query cannot be cancelled**: vtgate refuses `KILL QUERY` with `VT07001` and the statement runs to completion (a 5 second `SLEEP` took its full 5003 ms). And per-index sizes always read 0 bytes, because Vitess names the InnoDB table after the physical shard database (`vt_probe_0`), which is also the name the table and index statistics show instead of the keyspace you connected to. Setting a session variable can fail where reading it works: `SET @@cte_max_recursion_depth` is rejected as an unknown system variable, while `SELECT @@cte_max_recursion_depth` answers 1000. Probed on an unsharded single-shard keyspace only; a sharded keyspace was not probed, and no permission error could be measured because `vttestserver` grants every login full rights. |
| Citus | `postgres` | Full | citus 14.1-1 on PostgreSQL 18.4 | All surfaces answer. **Row counts and sizes for a distributed table are wrong, not missing** — PostgreSQL statistics describe the empty coordinator parent, not the shards. `citus_tables` and `citus_schemas` show up in the browser. |
| TimescaleDB | `postgres` | Full | TimescaleDB 2.29.2 on PostgreSQL 17.11 | All surfaces answer. **A hypertable's row count and size are wrong, not missing** — the statistics describe the empty parent table, not the chunks. Every chunk shows up as its own table and index, along with the `_timescaledb_catalog` and `_timescaledb_cache` schemas. The overview shows PostgreSQL's version, not the extension's. **The agent cannot ground a run here** — the extension's catalogs answer 473 of 478 rows in the grounding read, over its 200-row budget, on a stock install. |
| YugabyteDB | `postgres` | Full | YugabyteDB 2.25.2.0-b0 (advertises PostgreSQL 15.12) | All surfaces answer, foreign keys included. **Row counts and sizes read 0 until you run `ANALYZE`** — nothing collects statistics automatically, so a full database looks empty. Index sizes always read 0 bytes (index storage lives in DocDB) and the overview's database size reads 0 bytes. Index types read `lsm`, which is the real storage rather than a misreading. |
| AlloyDB Omni | `postgres` | Full | PostgreSQL 17.9 (AlloyDB Omni 17.9.0) | All fifteen surfaces answer, and the numbers are exact: 2000 rows read as 2000 and 270336 bytes as 270336 (180224 table plus 90112 index), with a foreign key both read back and enforced by the engine. **The version panel cannot be told apart from a stock PostgreSQL 17** - `version()` reports `PostgreSQL 17.9 on x86_64-pc-linux-gnu` and names AlloyDB nowhere; the product is identifiable only from the `alloydb.*` settings and the image tag. The object browser lists 10 objects for 2 user tables, the 8 extras being AlloyDB's own `google_ml` tables - and **that understates what is installed**: outside the system schemas there are 70 objects, because 49 extension views live in `public` itself (`g_columnar_*`, `google_db_advisor_*`, `hypopg_list_indexes` and more), which the browser hides only because its schema query filters `table_type = 'BASE TABLE'`. A role with no grants at all - `LOGIN` plus `CONNECT`, `ALL` revoked on `public` - still lists those `google_ml` tables and reads them (`SELECT count(*) FROM google_ml.supported_vertex_models` answered 15 to it). The slow-query panel is empty because `pg_stat_statements` ships with the image but is not installed in it, which health reports honestly. The columnar engine is off by default and needs `ALTER SYSTEM` plus a restart; with it on the on-disk sizes stay exact but do not count the columnar copy. **The agent cannot ground a run here**: the image's own `postgres` superuser is refused as too broad, and a least-privilege role - which does acquire both profiles - has its capture refused at 536 rows against a 200-row budget, only 7 of them the user's, and narrowing the capture to `public` alone still refuses at 348 (B52). Probed on the 17.9.0 image only; the 15.x and 16.x lines were not. |
| Valkey | `redis` | Full | Valkey 9.1.1 | Behaves as Redis. The overview shows the Redis emulation level (7.2.4), not the Valkey version. |
| DragonflyDB | `redis` | Full | DragonflyDB df-v1.40.1 | Overview shows the emulation level (7.4.0). Max connections reads 0 (no usable `maxclients` in `INFO`), and active sessions show a numeric id instead of a username (`CLIENT LIST` omits `user=`). |
| KeyDB | `redis` | Full | KeyDB 6.3.4 | Publishes no version field of its own, so the overview is indistinguishable from a Redis 6 server. A session's command can appear without its subcommand. |
| FerretDB | `mongodb` | Full | FerretDB 2.7.0 (MongoDB 7.0.77 wire) | Every monitoring surface answers. Sign in with the **backend PostgreSQL** credentials — `authMechanism=PLAIN` is rejected. The version shown is the advertised MongoDB wire version. Needs its own backend, so it is two containers. |
| StarRocks | `mysql` | Partial | StarRocks 3.3.22-753696f | The editor, the table list, column metadata, table and storage stats, performance metrics and slow queries all work. **The version reads MySQL 5.1** — `version()` returns a fictitious 5.1.0 and the real build is only in `current_version()`. The overview, health, active-session and monitoring panels all fail (the first two on the prepared-statement protocol, the other two on a missing `information_schema.PROCESSLIST`). **Those first two are not a StarRocks quirk**: the prepared-statement cause is ours and shared with SingleStore, where it takes five surfaces down - one change to the provider would plausibly recover panels on both engines (D8 in [`../BACKLOG.md`](../BACKLOG.md)). Row counts and sizes are hard zeros, checked directly, no index is reported at all, and the Explain panel does not work (`EXPLAIN FORMAT='json'` does not parse). |
| OceanBase | `mysql` | Partial | 5.7.25-OceanBase_CE-v4.4.2.1 | Fourteen of the fifteen surfaces return without throwing, but **only twelve of them do their job**, and that gap is what makes this partial rather than full: performance metrics and storage stats are answered-but-useless, and the overview, table statistics and index statistics carry useless zeros in their size fields while their row and structure data is real. The slow-query panel reading 0 rows is an honest empty, not a fabricated number. **Health is the one hard failure** - the tenant has no `performance_schema` database at all (`ERROR 1049 Unknown database 'performance_schema'`), and health passes on the MySQL 26.7.0 baseline probed in the same pass, so this is the engine's. One consequence is visible before any panel is opened: the header badge reads **Slow** rather than Online, which is not latency - the badge is set from whether the health request succeeded, and health is exactly what this engine refuses. **Every size reads 0 B** - table, index, database and storage - because `information_schema.TABLES` reports `DATA_LENGTH 0` and `INDEX_LENGTH 0`; storage stats also list a phantom `InnoDB` row at `ibdata1:12M:autoextend` whose size reads N/A, OceanBase faking `innodb_data_file_path` for compatibility with no such file behind it. **Row counts are correct** once `ANALYZE TABLE` has run (2000 for 2000), and it must be the MySQL-mode statement - the Oracle-mode `ANALYZE TABLE t COMPUTE STATISTICS` is rejected with `ERROR 1235`. The object browser is clean, 2 objects for 2 user tables: the schema query scopes to `TABLE_SCHEMA` and to `TABLE_TYPE = 'BASE TABLE'`, and OceanBase's own 860 + 70 + 18 catalog objects are all `SYSTEM TABLE` or `SYSTEM VIEW`, so neither filter admits them. A foreign key is both read back and enforced (an orphan insert is refused with `ERROR 1452`), but no backing index is created for one, so index counts will not match an equivalent MySQL schema. Cancelling genuinely cancels, and Explain genuinely describes without executing (an 11-row ASCII plan with an `EST.ROWS` column). **Sign in to the business tenant, not `sys`**: `MODE=mini` creates a user tenant named `test`, so the login is `root@test`; the `sys` tenant shows nine databases including Oracle-mode artifacts (`LBACSYS`, `ORAAUDITOR`, `SYS`, `ocs`, `sys_external_tbs`) that a user tenant does not have. Plan mode grounds a run here, through the provider-inventory path. Probed on the `4.4.2-lts` image with `MODE=mini` only. |
| SingleStore | `mysql` | Partial | SingleStoreDB 9.1.1 (advertises MySQL 5.7.32) | Ten of the fifteen surfaces answer. **Five failures share one cause and it is ours, not SingleStore's** - Test Connection, health, the overview and the monitoring dashboard all fail with the same engine message, `This command is not supported in the prepared statement protocol yet`, and the Explain panel fails with a syntax error on `EXPLAIN FORMAT=JSON`; the provider sends every statement through the binary prepared protocol, and all six statements measured succeed on the text protocol (D8 in [`../BACKLOG.md`](../BACKLOG.md)). **Row counts and sizes are missing rather than wrong**: a 2000-row table reads `rowCount 0` and `0 B` in the object browser, the table statistics and the storage panel, against a ground truth of 2000 rows and 77046 bytes measured four independent ways (`SELECT count(*)`, `SHOW TABLE STATUS`, `information_schema.OPTIMIZER_STATISTICS.ROW_COUNT`, and the EXPLAIN plan's `est_table_rows`). SingleStore leaves `information_schema.TABLES` zeroed and keeps the real numbers elsewhere, and running `ANALYZE` does not change what the panels read, so a populated table looks empty. The index panel lists 4 rows for 2 tables against the baseline's 2, because SingleStore auto-creates a shard key on every table and reports it as an index named `__SHARDKEY` with index type `SHARD`, beside `PRIMARY`. **Foreign keys do not exist**: `ALTER TABLE ... ADD FOREIGN KEY` fails with `ERROR 2752`, and with `SET GLOBAL ignore_foreign_keys = ON` a `CREATE TABLE` carrying an inline foreign key is accepted and the constraint silently stripped - the one shape where you could believe you have a key you do not. The header badge reads **Slow** rather than Online, which is not latency but the same failing health request. Of the maintenance actions Analyze works; Optimize and Check fail with the same prepared-statement error. Permission errors are identical to MySQL, with the server's own text intact, and under a `SELECT`-only role the table list correctly showed only the granted table. No version is displayed anywhere, because the panel carrying it is one of the unavailable ones; were it fixed it would read MySQL 5.7.32, the wire version, not SingleStoreDB 9.1.1. **No licence key is needed** - the dev image self-licenses with `ROOT_PASSWORD` as the only variable set, which is what issue #424 recorded as the reason this engine had gone unprobed. Plan mode grounds a run here, through the provider-inventory path. Probed on the `0.2.82` dev image only. |
| CockroachDB | `postgres` | Partial | CockroachDB CCL v26.2.5 | Editor, error handling, performance metrics, slow queries and sessions all work. The **object browser and every size/health panel are blank**: `pg_total_relation_size()`, `pg_size_pretty()`, `pg_postmaster_start_time()` and `pg_tablespace_location()` do not exist there. |
| Apache Cloudberry (incubating) | `postgres` | Partial | PostgreSQL 14.4 (Apache Cloudberry 2.1.0-incubating) | Twelve of the fifteen surfaces answer. The monitoring dashboard, table statistics and index statistics all fail with one engine error, `query plan with multiple segworker groups is not supported`, which is Cloudberry's MPP planner restriction rather than a version gap. **Row counts and sizes after `ANALYZE` are correct** (2000 rows for 2000; 576 KB for 589824 bytes), so this is not the kind of engine whose statistics mislead; what they read before `ANALYZE` was not probed. Two `pg_ext_aux` tables appear in the browser, so it lists 4 objects for 2 user tables, and the overview's database size reads 62 MB against roughly 900 KB of user tables. **A foreign key is read back as if enforced and is not**: Cloudberry accepts the constraint with a warning that it will not enforce it, and an orphan insert then succeeds. **The agent cannot ground a run here**: the usual `gpadmin` login is refused because the execution profile reads a superuser as too broad, and a least-privilege role is refused at 289 rows against a 200-row budget, 282 of them in Cloudberry's own `gp_toolkit`. What the run reports for the first of those is that the engine offers no read-only execution profile, which describes the role rather than the engine (B47). The three failing panels report the planner error as a connection error, which the connection is not. Apache publishes build images only, so the probe ran on a third-party image. |
| ScyllaDB | `cassandra` | Partial | ScyllaDB 2026.2.4-0.20260810.e54224b8cebb (advertises Cassandra 3.0.8) | Eight of the thirteen surfaces this provider offers answer - thirteen rather than the fifteen this column counts elsewhere, because the Cassandra provider offers neither cancellation nor `EXPLAIN` on either engine. **Five failures share one cause, and so does Test Connection**: the overview, health, performance metrics, active sessions and the monitoring dashboard all read Cassandra's `system_views` virtual tables, ScyllaDB has no `system_views` keyspace at all, and all five come back with the same verbatim `Keyspace system_views does not exist`; Test Connection fails with them because it calls the same health surface - and **the dialog will not save the connection either**, because Establish Connection is gated on that same call, so a ScyllaDB connection has to arrive seeded or admin-managed today (measured in a browser; StarRocks and SingleStore sit on the same gate and neither row records it). The monitoring dashboard renders one **Connection Error** page reading the keyspace message, which the connection is not, and the header badge reads **Slow** rather than Online for the same failing health request. Apache Cassandra 5.0.9, probed in the same pass, answered all thirteen. **The SQL editor and the object browser work in full**: statements run, and every one of 18 CQL types read back byte-identically to that Cassandra baseline, `bigint` 9007199254740993, `decimal` 1.25, `duration` `3h20m`, `varint`, `blob`, `inet`, `date`, `time` and the collections included. No version is displayed anywhere, because the panel carrying it is one of the failing ones; were it fixed it would read Apache Cassandra 3.0.8 - the compatibility number `system.local` publishes - and not ScyllaDB 2026.2.4, which lives in `system.versions` where the provider does not look. **The object browser lists one extra table per secondary index**: ScyllaDB backs an index with a view that `system_schema.tables` reports, so a keyspace with 3 user tables and 1 index lists 4 objects (`customers_country_idx_index`) where Cassandra listed 3 for the same schema. **Error classes are identical to Cassandra even though the server's wording is not** - a missing table is `unconfigured table no_such_table` rather than `table no_such_table does not exist`, a missing column `Unrecognized name nope` rather than `Undefined column name nope in table probe.customers` - because the provider classifies on the driver's error code and not on the message text. Row counts and sizes are blank for the same reason as on Cassandra, and the panels read `N/A` rather than a fabricated zero. **Creating a keyspace needs `NetworkTopologyStrategy` on the 2026.2 line**: `SimpleStrategy` is refused outright with `SimpleStrategy doesn't support tablet replication`, so the setup recipe in [cassandra.md §10](./cassandra.md#reproducing-the-live-pass) does not run unchanged; 2025.1 still accepts it, with a warning. ScyllaDB 2025.1.14-0.20260612.103b84070f3b was probed in the same pass and behaved identically on every surface, so this row describes both the 2025.1 and the 2026.2 line - but only those two builds, and only a single-node container. |
| Materialize | `postgres` | Query editor only | Materialize 26.37.0 | No pg statistics catalog and no size functions, and `MATERIALIZED` is reserved, which our schema query uses. Editor only. |
| RisingWave | `postgres` | Query editor only | RisingWave 3.0.3 | No pg statistics catalog, differently typed size functions, and a parameterised `LIMIT` is rejected. Editor only. |

**ScyllaDB was the standing illustration of the rule above, and its probe has now run**, which is why
it has a row rather than a paragraph. It speaks the CQL wire protocol and `cassandra-driver` connects
to it, which is exactly the kind of "connects, therefore supported" claim this table exists to refuse
— and what the probe measured is that the parts which differ are the parts that are *not* the wire.
Of the three doubts [cassandra.md §11](./cassandra.md#11-scylladb-is-a-partial-relative-one-absent-keyspace-costs-five-surfaces) raised,
two held and one was refuted: `system_views` is absent, which is the whole of what makes the row
above Partial, and the version string is not `release_version`-shaped, while `gossip_generation` does
exist on ScyllaDB and answers. Nothing about how a name gets in has changed: a probe against a real
instance through the real provider is still the only way, and until one runs the honest state is
*untested*, not *unsupported*.

Reproduce any row with the `compat` profile of the container fixture, then connect as the driver in
the second column:

```bash
docker compose -f database-compose.yml --profile compat up -d
```

**ScyllaDB needs one connection field the other rows here do not**, the same one Apache Cassandra
needs: `Local Data Center` must be `datacenter1`, and the driver refuses to open a session while it is
empty. The fixture's service is `scylla`, reachable on `localhost` port **9142** with no user and no
password, and the probe keyspace is `probe`.

**Absent from the table for two different reasons**, which are worth keeping apart: an engine we
could not reach is not the same as an engine we reached and refused.

**Measured, and refused a row.** The probe ran and the result did not earn an entry, so there is no
tier and no version column for it - the number is the finding:

- **Google Cloud Spanner, PostgreSQL dialect** - **1 of 15 surfaces**, probed on 2026-08-20 through
  the `postgres` driver against `gcr.io/cloud-spanner-pg-adapter/pgadapter-emulator:v0.55.2` (the
  Cloud Spanner **emulator** behind PGAdapter 0.55.2; the managed service was not probed and inherits
  nothing from this). It does not reach even query-editor-only: pressing Run fails, because the editor
  always attaches a `queryId` and the provider then issues `SELECT pg_backend_pid()` first, which
  Spanner rejects as an unsupported function. Test Connection fails on a connection that works, since
  it reads `pg_stat_activity`. The object browser is empty (`regclass` is an unsupported type), no
  monitoring panel answers at all, no row count or size is obtainable anywhere - the emulated
  `pg_class` reports 0 rows for a 2000-row table and even ground truth is unreadable - Explain fails
  on `BUFFERS`, and Cancel can never work because the backend PID it needs is unreadable. Agent and
  plan mode fail closed, which is correct: the role-privilege verification in `connect()` cannot run
  (`current_setting(text)` is unsupported), so acquisition is refused and the user is told the
  connection failed. Foreign keys **are** enforced by the engine, but the app can never display them
  because the schema read fails. **One result is worse than a failure: Vacuum reports "VACUUM
  completed successfully" when Spanner has no vacuum and nothing happened** - PGAdapter swallows the
  statement. Analyze, by contrast, correctly reports itself unsupported. Fixture notes for anyone
  repeating this: `numeric` takes no precision or scale (so `decimal(10,2)` is rejected), there is no
  `ANALYZE`, the emulator authenticates nobody and has no role vocabulary at all (`CREATE ROLE`
  answers "Statement is not supported."), and nothing survives a restart because the database is in
  memory.

**No instance was reachable**, so these are deliberately absent rather than assumed to work: every
managed-only service - Amazon Redshift, Aurora, AlloyDB (the managed service; the downloadable
**AlloyDB Omni** is in the table above), Neon, Supabase, Cloud SQL, Azure SQL Database,
Microsoft Fabric, Azure Synapse, Azure SQL Managed Instance, Amazon ElastiCache, Upstash,
PlanetScale, Azure Cosmos DB and Amazon DocumentDB. Their status is tracked in
[#424](https://github.com/libredb/libredb-studio/issues/424).

## Cross-cutting docs

- **Provider architecture:** [`../DATABASE_PROVIDERS.md`](../DATABASE_PROVIDERS.md) — the
  Strategy-Pattern architecture, the provider hierarchy, and the shared interface/base classes.
- **Adding a new provider:** [`../ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) — the step-by-step
  guide, plus the rubric for deciding whether a database needs a driver at all, the transport seam,
  and the traps of talking to one over HTTP. Couchbase is the worked example.
- **HTTP API contract** (request/response for `/api/db/query`, schema, maintenance, …):
  [`../API_DOCS.md`](../API_DOCS.md).


## Connecting to the container fixture

What to type into the connection dialog for **every shipped provider**, against
[`database-compose.yml`](../../database-compose.yml). One row per type-id, so the table covers the
same set as the table at the top of this file and a new provider is a new row rather than a re-drawn
grid. Each row was verified against the running container on 2026-08-19, and the Trino row on
2026-08-20 — the credentials are the ones the fixture actually accepts, not the ones its environment
block asks for (twice those differ; see the notes).

Start the thirteen always-on services with a plain `docker compose -f database-compose.yml up -d` -
twelve engine containers plus the one-shot `couchbase-init` seed sidecar; the `Profile` column names
the ones that need asking for. The count is derived, not written: a service in this file carries no
`profiles:` key precisely when it backs a SHIPPED provider, so a plain `up -d` can reproduce that
provider's integration pass.

| Provider | Compose service | Host | Port | User | Password | Database / service | Profile |
|---|---|---|---|---|---|---|---|
| PostgreSQL | `postgres` | localhost | 5432 | `postgres` | `postgres` | `postgres` | — |
| MySQL | `mysql` | localhost | 3306 | `root` | `root` | `mysql` | — |
| Oracle | `oracle` | localhost | 1521 | `system` | `Password123!` | `XEPDB1` (service name) | — |
| SQL Server | `mssql` | localhost | 1433 | `sa` | `Password123!` | `master` | — |
| MongoDB | `mongodb` | localhost | 27017 | `admin` | `admin` | any; auth source `admin` | — |
| Redis | `redis` | localhost | 6379 | *none* | *none* | *none* (db index 0) | — |
| Couchbase | `couchbase` | localhost | 8091 | `Administrator` | `password123` | `travel` (bucket) | — |
| ClickHouse | `clickhouse` | localhost | 8123 | `libredb` | `password123` | `demo` | — |
| Apache Druid | `druid-router` | localhost | 8888 | *none* | *none* | *none* | `druid` |
| Elasticsearch | `elasticsearch` | localhost | 9200 | *none* | *none* | *none* | — |
| OpenSearch | `opensearch` | localhost | **9201** | *none* | *none* | *none* | — |
| Apache Trino | `trino` | localhost | 8080 | *none* | *none* | `tpch` (catalog) | — |
| Apache Cassandra | `cassandra` | localhost | 9042 | *none* | *none* | `probe` (keyspace) | — |
| SQLite | *no service* | — | — | — | — | a file path on the Studio host | — |
| LibreDB | *no service* | — | — | — | — | a directory on the Studio host | — |

*none* means leave the field empty. It is never a default that happens to be blank: Druid loads no
security extension in a default install, both search services run with their security plugin off, the
`trino` service runs with authentication disabled, and the `redis` service sets no `requirepass`
(verified: `CONFIG GET requirepass` answers empty). **Never put a password on a plain-HTTP Trino
connection**: the coordinator answers `401 Password not allowed for insecure authentication` even
with authentication off, so a password breaks a connection that works without one
([trino.md §4.3](./trino.md#43-tls-and-the-password-rule)).

**Cassandra needs one field this table has no column for, and will not connect without it.** `Local
Data Center` must be `datacenter1` - a stock single node names its own data centre that, and the
driver refuses to open a session when the field is empty rather than defaulting to the only data
centre it can see ([cassandra.md §3.4](./cassandra.md#34-localdatacenter-is-a-required-connection-field-and-nothing-else-here-has-one)).
The port needs nothing: the compose service publishes the native protocol as `9042:9042`, which is
also what the connection dialog prefills, so the field can be left untouched. `docker port
libredb-cassandra` prints the mapping.

**The two embedded providers have no container, and that is the whole point of them.** SQLite takes a
path resolved *in the Studio process* and LibreDB a directory; neither reaches a network. Both also
ship a ready-made sample connection — "Sample (Employees)" and "Sample (LibreDB)" appear in the
sidebar with no configuration at all — so the fastest way to exercise them is to click one rather than
to fill this dialog in. See [sqlite.md](./sqlite.md) and [libredb.md](./libredb.md).

**Two rows differ from what the compose file's environment asks for**, which is why they are stated
from the running container instead:

- **Oracle** sets `ORACLE_PDB: ORCLPDB1`, and `gvenzl/oracle-xe` does not read that variable — it
  takes `ORACLE_DATABASE` for an application PDB. So the only PDB on the node is the image default,
  `XEPDB1` (verified: `SELECT name FROM v$pdbs`). Connect to `XEPDB1`, or the listener refuses the
  service name.
- **SQL Server** sets `MSSQL_DATABASE: mssql`, which the official image ignores; it creates no
  database. `master` is what the fixture guarantees (verified: `SELECT name FROM sys.databases`), and
  a `shop` database appears only once an E2E seed has run.

**The two search services share a port inside the container.** OpenSearch publishes **9201** on the
host because both products ship on 9200 and the `elasticsearch` service claims it; the provider's own
default port stays 9200, so this is a collision on this machine and not a fact about the product.
Security is off on both, which is what makes their fixtures reproducible *and* the limit of what they
can prove: a bogus `Basic` header is ignored there (HTTP 200 on both, measured), so no 401/403 body
can ever be captured from these containers. Neither offers a `Database` field at all — an index has no
namespace above it. Details in [elasticsearch.md](./elasticsearch.md) and
[opensearch.md](./opensearch.md).

**Trino's `Database` field is a CATALOG, not a database.** The fixture ships `tpch`, `tpcds`,
`memory`, `system` and `jmx` configured, and `tpch` is the one to type: it generates its rows on
read, so `tpch.tiny.nation` (25 rows) answers immediately with no seed step. The tree shows the
schemas of that one catalog; every other catalog stays reachable from the editor by qualifying names
in full. Leave `jmx` configured — it is the only SQL-reachable source for the overview's uptime.
Details in [trino.md](./trino.md).

**Druid is seven containers, not one.** It has no single-container mode, so the whole block carries
`profiles: ["druid"]` and a plain `up -d` leaves it out. The dialog only ever needs the Router:

```bash
docker compose -f database-compose.yml --profile druid up -d
```

For the engines that have no provider of their own, use the `compat` profile and connect as the driver
named in the [Wire-compatible engines](#wire-compatible-engines) table above.

### If Studio itself runs in a container, `localhost` is the wrong host

Every `Host` in the table above is written for a Studio that runs **on the host** — `bun dev`,
`bun run start`, or the npm package. Inside a container, `localhost` is that container's own loopback
and nothing is listening on it: a plain `docker run -p 3000:3000 libredb/libredb-studio` reaches
none of these services (measured — `curl localhost:9200` from an unrelated container answers no HTTP
status at all, not a refusal you could mistake for a credential problem).

Pick one of three, in this order of preference.

**1. Join the fixture's network and address services by name.** The best answer, and the only one that
needs no host ports at all: compose puts every service on `libredb-studio_default` with its service
name as a DNS name.

```bash
docker run -p 3000:3000 --network libredb-studio_default libredb/libredb-studio
```

Then use the **service name** as the host and the **in-container** port — which is not always the port
in the table above:

| Provider | Host inside the network | Port inside the network |
|---|---|---|
| PostgreSQL | `postgres` | 5432 |
| MySQL | `mysql` | 3306 |
| Oracle | `oracle` | 1521 |
| SQL Server | `mssql` | 1433 |
| MongoDB | `mongodb` | 27017 |
| Redis | `redis` | 6379 |
| Couchbase | `couchbase` | 8091 |
| ClickHouse | `clickhouse` | 8123 |
| Apache Druid | `druid-router` | 8888 |
| Elasticsearch | `elasticsearch` | 9200 |
| OpenSearch | `opensearch` | **9200** |
| Apache Trino | `trino` | 8080 |

> **OpenSearch is 9200 here, not 9201.** The 9201 in the table above is a *host* port published to
> dodge a collision with the `elasticsearch` service. Inside the network there is no collision, so the
> port is the product's own. Verified: `http://opensearch:9200/` reports distribution `opensearch`,
> number `3.8.0`.
>
> Credentials and database names do not change — only host and port do. And the network exists only
> once compose has created it, so start the fixture before Studio; the name is
> `<project>_default`, which is `libredb-studio_default` when compose is run from this repository and
> `<your-directory>_default` otherwise (`docker network ls` says which).

**2. Reach the published host ports through the host gateway.** Use this when Studio must stay off the
fixture's network — a container you did not start, or services split across several compose projects.
On Docker Desktop `host.docker.internal` already resolves; on Linux it does not, and the flag below is
what creates it:

```bash
docker run -p 3000:3000 --add-host=host.docker.internal:host-gateway libredb/libredb-studio
```

Now the table at the top of this section is correct as written, with `host.docker.internal` in place of
`localhost` — including OpenSearch on **9201**, because these are the published host ports. Verified on
Linux: 9200 and 9201 both answer HTTP 200 through that name.

**3. `--network host`.** Makes `localhost` mean the host's loopback, so the table applies unchanged:

```bash
docker run --network host ghcr.io/libredb/libredb-studio
```

Last because of what it costs: **Linux only** (on Docker Desktop the "host" is the VM, not your
machine), no `-p` mapping (the app binds the host's port 3000 directly), and the container shares the
host's whole network namespace, which is a far wider grant than reaching one database.

Whichever you pick, [`docker-compose.yml`](../../docker-compose.yml) in the repository root is the
shape to copy for a real deployment: Studio and its Postgres sit on one compose network and address
each other by service name, so nothing depends on a published host port existing.

One collision to know about if you run both files: that root compose file and the fixture both name a
container `libredb-postgres`, so the second one to start fails with *"container name is already in
use"*. Rename one, or run only the fixture and point Studio's `STORAGE_*` variables at it.
