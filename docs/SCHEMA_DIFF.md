# Generated migration SQL

`generateMigrationSQL` in `src/lib/schema-diff/migration-generator.ts` converts a schema diff into
reviewable SQL. Its dialect coverage is pinned by the exhaustive tables in
`tests/unit/schema-diff/migration-generator.test.ts` and `migration-dialects.test.ts`.

For SQL Server, migrations use `BEGIN TRANSACTION` and `COMMIT`; added columns use `ADD`, and
index drops include `ON <table>`. Oracle uses `ADD (<definition>)`, places `DEFAULT` before
`NOT NULL`, and emits no transaction wrapper because DDL commits implicitly. Oracle table,
index and constraint drops use the unconditional forms, which avoid depending on a particular
release's support for `IF EXISTS`. A generated migration is not an idempotent script.

Removed foreign keys and indexes precede column changes, so an indexed column can be removed
and an index name can be reused in the same table diff. Changes to an existing index's columns,
column order or uniqueness replace its old definition; a uniqueness change can fail if existing
data violates the new constraint. Identifier quoting escapes delimiters;
line breaks in informational comments are flattened so metadata cannot start a SQL statement.

MongoDB, Redis, LibreDB, Couchbase, Druid, Elasticsearch and OpenSearch receive an explanatory
comment instead of relational table DDL. Trino and ClickHouse refuse foreign-key clauses;
Trino refuses primary keys too. Trino has no index grammar, and the diff does not retain enough
ClickHouse index metadata to distinguish and recreate its index kinds, so those index changes
also produce comments. Existing Cassandra and SQLite-family limitations remain explicit.

Review each migration against its target: a diff does not carry original foreign-key constraint
names, schema qualifiers, cross-table dependency order, or a general type-conversion strategy.
Default expressions remain SQL expressions supplied by the diff; they are not parameter values.

## Live regression probe

The optional probe in `tests/live/schema-diff-dialects.ts` creates a fresh SQL Server database or
Oracle user schema and removes it in `finally`. Use disposable servers on localhost. It checks:

- CREATE, ADD and DROP statements, defaults, NOT NULL and foreign-key enforcement;
- dropping an indexed foreign-key column and reusing the index name;
- hostile line breaks and quoting in object names without modifying a sentinel row;
- transaction rollback on SQL Server and implicit DDL commit on Oracle;
- negative controls: the previous `ADD COLUMN` and bare `BEGIN` forms must fail.

Run one engine at a time, supplying the password configured on its disposable container:

```sh
MIGRATION_PROBE_ENGINE=mssql MSSQL_TEST_PORT=11433 MSSQL_TEST_PASSWORD="$PROBE_PASSWORD" \
  bun tests/live/schema-diff-dialects.ts
MIGRATION_PROBE_ENGINE=oracle ORACLE_TEST_PORT=11521 ORACLE_TEST_PASSWORD="$PROBE_PASSWORD" \
  bun tests/live/schema-diff-dialects.ts
```

The Oracle connection targets `FREEPDB1`. Both probes require credentials allowed to create and
remove the isolated test database/schema. They are separate from `bun run test`, which needs no
external database server.

Measured on 2026-09-08 with Oracle AI Database 26ai Free 23.26.1.0.0
(`gvenzl/oracle-free:23.26.1-slim-faststart`) and the SQL Server 15 ARM64 engine in
Microsoft Azure SQL Edge Developer 15.0.2000.1574 (`mcr.microsoft.com/azure-sql-edge:1.0.7`).
The SQL Server 2022 CU17 x86 container could not start under the local Mac's emulation, so the
live T-SQL measurement uses the ARM engine above; it is not a SQL Server 2022 certification.

Grammar references:
[SQL Server ALTER TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql),
[SQL Server DROP INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/drop-index-transact-sql),
[Oracle ALTER TABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ALTER-TABLE.html),
[Trino SQL statements](https://trino.io/docs/current/sql.html), and
[ClickHouse index examples](https://github.com/ClickHouse/clickhouse-docs/blob/main/docs/guides/best-practices/skipping-indexes-examples.md).
