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
│   │   ├── oracle.ts           # Oracle Strategy
│   │   └── mssql.ts            # SQL Server Strategy
│   ├── document/               # Document Database Providers
│   │   └── mongodb.ts          # MongoDB Strategy
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
│   └── MSSQLProvider                       │
├── MongoDBProvider ────────────────────────┤ Document Database
├── RedisProvider ──────────────────────────┤ Key-Value Store
└── LibreDBProvider ────────────────────────┘ Embedded (key-value)
```

`SQLBaseProvider` provides SQL-specific helpers (LIMIT injection, identifier escaping, placeholder generation). Non-SQL databases like MongoDB, Redis, and LibreDB extend `BaseDatabaseProvider` directly. LibreDB is embedded (opened in-process from a file, like SQLite) but, having no SQL, it is a key-value-style provider rather than a SQL one.

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

Eight providers are supported. For the per-provider reference (driver, pooling, query format,
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
import { createDatabaseProvider } from '@/lib/db';

const provider = createDatabaseProvider(connection, {
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
const provider = createDatabaseProvider(connection, {
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
} from '@/lib/db';

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
└── TimeoutError         - Query/connection timeouts
```

## Provider-Specific Features

Provider-specific behaviour — pooling model, SSL/encryption, pagination, monitoring sources,
maintenance operations, and known limitations — is documented per provider under
[`docs/providers/`](./providers/README.md). Start there for anything specific to PostgreSQL, MySQL,
Oracle, SQL Server, SQLite, Redis, or MongoDB.

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

# Adding a New Database Provider

This section walks you through every step of adding a new database type to LibreDB Studio. Because the architecture follows the **Strategy Pattern** (see [Architecture](#architecture) and [Provider Hierarchy](#provider-hierarchy) above), adding a new database requires **no changes** to routes, components, or existing providers — you only register a new self-contained provider class.

## Prerequisites

Before you start, decide:

1. **SQL or non-SQL?**
   - SQL databases → extend `SQLBaseProvider` (you get LIMIT injection, identifier escaping, placeholder generation for free)
   - Non-SQL databases → extend `BaseDatabaseProvider` directly (like MongoDB)

2. **Query language?**
   - `'sql'` → Monaco editor uses SQL mode with autocomplete
   - `'json'` → Monaco editor uses JSON mode with MQL-style autocomplete

3. **Which npm driver?** (e.g., `pg`, `mysql2`, `mongodb`, `redis`, `better-sqlite3`)

## Step 1: Register the Database Type

### 1.1 — Add to `DatabaseType` union

**File:** `src/lib/types.ts`

```typescript
// Before:
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql';

// After (example: adding CockroachDB):
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'cockroachdb';
```

> **Note:** `redis` is already in the union but not yet implemented. If you're implementing Redis, skip this step.

### 1.2 — Add to `QueryTab.type` if needed

**File:** `src/lib/types.ts`

If your database uses a new editor mode (not `'sql'` or `'mongodb'`), add it:

```typescript
export interface QueryTab {
  // ...
  type: 'sql' | 'mongodb' | 'redis';  // Add your type here if needed
}
```

For most SQL databases, the existing `'sql'` type is sufficient. You only need a new tab type if your database uses a fundamentally different query language.

## Step 2: Create the Provider Class

Create the file under the right family folder, named by the canonical **type-id** —
`src/lib/db/providers/sql/<type-id>.ts` for SQL, `src/lib/db/providers/<family>/<type-id>.ts`
(e.g. `document/`, `keyvalue/`) for non-SQL.

**Start from the closest existing provider — it is the authoritative, code-verified template** (and
is kept in sync with its per-provider doc). Don't copy a skeleton from this guide; copy a real file:

| Your database is… | Extend | Copy as template | Reference |
|-------------------|--------|------------------|-----------|
| Pooled SQL (wire-protocol DB) | `SQLBaseProvider` | `postgres.ts` / `mysql.ts` | [postgres.md](./providers/postgres.md) · [mysql.md](./providers/mysql.md) |
| Embedded / file SQL | `SQLBaseProvider` | `sqlite.ts` | [sqlite.md](./providers/sqlite.md) |
| Document store | `BaseDatabaseProvider` | `mongodb.ts` | [mongodb.md](./providers/mongodb.md) |
| Key-value store | `BaseDatabaseProvider` | `redis.ts` | [redis.md](./providers/redis.md) |
| Embedded (in-process, no wire protocol) | `BaseDatabaseProvider` | `embedded/libredb.ts` | [libredb.md](./providers/libredb.md) |

**Implement the abstract methods** from the `DatabaseProvider` interface: `connect`, `disconnect`,
`query`, `getSchema`, `getHealth`, `runMaintenance`, plus the monitoring set (`getOverview`,
`getPerformanceMetrics`, `getSlowQueries`, `getActiveSessions`, `getTableStats`, `getIndexStats`,
`getStorageStats`). Return `[]` from the monitoring methods that don't apply to your engine.

**Override the metadata hooks** so the shared UI renders correctly:

- `getCapabilities()` — query language (`sql` | `json`), `defaultPort`, supported `maintenanceOperations`, the `supportsExplain`/`supportsConnectionString`/`supportsCreateTable` flags, and `schemaRefreshPattern`.
- `getLabels()` — only if the generic SQL wording ("Table" / "row" / "Select Top 50" / …) doesn't fit. Non-relational providers relabel it (Redis → "Key Pattern"/"key", MongoDB → "Collection"/"document").
- `prepareQuery()` — only if your dialect needs non-standard pagination. SQL `LIMIT` injection is inherited from `SQLBaseProvider`; Oracle/SQL Server override it for `FETCH FIRST` / `TOP`; the non-SQL providers make it a metadata-only pass-through.

Wrap native driver errors with `mapDatabaseError(err, '<type-id>', query)` — the 3rd argument is the
raw query string (SQL **or** JSON, per `src/lib/db/errors.ts`) — so they normalise onto the shared
error classes. For the exact DTO shapes see [Reference: Interface Contracts](#reference-interface-contracts);
for worked, code-verified examples see each provider's **Design decisions** section in
[`docs/providers/`](./providers/README.md).


### What the base class gives you for free

| Method | What it does |
|--------|-------------|
| `isConnected()` | Returns `this.state.connected` |
| `getTables()` | Calls `getSchema()` and extracts table names |
| `getMonitoringData()` | Orchestrates `getOverview`, `getPerformanceMetrics`, etc. |
| `validate()` | Checks that `config.type` and `config.id` exist |
| `ensureConnected()` | Throws if not connected |
| `trackQuery()` | Increments/decrements active query counter |
| `measureExecution()` | Wraps a function and returns `{ result, executionTime }` |
| `mapError()` | Converts unknown errors to typed `DatabaseError` |
| `setConnected()` | Updates connection state |

### What SQLBaseProvider adds (SQL databases only)

| Method | What it does |
|--------|-------------|
| `escapeIdentifier()` | `"table_name"` (PostgreSQL/SQLite) or `` `table_name` `` (MySQL) |
| `buildLimitClause()` | `LIMIT 50 OFFSET 10` |
| `getPlaceholder()` | `$1` (PostgreSQL) or `?` (MySQL/SQLite) |
| `shouldEnableSSL()` | Auto-detects cloud providers |
| `prepareQuery()` | Automatically injects LIMIT into SELECT queries |

## Step 3: Register in the Factory

**File:** `src/lib/db/factory.ts`

Add a `case` to the `switch` statement:

```typescript
export async function createDatabaseProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {}
): Promise<DatabaseProvider> {
  switch (connection.type) {
    // ... existing cases ...

    case 'cockroachdb': {
      const { CockroachDBProvider } = await import('./providers/sql/cockroachdb');
      return new CockroachDBProvider(connection, options);
    }

    // ...
  }
}
```

> **Important:** Use dynamic `import()` to keep the initial bundle small.

## Step 4: Add UI Configuration

**File:** `src/lib/db-ui-config.ts`

Add an entry to `DB_UI_CONFIG`:

```typescript
import { /* existing imports */, Hexagon } from 'lucide-react';

const DB_UI_CONFIG: Record<DatabaseType, DatabaseUIConfig> = {
  // ... existing entries ...

  cockroachdb: {
    icon: Hexagon,                          // Pick a Lucide icon
    color: 'text-indigo-400',               // Tailwind color class
    label: 'CockroachDB',                   // Display name in ConnectionModal
    defaultPort: '26257',                   // Default port for host/port form
    showConnectionStringToggle: true,        // Show "Connection String" tab in modal
    connectionFields: ['host', 'port', 'user', 'password', 'database', 'connectionString'],
  },
};
```

Then add the type to the selectable list in `ConnectionModal.tsx`:

**File:** `src/components/ConnectionModal.tsx`

```typescript
const selectableTypes: DatabaseType[] = [
  'postgres', 'mysql', 'cockroachdb', 'mongodb', 'redis'
];
```

That's it. The ConnectionModal reads `getDBConfig(type)` for everything else — port, form fields, connection string toggle — automatically.

## Step 5: Install the Driver

```bash
bun add <driver-package>

# Examples:
# bun add pg                  (PostgreSQL, CockroachDB)
# bun add mysql2              (MySQL)
# bun add mongodb             (MongoDB)
# bun add ioredis             (Redis)
# bun add better-sqlite3      (SQLite)
```

## Step 6: Verify

### Build & Lint

```bash
bun run build    # Must pass with 0 errors
bun run lint     # Must pass with 0 new warnings
```

### Grep Check

Ensure you didn't introduce hardcoded type checks outside your provider:

```bash
# Should only appear in YOUR provider file and db-ui-config.ts:
grep -r "=== 'cockroachdb'" src/
```

If it appears in routes, components, or utilities — you're doing it wrong. Use capabilities/labels instead.

### Functional Checklist

| Feature | How to test |
|---------|-------------|
| Connection | Create connection in ConnectionModal, verify it connects |
| Schema | Sidebar shows tables/collections with columns and indexes |
| Query execution | Write a query, press Ctrl+Enter, verify results |
| EXPLAIN | If `supportsExplain: true`, verify EXPLAIN button works |
| Create Table | If `supportsCreateTable: true`, verify the + button appears |
| Maintenance | Open Database Maintenance, verify correct operations show |
| AI Assistant | Open AI in QueryEditor, ask a question, verify correct syntax |
| Labels | Check all UI text uses your labels (entity names, actions, etc.) |
| Schema refresh | Run a write query, verify schema reloads if it matches `schemaRefreshPattern` |

## Reference: Interface Contracts

### ProviderCapabilities

Every field and what it controls:

| Field | Type | Controls |
|-------|------|----------|
| `queryLanguage` | `'sql' \| 'json'` | Monaco editor language mode, AI prompt style, query template format |
| `supportsExplain` | `boolean` | EXPLAIN button visibility in QueryEditor toolbar |
| `supportsExternalQueryLimiting` | `boolean` | Whether route applies LIMIT to queries (SQL) or provider handles it (MongoDB) |
| `supportsCreateTable` | `boolean` | "Create Table" button in SchemaExplorer |
| `supportsMaintenance` | `boolean` | Whether maintenance API accepts requests for this provider |
| `maintenanceOperations` | `MaintenanceType[]` | Which operation cards show in MaintenanceModal (vacuum, analyze, reindex, etc.) |
| `supportsConnectionString` | `boolean` | Used for future connection validation logic |
| `defaultPort` | `number \| null` | Informational; actual UI port comes from `db-ui-config.ts` |
| `schemaRefreshPattern` | `string` | Regex to detect write/DDL queries that should trigger schema reload |

### ProviderLabels

Every field and where it appears:

| Field | Where it appears |
|-------|-----------------|
| `entityName` | "Create {Table}" button title, "{Table} name copied", "{Table} Optimizer" |
| `entityNamePlural` | "{Tables} found" count in MaintenanceModal |
| `rowName` / `rowNamePlural` | "{rows}" count in MaintenanceModal table list |
| `selectAction` | SchemaExplorer dropdown: "Select Top 100" / "Find Documents" |
| `generateAction` | SchemaExplorer dropdown: "Generate Query" / "Generate Find" |
| `analyzeAction` | SchemaExplorer dropdown + MaintenanceModal button title |
| `vacuumAction` | SchemaExplorer dropdown + MaintenanceModal button title |
| `searchPlaceholder` | SchemaExplorer search input placeholder text |
| `analyzeGlobalLabel` | MaintenanceModal "Run Analyze" button text |
| `analyzeGlobalTitle` | MaintenanceModal card title ("Update Statistics") |
| `analyzeGlobalDesc` | MaintenanceModal card description paragraph |
| `vacuumGlobalLabel` | MaintenanceModal "Run Vacuum" button text |
| `vacuumGlobalTitle` | MaintenanceModal card title ("Reclaim Space") |
| `vacuumGlobalDesc` | MaintenanceModal card description paragraph |

### PreparedQuery

Returned by `prepareQuery()`. The query route uses it directly:

```typescript
// In /api/db/query/route.ts — no type checks needed:
const provider = await getOrCreateProvider(connection);
const prepared = provider.prepareQuery(sql, { limit, offset, unlimited });
const result = await provider.query(prepared.query);
```

| Field | Purpose |
|-------|---------|
| `query` | The (possibly modified) query string to execute |
| `wasLimited` | Whether a LIMIT was injected (shown as warning badge in UI) |
| `limit` | The effective row limit |
| `offset` | The effective offset |

## Reference: Existing Providers

For the authoritative, code-verified reference for each shipped provider (extends-which-base,
driver, pooling, capabilities, labels, `prepareQuery` behaviour, and limitations), see the prime
docs — they are the single source of truth and are kept in sync with the code:

**[docs/providers/](./providers/README.md)** → postgres · mysql · oracle · mssql · sqlite · redis · mongodb

When implementing a new provider, the closest existing analogue is the best template: a pooled SQL
provider (postgres/mysql), an embedded SQL provider (sqlite), or a non-SQL provider
(mongodb/redis).

## Quick Reference Checklist

When adding a new database, ensure you've touched **exactly these files**:

- [ ] `src/lib/types.ts` — Add to `DatabaseType` union (if not already there)
- [ ] `src/lib/db/providers/<category>/<name>.ts` — **New file:** provider class
- [ ] `src/lib/db/factory.ts` — Add `case` with dynamic import
- [ ] `src/lib/db-ui-config.ts` — Add UI config entry
- [ ] `src/components/ConnectionModal.tsx` — Add to `selectableTypes` array
- [ ] `package.json` — Install driver (`bun add <driver>`)

**No other files should need changes.** If you find yourself editing routes, components, or utilities — you're likely bypassing the abstraction. Use `getCapabilities()` and `getLabels()` instead.
