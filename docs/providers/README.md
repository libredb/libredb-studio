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
| LibreDB | `libredb` | Embedded (Key-Value) | `@libredb/libredb` | JSON (command grammar) | [libredb.md](./libredb.md) |

## Conventions

- **Filename = canonical type-id** (`postgres.md`, `mssql.md`, …), mirroring the source file
  (`src/lib/db/providers/<family>/<type-id>.ts`, or a `<type-id>/` directory when a provider is
  split across modules, as Couchbase, ClickHouse and Druid are). The official product name (e.g.
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


## Connecting to the container fixture

What to type into the connection dialog for **every shipped provider**, against
[`database-compose.yml`](../../database-compose.yml). One row per type-id, so the table covers the
same set as the table at the top of this file and a new provider is a new row rather than a re-drawn
grid. Each row was verified against the running container on 2026-08-19 — the credentials are the
ones the fixture actually accepts, not the ones its environment block asks for (twice those differ;
see the notes).

Start the eight always-on services with a plain `docker compose -f database-compose.yml up -d`; the
`Profile` column names the ones that need asking for.

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
| SQLite | *no service* | — | — | — | — | a file path on the Studio host | — |
| LibreDB | *no service* | — | — | — | — | a directory on the Studio host | — |

*none* means leave the field empty. It is never a default that happens to be blank: Druid loads no
security extension in a default install, both search services run with their security plugin off, and
the `redis` service sets no `requirepass` (verified: `CONFIG GET requirepass` answers empty).

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

**Druid is seven containers, not one.** It has no single-container mode, so the whole block carries
`profiles: ["druid"]` and a plain `up -d` leaves it out. The dialog only ever needs the Router:

```bash
docker compose -f database-compose.yml --profile druid up -d
```

For the engines that have no provider of their own, use the `compat` profile and connect as the driver
named in the [Wire-compatible engines](#wire-compatible-engines) table above.
