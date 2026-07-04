# Query Optimization & Performance Features

LibreDB Studio includes enterprise-grade query optimization features to prevent system freezes and provide performance insights for DBAs, data engineers, and developers.

## Table of Contents

- [Query Pagination System](#query-pagination-system)
- [Silent Auto-Limiting](#silent-auto-limiting)
- [Load More Functionality](#load-more-functionality)
- [Query EXPLAIN Integration](#query-explain-integration)
- [Performance Insights](#performance-insights)
- [Architecture](#architecture)

---

## Query Pagination System

### Overview

All SELECT queries are automatically paginated to prevent browser freezes when dealing with large datasets. This is handled transparently without interrupting the user workflow.

### Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_QUERY_LIMIT` | 500 | Default rows per page |
| `MAX_UNLIMITED_ROWS` | 100,000 | Maximum rows for "Load All" |

### How It Works

1. User executes a SELECT query
2. System automatically adds `LIMIT 500` if no LIMIT exists (an `OFFSET` clause is only appended when the offset is greater than 0)
3. If user already specified a LIMIT, it's preserved (no override)
4. Results display with pagination metadata

---

## Silent Auto-Limiting

### Philosophy

Instead of showing warning popups for large datasets, LibreDB Studio silently limits results to 500 rows. This provides:

- **Uninterrupted workflow** - No confirmation dialogs
- **Safe defaults** - System never freezes
- **User control** - Load More when needed

### Visual Indicators

When auto-limiting is applied:

```
┌─────────────────────────────────────────────────────┐
│ Results   500 rows  │  AUTO-LIMITED  │  Load More  │
└─────────────────────────────────────────────────────┘
```

- **AUTO-LIMITED badge** - Shows when the system added a LIMIT
- **Row count** - Displays actual returned rows
- **Load More button** - Appears when more data is available

### Query Limiter Utility

Location: `src/lib/db/utils/query-limiter.ts`

```typescript
import { analyzeQuery, applyQueryLimit } from '@/lib/db/utils/query-limiter';

// Analyze a query
const info = analyzeQuery('SELECT * FROM users WHERE active = true');
// Returns: { type: 'SELECT', hasLimit: false, hasOffset: false, ... }

// Apply limit to query
const result = applyQueryLimit('SELECT * FROM users', 500, 0);
// Returns: { sql: 'SELECT * FROM users LIMIT 500', wasLimited: true, ... }
// (OFFSET is only appended when offset > 0, e.g. applyQueryLimit(sql, 500, 500) -> '... LIMIT 500 OFFSET 500')
```

### Supported Query Types

| Query Type | Auto-Limit Applied |
|------------|-------------------|
| SELECT | Yes |
| SELECT with LIMIT | No (preserved) |
| SELECT with UNION | Yes (LIMIT appended after the last statement) |
| SELECT with CTE | Yes |
| INSERT/UPDATE/DELETE | No |
| DDL (CREATE, ALTER) | No |

---

## Load More Functionality

### User Flow

1. Execute query → 500 rows displayed
2. Click "Load More" → Next 500 rows appended
3. Repeat until all data loaded or satisfied

### API Request

```typescript
// Initial query
POST /api/db/query
{
  "connection": {...},
  "sql": "SELECT * FROM orders",
  "options": { "limit": 500, "offset": 0 }
}

// Load More
POST /api/db/query
{
  "connection": {...},
  "sql": "SELECT * FROM orders",
  "options": { "limit": 500, "offset": 500 }
}
```

### Response Format

```typescript
{
  "rows": [...],
  "fields": ["id", "name", ...],
  "rowCount": 500,
  "executionTime": 45,
  "pagination": {
    "limit": 500,
    "offset": 0,
    "hasMore": true,        // More rows available
    "totalReturned": 500,
    "wasLimited": true      // System added LIMIT
  }
}
```

### Load All Option

For advanced users, a "Load All" button triggers an unlimited query (max 100K rows) with a confirmation dialog:

```
┌──────────────────────────────────────┐
│  Load all results?                   │
│                                      │
│  This may slow down your browser.    │
│  Max 100K rows will be loaded.       │
│                                      │
│  [Cancel]          [Load All]        │
└──────────────────────────────────────┘
```

---

## Query EXPLAIN Integration

### Automatic EXPLAIN

Every SELECT query automatically runs EXPLAIN in the background (parallel execution). This provides instant performance insights without user action.

### Supported Databases

| Database | EXPLAIN Format |
|----------|---------------|
| PostgreSQL | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` |
| MySQL | `EXPLAIN FORMAT=JSON` |
| SQLite | Not supported (no JSON format) |

### How It Works

```
User executes: SELECT * FROM orders WHERE status = 'pending'

┌─────────────────────────────────────────────────────────────┐
│                    Parallel Execution                        │
│                                                              │
│  ┌──────────────────┐      ┌──────────────────────────────┐ │
│  │   Main Query     │      │   Background EXPLAIN          │ │
│  │   (with LIMIT)   │      │   (no LIMIT, ANALYZE)         │ │
│  └────────┬─────────┘      └────────────┬─────────────────┘ │
│           │                              │                   │
│           ▼                              ▼                   │
│     Results Tab                    Explain Tab               │
└─────────────────────────────────────────────────────────────┘
```

### Accessing EXPLAIN Data

Click the "Explain" tab in the results panel to view:
- Performance Insights
- Execution Plan Tree
- Raw JSON

---

## Performance Insights

### VisualExplain Component

Location: `src/components/VisualExplain.tsx`

The VisualExplain component analyzes execution plans and provides actionable insights.

### Automatic Warning Detection

| Warning | Trigger | Severity |
|---------|---------|----------|
| Sequential Scan | Seq Scan on >10K rows | Warning |
| Estimate Mismatch | Actual/Planned ratio >10x or <0.1x | Info |
| Expensive Sort | Sort operation >100ms | Warning |
| High Loop Count | Nested Loop >1000 iterations | Critical |

### Warning Examples

**Sequential Scan Warning:**
```
⚠️ Sequential Scan
Full table scan on "orders" (15.2K rows). Consider adding an index.
```

**N+1 Problem Detection:**
```
🔴 High Loop Count
Nested loop executed 5.2K times. This could indicate an N+1 problem.
```

**Estimate Mismatch:**
```
ℹ️ Estimate Mismatch
Expected 100 rows, got 15.2K. Statistics may be outdated.
```

### Metrics Grid

| Metric | Description |
|--------|-------------|
| Cache Hit Rate | Buffer cache efficiency (>95% is good) |
| Operations | Number of plan nodes |
| Execution | Total query time |

### Plan Tree View

Interactive, collapsible execution plan with:
- Node type icons (Seq Scan, Index Scan, Join, Sort, etc.)
- Time bars showing relative cost
- Row counts and costs
- Filter conditions
- Index usage

```
▼ Limit (0.12ms, 500 rows)
  └─▼ Sort (45.2ms, 500 rows)
      └─▼ Seq Scan on orders (120.5ms, 15.2K rows)
          Filter: status = 'pending'
```

---

## Architecture

### File Structure

```
src/
├── lib/db/utils/
│   └── query-limiter.ts      # Query parsing and LIMIT injection
├── app/api/db/
│   └── query/route.ts        # Query API with pagination
├── components/
│   ├── Studio.tsx            # Query execution orchestration
│   ├── ResultsGrid.tsx       # Results display with Load More
│   └── VisualExplain.tsx     # EXPLAIN visualization
└── lib/types.ts              # QueryPagination interface
```

### Data Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Dashboard  │────▶│  /api/db/query   │────▶│  DB Provider    │
│             │     │                  │     │                 │
│ executeQuery│     │ - Parse query    │     │ - Execute SQL   │
│             │     │ - Apply LIMIT    │     │ - Return rows   │
└─────────────┘     │ - Add pagination │     └─────────────────┘
       │            └──────────────────┘
       │
       ▼
┌─────────────┐     ┌──────────────────┐
│ ResultsGrid │     │  VisualExplain   │
│             │     │                  │
│ - Show rows │     │ - Parse plan     │
│ - Load More │     │ - Show warnings  │
│ - Stats bar │     │ - Render tree    │
└─────────────┘     └──────────────────┘
```

### Key Interfaces

```typescript
// Query pagination metadata
interface QueryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  totalReturned: number;
  wasLimited: boolean;
}

// Query result with pagination
interface QueryResult {
  rows: any[];
  fields: string[];
  rowCount: number;
  executionTime: number;
  explainPlan?: any;
  pagination?: QueryPagination;
}

// Query tab state
interface QueryTab {
  id: string;
  name: string;
  query: string;
  result: QueryResult | null;
  explainPlan?: any;
  currentOffset?: number;
  isLoadingMore?: boolean;
  allRows?: any[];
}
```

---

## Best Practices

### For Users

1. **Use WHERE clauses** - Filter data at the database level
2. **Add LIMIT when known** - If you only need 10 rows, add `LIMIT 10`
3. **Check Explain tab** - Review performance before running in production
4. **Use indexes** - Add indexes for frequently filtered columns

### For Developers

1. **Never bypass the limiter** - Always use the query API
2. **Handle pagination** - Support `hasMore` in custom implementations
3. **Parse EXPLAIN** - Use the analyzePlan function for custom analysis

---

## Configuration

Currently, limits are hardcoded. Future versions may support configuration:

```typescript
// Future: .env configuration
QUERY_DEFAULT_LIMIT=500
QUERY_MAX_UNLIMITED=100000
EXPLAIN_AUTO_RUN=true
```

---

## Changelog

| Version | Changes |
|---------|---------|
| 0.7.0 | Initial query optimization system |
| 0.7.1 | Removed Large Dataset popup (silent limiting) |
| 0.7.1 | Added automatic background EXPLAIN |
| 0.7.1 | Added VisualExplain with Performance Insights |
