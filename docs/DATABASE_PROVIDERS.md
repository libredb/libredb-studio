# Database Provider Architecture

This document describes the modular database provider architecture implemented using the Strategy Pattern.

## Overview

The database abstraction layer (`src/lib/db/`) provides a unified interface for multiple database types while maintaining type safety, connection pooling, and consistent error handling.

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
│   │   ├── index.ts            # SQL exports
│   │   ├── sql-base.ts         # SQL-specific base class
│   │   ├── postgres.ts         # PostgreSQL Strategy
│   │   ├── mysql.ts            # MySQL Strategy
│   │   └── sqlite.ts           # SQLite Strategy
│   ├── document/               # Document Database Providers
│   │   ├── index.ts            # Document exports
│   │   └── mongodb.ts          # MongoDB Strategy
└── utils/
    └── pool-manager.ts         # Connection pool utilities
```

## Provider Hierarchy

```
BaseDatabaseProvider (abstract)
├── SQLBaseProvider (abstract) ─────────────┐
│   ├── PostgresProvider                    │ SQL Databases
│   ├── MySQLProvider                       │ (shared SQL utilities)
│   └── SQLiteProvider                      │
├── MongoDBProvider ────────────────────────┤ Document Databases
```

## Supported Databases

| Category | Database   | Status | Driver           | Pooling | Notes                    |
|----------|------------|--------|------------------|---------|--------------------------|
| SQL      | PostgreSQL | Full   | `pg`             | Yes     | Production ready         |
| SQL      | MySQL      | Full   | `mysql2`         | Yes     | Production ready         |
| SQL      | SQLite     | Full   | `better-sqlite3` | No      | File-based, sync driver  |
| Document | MongoDB    | Full   | `mongodb`        | Yes     | JSON-based queries       |
| SQL      | Oracle     | Full   | `oracledb`       | Yes     | Production ready         |
| SQL      | SQL Server | Full   | `mssql`          | Yes     | Production ready         |

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

## MongoDB Query Format

MongoDB queries are JSON-formatted with the following structure:

```typescript
interface MongoQuery {
  collection: string;  // Required: collection name
  operation: string;   // Required: find, findOne, aggregate, count, distinct,
                       //           insertOne, insertMany, updateOne, updateMany,
                       //           deleteOne, deleteMany
  filter?: object;     // Optional: query filter
  pipeline?: object[]; // Optional: aggregation pipeline
  update?: object;     // Optional: update document
  documents?: object[];// Optional: documents to insert
  options?: {
    limit?: number;
    skip?: number;
    sort?: object;
    projection?: object;
  };
}
```

### MongoDB Query Examples

```json
// Find documents
{"collection": "users", "operation": "find", "filter": {"status": "active"}, "options": {"limit": 50}}

// Find one document
{"collection": "users", "operation": "findOne", "filter": {"_id": "123"}}

// Aggregate
{"collection": "orders", "operation": "aggregate", "pipeline": [
  {"$match": {"status": "completed"}},
  {"$group": {"_id": "$customerId", "total": {"$sum": "$amount"}}}
]}

// Count documents
{"collection": "users", "operation": "count", "filter": {"role": "admin"}}

// Insert one document
{"collection": "users", "operation": "insertOne", "documents": [{"name": "John", "email": "john@example.com"}]}

// Update documents
{"collection": "users", "operation": "updateOne", "filter": {"_id": "123"}, "update": {"$set": {"status": "inactive"}}}

// Delete documents
{"collection": "users", "operation": "deleteMany", "filter": {"status": "deleted"}}
```

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

## Adding New Providers

### Adding a New SQL Database (e.g., Oracle)

1. Create provider class extending `SQLBaseProvider`:

```typescript
// src/lib/db/providers/sql/oracle.ts
import { SQLBaseProvider } from './sql-base';

export class OracleProvider extends SQLBaseProvider {
  public async connect(): Promise<void> { /* ... */ }
  public async disconnect(): Promise<void> { /* ... */ }
  public async query(sql: string): Promise<QueryResult> { /* ... */ }
  public async getSchema(): Promise<TableSchema[]> { /* ... */ }
  public async getHealth(): Promise<HealthInfo> { /* ... */ }
  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> { /* ... */ }
}
```

2. Export from `sql/index.ts`:

```typescript
export { OracleProvider } from './oracle';
```

3. Register in factory:

```typescript
case 'oracle':
  return new OracleProvider(connection, options);
```

4. Update types:

```typescript
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'oracle' | 'mongodb';
```

### Adding a New Document Database (e.g., Couchbase)

1. Create provider class extending `BaseDatabaseProvider`:

```typescript
// src/lib/db/providers/document/couchbase.ts
import { BaseDatabaseProvider } from '../../base-provider';

export class CouchbaseProvider extends BaseDatabaseProvider {
  // Implement all required methods
}
```

2. Export and register in factory.

### Adding a New Database Category (e.g., Key-Value)

1. Create new folder: `src/lib/db/providers/keyvalue/`
2. Optionally create base class if shared logic exists: `keyvalue-base.ts`
3. Create provider: `redis.ts`
4. Follow same registration pattern

## Provider-Specific Features

### PostgreSQL

- Full connection pooling via `pg.Pool`
- SSL auto-detection for cloud providers (Supabase, Render, Neon)
- `pg_stat_statements` integration for slow query monitoring
- VACUUM, ANALYZE, REINDEX maintenance operations

### MySQL

- Connection pooling via `mysql2`
- Performance schema integration
- ANALYZE, OPTIMIZE, CHECK table operations

### SQLite

- Synchronous operations (file-based)
- WAL mode enabled by default
- VACUUM, ANALYZE, INTEGRITY_CHECK support

### MongoDB

- Connection pooling via official MongoDB driver
- JSON-based MQL queries
- Automatic schema inference from documents
- Compact, validate, reIndex maintenance operations
- Profiler integration for slow query monitoring

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
