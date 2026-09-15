# LibreDB Studio

LibreDB Studio is an MIT-licensed, AI-assisted open source SQL IDE that connects to seventeen database engines directly from the browser.

Use cases:

* Browser-based database management
  * Browse schemas and run queries across seventeen engines: PostgreSQL, MySQL, Oracle, SQL Server, Db2 LUW, SQLite, libSQL, DuckDB, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino and Apache Cassandra. Editing data follows the engine rather than the IDE: inline row editing on PostgreSQL, MySQL, Oracle, SQL Server, Db2, SQLite, libSQL and DuckDB, and everywhere else the controls are reported as unsupported rather than offered and then failed.
* AI-assisted querying
  * An optional AI assistant (bring your own key: Gemini, OpenAI, or a local model) explains a query in plain English from the engine's own EXPLAIN plan, on PostgreSQL, MySQL, SQLite, libSQL, DuckDB, Couchbase, ClickHouse, Apache Druid and Apache Trino, and runs a read-only investigation agent on PostgreSQL, SQLite and DuckDB where the database, not the IDE, enforces the read-only session. It stays off unless you configure a provider.
* Self-hosted data
  * Runs entirely on your own infrastructure, so no external database is required to operate the IDE itself. Installs from the Rancher Apps catalog with default values: first-run admin credentials are generated automatically and printed to the pod log.
