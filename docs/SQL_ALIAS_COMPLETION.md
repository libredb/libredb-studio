# SQL Alias-Based Code Completion

This document describes the intelligent SQL code completion feature that provides context-aware autocompletion with alias support in the Monaco Editor.

## Features

### 1. Alias-Based Column Completion

When you define a table alias in your SQL query, typing the alias followed by a dot (`.`) will suggest columns from the referenced table.

**Supported Patterns:**

| Pattern | Example | Result |
|---------|---------|--------|
| `FROM table AS alias` | `FROM employee AS e WHERE e.` | employee columns |
| `FROM table alias` | `FROM employee e WHERE e.` | employee columns |
| `JOIN table AS alias` | `JOIN department AS d ON d.` | department columns |
| `JOIN table alias` | `LEFT JOIN salary s ON s.` | salary columns |
| `schema.table alias` | `FROM employees.employee e WHERE e.` | employee columns |
| Multiple aliases | `FROM a AS x JOIN b AS y` | Both `x.` and `y.` work |
| CTE references | `WITH cte AS (...) SELECT cte.` | CTE columns |
| Direct table | `employee.` | employee columns |

### 2. Context-Aware Completions

The completion system intelligently shows suggestions based on SQL context:

**Columns are shown only after:**
- `SELECT` keyword
- `WHERE` clause
- `AND`, `OR` operators
- `ON` (in JOIN conditions)
- `SET` (in UPDATE statements)
- `HAVING` clause
- `ORDER BY`, `GROUP BY` clauses
- Comma (`,`) in column lists

**Columns are NOT shown when:**
- Typing keywords like `FROM`, `JOIN`, `WHERE`
- After `SELECT *` (expecting keyword, not column)

### 3. Prioritized Suggestions

Suggestions are sorted by relevance:

| Priority | Type | Description |
|----------|------|-------------|
| 1st | Keywords | SQL keywords (SELECT, FROM, WHERE, etc.) |
| 2nd | Functions | SQL functions (COUNT, SUM, AVG, etc.) |
| 3rd | Tables | Database tables |
| 4th | Snippets | Query templates |
| 5th | Columns | Table columns (context-dependent) |

## Architecture

### Module Structure

```
src/lib/sql/
├── alias-extractor.ts   # Core alias extraction logic
├── types.ts             # TypeScript interfaces
└── index.ts             # Module exports
```

### Key Components

#### 1. Alias Extractor (`src/lib/sql/alias-extractor.ts`)

Lightweight regex-based SQL parser that extracts table aliases without external dependencies.

**Functions:**
- `extractAliases(sql: string)` - Extract all table aliases from a SQL query
- `resolveAlias(identifier: string, aliases: Map)` - Resolve an alias to its table name

**How it works:**
1. Preprocesses SQL to remove comments and string literals
2. Extracts FROM clause aliases
3. Extracts JOIN clause aliases
4. Extracts CTE (WITH clause) aliases
5. Returns a Map of alias → table name

#### 2. Completion Provider (`src/components/QueryEditor.tsx`)

Monaco Editor completion provider that integrates with the alias extractor.

**Dot-triggered completion flow:**
```
User types: "e."
     ↓
1. Try direct table lookup: columnMap.get("e")
     ↓ (not found)
2. Extract aliases from query text
     ↓
3. Resolve "e" → "employee"
     ↓
4. Find columns: columnMap.get("employee")
     ↓
5. Return column suggestions
```

### Edge Cases Handled

1. **SQL Keywords as Aliases**: Filters out `ON`, `WHERE`, `AND`, etc.
2. **Comments**: Removes `--` and `/* */` before parsing
3. **String Literals**: Replaces with placeholder to avoid false matches
4. **Case Insensitivity**: Alias lookup is case-insensitive
5. **Schema Prefixes**: Handles `schema.table` format (e.g., `employees.employee`)

## Performance Considerations

- **No external SQL parser**: Keeps bundle size small
- **Regex-based parsing**: Fast execution (<10ms for typical queries)
- **Lazy evaluation**: Alias extraction only runs on dot-trigger
- **Cursor-limited parsing**: Only parses text from start to cursor position
- **Early exit**: Skips parsing if no FROM/JOIN/WITH keywords found

## Examples

### Basic Alias Usage
```sql
SELECT e.first_name, e.last_name
FROM employee e
WHERE e.hire_date > '2020-01-01'
```
Typing `e.` after defining `FROM employee e` will suggest all employee columns.

### Multiple Table Aliases
```sql
SELECT
  e.first_name,
  d.dept_name,
  s.amount
FROM employee e
JOIN department_employee de ON de.employee_id = e.id
JOIN department d ON d.id = de.department_id
JOIN salary s ON s.employee_id = e.id
```
Each alias (`e`, `de`, `d`, `s`) resolves to its respective table.

### CTE Support
```sql
WITH active_employees AS (
  SELECT * FROM employee WHERE status = 'active'
)
SELECT ae.first_name
FROM active_employees ae
WHERE ae.department_id = 1
```
The `ae` alias resolves to the CTE `active_employees`.

## Integration

The alias completion is automatically available in the SQL editor. No configuration required.

### API

```typescript
import { extractAliases, resolveAlias } from '@/lib/sql';

// Extract aliases from a query
const { aliases } = extractAliases('SELECT * FROM employee e WHERE e.id = 1');

// Resolve an alias
const tableName = resolveAlias('e', aliases); // Returns 'employee'
```

## Type Definitions

```typescript
interface TableAlias {
  alias: string;           // e.g., 'e'
  tableName: string;       // e.g., 'employee'
  schema?: string;         // e.g., 'employees'
  source: 'from' | 'join' | 'cte';
}

interface AliasExtractionResult {
  aliases: Map<string, TableAlias>;
  hasTableReferences: boolean;
}
```

## Related Files

| File | Description |
|------|-------------|
| `src/lib/sql/types.ts` | Type definitions |
| `src/lib/sql/alias-extractor.ts` | Core parsing logic |
| `src/lib/sql/index.ts` | Module exports |
| `src/components/QueryEditor.tsx` | Monaco Editor integration |
