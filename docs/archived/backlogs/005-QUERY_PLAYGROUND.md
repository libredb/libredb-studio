# Query Playground (Sandbox Mode)

## Overview
A safe environment to test dangerous queries (DELETE, UPDATE, DROP) without affecting production data. Preview the impact before committing.

## Problem Statement
Database users face anxiety when running destructive queries:
- "Will this DELETE remove the right rows?"
- "How many records will this UPDATE affect?"
- "What if I make a mistake with this DROP TABLE?"

Current mitigations are inadequate:
- Running on a test database (data may differ)
- Adding WHERE 1=0 to test syntax (doesn't show impact)
- Manual review (error-prone, time-consuming)
- Hoping for the best (risky)

## Proposed Solution
A sandbox mode that:
1. Analyzes destructive queries before execution
2. Shows exactly what will be affected
3. Provides one-click rollback capability
4. Allows "dry run" execution

## Features

### 1. Query Impact Preview
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ DESTRUCTIVE QUERY DETECTED                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ DELETE FROM orders WHERE status = 'cancelled'              │
│                                                             │
│ Impact Analysis:                                            │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 🗑️  847 rows will be deleted                            │ │
│ │ 📊 This is 12% of the orders table                      │ │
│ │ 🔗 0 foreign key constraints affected                   │ │
│ │ 💾 Estimated freed space: 2.3 MB                        │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ Preview of affected rows (first 10):                        │
│ ┌────┬──────────┬────────────┬─────────────┐               │
│ │ id │ customer │ amount     │ created_at  │               │
│ ├────┼──────────┼────────────┼─────────────┤               │
│ │ 42 │ John D.  │ $150.00    │ 2024-01-15  │               │
│ │ 78 │ Jane S.  │ $89.50     │ 2024-02-20  │               │
│ │... │ ...      │ ...        │ ...         │               │
│ └────┴──────────┴────────────┴─────────────┘               │
│                                                             │
│ [View All 847 Rows]                                         │
│                                                             │
│        [Cancel]  [Execute with Rollback]  [Execute]         │
└─────────────────────────────────────────────────────────────┘
```

### 2. Sandbox Execution Mode
```
┌─────────────────────────────────────────────────────────────┐
│ 🧪 SANDBOX MODE                              [Exit Sandbox] │
├─────────────────────────────────────────────────────────────┤
│ All changes are temporary and can be rolled back            │
│                                                             │
│ Pending Changes:                                            │
│ • DELETE orders (847 rows) - 2 min ago                     │
│ • UPDATE users SET status='inactive' (23 rows) - 1 min ago │
│                                                             │
│                         [Rollback All]  [Commit All]        │
└─────────────────────────────────────────────────────────────┘
```

### 3. Transaction Wrapper
Behind the scenes:
```sql
BEGIN TRANSACTION;
-- User's dangerous query runs here
-- Results shown to user
-- Wait for user decision
COMMIT;   -- If user confirms
ROLLBACK; -- If user cancels
```

### 4. Visual Diff for UPDATE
```
┌─────────────────────────────────────────────────────────────┐
│ UPDATE users SET email = LOWER(email) WHERE id < 100       │
├─────────────────────────────────────────────────────────────┤
│ 23 rows will be modified:                                   │
│                                                             │
│ id │ email (before)          │ email (after)               │
│ ───┼─────────────────────────┼───────────────────────────  │
│ 1  │ John@Example.COM        │ john@example.com            │
│ 2  │ JANE@Test.Org           │ jane@test.org               │
│ 5  │ Bob.Smith@COMPANY.com   │ bob.smith@company.com       │
│ ...│                         │                              │
└─────────────────────────────────────────────────────────────┘
```

### 5. Undo History
```
┌─────────────────────────────────────────────────────────────┐
│ 📜 Undo History                                             │
├─────────────────────────────────────────────────────────────┤
│ ↩️  DELETE orders (847 rows) - Committed 5 min ago    [Undo]│
│ ↩️  UPDATE users (23 rows) - Committed 3 min ago      [Undo]│
│ ✓  INSERT products (5 rows) - Committed 1 min ago          │
└─────────────────────────────────────────────────────────────┘
```
- Keep backup data for recent destructive operations
- One-click restore from backup
- Configurable retention period

### 6. Query Safety Checks
Before execution, analyze for:
- Missing WHERE clause: `DELETE FROM users` → "No WHERE clause! This will delete ALL rows"
- Overly broad conditions: `WHERE 1=1` → "Condition matches all rows"
- Cascade effects: Foreign key deletions
- Index impact: Updating indexed columns
- Lock warnings: Table-level locks on large operations

## Technical Considerations

### Implementation Strategy

#### Option A: Transaction Wrapping
```typescript
async function sandboxExecute(query: string, connection: Connection) {
  await connection.query('BEGIN');

  try {
    // Get affected rows count first
    const countResult = await analyzeImpact(query, connection);

    // Execute and capture changes
    const result = await connection.query(query);

    // Return result without committing
    return {
      result,
      impact: countResult,
      rollback: () => connection.query('ROLLBACK'),
      commit: () => connection.query('COMMIT'),
    };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}
```

#### Option B: Clone & Execute
For very destructive operations:
1. Create temporary table copy
2. Execute on copy
3. Show diff
4. If confirmed, execute on real table

#### Option C: Query Rewriting
```sql
-- Original
DELETE FROM orders WHERE status = 'cancelled'

-- Rewritten for preview
SELECT * FROM orders WHERE status = 'cancelled'
-- Shows what would be deleted
```

### Impact Analysis API
```typescript
interface ImpactAnalysis {
  queryType: 'DELETE' | 'UPDATE' | 'DROP' | 'TRUNCATE' | 'ALTER';
  affectedRows: number;
  affectedTables: string[];
  cascadeEffects: CascadeEffect[];
  estimatedDuration: number;
  warnings: Warning[];
  previewData: any[];
}

async function analyzeQuery(
  query: string,
  connection: Connection
): Promise<ImpactAnalysis>;
```

### Undo Implementation
```typescript
interface UndoRecord {
  id: string;
  timestamp: Date;
  queryType: string;
  table: string;
  affectedRows: number;
  backupData: any[];  // Snapshot of affected rows
  undoQuery: string;  // Generated reverse query
}
```

For DELETE:
- Store deleted rows in undo buffer
- Generate INSERT statements for undo

For UPDATE:
- Store before-values
- Generate UPDATE with original values for undo

### API Endpoints
```
POST /api/db/sandbox/analyze
  → Returns impact analysis

POST /api/db/sandbox/execute
  → Executes in transaction, returns preview

POST /api/db/sandbox/commit
  → Commits pending transaction

POST /api/db/sandbox/rollback
  → Rolls back pending transaction

GET /api/db/sandbox/undo-history
  → Returns undo-able operations

POST /api/db/sandbox/undo/:id
  → Undoes a specific operation
```

## UI Components

### New Components
- `SandboxBanner.tsx` - Top banner showing sandbox mode status
- `ImpactPreview.tsx` - Shows affected rows preview
- `DiffView.tsx` - Before/after comparison for UPDATE
- `UndoHistory.tsx` - List of undo-able operations
- `SafetyWarnings.tsx` - Displays query safety issues
- `ConfirmationModal.tsx` - Confirm destructive action

### Editor Integration
- Detect destructive keywords (DELETE, UPDATE, DROP, TRUNCATE, ALTER)
- Show warning icon in gutter
- Auto-trigger sandbox mode for dangerous queries
- Toggle: "Always use sandbox for destructive queries"

## User Flow

### Automatic Sandbox (Default)
```
1. User writes DELETE/UPDATE query
   ↓
2. Clicks "Run" (or Cmd+Enter)
   ↓
3. System detects destructive query
   ↓
4. Impact analysis runs automatically
   ↓
5. Preview modal shows affected rows
   ↓
6. User reviews and decides:
   - Cancel: Nothing happens
   - Execute with Rollback: Runs in sandbox
   - Execute: Runs directly (if confident)
```

### Manual Sandbox Mode
```
1. User enables "Sandbox Mode" toggle
   ↓
2. All queries run in transaction
   ↓
3. Changes accumulate without committing
   ↓
4. User can preview, test, experiment
   ↓
5. Finally: Commit All or Rollback All
```

## Safety Levels

### Level 1: Warning Only
- Show warning banner
- User can proceed immediately
- For: UPDATE with WHERE clause

### Level 2: Preview Required
- Must view affected rows before executing
- For: DELETE with WHERE clause

### Level 3: Confirmation Required
- Type table name to confirm
- For: DROP TABLE, TRUNCATE

### Level 4: Blocked
- Cannot execute in UI
- For: DROP DATABASE
- Must use CLI with explicit flag

```
┌─────────────────────────────────────────────────────────────┐
│ ⛔ DROP TABLE users                                         │
├─────────────────────────────────────────────────────────────┤
│ This action cannot be undone.                               │
│                                                             │
│ Type "users" to confirm:                                    │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │                                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│                                    [Cancel]  [Drop Table]   │
└─────────────────────────────────────────────────────────────┘
```

## Configuration Options
- Sandbox mode: Auto (destructive only) / Always / Never
- Undo history retention: 1 hour / 1 day / 1 week
- Preview row limit: 10 / 50 / 100
- Safety level overrides per table
- Excluded tables (never sandbox)

## Edge Cases
- Long-running transactions (timeout handling)
- Concurrent modifications (lock detection)
- Very large affected sets (sampling for preview)
- Queries with side effects (triggers, functions)
- Read replica connections (write detection)

## Acceptance Criteria
- [ ] Destructive queries trigger impact preview
- [ ] Affected row count is shown before execution
- [ ] Preview shows sample of affected rows
- [ ] UPDATE shows before/after diff
- [ ] User can cancel, execute, or execute with rollback
- [ ] Sandbox mode allows multiple operations before commit
- [ ] Undo history allows reverting recent operations
- [ ] Safety warnings appear for risky patterns
- [ ] Works with PostgreSQL, MySQL, SQLite

## Dependencies
- Transaction support in database providers
- Query parsing for type detection
- Backup/restore functionality for undo

## Estimated Effort
Medium-High complexity

## Priority
P1 - Safety critical

## Related Features
- Query History (existing)
- Inline Data Editing (planned - will use sandbox)
- Query Time Machine (planned - can use for comparison)
