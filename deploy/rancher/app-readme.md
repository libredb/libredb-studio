# LibreDB Studio

LibreDB Studio is an MIT-licensed, AI-assisted open source SQL IDE that connects to forty-two database engines directly from the browser.

Use cases:

* Browser-based database management
  * Browse schemas and run queries across forty-two engines: PostgreSQL, MySQL, Oracle, Db2 LUW, SQL Server, SQLite, libSQL, DuckDB, MongoDB, Redis, Couchbase, Firestore, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Trino, Databend, BigQuery, Snowflake, Apache Spark, Apache Cassandra, Prometheus, InfluxDB (InfluxQL), InfluxDB 3 (SQL), Apache Kafka, etcd, Neo4j, Milvus, Qdrant, Weaviate, Oxia, S3-compatible object storage, Kubernetes, MQTT, RabbitMQ, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B. Editing data follows the engine rather than the IDE: inline row editing on PostgreSQL, MySQL, Oracle, SQL Server, SQLite, libSQL and DuckDB, and everywhere else the controls are reported as unsupported rather than offered and then failed.
* AI-assisted querying
  * An optional AI assistant (bring your own key: Gemini, OpenAI, or a local model) explains a query in plain English from the engine's own EXPLAIN plan, on PostgreSQL, MySQL, SQLite, libSQL, DuckDB, Couchbase, ClickHouse, Apache Druid, Trino, Databend, BigQuery, Snowflake and Apache Spark. It also runs a read-only investigation agent on PostgreSQL, SQLite, DuckDB, SQL Server, MySQL, Kubernetes and MongoDB that never writes, under the read-only boundary documented for each engine. It stays off unless you configure a provider.
* Self-hosted data
  * Runs entirely on your own infrastructure, so no external database is required to operate the IDE itself. Installs from the Rancher Apps catalog with default values: first-run admin credentials are generated automatically and printed to the pod log.
