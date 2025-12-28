# Data Import

## Overview
Enable importing data from external files (CSV, JSON, Excel) into database tables.

## Problem Statement
Users currently have no way to bulk import data through the UI. They must either:
- Write INSERT statements manually
- Use external tools (psql COPY, mysql LOAD DATA)
- Use command-line utilities

This creates friction for common workflows like data migration, seeding test data, or importing spreadsheet data.

## Proposed Solution
Add a data import feature accessible from the Schema Explorer, allowing users to:
- Upload files via drag & drop or file picker
- Preview and validate data before import
- Map file columns to table columns
- Configure import options (batch size, error handling)
- Execute import with progress tracking

## Supported Formats

### CSV
- Delimiter detection (comma, semicolon, tab)
- Header row option
- Quote character handling
- Encoding support (UTF-8, Latin-1)

### JSON
- Array of objects format
- Nested object flattening (optional)
- JSON Lines (.jsonl) support

### Excel (.xlsx)
- Sheet selection
- Header row configuration
- Date format handling

## Features

### 1. File Upload
- Drag & drop zone
- File picker button
- File size limit (configurable, default 50MB)
- Format auto-detection

### 2. Data Preview
- First 100 rows preview
- Column type inference
- Error/warning indicators
- Row count display

### 3. Column Mapping
- Auto-mapping by column name
- Manual mapping dropdown
- Ignore column option
- Type conversion warnings
- Required field validation

### 4. Import Options
- Batch size (default: 1000 rows)
- On error: Stop / Skip / Replace
- Truncate table before import (with confirmation)
- Dry run mode (validate only)

### 5. Progress & Results
- Progress bar with percentage
- Rows processed / total
- Success / error counts
- Error log with row numbers
- Cancel button

## Technical Considerations

### File Processing
- Client-side parsing for preview (Papa Parse for CSV)
- Server-side processing for large files
- Streaming for memory efficiency
- Chunked uploads for large files

### API Endpoints
```
POST /api/db/import/preview
{
  connection: DatabaseConnection,
  file: FormData,
  options: { format, delimiter, hasHeader }
}
Response: { columns: [], preview: [], rowCount: number }

POST /api/db/import/execute
{
  connection: DatabaseConnection,
  table: string,
  mapping: { fileColumn: tableColumn }[],
  options: { batchSize, onError, truncate }
}
Response: { success: number, failed: number, errors: [] }
```

### Libraries
- CSV: `papaparse` (client) + `csv-parse` (server)
- Excel: `xlsx` or `exceljs`
- JSON: Native parsing

## UI Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Import Data to "users"                    │
├──────────────────────────────────────────────────────────────┤
│  Step 1: Upload File                                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │     📁 Drag & drop your file here                     │  │
│  │        or click to browse                              │  │
│  │                                                        │  │
│  │     Supported: CSV, JSON, Excel (.xlsx)               │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Step 2: Preview & Map Columns                               │
├──────────────────────────────────────────────────────────────┤
│  File: users_export.csv (1,234 rows)                         │
│                                                              │
│  Column Mapping:                                             │
│  ┌─────────────────┬─────────────────┬──────────────────┐   │
│  │ File Column     │ Table Column    │ Status           │   │
│  ├─────────────────┼─────────────────┼──────────────────┤   │
│  │ name            │ [name ▼]        │ ✓ Mapped         │   │
│  │ email           │ [email ▼]       │ ✓ Mapped         │   │
│  │ age             │ [age ▼]         │ ⚠ Type mismatch  │   │
│  │ created         │ [-- Ignore --]  │ Skipped          │   │
│  └─────────────────┴─────────────────┴──────────────────┘   │
│                                                              │
│  Preview (first 5 rows):                                     │
│  ┌────────────────┬────────────────┬─────┐                  │
│  │ name           │ email          │ age │                  │
│  ├────────────────┼────────────────┼─────┤                  │
│  │ John Doe       │ john@test.com  │ 25  │                  │
│  │ Jane Smith     │ jane@test.com  │ 30  │                  │
│  └────────────────┴────────────────┴─────┘                  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Step 3: Import Options                                      │
├──────────────────────────────────────────────────────────────┤
│  Batch Size: [1000 ▼]                                        │
│  On Error:   (•) Skip row  ( ) Stop import  ( ) Replace      │
│  [ ] Truncate table before import ⚠                         │
│  [ ] Dry run (validate only)                                 │
│                                                              │
│                         [Cancel]  [Start Import]             │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Importing...                                                │
├──────────────────────────────────────────────────────────────┤
│  ████████████████████░░░░░░░░░░  67%                        │
│  823 / 1,234 rows processed                                  │
│  ✓ 820 successful  ✗ 3 failed                               │
│                                                              │
│                                              [Cancel]        │
└──────────────────────────────────────────────────────────────┘
```

## Entry Points

1. **Schema Explorer Context Menu**
   - Right-click on table → "Import Data..."

2. **Table Actions Dropdown**
   - Table row → More menu → "Import"

3. **Toolbar Button** (when table is selected)
   - Import icon in schema explorer toolbar

## Acceptance Criteria
- [ ] User can upload CSV, JSON, and Excel files
- [ ] File format is auto-detected
- [ ] Preview shows first 100 rows
- [ ] Columns can be mapped to table columns
- [ ] Unmapped columns can be ignored
- [ ] Type mismatches show warnings
- [ ] Import options are configurable
- [ ] Progress is displayed during import
- [ ] Errors are logged with row numbers
- [ ] Import can be cancelled
- [ ] Success message shows final counts
- [ ] Works with PostgreSQL, MySQL, SQLite

## Security Considerations
- File size limits
- Sanitize input data
- SQL injection prevention (parameterized queries)
- Rate limiting on import endpoint
- Validate file types (not just extension)

## Dependencies
- Schema information (column names, types)
- Database write permissions
- Bulk insert support in providers

## Estimated Effort
High complexity

## Priority
P2 - Nice to have

## Related Issues
- Data Export (existing feature)
- Inline Data Editing (backlog)
- Schema Explorer (existing)
