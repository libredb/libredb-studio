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
| LibreDB | `libredb` | Embedded (Key-Value) | `@libredb/libredb` | JSON (command grammar) | [libredb.md](./libredb.md) |

## Conventions

- **Filename = canonical type-id** (`postgres.md`, `mssql.md`, …), mirroring the source file
  (`src/lib/db/providers/<family>/<type-id>.ts`, or a `<type-id>/` directory when a provider is
  split across modules, as Couchbase, ClickHouse and Druid are). The official product name (e.g.
  "SQL Server") is used only in each doc's title and prose.
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
| MariaDB | `mysql` | Full | 12.3.2-MariaDB-ubu2404 | Behaves as MySQL throughout. The version shown is MariaDB's full build string. Only 12.3 was probed; the 10.x `information_schema` surface was not. |
| Citus | `postgres` | Full | citus 14.1-1 on PostgreSQL 18.4 | All surfaces answer. **Row counts and sizes for a distributed table are wrong, not missing** — PostgreSQL statistics describe the empty coordinator parent, not the shards. `citus_tables` and `citus_schemas` show up in the browser. |
| Valkey | `redis` | Full | Valkey 9.1.1 | Behaves as Redis. The overview shows the Redis emulation level (7.2.4), not the Valkey version. |
| DragonflyDB | `redis` | Full | DragonflyDB df-v1.40.1 | Overview shows the emulation level (7.4.0). Max connections reads 0 (no usable `maxclients` in `INFO`), and active sessions show a numeric id instead of a username (`CLIENT LIST` omits `user=`). |
| KeyDB | `redis` | Full | KeyDB 6.3.4 | Publishes no version field of its own, so the overview is indistinguishable from a Redis 6 server. A session's command can appear without its subcommand. |
| FerretDB | `mongodb` | Full | FerretDB 2.7.0 (MongoDB 7.0.77 wire) | Every monitoring surface answers. Sign in with the **backend PostgreSQL** credentials — `authMechanism=PLAIN` is rejected. The version shown is the advertised MongoDB wire version. Needs its own backend, so it is two containers. |
| CockroachDB | `postgres` | Partial | CockroachDB CCL v26.2.5 | Editor, error handling, performance metrics, slow queries and sessions all work. The **object browser and every size/health panel are blank**: `pg_total_relation_size()`, `pg_size_pretty()`, `pg_postmaster_start_time()` and `pg_tablespace_location()` do not exist there. |
| Materialize | `postgres` | Query editor only | Materialize 26.37.0 | No pg statistics catalog and no size functions, and `MATERIALIZED` is reserved, which our schema query uses. Editor only. |
| RisingWave | `postgres` | Query editor only | RisingWave 3.0.3 | No pg statistics catalog, differently typed size functions, and a parameterised `LIMIT` is rejected. Editor only. |

Reproduce any row with the `compat` profile of the container fixture, then connect as the driver in
the second column:

```bash
docker compose -f database-compose.yml --profile compat up -d
```

**Not yet measured.** The following speak a wire protocol we ship but had no reachable instance
during the Phase 0 run, so they are deliberately absent from the table above rather than assumed to
work: YugabyteDB and TimescaleDB (image pulls did not complete), TiDB (needs a PD + TiKV cluster),
SingleStore (dev image needs a licence key), StarRocks and OceanBase (multi-GB images), and every
managed-only service — Amazon Redshift, Aurora, AlloyDB, Neon, Supabase, Cloud SQL, Cloud Spanner,
Azure SQL Database, Microsoft Fabric, Azure Synapse, Azure SQL Managed Instance, Amazon ElastiCache,
Upstash, PlanetScale, Azure Cosmos DB and Amazon DocumentDB. Their status is tracked in
[#424](https://github.com/libredb/libredb-studio/issues/424).

## Cross-cutting docs

- **Provider architecture:** [`../DATABASE_PROVIDERS.md`](../DATABASE_PROVIDERS.md) — the
  Strategy-Pattern architecture, the provider hierarchy, and the shared interface/base classes.
- **Adding a new provider:** [`../ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) — the step-by-step
  guide, plus the rubric for deciding whether a database needs a driver at all, the transport seam,
  and the traps of talking to one over HTTP. Couchbase is the worked example.
- **HTTP API contract** (request/response for `/api/db/query`, schema, maintenance, …):
  [`../API_DOCS.md`](../API_DOCS.md).


## database compose connection tests
  ┌──────────┬───────────────┬─────────────┬──────────────┐
  │          │   Couchbase   │ ClickHouse  │ Apache Druid │
  ├──────────┼───────────────┼─────────────┼──────────────┤
  │ Host     │ localhost     │ localhost   │ localhost    │
  ├──────────┼───────────────┼─────────────┼──────────────┤
  │ Port     │ 8091          │ 8123        │ 8888         │
  ├──────────┼───────────────┼─────────────┼──────────────┤
  │ User     │ Administrator │ libredb     │ null         │
  ├──────────┼───────────────┼─────────────┼──────────────┤
  │ Password │ password123   │ password123 │ null         │
  ├──────────┼───────────────┼─────────────┼──────────────┤
  │ Database │ travel        │ demo        │ null         │
  └──────────┴───────────────┴─────────────┴──────────────┘
