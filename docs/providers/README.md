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

## Cross-cutting docs

- **Provider architecture:** [`../DATABASE_PROVIDERS.md`](../DATABASE_PROVIDERS.md) — the
  Strategy-Pattern architecture, the provider hierarchy, and the shared interface/base classes.
- **Adding a new provider:** [`../ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) — the step-by-step
  guide, plus the rubric for deciding whether a database needs a driver at all, the transport seam,
  and the traps of talking to one over HTTP. Couchbase is the worked example.
- **HTTP API contract** (request/response for `/api/db/query`, schema, maintenance, …):
  [`../API_DOCS.md`](../API_DOCS.md).
