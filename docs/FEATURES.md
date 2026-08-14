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
*   **Inline Editing:** Double-click any cell to edit data directly; apply pending cell changes as one `UPDATE` per edited row or discard them. Offered only where the provider declares `supportsInlineRowEdit`. ClickHouse, Druid, MongoDB, Redis and LibreDB show no editing control at all because they have no single-table row update; Couchbase shows none because the document key reaches the grid as a projection alias the generated `WHERE` cannot address.
*   **Data-Type Formatting:** Specialized rendering for Numbers, Booleans, and Nulls.
*   **Column Management:** Resizable columns and advanced sorting.

### 4. Visual EXPLAIN (Query Analyzer)
*   **Performance Visualization:** Visual execution plan to identify performance bottlenecks.
*   **Detailed Metrics:** Graphical representation of database scan types, join operations, costs, and execution times.
*   **Multi-DB Support:** PostgreSQL and MySQL JSON plans, SQLite `EXPLAIN QUERY PLAN`, Couchbase SQL++ plan trees, ClickHouse JSON plan trees, and Apache Druid native-query plan trees. Providers without a real analyze mode hide the toggle instead of degrading to an estimate. A plan also shows only the numbers its planner actually reports: Druid emits no cost and no row estimate, so its nodes carry structure and no metrics rather than invented ones.

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
*   **DBA Quick Tools:** (Admin Only) Instant access to "Analyze Table" and "Vacuum Table" directly from the table context menu.
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
*   **Zero-Config First Run:** Missing `JWT_SECRET`/`ADMIN_PASSWORD` are generated at boot and printed once; native channels bind to `127.0.0.1` by default, while Docker/Helm bind `0.0.0.0`. Set `AUTH_BOOTSTRAP=off` for strict production mode requiring explicit secrets.

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
*   **Read-only, enforced by the database:** every statement the agent runs goes through the agent's own audited pipeline — a policy decision, an audit event and budget accounting before the driver is touched (`executeAuditedOperation`, `src/lib/db/operations/execution.ts:129`) — under a read-only execution profile: a read-only transaction on PostgreSQL, `PRAGMA query_only` re-asserted per statement on SQLite. Writes and DDL are refused before the database is reached, and `EXPLAIN ANALYZE` is default-denied because it would execute the statement. The pipeline is the agent's alone and is not shared with the editor: a statement you run yourself calls the provider directly (`src/app/api/db/query/route.ts:44`), receiving neither the policy decision nor the audit event.
*   **Agent mode is PostgreSQL and SQLite only:** the read-only profile is database-native, so it exists only where a provider implements `queryReadOnly` — `postgres.ts:870` and `sqlite.ts:397`, and no other provider does. On MySQL, Oracle, SQL Server, MongoDB, Redis, ClickHouse, Druid or Couchbase an Agent-mode run ends `engine-unsupported` (`src/lib/agent/runtime.ts:199`). Plan mode is toolless, touches no database, and carries no engine restriction.
*   **Two independent axes:** the **mode** (Plan, which is toolless and performs zero database operations, or Agent) and the **workflow** (Investigate, Optimize, Assess). Both are fixed when the run opens and read from the run's own record thereafter.
*   **Counts, never values:** the Assess workflow's table profiling composes aggregates only — row counts, present counts, distinct counts, and shape matches computed inside the database. There is deliberately no `min`/`max`, because on a text column those return real values.
*   **Bounded and visible:** 20 statements, 60 s of database time, 200 rows per read, a 5-minute run deadline, 3 repair attempts — with the meter on screen, and stated as a floor rather than an exact spend.
*   **A verdict beside the status:** a run that ended `succeeded` may still have answered nothing, so the rail says "Run answered" or "Run did not answer" and names what was missing.
*   **Your own model, standalone only:** Gemini, OpenAI, Ollama or any OpenAI-compatible endpoint through the existing `LLM_*` settings; the embedded `@libredb/studio` package carries no agent surface. See [Agent Guide](AGENT_GUIDE.md), [Agent Data Flow](AGENT_DATA_FLOW.md) and [Agent Runtime](AGENT.md).

## Roadmap

Upcoming phases are tracked in the [Roadmap section of the README](../README.md#roadmap).
