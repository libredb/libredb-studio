# Inline Data Editing

## Overview
Enable direct data manipulation in the Results Grid without writing SQL queries manually.

## Problem Statement
Currently, users must write UPDATE, INSERT, or DELETE statements manually to modify data. This is time-consuming for quick fixes and requires SQL knowledge for simple operations.

## Proposed Solution
Add inline editing capabilities to the ResultsGrid component, allowing users to:
- Edit cell values directly by double-clicking
- Insert new rows
- Delete existing rows
- Review pending changes before committing

## Features

### 1. Cell Editing
- Double-click on a cell to enter edit mode
- Press Enter to confirm, Escape to cancel
- Visual indicator for modified cells (highlight/border)
- Type-aware input fields (text, number, date, boolean)

### 2. Row Operations
- "Add Row" button in toolbar
- Row selection with checkbox
- "Delete Selected" button with confirmation
- Right-click context menu for row operations

### 3. Change Tracking
- Pending changes indicator (badge count)
- Changes panel showing all modifications
- Diff view: original value → new value
- Undo individual changes

### 4. Commit/Rollback
- "Commit Changes" button - executes all pending changes
- "Rollback" button - discards all pending changes
- Transaction support (all-or-nothing)
- Success/error feedback per operation

### 5. Safety Features
- Confirmation dialog for destructive operations
- Primary key requirement for UPDATE/DELETE
- Row count limit for bulk operations
- Read-only mode toggle

## Technical Considerations

### Database Requirements
- Table must have a PRIMARY KEY for UPDATE/DELETE
- User must have appropriate permissions
- Connection must support transactions

### UI Components
- Extend `ResultsGrid.tsx` with edit mode
- New `PendingChanges` component
- New `EditableCell` component
- Toolbar additions

### API Endpoints
```
POST /api/db/mutation
{
  connection: DatabaseConnection,
  operations: [
    { type: 'UPDATE', table: string, pk: object, changes: object },
    { type: 'INSERT', table: string, values: object },
    { type: 'DELETE', table: string, pk: object }
  ]
}
```

## UI Mockup

```
┌─────────────────────────────────────────────────────────────┐
│ Results                                    [3 pending] [+]  │
├─────────────────────────────────────────────────────────────┤
│ ☐ │ id │ name        │ email              │ status   │     │
├───┼────┼─────────────┼────────────────────┼──────────┼─────┤
│ ☐ │ 1  │ John Doe    │ john@example.com   │ active   │     │
│ ☑ │ 2  │ [Jane Doe]* │ jane@example.com   │ active   │ 🗑  │
│ ☐ │ 3  │ Bob Smith   │ bob@example.com    │ inactive │     │
│ + │ -- │ New row...  │ --                 │ --       │     │
└─────────────────────────────────────────────────────────────┘
│                              [Rollback] [Commit Changes]    │
└─────────────────────────────────────────────────────────────┘

* = modified cell (highlighted)
```

## Acceptance Criteria
- [ ] User can double-click a cell to edit its value
- [ ] Modified cells are visually distinct
- [ ] User can add new rows to the result set
- [ ] User can delete selected rows
- [ ] Pending changes are tracked and displayed
- [ ] User can commit all changes in a single transaction
- [ ] User can rollback all pending changes
- [ ] Confirmation dialog appears before destructive operations
- [ ] Error handling with clear feedback
- [ ] Works with PostgreSQL, MySQL, SQLite

## Dependencies
- Primary key detection from schema
- Transaction support in database providers
- Permission checking

## Estimated Effort
Medium-High complexity

## Priority
P2 - Nice to have

## Related Issues
- Query Results Export (existing)
- Schema Explorer (existing)
