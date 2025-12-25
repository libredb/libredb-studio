# Release v0.6.1 - Database Monitoring & Theming System

**Release Date:** December 2024

This release introduces a comprehensive database monitoring dashboard, modernized theming system with Tailwind CSS v4, and significant UI/UX improvements.

---

## Highlights

- **Database Monitoring Dashboard:** Real-time database metrics, performance analytics, and session management
- **Tailwind CSS v4 Theming:** Modern `@theme inline` directive for CSS variable mapping
- **Resizable Sidebar:** Drag-to-resize sidebar panel for better workspace flexibility
- **Theming Documentation:** Comprehensive guide for theme customization

---

## New Features

### Database Monitoring Dashboard

A new `/monitoring` route provides comprehensive database insights accessible to all authenticated users.

**Six Tab-Based Views:**

| Tab | Description |
|-----|-------------|
| **Overview** | Database version, uptime, connection stats, size metrics |
| **Performance** | Cache hit ratio, buffer usage, transaction stats |
| **Queries** | Slow query analysis from `pg_stat_statements` |
| **Sessions** | Active connections with kill session capability |
| **Tables** | Table statistics, row counts, bloat analysis |
| **Storage** | Tablespace usage, WAL size, storage metrics |

**Key Features:**
- Auto-refresh every 30 seconds (configurable)
- Manual refresh button
- Connection selector dropdown
- PostgreSQL-optimized with graceful fallback for other databases
- Kill session support for DBAs

**Access:**
- All authenticated users (admin + user roles)
- Navigate via header link or `/monitoring` URL

### Theming System

Complete theming overhaul using Tailwind CSS v4's CSS-first configuration:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-popover: var(--popover);
  --color-primary: var(--primary);
  --color-secondary: var(--secondary);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  /* ... */
}
```

**Benefits:**
- Semantic class names (`bg-background`, `text-foreground`)
- Consistent dark/light mode support
- Easy theme customization via CSS variables
- shadcn/ui component compatibility

### Resizable Sidebar

Sidebar panel is now resizable with drag handle:

- **Default width:** 22%
- **Minimum:** 15%
- **Maximum:** 35%
- Drag handle visible on hover (blue highlight)
- Preserves layout on mobile (collapsed to bottom tabs)

---

## UI/UX Improvements

### SchemaExplorer Fixes

- Fixed dropdown menu visibility issue (overflow clipping)
- Replaced hardcoded colors with theme variables
- Improved button styling with proper `variant="ghost"`
- Better hover states with `hover:bg-accent`

### Theme-Compatible Components

All components updated to use theme variables:

```tsx
// Before (hardcoded)
<div className="bg-zinc-900 text-white">

// After (theme-aware)
<div className="bg-background text-foreground">
```

---

## Architecture

### New Files

```
src/
├── app/
│   ├── monitoring/
│   │   └── page.tsx                    # Monitoring route
│   └── api/db/monitoring/
│       └── route.ts                    # Monitoring API endpoint
├── components/monitoring/
│   ├── MonitoringDashboard.tsx         # Main dashboard component
│   └── tabs/
│       ├── OverviewTab.tsx
│       ├── PerformanceTab.tsx
│       ├── QueriesTab.tsx
│       ├── SessionsTab.tsx
│       ├── TablesTab.tsx
│       └── StorageTab.tsx
├── hooks/
│   └── use-monitoring-data.ts          # Data fetching hook
└── lib/db/
    └── types.ts                        # Monitoring type definitions
```

### Provider Extensions

New monitoring methods added to `BaseDatabaseProvider`:

```typescript
// Abstract methods (implemented per provider)
getOverview(): Promise<DatabaseOverview>;
getPerformanceMetrics(): Promise<PerformanceMetrics>;
getSlowQueries(options?): Promise<SlowQueryStats[]>;
getActiveSessions(options?): Promise<ActiveSessionDetails[]>;
getTableStats(options?): Promise<TableStats[]>;
getIndexStats(options?): Promise<IndexStats[]>;
getStorageStats(): Promise<StorageStats[]>;

// Convenience method
getMonitoringData(options?): Promise<MonitoringData>;
```

### PostgreSQL SQL Sources

| Metric | SQL Source |
|--------|------------|
| Version/Uptime | `version()`, `pg_postmaster_start_time()` |
| Connections | `pg_stat_activity`, `max_connections` |
| Cache Hit Ratio | `pg_statio_user_tables` |
| Slow Queries | `pg_stat_statements` (extension) |
| Active Sessions | `pg_stat_activity`, `pg_locks` |
| Table Stats | `pg_stat_user_tables`, `pg_table_size()` |
| Storage | `pg_tablespace`, `pg_wal_lsn_diff()` |

---

## Documentation

### New: Theming Guide

Comprehensive documentation at `docs/THEMING.md`:

- Theme architecture overview
- CSS variable reference
- Tailwind v4 integration guide
- Dark/light mode configuration
- Custom color additions
- Troubleshooting guide

### Updated: README.md

- Added Theming row to Tech Stack table
- Community & Quality section with SonarCloud badge

---

## Dependencies

### No New Dependencies

All monitoring features built with existing stack:
- `react-resizable-panels` (already in project)
- `recharts` (already in project)
- shadcn/ui components

---

## Database Support

### Monitoring Feature Matrix

| Feature | PostgreSQL | MySQL | SQLite | MongoDB |
|---------|------------|-------|--------|---------|
| Overview | Full | Full | Basic | Full |
| Performance | Full | Full | Basic | Full |
| Slow Queries | Full* | Full | N/A | Profile** |
| Sessions | Full | Full | Single | Full |
| Tables | Full | Full | Basic | Collections |
| Storage | Full | Basic | Basic | Full |

\* Requires `pg_stat_statements` extension
\** Requires profiler enabled

---

## Breaking Changes

None. All existing APIs remain compatible.

---

## Bug Fixes

- Fixed dropdown menu not visible in SchemaExplorer (overflow issue)
- Fixed hardcoded `text-white` colors breaking light mode
- Fixed sidebar width preventing dropdown visibility

---

## Configuration

### VS Code Settings

Added CSS warning suppression for Tailwind v4:

```json
{
  "css.lint.unknownAtRules": "ignore"
}
```

---

## What's Next

### v0.7.0 (Planned)
- Real-time monitoring charts with historical data
- Query performance trends
- Alert thresholds configuration
- Monitoring data export

---

## Full Changelog

### Added
- `/monitoring` route with comprehensive database dashboard
- `MonitoringDashboard` component with 6 tab views
- `use-monitoring-data` hook with auto-refresh
- `/api/db/monitoring` endpoint
- Monitoring type definitions in `types.ts`
- Provider monitoring methods (PostgreSQL, MySQL, SQLite, MongoDB)
- `@theme inline` block in globals.css
- `docs/THEMING.md` comprehensive guide
- Resizable sidebar with `ResizablePanelGroup`
- VS Code settings for CSS warning suppression

### Changed
- Sidebar from fixed width to resizable panel
- SchemaExplorer dropdown trigger to proper Button component
- Hardcoded colors to theme variables across components
- README.md with theming and community sections

### Fixed
- SchemaExplorer dropdown menu visibility
- Theme color inconsistencies
- Light mode color issues

---

## Screenshots

### Monitoring Dashboard - Overview
Database overview with key metrics, connection stats, and uptime information.

### Monitoring Dashboard - Sessions
Active session management with kill session capability.

### Resizable Sidebar
Drag handle for sidebar width adjustment.

---

## Contributors

- Database monitoring implementation
- Tailwind v4 theming integration
- UI/UX improvements
- Documentation

---

*LibreDB Studio v0.6.1 - Modern database management for the cloud era.*
