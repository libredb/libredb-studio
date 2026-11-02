# MCP server

LibreDB Studio serves the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`.
An AI client of your own, such as Claude Code, Codex, Cursor, VS Code or Gemini CLI, reads the schemas of the connections an operator opted in and runs bounded, read-only SQL, MongoDB commands, kubectl reads, LibreDB commands, Weaviate metadata reads, Qdrant metadata reads, Cypher statements, Redis metadata reads, RabbitMQ stream reads, Kafka metadata reads and MTConnect requests through Studio, while the database credentials stay on the server.
It is off by default.

## What it is

- One endpoint, `POST /api/mcp`, served by the official MCP TypeScript SDK.
  It speaks revision 2026-07-28 and, without sessions, the 2025 revisions 2025-11-25 and 2025-06-18 that most clients still use.
- Thirteen tools, each annotated read-only and closed-world:
  - `list_connections` lists the connections opted in for MCP that your token's role may use, without credentials.
    It works for every engine but etcd, Oxia, S3-compatible object storage, MQTT, Firestore, OPC UA, Modbus, NETCONF, SNMP and Sparkplug B, whose connections the seed file cannot opt in.
    Each connection's `read_tool` names the tool that runs a statement on it, `run_read_query`, `run_kubectl_read`, `run_mongo_command`, `run_libredb_read`, `run_weaviate_read`, `run_qdrant_read`, `run_cypher_read`, `run_redis_read`, `run_rabbitmq_read`, `run_kafka_read` or `run_mtconnect_read`, and is `null` where `inspect_schema` is the only read.
  - `inspect_schema` lists one connection's tables with their columns and, on request, their indexes.
    It works on every engine but etcd, Oxia, S3-compatible object storage, MQTT, Firestore, OPC UA, Modbus, NETCONF, SNMP and Sparkplug B: it lists every object kind the engine reads rows from, such as views beside tables, MongoDB collections, Redis keyspaces and search indexes, and `kind` names which one each entry is.
    On Kubernetes it refuses the call by name, because no Kubernetes kind is a table: the refusal names `run_kubectl_read`, which reads its objects, and is answered as soon as the connection resolves, before anything is acquired.
    So no object name, a Secret's included, reaches it there ([kubernetes.md](./providers/kubernetes.md#9-capabilities-ai-and-mcp)).
    The statement language that serves an engine declares that its engines hold no table (`holdsNoTables` in its MCP facet, `src/lib/agent/languages/<statement-language>/mcp.ts`), and a test holds that declaration to every served engine's own relation kinds.
    On RabbitMQ it lists the streams of one virtual host, at most the 500 its Streams folder shows, and matches a named virtual host case-insensitively ([rabbitmq.md](./providers/rabbitmq.md#8-ai-agent-and-mcp)).
    A column an engine only inferred from sampled data, rather than read from a declaration, is never listed, so a table may hold fields the answer does not show; `columns_omitted` counts only the columns beyond the 50-column cap, and agent grounding and the AI panels never receive such a column either.
    On Milvus it lists the collection's declared fields, with the dynamic field as one `$meta` column and never a key inside it.
    On Qdrant it lists payload-index fields and vectors only, and says that other payload keys may exist: the keys Studio samples from points never reach an MCP client.
    On Weaviate it lists each collection's declared properties and vectors and never its tenants or aliases, which `run_weaviate_read` reads as far as the key's grants reach; it reads no stored object, so a vector's dimension, which the schema does not declare, reads `?`, and a call wakes no tenant.
    On InfluxDB (InfluxQL) it lists measurements with their tag and field keys, and on InfluxDB 3 (SQL) tables with their columns; the `_internal` database and the `system.*` tables of a 3.x server are never returned.
    On Databend it lists tables, views, materialized views and dynamic tables; on a Databend Cloud connection with a Warehouse set, a call resumes a suspended warehouse, which bills while it runs, as any statement does.
    On Apache Spark it lists the tables and views of one namespace, read with SHOW and DESCRIBE statements that start no Spark job on Studio's own session; a namespace is named in Spark's spelling, its parts joined by dots.
  - `run_read_query` runs one read-only SQL statement.
    A `SELECT` runs on every engine it serves; a refused statement's answer names what else that engine takes.
    Runs on PostgreSQL, SQLite, DuckDB, SQL Server, MySQL, ClickHouse, libSQL, InfluxDB 3 (SQL), Elasticsearch, OpenSearch, Oracle, Db2 LUW, Apache Cassandra and Couchbase; other engines refuse it, and list_connections' read_tool names the tool that reads each connection.
    It serves an engine only where agent mode executes statements on it, the engine is offered to MCP, and `MCP_STATEMENT_READ` in `src/lib/db/compatibility.ts` opens statement reads on it, so an engine that joins agent mode stays closed here until a change of its own opens it.
    It refuses every engine outside that list as soon as the connection resolves, before anything is acquired, answering "this tool does not serve <engine>; use <tool> there", where the tool is the one the connection's `read_tool` names, or `inspect_schema` where it is `null`.
    MongoDB is one of them, because its statement is a JSON command, which `run_mongo_command` reads, Kubernetes another, because its statement is a kubectl line, which `run_kubectl_read` reads, LibreDB another, because its statement is a LibreDB command, which `run_libredb_read` reads, Weaviate another, because its statement is a REST request line, which `run_weaviate_read` reads, Qdrant another, because its statement is a REST request, which `run_qdrant_read` reads, Neo4j another, because its statement is Cypher, which `run_cypher_read` reads, Redis another, because its statement is one Redis command, which `run_redis_read` reads, RabbitMQ another, because its statement is a stream read request, which `run_rabbitmq_read` reads, Apache Kafka another, because its statement is a JSON metadata read, which `run_kafka_read` reads, and MTConnect another, because its statement is a request line, which `run_mtconnect_read` reads.
    Elasticsearch SQL has no `OFFSET`, so there `pagination.nextOffset` is always `null`, an `offset` is refused before anything is sent, and the answer says to page by key instead: `ORDER BY` a unique field, and for the next page add `WHERE` that field `>` the last value read.
    CQL has no `OFFSET` either, so on Apache Cassandra `pagination.nextOffset` is always `null`, an `offset` is refused before anything is sent, and the answer says how to page without one: keep a `LIMIT`, and for the next page add `WHERE token(<partition key>) > token(<the last one read>)`, or within one partition `WHERE <clustering column> > <the last value read>`.
    Each engine takes these, as its row in `src/lib/db/providers/sql/read-query-forms.ts` names them:
    - PostgreSQL: a `SELECT` (a `WITH` is fine), `VALUES`, `TABLE`, or `EXPLAIN` without `ANALYZE`.
    - SQLite: a `SELECT` (a `WITH` is fine), `VALUES`, or `EXPLAIN`.
    - DuckDB: a `SELECT` (a `WITH` is fine), `VALUES`, `TABLE`, or `EXPLAIN` without `ANALYZE`.
    - SQL Server: a `SELECT` (a `WITH` is fine).
    - MySQL: a `SELECT` (a `WITH` is fine), `VALUES`, `TABLE` (MySQL, not MariaDB), or `EXPLAIN` without `ANALYZE`.
    - ClickHouse: a `SELECT` (a `WITH` is fine), or `EXPLAIN` without `ANALYZE`.
    - libSQL: a `SELECT` (a `WITH` is fine), `VALUES`, or `EXPLAIN`.
    - InfluxDB 3 (SQL): a `SELECT` (a `WITH` is fine), `VALUES`, or `EXPLAIN` without `ANALYZE`.
    - Elasticsearch: a `SELECT` that reads at most one index expression, with no comment, subquery, `WITH` or `JOIN`, or an `EXPLAIN` of such a `SELECT`.
    - OpenSearch: a `SELECT` that reads at most one index expression, with no comment, subquery, `WITH`, `JOIN` or double quote (quote a name in backticks).
    - Oracle: a `SELECT` (a `WITH` is fine).
    - Db2 LUW: a `SELECT` (a `WITH` is fine), or `VALUES`.
    - Apache Cassandra: a `SELECT` of one table of the connection's keyspace or of `system_schema`.
    - Couchbase: a `SELECT` (a `WITH` is fine).
  - `run_mongo_command` runs one read-only MongoDB command, the JSON command envelope agent mode reads: `find`, `findOne`, `aggregate`, `count` or `distinct` on one collection, as `command`.
    Runs on MongoDB; other engines refuse it.
    It reads and admits the command with agent mode's own reader, so a write operation and a write stage of a pipeline (`$out`, `$merge`) are refused before anything is acquired, in the sentence an agent run reads.
    It takes no `offset`: a result cut at `max_rows` says how to narrow the command, and a read past the 1000-row provider budget is refused with the same advice, so page inside the command with a find's `skip` or a `$skip` stage.
    A result cut at the 32 KiB result limit names how many rows fitted and says to project fewer fields or skip past them, never to set the limit the command already has.
    It takes no `database`: a MongoDB connection reads the database it is bound to, as an agent run does.
  - `run_kubectl_read` runs one read-only kubectl read, the line agent mode reads: `get`, `describe`, `logs`, `top`, `events`, `api-resources`, `api-versions`, `explain`, `auth can-i`, `auth whoami` or `version`, with or without the `kubectl` word, as `statement`.
    Runs on Kubernetes; other engines refuse it.
    It reads and admits the line with agent mode's own reader, so exec, a write, a line longer than 4,096 characters and Studio's paging line are refused before anything is acquired, in the sentence an agent run reads; a watch (`-w`) is refused by the provider.
    Its answer is the agent's machine projection: a Secret's name in every field defined to hold one, Secret and ConfigMap values, env and header values, a container's command and args and annotation values read `<redacted>`.
    Free-text status, event and log messages are not masked, so a Secret's name or a value an application printed reaches the client there; the full residue machine redaction leaves unmasked is the one [kubernetes.md](./providers/kubernetes.md#9-capabilities-ai-and-mcp) states.
    It takes no `offset`: a result cut at `max_rows` says how to narrow the read with the command's own flags, and a read past the 1000-row provider budget is refused with the same advice.
    It takes no `database`: a statement names its namespace with `-n` or `-A`, and without one reads the connection's Default namespace.
  - `run_libredb_read` runs one read-only LibreDB command, the line agent mode reads: `get <key>`, `prefix <p>` or `range <start> <end>`, as `statement`.
    Runs on LibreDB; other engines refuse it.
    It reads and admits the command with agent mode's own reader, so `put`, `delete`, any other first word, a second line and a command longer than 4,096 characters are refused before anything is acquired, in the sentence an agent run reads.
    Each command opens the seed's file read-only, on a handle of its own that takes no lock and cannot write, so the Studio editor keeps the file and keeps writing beside it, and the read sees what the editor has committed.
    Each row is one key and its whole value; the file's reserved internal namespace, where the engine keeps its catalog, is left out of every answer whatever the command names.
    It takes no `offset`: a result cut at `max_rows` says to read on with a `range` from the last key returned, and a read past the 1000-key provider budget is refused with the command's own advice; a value is answered whole, never cut, so one too large for the 32 KiB result limit is refused, and since that limit measures the whole tool result, which carries every row twice, once in its text block and once in `structuredContent`, a value of about 16 KiB is already refused.
    It takes no `database`: a LibreDB connection's database is the path of its file, which the seed names, so a client never names another file ([libredb.md](./providers/libredb.md#158-mcp-run_libredb_read)).
  - `run_weaviate_read` runs one read-only Weaviate metadata read, the request agent mode reads: `GET /v1/meta`, `/v1/schema`, one collection, its shards, its tenants or one tenant, `/v1/aliases` or one alias, `/v1/nodes` or one collection's nodes, or `POST /v1/aggregate/{collection}` for a count, with an optional `tenant`, as `statement`.
    Runs on Weaviate; other engines refuse it.
    It reads and admits the request with agent mode's own reader, so an object read, a search, GraphQL, an aggregate's `where` or `groupBy`, and every write are refused before anything is acquired, in the sentence an agent run reads.
    Its answer is the agent's metadata-only projection: names, counts and flags, never a stored object, property or vector, and a server refusal is worded by its status alone.
    Tenant and alias names reach it only as the server filters them by the key's grants: a name in a collection's place is sent only when the key's own collection or alias list holds it, and an alias as the collection its list entry names, because the server reads an alias there as whatever collection it names when the request arrives, and a name that does not exist and one outside the grants are one answer; a verbose node read names the collections on each node and neither names nor counts their shards, because the server lists every tenant of a collection there as a shard, so a shard count would be a tenant count and an object sum less one tenant's count another tenant's count ([weaviate.md](./providers/weaviate.md), section 15.8).
    It takes no `offset`: a result cut at `max_rows` says how to narrow the read, and a read past the 1000-row provider budget is refused with the same advice, so a collection with more than 1000 tenants cannot be listed, only read one tenant at a time.
    It takes no `database`: a collection is part of the request.
  - `run_qdrant_read` runs one read-only Qdrant metadata read, the request agent mode reads: `GET /`, `GET /collections`, a collection's configuration, `exists`, `aliases` or `cluster` read, `GET /aliases`, or `POST /collections/{collection}/points/count` with a body of `exact` alone, as `true` or `false`, and the count route's own `consistency` and `timeout` query keys, which read no stored value, as `statement`.
    Runs on Qdrant; other engines refuse it.
    It reads and admits the request with agent mode's own reader, so a point read, a scroll, a facet, every query, a count's `filter` and every write are refused before anything is acquired, in the sentence an agent run reads.
    Before every read the server must refuse an empty alias update and an empty point delete on each collection the key lists, and the answer is the agent's metadata-only projection: names, counts and flags, never a stored payload or vector ([qdrant.md](./providers/qdrant.md) section 15.7).
    It takes no `offset`: a result cut at `max_rows` says how to narrow the read, and a read past the 1000-row provider budget is refused with the same advice.
    It takes no `database`: a request names its collection in its path.
  - `run_cypher_read` runs one read-only Cypher statement, the statement agent mode reads: a `MATCH ... RETURN`, the `SHOW` forms of indexes, constraints, procedures and functions, or a `CALL` of the eight schema and health procedures, as `statement`.
    Runs on Neo4j; other engines refuse it.
    It reads and admits the statement with agent mode's own reader, so a write, `LOAD CSV`, `USE`, any other procedure, a parameter and a comment are refused before anything is acquired, in the sentence an agent run reads; the `SHOW DATABASE` forms are refused by the server's own classification of the statement, so no database listing or server address is read.
    It runs only on Neo4j Enterprise Edition, as a user the server proves read-only before every statement, so Community Edition is refused at the open.
    It takes no `offset`: a result cut at `max_rows` or at the 32 KiB result limit says to page inside the statement with `ORDER BY`, `SKIP` and `LIMIT`, and a read past the 1000-row provider budget is refused with the same advice.
    It takes no `database`: a Neo4j connection reads the one database it names, as an agent run does.
  - `run_redis_read` runs one read-only Redis metadata read, the command agent mode reads: `DBSIZE`, or, for one key the command names, `TYPE`, `EXISTS`, `TTL`, `PTTL`, `STRLEN`, `LLEN`, `HLEN`, `SCARD`, `ZCARD`, `XLEN`, `OBJECT ENCODING` or `MEMORY USAGE` with `SAMPLES` 1 to 5, on one line, as `statement`.
    Runs on Redis; other engines refuse it.
    It reads and admits the command with agent mode's own reader, so a write, a key listing (`SCAN`, `KEYS`, `RANDOMKEY`), a value read, `INFO`, `SELECT`, a second command and a command longer than 4,096 characters are refused before anything is acquired, in the sentence an agent run reads.
    Key names count as stored values, so its answer is the agent's metadata-only projection: one row of counts, types and sizes that never repeats the key it was asked about, and a server error worded by its code alone, since a Redis error can repeat a key ([redis.md](./providers/redis.md#164-metadata-only)).
    What a call can read is what its ACL user's key patterns allow: a key outside them is refused by the server, in the same words whether the key exists or not, words that never name it; `DBSIZE` counts every key of the connection's database whatever the patterns, and a `~*` user answers whether any key it names exists.
    A read has two effects of the server's own: a read of a key whose time to live has passed deletes it, and on a server whose `notify-keyspace-events` holds the key-miss class, every key read of the table but `OBJECT ENCODING` and `MEMORY USAGE` publishes a `keymiss` event naming that key to the server's own subscribers when the key is missing.
    Every read answers one row, so it takes no `offset` and no read reaches the 1000-row provider budget.
    It takes no `database`: a Redis connection reads the numbered database it names, and no command of the table switches it.
  - `run_rabbitmq_read` runs one read-only read of one RabbitMQ stream, the read request agent mode reads: one JSON object with the keys `vhost`, `stream`, `from` and `limit` and no other, as `statement`.
    Runs on RabbitMQ; other engines refuse it.
    It reads and admits the request with agent mode's own reader, so a request with any other key, a `limit` past 500, text that is no read request and a request longer than 4,096 characters are refused before anything is acquired, in the sentence an agent run reads; a classic or quorum queue is refused by the provider's type check before any frame, since reading one removes its messages.
    Its answer is the agent's metadata-only projection: each message's offset and body size, and never a message's body, headers, properties or routing key.
    A read that stops before its `limit` for any reason but the stream's end is refused rather than answered in part.
    An answer carries no warning text: a read that stops before its `limit` because no message arrived for 1 s answers the messages it read, which is not proof of the stream's end, and a read from `next` answers only messages published after the read starts, and the tool's description says both.
    It takes no `offset`: a result cut at `max_rows` says to start the next read at `{"offset": n}`, `n` the last offset returned plus one, and since a `limit` is at most 500 no read reaches the 1000-row provider budget.
    It takes no `database`: a request names its virtual host in `vhost`, and the broker's permissions for the seed's user decide which virtual hosts and streams it reads ([rabbitmq.md](./providers/rabbitmq.md#17-agent-mode)).
  - `run_kafka_read` runs one read-only Kafka metadata read, the JSON read request agent mode reads: `{"read": "topics"}`, `{"read": "brokers"}`, `{"read": "partitions", "topic": "<name>"}` or `{"read": "offsets", "topic": "<name>"}`, each with an optional `limit` (1 to 500, default 50) and `after`, as `statement`.
    Runs on Apache Kafka; other engines refuse it.
    It reads and admits the request with agent mode's own reader, so a fetch, a produce, a timestamp lookup, an administrative call, a key outside the four, a request longer than 4,096 characters and a request that names one of Kafka's internal topics or a platform's own topic are refused before anything is acquired, in the sentence an agent run reads.
    Its answer is the agent's metadata projection: topic names with partition and replica counts, broker node ids and racks, the cluster id, each partition's leader and replicas and its earliest and end offsets; never a record's key, value, headers or timestamp, a broker's host and port, a config, a log directory or a consumer group.
    A platform's own topics, named with a leading underscore (Schema Registry's `_schemas`, Confluent's `_confluent-*`) or `connect-` (Kafka Connect's), are withheld from every listing, as they are in agent mode and in `inspect_schema` ([kafka.md](./providers/kafka.md#16-mcp)).
    It takes no `offset`: page inside the request with `limit` and `after`, the last topic name, node id or partition id read; an answer that holds as many rows as its `limit` may have more after it, since the provider's "more follow" note is not part of an MCP answer, and a result cut at `max_rows` or 32 KiB says to read on with `after`.
    A read answers at most 500 rows, so the 1000-row provider budget never refuses one.
    It takes no `database`: a Kafka connection has no catalog level.
  - `run_mtconnect_read` runs one read-only MTConnect read, the request line agent mode reads: `/probe`, `/current`, `/sample` or `/assets`, each for every device or for one, or `/asset/{assetIds}`, written as the console writes it with GET implied, as `statement`.
    Runs on MTConnect; other engines refuse it.
    It reads and admits the line with agent mode's own reader, so a PUT, a POST, `/cancel`, a streaming parameter (`interval`, `heartbeat`, `frequency`), a second request line, a dot segment and a `path` outside agent mode's subset are refused before anything is acquired, in the sentence an agent run reads; a `count` past the 1000-row provider budget is refused by the provider before anything is sent.
    Each call reads the agent's device model with `GET /probe` and then sends the one request, so a device the model does not hold, or a `path` value that no data item it answers holds, is refused after the model read and before the request, in the same words whether the value is a withheld adapter id or no id at all.
    Its answer is agent mode's: observations as the console renders them and each asset with its document as XML text, with the agent's own adapter connections, whose names, ids and `ADAPTER_URI` values carry the adapter's network address, left out, and every URL in an asset kept to its scheme, host, port and path, everything from its `://` to the last `@` in the value and from the first `?` or `#` after that to the end of the value, its user name, password, query string and fragment, reading `[withheld]` ([mtconnect.md](./providers/mtconnect.md#14-agent-mode)).
    It takes no `offset`: a result cut at `max_rows` says how to narrow the read with a device, a path or a smaller count, and a read past the 1000-row provider budget is refused with the same advice.
    It takes no `database`: a request line names its device.
- Each statement tool is one statement language's MCP facet, declared in that language's own pack at `src/lib/agent/languages/<statement-language>/mcp.ts` and registered in `AGENT_LANGUAGE_MCP_FACETS`: the tool's name, its statement argument, its description and the words its refusals use.
  `src/lib/mcp/tools/statement-arms.ts` builds the tools from those facets and names no language, so a language that gains an MCP tool adds its facet and edits nothing under `src/lib/mcp/`.
- Read-only is the database's own enforcement, not a filter over statement text: `run_read_query`, `run_kubectl_read`, `run_mongo_command`, `run_libredb_read`, `run_weaviate_read`, `run_qdrant_read`, `run_cypher_read`, `run_redis_read`, `run_rabbitmq_read`, `run_kafka_read` and `run_mtconnect_read` take the connection under Studio's agent read-only execution profile and run through the provider's read-only statement path, which PostgreSQL enforces with a read-only transaction, SQLite and DuckDB with a read-only open, SQL Server by verifying the principal cannot write, MySQL and MariaDB by a least-privilege principal beside a read-only transaction, ClickHouse by `readonly = 1` on every request beside a user proven at open to hold only reads ([clickhouse.md](./providers/clickhouse.md)), libSQL by a token proven at open to be read-only, which the server refuses every write ([libsql.md](./providers/libsql.md)), Elasticsearch by the grammar of its SQL endpoint, which holds no write, DDL or transaction statement, on a server checked at open to be the 9.1 release line whose refusals were captured, with a login narrowed at open, when security is on, to hold no cluster privilege `all` and no broad reach over the restricted system indices, while hidden and system indices are kept from each statement by the provider's statement check ([elasticsearch.md](./providers/elasticsearch.md)), OpenSearch by its SQL plugin, which refuses every write and DDL statement, on a server whose `DELETE` setting is proved off and whose 3.8 release line is checked at open, with a login probed at open, when security is on, for access to the security plugin's REST API and for a delete by query and an index close on a fresh index name, which narrows the login while the statement check and the plugin refuse every write whatever it is, and with hidden and dot-led indices and the indices the bundled plugins write into kept from each statement by the provider's statement check ([opensearch.md](./providers/opensearch.md)), InfluxDB 3 (SQL) by the 3.12 Core planner, which refuses every write, DDL, `COPY`, `SET` and transaction statement whatever the token, on a server checked at open to be that line ([influxdb3.md](./providers/influxdb3.md)), Oracle by a user set `ALTER USER ... READ ONLY`, which the server refuses every write, checked before every statement, on that statement's own session, to reach nothing READ ONLY leaves open and to read nothing of Oracle's own schemas beyond what `PUBLIC` may ([oracle.md](./providers/oracle.md)), Db2 LUW by a user checked as itself before every statement, on that statement's own connection, to hold nothing but `CONNECT` and `SELECT`, which the server refuses every write, and no read of the catalog's distribution or column statistics, with the statement sent inside a derived table that only a fullselect fits ([db2.md](./providers/db2.md)), Apache Cassandra by a role checked at open and again before every statement, on that statement's own session, to be no superuser and to hold only `SELECT` on the connection's keyspace, on an Apache Cassandra 5.0 server that enforces its grants, while the provider sends one `SELECT` of a table of that keyspace or of `system_schema` and nothing else ([cassandra.md](./providers/cassandra.md)), Couchbase by a user whose only roles are `query_select` on named scopes of the connection's bucket, checked at open and again before every statement on a server proven to refuse that user a write, behind the provider's fence that sends one `SELECT` ([couchbase.md](./providers/couchbase.md)), MongoDB by proving at open that the user holds only reads of its database on a server that enforces authorization ([mongodb.md](./providers/mongodb.md)), Redis by the provider's closed table of metadata reads, which holds no write, with an ACL user the server refuses fifteen write, admin, dangerous, scripting and pubsub probes as commands it does not hold, at open and again before every command on that command's own connection ([redis.md](./providers/redis.md#161-the-boundary)), Kubernetes by Studio's request allowlist on the final method and path of every request together with the token's RBAC ([kubernetes.md](./providers/kubernetes.md)), LibreDB by a read-only handle opened for each command through Studio's read-only file adapter, whose descriptor the operating system does not write through and whose write call refuses before writing ([libredb.md](./providers/libredb.md)), Weaviate by the provider's closed table of read requests, which names no write, with a key the server proves before every read to hold the viewer role's read actions only ([weaviate.md](./providers/weaviate.md)), Qdrant by the provider's closed table of read routes together with a key the server refuses an empty alias update and an empty point delete on every collection it lists, before every request ([qdrant.md](./providers/qdrant.md)), Neo4j by a user the server proves, at open and again before every statement, to be on Enterprise Edition with only reads granted across every role, no `LOAD` and no extension it can execute, with every statement classified by the server and run in a READ session ([neo4j.md](./providers/neo4j.md)), RabbitMQ by Studio's read client, which encodes no take, publish, purge or declare, checks before any frame that the object is a stream and consumes with a stream offset the broker refuses on any other queue, because a read permission in RabbitMQ also grants a take and a purge ([rabbitmq.md](./providers/rabbitmq.md)), Apache Kafka by the provider's agent client, which holds the Metadata request, sent with topic auto-creation off, and the ListOffsets request at the earliest and latest offsets alone, so no produce, fetch, topic or config change, offset commit or group read can be sent ([kafka.md](./providers/kafka.md#16-mcp)), and MTConnect, whose agent authenticates nothing, by the provider's closed table of nine GET routes, sent by a client with no method argument and no body ([mtconnect.md](./providers/mtconnect.md)).
  A statement check runs first as defence in depth.
- A result that carries database content starts with a text block telling the model to treat what follows as untrusted data.
- A profile refusal raised by the statement call itself, where the provider checks its principal before every statement, as Oracle's does, names objects and roles any user of the database may have named (functions, views, policies, roles), so it is answered in the tool's sentence behind that notice; a profile refusal at the open carries no notice.

## Enabling it

Four variables decide it, and `.env.example` documents each.

| Variable | What it sets |
|---|---|
| `LIBREDB_MCP_ENABLED` | `true`, `on` or `1` enable MCP; `false`, `off`, `0`, empty or unset leave it off; any other value is an error on every authenticated request |
| `LIBREDB_MCP_URL` | The address clients use, which every token is bound to: an absolute http(s) URL ending in `/api/mcp`, with your `BASE_PATH`, and no user name, password, query or fragment |
| `LIBREDB_MCP_TOKEN_LABEL` | Any non-empty value; changing it revokes every MCP token at once |
| `LIBREDB_MCP_TOKEN_TTL_DAYS` | How many days a minted token stays valid, from 1 to 365, 30 when unset |

Governance mode (`GOVERNANCE_SOURCE`, see [GOVERNANCE.md](./GOVERNANCE.md)) switches MCP off whatever these variables say, until a later Studio release runs it under governance.
`/api/mcp` answers a valid token with `404`, as it does with MCP switched off, `GET /api/mcp/token` reports the channel off and names the hold as its one problem, and no token is minted.
The boot check of governance mode refuses `LIBREDB_MCP_ENABLED` switched on as well, and the hold stands even where that check did not run.
A control plane may set the runtime setting `mcp.enabled`, which `/api/mcp` reads again on every request and which wins over `LIBREDB_MCP_ENABLED` once the hold is lifted.
`LIBREDB_MCP_URL`, `LIBREDB_MCP_TOKEN_LABEL` and `LIBREDB_MCP_TOKEN_TTL_DAYS` stay prerequisites in the environment, so `true` enables only what they configure.
While the hold stands the setting has no effect, so a control plane shows it read-only and Studio's admin status reports it as held, with the note that MCP and agent governance ship in v1.1.

The Kubernetes access review (`KUBERNETES_ACCESS_REVIEW`, see [Kubernetes access review](./SEED_CONNECTIONS.md#kubernetes-access-review)) holds MCP off the same way: an MCP token carries no groups record for a review to assert, so `/api/mcp` answers `404`, `GET /api/mcp/token` names the review's hold as its one problem, and the boot check refuses `LIBREDB_MCP_ENABLED` switched on.

### npx

The launcher derives `LIBREDB_MCP_URL` from the address and port it serves on, so only the switch and the label are yours:

```bash
LIBREDB_MCP_ENABLED=true LIBREDB_MCP_TOKEN_LABEL=studio-mcp-1 npx @libredb/studio
```

The derived address is `http://127.0.0.1:3000/api/mcp` unless `--host` or `--port` says otherwise, and changing either invalidates every token minted for the old address.
Set `LIBREDB_MCP_URL` yourself when clients reach Studio through another address, such as a reverse proxy.
The launcher resolves a relative path variable, such as `SEED_CONFIG_PATH`, against the directory you run `npx` from, so `SEED_CONFIG_PATH=./seed-connections.yaml` finds the file beside you.

### Docker and Compose

Add the three settings to the container's environment:

```bash
docker run -p 3000:3000 \
  -v libredb-data:/app/data \
  -e LIBREDB_MCP_ENABLED=true \
  -e LIBREDB_MCP_URL=https://studio.example.com/api/mcp \
  -e LIBREDB_MCP_TOKEN_LABEL=studio-mcp-1 \
  ghcr.io/libredb/libredb-studio:latest
```

The `libredb-data` volume keeps `/app/data`, where Studio stores the admin credentials and the `JWT_SECRET` it generates when you set none, so every MCP token survives the container being recreated; without it, a new container generates a new `JWT_SECRET` and every MCP token stops verifying.
In `docker-compose.example.yml`, uncomment the four `LIBREDB_MCP_*` lines beside the agent flag.

### Helm

```bash
helm upgrade libredb libredb/libredb-studio --reuse-values \
  --set mcp.enabled=true \
  --set mcp.url=https://studio.example.com/api/mcp \
  --set mcp.tokenLabel=studio-mcp-1
```

An enabled `mcp` block without `mcp.url` or `mcp.tokenLabel` refuses to render and names the value.

### Other channels

The native packages and every other way of running `server.js` derive nothing: set all three yourself.

## Opting connections in

An MCP client reaches a connection only when its seed entry says `mcp: true`, and only when the connection's `roles` admit the role your token carries ([`docs/SEED_CONNECTIONS.md`](SEED_CONNECTIONS.md)).

```yaml
connections:
  - id: shop
    name: Shop
    type: postgres
    host: db.internal
    database: shop
    roles: ["*"]
    mcp: true
```

The opt-in is per connection, so `defaults.mcp` is refused.
A SQLite seed's `database` is an absolute path on the machine running Studio, and under Docker a path inside the container, so mount the file there.
The built-in sample connections are never visible to an MCP client.
An empty `list_connections` answer means no connection is opted in for your token's role: an operator adds `mcp: true` to a seed connection.

`run_read_query` refuses a PostgreSQL, SQL Server, ClickHouse, libSQL, Oracle, Apache Cassandra or Couchbase connection whose own login could do more than read, so an opted-in seed for those engines needs a least-privilege principal.
On PostgreSQL the seed's role must not be a superuser and must not hold `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`.
On SQL Server the login must hold no fixed server role, neither `CONTROL SERVER` nor `ADMINISTER BULK OPERATIONS`, and none of `db_owner`, `db_accessadmin`, `db_securityadmin`, `db_ddladmin`, `db_backupoperator` or `db_datawriter`, and it must be granted `SHOWPLAN`.
On libSQL the seed's token must be a read-only token (a JWT whose claims carry `"a": "ro"` and nothing beyond the standard claims) on a server that checks it, as the open proves for agent mode ([libsql.md](./providers/libsql.md) section 3.6): a seed that names a user signs in with HTTP Basic and is refused, and so is a seed with no token, a writable token, or a server that runs a write the token sends, such as one that checks no credential.
On InfluxDB 3 (SQL) every Core token is an admin token, so no seed token is least-privilege and none is asked for: `run_read_query` refuses instead a server that is not InfluxDB 3 Core on the 3.12 line, whose planner's write refusals were captured, as the open does for agent mode ([influxdb3.md](./providers/influxdb3.md) section 3.5).
On Elasticsearch with security on, the open asks the server what the seed's login may do and lists its privileges, and refuses, before any statement runs, a login that holds the cluster privilege `all`, reads the restricted system indices it asks about, or is listed with an index privilege granted with `allow_restricted_indices`, on this cluster or a remote one, so a seed signed in as a superuser is refused; that check cannot name every restricted index, and the server lists no privileges for an API key with role descriptors of its own, so it does not refuse every login that may read one.
The provider sends no run-as header, so every request runs as the seed's own login, and a `run_as` privilege in its role does not widen what `run_read_query` reads.
With security on or off, the boundary is the provider's statement check: it reads each statement before sending it, refusing one it cannot read with certainty and one whose index expression holds an exclusion or a name that starts with a dot, and asks the server what its index resolves to, in the server's own index resolution and in the one the SQL endpoint makes, refusing a statement whose index resolves to a hidden or system index, alias or data stream, or which the two resolutions do not resolve alike.
`run_read_query` needs the cluster action `cluster:monitor/main` and `read` and `view_index_metadata` on the indices to read, and `inspect_schema` also the cluster privileges `monitor` and `read_pipeline` and the index privilege `monitor`, which is the `libredb_seed_read` role of [elasticsearch.md](./providers/elasticsearch.md) section 5.9, so opt in a seed signed in with that role.
On OpenSearch with security on, the open asks the security plugin whether the seed's login may call its REST API and probes a document delete by query and an index close on a fresh index name, and refuses, before any statement runs, a login the plugin lets do any of the three, so a seed signed in as `admin` is refused.
The probes show only that: a role granting writes on a pattern the fresh name does not match, or only granular write, create, delete or alias actions, passes them, and the statement check and the plugin refuse every write it sends, so the boundary is not the login.
With security on or off, hidden and dot-led indices and the indices the bundled plugins write into, such as `top_queries-*` and `security-auditlog-*`, are kept from each statement by the provider's statement check, which reads the statement before sending it and asks the server what its one index expression resolves to, in its own index resolution and in the field capabilities request that names the indices the SQL plugin reads.
`run_read_query` needs the cluster actions `cluster:monitor/main` and `cluster:monitor/state` and, on the indices to read, `read`, `indices:admin/mappings/get` and `indices:monitor/settings/get`, and `inspect_schema` also the cluster actions `cluster:monitor/health`, `cluster:admin/ingest/pipeline/get` and `indices:admin/index_template/get` and five index actions on every index, which is the `libredb_seed_read` role of [opensearch.md](./providers/opensearch.md) section 5.9, so opt in a seed signed in with that role.
On Apache Cassandra the seed must name its keyspace as `database`, a keyspace of the user's data, since a seed bound to one of Cassandra's own keyspaces (`system`, `system_auth`, `system_traces` and the rest) is refused at open whatever its role holds, and its `user` must be a role that is no superuser, holds no superuser role, and holds only `SELECT` on that keyspace or on tables of it, directly or through roles granted to it, with no column of the keyspace masked by a function outside the `system` keyspace, on an Apache Cassandra 5.0 server with `PasswordAuthenticator` and `CassandraAuthorizer`, as the check proves for agent mode ([cassandra.md](./providers/cassandra.md) section 14.2): the image's default `cassandra` superuser is refused, and so is a role holding `MODIFY`, `EXECUTE`, `UNMASK` or `DESCRIBE`, or `SELECT` on every keyspace, a node on `AllowAllAuthorizer`, and ScyllaDB.
On Couchbase the seed's user must hold no role but `query_select` on named scopes of the seed's bucket (`query_select[<bucket>:<scope>]`, one for each scope it reads), never on every scope or on the bucket's `_system` scope, counting the roles of its groups, on a server that refuses that user a write, as the check proves at open and before every statement for agent mode ([couchbase.md](./providers/couchbase.md) section 15.7): the administrator, `ro_admin`, `query_system_catalog`, `data_reader`, a role on another bucket, a group that grants a writing role and every Community Edition user are refused.
On ClickHouse the seed's user must hold only `SELECT` and `SHOW` on named databases or tables, with no source grant, no grant that `readonly = 1` leaves usable (such as `BACKUP`), no read of `system.query_log`, no table that reads an external source and no executable function on the server, as the open proves for agent mode ([clickhouse.md](./providers/clickhouse.md) section 5.6).
On Oracle (23ai and later) the seed's user must be a local user set `ALTER USER ... READ ONLY` that holds `CREATE SESSION`, `SELECT` on the tables to read and, granted by SYS, `SELECT` on `SYS.DBA_POLICIES` and `SYS.DBA_AUDIT_POLICIES`, and nothing more, as the check before each agent statement proves ([oracle.md](./providers/oracle.md) section 5.7).
The check runs before every statement, not at the open, so `run_read_query` answers its refusal in its own sentence and sends nothing: a user that is not READ ONLY, such as SYSTEM or the schema owner, one holding a system privilege beyond `CREATE SESSION` or a role carrying one, `CONNECT` and `DBA` included, `EXECUTE` on code that is not Oracle's, or any grant on a schema Oracle maintains beyond those two catalogs, such as `SELECT_CATALOG_ROLE` or `AUDIT_VIEWER`, and any user while the database holds a database link or a row-level security or fine-grained auditing policy that runs code that is not Oracle's.
A grant added between two calls refuses the next call, and a lifted one admits it.
`run_read_query` refuses a Db2 LUW connection whose own user could do more than read, checked before every statement rather than at the open, so an opted-in Db2 seed needs a least-privilege user too.
On Db2 LUW the seed's user must hold `CONNECT` and `SELECT` on the tables it may read and nothing else, with no authority such as `DBADM`, `DATAACCESS`, `ACCESSCTRL`, `SECADM` or `SQLADM`, no `EXECUTE` on code that is not IBM's (the casts and comparisons Db2 generates for a distinct type, which it grants to `PUBLIC`, count as IBM's), and none on an IBM monitor function or module, or `SELECT` on a `SYSIBMADM` monitor view, through a grant a user made rather than the database, since that is what shows other sessions' statements, no `SELECT` on the catalog's distribution statistics or on the seven objects that keep every column's second highest and lowest value, `SYSCAT.COLUMNS` among them, directly or through a view, and no trusted context naming it, on a database that holds no row permission or column mask of its own, as the check proves for agent mode ([db2.md](./providers/db2.md) section 10.1); a fresh database is refused until the operator revokes what it grants `PUBLIC`, as `docker/db2-init/02-agent-principal.sql` does, and the refusal names each revoke.
A seed entry cannot carry a separate agent credential, so the fix is the seed's own login.
`inspect_schema` acquires its connection read-only too, under `agent-operations` where `run_read_query` takes `agent-read-only`, and on PostgreSQL and SQL Server both profiles verify the principal at open, not per statement, so the same least-privilege requirement applies there too: a superuser PostgreSQL role or a privileged SQL Server login refuses `inspect_schema` as well.
ClickHouse proves its user only for a connection that sends statements, so `inspect_schema` opens a ClickHouse connection unproven, as the editor does.
libSQL proves its token only for a connection that sends statements, so `inspect_schema` opens a libSQL connection unproven, as the editor does, with a writable token or HTTP Basic too.
InfluxDB 3 checks its server's line only for a connection that sends statements, so `inspect_schema` opens an InfluxDB 3 connection on any 3.x server, as the editor does.
Elasticsearch checks its server's release and its login only for a connection that sends statements, so `inspect_schema` opens an Elasticsearch connection on any release, as the editor does.
OpenSearch proves its `DELETE` off, checks its server's release and probes its login only for a connection that sends statements, so `inspect_schema` opens an OpenSearch connection on any release and with any login, as the editor does.
Oracle checks its user only on a call that sends a statement, so `inspect_schema` opens an Oracle connection unchecked, as the editor does, and lists what the seed's user may see in the `ALL_*` views.
Db2 LUW checks its user only before a statement it sends, so `inspect_schema` opens a Db2 connection unchecked, as the editor does.
Apache Cassandra checks its role only for a connection that sends statements, so `inspect_schema` opens an Apache Cassandra connection unproven, as the editor does, with a superuser too.
Couchbase checks its user only for a connection that sends statements, so `inspect_schema` opens a Couchbase connection unchecked, as the editor does, with the administrator too.
On Neo4j the seed's `user` must be one the proof admits on Enterprise Edition: a copy of the `reader` role with `LOAD` revoked from `PUBLIC` or denied to one of its roles, granted only reads across every role it holds, and able to execute no procedure or function beyond the server's built-ins, as the proof checks at open and before every statement for agent mode ([neo4j.md](./providers/neo4j.md) section 15.7): the administrator, a user with the `editor` role, a user that may `LOAD` and every Community Edition user are refused.
Grant it `ACCESS` on the seed's database alone, since `USE` of another database it may access is stopped only by Studio's statement reader.
Neo4j proves its user only for a connection that sends statements, so `inspect_schema` opens a Neo4j connection unproven, as the editor does.
It lists the labels and relationship types the seed's user may traverse, with the properties it may read; a user without `SHOW INDEX` is listed them too, and with `include_indexes` each one's indexes are answered unavailable in the server's words.
MongoDB proves its principal only for a connection that sends statements, so `inspect_schema` opens a MongoDB connection unverified, as the editor does, and no principal check refuses it there (`tests/integration/mcp/inspect-schema.test.ts` lists the collections of the admin seed, of a server without authorization and of FerretDB).
A LibreDB file has no user, so a LibreDB seed proves no principal and carries none: `run_libredb_read` reads every key of the one file the seed's `database` names, and nothing else.
Studio's own storage database, its `-wal` and `-shm` files and its `auth-bootstrap.json` are refused as a LibreDB target before anything is opened, compared by resolved path and by file identity, so a symbolic or hard link to one is refused too, a file that is no LibreDB file is refused by the engine's own format check and left as it was, and a missing file is refused by `run_libredb_read` and `inspect_schema` alike, which create neither it nor its lock ([libredb.md](./providers/libredb.md#158-mcp-run_libredb_read)).
So opt in a seed whose file holds only what the roles it names may read.
A Weaviate seed's `password` is the API key every MCP call on it reads as, and `run_weaviate_read` has the server prove it before every read, at the open and again before each request: the key must name at least one role and no OIDC group, and every action of every role must be one of the built-in `viewer` role's read actions, so the root key, an administrator's key, a role that also writes, a key on a server with RBAC off and a seed with no key are refused ([weaviate.md](./providers/weaviate.md) section 15.2).
A custom role of viewer actions scoped to some collections, tenants and aliases passes that proof and narrows what the tool reads, since the server filters the schema, tenant and alias lists by it and refuses a read outside it.
Weaviate proves its key only for a connection that sends statements, so `inspect_schema` opens a Weaviate connection unproven, as the editor does, with the root key too, and lists the collections any key may read the definitions of, reading no stored object and passing on none of the server's words.
`run_qdrant_read` refuses a Qdrant connection whose key the server answers a write, or that carries none, at the open, in its own sentence, before the read is sent.
On Qdrant the seed's `password` must be the server's read-only API key or a JWT whose access is `r`, globally or on the collections the client should read, with no claim beside `exp`, `iat`, `nbf`, `sub` and `value_exists`, on a server with a key configured, and the key must list at most 32 collections, as the proof shows before every agent request ([qdrant.md](./providers/qdrant.md) section 15.7): the API key, a JWT that manages, names no access or writes a collection or an alias, and any key on a server with no key configured are refused.
The proof runs before every call, so a key listing N collections costs N + 3 requests per call, N + 4 more on the call that opens the connection.
The read-only API key reads every collection and alias the server holds; a JWT whose access is `r` on named collections lists those alone and is refused every other, whether it exists or not.
Qdrant proves its key only for a connection that sends statements, so `inspect_schema` opens a Qdrant connection unproven, as the editor does, with the API key too.
A Kafka seed needs no least-privilege principal and none is proven, since the agent's client can send no write whatever the login may do; what `run_kafka_read` and `inspect_schema` list is every topic the seed's login may Describe, so opt in a login that holds `Describe` on the topics meant to be listed and nothing on the rest ([kafka.md](./providers/kafka.md#16-mcp)).
A Redis seed's `user` must be an ACL user of its own, never `default`, that the server refuses every write probe as a command it does not hold, such as `on`, a password, `~*` and `+@read`, on a standalone Redis or Valkey server, as the proof shows for agent mode; a seed that names a database other than 0 also needs `+select`, which `+@read` does not hold, or it is refused at the open ([redis.md](./providers/redis.md#162-the-read-only-proof)).
`run_redis_read` refuses at the open, in its own sentence and before any command, a seed that names no user or names `default`, before any socket, and one whose user may run a probed write, `~* &* +@all` and `+@read +del` among them, or holds a write and is refused it only by its key patterns, such as `~app:* +@read +@write`; KeyDB 6.3.4, whose refusals are worded otherwise, and Garnet 2.1.5, whose `HELLO` differs, are refused too.
A key-pattern user such as `~app:* +@read` passes and reads only the keys its patterns cover; a `~*` user may ask about any key it names.
Redis proves its ACL user only for a connection that sends statements, so `inspect_schema` opens a Redis connection unproven, as the editor does, with any user, `default` and a `+@read` reader included, and lists the leading segment of each key grouping (`user:*`), never a full key name and never a function library.
Its walk is not filtered by the user's key patterns, so a key-pattern user is listed the groupings of keys outside them too, a user refused `CONFIG GET` is listed its session database alone, and a refusal is worded by the command it names, never the user ([redis.md](./providers/redis.md#167-mcp-read)).
A Kubernetes seed's `password` is the ServiceAccount token every MCP call on it runs as, because a seed carries no separate agent token, so opt in a token bound to a read role such as `view` or `studio-reader` ([kubernetes.md](./providers/kubernetes.md#45-a-serviceaccount-token-view-and-studio-reader)).
A RabbitMQ seed's user is never proven read-only, because a read permission in RabbitMQ also lets a user take and purge messages, so no user can be the boundary: `run_rabbitmq_read` serves any user, the administrator included, and Studio's read client is the boundary.
The broker's permissions still decide what it reads: measured on 4.3.6, a user with no permission on a virtual host is refused that virtual host in the same words whether the stream exists and whether the virtual host exists, and a stream outside its read pattern is refused by the broker ([rabbitmq.md](./providers/rabbitmq.md#17-agent-mode)).
So opt in a user tagged `management` with read permission on one virtual host's streams and no configure or write permission.
An MTConnect seed carries no credential, because an MTConnect agent authenticates nothing: whoever reaches its port reads what it serves, and an agent set `AllowPut = true` accepts writes from anyone, so the boundary is the provider's closed route table, never a login, and `run_mtconnect_read` reads what the agent serves any client, its adapter connections and the secrets in an asset's URLs aside ([mtconnect.md](./providers/mtconnect.md#14-agent-mode)).

A PostgreSQL seed with an empty `database` reaches every database its role can CONNECT to (#1530, [`docs/providers/postgres.md` §4.1.1](providers/postgres.md#411-server-level-connections-an-empty-database-1530)).
On such a connection both `inspect_schema` and `run_read_query` take a `database` argument naming the one to read, and a call without it is answered, in Studio's words, with the databases it could name (at most fifty), rather than run in whichever came first.
On every other connection `database` is refused, because the connection names its own.
The answer echoes the `database` it read.

## Getting a token

On a first start without `ADMIN_PASSWORD`, Studio generates an admin, `admin@libredb.org`, with a random password and prints both once: under npx in the terminal, under Docker in `docker logs`.
It also stores the password in `auth-bootstrap.json` in its data directory, the directory of `STORAGE_SQLITE_PATH` (`/app/data` in the image), and a later start prints only that file's path.
An admin signs in to the admin dashboard, which has no user menu: choose **Editor**, then the user menu at the top right, then **MCP**.
That opens the settings screen at `/settings/mcp`.
It shows whether MCP is ready on this server, what an operator has to set when it is not, and how many connections your role can reach.
When it is ready, **Create token** mints one for you and shows it once: copy it then, because it is not shown again and nothing about it is stored.

- A token is valid for `LIBREDB_MCP_TOKEN_TTL_DAYS` days, 30 by default.
- It carries the role you had when you minted it, as well as any custom claim roles (`claimRoles`) mapped from your OIDC session.
- Creating a token needs a sign-in from the last ten minutes: an older session is asked to sign in again, because a session lives 24 hours.
- With local sign-in and `STORAGE_PROVIDER=sqlite` or `postgres`, every call checks the token against the stored account, as a session is checked, so a token stops working at its next call when its account is disabled, changes role, has its password set by an admin, is deleted, removes one of its passkeys, or has its passkeys removed by an admin.
- Changing `LIBREDB_MCP_TOKEN_LABEL` revokes every MCP token at once.
  Under OIDC and with `STORAGE_PROVIDER=local` there is no stored account to check, so that is the one revocation there: a lowered role, removed claim roles, a disabled OIDC account or a changed password leaves the tokens valid until they expire or the label changes.
  IdP roster changes or group membership removals do not immediately revoke an existing token's claim roles until token expiry or label rotation; set an appropriately short `LIBREDB_MCP_TOKEN_TTL_DAYS` (or rotate `LIBREDB_MCP_TOKEN_LABEL`) if your environment relies on dynamic IdP team rosters.
  Removing a person's access there takes two steps: stop them signing in, then rotate `LIBREDB_MCP_TOKEN_LABEL` once ten minutes have passed, so no session they still hold can mint under the new label.
- Rotating `JWT_SECRET` ends every session and revokes every MCP token at once.
- A changed `LIBREDB_MCP_URL`, and under npx a changed `--host` or `--port`, invalidates every token too.

## Client configuration

Every example that reads the token from the environment reads `LIBREDB_MCP_TOKEN`:

```bash
export LIBREDB_MCP_TOKEN='<your-mcp-token>'
```

The name is Studio's own on purpose: Claude Code reads a set of well-known credential variables as empty toward a remote server, and a name of your own expands.
Never commit a token.

### Claude Code

Verified live on 2026-09-26 with Claude Code 2.1.283.

In `.mcp.json`:

```json
{
  "mcpServers": {
    "libredb": {
      "type": "http",
      "url": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${LIBREDB_MCP_TOKEN}"
      }
    }
  }
}
```

Or from a shell:

```bash
claude mcp add --transport http libredb https://studio.example.com/api/mcp --header "Authorization: Bearer ${LIBREDB_MCP_TOKEN}"
```

Claude Code shows a 401 from a server whose `Authorization` header you configured as a failed connection, and it marks a server configured without that header for an OAuth sign-in, which Studio does not offer.

### Codex

Not verified live.

In `~/.codex/config.toml`:

```toml
[mcp_servers.libredb]
url = "https://studio.example.com/api/mcp"
bearer_token_env_var = "LIBREDB_MCP_TOKEN"
```

### Cursor

Not verified live.

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "libredb": {
      "url": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:LIBREDB_MCP_TOKEN}"
      }
    }
  }
}
```

### VS Code

Not verified live.

In `.vscode/mcp.json`; VS Code asks for the token once and stores it:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "libredb-mcp-token",
      "description": "LibreDB Studio MCP token",
      "password": true
    }
  ],
  "servers": {
    "libredb": {
      "type": "http",
      "url": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${input:libredb-mcp-token}"
      }
    }
  }
}
```

VS Code's Agent Host does not receive servers that need an `${input:...}` value.

### Gemini CLI

Not verified live.

In `~/.gemini/settings.json`; Gemini CLI takes the streaming HTTP address as `httpUrl`, because `url` selects its SSE client, and it takes the token written in:

```json
{
  "mcpServers": {
    "libredb": {
      "httpUrl": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-mcp-token>"
      }
    }
  }
}
```

Or run `gemini mcp add -t http -H "Authorization: Bearer <your-mcp-token>" libredb https://studio.example.com/api/mcp`.
Do not commit a settings file that holds a token.

### OpenCode

Verified live on 2026-09-26 with OpenCode 1.18.31, 1.18.32 and 2.0.18, on Linux and Windows.

In `opencode.json`, as a remote server under `mcp.servers`, where OpenCode 2 looks for servers and OpenCode 1 reads them too ([OpenCode's MCP servers page](https://opencode.ai/docs/mcp-servers), and [the OpenCode 2 page](https://opencode.ai/v2/docs/mcp-servers)); `oauth: false` turns off the OAuth sign-in OpenCode would otherwise attempt, and `{env:...}` reads the token from the environment:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "libredb": {
        "type": "remote",
        "url": "https://studio.example.com/api/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {env:LIBREDB_MCP_TOKEN}"
        }
      }
    }
  }
}
```

`opencode mcp list` shows the server as connected when the token verifies.
OpenCode 2 runs one shared background service that reads `LIBREDB_MCP_TOKEN` when it starts, so set the token before the first `opencode` command, or run `opencode service restart` after setting it.
For the first few seconds after that service starts, `opencode mcp list` can say "No MCP servers configured" or show the server as pending: run it again.

## Limits

- Authentication is a static bearer token that Studio mints: there is no OAuth and no protected resource metadata document, so a client needs its `Authorization` header configured.
- `run_read_query` reads at most 1000 rows and 1 MiB from the database, and answers at most `max_rows` rows (default 100, at most 500) and 32 KiB; `truncated`, `truncated_by`, `pagination.hasMore` and `pagination.nextOffset` say what was cut and where the next page starts.
- On an engine that bills every read, one statement call may spend at most 2000 billed reads (`MCP_CALL_READ_ALLOWANCE`), and each call gets its own allowance; a read past it is refused before it is sent. No engine served by MCP bills its reads yet.
- A statement a provider's own read-only fence refuses before sending it is answered "The statement was refused before it reached the database:" with the provider's sentence, never as the database's error.
- A NaN, Infinity or -Infinity cell in a `run_read_query` answer is the string `"NaN"`, `"Infinity"` or `"-Infinity"`; it used to be `null`, which a client could not tell from SQL NULL. A text cell holding one of those words looks the same.
- A query with its own `LIMIT` or `TOP`, and `VALUES`, `TABLE` or `EXPLAIN`, cannot be paged with `offset`; the answer says how to page it in that engine's SQL.
- `inspect_schema` and `list_connections` fit each page to 32 KiB, and `has_more` and `next_offset` say where the next page starts.
- Every `POST` spends one slot of the same per-user budget the database routes use (`RATE_LIMIT_QUERY_MAX`, 120 a minute by default), so a session and an MCP token of one person share it.
- Studio honours a cancel only when the client closes the request.
  A 2026-07-28 client does that on every cancel, and a 2025 client only by disconnecting.
  A 2025 client's `notifications/cancelled`, sent in a `POST` of its own, gets 202 and is ignored, because each `POST` is answered by a server that keeps no session and does not know the call it names: the call runs to completion or `timeout_ms`, answers on the request that is still open, and is audited that way, never as cancelled.
- A cancel or a timeout ends the wait, not the statement:

| Engine | The client closes the request | `timeout_ms` passes |
|---|---|---|
| PostgreSQL | Studio stops waiting; the statement runs on until `statement_timeout`, which is set to the time left | The database ends the statement, and the client gets the timeout answer |
| SQL Server | Studio stops waiting; the statement runs until the provider's deadline cancels it | The provider cancels the statement, and the client gets the timeout answer |
| DuckDB | Studio stops waiting; the statement runs to completion and its result is discarded | The client gets the timeout answer near `timeout_ms`, and the statement runs on |
| SQLite | An on-disk statement runs in a killable child process, so the client is answered at `timeout_ms` | The statement is killed at `timeout_ms`; an in-memory statement still runs to completion |
| ClickHouse | Studio stops waiting; the statement runs on until its server-side `max_execution_time`, which is set to the time left rounded up to whole seconds, ends it | Studio closes the request at `timeout_ms`, ClickHouse cancels the statement, and the client gets the timeout answer |
| libSQL | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on sqld | Studio closes the request at `timeout_ms`, sqld stops the statement, and the client gets the timeout answer |
| InfluxDB 3 (SQL) | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on InfluxDB 3 Core | Studio closes the request at `timeout_ms`, InfluxDB 3 Core stops the statement, and the client gets the timeout answer |
| Elasticsearch | Studio stops waiting, and the provider closes its request at the time left of `timeout_ms`; the cluster runs the statement to its end, and holds no search context for it once it ends | Studio closes the request at `timeout_ms`, the cluster runs the statement to its end and then holds no search context for it, and the client gets the timeout answer |
| OpenSearch | Studio stops waiting, and the provider closes its request at the time left of `timeout_ms`; the cluster runs the search to its end, and holds no search context for it once it ends | Studio closes the request at `timeout_ms`, the cluster runs the search to its end and then holds no search context for it, and the client gets the timeout answer |
| Oracle | Studio stops waiting; the statement runs on until the driver's call timeout, set to the time left of `timeout_ms`, ends its session, which stops it | The driver's call timeout ends the statement's session at `timeout_ms`, Oracle stops the statement within two seconds, and the client gets the timeout answer |
| Db2 LUW | Studio stops waiting; the statement runs on the server to its end, and the provider closes its connection once it has ended | Studio stops waiting at `timeout_ms`, the statement runs on the server to its end, and the client gets the timeout answer |
| Apache Cassandra | Studio stops waiting; the native protocol has no cancel, so the coordinator runs the statement to its end, and the provider closes the call's session when the answer arrives or at the time left of `timeout_ms` | The driver's read timeout, set to the time left, ends the wait and the provider closes the call's session; the coordinator runs the statement to its end, and the client gets the timeout answer |
| Apache Kafka | Studio stops waiting; the read runs on until the provider's deadline, set to the time left of `timeout_ms`, drops its answer, and a request already sent settles under the client's own timers | The provider's deadline ends the wait at `timeout_ms`, a request already sent settles under the client's own timers, and the client gets the timeout answer |
| Couchbase | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on the query service | Studio closes the request at `timeout_ms` and the query service, whose own timeout is set to the time left, stops the statement, and the client gets the timeout answer |
| Qdrant | Studio stops waiting; the provider keeps its request open until its own deadline, set to the time left of `timeout_ms`, closes it | The provider closes its request at `timeout_ms`, and the client gets the timeout answer |
| LibreDB | The read runs on the Studio server's own thread and cannot be stopped midway, so the cancel is seen only once the read has ended; the read was already answered by then | The read runs to its end, and one that outran the time left of `timeout_ms` is then answered as the timeout |
| RabbitMQ | Studio stops waiting; the read runs on until it reaches its `limit`, finds no message for 1 s, or meets the provider's deadline, the time left of `timeout_ms`, and the provider then closes its AMQP connection; until then the read keeps the seed's one read slot, so a later call on that seed waits for it, and one whose `timeout_ms` ends first is answered as the timeout | The provider's deadline, the time left of `timeout_ms`, ends the read and closes its AMQP connection, and the client gets the timeout answer |
| Neo4j | Studio stops waiting; the statement runs on until the provider closes its session at the time left of `timeout_ms`, which is also the transaction's timeout, and the server ends it | The provider closes the session at `timeout_ms`, the server ends the statement, and the client gets the timeout answer |
| Redis | Studio stops waiting; the read runs on its own connection, whose TCP connect waits up to the provider's query timeout and each of whose later steps, the sign-in, the `SELECT` of a database other than 0, the proof's round trip and the command, gives up when the time left of `timeout_ms` passes without an answer, after which the connection is closed and never reopened, so a server that stops answering holds the read one time left after the step it holds began | Studio stops waiting at `timeout_ms`, the read's own connection gives up as on a cancel, and the client gets the timeout answer |
| Weaviate | Studio stops waiting; the request stays open until its answer or until the provider closes it at the time left of `timeout_ms` | The provider closes its request at `timeout_ms`, and the client gets the timeout answer |
| MTConnect | Studio stops waiting; the provider's request runs on until its own time budget, set to the time left of `timeout_ms`, closes it | The provider closes its request at `timeout_ms`, and the client gets the timeout answer; an agent route answers one document and runs nothing after its request closes |

- One MCP query against a large SQLite table no longer stops the Studio process: the read runs in a
  child process and is killed at `timeout_ms`; only an in-memory SQLite read still blocks it.
- An MCP call on a LibreDB connection that no Studio session holds open opens the file itself and keeps its exclusive lock until that handle has been idle for 30 minutes.
  Every MCP call resets that clock, and meanwhile opening the connection in the Studio editor fails with 503, `LibreDB file is already open by another process (exclusive lock)`.
  When the editor opened the file first, MCP borrows its handle and nothing conflicts ([`docs/providers/libredb.md`](providers/libredb.md#421-on-disk-format-locking-and-version-compatibility-02x)).
  `run_libredb_read` takes no lock: each command opens its own read-only handle beside whatever holds the file.
- Every request's `Origin` is checked, and on a loopback bind (`HOSTNAME` of 127.0.0.1, ::1 or localhost) its `Host` too; a container binds every address, so there the Origin check and the token protect the endpoint.
  An MCP client that is not a browser sends no `Origin` and is not affected; a request that does carry one passes only from a localhost name or an `ALLOWED_ORIGINS` host, so a browser-based client served from another origin needs that origin in `ALLOWED_ORIGINS`.
- JSON-RPC batches are refused: a request body that is a JSON array gets 400 and `-32600`.
- A client must send `MCP-Protocol-Version` on every request after `initialize`; a request without it gets 400 and `-32020`.
- `GET` and `DELETE` get 405, and a hand-built `DELETE` with neither an `Origin` nor a JSON content type is refused 403 by Studio's CSRF check first.

## Troubleshooting

| Status | Meaning |
|---|---|
| 401 | No `Authorization: Bearer` header, or a token that does not verify: expired, minted before the label changed, or minted for another address (a changed `LIBREDB_MCP_URL`, or under npx a changed `--host` or `--port`); the audit reason says `mcp_token_invalid`, or `mcp_channel_unconfigured` when the label or the URL is unset |
| 403 | The request's `Origin`, or on a loopback bind its `Host`, is not allowed |
| 404 | MCP is off on this server, switched off or held off by governance mode; a client that falls back to the older HTTP+SSE transport retries with `GET` and reports a transport error rather than "disabled" |
| 409 | At minting, the channel is not ready, and the screen lists what to set |
| 429 | The per-user query budget is spent; retry after `Retry-After` seconds |
| 400 `-32020` | A required `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` header is missing, malformed or disagrees with the body |
| 500 | An unrecognized `LIBREDB_MCP_ENABLED`, an unset server version, or a server fault such as a missing `JWT_SECRET`; the server log names which |

A tool call that reaches a database writes two `mcp_operation` audit events: a decision before the database is reached and an outcome after it, under one correlation id, with the token's user and the connection's seed id.
`list_connections` reaches no database, so it writes one event.
A call whose audit record cannot be written is not run.
