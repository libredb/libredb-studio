# LibreDB Studio Expert Features

## Implemented Features

### 1. Monaco SQL IDE Experience
*   **VS Code Engine:** Integrated Monaco Editor for a professional coding environment.
*   **Pro SQL Autocomplete:** Advanced schema-aware completion for tables, columns (`table.col`), SQL keywords, and built-in functions.
*   **SQL Formatter:** Built-in "Format" button and `Alt + Shift + F` shortcut for clean, readable SQL code.
*   **Custom DB Theme:** Specialized `db-dark` theme for high-contrast SQL syntax highlighting.
*   **Power Snippets:** Integrated templates for CTEs, Joins, and complex CRUD operations.
*   **Modern Editor Specs:** Font ligatures, smooth scrolling, bracket pair colorization, and parameter hints enabled.
*   **Keyboard Shortcuts:** `Cmd/Ctrl+Enter` to execute the query (editor focused), `Alt+Shift+F` to format the query (editor focused), `Cmd/Ctrl+Shift+X` to open a new query tab (except while renaming a tab or while an object apply is in flight), `Cmd/Ctrl+K` to toggle the command palette.
*   **Command Palette:** Quick access to tables, connections, saved queries, and actions with `Cmd/Ctrl+K`.

> Shortcut bindings and labels come from `src/lib/keyboard-shortcuts.ts`. After changing the registry, run `bun run shortcuts:sync`; the unit suite checks this list for drift. See [`docs/editor/`](editor/) for the editor internals — completion provider, alias resolution, and performance design.

### 2. Multi-Tab Query Management
*   **Workspace Tabs:** Open multiple queries simultaneously in separate tabs.
*   **Independent Results:** Each tab maintains its own execution state and results grid.
*   **Failed Runs Stay Visible:** A run that fails replaces the tab's previous result with the error, in the results panel, so the rows on screen always belong to the statement that last ran.
    The notification still appears, and the next successful run clears the error.
    A failed Load More is the exception, because only the next page failed: the rows already loaded stay.
    A cancelled run leaves the previous result as it was.
    The embedded workspace shows the same inline error, which is its only failure signal, because it mounts no notification area.
*   **Persistent Tabs:** Switch between tasks without losing your work.

### 3. Pro Data Grid (Excel-Style)
*   **High Performance:** Virtualized rendering using TanStack Virtual for smooth scrolling through millions of rows.
*   **Inline Editing:** Double-click any cell to edit data directly; apply pending cell changes as one `UPDATE` per edited row or discard them. The table written to is the one the *statement that fetched the rows* names, not the tab's title. A query whose rows have no single table - a join, a comma-separated `FROM`, a subquery in `FROM` or in the select list, a CTE, a set operation - is refused with a reason rather than guessed at. The key the `WHERE` is built on is a guess off the result's own fields, so before anything is written the apply asks the engine whether that column addresses one row per value and refuses the whole apply when it does not: on a result carrying a foreign key rather than the table's own key, one cell edit used to rewrite every row sharing that value. Offered only where the provider declares `supportsInlineRowEdit`. ClickHouse, Druid, Elasticsearch, OpenSearch, Trino, Cassandra, MongoDB, Redis, Prometheus, InfluxDB (InfluxQL), InfluxDB 3 (SQL), Apache Kafka, etcd, Neo4j, Milvus, Qdrant, Oxia and LibreDB show no editing control at all because they have no single-table row update - on Cassandra because CQL requires the WHOLE primary key restricted by equality while the editor names one column it guessed from the result fields, so a clustered table answers "Some partition key parts are missing" (measured); on Trino because it declares no primary key for any table in any catalog, so the generated `WHERE` could not identify one row; on the two search engines `UPDATE` is absent from the SQL grammar itself, measured on both; Couchbase shows none because the document key reaches the grid as a projection alias the generated `WHERE` cannot address.
*   **Data-Type Formatting:** Specialized rendering for Numbers, Booleans, and Nulls.
*   **Vector Cells:** A column the result declares as a vector (`QueryResult.vectorColumns`) shows its first 8 elements and its size, such as `768 dims`, bits for a binary vector, entries for a sparse vector and rows for a multivector, instead of one line of thousands of digits.
    The row detail shows a header line such as `dense float32, 768 dims` over the whole value, wrapped.
    Copy Cell copies the whole value as compact JSON in the engine's own encoding, so it can be pasted back into a search on the same engine, and a masked column copies its mask.
    A column that is not declared renders as before, so no existing engine's cells change.
*   **Copy Cell on binary values:** Copy Cell on a binary value (`bytea`, `BLOB`, `varbinary`) copies the whole value as `\x` hex, the form the row detail and the export write.
    It used to copy the cell's shortened preview: the first 32 bytes and the size.
*   **Column Management:** Resizable columns and advanced sorting.
    While masking is in force, a masked column sorts by the masked text the grid shows, numeric columns included, so the row order cannot rank the clear values under the mask; rows whose masks are identical keep their original order, and a NULL there sorts as the text `NULL` it shows rather than first or last.
    A result column opens at a width that fits its header.
    Double-clicking a column's resize handle restores that width.
*   **Row Detail:** A control at the left edge of every row opens that row field by field, values beside field names, with per-field copy and the same masking the grid applies.
    It is how a result with more columns than fit the window stays readable, so it is on the desktop grid and not only on the small-screen card and table views, where it shipped first (#800).
    The control is pinned to the left edge rather than scrolling away with the first column, and no breakpoint hides it.
    The field list flows into as many columns as the window fits, asked for by column width rather than by a breakpoint, and the panel is capped at a share of the window rather than always filling it, so a six field row no longer hides the grid it came from.
    Measured on a 40 field row: one column at 390px and 768px, two at 834px and 1024px, three at 1280px and 1440px, four at 1920px and eight at 3840px.
    How many of them carry fields depends on how many fields the row has, so a short row fills fewer than the window could hold.
*   **Column Filter:** Each column header's funnel filters the rows by a case-insensitive substring of that column.
    While masking is in force, a masked column is matched against the masked text the grid shows, so typing parts of a clear value cannot narrow the rows to reveal it.

### 4. Visual EXPLAIN (Query Analyzer)
*   **Performance Visualization:** Visual execution plan to identify performance bottlenecks.
*   **Detailed Metrics:** Graphical representation of database scan types, join operations, costs, and execution times.
*   **Multi-DB Support:** PostgreSQL and MySQL JSON plans, SQLite and libSQL `EXPLAIN QUERY PLAN`, DuckDB `EXPLAIN (FORMAT JSON)` physical-plan trees, Couchbase SQL++ plan trees, ClickHouse JSON plan trees, Apache Druid native-query plan trees, and Trino `EXPLAIN (FORMAT JSON)` plan trees. Trino is where the estimate/analyze distinction is load-bearing rather than cosmetic: measured on 476, `EXPLAIN (FORMAT JSON) INSERT …` left the target table at 0 rows while `EXPLAIN ANALYZE INSERT …` took it to 1, so only the planning form is ever emitted — a background estimate that reaches S3, Iceberg or Hive twice is a real bill. Providers without a real analyze mode hide the toggle instead of degrading to an estimate, and providers with no plan at all hide the button and the tab: Cassandra declares `supportsExplain: false` and no `explainFormat` because `EXPLAIN` is not in CQL's grammar at all (`no viable alternative at input 'EXPLAIN'`) - its only substitute is tracing, which profiles a statement that has already run and is therefore not a plan. Elasticsearch and OpenSearch declare the same pair, because neither answer is a plan this repo can render on both products: measured, `EXPLAIN SELECT …` on Elasticsearch 9.1.4 returns one `keyword` column of its own internal plan text, while the same statement on OpenSearch 3.8.0 is refused outright (`SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE, SHOW or DESCRIBE"). A tab that works on one of two products behind one code path is worse than no tab. A plan also shows only the numbers its planner actually reports: Druid emits no cost and no row estimate, so its nodes carry structure and no metrics rather than invented ones.

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
    *   **Db2 LUW:** Db2 for Linux, UNIX and Windows over DRDA through `db2-node`, a native N-API addon that needs no IBM client; schema browsing and stored definitions from `SYSCAT`, server-side paging, RUNSTATS and REORG per table, and inline editing and import into an existing table. TLS is required unless the connection opts out; Create Table, EXPLAIN, transactions and cancel are off, and the driver issues still open are listed in [`providers/db2.md`](./providers/db2.md).
    *   **SQL Server:** Full support with connection pooling (`mssql`); monitoring via DMVs (`sys.dm_*`).
    *   **ClickHouse:** Full support with **no driver dependency** — SQL over the documented HTTP interface, so the SQL editor and limiter both apply. Column types read verbatim from `system.columns`, JSON EXPLAIN plan trees, and `OPTIMIZE TABLE` / table-statistics / query-kill maintenance.
    *   **Apache Druid:** Read-only support with **no driver dependency** — SQL over `POST /druid/v2/sql` on the Router (8888) or the Broker (8082), so the SQL editor and limiter both apply. Datasources and column types from `INFORMATION_SCHEMA`, native-query EXPLAIN plan trees, and monitoring from `sys.segments` / `sys.servers` / `sys.tasks`. Read-only is the engine, not the integration: Druid SQL has no `UPDATE`, no `DELETE` and no `CREATE TABLE`, and no maintenance operation is reachable from SQL, so those controls are reported as unsupported instead of failing when used.
    *   **Trino:** Full query support with **no driver dependency** — SQL over Trino's own client protocol (`POST /v1/statement`, port 8080), so the SQL editor and limiter both apply. Trino is a query *engine*, not a database, and the integration says so everywhere it matters. The connection's Database field pins one **catalog** (the tree is catalog-scoped and two levels deep; cross-catalog queries still run by qualifying names in full), the schema tree comes from that catalog's `information_schema`, monitoring from `system.runtime` and `jmx`, and row counts and sizes from a real `SHOW STATS` per table. What it declares as absent is absent from the engine, not from the integration: Trino's `information_schema` holds eight views and neither `table_constraints` nor `key_column_usage`, so no connector can declare a key through it — no primary keys, no foreign keys, no indexes, ER edges or inline row editing anywhere. It stores nothing, so the size panels name the catalogs and their connectors instead of inventing a footprint. Writes are the connector's decision rather than the engine's, and its refusal is shown verbatim. EXPLAIN renders as a plan tree from `EXPLAIN (FORMAT JSON)`, and never from `EXPLAIN ANALYZE`, which executes the statement. Query cancellation is real (`DELETE /v1/query/{id}`; abandoning a request does *not* stop the work), and `kill` is the one maintenance operation. Two traps a user meets immediately: a failed statement arrives as **HTTP 200** with the failure in the document, and a password is refused over plain HTTP even on a cluster with authentication disabled.
    *   **libSQL:** Full SQL support with **no driver dependency** - SQLite's own dialect over the Hrana protocol (`POST /v2/pipeline`, port 8080), reaching both a self-hosted libSQL server (`sqld`) and Turso Cloud through ONE type-id, because they speak the same protocol and embed the same SQLite (3.47.0 on both, measured). The credential is an auth **token**, so the connection dialog labels the field that way and takes the `libsql://<database>-<org>.turso.io?authToken=<jwt>` URL Turso's CLI prints; a self-hosted `sqld` started with `SQLD_HTTP_AUTH` checks a user name and password instead, which a connection sends as HTTP Basic once it names a `user`. Introspection is SQL (`sqlite_master`, the `pragma_*` functions) and the sizes are real: `dbstat` answers on both deployments, which the file-based SQLite driver under Bun cannot do at all, so tables and indexes report measured bytes. What is absent is the server's decision rather than the integration's: `VACUUM`, `ANALYZE`, `PRAGMA optimize` and `PRAGMA wal_checkpoint` are all refused by its statement allowlist, so only Reindex and Integrity Check are offered; `PRAGMA query_only` is refused too, which is why agent mode's read-only profile does not extend here. There is no session, no uptime and no statement history to show, because Hrana is stateless and libSQL publishes none of them.
    *   **DuckDB:** Full SQL support against an EMBEDDED analytical engine — the whole connection is a file path (or `:memory:`) on the server this app runs on, so there is no host, no port and no credential, and the driver (`@duckdb/node-api`) is a native N-API addon loaded in-process. `EXPLAIN (FORMAT JSON)` physical-plan trees, `duckdb_*` catalog introspection, real per-table bytes derived from `pragma_storage_info` block allocation, and query cancellation through the connection's own `interrupt()`. Three maintenance operations only — `VACUUM`, `ANALYZE` and `CHECKPOINT` — because `REINDEX` is a parser error on this engine and neither `PRAGMA integrity_check` nor `PRAGMA optimize` exists. It publishes no slow-query log and no session list, so those panels say so rather than reporting a zero, and the file admits exactly ONE operating-system process, refused in read-only mode too.
    *   **Apache Cassandra:** Full CQL support over the native protocol (port 9042) through `cassandra-driver` - pure JavaScript, so no native module reaches any distribution channel. The connection pins one **keyspace** (the `database` field) and carries a **`localDataCenter`**, which no other engine here needs and the driver refuses to connect without. The schema tree marks partition and clustering keys and orders columns partition-key-first, because declaration order is genuinely unrecoverable: `system_schema.columns.position` is -1 for every regular column and the rows arrive alphabetically. What it does NOT report is the point: **no row count and no size anywhere**, because Cassandra publishes neither honestly - `system.size_estimates` counts partitions per token range from flushed files (measured at 143 for a 500-row clustered table, 525 for a 500-row flat one) and `system_views.disk_usage` is whole mebibytes (`1 MiB` for 19,476 bytes) - so the object browser, the overview and the table, index and storage panels show nothing rather than something wrong. There is no EXPLAIN (the keyword is not in CQL), no cancellation (the protocol has no cancel frame), and no maintenance operation (compaction, repair, flush and cleanup are all `nodetool` actions over JMX). Values are normalized once at the driver boundary: a `blob` reaches the grid as `0x…` rather than a Buffer document, a `bigint`/`decimal`/`varint` as its exact digits, a `vector<float,3>` as an array and a `duration` as `1mo2d3h`.
*   **Search Engines:**
    *   **Elasticsearch / OpenSearch:** Read-only support with **no driver dependency** — SQL over `POST /_sql?format=json` (Elasticsearch) and `POST /_plugins/_sql` (OpenSearch), port 9200 on both. Two type-ids share one provider module because the two products differ only in wire detail. Indices become tables and mapped fields become columns, read from `_mapping` rather than from `SELECT *`: measured on Elasticsearch 9.1.4, an index mapping a `flattened` and a `nested` field answers `SELECT *` with **no columns at all**, so the mapping is the only honest source. Cluster health, per-index document counts and store sizes come from `_cluster/health`, `_cluster/stats` and `_cat/indices`. Read-only is the engine, not the integration: neither grammar has `INSERT`, `UPDATE` or `CREATE TABLE`, so `supportsCreateTable`, `supportsInlineRowEdit`, `supportsExplain` and `supportsMaintenance` are all false and those controls are hidden rather than offered and then failed. Elasticsearch SQL also has no `OFFSET` — measured, `LIMIT 2 OFFSET 1` is HTTP 400 there and HTTP 200 on OpenSearch — so on Elasticsearch a request for a second page is refused with that reason instead of returning page one again. ES|QL is deliberately unused: it exists on one of the two products, so it cannot be the shared query language.
*   **Document Databases:**
    *   **MongoDB:** Full support with official driver, JSON-based MQL queries, automatic schema inference, and aggregation pipelines.
    *   **Couchbase:** Full support with **no driver dependency** — SQL++ over the documented Query and management REST APIs, so the SQL editor and limiter both apply. Buckets/scopes/collections flattened into the schema explorer, `INFER`-based column inference, visual EXPLAIN plans, and read-your-writes query consistency by default.
*   **Key-Value Stores:**
    *   **Redis:** Full support via the official `ioredis` driver — plain-command and JSON query styles, prefix-grouped key "schema" through a non-blocking `SCAN`, and `INFO`/`SLOWLOG`/`CLIENT LIST`-derived health and metrics.
    *   **etcd:** Read-write over etcd's gRPC API through `@grpc/grpc-js`: an etcdctl subset in the editor, key-prefix groups in the tree and every key in the Keys panel, guarded value edits, a bounded watch, leases, admin-only compaction, defragmentation and alarm disarm, every write under a Kubernetes prefix refused and every Kubernetes secret withheld.
    *   **Oxia:** Read-only over Oxia's gRPC client API through `@grpc/grpc-js`: `oxia client` read commands (`get`, `list`, `range-scan`) in the editor, shards in the tree and every key in the Keys panel, the key order probed, and a dial policy that sends the token to no address the connection does not name.
*   **Time-Series Stores:**
    *   **Prometheus:** PromQL over the Prometheus HTTP API with **no driver dependency**, the first engine to declare a `queryLanguage` of its own, `promql` beside `sql` and `json`.
        The editor text reaches the server unchanged, results land in the grid and in the chart tab (a stepped subquery such as `rate(x[5m])[1h:1m]` charts as lines over its timestamps: the tab opens on the first series, more are added from the Y-Axis menu, one line each, and at most eight are drawn at once, past which it says "Showing first 8 of N series"; but the chart draws a missing sample, and a `NaN` or `Inf` among numbers, at 0, so a raw range over targets scraped at their own offsets charts false zeros; `docs/BACKLOG.md` U44), and `NaN` and `Inf` stay the engine's strings.
        Metrics, rule groups, recording and alerting rules, scrape pools and scrape targets are browsable, with a firing alert or a down target marked in the tree.
        Read-only by design: no admin endpoint, no remote write, no maintenance.
        See [`providers/prometheus.md`](providers/prometheus.md).
    *   **InfluxDB (InfluxQL):** Read-only InfluxQL over the v1 `/query` API with no driver dependency, on every line: tested on InfluxDB 1.13.1, 2.9.1 and 3.12.0 Core.
        Databases and their measurements are browsable with `time`, the tag keys and the field keys as columns, and a click on a measurement writes a time-windowed, newest-first read that passes the same policy as typed text.
        Every statement passes a lexer that reads the text as the server's scanner does, then a read policy: one statement whose first keyword is SELECT, SHOW or EXPLAIN, no `INTO`, no bound parameter, and no Flux.
        A 64-bit integer keeps every digit, and nanosecond timestamps stay distinct.
        See [`providers/influxdb.md`](providers/influxdb.md).
    *   **InfluxDB 3 (SQL):** Read-only SQL over InfluxDB 3's `/api/v3/query_sql`, read under the Apache DataFusion grammar row, tested on InfluxDB 3.12.0 Core.
        One connection reads one database, whose tables are browsable with their columns, and a tree click previews a recent time window.
        A statement runs only when it is one read statement, through a closed route table that reaches no write, configure, token or plugin route.
        See [`providers/influxdb3.md`](providers/influxdb3.md).
*   **Stream Stores:**
    *   **Apache Kafka:** Read-only browsing over the Kafka protocol through `@platformatic/kafka`, with a JSON read request in the editor (`queryDialect: "kafka"`) that reads a topic by partition, offset or timestamp, from the earliest offset, or its latest messages.
        Topics with their partitions and non-default configs, consumer groups of both protocols with their lag per partition, and brokers with their configs are browsable, with an offline or under-replicated topic marked in the tree.
        Keys, values and headers are decoded as JSON, text or base64, and a Confluent-framed value is labelled with its schema id; reads are read-committed, and every result is bounded by a row limit, a byte budget and a cell limit.
        TLS with a custom CA and client certificates, and SASL PLAIN, SCRAM-SHA-256 and SCRAM-SHA-512 over TLS only.
        Read-only by construction: the provider never produces, commits an offset, joins a consumer group or creates a topic.
        See [`providers/kafka.md`](providers/kafka.md).
*   **Graph Databases:**
    *   **Neo4j:** Read-only Cypher over Bolt through `neo4j-driver-lite`, tested on Neo4j 5.26 LTS, on a shared graph layer a second Cypher engine can join.
        Node labels and relationship types with their properties as columns, indexes and constraints are browsable, and a click on a label or a relationship type writes a bounded sample read.
        Nodes, relationships and paths reach the grid as tagged JSON cells with the graph type in the column header, and a 64-bit integer or a temporal value keeps every digit.
        A Graph tab beside the grid draws a result's nodes and relationships, with no statement of its own.
        Read-only by construction: every statement passes a read policy (no writes, no `LOAD CSV`, no APOC or GDS, allowlisted procedures, functions and SHOW forms), then the server's own classification (which an allowlisted SHOW form skips), then a READ session.
        See [`providers/neo4j.md`](providers/neo4j.md).
*   **Vector Databases:**
    *   **Milvus:** Read-only over Milvus's gRPC API through a client of Studio's own, tested on Milvus 3.0.2.
        Milvus's own REST v2 requests in the editor, fifteen read routes: reads, exact counts and vector searches over every vector type, BM25 and hybrid search included.
        Databases and collections are browsable with their fields, partitions, indexes and load state, and vectors reach the grid as vector cells with their dimension and full-value copy.
        Load and Release for admins, each with a preview and a typed collection name; the default `root` password is warned about, and no server-side function, ranker or inference is run, in any release.
        See [`providers/milvus.md`](providers/milvus.md).
    *   **Qdrant:** Read-only over Qdrant's REST API through a client of Studio's own, tested on Qdrant 1.19.1.
        Qdrant's own REST requests in the editor, seventeen read routes: queries, batches and grouped queries over dense, sparse and multivector data, the local BM25 model included.
        Collections are browsable with their vectors, payload indexes and a sampled view of payload keys, and vectors reach the grid as vector cells with their dimension and full-value copy.
        Every inference input but local BM25 is refused, in every release.
        See [`providers/qdrant.md`](providers/qdrant.md).
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
Two components are described below and a claim true of one can be false of the other. The desktop sidebar renders the lazy object tree; the mobile schema tab and the published `SchemaExplorer` export render the flat schema list. A bullet marked "(schema tab)" is about the flat list.
*   **Lazy Object Tree (desktop sidebar):** Containers, per-kind folders and object rows, each level read only when it is opened, so connecting costs one listing rather than a walk of the whole database. Expanding an object of a kind whose provider declares that it has columns adds one row per column, with the declared type right-aligned and a key mark on the primary key, from a single-object read issued when the row is opened and kept for the life of the connection; a kind whose provider declares nothing has no chevron, is never read, and stays a leaf. The two gestures on an object row are separate and do different things: clicking the row opens that object's data in a tab, and clicking the chevron to its left opens and closes its columns. With the row focused, Enter and Space open the data, ArrowRight and ArrowLeft open and close the columns.
    Activating an object whose data tab is already open on the same connection, and whose query has not been edited since, focuses that tab without running the query again; once the query has been edited, a fresh tab opens instead.
    When that tab's last run failed, focusing it also runs its query again, in the same tab.
    Holding Enter or Space down does not open another tab per key repeat.
*   **Deep Tree Inspection (schema tab):** Expand tables to view column definitions, data types, and Primary Key (PK) constraints with intuitive iconography.
*   **Global Search & Filter (schema tab):** Real-time, high-performance filtering across both table names and column names.
*   **Catalog Row Counts:** Both explorers draw the row count the engine already holds in its catalog, in compact K/M/B/T units (for example, `1.6M`).
    Hover to see the complete figure and the caveat that it is an estimate on most engines.
    A missing count stays absent, and drawing a badge never runs a full-table count.
*   **Visual Table Designer:** Create new tables directly from the explorer with a modern, column-based UI. No SQL knowledge required for basic structures.
*   **Contextual Actions (schema tab):** Quick access menus for each table including "Select Top 50", "Generate Query", "Generate Count Query", and "Copy Name". Action labels adapt per provider (e.g. "Scan Keys" for Redis, "Find Documents" for MongoDB).
*   **Generate Count Query (both explorers):** Opens an editable count statement in a new tab without running it, so a filter can be added before Run.
    SQL engines get a qualified, dialect-quoted `SELECT COUNT(*)` (`COUNT_BIG(*)` on SQL Server), and MongoDB gets its `count` document.
    Redis, LibreDB, Prometheus, InfluxDB (InfluxQL), Apache Kafka, etcd, Neo4j, Milvus, Qdrant and Oxia have no count grammar here, and a derived key-prefix grouping has nothing to count, so they are not offered it.
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
*   **In-Place Error Alerts:** The Query Safety dialog and schema-documentation panel render AI failures inline. Query Safety omits the credentials error only when no provider is configured at all, retaining the plain warning and explicit Cancel/Execute controls. Setting `LLM_PROVIDER` without its credentials is an unfinished setup, so that error stays visible, as do invalid provider settings, missing models or service URLs, authentication errors and service failures.
*   **Bounded Safety Analysis:** The Query Safety dialog's AI analysis is advisory, and waiting for it is bounded. While it runs, **Skip analysis** stops the request and enables Execute at once; an analysis that has not finished within 15 seconds is stopped, the dialog says the analysis could not be completed, and Execute is enabled. A typed confirmation the engine asks for still has to be typed either way. `POST /api/ai/query-safety` itself stops waiting for the model after 30 seconds and answers `504` `TIMEOUT_ERROR`. Both values are constants in `src/lib/llm/query-safety.ts`.
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
*   **Graph View:** A result that holds graph values (Neo4j nodes, relationships and paths, at any depth in a cell) offers a Graph tab beside Results.
    It draws only what the statement returned, at most 300 nodes with a notice naming the total, with a colour and a legend count per label, a caption per node, arrows with the relationship type, and an inspector listing every property of the clicked element.
    Pan, zoom and fit work by mouse and by keyboard, a dragged node stays where it is dropped, PNG and JSON export the drawn graph, and the grid's data masking applies to captions, the inspector and both exports.
    See [`providers/neo4j.md`](providers/neo4j.md#56-the-graph-tab).

### 15. Professional Data Export
*   **Format Versatility:** Instantly export query result sets to CSV, JSON, SQL `INSERT` statements, or a generated `CREATE TABLE` DDL.
*   **CSV Delimiters:** Choose comma (default), semicolon or tab in the import preview or result export menu. Changing the import delimiter reparses the preview and retains the header setting and column mappings. Export quoting, formula neutralization and UTF-8 encoding apply to every separator.
*   **Import into a new table:** the table name and every column name are quoted in the connection's own style in both the `CREATE TABLE` and the `INSERT`, so a header that is a reserved word (`when`, `order`, `user`), has mixed case or holds a space creates that column as written. A name typed with a dot (`sales.imported`) is a table in that schema.
    In the standalone app, an import the database refuses keeps the dialog open on the review step with the database's message, and the file, target and column mapping stay as they were; the dialog closes once the import ran, or when the confirmation dialog takes it over. The embedded workspace of the npm package still closes the dialog whatever the outcome, because its query adapter reports none.
*   **Masked Results:** While data masking applies to a result, every export and copy writes the masked text, so the export menu names the masked columns and says so. The grid's column filter and sort read the masked text too. SQL `INSERT` is not offered in that state, because it would store the mask as the column's value; CSV, JSON and DDL stay. When the result carries no declared column types, the DDL export infers a column's type from the masked text, so a masked column can come out as a text type.
*   **Developer-Ready:** Clean data output optimized for external analysis, reporting, or database migrations.
*   **Binary Values:** A `bytea`, `BLOB`, `RAW` or `varbinary` value is written as the `\x` hex the grid shows (`\xdeadbeef00ff`) in the CSV and the JSON export and by Copy Row as JSON, and as the dialect's own binary literal in a SQL `INSERT`.
*   **Replayable SQL:** The SQL `INSERT` form reads each column's declared type and writes arrays, maps, structs, tuples, intervals, wide integers and typed scalars in the literal the connected engine reads back (`src/lib/export/typed-literals.ts`). A row holding a value the engine has no literal for is replaced by a `-- Row N skipped: column "c" ...` comment instead of a statement that would stop the whole file. Masking turns a value into text, so with masking on a masked array, map, row or tuple cell is skipped this way on Trino and Cassandra, and on the other engines is written as the masked text, which the engine refuses on replay. The statement targets the one table the producing `SELECT` read, when it read exactly one, and otherwise the tab's title.
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
*   **Read-only, enforced by the database:** every statement the agent runs goes through the agent's own audited pipeline — a policy decision, an audit event and budget accounting before the driver is touched, through `executeAuditedOperation()` ([`execution.ts`](../src/lib/db/operations/execution.ts)) — under a read-only execution profile: a read-only transaction on PostgreSQL, `PRAGMA query_only` re-asserted per statement on SQLite, a `READ_ONLY` engine handle plus an SQL-level guard on DuckDB — the flag alone is not a filesystem sandbox, since `COPY … TO`, `EXPORT DATABASE`, `INSTALL`/`LOAD` and the local-file table functions all succeed under it. On SQL Server the profile is four layers instead of one, because the engine has no read-only transaction and no session-level read-only switch: a session principal verified at open to be unable to write or to reach the server's dangerous surfaces, an admission step that asks the optimizer to compile each statement without running it, a server-side row bound (`SET ROWCOUNT`) that stops an unbounded read before the result is materialised at all, and a pinned transaction that is always rolled back. Writes and DDL are refused before the database is reached, and `EXPLAIN ANALYZE` is default-denied because it would execute the statement. The pipeline is the agent's alone and is not shared with the editor: a statement you run yourself calls the provider directly in `POST()` ([`query/route.ts`](../src/app/api/db/query/route.ts)), receiving neither the policy decision nor the audit event.
*   **Agent mode is PostgreSQL, SQLite, DuckDB and SQL Server only — except Operate:** the read-only profile is database-native, so it exists only where a provider implements `queryReadOnly` — [`postgres.ts`](../src/lib/db/providers/sql/postgres.ts), [`sqlite.ts`](../src/lib/db/providers/sql/sqlite.ts), [`duckdb/index.ts`](../src/lib/db/providers/sql/duckdb/index.ts) and [`mssql.ts`](../src/lib/db/providers/sql/mssql.ts), and no other provider does. On MySQL, Oracle, Db2 LUW, libSQL, MongoDB, Redis, ClickHouse, Druid, Couchbase, Elasticsearch, OpenSearch, Trino, Cassandra, Prometheus, InfluxDB (InfluxQL), InfluxDB 3 (SQL), Apache Kafka, etcd, Neo4j, Milvus, Qdrant, Oxia or the embedded LibreDB store an Agent-mode run whose workflow sends statements is refused by `POST /api/agent/runs` before a run id exists, and one that reaches the provider factory ends `engine-unsupported` in `driveAgentRun()` ([`runtime.ts`](../src/lib/agent/runtime.ts)). The search providers implement no `queryReadOnly` and could not: their SQL grammars have no transaction and no session-scoped setting to make read-only, and the surface is already read-only in the grammar itself, which is a different guarantee from one the database enforces per statement. The **Operate** workflow is the exception and runs on every engine, because it sends no SQL at all: it reads the engine's own reporting interface, which every provider implements. Plan mode opens on every connection: its model is handed no tools, so no read-only profile has to be acquired for it. It is not blind, though — since 2026-08-15 the server reads the connection's schema and the engine's own estimated statistics before the model's first turn. That **grounding** reaches every engine: on PostgreSQL and SQLite the server composes catalog statements and reads them through that same read-only path, and on every other connection it asks the provider to describe its own schema — the reading the sidebar already performs when it lists your tables, which needs no read-only statement path. So the two limits are separate ones: agent mode is those four engines, grounding is all of them, and a run whose reading fails — refused, overran its time, or rejected by the engine — says so rather than inventing tables.
*   **Two independent axes:** the **mode** (Plan, whose model is toolless and whose deliverable is one statement for you to run yourself — the run executes no statement of yours and writes nothing — or Agent) and the **workflow** (Investigate, Optimize, Assess, Operate, Analyze). Both are fixed when the run opens and read from the run's own record thereafter.
*   **Operate reads the live server, not its tables:** the slowest queries, who is connected and what is blocked, table and index statistics, storage and health — each a curated reading the server takes through the provider's own reporting interface, stored as an ordinary citable artifact. Every reading is a point in time, and both the prompt and the timeline say so rather than letting a report imply a trend was measured.
*   **Counts, never values:** the Assess workflow's table profiling composes aggregates only — row counts, present counts, distinct counts, and shape matches computed inside the database. There is deliberately no `min`/`max`, because on a text column those return real values.
*   **Bounded and visible:** 18 to 45 statements, 80 to 180 s of database time, 200 rows per read, a 6 to 15 minute run deadline and 3 repair attempts, each ceiling set per workflow — with the meter on screen, and stated as a floor rather than an exact spend.
*   **A verdict beside the status:** a run that ended `succeeded` may still have answered nothing, so the rail says "Run answered" or "Run did not answer" and names what was missing.
*   **Your own model, standalone only:** Gemini, OpenAI, Ollama or any OpenAI-compatible endpoint through the existing `LLM_*` settings; the embedded `@libredb/studio` package carries no agent surface. See [Agent Guide](AGENT_GUIDE.md), [Agent Data Flow](AGENT_DATA_FLOW.md) and [Agent Runtime](AGENT.md).

### 19. MCP Server for your own AI client (off by default)
*   **Your own client:** Claude Code, Codex, Cursor, VS Code or Gemini CLI connect to `/api/mcp` with a token each user mints on the settings screen.
*   **Three read-only tools:** `list_connections` and `inspect_schema` on every engine, and `run_read_query` on PostgreSQL, SQLite, DuckDB and SQL Server.
*   **Opted-in connections only:** only the seed connections an operator opts in with `mcp: true`, filtered by the token's role; the database credentials stay on the server.
*   **Bounded and audited:** every result is bounded to 32 KiB and marked as untrusted data, and every call is audited.
*   **Setup:** client configuration and limits are in [`docs/MCP.md`](MCP.md).

## Roadmap

Upcoming phases are tracked in the [Roadmap section of the README](../README.md#roadmap).
