# Editor Documentation

Reference docs for LibreDB Studio's SQL editor (Monaco-based) and the query
execution pipeline behind it.

| Doc | Covers |
|-----|--------|
| [Monaco Performance](monaco-performance.md) | Editor responsiveness — uncontrolled component pattern, memoized schema props, completion caching, one-CTE schema fetch. A historical record of one optimization pass; passages about since-deleted code are marked as such |
| [SQL Alias Completion](sql-alias-completion.md) | Context-aware autocompletion with table-alias resolution (`FROM`/`JOIN`/CTE), the completion provider, and the alias extractor |
| [Query Optimization](query-optimization.md) | Query pagination, silent auto-limiting, Load More, result-level signals (engine warnings, declared column types), background `EXPLAIN`, and performance insights |

## Asset loading

Monaco is served from studio's own origin, never a CDN — `bun run dev` / `bun run build` stage
`node_modules/monaco-editor/min/vs` into `public/monaco/vs` (`scripts/copy-monaco.mjs`) and
`src/lib/editor/monaco-loader.ts` points `@monaco-editor/react`'s AMD loader at that path,
replacing its `cdn.jsdelivr.net` default. The workspace therefore issues zero off-origin
requests and works air-gapped (`e2e/offline-editor.spec.ts` asserts exactly that).

Deployments that serve the bundle elsewhere — a sub-path mount, or platform embedding the npm
package, which does not ship `public/` — set `NEXT_PUBLIC_MONACO_VS_PATH`.

## Source map

| Area | Source |
|------|--------|
| Editor component | `src/components/QueryEditor.tsx` |
| Monaco loader config | `src/lib/editor/monaco-loader.ts` |
| Asset staging | `scripts/copy-monaco.mjs` |
| Completion provider | `src/lib/editor/sql-completions.ts` |
| Tab type / language ladder | `src/lib/editor/tab-language.ts` |
| Non-SQL command languages | `src/lib/editor/libredb-language.ts`, `src/lib/editor/redis-language.ts` |
| Alias extraction | `src/lib/sql/alias-extractor.ts` |
| Query limiting | `src/lib/db/utils/query-limiter.ts` |
| Visual EXPLAIN | `src/components/VisualExplain.tsx` |
