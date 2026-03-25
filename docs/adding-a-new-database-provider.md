# Adding a New Database Provider to LibreDB Studio

This guide walks you through every step of adding a new database type to LibreDB Studio. The architecture follows the **Strategy Pattern** — each database type is a self-contained provider class. Adding a new one requires **no changes** to routes, components, or existing providers.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Step 1: Register the Database Type](#step-1-register-the-database-type)
4. [Step 2: Create the Provider Class](#step-2-create-the-provider-class)
5. [Step 3: Register in the Factory](#step-3-register-in-the-factory)
6. [Step 4: Add UI Configuration](#step-4-add-ui-configuration)
7. [Step 5: Install the Driver](#step-5-install-the-driver)
8. [Step 6: Verify](#step-6-verify)
9. [Reference: Interface Contracts](#reference-interface-contracts)
10. [Reference: Existing Providers](#reference-existing-providers)

---

## 1. Architecture Overview

```
DatabaseProvider (interface)
  └── BaseDatabaseProvider (abstract — shared logic)
        ├── SQLBaseProvider (abstract — SQL-specific: LIMIT, escaping, placeholders)
        │     ├── PostgresProvider
        │     ├── MySQLProvider
        │     └── SQLiteProvider
        ├── MongoDBProvider (document-based, extends BaseDatabaseProvider directly)
```

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

---

## 2. Prerequisites

Before you start, decide:

1. **SQL or non-SQL?**
   - SQL databases → extend `SQLBaseProvider` (you get LIMIT injection, identifier escaping, placeholder generation for free)
   - Non-SQL databases → extend `BaseDatabaseProvider` directly (like MongoDB)

2. **Query language?**
   - `'sql'` → Monaco editor uses SQL mode with autocomplete
   - `'json'` → Monaco editor uses JSON mode with MQL-style autocomplete

3. **Which npm driver?** (e.g., `pg`, `mysql2`, `mongodb`, `redis`, `better-sqlite3`)

---

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

---

## Step 2: Create the Provider Class

### For SQL databases

Create a file under `src/lib/db/providers/sql/`:

```
src/lib/db/providers/sql/cockroachdb.ts
```

```typescript
/**
 * CockroachDB Database Provider
 * PostgreSQL-compatible distributed SQL database
 */

import { Pool } from 'pg'; // CockroachDB uses the PostgreSQL wire protocol
import { SQLBaseProvider } from './sql-base';
import {
  type DatabaseConnection,
  type TableSchema,
  type ColumnSchema,
  type IndexSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';

export class CockroachDBProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ──────────────────────────────────────────────
  // Provider Metadata (REQUIRED OVERRIDES)
  // ──────────────────────────────────────────────

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),           // Inherits SQL defaults
      defaultPort: 26257,                    // CockroachDB default port
      supportsExplain: true,                 // Supports EXPLAIN
      supportsConnectionString: true,        // Supports connection URI
      maintenanceOperations: ['analyze'],     // Only ANALYZE supported
    };
  }

  // getLabels() — SQL defaults from BaseDatabaseProvider are fine
  //   entityName: 'Table', selectAction: 'Select Top 100', etc.
  //   Override only if you need different labels.

  // prepareQuery() — SQLBaseProvider handles LIMIT injection automatically
  //   Override only if your SQL dialect has a different LIMIT syntax.

  // ──────────────────────────────────────────────
  // Connection Management (REQUIRED)
  // ──────────────────────────────────────────────

  public async connect(): Promise<void> {
    try {
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port || 26257,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        max: this.poolConfig.max,
        idleTimeoutMillis: this.poolConfig.idleTimeout,
        connectionTimeoutMillis: this.poolConfig.acquireTimeout,
        ssl: this.shouldEnableSSL() ? { rejectUnauthorized: false } : undefined,
      });

      // Test connection
      const client = await this.pool.connect();
      client.release();
      this.setConnected(true);
    } catch (error) {
      this.setError(error as Error);
      throw new ConnectionError(
        `Failed to connect to CockroachDB: ${(error as Error).message}`,
        'cockroachdb'
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.setConnected(false);
  }

  // ──────────────────────────────────────────────
  // Query Execution (REQUIRED)
  // ──────────────────────────────────────────────

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();
    if (!this.pool) throw new ConnectionError('Pool not initialized', 'cockroachdb');

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        return this.pool!.query(sql, params);
      });

      return {
        rows: result.rows || [],
        fields: result.fields?.map(f => f.name) || [],
        rowCount: result.rows?.length || 0,
        executionTime,
      };
    });
  }

  // ──────────────────────────────────────────────
  // Schema Introspection (REQUIRED)
  // ──────────────────────────────────────────────

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();
    // Use information_schema (same as PostgreSQL)
    const tablesResult = await this.query(`
      SELECT table_name, ...
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    // ... build TableSchema[] from results
    return [];
  }

  // ──────────────────────────────────────────────
  // Health & Monitoring (REQUIRED)
  // ──────────────────────────────────────────────

  public async getHealth(): Promise<HealthInfo> { /* ... */ }
  public async getOverview(): Promise<DatabaseOverview> { /* ... */ }
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> { /* ... */ }
  public async getSlowQueries(): Promise<SlowQueryStats[]> { /* ... */ }
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> { /* ... */ }
  public async getTableStats(): Promise<TableStats[]> { /* ... */ }
  public async getIndexStats(): Promise<IndexStats[]> { /* ... */ }
  public async getStorageStats(): Promise<StorageStats[]> { /* ... */ }

  // ──────────────────────────────────────────────
  // Maintenance (REQUIRED)
  // ──────────────────────────────────────────────

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();
    const { result, executionTime } = await this.measureExecution(async () => {
      switch (type) {
        case 'analyze':
          if (target) {
            await this.query(`ANALYZE ${this.escapeIdentifier(target)}`);
          } else {
            // CockroachDB doesn't have a global ANALYZE; iterate tables
          }
          return { success: true };
        default:
          throw new QueryError(`Unsupported maintenance operation: ${type}`, 'cockroachdb');
      }
    });
    return {
      success: true,
      executionTime,
      message: `${type} completed successfully`,
    };
  }

  // ──────────────────────────────────────────────
  // Validation
  // ──────────────────────────────────────────────

  public override validate(): void {
    super.validate();
    if (!this.config.connectionString && !this.config.host) {
      throw new DatabaseConfigError('Host or connection string is required', 'cockroachdb');
    }
    if (!this.config.database && !this.config.connectionString) {
      throw new DatabaseConfigError('Database name is required', 'cockroachdb');
    }
  }
}
```

### For non-SQL databases

Create a file under `src/lib/db/providers/` (choose an appropriate subdirectory):

```
src/lib/db/providers/keyvalue/redis.ts
```

Extend `BaseDatabaseProvider` directly and override **all** abstract methods plus the 3 metadata methods:

```typescript
import { BaseDatabaseProvider } from '../../base-provider';

export class RedisProvider extends BaseDatabaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // Must override getCapabilities() — defaults are SQL-oriented
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: 'json',              // or 'sql' if Redis uses a custom CLI-like syntax
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsMaintenance: true,
      maintenanceOperations: ['analyze'],
      supportsConnectionString: true,
      defaultPort: 6379,
      schemaRefreshPattern: '"operation"\\s*:\\s*"(set|del|hset)',
    };
  }

  // Must override getLabels()
  public override getLabels(): ProviderLabels {
    return {
      entityName: 'Key Space',
      entityNamePlural: 'Key Spaces',
      rowName: 'key',
      rowNamePlural: 'keys',
      selectAction: 'Scan Keys',
      generateAction: 'Generate Command',
      analyzeAction: 'Inspect Key',
      vacuumAction: 'Flush Keys',
      searchPlaceholder: 'Search key spaces...',
      analyzeGlobalLabel: 'Run Info',
      analyzeGlobalTitle: 'Server Info',
      analyzeGlobalDesc: 'Retrieves Redis server statistics and memory usage.',
      vacuumGlobalLabel: 'Run Memory Doctor',
      vacuumGlobalTitle: 'Memory Analysis',
      vacuumGlobalDesc: 'Analyzes memory usage patterns and suggests optimizations.',
    };
  }

  // Must override prepareQuery()
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    return { query, wasLimited: false, limit: options.limit || 100, offset: 0 };
  }

  // ... implement all abstract methods: connect, disconnect, query, getSchema, etc.
}
```

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

---

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

---

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

---

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

---

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

---

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

---

## Reference: Existing Providers

### PostgresProvider (`src/lib/db/providers/sql/postgres.ts`)

- Extends: `SQLBaseProvider`
- Driver: `pg` (node-postgres)
- Connection pooling: `pg.Pool`
- Capabilities: `sql`, explain: yes, port: 5432, maintenance: vacuum/analyze/reindex/kill
- Labels: defaults (Table, row, Select Top 100, etc.)
- `prepareQuery`: inherited from SQLBaseProvider (auto LIMIT injection)

### MySQLProvider (`src/lib/db/providers/sql/mysql.ts`)

- Extends: `SQLBaseProvider`
- Driver: `mysql2/promise`
- Connection pooling: `mysql2.createPool`
- Capabilities: `sql`, explain: yes, port: 3306, maintenance: analyze/optimize/check/kill
- Labels: defaults
- `prepareQuery`: inherited from SQLBaseProvider

### SQLiteProvider (`src/lib/db/providers/sql/sqlite.ts`)

- Extends: `SQLBaseProvider`
- Driver: `better-sqlite3`
- No connection pooling (file-based)
- Capabilities: `sql`, explain: no, port: null, maintenance: vacuum/analyze/reindex/check
- Labels: defaults
- `prepareQuery`: inherited from SQLBaseProvider

### MongoDBProvider (`src/lib/db/providers/document/mongodb.ts`)

- Extends: `BaseDatabaseProvider` (NOT SQLBaseProvider)
- Driver: `mongodb`
- Connection: `MongoClient`
- Capabilities: `json`, explain: no, createTable: no, port: 27017, maintenance: vacuum/analyze/check
- Labels: fully custom (Collection, document, Find Documents, etc.)
- `prepareQuery`: pass-through (MongoDB handles its own limiting)
- Query format: JSON `{ collection, operation, filter, options }`

---

## Quick Reference Checklist

When adding a new database, ensure you've touched **exactly these files**:

- [ ] `src/lib/types.ts` — Add to `DatabaseType` union (if not already there)
- [ ] `src/lib/db/providers/<category>/<name>.ts` — **New file:** provider class
- [ ] `src/lib/db/factory.ts` — Add `case` with dynamic import
- [ ] `src/lib/db-ui-config.ts` — Add UI config entry
- [ ] `src/components/ConnectionModal.tsx` — Add to `selectableTypes` array
- [ ] `package.json` — Install driver (`bun add <driver>`)

**No other files should need changes.** If you find yourself editing routes, components, or utilities — you're likely bypassing the abstraction. Use `getCapabilities()` and `getLabels()` instead.
