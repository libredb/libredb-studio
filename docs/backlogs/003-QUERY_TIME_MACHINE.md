# Query Time Machine

## Overview
Compare query results across different points in time. Answer questions like "What did this data look like yesterday vs today?"

## Problem Statement
Data analysts frequently need to understand how data has changed over time:
- "Why did our sales drop? What changed since last week?"
- "This customer had 5 orders yesterday, now shows 3. What happened?"
- "Compare today's active users with last month"

Currently, users must:
- Manually save query results to files/spreadsheets
- Re-run queries and manually compare
- Rely on memory or external documentation

## Proposed Solution
Automatic query result snapshots with visual diff comparison.

## Features

### 1. Automatic Snapshots
- Save query results with timestamp automatically
- Configurable retention (7 days, 30 days, custom)
- Storage optimization (compress, deduplicate)
- Manual "Pin" option for important snapshots

### 2. Time Selector UI
```
┌─────────────────────────────────────────────────────────────┐
│ Query Results                    [Today ▼] vs [Yesterday ▼] │
├─────────────────────────────────────────────────────────────┤
│ Timeline: ───●────●────●────●────●───                       │
│          Dec 20  21   22   23   24                          │
└─────────────────────────────────────────────────────────────┘
```
- Dropdown to select comparison dates
- Visual timeline with snapshot points
- Quick presets: "vs Yesterday", "vs Last Week", "vs Last Month"

### 3. Diff Visualization
```
┌─────────────────────────────────────────────────────────────┐
│ Changes Summary: +12 new rows, -3 removed, ~5 modified      │
├─────────────────────────────────────────────────────────────┤
│   name          │ orders (Dec 23) │ orders (Dec 24) │ diff  │
├─────────────────┼─────────────────┼─────────────────┼───────┤
│ + Alice Smith   │ -               │ 15              │ NEW   │
│ ~ John Doe      │ 42              │ 45              │ +3    │
│ ~ Jane Wilson   │ 38              │ 35              │ -3    │
│ - Bob Johnson   │ 12              │ -               │ DEL   │
└─────────────────────────────────────────────────────────────┘

Legend: + Added  ~ Modified  - Removed
```
- Side-by-side comparison
- Inline diff with color coding
- Summary statistics (added/removed/modified counts)
- Filter: "Show only changes"

### 4. Trend Analysis
- Mini sparkline showing value changes over time
- "This value increased 23% over the last 7 snapshots"
- Anomaly detection: "Unusual drop detected on Dec 22"

### 5. Query History Integration
- Link snapshots to specific query executions
- "Show me all snapshots for this query"
- Compare results from different query versions

## Technical Considerations

### Storage Strategy
```typescript
interface QuerySnapshot {
  id: string;
  queryHash: string;           // Hash of the SQL query
  connectionId: string;
  timestamp: Date;
  rowCount: number;
  checksum: string;            // For quick equality check
  data: CompressedData;        // Compressed row data
  metadata: {
    executionTime: number;
    fields: string[];
  };
}
```

### Storage Options
1. **LocalStorage/IndexedDB** - Client-side, limited capacity
2. **Server-side SQLite** - Dedicated snapshot database
3. **Cloud Storage** - S3/GCS for large datasets
4. **Hybrid** - Recent in browser, older in cloud

### Diff Algorithm
- Use row primary key for matching
- Hash-based comparison for quick equality check
- Deep comparison for modified detection
- Efficient diff for large datasets (streaming)

### API Endpoints
```
GET /api/snapshots?queryHash=xxx
POST /api/snapshots
GET /api/snapshots/:id
DELETE /api/snapshots/:id
GET /api/snapshots/diff?from=id1&to=id2
```

## UI Components

### New Components
- `TimelineSelector.tsx` - Visual timeline with snapshot points
- `SnapshotDiff.tsx` - Side-by-side comparison view
- `SnapshotManager.tsx` - List and manage saved snapshots
- `TrendSparkline.tsx` - Mini trend visualization

### Integration Points
- Results toolbar: "Compare with..." button
- Query history: "View snapshots" action
- New bottom panel tab: "Time Machine"

## User Flow

```
1. User runs query
   ↓
2. System auto-saves snapshot (if enabled)
   ↓
3. User clicks "Compare with..." or "Time Machine" tab
   ↓
4. User selects comparison date/snapshot
   ↓
5. System shows diff view with changes highlighted
   ↓
6. User can drill down into specific changes
```

## Configuration Options
- Auto-snapshot: On/Off
- Retention period: 7/30/90 days
- Max snapshots per query: 10/50/100
- Storage limit: 50MB/200MB/1GB
- Compression level: Low/Medium/High

## Edge Cases
- Query with no primary key (use row index)
- Schema changes between snapshots
- Very large result sets (pagination/sampling)
- Identical results (show "No changes" state)

## Empty States
- "No snapshots yet. Run a query to create your first snapshot."
- "This is the first snapshot. Run the query again later to compare."
- "No changes between selected snapshots."

## Acceptance Criteria
- [ ] Query results are automatically saved as snapshots
- [ ] User can select two snapshots to compare
- [ ] Diff view shows added, removed, and modified rows
- [ ] Changes are color-coded for easy identification
- [ ] Summary shows counts of each change type
- [ ] User can filter to show only changes
- [ ] Snapshots can be manually pinned/deleted
- [ ] Storage limits are enforced
- [ ] Works with PostgreSQL, MySQL, SQLite

## Dependencies
- Query execution system
- Storage system (IndexedDB or server-side)
- Diff algorithm implementation

## Estimated Effort
High complexity

## Priority
P2 - Differentiating feature

## Related Features
- Query History (existing)
- Data Visualization (existing)
- AI Data Storyteller (planned)
