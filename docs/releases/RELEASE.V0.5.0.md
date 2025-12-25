# Release v0.5.0 - Database Provider Architecture & MongoDB Support

**Release Date:** December 2024

This release introduces a major architectural refactoring of the database provider system using the Strategy Pattern, along with full MongoDB support.

---

## Highlights

- **New Architecture:** Modular, extensible database provider system
- **MongoDB Support:** Full document database support with JSON-based queries
- **SQLBaseProvider:** Shared utilities for SQL databases
- **Improved Maintainability:** Clear separation of concerns by database category

---

## New Features

### MongoDB Support

Full MongoDB integration with the official `mongodb` driver:

```typescript
const connection = {
  id: 'my-mongo',
  name: 'MongoDB Atlas',
  type: 'mongodb',
  connectionString: 'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
  createdAt: new Date(),
};

const provider = await getOrCreateProvider(connection);
const result = await provider.query(JSON.stringify({
  collection: 'users',
  operation: 'find',
  filter: { status: 'active' },
  options: { limit: 50 }
}));
```

**Supported Operations:**
- `find`, `findOne` - Query documents
- `aggregate` - Aggregation pipelines
- `count`, `distinct` - Count and distinct queries
- `insertOne`, `insertMany` - Insert documents
- `updateOne`, `updateMany` - Update documents
- `deleteOne`, `deleteMany` - Delete documents

**MongoDB Features:**
- Connection pooling
- Automatic schema inference from documents
- Index listing
- Health monitoring with profiler integration
- Maintenance operations (compact, validate, reIndex)

---

## Architecture Changes

### New Directory Structure

```
src/lib/db/
├── index.ts                    # Public exports
├── types.ts                    # Interfaces & Types
├── errors.ts                   # Custom error classes
├── factory.ts                  # Provider Factory
├── base-provider.ts            # Abstract base class
├── providers/
│   ├── sql/                    # SQL Database Providers
│   │   ├── index.ts
│   │   ├── sql-base.ts         # SQL-specific base class (NEW)
│   │   ├── postgres.ts
│   │   ├── mysql.ts
│   │   └── sqlite.ts
│   ├── document/               # Document Database Providers (NEW)
│   │   ├── index.ts
│   │   └── mongodb.ts          # MongoDB Provider (NEW)
│   └── demo.ts
└── utils/
    └── pool-manager.ts
```

### Provider Hierarchy

```
BaseDatabaseProvider (abstract)
├── SQLBaseProvider (abstract) ─────────────┐
│   ├── PostgresProvider                    │ SQL Databases
│   ├── MySQLProvider                       │ (shared utilities)
│   └── SQLiteProvider                      │
├── MongoDBProvider ────────────────────────┤ Document Databases
└── DemoProvider ───────────────────────────┘ Mock/Testing
```

### SQLBaseProvider

New abstract class with SQL-specific shared utilities:

```typescript
abstract class SQLBaseProvider extends BaseDatabaseProvider {
  // SQL-specific utilities
  protected escapeIdentifier(identifier: string): string;
  protected escapeString(value: string): string;
  protected buildLimitClause(limit: number, offset?: number): string;
  protected getPlaceholder(index: number): string;
  protected shouldEnableSSL(): boolean;
  protected isReadOnlyQuery(sql: string): boolean;
  protected isSchemaModifyingQuery(sql: string): boolean;
}
```

---

## Supported Databases

| Category | Database   | Status | Driver           | Pooling |
|----------|------------|--------|------------------|---------|
| SQL      | PostgreSQL | Full   | `pg`             | Yes     |
| SQL      | MySQL      | Full   | `mysql2`         | Yes     |
| SQL      | SQLite     | Full   | `better-sqlite3` | No      |
| Document | MongoDB    | Full   | `mongodb`        | Yes     |
| Other    | Demo       | Full   | Mock data        | N/A     |

---

## Breaking Changes

None. All existing APIs remain compatible.

---

## Bug Fixes

- Fixed `idx.columns.join is not a function` error in SchemaExplorer when PostgreSQL returns null for empty index columns
- Fixed `col.primaryKey` property name to `col.isPrimary` in SchemaDiagram component

---

## Dependencies

### Added
- `mongodb@7.0.0` - Official MongoDB driver

### Existing
- `pg` - PostgreSQL driver
- `mysql2` - MySQL driver
- `better-sqlite3` - SQLite driver

---

## Documentation

- Updated `docs/DATABASE_PROVIDERS.md` with:
  - New architecture diagram
  - MongoDB query format and examples
  - Guide for adding new providers
  - Provider-specific features

---

## Migration Guide

### For Users

No migration required. Existing connections continue to work.

### For Developers

If you have custom code extending database providers:

```typescript
// Before (v0.4.x)
import { PostgresProvider } from '@/lib/db/providers/postgres';

// After (v0.5.0)
import { PostgresProvider } from '@/lib/db/providers/sql/postgres';
// or
import { PostgresProvider } from '@/lib/db';
```

---

## Adding New Providers

### SQL Database (e.g., Oracle)

```typescript
// src/lib/db/providers/sql/oracle.ts
import { SQLBaseProvider } from './sql-base';

export class OracleProvider extends SQLBaseProvider {
  // Inherit SQL utilities, implement abstract methods
}
```

### Document Database (e.g., Couchbase)

```typescript
// src/lib/db/providers/document/couchbase.ts
import { BaseDatabaseProvider } from '../../base-provider';

export class CouchbaseProvider extends BaseDatabaseProvider {
  // Implement all abstract methods
}
```

---

## What's Next

### v0.6.0 (Planned)
- MongoDB UI improvements (JSON editor, collection explorer)
- Redis support (Key-Value category)
- Query builder for MongoDB

---

## Contributors

- Database architecture refactoring
- MongoDB provider implementation
- Documentation updates

---

## Full Changelog

### Added
- `SQLBaseProvider` abstract class for SQL databases
- `MongoDBProvider` for document database support
- `providers/sql/` directory for SQL providers
- `providers/document/` directory for document providers
- MongoDB query parsing and execution
- MongoDB schema inference from documents
- MongoDB health monitoring
- MongoDB maintenance operations

### Changed
- Moved PostgreSQL provider to `providers/sql/postgres.ts`
- Moved MySQL provider to `providers/sql/mysql.ts`
- Moved SQLite provider to `providers/sql/sqlite.ts`
- Updated factory to use new provider locations
- Updated index exports for new structure

### Fixed
- `idx.columns.join is not a function` in SchemaExplorer
- `col.primaryKey` → `col.isPrimary` in SchemaDiagram

### Removed
- Old provider files from `providers/` root (moved to `providers/sql/`)
