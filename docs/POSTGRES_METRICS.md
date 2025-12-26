# Database Monitoring Feature - Implementation Plan

## Overview

LibreDB Studio için kapsamlı bir database monitoring ekranı implementasyonu. PostgreSQL öncelikli, tüm kullanıcılara açık, auto-refresh destekli, tab-based UI ile yapılandırılmış.

**Kullanıcı Gereksinimleri:**
- Tüm authenticated kullanıcılar erişebilir (admin + user)
- Database Native query stats (pg_stat_statements, performance_schema)
- PostgreSQL öncelikli (en zengin özellikler)
- Auto-refresh (30 saniye interval)

---

## Phase 1: Type Definitions

### 1.1 Yeni Interface'ler (`src/lib/db/types.ts`)

Mevcut `HealthInfo`, `SlowQuery`, `ActiveSession` interface'lerini koruyarak yeni monitoring type'ları ekle:

```typescript
// Yeni eklenecek interface'ler:

export interface DatabaseOverview {
  version: string;
  uptime: string;
  startTime?: Date;
  activeConnections: number;
  maxConnections: number;
  databaseSize: string;
  databaseSizeBytes: number;
  tableCount: number;
  indexCount: number;
}

export interface PerformanceMetrics {
  cacheHitRatio: number;
  transactionsPerSecond?: number;
  queriesPerSecond?: number;
  bufferPoolUsage?: number;
  deadlocks?: number;
  checkpointWriteTime?: string;
}

export interface SlowQueryStats {
  queryId?: string;
  query: string;
  calls: number;
  totalTime: number;
  avgTime: number;
  minTime?: number;
  maxTime?: number;
  rows: number;
  sharedBlksHit?: number;
  sharedBlksRead?: number;
}

export interface ActiveSessionDetails {
  pid: number | string;
  user: string;
  database: string;
  applicationName?: string;
  clientAddr?: string;
  state: string;
  query: string;
  queryStart?: Date;
  duration: string;
  durationMs: number;
  waitEventType?: string;
  waitEvent?: string;
  blocked?: boolean;
}

export interface TableStats {
  schemaName: string;
  tableName: string;
  rowCount: number;
  liveRowCount?: number;
  deadRowCount?: number;
  tableSize: string;
  tableSizeBytes: number;
  indexSize?: string;
  totalSize: string;
  totalSizeBytes: number;
  lastVacuum?: Date;
  lastAnalyze?: Date;
  bloatRatio?: number;
}

export interface IndexStats {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexType?: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  indexSize: string;
  indexSizeBytes: number;
  scans: number;
  usageRatio?: number;
}

export interface StorageStats {
  name: string;
  location?: string;
  size: string;
  sizeBytes: number;
  usagePercent?: number;
  walSize?: string;
  walSizeBytes?: number;
}

export interface MonitoringData {
  timestamp: Date;
  overview: DatabaseOverview;
  performance: PerformanceMetrics;
  slowQueries: SlowQueryStats[];
  activeSessions: ActiveSessionDetails[];
  tables?: TableStats[];
  indexes?: IndexStats[];
  storage?: StorageStats[];
}

export interface MonitoringOptions {
  includeTables?: boolean;
  includeIndexes?: boolean;
  includeStorage?: boolean;
  slowQueryLimit?: number;
  sessionLimit?: number;
  schemaFilter?: string;
}
```

---

## Phase 2: Provider Extensions

### 2.1 Base Provider (`src/lib/db/base-provider.ts`)

Mevcut abstract class'a yeni metodlar ekle:

```typescript
// Abstract metodlar (her provider implement etmeli):
public abstract getOverview(): Promise<DatabaseOverview>;
public abstract getPerformanceMetrics(): Promise<PerformanceMetrics>;
public abstract getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]>;
public abstract getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]>;
public abstract getTableStats(options?: { schema?: string }): Promise<TableStats[]>;
public abstract getIndexStats(options?: { schema?: string }): Promise<IndexStats[]>;
public abstract getStorageStats(): Promise<StorageStats[]>;

// Default implementation (tüm metodları çağırır):
public async getMonitoringData(options: MonitoringOptions = {}): Promise<MonitoringData>
```

### 2.2 PostgreSQL Provider (`src/lib/db/providers/sql/postgres.ts`)

**En kapsamlı implementasyon** - Tüm system catalog'ları kullan:

| Metod | SQL Kaynakları |
|-------|----------------|
| `getOverview()` | `version()`, `pg_postmaster_start_time()`, `pg_database_size()`, `pg_stat_activity` |
| `getPerformanceMetrics()` | `pg_statio_user_tables`, `pg_stat_database`, `pg_stat_bgwriter` |
| `getSlowQueries()` | `pg_stat_statements` (extension varsa), fallback `pg_stat_activity` |
| `getActiveSessions()` | `pg_stat_activity` + `pg_locks` (blocking detection) |
| `getTableStats()` | `pg_stat_user_tables`, `pg_table_size()`, `pg_indexes_size()` |
| `getIndexStats()` | `pg_stat_user_indexes`, `pg_index`, `pg_am` |
| `getStorageStats()` | `pg_tablespace`, `pg_wal_lsn_diff()` |

### 2.3 MySQL Provider (`src/lib/db/providers/sql/mysql.ts`)

**İyi kapsam** - `performance_schema` ve `information_schema` kullan:

| Metod | SQL Kaynakları |
|-------|----------------|
| `getOverview()` | `SHOW VARIABLES`, `SHOW STATUS`, `information_schema.tables` |
| `getPerformanceMetrics()` | `performance_schema.global_status`, InnoDB metrics |
| `getSlowQueries()` | `performance_schema.events_statements_summary_by_digest` |
| `getActiveSessions()` | `information_schema.processlist` |
| `getTableStats()` | `information_schema.tables`, `information_schema.statistics` |
| `getIndexStats()` | `information_schema.statistics` |
| `getStorageStats()` | `information_schema.tablespaces`, binlog info |

### 2.4 SQLite Provider (`src/lib/db/providers/sql/sqlite.ts`)

**Temel metrikler** - PRAGMA komutları:

| Metod | SQL Kaynakları |
|-------|----------------|
| `getOverview()` | `sqlite_version()`, file size, `sqlite_master` |
| `getPerformanceMetrics()` | `PRAGMA cache_size`, `PRAGMA page_size` |
| `getSlowQueries()` | Boş array (desteklenmiyor) |
| `getActiveSessions()` | Tek session (current) |
| `getTableStats()` | `sqlite_master`, `SELECT COUNT(*)` |
| `getIndexStats()` | `PRAGMA index_list`, `PRAGMA index_info` |
| `getStorageStats()` | `PRAGMA page_count * page_size` |

### 2.5 MongoDB Provider (`src/lib/db/providers/document/mongodb.ts`)

**Adapte metrikler** - MongoDB komutları:

| Metod | MongoDB Kaynakları |
|-------|---------------------|
| `getOverview()` | `serverStatus`, `dbStats` |
| `getPerformanceMetrics()` | `serverStatus` (connections, opcounters, wiredTiger) |
| `getSlowQueries()` | `system.profile` (profiler enabled ise) |
| `getActiveSessions()` | `currentOp` |
| `getTableStats()` | `collStats` per collection |
| `getIndexStats()` | `$indexStats` aggregation |
| `getStorageStats()` | `dbStats`, storage engine metrics |

### 2.6 Demo Provider (`src/lib/db/providers/demo.ts`)

Mock data döndür - UI test için.

---

## Phase 3: API Endpoints

### 3.1 Ana Endpoint (`src/app/api/db/monitoring/route.ts`)

```typescript
// POST /api/db/monitoring
// Body: { connection: DatabaseConnection, options?: MonitoringOptions }
// Response: MonitoringData

export async function POST(request: NextRequest) {
  // 1. Auth check (getSession)
  // 2. Validate connection
  // 3. getOrCreateProvider(connection)
  // 4. provider.getMonitoringData(options)
  // 5. Return JSON response
  // 6. Error handling (ConnectionError, DatabaseError)
}
```

### 3.2 Granüler Endpointler (Opsiyonel)

Gerekirse ayrı endpoint'ler:
- `POST /api/db/monitoring/overview`
- `POST /api/db/monitoring/performance`
- `POST /api/db/monitoring/queries`
- `POST /api/db/monitoring/sessions`
- `POST /api/db/monitoring/tables`
- `POST /api/db/monitoring/storage`

---

## Phase 4: Frontend Components

### 4.1 Dosya Yapısı

```
src/
├── app/
│   └── monitoring/
│       └── page.tsx                    # Route entry point
├── components/
│   └── monitoring/
│       ├── MonitoringDashboard.tsx     # Ana container
│       ├── MonitoringHeader.tsx        # Header + connection selector
│       ├── RefreshIndicator.tsx        # Auto-refresh status
│       └── tabs/
│           ├── OverviewTab.tsx
│           ├── PerformanceTab.tsx
│           ├── QueriesTab.tsx
│           ├── SessionsTab.tsx
│           ├── TablesTab.tsx
│           └── StorageTab.tsx
└── hooks/
    └── useMonitoringData.ts            # Data fetching hook
```

### 4.2 Route: `/monitoring` (`src/app/monitoring/page.tsx`)

```tsx
'use client';

// Auth check via /api/auth/me
// Render MonitoringDashboard component
// No RBAC restriction (all authenticated users)
```

### 4.3 MonitoringDashboard Component

**State Management:**
- `activeTab`: Aktif sekme
- `connection`: Seçili connection
- `autoRefresh`: Toggle (default: true)
- `refreshInterval`: 30000ms

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ Header: Title + Connection Selector + Refresh Controls      │
├─────────────────────────────────────────────────────────────┤
│ Tabs: Overview | Performance | Queries | Sessions | Tables  │
├─────────────────────────────────────────────────────────────┤
│ Tab Content (scrollable)                                    │
└─────────────────────────────────────────────────────────────┘
```

### 4.4 Tab İçerikleri

#### Overview Tab
- 4 StatCard: Connections, DB Size, Cache Hit %, Uptime
- Version badge, connection status
- Quick stats row

#### Performance Tab
- MetricCard'lar: Cache Hit Ratio, Buffer Usage, Index Hit Ratio
- ProgressBar'lar ile görselleştirme
- İleride: Line/Area chart (Recharts)

#### Queries Tab
- Top Stats: Total Queries, Avg Time, Slow Count
- SlowQueriesTable: Query, Calls, Total Time, Avg Time
- Sortable columns

#### Sessions Tab
- Session breakdown: Active, Idle, Waiting
- SessionsTable: PID, User, State, Query, Duration, Kill button
- Kill session -> `/api/db/maintenance` (type: 'kill')

#### Tables Tab
- Summary: Total Tables, Total Rows, Total Size
- TablesTable: Table, Rows, Size, Index Size, Bloat %, Last Vacuum
- Quick actions: Analyze, Vacuum

#### Storage Tab
- Stats: Total Size, Index Size, WAL Size
- StorageTable: Tablespace, Location, Size, Usage %

### 4.5 useMonitoringData Hook

```typescript
interface UseMonitoringReturn {
  data: MonitoringData | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  autoRefresh: boolean;
  setAutoRefresh: (enabled: boolean) => void;
  refresh: () => Promise<void>;
  killSession: (pid: number | string) => Promise<void>;
}
```

**Auto-refresh Logic:**
```typescript
useEffect(() => {
  if (!connection || !autoRefresh) return;
  fetchData();
  const interval = setInterval(fetchData, 30000);
  return () => clearInterval(interval);
}, [connection, autoRefresh]);
```

---

## Phase 5: UI Components

### 5.1 Mevcut Shadcn/UI Kullanımı

- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` - Tab navigation
- `Card`, `CardHeader`, `CardTitle`, `CardContent` - Stat cards
- `Table`, `TableHeader`, `TableRow`, `TableCell` - Data tables
- `Button` - Actions
- `Select`, `SelectTrigger`, `SelectContent`, `SelectItem` - Connection selector
- `Badge` - Status indicators
- `Progress` - Metric visualization
- `Tooltip` - Query details
- `Skeleton` - Loading states

### 5.2 Lucide Icons

- `LayoutDashboard` - Overview
- `Activity` - Performance
- `Clock` - Queries
- `Users` - Sessions
- `Table2` - Tables
- `HardDrive` - Storage
- `RefreshCw` - Refresh
- `Skull` - Kill session
- `Database`, `Zap`, `Gauge` - Stats

---

## Implementation Order

### Step 1: Type Definitions
1. `src/lib/db/types.ts` - Yeni interface'leri ekle

### Step 2: Base Provider
2. `src/lib/db/base-provider.ts` - Abstract metodları ekle

### Step 3: PostgreSQL (Priority)
3. `src/lib/db/providers/sql/postgres.ts` - Tüm monitoring metodlarını implement et

### Step 4: API Endpoint
4. `src/app/api/db/monitoring/route.ts` - Ana endpoint

### Step 5: Frontend Hook
5. `src/hooks/useMonitoringData.ts` - Data fetching

### Step 6: Page & Dashboard
6. `src/app/monitoring/page.tsx` - Route
7. `src/components/monitoring/MonitoringDashboard.tsx` - Ana component
8. `src/components/monitoring/MonitoringHeader.tsx` - Header

### Step 7: Tab Components
9. `src/components/monitoring/tabs/OverviewTab.tsx`
10. `src/components/monitoring/tabs/PerformanceTab.tsx`
11. `src/components/monitoring/tabs/QueriesTab.tsx`
12. `src/components/monitoring/tabs/SessionsTab.tsx`
13. `src/components/monitoring/tabs/TablesTab.tsx`
14. `src/components/monitoring/tabs/StorageTab.tsx`

### Step 8: Other Providers
15. `src/lib/db/providers/sql/mysql.ts` - MySQL monitoring
16. `src/lib/db/providers/sql/sqlite.ts` - SQLite monitoring
17. `src/lib/db/providers/document/mongodb.ts` - MongoDB monitoring
18. `src/lib/db/providers/demo.ts` - Demo mock data

### Step 9: Navigation Link
19. `src/components/Studio.tsx` - Monitoring sayfasına link ekle

---

## Critical Files Summary

| Dosya | İşlem |
|-------|-------|
| `src/lib/db/types.ts` | Interface'ler ekle |
| `src/lib/db/base-provider.ts` | Abstract metodlar ekle |
| `src/lib/db/providers/sql/postgres.ts` | Monitoring implementasyonu |
| `src/lib/db/providers/sql/mysql.ts` | Monitoring implementasyonu |
| `src/lib/db/providers/sql/sqlite.ts` | Temel monitoring |
| `src/lib/db/providers/document/mongodb.ts` | MongoDB monitoring |
| `src/lib/db/providers/demo.ts` | Mock data |
| `src/app/api/db/monitoring/route.ts` | Yeni API endpoint |
| `src/app/monitoring/page.tsx` | Yeni route |
| `src/components/monitoring/*.tsx` | Yeni UI components |
| `src/hooks/useMonitoringData.ts` | Yeni hook |
| `src/components/Studio.tsx` | Navigation link |

---

## PostgreSQL SQL Queries Reference

### Overview
```sql
SELECT version(), current_database(), pg_postmaster_start_time();
SELECT count(*) FROM pg_stat_activity;
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT setting::int FROM pg_settings WHERE name = 'max_connections';
```

### Performance
```sql
SELECT ROUND(sum(heap_blks_hit)*100.0/NULLIF(sum(heap_blks_hit)+sum(heap_blks_read),0),2)
FROM pg_statio_user_tables;

SELECT xact_commit, xact_rollback, deadlocks
FROM pg_stat_database WHERE datname = current_database();
```

### Slow Queries (pg_stat_statements)
```sql
SELECT queryid, LEFT(query,500), calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC LIMIT 10;
```

### Active Sessions
```sql
SELECT pid, usename, datname, application_name, client_addr, state,
       LEFT(query,500), query_start, wait_event_type, wait_event
FROM pg_stat_activity
WHERE datname = current_database() AND pid != pg_backend_pid()
ORDER BY query_start DESC NULLS LAST LIMIT 50;
```

### Table Stats
```sql
SELECT schemaname, relname, n_live_tup, n_dead_tup,
       pg_size_pretty(pg_table_size(schemaname||'.'||relname)),
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||relname)),
       last_vacuum, last_analyze
FROM pg_stat_user_tables WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||relname) DESC;
```

### Index Stats
```sql
SELECT schemaname, relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes WHERE schemaname = 'public'
ORDER BY idx_scan DESC;
```

### Storage
```sql
SELECT spcname, pg_tablespace_location(oid),
       pg_size_pretty(pg_tablespace_size(oid))
FROM pg_tablespace;

SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0'));
```

---

## Notes

- **pg_stat_statements extension**: Slow queries için gerekli. Extension yoksa graceful fallback.
- **Mobile responsive**: Tailwind breakpoints (sm, md, lg) kullan.
- **Error handling**: Toast notifications (Sonner) + inline error states.
- **Empty states**: Connection seçilmediğinde, data yokken UI.
- **Loading states**: Skeleton components kullan.
