# Editor Documentation

Reference docs for LibreDB Studio's SQL editor (Monaco-based) and the query
execution pipeline behind it.

| Doc | Covers |
|-----|--------|
| [Monaco Performance](monaco-performance.md) | Editor responsiveness — uncontrolled component pattern, RAF-buffered AI streaming, memoized schema props, completion caching |
| [SQL Alias Completion](sql-alias-completion.md) | Context-aware autocompletion with table-alias resolution (`FROM`/`JOIN`/CTE), the completion provider, and the alias extractor |
| [Query Optimization](query-optimization.md) | Query pagination, silent auto-limiting, Load More, background `EXPLAIN`, and performance insights |

## Source map

| Area | Source |
|------|--------|
| Editor component | `src/components/QueryEditor.tsx` |
| Completion provider | `src/lib/editor/sql-completions.ts` |
| Alias extraction | `src/lib/sql/alias-extractor.ts` |
| Query limiting | `src/lib/db/utils/query-limiter.ts` |
| Visual EXPLAIN | `src/components/VisualExplain.tsx` |
