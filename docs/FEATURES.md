# LibreDB Studio Expert Features

## Implemented Features

### 1. Monaco SQL IDE Experience
*   **VS Code Engine:** Integrated Monaco Editor for a professional coding environment.
*   **Pro SQL Autocomplete:** Advanced schema-aware completion for tables, columns (`table.col`), SQL keywords, and built-in functions.
*   **SQL Formatter:** Built-in "Format" button and `Alt + Shift + F` shortcut for clean, readable SQL code.
*   **Custom DB Theme:** Specialized `db-dark` theme for high-contrast SQL syntax highlighting.
*   **Power Snippets:** Integrated templates for CTEs, Joins, and complex CRUD operations.
*   **Modern Editor Specs:** Font ligatures, smooth scrolling, bracket pair colorization, and parameter hints enabled.
*   **Keyboard Shortcuts:** `Cmd/Ctrl + Enter` to execute, `Alt + Shift + F` to format.

> See [`docs/editor/`](editor/) for the editor internals — completion provider, alias resolution, and performance design.

### 2. Multi-Tab Query Management
*   **Workspace Tabs:** Open multiple queries simultaneously in separate tabs.
*   **Independent Results:** Each tab maintains its own execution state and results grid.
*   **Persistent Tabs:** Switch between tasks without losing your work.

### 3. Pro Data Grid (Excel-Style)
*   **High Performance:** Virtualized rendering using TanStack Virtual for smooth scrolling through millions of rows.
*   **Inline Editing:** Double-click any cell to edit data directly; apply pending cell changes as one `UPDATE` per edited row or discard them. Offered only where the provider declares `supportsInlineRowEdit`. ClickHouse, Druid, Elasticsearch, OpenSearch, Trino, Cassandra, MongoDB, Redis and LibreDB show no editing control at all because they have no single-table row update - on Cassandra because CQL requires the WHOLE primary key restricted by equality while the editor names one column it guessed from the result fields, so a clustered table answers "Some partition key parts are missing" (measured) — on Trino because it declares no primary key for any table in any catalog, so the generated `WHERE` could not identify one row — on the two search engines `UPDATE` is absent from the SQL grammar itself, measured on both; Couchbase shows none because the document key reaches the grid as a projection alias the generated `WHERE` cannot address.
*   **Data-Type Formatting:** Specialized rendering for Numbers, Booleans, and Nulls.
*   **Column Management:** Resizable columns and advanced sorting.

### 4. Visual EXPLAIN (Query Analyzer)
*   **Performance Visualization:** Visual execution plan to identify performance bottlenecks.
*   **Detailed Metrics:** Graphical representation of database scan types, join operations, costs, and execution times.
*   **Multi-DB Support:** PostgreSQL and MySQL JSON plans, SQLite and libSQL `EXPLAIN QUERY PLAN`, DuckDB `EXPLAIN (FORMAT JSON)` physical-plan trees, Couchbase SQL++ plan trees, ClickHouse JSON plan trees, Apache Druid native-query plan trees, and Apache Trino `EXPLAIN (FORMAT JSON)` plan trees. Trino is where the estimate/analyze distinction is load-bearing rather than cosmetic: measured on 476, `EXPLAIN (FORMAT JSON) INSERT …` left the target table at 0 rows while `EXPLAIN ANALYZE INSERT …` took it to 1, so only the planning form is ever emitted — a background estimate that reaches S3, Iceberg or Hive twice is a real bill. Providers without a real analyze mode hide the toggle instead of degrading to an estimate, and providers with no plan at all hide the button and the tab: Cassandra declares `supportsExplain: false` and no `explainFormat` because `EXPLAIN` is not in CQL's grammar at all (`no viable alternative at input 'EXPLAIN'`) - its only substitute is tracing, which profiles a statement that has already run and is therefore not a plan. Elasticsearch and OpenSearch declare the same pair, because neither answer is a plan this repo can render on both products: measured, `EXPLAIN SELECT …` on Elasticsearch 9.1.4 returns one `keyword` column of its own internal plan text, while the same statement on OpenSearch 3.8.0 is refused outright (`SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE, SHOW or DESCRIBE"). A tab that works on one of two products behind one code path is worse than no tab. A plan also shows only the numbers its planner actually reports: Druid emits no cost and no row estimate, so its nodes carry structure and no metrics rather than invented ones.

### 5. AI Query Assistance (Multi-Provider LLM)
*   **AI SQL Explanation:** One-click "AI Explain" button to translate complex SQL logic into plain English for easier debugging and onboarding.
*   **Schema-Aware Context:** The schema of the connected database is sent as context, so an explanation or a description names your own tables and columns.
*   **Streaming Responses:** Answers are streamed token-by-token from the configured model.
*   **Flexible LLM Support:** Choose Gemini (default `gemini-2.5-flash`), OpenAI, Ollama, or a custom provider via environment configuration.
*   **AI Intelligence Suite:** Query Safety checks and AI-generated schema descriptions.

### 6. Multi-Database Engine Support
*   **Strategy Pattern Architecture:** Modular, extensible database provider system with clear separation by database category.
*   **SQL Databases:**
    *   **PostgreSQL:** Full support with connection pooling (`pg`), schema inspection, and maintenance tools.
    *   **MySQL:** Full support with connection pooling (`mysql2`) and `performance_schema` integration.
    *   **SQLite:** File-based database support via the runtime's built-in driver — `bun:sqlite` under Bun, `node:sqlite` under Node (the storage layer uses `better-sqlite3`).
    *   **Oracle:** Full support with connection pooling (`oracledb`); introspection/monitoring via the `ALL_*`/`DBA_*` data-dictionary views.
    *   **SQL Server:** Full support with connection pooling (`mssql`); monitoring via DMVs (`sys.dm_*`).
    *   **ClickHouse:** Full support with **no driver dependency** — SQL over the documented HTTP interface, so the SQL editor and limiter both apply. Column types read verbatim from `system.columns`, JSON EXPLAIN plan trees, and `OPTIMIZE TABLE` / table-statistics / query-kill maintenance.
    *   **Apache Druid:** Read-only support with **no driver dependency** — SQL over `POST /druid/v2/sql` on the Router (8888) or the Broker (8082), so the SQL editor and limiter both apply. Datasources and column types from `INFORMATION_SCHEMA`, native-query EXPLAIN plan trees, and monitoring from `sys.segments` / `sys.servers` / `sys.tasks`. Read-only is the engine, not the integration: Druid SQL has no `UPDATE`, no `DELETE` and no `CREATE TABLE`, and no maintenance operation is reachable from SQL, so those controls are reported as unsupported instead of failing when used.
    *   **Apache Trino:** Full query support with **no driver dependency** — SQL over Trino's own client protocol (`POST /v1/statement`, port 8080), so the SQL editor and limiter both apply. Trino is a query *engine*, not a database, and the integration says so everywhere it matters. The connection's Database field pins one **catalog** (the tree is catalog-scoped and two levels deep; cross-catalog queries still run by qualifying names in full), the schema tree comes from that catalog's `information_schema`, monitoring from `system.runtime` and `jmx`, and row counts and sizes from a real `SHOW STATS` per table. What it declares as absent is absent from the engine, not from the integration: Trino's `information_schema` holds eight views and neither `table_constraints` nor `key_column_usage`, so no connector can declare a key through it — no primary keys, no foreign keys, no indexes, ER edges or inline row editing anywhere. It stores nothing, so the size panels name the catalogs and their connectors instead of inventing a footprint. Writes are the connector's decision rather than the engine's, and its refusal is shown verbatim. EXPLAIN renders as a plan tree from `EXPLAIN (FORMAT JSON)`, and never from `EXPLAIN ANALYZE`, which executes the statement. Query cancellation is real (`DELETE /v1/query/{id}`; abandoning a request does *not* stop the work), and `kill` is the one maintenance operation. Two traps a user meets immediately: a failed statement arrives as **HTTP 200** with the failure in the document, and a password is refused over plain HTTP even on a cluster with authentication disabled.
    *   **libSQL:** Full SQL support with **no driver dependency** - SQLite's own dialect over the Hrana protocol (`POST /v2/pipeline`, port 8080), reaching both a self-hosted libSQL server (`sqld`) and Turso Cloud through ONE type-id, because they speak the same protocol and embed the same SQLite (3.47.0 on both, measured). The credential is an auth **token** rather than a password - libSQL has no user names - so the connection dialog labels the field that way and takes the `libsql://<database>-<org>.turso.io?authToken=<jwt>` URL Turso's CLI prints. Introspection is SQL (`sqlite_master`, the `pragma_*` functions) and the sizes are real: `dbstat` answers on both deployments, which the file-based SQLite driver under Bun cannot do at all, so tables and indexes report measured bytes. What is absent is the server's decision rather than the integration's: `VACUUM`, `ANALYZE`, `PRAGMA optimize` and `PRAGMA wal_checkpoint` are all refused by its statement allowlist, so only Reindex and Integrity Check are offered; `PRAGMA query_only` is refused too, which is why agent mode's read-only profile does not extend here. There is no session, no uptime and no statement history to show, because Hrana is stateless and libSQL publishes none of them.
    *   **DuckDB:** Full SQL support against an EMBEDDED analytical engine — the whole connection is a file path (or `:memory:`) on the server this app runs on, so there is no host, no port and no credential, and the driver (`@duckdb/node-api`) is a native N-API addon loaded in-process. `EXPLAIN (FORMAT JSON)` physical-plan trees, `duckdb_*` catalog introspection, real per-table bytes derived from `pragma_storage_info` block allocation, and query cancellation through the connection's own `interrupt()`. Three maintenance operations only — `VACUUM`, `ANALYZE` and `CHECKPOINT` — because `REINDEX` is a parser error on this engine and neither `PRAGMA integrity_check` nor `PRAGMA optimize` exists. It publishes no slow-query log and no session list, so those panels say so rather than reporting a zero, and the file admits exactly ONE operating-system process, refused in read-only mode too.
    *   **Apache Cassandra:** Full CQL support over the native protocol (port 9042) through `cassandra-driver` - pure JavaScript, so no native module reaches any distribution channel. The connection pins one **keyspace** (the `database` field) and carries a **`localDataCenter`**, which no other engine here needs and the driver refuses to connect without. The schema tree marks partition and clustering keys and orders columns partition-key-first, because declaration order is genuinely unrecoverable: `system_schema.columns.position` is -1 for every regular column and the rows arrive alphabetically. What it does NOT report is the point: **no row count and no size anywhere**, because Cassandra publishes neither honestly - `system.size_estimates` counts partitions per token range from flushed files (measured at 143 for a 500-row clustered table, 525 for a 500-row flat one) and `system_views.disk_usage` is whole mebibytes (`1 MiB` for 19,476 bytes) - so the object browser, the overview and the table, index and storage panels show nothing rather than something wrong. There is no EXPLAIN (the keyword is not in CQL), no cancellation (the protocol has no cancel frame), and no maintenance operation (compaction, repair, flush and cleanup are all `nodetool` actions over JMX). Values are normalized once at the driver boundary: a `blob` reaches the grid as `0x…` rather than a Buffer document, a `bigint`/`decimal`/`varint` as its exact digits, a `vector<float,3>` as an array and a `duration` as `1mo2d3h`.
*   **Search Engines:**
    *   **Elasticsearch / OpenSearch:** Read-only support with **no driver dependency** — SQL over `POST /_sql?format=json` (Elasticsearch) and `POST /_plugins/_sql` (OpenSearch), port 9200 on both. Two type-ids share one provider module because the two products differ only in wire detail. Indices become tables and mapped fields become columns, read from `_mapping` rather than from `SELECT *`: measured on Elasticsearch 9.1.4, an index mapping a `flattened` and a `nested` field answers `SELECT *` with **no columns at all**, so the mapping is the only honest source. Cluster health, per-index document counts and store sizes come from `_cluster/health`, `_cluster/stats` and `_cat/indices`. Read-only is the engine, not the integration: neither grammar has `INSERT`, `UPDATE` or `CREATE TABLE`, so `supportsCreateTable`, `supportsInlineRowEdit`, `supportsExplain` and `supportsMaintenance` are all false and those controls are hidden rather than offered and then failed. Elasticsearch SQL also has no `OFFSET` — measured, `LIMIT 2 OFFSET 1` is HTTP 400 there and HTTP 200 on OpenSearch — so on Elasticsearch a request for a second page is refused with that reason instead of returning page one again. ES|QL is deliberately unused: it exists on one of the two products, so it cannot be the shared query language.
*   **Document Databases:**
    *   **MongoDB:** Full support with official driver, JSON-based MQL queries, automatic schema inference, and aggregation pipelines.
    *   **Couchbase:** Full support with **no driver dependency** — SQL++ over the documented Query and management REST APIs, so the SQL editor and limiter both apply. Buckets/scopes/collections flattened into the schema explorer, `INFER`-based column inference, visual EXPLAIN plans, and read-your-writes query consistency by default.
*   **Key-Value Stores:**
    *   **Redis:** Full support via the official `ioredis` driver — plain-command and JSON query styles, prefix-grouped key "schema" through a non-blocking `SCAN`, and `INFO`/`SLOWLOG`/`CLIENT LIST`-derived health and metrics.
*   **Embedded Stores:**
    *   **LibreDB:** Support for embedded, server-less `.libredb` files via the `@libredb/libredb` package — a small get/put/delete/prefix/range command grammar over the key-value lens, with catalog-aware schema views for relational and document namespaces.
*   **Connection Pooling:** Configurable pool settings (min/max connections, idle timeout) for production workloads.
*   **Query Timeout:** 60-second default timeout with per-provider configuration.

### 7. Database Health Dashboard (Live Stats)
*   **Real-time Monitoring:** Track active connections, database size, and cache hit ratios.
*   **Performance Insights:** Automatic detection of the slowest queries in your database.
*   **Session Management:** View and monitor active database sessions and their current states.
*   **Visual Gauges:** Intuitive dashboards for quick health assessments.

### 8. Advanced Schema Explorer (2025 Edition)
*   **Deep Tree Inspection:** Expand tables to view column definitions, data types, and Primary Key (PK) constraints with intuitive iconography.
*   **Global Search & Filter:** Real-time, high-performance filtering across both table names and column names.
*   **Precision Row Counts:** Optimized PostgreSQL integration using `pg_class` statistics for fast, accurate (estimated) row counts even on large datasets.
*   **Visual Table Designer:** Create new tables directly from the explorer with a modern, column-based UI. No SQL knowledge required for basic structures.
*   **Contextual Actions:** Quick access menus for each table including "Select Top 50", "Generate Query", and "Copy Name". Action labels adapt per provider (e.g. "Scan Keys" for Redis, "Find Documents" for MongoDB).
*   **DBA Quick Tools:** (Admin Only) Instant access to "Analyze Table" and "Vacuum Table" directly from the table context menu, on the providers whose rows are real objects. A key-value provider such as Redis, whose rows are derived key-prefix groupings, offers neither -- there is no table for the maintenance page to act on.
*   **Visual Clarity:** Modern glassmorphic design with Framer Motion animations for smooth transitions.
*   **Database Stats:** Integrated table counts and connection health monitoring directly in the sidebar.

### 9. DBA Maintenance Toolkit (Admin Exclusive)
*   **Centralized Control Panel:** Dedicated "Database Maintenance" modal for high-level administration tasks.
*   **Global Optimizations:** Trigger database-wide `ANALYZE`, `VACUUM`, and `REINDEX` operations to maintain peak performance.
*   **Live Session Management:** Real-time monitoring of active database PIDs (Process IDs).
*   **Process Termination:** Ability to safely terminate (kill) hung or resource-intensive queries with a single click.
*   **Health Dashboard Integration:** Real-time feedback on connection states and session durations.

### 10. AI Reliability & Error Management
*   **Intelligent Error Handling:** Comprehensive English error messages for API quotas, rate limits, and service availability issues.
*   **In-Place Error Alerts:** An AI feature that fails says so where it was invoked — the Query Safety dialog and the schema-documentation panel each render the failure inline instead of leaving a spinner or an empty result. (The in-editor AI panel that used to hold these alerts was removed; the alerts were not.)
*   **Graceful Degradation:** Robust backend logic to handle API timeouts and authentication failures without crashing the UI.

### 11. DevOps & Enterprise Deployment
*   **Containerization Ready:** Optimized Dockerfile using multi-stage Bun builds for minimal image size.
*   **Kubernetes Support:** Pre-configured `standalone` Next.js mode plus an official Helm chart for production orchestration.
*   **Local Development Pro:** Integrated `docker-compose` setup for consistent environment across the entire team.
*   **Multi-Channel Distribution:** Beyond Docker/Helm, install via `npx @libredb/studio`, the Homebrew tap, `.deb`/`.rpm` packages (systemd service), or Snap — all backed by the same standalone server payload. See [`docs/DISTRIBUTION.md`](DISTRIBUTION.md).
*   **Zero-Config First Run:** Missing `JWT_SECRET`/`ADMIN_PASSWORD` are generated at boot and printed once; native channels bind to `127.0.0.1` by default, while Docker/Helm resolve their own address at startup and prefer a dual-stack `::`. Set `AUTH_BOOTSTRAP=off` for strict production mode requiring explicit secrets.

### 12. Advanced Query History (DBA-Level)
*   **Full Audit Trail:** Searchable history of every query executed, including SQL content, success status, and error details.
*   **Performance Tracking:** Precise execution time measurement (ms) for every query to identify slow operations.
*   **Metadata Insights:** Automatic tracking of execution timestamps and row counts for historical analysis.
*   **Instant Restore:** Re-run any previous query with a single click directly from the history panel.

### 13. Saved Queries Library
*   **Query Repository:** Save complex queries with custom names, detailed descriptions, and organizational tags.
*   **Schema Filtering:** Automatically organizes queries based on the target database/schema to reduce clutter.
*   **Team Knowledge Base:** Centralized storage for frequently used business logic and maintenance scripts.

### 14. Enterprise Results Hub
*   **Tabbed Workspace:** Professional interface managing Results, History, and Saved Queries in one unified panel.
*   **Live Metrics:** Real-time feedback on query performance and status directly in the results header.
*   **Editor Integration:** Seamlessly save current editor content or load previous scripts with dedicated UI controls.

### 15. Professional Data Export
*   **Format Versatility:** Instantly export query result sets to CSV, JSON, SQL `INSERT` statements, or a generated `CREATE TABLE` DDL.
*   **Developer-Ready:** Clean data output optimized for external analysis, reporting, or database migrations.
*   **Formula-Safe CSV:** A cell whose value starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe, so a spreadsheet shows it as text instead of evaluating it when the file is opened; this is unconditional and has no setting, and a plain number such as `-12.5` is left exactly as it is.

### 16. Authentication & Identity Management
*   **Secure User Onboarding:** Full-featured login/logout flows and session management via Next.js middleware and API routes.
*   **OIDC Single Sign-On:** Optional SSO via OpenID Connect (Auth0, Keycloak, Okta, Azure AD) using PKCE, mapping to the same local JWT session as email/password auth. See [OIDC](OIDC.md).
*   **Context-Aware UI:** Personalized experience based on authenticated user state (e.g., "Me" endpoint integration).
*   **Enterprise Security First:** Environment variable protection with `.env.example` templates and strict Git tracking policies for credentials.

### 17. Visual Schema Explorer (ERD)
*   **Interactive Entity-Relationship Diagrams:** React Flow–powered visualization of tables and their foreign-key relationships.
*   **Pan, Zoom & Reposition:** Freely navigate large schemas and drag nodes into place.
*   **Search & Filter:** Locate tables by name, with compact and detailed view modes.
*   **Export:** Save diagrams as SVG or PNG for documentation.

### 18. The Database Agent (read-only investigation runs)
*   **A run, not a chat:** you state an objective and press Start; the run drafts SQL against the connected database, reads the results, and composes a report whose every claim cites the result it came from. An uncited claim is refused, so it cannot be composed at all.
*   **Read-only, enforced by the database:** every statement the agent runs goes through the agent's own audited pipeline — a policy decision, an audit event and budget accounting before the driver is touched (`executeAuditedOperation`, `src/lib/db/operations/execution.ts:129`) — under a read-only execution profile: a read-only transaction on PostgreSQL, `PRAGMA query_only` re-asserted per statement on SQLite, and a `READ_ONLY` engine handle plus an SQL-level guard on DuckDB — the flag alone is not a filesystem sandbox, since `COPY … TO`, `EXPORT DATABASE`, `INSTALL`/`LOAD` and the local-file table functions all succeed under it. Writes and DDL are refused before the database is reached, and `EXPLAIN ANALYZE` is default-denied because it would execute the statement. The pipeline is the agent's alone and is not shared with the editor: a statement you run yourself calls the provider directly (`src/app/api/db/query/route.ts:44`), receiving neither the policy decision nor the audit event.
*   **Agent mode is PostgreSQL, SQLite and DuckDB only — except Operate:** the read-only profile is database-native, so it exists only where a provider implements `queryReadOnly` — `postgres.ts:915`, `sqlite.ts:537` and `duckdb/index.ts:525`, and no other provider does. On MySQL, Oracle, SQL Server, libSQL, MongoDB, Redis, ClickHouse, Druid, Couchbase, Elasticsearch, OpenSearch, Trino or Cassandra an Agent-mode run ends `engine-unsupported` (`src/lib/agent/runtime.ts:199`). The search providers implement no `queryReadOnly` and could not: their SQL grammars have no transaction and no session-scoped setting to make read-only, and the surface is already read-only in the grammar itself, which is a different guarantee from one the database enforces per statement. The **Operate** workflow is the exception and runs on every engine, because it sends no SQL at all: it reads the engine's own reporting interface, which every provider implements. Plan mode opens on every connection: its model is handed no tools, so no read-only profile has to be acquired for it. It is not blind, though — since 2026-08-15 the server reads the connection's schema and the engine's own estimated statistics before the model's first turn. That **grounding** reaches every engine: on PostgreSQL and SQLite the server composes catalog statements and reads them through that same read-only path, and on every other connection it asks the provider to describe its own schema — the reading the sidebar already performs when it lists your tables, which needs no read-only statement path. So the two limits are separate ones: agent mode is those two engines, grounding is all of them, and a run whose reading fails — refused, overran its time, or rejected by the engine — says so rather than inventing tables.
*   **Two independent axes:** the **mode** (Plan, whose model is toolless and whose deliverable is one statement for you to run yourself — the run executes no statement of yours and writes nothing — or Agent) and the **workflow** (Investigate, Optimize, Assess, Operate). Both are fixed when the run opens and read from the run's own record thereafter.
*   **Operate reads the live server, not its tables:** the slowest queries, who is connected and what is blocked, table and index statistics, storage and health — each a curated reading the server takes through the provider's own reporting interface, stored as an ordinary citable artifact. Every reading is a point in time, and both the prompt and the timeline say so rather than letting a report imply a trend was measured.
*   **Counts, never values:** the Assess workflow's table profiling composes aggregates only — row counts, present counts, distinct counts, and shape matches computed inside the database. There is deliberately no `min`/`max`, because on a text column those return real values.
*   **Bounded and visible:** 20 statements, 60 s of database time, 200 rows per read, a 5-minute run deadline, 3 repair attempts — with the meter on screen, and stated as a floor rather than an exact spend.
*   **A verdict beside the status:** a run that ended `succeeded` may still have answered nothing, so the rail says "Run answered" or "Run did not answer" and names what was missing.
*   **Your own model, standalone only:** Gemini, OpenAI, Ollama or any OpenAI-compatible endpoint through the existing `LLM_*` settings; the embedded `@libredb/studio` package carries no agent surface. See [Agent Guide](AGENT_GUIDE.md), [Agent Data Flow](AGENT_DATA_FLOW.md) and [Agent Runtime](AGENT.md).

## Roadmap

Upcoming phases are tracked in the [Roadmap section of the README](../README.md#roadmap).
