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
| Percona Server for MySQL | `mysql` | Full | Percona Server for MySQL 8.4.11-11 | Probed 2026-08-26 against `percona/percona-server:8.4`. Behaves as MySQL throughout: all fifteen surfaces answer, **the numbers are correct** (2000 rows read as 2000, 114688 bytes as 114688, index 65536), indexes and a foreign key are read back, `EXPLAIN FORMAT=JSON` parses, and **all three maintenance actions succeed** - `Analyze`, `Optimize` (*Table does not support optimize, doing recreate + analyze instead; OK*, InnoDB's own answer) and `Check`. **Nothing on screen says Percona**: `version()` answers a bare `8.4.11-11` and the product name is only in `@@version_comment` (*Percona Server (GPL), Release 11, Revision 57878ff8*), which the provider does not read, so the overview cannot be told apart from a stock MySQL 8.4 - the same shape as Garnet's row above. One reading that looked like a Percona defect and was NOT: the health panel's slow-query line said *Performance schema not available* while `@@performance_schema` was 1 and the slow-query panel itself returned rows. Measured identically on a stock MySQL 26.7.0 in the same pass, so it was ours, not Percona's - **since fixed in #512**: the health line now carries the same digest rows the panel does (both read one statement), and where the digest table cannot be read at all the line is empty and the panel names the server's reason. See [providers/mysql.md](mysql.md#the-slow-query-line-asked-for-a-column-the-digest-table-does-not-have). |
| MariaDB | `mysql` | Full | 12.3.2-MariaDB-ubu2404 | Behaves as MySQL throughout. The version shown is MariaDB's full build string, passed through as the server gave it. **`performance_schema` ships OFF** (`@@performance_schema` = 0), so the cache-hit, queries-per-second and buffer-pool figures are absent and the slow-query list is empty until the server is started with `performance_schema=ON`; the tables exist either way, so nothing fails, it simply measures nothing. The schema tree, sizes, row counts, sessions and `EXPLAIN FORMAT=JSON` come from `information_schema` and are unaffected. Only 12.3 was probed; the 10.x `information_schema` surface was not. |
| TiDB | `mysql` | Full | 8.0.11-TiDB-v8.5.1 | All surfaces answer. A freshly loaded table reads **0 rows and 0 B until TiDB's background statistics catch up** — they correct themselves, with no `ANALYZE`. Max connections reads 0 (TiDB's default, meaning unlimited), the slow-query panel is always empty (TiDB's slow log lives in `information_schema.SLOW_QUERY`), and storage stats list a phantom `InnoDB` entry. The Explain panel does not work either — TiDB rejects `EXPLAIN FORMAT='json'` — though the query itself runs normally. Probed on a standalone `--store=unistore` server only; PD + TiKV was not probed. |
| Vitess | `mysql` | Full | 8.0.43-Vitess (Vitess 24.0.2) | All fifteen surfaces answer and the browser is clean: 2 objects for 2 user tables. **Row counts and total size are exact**, checked against the engine (2000 rows read as 2000; 163840 bytes as 163840), and a foreign key is both read back and enforced. Two things do not work. **A running query cannot be cancelled**: vtgate refuses `KILL QUERY` with `VT07001` and the statement runs to completion (a 5 second `SLEEP` took its full 5003 ms). And per-index sizes always read 0 bytes, because Vitess names the InnoDB table after the physical shard database (`vt_probe_0`), which is also the name the table and index statistics show instead of the keyspace you connected to. Setting a session variable can fail where reading it works: `SET @@cte_max_recursion_depth` is rejected as an unknown system variable, while `SELECT @@cte_max_recursion_depth` answers 1000. Probed on an unsharded single-shard keyspace only; a sharded keyspace was not probed, and no permission error could be measured because `vttestserver` grants every login full rights. |
| ParadeDB | `postgres` | Full | ParadeDB 0.25.4 on PostgreSQL 18.6 | Probed 2026-08-27 against `paradedb/paradedb:0.25.4`. All fifteen surfaces answer and the numbers are correct (2000 rows read as 2000, 131072 bytes as 131072), with a foreign key and its indexes read back. **What it costs is width, not accuracy**: the object browser lists **41 objects for 2 user tables** and the index panel 74 rows, because ParadeDB ships nine extensions - `pg_search`, `vector`, `postgis` with its `tiger` geocoder, `pg_ivm`, `pg_stat_statements` and `paradedb`'s own tables. `spatial_ref_sys` (8500 rows) sits in `public` beside your tables. **Agent plan mode WORKS here, and that result refutes what the width predicted** - worth recording, because the expectation was [B52](../BACKLOG.md): the grounding capture reads what the ROLE can see, and a superuser sees 539 non-system columns where an unprivileged role sees **168**, the tiger geocoder's 425 not being readable. Under the 200-row ceiling, so a plan run grounded on **21 tables** (`ctx_c35a`) and drafted a `LEFT JOIN` over the real objects. **Connect as a least-privilege role, not as a superuser**: as `postgres` the run fails with *the agent cannot run on this database engine: it offers no read-only execution profile*, which is the profile refusing a superuser on any PostgreSQL rather than anything about ParadeDB. So B52's real trigger is a role that CAN read a wide catalog, not an extension that installs one. Slow queries do work here, unlike most PostgreSQL relatives, because `pg_stat_statements` ships enabled. **`version()` names PostgreSQL only**, so the version panel cannot tell this apart from a stock PostgreSQL 18.6 - the release is in the image tag and nowhere the provider reads. |
| Percona Distribution for PostgreSQL | `postgres` | Full | Percona Server for PostgreSQL 18.6.1 on PostgreSQL 18.6 | Probed 2026-08-26 against `percona/percona-distribution-postgresql:18.6`. Behaves as PostgreSQL throughout: all fifteen surfaces answer, **the numbers are correct** (2000 rows read as 2000 and 131072 bytes as 131072, index 65536), a foreign key is read back with its indexes, and `Analyze` and `Vacuum` both work. **The version panel names Percona** - `version()` answers *PostgreSQL 18.6 - Percona Server for PostgreSQL 18.6.1* - which is the opposite of the MySQL distribution below and worth knowing when you are trying to tell a fork from stock. Slow queries are empty until `pg_stat_statements` is enabled, which is stock PostgreSQL behaviour rather than a Percona property. Nothing else deviates from the PostgreSQL baseline. |
| Citus | `postgres` | Full | citus 14.1-1 on PostgreSQL 18.4 | All surfaces answer. **Row counts and sizes for a distributed table are wrong, not missing** — PostgreSQL statistics describe the empty coordinator parent, not the shards. `citus_tables` and `citus_schemas` show up in the browser. |
| OrioleDB | `postgres` | Full | OrioleDB beta 16 on PostgreSQL 18.4 (nightly of 2026-08-24) | Probed 2026-08-27 against `orioledb/orioledb:pg18-nightly-20260824-cc35a80-ubuntu`. **Read this row against ParadeDB above: both are Full and their costs are opposites.** Here the object browser is clean - 2 objects for 2 user tables - row counts are exact (2000 read as 2000, 122880 bytes), and a foreign key and its indexes are read back. What is missing is what PostgreSQL cannot see of OrioleDB's own storage: **every index reads 0 bytes** in the browser and the table statistics, because `pg_indexes_size()` returns 0 for an OrioleDB table (measured directly: 114688 bytes of table, 0 of indexes) - the YugabyteDB DocDB shape; and **the cache hit ratio reads N/A**, because OrioleDB has its own buffer manager and `pg_statio_user_tables` stays at 0 hits / 0 reads. That second one is an absence honestly rendered, not a wrong number. **Gate 7 passes** under a least-privilege role: 27 visible columns, a plan run grounded on 6 tables (`ctx_6b5e`) and drafted a `LEFT JOIN` over the real objects - and as a superuser it fails on the same profile refusal ParadeDB's row describes. Verified before trusting the row that the fixture actually measures OrioleDB: `default_table_access_method` is `orioledb` and both probe tables report `amname = orioledb`, so a heap-table probe measuring plain PostgreSQL was ruled out. **`version()` does name OrioleDB** - the one thing ParadeDB's does not - and carries the build hash and date, which is also the caveat: the project publishes **nightly images only**, so there is no release tag to pin and this row describes one dated build. |
| TimescaleDB | `postgres` | Full | TimescaleDB 2.29.2 on PostgreSQL 17.11 | All surfaces answer. **A hypertable's row count and size are wrong, not missing** — the statistics describe the empty parent table, not the chunks. Every chunk shows up as its own table and index, along with the `_timescaledb_catalog` and `_timescaledb_cache` schemas. The overview shows PostgreSQL's version, not the extension's. **The agent cannot ground a run here** — the extension's catalogs answer 473 of 478 rows in the grounding read, over its 200-row budget, on a stock install. |
| YugabyteDB | `postgres` | Full | YugabyteDB 2.25.2.0-b0 (advertises PostgreSQL 15.12) | All surfaces answer, foreign keys included. **Row counts and sizes read 0 until you run `ANALYZE`** — nothing collects statistics automatically, so a full database looks empty. Index sizes always read 0 bytes (index storage lives in DocDB) and the overview's database size reads 0 bytes. Index types read `lsm`, which is the real storage rather than a misreading. |
| AlloyDB Omni | `postgres` | Full | PostgreSQL 17.9 (AlloyDB Omni 17.9.0) | All fifteen surfaces answer, and the numbers are exact: 2000 rows read as 2000 and 270336 bytes as 270336 (180224 table plus 90112 index), with a foreign key both read back and enforced by the engine. **The version panel cannot be told apart from a stock PostgreSQL 17** - `version()` reports `PostgreSQL 17.9 on x86_64-pc-linux-gnu` and names AlloyDB nowhere; the product is identifiable only from the `alloydb.*` settings and the image tag. The object browser lists 10 objects for 2 user tables, the 8 extras being AlloyDB's own `google_ml` tables - and **that understates what is installed**: outside the system schemas there are 70 objects, because 49 extension views live in `public` itself (`g_columnar_*`, `google_db_advisor_*`, `hypopg_list_indexes` and more), which the browser hides only because its schema query filters `table_type = 'BASE TABLE'`. A role with no grants at all - `LOGIN` plus `CONNECT`, `ALL` revoked on `public` - still lists those `google_ml` tables and reads them (`SELECT count(*) FROM google_ml.supported_vertex_models` answered 15 to it). The slow-query panel is empty because `pg_stat_statements` ships with the image but is not installed in it, which health reports honestly. The columnar engine is off by default and needs `ALTER SYSTEM` plus a restart; with it on the on-disk sizes stay exact but do not count the columnar copy. **The agent cannot ground a run here**: the image's own `postgres` superuser is refused as too broad, and a least-privilege role - which does acquire both profiles - has its capture refused at 536 rows against a 200-row budget, only 7 of them the user's, and narrowing the capture to `public` alone still refuses at 348 (B52). Probed on the 17.9.0 image only; the 15.x and 16.x lines were not. |
| Valkey | `redis` | Full | Valkey 9.1.1 | Behaves as Redis. The overview shows the Redis emulation level (7.2.4), not the Valkey version. |
| DragonflyDB | `redis` | Full | DragonflyDB df-v1.40.1 | Overview shows the emulation level (7.4.0). Max connections reads 0 (no usable `maxclients` in `INFO`), active sessions show a numeric id instead of a username (`CLIENT LIST` sets `name=` to the connection id), and every session reads `idle`/`N` (no `cmd=` or `flags=` field). |
| KeyDB | `redis` | Full | KeyDB 6.3.4 | Publishes no version field of its own, so the overview is indistinguishable from a Redis 6 server. A session's command can appear without its subcommand. |
| Garnet | `redis` | Full | Garnet 2.1.5 (advertises Redis 7.4.3) | Probed 2026-08-26 against `ghcr.io/microsoft/garnet:2.1.5`. Every Redis surface answers - the key browser grouped 71 keys into `user:*`, `session:*` and `queue:*`, sessions list the connection, and `Key Info` (the Analyze action) returned 129 metrics. **It is the one relative here whose real version was available and went unread**: the overview shows Redis `7.4.3` while `INFO` also carries `garnet_version:2.1.5` and `server_name:garnet`. Valkey and DragonflyDB publish only an emulation level and KeyDB nothing at all, so on those three the displayed version is the best reading available; here it is not. **Two numbers are absences wearing a value**, both from `INFO` fields Garnet does not publish: there is no `used_memory`, so the database size and the memory storage panel read `0 B`; and there are no `keyspace_hits` / `keyspace_misses`, so the cache hit ratio reads `100%` - the `: 100` fallback recorded as [D14](../BACKLOG.md). Measured side by side with Redis 8.10.0, which publishes all three. Max connections reads 0 (no `maxclients`, as on DragonflyDB), and `connected_clients` stays 0 even with a client attached, though the session list itself is right. **Browser-verified 2026-08-26** on the built app: the tree read `user:* 50`, `session:* 20`, `queue:* 1`, a `{"command":"GET","args":["user:1"]}` run returned the value, and Monitoring showed `7.4.3`, `Connections 0 / no limit published`, `Tables 71 / 0 indexes`, `DB Size 0B` and **`Cache Hit 100.0%` rated *Excellent*** - the D14 fallback being graded, which is the sharpest form of this row's warning. Fixture note: Garnet keeps everything in memory and publishes no persistence, so a `docker stop` empties it - measured, `dbsize` 71 before and 0 after a restart. |
| FerretDB | `mongodb` | Full | FerretDB 2.7.0 (MongoDB 7.0.77 wire) | Every monitoring surface answers. Sign in with the **backend PostgreSQL** credentials — `authMechanism=PLAIN` is rejected. The version shown is the advertised MongoDB wire version. Needs its own backend, so it is two containers. |
| StarRocks | `mysql` | Partial | StarRocks 3.3.22-753696f | The editor, the table list, column metadata, table and storage stats, performance metrics and slow queries all work. **The version reads MySQL 5.1** — `version()` returns a fictitious 5.1.0 and the real build is only in `current_version()`. **Re-probed 2026-08-24** after every parameterless statement moved to MySQL's text protocol: `getOverview()` and `getPerformanceMetrics()` now succeed through the provider, and the user still sees none of it. The active-session read is an engine gap of its own - *Unknown table `information_schema.PROCESSLIST`* - and it used to discard the whole dashboard with it. Since 2026-08-24 each panel is read independently: **re-measured 2026-08-24 through the provider, `getMonitoringData()` returns `overview`, `performance`, `slowQueries`, `tables`, `indexes` and `storage`, with `errors.activeSessions` carrying StarRocks' own sentence**, and the sessions panel alone shows it. Health fails on the same missing table and the badge reads **Slow**, measured in the browser. What the protocol change did recover here is the provider layer, not a panel. Row counts and sizes are hard zeros, checked directly, no index is reported at all, and the Explain panel does not work (`EXPLAIN FORMAT='json'` does not parse). |
| Apache Doris | `mysql` | Partial | Apache Doris 4.1.3-rc02-7126cf65d96 (`version()` reports 5.7.99) | Probed 2026-08-26. **Thirteen of the fifteen surfaces answer**, and the two that fail share one cause that is ours: the overview and health panels send `SHOW STATUS LIKE '...'`, which is a parse error in the Doris grammar (`mismatched input 'LIKE'`) while a bare `SHOW STATUS` is accepted and answers zero rows - filed as [D30](../BACKLOG.md), and the reason this row is Partial rather than Full. **Read this row against StarRocks above, which is a fork of Doris, because the numbers are where they part company.** Doris reports the truth: `getSchema()` read 3 rows / 2.65 KB and 2000 rows / 9.95 KB against a ground truth of 3 and 2000 (`SELECT count(*)`), and `getTableStats()` read 10187 bytes against `SHOW DATA`'s 9.948 KB, where StarRocks reports hard zeros. The lag is the catch: immediately after the 2000-row insert every surface read **0 rows and 0 B**, an `ANALYZE TABLE ... WITH SYNC` in between changed nothing, and the true numbers appeared about a minute later on their own - the TiDB shape, self-correcting, so a freshly loaded table looks empty for a while. What it shares with the fork: **the version reads MySQL 5.7.99**, a fictitious compatibility number, and unlike StarRocks there is no `current_version()` to read the real build from - it is only in `@@version_comment` (`doris version doris-4.1.3-rc02-7126cf65d96`), which the provider does not call; **no index is ever reported**, `information_schema.statistics` being empty; and **`EXPLAIN FORMAT='json'` does not parse**, so the Explain panel fails while a plain `EXPLAIN` runs in the editor. **A foreign key is invisible AND unenforced**: `ADD CONSTRAINT ... FOREIGN KEY` is accepted and `SHOW CONSTRAINTS` lists it, but `information_schema.KEY_COLUMN_USAGE` is empty (0 rows), so the ER diagram draws nothing - and an order row referencing customer 424242 inserted successfully, because the constraint is a planner hint there. A `UNIQUE KEY` table also declares no primary key to the product: `COLUMN_KEY` reads `UNI`, not `PRI`. **What works that a reader would not assume**: cancellation genuinely cancels (an 8-second `SELECT sleep(8)` died at 1513 ms with Doris's own *cancel query by user* message, where Vitess cannot cancel at all), active sessions and the monitoring dashboard answer through `information_schema.processlist`, storage stats answer, permission errors arrive as the right class with the server's sentence intact and a `SELECT_PRIV` role saw only its granted table, and `Analyze` works - `Optimize` and `Check` do not exist in the grammar at all. `getPerformanceMetrics()` answers `{}`: the object is empty rather than absent, because Doris's `SHOW STATUS` publishes no counters. **What the panels actually show, verified in Chrome against the built app on 2026-08-26** (the provider's boundary is not the product's, which is what U14 cost us on Cassandra): the header badge reads **Slow** and the Monitoring Overview tab carries *This database could not answer this panel* with Doris's own `mismatched input 'LIKE'` sentence beneath it - one panel, not the dashboard. Every other tab answers: **Tables** reads `2` tables / `2.0K rows` / `12.60 KB` with `probe_orders` at 2.0K / 9.95 KB and `probe_customers` at 3 / 2.65 KB, **Storage** shows `DB Size N/A` above a populated tablespace and largest-table list, **Sessions** lists 7, and **Performance**, **Queries** and **Pool** read `N/A` with *Not measured* / *not available* rather than a fabricated zero. The object browser shows the row count beside the table (`probe_customers 3`). One reading to treat with suspicion: the Tables card summarises **Vacuum `0` / OK** on an engine that has no vacuum-like operation at all - the numbers below it are correct, but that card is the U14 shape and is recorded here rather than claimed as healthy. **Creating the connection takes two clicks of Establish Connection, by design**: Test Connection answers *Connected, but this server answered no health data: ...*, and the first Establish reports that degraded reading and stores nothing, the second stores it (the D9 contract - before that fix an engine whose health failed could not be saved at all). **Gate 7 passes**: a plan run captured 2 tables (`ctx_adf7`) and drafted a `LEFT JOIN` over the real `probe_customers` / `probe_orders`, which then ran unmodified and answered `TR 667`, `DE 667`, `US 666`. |
| OceanBase | `mysql` | Partial | 5.7.25-OceanBase_CE-v4.4.2.1 | Fourteen of the fifteen surfaces return without throwing, but **only twelve of them do their job**, and that gap is what makes this partial rather than full: performance metrics and storage stats are answered-but-useless, and the overview, table statistics and index statistics carry useless zeros in their size fields while their row and structure data is real. The slow-query panel read 0 rows here, an honest empty rather than a fabricated number; since #512 it shows the tenant's own `ERROR 1049` instead, because `getSlowQueries()` no longer swallows an unreadable source. **Health is the one hard failure** - the tenant has no `performance_schema` database at all (`ERROR 1049 Unknown database 'performance_schema'`), and health passes on the MySQL 26.7.0 baseline probed in the same pass, so this is the engine's. One consequence is visible before any panel is opened: the header badge reads **Slow** rather than Online, which is not latency - the badge is set from whether the health request succeeded, and health is exactly what this engine refuses. **Every size reads 0 B** - table, index, database and storage - because `information_schema.TABLES` reports `DATA_LENGTH 0` and `INDEX_LENGTH 0`; storage stats also list a phantom `InnoDB` row at `ibdata1:12M:autoextend` whose size reads N/A, OceanBase faking `innodb_data_file_path` for compatibility with no such file behind it. **Row counts are correct** once `ANALYZE TABLE` has run (2000 for 2000), and it must be the MySQL-mode statement - the Oracle-mode `ANALYZE TABLE t COMPUTE STATISTICS` is rejected with `ERROR 1235`. The object browser is clean, 2 objects for 2 user tables: the schema query scopes to `TABLE_SCHEMA` and to `TABLE_TYPE = 'BASE TABLE'`, and OceanBase's own 860 + 70 + 18 catalog objects are all `SYSTEM TABLE` or `SYSTEM VIEW`, so neither filter admits them. A foreign key is both read back and enforced (an orphan insert is refused with `ERROR 1452`), but no backing index is created for one, so index counts will not match an equivalent MySQL schema. Cancelling genuinely cancels, and Explain genuinely describes without executing (an 11-row ASCII plan with an `EST.ROWS` column). **Sign in to the business tenant, not `sys`**: `MODE=mini` creates a user tenant named `test`, so the login is `root@test`; the `sys` tenant shows nine databases including Oracle-mode artifacts (`LBACSYS`, `ORAAUDITOR`, `SYS`, `ocs`, `sys_external_tbs`) that a user tenant does not have. Plan mode grounds a run here, through the provider-inventory path. Probed on the `4.4.2-lts` image with `MODE=mini` only. |
| SingleStore | `mysql` | Partial | SingleStoreDB 9.1.1 (advertises MySQL 5.7.32) | Ten of the fifteen surfaces answer. **Four of those failures were ours, not SingleStore's, and are fixed** - Test Connection, health, the overview and the monitoring dashboard all failed with the same engine message, `This command is not supported in the prepared statement protocol yet`, because the provider sent every statement through mysql2's binary prepared protocol. Every parameterless statement moved to the text protocol on 2026-08-24, and all four were re-probed in the browser on the built app: the header badge reads **Online**, the fleet card reads `152ms / 4 conn`, and Monitoring renders `MySQL 5.7.32`, an uptime, `Connections 7/100000` and `Tables 2 / 2 indexes`. The Storage panel renders too, all zeros, which is this engine's own zeroed `information_schema.TABLES` below and not a failure of ours. **The Explain panel is NOT among them**: `EXPLAIN FORMAT=JSON` is `ER_PARSE_ERROR` here on BOTH protocols, because SingleStore's grammar is `EXPLAIN JSON` - a statement problem wearing a protocol problem's message, recorded as X14 in [`../BACKLOG.md`](../BACKLOG.md). **Row counts and sizes are missing rather than wrong**: a 2000-row table reads `rowCount 0` and `0 B` in the object browser, the table statistics and the storage panel, against a ground truth of 2000 rows and 77046 bytes measured four independent ways (`SELECT count(*)`, `SHOW TABLE STATUS`, `information_schema.OPTIMIZER_STATISTICS.ROW_COUNT`, and the EXPLAIN plan's `est_table_rows`). SingleStore leaves `information_schema.TABLES` zeroed and keeps the real numbers elsewhere, and running `ANALYZE` does not change what the panels read, so a populated table looks empty. The index panel lists 4 rows for 2 tables against the baseline's 2, because SingleStore auto-creates a shard key on every table and reports it as an index named `__SHARDKEY` with index type `SHARD`, beside `PRIMARY`. **Foreign keys do not exist**: `ALTER TABLE ... ADD FOREIGN KEY` fails with `ERROR 2752`, and with `SET GLOBAL ignore_foreign_keys = ON` a `CREATE TABLE` carrying an inline foreign key is accepted and the constraint silently stripped - the one shape where you could believe you have a key you do not. Of the maintenance actions Analyze always worked; Optimize and Check failed with the same prepared-statement error and both succeed on the text protocol, measured through the provider (the app offers only Analyze as a global action here, so that pair was not re-probed from the UI). Permission errors are identical to MySQL, with the server's own text intact, and under a `SELECT`-only role the table list correctly showed only the granted table. No version is displayed anywhere, because the panel carrying it is one of the unavailable ones; were it fixed it would read MySQL 5.7.32, the wire version, not SingleStoreDB 9.1.1. **No licence key is needed** - the dev image self-licenses with `ROOT_PASSWORD` as the only variable set, which is what issue #424 recorded as the reason this engine had gone unprobed. Plan mode grounds a run here, through the provider-inventory path. Probed on the `0.2.82` dev image only. |
| CockroachDB | `postgres` | Partial | CockroachDB CCL v26.2.5 | Editor, error handling, performance metrics, slow queries and sessions all work. The **object browser and every size/health panel are blank**: `pg_total_relation_size()`, `pg_size_pretty()`, `pg_postmaster_start_time()` and `pg_tablespace_location()` do not exist there. |
| Apache Cloudberry (incubating) | `postgres` | Partial | PostgreSQL 14.4 (Apache Cloudberry 2.1.0-incubating) | Twelve of the fifteen surfaces answer. The monitoring dashboard, table statistics and index statistics all fail with one engine error, `query plan with multiple segworker groups is not supported`, which is Cloudberry's MPP planner restriction rather than a version gap. **Row counts and sizes after `ANALYZE` are correct** (2000 rows for 2000; 576 KB for 589824 bytes), so this is not the kind of engine whose statistics mislead; what they read before `ANALYZE` was not probed. Two `pg_ext_aux` tables appear in the browser, so it lists 4 objects for 2 user tables, and the overview's database size reads 62 MB against roughly 900 KB of user tables. **A foreign key is read back as if enforced and is not**: Cloudberry accepts the constraint with a warning that it will not enforce it, and an orphan insert then succeeds. **The agent cannot ground a run here**: the usual `gpadmin` login is refused because the execution profile reads a superuser as too broad, and a least-privilege role is refused at 289 rows against a 200-row budget, 282 of them in Cloudberry's own `gp_toolkit`. What the run reports for the first of those is that the engine offers no read-only execution profile, which describes the role rather than the engine (B47). The three failing panels report the planner error as a connection error, which the connection is not. Apache publishes build images only, so the probe ran on a third-party image. |
| ScyllaDB | `cassandra` | Partial | ScyllaDB 2026.2.4-0.20260810.e54224b8cebb (advertises Cassandra 3.0.8) | **All thirteen surfaces this provider offers now answer** - thirteen rather than the fifteen this column counts elsewhere, because the Cassandra provider offers neither cancellation nor `EXPLAIN` on either engine - and the row is still Partial because five of them answer *empty*. Re-probed 2026-08-24 through `createDatabaseProvider({type:"cassandra"})`, surface by surface, after the 2026-08-24 change: the overview, health, performance metrics, active sessions and the monitoring dashboard read Cassandra's `system_views` virtual tables, ScyllaDB has no `system_views` keyspace at all, and all five used to come back with the same verbatim `Keyspace system_views does not exist`. They now degrade to empty the way a denied grant does, so **Test Connection passes and the connection dialog can create a ScyllaDB connection** - before that change it could not, because Establish Connection is gated on that same health request, and one had to arrive seeded or admin-managed. What the degradation costs: no cache hit ratio and no active-session list (both `N/A`). **Connections now reads `N/A` with "not published" beneath it, not a fabricated `0`** - `DatabaseOverview.activeConnections` and `HealthInfo.activeConnections` are both optional as of 2026-08-24, the provider omits the key rather than send a zero nobody measured, and the same absence reaches the fleet card (which drops the connection chip entirely) and the agent's curated health reading (`null`). Verified in the browser on the built app: Connections `N/A / not published` on ScyllaDB against `1 / no limit published` on Apache Cassandra 5.0.9 in the same pass. The version, uptime, table count and index count are real: measured `Apache Cassandra 3.0.8`, `23.76m`, 3 tables, 1 index. Apache Cassandra 5.0.9, probed in the same pass, answers all thirteen with data in every one. **The SQL editor and the object browser work in full**: statements run, and every one of 18 CQL types read back byte-identically to that Cassandra baseline, `bigint` 9007199254740993, `decimal` 1.25, `duration` `3h20m`, `varint`, `blob`, `inet`, `date`, `time` and the collections included. The version panel reads Apache Cassandra 3.0.8 - the compatibility number `system.local` publishes - and not ScyllaDB 2026.2.4, which lives in `system.versions` where the provider does not look. **The object browser lists one extra object per secondary index, and the tree and the overview disagree about it**: ScyllaDB backs an index with a materialized view, so `customers_country_idx_index` is in `system_schema.views` - which the tree reads - and not in `system_schema.tables`, which the Tables count reads (measured: 4 objects in the tree against `tableCount` 3). Cassandra lists neither. **Error classes are identical to Cassandra even though the server's wording is not** - a missing table is `unconfigured table no_such_table` rather than `table no_such_table does not exist`, a missing column `Unrecognized name nope` rather than `Undefined column name nope in table probe.customers` - because the provider classifies on the driver's error code and not on the message text. Row counts and sizes are blank for the same reason as on Cassandra, and the panels read `N/A` rather than a fabricated zero. **Creating a keyspace needs `NetworkTopologyStrategy` on the 2026.2 line**: `SimpleStrategy` is refused outright with `SimpleStrategy doesn't support tablet replication`, so the setup recipe in [cassandra.md §10](./cassandra.md#reproducing-the-live-pass) does not run unchanged; 2025.1 still accepts it, with a warning. ScyllaDB 2025.1.14-0.20260612.103b84070f3b was probed in the 2026-08-21/22 pass and behaved identically on every surface, including the same verbatim refusal the fix keys on, so this row describes both the 2025.1 and the 2026.2 line - but only those two builds, only a single-node container, and only 2026.2.4 was re-probed after the fix. |
| Databend | `mysql` | Query editor only | Databend v1.2.925-patch-11 (advertises MySQL 8.0.90) | Probed 2026-08-27 against `datafuselabs/databend:v1.2.925-patch-11`. SQL runs - a 2000-row `count(*)`, a `GROUP BY` and a plain `EXPLAIN` all answer, the last with Databend's own `TableScan` plan. **Everything else is unavailable for a reason that is ours, and the catalogs prove it**: asked with literal SQL, `information_schema.tables` reports the true 3 and 2000 rows with `data_length` 124 and 49000, and `information_schema.columns` answers in full. The provider gets none of it, because every parameterised read goes through mysql2's prepared protocol and Databend replies **`Prepare is not support in Databend`** - so the table list, the schema, active sessions and the table, index and storage statistics all fail. [D8](../BACKLOG.md) moved the *parameterless* statements to the text protocol; these carry placeholders and still prepare. Recorded as [D33](../BACKLOG.md). Two gaps are the engine's own and would survive that fix: **there is no `SHOW STATUS` statement at all** (`unexpected STATUS. Did you mean SHOW STAGES...`), so the overview and health panels have no source, and there is no `information_schema.processlist`, so sessions have none either. Also its own: `EXPLAIN FORMAT='json'` does not parse, `OPTIMIZE` and `CHECK` do not exist, foreign keys are absent (`key_column_usage` is empty) and no index is ever reported (`statistics` is empty). **`ANALYZE` crashes the provider rather than failing**: it returns an object where the reader expects an array, so `runMaintenance` throws `rows.filter is not a function` - filed with D33. One authoring trap worth knowing: Databend follows the SQL standard on quoting, so `"TR"` is an identifier and only `'TR'` is a string. **Browser-verified 2026-08-27**: the editor really does run - `SELECT country, count(*) ... GROUP BY country` returned `DE 1`, `TR 1`, `US 1` from the grid - which is the check QuestDB failed, and the background `EXPLAIN FORMAT=JSON` beside it returns 500 as expected. **What plan mode does here is the honest downstream of the same cause and is worth reading**: the run succeeds and drafts NOTHING, saying *this run was given no inventory of this database* and asking for the table and column names - the schema read failed, so it refuses to invent a schema rather than guessing one. |
| Materialize | `postgres` | Query editor only | Materialize 26.37.0 | No pg statistics catalog and no size functions, and `MATERIALIZED` is reserved, which our schema query uses. Editor only. |
| RisingWave | `postgres` | Query editor only | RisingWave 3.0.3 | No pg statistics catalog, differently typed size functions, and a parameterised `LIMIT` is rejected. Editor only. |

**ScyllaDB was the standing illustration of the rule above, and its probe has now run**, which is why
it has a row rather than a paragraph. It speaks the CQL wire protocol and `cassandra-driver` connects
to it, which is exactly the kind of "connects, therefore supported" claim this table exists to refuse
— and what the probe measured is that the parts which differ are the parts that are *not* the wire.
Of the three doubts [cassandra.md §11](./cassandra.md#11-scylladb-is-a-partial-relative-one-absent-keyspace-cost-five-surfaces-until-d9) raised,
two held and one was refuted: `system_views` is absent, which is still the whole of what makes the
row above Partial - the five surfaces that read it answered an error until 2026-08-24 and answer empty since
(re-probed 2026-08-24) - and the version string is not `release_version`-shaped, while `gossip_generation` does
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

- **QuestDB 10.0.1** - **it fails the one surface a query-editor-only row exists to claim**, probed
  on 2026-08-26 through the `postgres` driver against `questdb/questdb:10.0.1`. QuestDB does speak
  the PostgreSQL wire protocol on 8812, and through the provider a statement answers: `SELECT
  country, count() c FROM probe_orders` returned three rows. **In the product it does not.** The
  editor always attaches a `queryId`, the provider then issues `SELECT pg_backend_pid()` first, and
  QuestDB has no such function, so pressing Run answers `500 unknown function name:
  pg_backend_pid()` - measured in Chrome, and measured both ways at the provider boundary to be
  sure of the cause: the identical call with a `queryId` fails and without one returns the three
  rows. **This is the Cloud Spanner shape below, and it is the reason a provider-level probe cannot
  award a tier.** Two statements do not rescue it either: the multi-statement path drops the
  `queryId`, but the run still failed in the browser.
  The rest, for whoever revisits this: the object browser fails on TWO independent causes of ours -
  the schema query's `AS MATERIALIZED` CTEs are a syntax error there, and with the keyword removed
  the same query dies on `pg_total_relation_size()`, which QuestDB does not have - so it is not the
  Materialize/RisingWave case of an absent catalog. `information_schema.tables` lists the table and
  `pg_catalog.pg_class` answers with 36 columns. There is no `pg_stat_activity`,
  `pg_statio_user_tables`, `pg_stat_user_tables` or `pg_tablespace`, so health, performance
  metrics, table statistics and storage cannot run; the slow-query and session reads fail earlier
  still, on `NULLS LAST`. A plain `EXPLAIN` works through the provider and shows QuestDB's own plan
  (`PageFrame`, `Row forward scan`) while the editor's background `EXPLAIN (ANALYZE, BUFFERS,
  FORMAT JSON)` is rejected outright. Neither `ANALYZE` nor `VACUUM` is a QuestDB statement. Errors
  are classified correctly with QuestDB's own text. The version panel would read PostgreSQL 12.3 -
  `version()` names QuestDB only at the end of its string, and the real build is in `build()`,
  which the provider does not call. The compose service is kept under the `compat` profile
  deliberately, so the refusal can be reproduced rather than taken on trust.
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


## SSH tunnels: bastion host key verification

Any connection may reach its database through an SSH tunnel (`sshTunnel` on the connection,
[`src/lib/ssh/tunnel.ts`](../../src/lib/ssh/tunnel.ts)). This is the only layer that can verify who
terminated the SSH hop: past it the database driver is handed `127.0.0.1` and a local port, so the
connection's own SSL settings say nothing about the bastion.

**The policy is trust-on-first-use (TOFU), pinned per connection.** Not "refuse anything unknown":
requiring a pasted fingerprint before the first connection makes tunnelling unusable for someone
reaching their own bastion, TOFU is what every SSH client does on first contact, and it is strictly
better than what it replaced - `ssh2` has no default host verifier, so with the callback absent the
library accepted whatever key it was offered and the tunnel completed against whatever answered on
that address.

What happens, in order:

1. **A connection carrying a pin** (`sshTunnel.hostKeyFingerprint`) is verified against it. Durable,
   per connection, and it always wins.
2. **No pin, first contact with that bastion** - the key is accepted and remembered for the bastion's
   address (`host:port`), the same thing `known_hosts` keys on. The accepted fingerprint is reported
   back on the tunnel.
3. **No pin, a later contact with that bastion** - verified against what was remembered.

A key that does not match fails the connection outright, naming both fingerprints. Measured
2026-08-26 against a real `openssh-server` container, all three arms:

```
no pin        -> accepted, reported SHA256:JWLQciyX8RYEeuK+bwRLW/YSpStz0/L7BlbVcejL1/U
                 (byte-identical to `ssh-keyscan -p 2226 127.0.0.1 | ssh-keygen -lf -`)
correct pin   -> connects
wrong pin     -> SSH host key verification failed for 127.0.0.1:2226: offered SHA256:JWLQ..., expected
                 SHA256:AAAA... Confirm the bastion's key with `ssh-keyscan <host> | ssh-keygen -lf -`;
                 if it changed legitimately, clear the pinned fingerprint for this connection.
```

Fingerprints are printed the way OpenSSH prints them - `SHA256:` followed by unpadded base64 of the
SHA-256 of the server's public key blob - so what an error shows can be compared directly against
`ssh-keyscan <bastion> | ssh-keygen -lf -`, against `ssh-keygen -lf` on a `.pub` file, or against an
existing `known_hosts` entry.

Three deliberate limits, so nobody reads more into this than it does:

- **There is no "accept the new key?" prompt.** A mismatch fails; the remedy is to clear the pin once
  you have confirmed out of band that the key legitimately changed (a rebuilt bastion). Whether to
  offer an in-product accept flow is a separate decision.
- **First-contact memory lasts as long as the server process.** A restart re-enters first contact.
- **Nothing writes the durable pin yet.** The verifier honours `sshTunnel.hostKeyFingerprint`, but no
  surface sets it: there is no input for it, seed configs do not model `sshTunnel`, and an accepted
  fingerprint is not written back. So today's protection is the process-scoped memory above - a key
  that changes within a server's lifetime is refused, and a restart trusts afresh. Tracked as D34.

The fingerprint is stored and displayed **in the clear**, on purpose. It is public key material: it
authenticates the bastion to Studio, grants no access, unlocks nothing, and it has to be readable for
the comparison above to be possible at all. `src/lib/storage/connection-secrets.ts` classifies it
`public` alongside the certificates in `ssl`; the tunnel's password, private key and passphrase stay
encrypted at rest.

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

**Garnet needs no setup at all** - `docker compose -f database-compose.yml --profile compat up -d garnet`
and it answers RESP on **16380** with no password.

**ParadeDB (15441), OrioleDB (15442) and Databend (13308) need no setup either**, beyond the usual
`probe` fixture. Two notes that decide whether a probe there measures anything: on **OrioleDB**,
check `default_table_access_method` is `orioledb` and that your tables report `amname = orioledb`
(`SELECT relname, amname FROM pg_class c JOIN pg_am a ON a.oid = c.relam`) - a heap table there
measures PostgreSQL, not OrioleDB. On **ParadeDB and OrioleDB both**, create a least-privilege role
before testing agent plan mode, because the execution profile refuses a superuser on any PostgreSQL:

```sql
CREATE ROLE probe_ro LOGIN PASSWORD 'Probe123pass!';
GRANT CONNECT ON DATABASE probe TO probe_ro;
GRANT USAGE ON SCHEMA public TO probe_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO probe_ro;
```

**Databend answers on 3307, not 3306**, and its strings must be single-quoted (`'TR'`, never
`"TR"` - that is an identifier there).

**The `questdb` service exists to reproduce a refusal, not a connection.** It answers the PostgreSQL wire on
**18812** (user `admin`, password `quest`, database `qdb`) and publishes its own HTTP API on 19000, which is
how the probe seeded 2000 rows (`INSERT INTO ... FROM long_sequence(2000)` over `GET /exec`) - there is no
`psql`-friendly bulk insert there. A connection to it can be created and the tree stays empty, and pressing
Run fails; see **QuestDB** under *Measured, and refused a row* above for what that costs and why.

**Two other services need a step before the dialog will work.** ScyllaDB needs `Local Data Center`
filled in, the same field Cassandra needs. **Apache Doris starts with no password on `root`, and an
empty password is not a credential the dialog treats as filled**, so set one and create the fixture
objects before connecting - this is the recipe the 2026-08-26 probe ran, and the sleep is not
optional: `information_schema` reports 0 rows and 0 B until Doris's background statistics catch up.

```bash
docker compose -f database-compose.yml --profile compat up -d doris
docker exec libredb-doris mysql -uroot -P9030 -h127.0.0.1 -e "SET PASSWORD FOR 'root' = PASSWORD('Probe#2026');"
docker exec libredb-doris mysql -uroot -pProbe#2026 -P9030 -h127.0.0.1 -e "
  CREATE DATABASE IF NOT EXISTS probe;
  CREATE TABLE probe.probe_orders (id INT NOT NULL, customer_id INT, amount DECIMAL(10,2), created DATETIME)
    DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 3 PROPERTIES('replication_num'='1');
  INSERT INTO probe.probe_orders SELECT number, number % 3 + 1, number * 1.25, '2026-08-26 10:00:00'
    FROM numbers('number'='2000');"
sleep 60   # information_schema reads 0 rows / 0 B until the background statistics land
```

Then connect on port **19035** as `root` / `Probe#2026`, database `probe`.

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
