# Query Optimization & Performance Features

LibreDB Studio includes enterprise-grade query optimization features to prevent system freezes and provide performance insights for DBAs, data engineers, and developers.

## Table of Contents

- [Query Pagination System](#query-pagination-system)
- [Silent Auto-Limiting](#silent-auto-limiting)
- [Destructive-Statement Confirmation](#destructive-statement-confirmation)
- [Load More Functionality](#load-more-functionality)
- [Result-Level Signals](#result-level-signals)
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
2. System automatically adds `LIMIT 500` if no LIMIT exists (an `OFFSET` clause is only appended when the offset is greater than 0). The clause is inserted at the end of the statement itself, before any trailing comment or `;` — see [Where the bound is placed](#where-the-bound-is-placed)
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
| SELECT behind a leading comment | Yes |
| SELECT ending in a comment | Yes (the bound is placed before the comment), except a `#` comment — see below |
| SELECT with LIMIT | No (preserved) |
| SELECT with UNION | Yes (LIMIT appended after the last statement) |
| Read-only CTE (`WITH … SELECT`) | Yes |
| Data-modifying CTE (`WITH … INSERT`/`UPDATE`/`DELETE`/`MERGE`) | No — the bound would apply to the rows the statement writes, committing only part of it |
| INSERT/UPDATE/DELETE | No |
| DDL (CREATE, ALTER) | No |

The statement's type is read from its first keyword that is neither whitespace nor a comment
(`src/lib/sql/leading-keyword.ts`), so `-- note`, `/* note */` and MySQL's `# note` before a `SELECT`
are skipped and the limit is still applied. Before this, an annotated `SELECT` was classified as an
unknown statement type and returned **every** row while the badge reported it as not limited.
An already-bounded annotated statement (`LIMIT n`, `FETCH FIRST n ROWS ONLY`, `SELECT TOP n`) is
still recognised as bounded and is not limited twice.

A statement leading with `WITH` is typed by the keyword its CTE list **operates** — the first one
after the list, read by walking the list's grammar in `src/lib/sql/operative-keyword.ts`. A list
element is read in either of the two shapes the supported dialects use: the standard
`name [(cols)] AS [[NOT] MATERIALIZED] (body)`, and ClickHouse's `<expr> AS <alias>`
(`WITH now() AS ts SELECT …`, `WITH 1 AS one SELECT …`) — an element the walker cannot cross ends the
reading, and the statement then loses its bound, which is what happened to ClickHouse's own CTE idiom
between the two fixes. The shapes are told apart by whether the element's head reads as a name and by
what follows its `AS`: a body or one of PostgreSQL's inlining hints can only be the standard shape,
anything else is an alias. Asking
instead whether the text contained `SELECT` let the `INSERT INTO … SELECT` idiom answer for its own
statement: a data-modifying CTE was typed `SELECT`, received a `LIMIT`, and in PostgreSQL that bound
applies to the rows the statement **writes** — it committed at most 500 of them while the badge
reported a truncated result set. Where the reader cannot cross the CTE list, the statement is not
treated as a `SELECT` and is not bounded: an over-large read can be re-run, a partly committed write
cannot be undone.

That covers most malformed input (an unclosed body, a missing `AS`, an unterminated comment or
literal) and, deliberately, two **well-formed** forms the reader does not walk — so they lose their
bound and return every row:

| Form | Why it is not read | Effect |
|------|--------------------|--------|
| PostgreSQL's `SEARCH` / `CYCLE` clause after a recursive CTE list | sits between the list and the operative keyword; the reader stops at the first word after the list | rare |
| An expression element aliased with an inlining hint (`WITH col AS materialized SELECT …`) | the hint commits the element to the standard shape, which then expects a body | rare, and the alternative reading would let `WITH t AS NOT LAZY (…)` report `LAZY` as the operative keyword |

Both are reads, so the cost is an unbounded result set rather than a partial write, and both are
pinned by tests in `tests/unit/sql/operative-keyword.test.ts` so the gap stays a decision.

The reverse also has a narrow case, pinned in the same file: reading an expression element means
knowing where it ends only by its `AS`, so any element the standard shape **declines** — a head that is
not a name, or an `AS` with no body after it — is re-read as an expression that ends at the first
`AS <name>` at depth 0, however far away. `WITH 2 INSERT INTO users AS u SELECT 1` and
`WITH x AS DELETE, foo AS (SELECT 1) SELECT 1` therefore answer `SELECT` and receive a bound. No
supported dialect accepts such text, so what the server receives is a rejected statement either way
rather than a partly limited write.

### Where the bound is placed

The clause is inserted **between the statement and its trailing trivia** — whitespace, comments and
the terminating `;` — and the trivia is re-attached verbatim. A statement carrying no trailing trivia
is emitted exactly as it was before this rule existed.

| Statement | Emitted SQL |
|-----------|-------------|
| `SELECT * FROM t` | `SELECT * FROM t LIMIT 500` |
| `SELECT * FROM t;` | `SELECT * FROM t LIMIT 500;` |
| `SELECT * FROM t -- note` | `SELECT * FROM t LIMIT 500 -- note` |
| `SELECT * FROM t; -- note` | `SELECT * FROM t LIMIT 500; -- note` |
| `SELECT * FROM t /* note */` | `SELECT * FROM t LIMIT 500 /* note */` |

Appending after the trivia instead put the bound **inside** a trailing line comment: the engine ran
the statement unbounded while the badge reported it as capped, and the re-appended `;` ended up
inside the comment as well.

The same reading of the end answers "is this statement already bounded". The `LIMIT n`,
`FETCH FIRST n ROWS ONLY` and `OFFSET n` probes are anchored at the end of the **statement**
(`src/lib/sql/statement-end.ts`), so:

- a bound written inside a trailing comment (`SELECT … -- LIMIT 10`) is not mistaken for a real one,
  and the statement is bounded;
- a real bound followed by a comment (`SELECT … LIMIT 10 -- deliberate`) is still detected, honoured
  and never doubled — a second bound is a syntax error, not extra rows.

Reading where a statement ends and **cutting** it there are separate answers, because they are not
equally risky: a probe that stops early merely finds no bound, while a clause inserted early lands in
the middle of the statement and the server rejects it outright. Two shapes are therefore read but not
cut, and a statement carrying either is **returned untouched with `wasLimited: false`** — the second
branch of "never `true` alongside a bound the engine cannot see":

| Shape | Why the cut is refused |
|-------|------------------------|
| An unterminated comment or literal, or a quote behind an odd backslash run (`… WHERE name = 'O\'Brien'`) | MySQL escapes with backslashes and PostgreSQL does not, so the two close the literal in different places; inserting on a guess puts the bound after the statement's own `;` |
| A `#` run at the end of the statement (`SELECT * FROM #tmp`, `… WHERE ID# = 1`, `SELECT flags # 5`) | `#` is MySQL's second comment marker and ordinary code elsewhere — a T-SQL temp table, an Oracle identifier, a PostgreSQL XOR — and nothing in the text tells them apart (`#note` and `#tmp` are the same characters) |

Both are a **deliberate loss of a bound**: appending after everything, as the limiter used to, was
valid SQL for the dialect in which those characters are code, and is exactly what put the clause
inside a trailing comment for the dialect in which they are not. Not bounding costs an over-large
read the user can re-run, which is the trade every reader in `src/lib/sql/` makes.

A `#` comment with code after it on a later line is unaffected. Where the cut is refused, the
statement's *text* is still read to its very end (trailing whitespace and `;` aside), so a bound
written after a `#` is still found and never doubled — which is also why MSSQL's `TOP` splice, writing
into the head, keeps bounding `SELECT * FROM #tmp` while leaving a temp-table page that already
carries a `FETCH NEXT` alone. That last part is not airtight: trailing trivia written *after* such a
bound hides it from the end-anchored probe, so the `TOP` is spliced anyway — unchanged from before
this section existed, and noted here rather than claimed closed. The
one shape that stays wrong is a bound commented out with `#` (`… # LIMIT 10`): it is still read as
real, so that statement is left alone instead of being bounded. The `--` form, which is unambiguous,
is fixed.

Providers that append a clause of their own follow the same rule: Oracle's `FETCH FIRST` and
`OFFSET … FETCH NEXT`, and MSSQL's `OFFSET … FETCH NEXT` pagination branch. MSSQL's `SELECT TOP n`
splices into the head, which no trailing comment can reach, and is unchanged. ClickHouse's refusal to
rewrite a statement ending in `FORMAT`/`SETTINGS`, and Druid's refusal to rewrite one ending in an
`OFFSET`, both read the same end — otherwise a trailing comment would hide the clause from them and
the bound placed before that comment would turn a working statement into a server-side syntax error.

### Multi-statement runs

In standalone studio, a script holding several statements is split
(`src/lib/sql/statement-splitter.ts`) and sent to `POST /api/db/multi-query`, which bounds the **last**
statement only, and only when it is a `SELECT`. Embedded in a host application the query goes to the
host's own executor and none of this route applies.

Whether that last statement *is* a `SELECT` is the shared reading described above (`isSelectQuery`),
not a pattern belonging to the route. It used to be `/^\s*SELECT\b/i`, which tolerates whitespace but
not a comment — and the splitter keeps each statement's leading comments — so a final `SELECT` behind a
`-- note` was not recognised and reached the engine unbounded, the one place the comment-tolerant
classifier had not been adopted (#281). The CTE typing applies here too: a final read-only CTE is
bounded, a final data-modifying one is not.

Last-only is that route's own policy, and it leaves a hole this section does not close: a non-final
`SELECT` runs exactly as written, and its **entire** result set travels back in `statements[i].rows`.
That is also what the grid displays whenever the final statement returns no rows of its own
(`SELECT * FROM huge; INSERT INTO t VALUES (1)`), since the response picks the last result that *has*
rows. Noted here rather than claimed closed.

Two indicators do not follow the bound onto this route, because it returns no pagination metadata at
all: the **AUTO-LIMITED badge does not appear** for a multi-statement run, and **Load More is not
offered** even when rows were capped. The bound itself is real and applied — re-run the final statement
on its own to page through it.

---

## Destructive-Statement Confirmation

Before a destructive statement runs, studio opens a confirmation dialog carrying an AI risk
analysis (`src/components/QuerySafetyDialog.tsx`). Which statements reach it is decided by the
same reading the auto-limiter uses, so the two cannot disagree about where a statement begins.

| Statement | Confirmation |
|-----------|--------------|
| `DELETE` / `DROP` / `TRUNCATE` / `ALTER` / `GRANT` / `REVOKE` / `UPDATE` | Yes |
| Any of those behind a comment (`-- note`, `/* note */`, MySQL's `# note`, several stacked) | Yes |
| A `WITH` whose CTE list precedes one (`WITH x AS (…) DELETE FROM …`) | Yes |
| A `WITH` whose CTE list *contains* an `UPDATE … SET` (PostgreSQL's data-modifying CTE) | Yes |
| `SELECT`, including one naming a destructive keyword in a string or a comment | No |

The statement's own keyword is read with `src/lib/sql/operative-keyword.ts` and tested against a
keyword set. It used to be re-derived here as six anchored patterns (`/^\s*DROP\b/i`, …), which
tolerate whitespace but not a comment — so `-- cleanup` above a `DROP TABLE` skipped the dialog
and the statement executed unconfirmed, on both the standalone and the embedded execution path.
Writing a note above a destructive statement is ordinary, and it is exactly where a confirmation
matters most.

One probe stays deliberately unanchored: a statement whose code contains `UPDATE` followed by
`SET` asks for confirmation whatever its own keyword is. PostgreSQL's data-modifying CTE is
*operated* by its `SELECT` — which is the honest answer, and the one the limiter needs so it does
not bound the rows a write commits — so anchoring this probe too would take the last check away
from a statement that really does write. It reads the statement's **code** rather than its text
(`src/lib/sql/words.ts`), so unlike the pattern before it, a read that merely quotes
`'UPDATE t SET x = 1'` or mentions it in a comment no longer prompts.

Three gaps are known and pinned by tests rather than claimed closed:

- **Only `UPDATE … SET` is looked for inside a read.** A write hidden in a CTE *body* under any
  other keyword (`WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone`) does not prompt.
  Widening the probe to `DELETE`/`INSERT`/`MERGE` would also make every read whose code names one
  of them prompt, so the asymmetry is inherited from the vocabulary above rather than chosen here.
- **A statement whose shape cannot be read at all** — an unclosed CTE list, or an undeterminable
  literal such as `'\'`, which closes the string in PostgreSQL and not in MySQL — hides what
  follows it. The text is a syntax error under at least one dialect, so the server rejects it
  either way.
- **A multi-statement script is read as one statement.** `SELECT 1; DROP TABLE users` does not
  prompt (its first keyword is the `SELECT`), while `SELECT 1; UPDATE t SET x = 1` does, because
  the unanchored probe finds it. Executing the destructive statement on its own always prompts.

Four runs bypass the gate on purpose, all on the standalone path
(`src/hooks/use-query-execution.ts`): an EXPLAIN run (see below), a Load-More page of a result the
user already has, a playground run (rolled back rather than committed), and anything carrying
`skipSafety` — which is the dialog's own "Execute Anyway" button and the inline row editor, whose
`UPDATE` comes from a grid edit the user has already confirmed. The embedded adapter
(`src/workspace/hooks/use-query-adapter.ts`) has only the force-execute bypass, so every other
query a host application runs through it reaches the gate.

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

## Result-Level Signals

Two things a result can say about itself, both optional and both filled by the provider that ran
the statement (issue #273). Neither has anything to do with auto-limiting.

### Engine Warnings

`QueryResult.warnings` carries the notices an engine attached to a run it **completed** — a
Couchbase query-service advisory, or a Druid answer admitting that some segments of the queried
data were unavailable while still answering 200. The field is **absent** when the engine reported
none, so its presence alone decides whether anything renders.

- With rows: an amber **WARNINGS badge** sits beside the AUTO-LIMITED badge in the stats bar. The
  messages are in its tooltip and are also read out by assistive technology.
- With no rows: the messages are listed outright under "Query returned no data". A result that is
  empty *because* the data was unreachable must not read as a result that is empty because the data
  is not there.

This is not the plan analysis in [Automatic Warning Detection](#automatic-warning-detection): those
are derived by the client from EXPLAIN output, these are the engine's own words about the run.

### Declared Column Types

`QueryResult.columnTypes` carries the type the wire format declared for each column of *this*
result, keyed by its name in `fields` and spelled the way the engine spells it
(`Nullable(String)`, `BIGINT`). For a computed column or an ad-hoc projection it is the only
source of a type at all — the schema tree has no catalog entry to answer with.

The type is shown beside the column name in the desktop table's header, and is part of that
header's accessible name. The compact table shown below the `md` breakpoint carries it as a
tooltip only: that table sizes its header and body cells from their own content, so visible text
in the header alone would push it out of step with the rows. A column the engine declared no type
for renders exactly as it did before.

---

## Query EXPLAIN Integration

### Automatic EXPLAIN

Every SELECT query automatically runs EXPLAIN in the background (parallel execution). This provides instant performance insights without user action.

### Supported Databases

| Database | EXPLAIN Format |
|----------|---------------|
| PostgreSQL | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` |
| MySQL | `EXPLAIN FORMAT=JSON` |
| SQLite | `EXPLAIN QUERY PLAN` (tree, no cost/timing metrics) |

### Non-SELECT Statements

EXPLAIN is built for SELECT statements only. Clicking **Explain** with anything else
(`UPDATE`, `INSERT`, DDL, …) executes nothing and reports "Only SELECT statements can
be explained" — an explain run never falls back to running the original statement,
because it deliberately bypasses the dangerous-query confirmation dialog.

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
  warnings?: QueryWarning[];             // notices the engine attached; absent when it reported none
  columnTypes?: Record<string, string>;  // declared type per column, keyed by its name in `fields`
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
