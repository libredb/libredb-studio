# LibreDB Studio - Platform Architecture

> **Status:** Backlog  
> **Date:** 2025-12-25  
> **Priority:** High

---

## 1. Operating Modes

The system can operate in **two modes**. It works flawlessly in both scenarios:

### 1.1 Browser-Only Mode (Default)

```
┌─────────────────────────────────────────┐
│  PGlite (WASM PostgreSQL)               │
│         │                               │
│         ▼                               │
│  IndexedDB (browser)                    │
│                                         │
│  ✅ No external DB required             │
│  ✅ Zero-config, works immediately      │
│  ✅ Single browser usage                │
└─────────────────────────────────────────┘
```

- Platform data stays **only in the browser**
- No external database **required**
- No installation or configuration **needed**
- Data is **lost** if browser is cleared

### 1.2 Database Sync Mode (Optional)

```
┌─────────────────────────────────────────┐
│  PGlite (WASM PostgreSQL)               │
│         │                               │
│         ▼                               │
│  IndexedDB (browser)                    │
│         │                               │
│         ▼ (sync enabled)                │
│  ElectricSQL ──▶ External PostgreSQL    │
│                                         │
│  ✅ Data in both browser and DB         │
│  ✅ Access from multiple devices        │
│  ✅ Recoverable even if browser cleared │
└─────────────────────────────────────────┘
```

- Platform data is stored **first in browser**, then **synced to external DB**
- User enables it if desired, **not mandatory**
- **Continues to work** offline
- Data is **persistent** and **shareable**

### 1.3 Mode Selection

| Parameter | Value | Behavior |
|-----------|-------|----------|
| `SYNC_MODE` or UI setting | `browser` (default) | Browser only |
| `SYNC_MODE` or UI setting | `database` | Browser + sync |

```typescript
// Example usage
if (syncConfig.enabled && syncConfig.databaseUrl) {
  await startSync(); // Start sync to external DB
}
// else: PGlite only, no errors
```

---

## 2. Requirements Analysis

### 2.1 Core Requirements

| # | Requirement | Description |
|---|-------------|-------------|
| 1 | **User/Role Management** | Create users, assign roles (admin, user, viewer) |
| 2 | **Query Logging** | User-based query history (query, row count, execution time, status) |
| 3 | **Saved Queries** | Allow users to save and edit their queries |
| 4 | **Account Management** | Profile, preferences, account settings |
| 5 | **Platform Structure** | Future collaborative workspace and sharing features |

### 2.2 Technical Requirements

| Requirement | Description |
|-------------|-------------|
| Zero-config startup | Must work without any installation |
| Database necessity | Persistent storage needed for users, query logs, saved queries |
| Optional persistence | Users who want can sync their data to external DB |
| Minimal complexity | Should not significantly change existing architecture |

### 2.3 Current Problems

- LocalStorage 5-10MB limit
- No user-based separation
- No cross-device data sharing
- Data loss when browser is cleared

---

## 3. Solution: PGlite + ElectricSQL

### 3.1 Vision

```
Default:   PGlite in browser (WASM PostgreSQL) → Persistent in IndexedDB
Optional:  If user wants → Sync to external PostgreSQL (ElectricSQL)
```

### 3.2 Why This Solution?

| Alternative | Problem |
|-------------|---------|
| LocalStorage | 5-10MB limit, no SQL |
| IndexedDB (raw) | NoSQL, complex queries are difficult |
| Mandatory External DB | No zero-config, requires installation |
| **PGlite** | ✅ Real PostgreSQL, 100GB+ limit, zero-config |

### 3.3 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│                                                              │
│   React Components                                           │
│         │                                                    │
│         ▼                                                    │
│   storage.ts (API unchanged)                                 │
│         │                                                    │
│         ▼                                                    │
│   PGlite (WASM PostgreSQL)                                   │
│         │                                                    │
│         ▼                                                    │
│   IndexedDB (100GB+ limit)                                   │
│         │                                                    │
│         ▼ (optional)                                         │
│   ElectricSQL Sync ──────────▶ External PostgreSQL           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Important:** The existing `storage.ts` API is preserved, only the backend changes.

---

## 4. Database Schema

### 4.1 Tables

```sql
-- Users
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',  -- admin, user, viewer
    preferences JSONB DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Connections (passwords excluded - stay in localStorage)
CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL,  -- postgres, mysql, sqlite, mongodb, demo
    host TEXT,
    port INTEGER,
    database_name TEXT,
    username TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Query History
CREATE TABLE query_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    connection_id TEXT,
    connection_name TEXT,
    tab_name TEXT,
    query TEXT NOT NULL,
    row_count INTEGER,
    execution_time_ms INTEGER,
    status TEXT NOT NULL,  -- success, error
    error_message TEXT,
    executed_at TEXT DEFAULT (datetime('now'))
);

-- Saved Queries
CREATE TABLE saved_queries (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    query TEXT NOT NULL,
    connection_type TEXT,
    tags TEXT,  -- JSON array as text
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Sync Config (optional)
CREATE TABLE sync_config (
    id TEXT PRIMARY KEY,
    sync_enabled INTEGER DEFAULT 0,
    sync_url TEXT,
    last_sync_at TEXT
);
```

---

## 5. Implementation Plan

### 5.1 File Structure (Minimal)

```
src/lib/
├── storage.ts           # Existing API preserved, PGlite backend
├── pglite/
│   ├── client.ts        # PGlite singleton
│   ├── migrations.ts    # Schema migrations
│   └── sync.ts          # ElectricSQL integration (Phase 2)
└── crypto/
    └── vault.ts         # Password encryption (localStorage)
```

### 5.2 Phase 1: PGlite Integration (1 week)

**Goal:** LocalStorage → PGlite migration

| Task | Description |
|------|-------------|
| PGlite client | Singleton instance, lazy loading |
| Migrations | Initial schema, version tracking |
| storage.ts refactor | Same API, PGlite backend |
| Data migration | Migrate existing localStorage data to PGlite |

**storage.ts change:**

```typescript
// BEFORE
export const storage = {
  getHistory: () => {
    const stored = localStorage.getItem(HISTORY_KEY);
    return JSON.parse(stored);
  }
};

// AFTER
export const storage = {
  getHistory: async () => {
    const db = await getPGlite();
    const result = await db.query('SELECT * FROM query_logs ORDER BY executed_at DESC');
    return result.rows;
  }
};
```

### 5.3 Phase 2: User Management (1 week)

**Goal:** Real user system

| Task | Description |
|------|-------------|
| User CRUD | Create, read, update users |
| Auth integration | Connect with existing JWT system |
| Role-based queries | User-based data filtering |
| Settings UI | User preferences page |

### 5.4 Phase 3: ElectricSQL Sync (1 week)

**Goal:** Optional external sync

| Task | Description |
|------|-------------|
| Electric client | Sync client setup |
| Sync UI | Connection form, status indicator |
| Conflict handling | Last-write-wins |

---

## 6. API Compatibility

**Existing API is preserved, only becomes async:**

```typescript
// Current usage (Dashboard.tsx)
storage.addToHistory(item);
const history = storage.getHistory();

// New usage (minimal change)
await storage.addToHistory(item);
const history = await storage.getHistory();
```

**Dashboard.tsx changes are minimal:**
- `storage.xxx()` → `await storage.xxx()`
- Async wrapper inside useEffect

---

## 7. Security

| Data | Storage | Sync |
|------|---------|------|
| Passwords | localStorage (encrypted) | ❌ Never |
| User information | PGlite | ✅ Optional |
| Query history | PGlite | ✅ Optional |
| Saved queries | PGlite | ✅ Optional |

---

## 8. Dependencies

```json
{
  "@electric-sql/pglite": "^0.2.x"
}
```

**Note:** ElectricSQL sync client will be added in Phase 3.

---

## 9. Timeline

| Phase | Duration | Output |
|-------|----------|--------|
| Phase 1: PGlite | 5-7 days | LocalStorage → PGlite migration |
| Phase 2: Users | 5-7 days | User management |
| Phase 3: Sync | 5-7 days | Optional external sync |

**Total:** ~3 weeks

---

## 10. Summary

```
Requirement                →  Solution
─────────────────────────────────────────────────
User/Role Management       →  users table + role column
Query Logging              →  query_logs table
Saved Queries              →  saved_queries table
Account Management         →  users.preferences JSONB
Platform (future)          →  ElectricSQL sync
Zero-config                →  PGlite (in-browser)
Optional persistence       →  ElectricSQL → External PostgreSQL
```

---

## 11. References

- [PGlite](https://pglite.dev/) - In-browser PostgreSQL
- [ElectricSQL](https://electric-sql.com/) - Postgres sync
