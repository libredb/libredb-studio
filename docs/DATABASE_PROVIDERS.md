# Database Provider Architecture

This document describes the modular database provider architecture implemented using the Strategy Pattern. It serves both as the **architecture overview** and as a step-by-step tutorial for [adding a new database provider](#adding-a-new-database-provider).

> **Per-provider detail lives in [`docs/providers/`](./providers/README.md).** Each provider has its
> own prime reference (`docs/providers/<type-id>.md`) covering connection, query format, schema,
> monitoring, maintenance, capabilities, error handling, testing, and known limitations. This
> document is the cross-cutting **architecture + authoring** companion to those per-provider docs.

## Overview

The database abstraction layer (`src/lib/db/`) provides a unified interface for multiple database types while maintaining type safety, connection pooling, and consistent error handling. Each database type is a self-contained provider class. Adding a new one requires **no changes** to routes, components, or existing providers.

## Architecture

```
src/lib/db/
├── index.ts                    # Public exports
├── types.ts                    # Interfaces & Types
├── errors.ts                   # Custom error classes
├── factory.ts                  # Provider Factory
├── base-provider.ts            # Abstract base class
├── providers/
│   ├── sql/                    # SQL Database Providers
│   │   ├── sql-base.ts         # SQL-specific base class
│   │   ├── postgres.ts         # PostgreSQL Strategy
│   │   ├── mysql.ts            # MySQL Strategy
│   │   ├── sqlite.ts           # SQLite Strategy
│   │   ├── sqlite-driver.ts    # SQLite runtime driver adapter (bun:sqlite | node:sqlite)
│   │   ├── oracle.ts           # Oracle Strategy
│   │   ├── mssql.ts            # SQL Server Strategy
│   │   └── clickhouse/         # ClickHouse Strategy (SQL over HTTP, no driver)
│   │       ├── index.ts        #   ClickHouseProvider
│   │       ├── transport.ts    #   ClickHouseTransport seam + neutral result types
│   │       ├── http-transport.ts # The one HTTP implementation (fetch)
│   │       └── introspect.ts   #   system.* catalogs (databases/tables/columns/data_skipping_indices)
│   ├── document/               # Document Database Providers
│   │   ├── mongodb.ts          # MongoDB Strategy
│   │   └── couchbase/          # Couchbase Strategy (SQL++ over REST, no driver)
│   │       ├── index.ts        #   CouchbaseProvider
│   │       ├── transport.ts    #   CouchbaseTransport seam + neutral result types
│   │       ├── http-transport.ts #  Query REST + management REST (the one implementation)
│   │       ├── keyspace.ts     #   display name <-> backtick-quoted keyspace path
│   │       └── introspect.ts   #   system:* catalogs + INFER
│   ├── keyvalue/               # Key-Value Providers
│   │   └── redis.ts            # Redis Strategy
│   └── embedded/               # Embedded (in-process) Providers
│       └── libredb.ts          # LibreDB Strategy
└── utils/
    ├── pool-manager.ts         # Connection pool utilities
    └── query-limiter.ts        # SELECT auto-LIMIT (analyzeQuery/applyQueryLimit)
```

## Provider Hierarchy

```
BaseDatabaseProvider (abstract)
├── SQLBaseProvider (abstract) ─────────────┐
│   ├── PostgresProvider                    │
│   ├── MySQLProvider                       │ SQL Databases
│   ├── SQLiteProvider                      │ (shared SQL utilities)
│   ├── OracleProvider                      │
│   ├── MSSQLProvider                       │
│   └── ClickHouseProvider                  │
├── MongoDBProvider ────────────────────────┤ Document Database
├── CouchbaseProvider ──────────────────────┤ Document Database (SQL++ over REST)
├── RedisProvider ──────────────────────────┤ Key-Value Store
└── LibreDBProvider ────────────────────────┘ Embedded (key-value)
```

`SQLBaseProvider` provides SQL-specific helpers (LIMIT injection, identifier escaping, placeholder generation). Non-SQL databases like MongoDB, Redis, and LibreDB extend `BaseDatabaseProvider` directly. LibreDB is embedded (opened in-process from a file, like SQLite) but, having no SQL, it is a key-value-style provider rather than a SQL one.

Couchbase is the one provider that speaks a SQL dialect (SQL++) without extending `SQLBaseProvider`: that base owns pooled-driver mechanics — per-dialect escaping, placeholder generation, transactions, `cancelQuery` — that a stateless HTTP transport does not have. Its SQL-ness is expressed through `queryLanguage: 'sql'` in the capabilities instead. See [providers/couchbase.md](./providers/couchbase.md).

The `SQLiteProvider` loads its embedded driver at runtime through `sqlite-driver.ts`: `bun:sqlite` under Bun, `node:sqlite` under plain Node (Node >= 24 built-in). Set `LIBREDB_SQLITE_DRIVER=bun|node` to force a driver. `better-sqlite3` is **not** used by the DB provider — it is only the SQLite driver for the storage layer (`src/lib/storage/`).

**Key files:**

| File | Purpose |
|------|---------|
| `src/lib/types.ts` | `DatabaseType` union, `DatabaseConnection` interface |
| `src/lib/db/types.ts` | `DatabaseProvider` interface, `ProviderCapabilities`, `ProviderLabels` |
| `src/lib/db/base-provider.ts` | Abstract base class with default implementations |
| `src/lib/db/providers/sql/sql-base.ts` | SQL-specific base (extend this for SQL databases) |
| `src/lib/db/factory.ts` | Provider creation + caching |
| `src/lib/db-ui-config.ts` | Icons, colors, form fields per database type |

**How it flows:**

```
Frontend                          Backend
────────                          ───────
ConnectionModal                   /api/db/provider-meta
  → selects DB type                 → getOrCreateProvider(conn)
  → form fields from                → provider.getCapabilities()
    db-ui-config.ts                 → provider.getLabels()
                                    → returns { capabilities, labels }
useProviderMetadata hook  ←─────
  → capabilities, labels

Studio.tsx
  → passes metadata to all components
  → components use labels for text, capabilities for feature flags

QueryEditor                      /api/db/query
  → user writes query              → getOrCreateProvider(conn)
  → Ctrl+Enter                     → provider.prepareQuery(sql, opts)
                                   → provider.query(prepared.query)
                                   → returns rows + pagination
```

## Supported Databases

Ten providers are supported. For the per-provider reference (driver, pooling, query format,
monitoring, limitations, …) see the prime docs in **[`docs/providers/`](./providers/README.md)**:

| Provider | type-id | Family | Reference |
|----------|---------|--------|-----------|
| PostgreSQL | `postgres` | SQL | [providers/postgres.md](./providers/postgres.md) |
| MySQL | `mysql` | SQL | [providers/mysql.md](./providers/mysql.md) |
| Oracle | `oracle` | SQL | [providers/oracle.md](./providers/oracle.md) |
| Microsoft SQL Server | `mssql` | SQL | [providers/mssql.md](./providers/mssql.md) |
| SQLite | `sqlite` | SQL (embedded) | [providers/sqlite.md](./providers/sqlite.md) |
| Redis | `redis` | Key-Value | [providers/redis.md](./providers/redis.md) |
| MongoDB | `mongodb` | Document | [providers/mongodb.md](./providers/mongodb.md) |
| Couchbase | `couchbase` | Document (SQL++) | [providers/couchbase.md](./providers/couchbase.md) |
| ClickHouse | `clickhouse` | SQL | [providers/clickhouse.md](./providers/clickhouse.md) |
| LibreDB | `libredb` | Embedded (key-value) | [providers/libredb.md](./providers/libredb.md) |

## Core Interface

```typescript
interface DatabaseProvider {
  readonly type: DatabaseType;
  readonly config: DatabaseConnection;

  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Query execution
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  // Schema operations
  getSchema(): Promise<TableSchema[]>;
  getTables(): Promise<string[]>;

  // Health & monitoring
  getHealth(): Promise<HealthInfo>;

  // Maintenance operations
  runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult>;

  // Validation
  validate(): void;
}
```

## Usage

### Basic Usage (Recommended)

```typescript
import { getOrCreateProvider } from '@/lib/db';

// SQL Database
const sqlConnection = {
  id: 'my-postgres',
  name: 'Production DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'admin',
  password: 'secret',
  createdAt: new Date(),
};

const sqlProvider = await getOrCreateProvider(sqlConnection);
const result = await sqlProvider.query('SELECT * FROM users LIMIT 10');

// MongoDB
const mongoConnection = {
  id: 'my-mongo',
  name: 'MongoDB Atlas',
  type: 'mongodb',
  connectionString: 'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
  createdAt: new Date(),
};

const mongoProvider = await getOrCreateProvider(mongoConnection);
const docs = await mongoProvider.query(JSON.stringify({
  collection: 'users',
  operation: 'find',
  filter: { age: { $gt: 18 } },
  options: { limit: 10 }
}));
```

### Direct Provider Creation

```typescript
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider(connection, {
  pool: { min: 2, max: 10 },
  queryTimeout: 30000,
});

await provider.connect();
const schema = await provider.getSchema();
await provider.disconnect();
```

## Non-SQL Query Formats

The non-SQL providers take a JSON query rather than SQL. The full format, operation list, and worked
examples live in their prime docs:

- **MongoDB** (MQL — `{collection, operation, filter, pipeline, update, documents, options}`):
  [providers/mongodb.md](./providers/mongodb.md) and the
  [`API_DOCS.md` MongoDB Query Format](./API_DOCS.md) section.
- **Redis** (plain command or `{command, args}`): [providers/redis.md](./providers/redis.md).

Couchbase is deliberately **not** in that list: SQL++ is a SQL dialect, so a Couchbase connection
takes ordinary SQL in the `sql` field and inherits the SQL editor, the shared limiter, and NL2SQL.
Its keyspaces are backtick-quoted three-part paths (`` `bucket`.`scope`.`collection` ``) — see
[providers/couchbase.md](./providers/couchbase.md).

## Configuration

### Pool Configuration

```typescript
interface PoolConfig {
  min: number;          // Minimum connections (default: 2)
  max: number;          // Maximum connections (default: 10)
  idleTimeout: number;  // Close idle after ms (default: 30000)
  acquireTimeout: number; // Wait timeout ms (default: 60000)
}
```

### Query Timeout

Default query timeout is 60 seconds (60000ms). Configure per-provider:

```typescript
const provider = await createDatabaseProvider(connection, {
  queryTimeout: 30000, // 30 seconds
});
```

## Error Handling

Custom error classes provide detailed error information:

```typescript
import {
  DatabaseError,
  ConnectionError,
  QueryError,
  TimeoutError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
} from '@/lib/db/errors';

try {
  await provider.query(sql);
} catch (error) {
  if (isConnectionError(error)) {
    console.log(`Connection failed to ${error.host}:${error.port}`);
  } else if (isQueryError(error)) {
    console.log(`Query error: ${error.message}, SQL: ${error.sql}`);
  } else if (isDatabaseError(error)) {
    console.log(`Database error: ${error.code}`);
  }
}
```

### Error Hierarchy

```
DatabaseError (base)
├── DatabaseConfigError  - Configuration errors
├── ConnectionError      - Connection failures
├── AuthenticationError  - Invalid credentials
├── PoolExhaustedError   - No available connections
├── QueryError           - SQL/MQL syntax/execution errors
├── TimeoutError         - Query/connection timeouts
└── QueryCancelledError  - Query cancelled by the user
```

## Provider-Specific Features

Provider-specific behaviour — pooling model, SSL/encryption, pagination, monitoring sources,
maintenance operations, and known limitations — is documented per provider under
[`docs/providers/`](./providers/README.md). Start there for anything specific to PostgreSQL, MySQL,
Oracle, SQL Server, SQLite, Redis, MongoDB, Couchbase, ClickHouse, or LibreDB.

## Security Considerations

- Parameterized queries prevent SQL injection
- MongoDB queries are JSON-parsed, preventing injection
- Connection credentials are never logged
- Pool connections are properly cleaned up
- SSL is auto-enabled for known cloud providers

## Performance Notes

- Connection pooling provides 5-10x speedup for repeated queries
- Idle connections are automatically closed after 30 seconds
- Query timeouts prevent runaway queries
- Schema queries are optimized with LIMIT clauses
- MongoDB uses estimated document counts for performance

---

## Adding a New Provider

This document describes the architecture and the providers that ship today. The step-by-step guide
to adding a new one — including how to decide whether it needs a driver at all — lives in
[`ADDING_A_PROVIDER.md`](./ADDING_A_PROVIDER.md).
