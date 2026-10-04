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

src/lib/editor/
└── sql-completions.ts   # Monaco completion provider (consumes the alias extractor)
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

#### 2. Completion Provider (`src/lib/editor/sql-completions.ts`)

Monaco Editor completion provider that integrates with the alias extractor. It is implemented as
`registerSQLCompletionProvider(monaco, schemaCompletionCache)`, which calls
`registerCompletionItemProvider('sql', …)` with trigger characters `.` and space. It is registered
from `src/components/QueryEditor.tsx` in a `useEffect` that returns the disposable for cleanup.

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
- **Statement-limited parsing**: Parses the text from the start to the cursor plus the rest of
  the cursor's statement, up to its `;`. The part after the cursor is read because an alias is
  often defined there: in `SELECT c. FROM e2e.customers c`, `c.` offered nothing while only the
  text before the cursor was read (#1397). It stops at the terminator, so a later statement's
  alias of the same name is not taken.
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

## Containers and qualified names

The editor holds each table's address as well as its name, and the session's default container
as the object inventory reported it (`defaultContainer`). Three rules follow (#1397):

- **A table outside the default container inserts its qualified address.** On PostgreSQL 18.6, a
  `sales.regions` with `sales` off the search path used to insert `regions`, which runs as
  `relation "regions" does not exist`; it now inserts `sales.regions`, each segment quoted the
  way the dialect needs. A table in the default container keeps its bare name. Where no default
  was reported (the embedded workspace), every table keeps its bare name.
- **A container qualifier offers that container's tables.** `sales.`, a MySQL `e2e_other.` or a
  ClickHouse `demo.` lists the tables of that schema or database, matched against the trailing
  segments of each table's container, and inserts each by its own name after the qualifier
  already typed. Columns of a table or alias with that name still come first.
- **A row count is shown only where the engine measured one.** A table whose count is absent
  reads `Table`, not `Table (0 rows)`; RisingWave 3.1.0 reports no count for a four-row table.

Qualified segments are quoted the way the dialect needs: PostgreSQL with its keyword-aware
rule, every other engine through the connection's own identifier quoting, so a MySQL database
named `e2e-other` is inserted as `` `e2e-other` ``.

### Known limits

- A `;` inside a string or comment after the cursor ends the statement early. The aliases
  defined after it are not read, which is the old before-the-cursor behaviour, not a wrong one.
- A quoted qualifier such as `"Sales".` is not matched against containers; only bare
  identifiers are.
- Matching a qualifier is case-insensitive, so on an engine where two containers differ only
  in case, both containers' tables are offered.
- A qualifier longer than a table's container path matches nothing: a Trino
  `catalog.schema.` against a one-segment path offers no tables.

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
| `src/lib/sql/alias-extractor.ts` | Core alias parsing logic (`extractAliases`, `resolveAlias`) |
| `src/lib/sql/types.ts` | Type definitions (`TableAlias`, `AliasExtractionResult`) |
| `src/lib/sql/index.ts` | Module exports |
| `src/lib/editor/sql-completions.ts` | Monaco completion provider (dot/space-triggered; consumes the alias extractor) |
| `src/components/QueryEditor.tsx` | Hosts the Monaco editor and registers the provider |
