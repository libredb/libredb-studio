# Seed Connections — Pre-Configured Database Connections

Seed Connections let administrators pre-configure database connections via a YAML or JSON file. Users see these connections immediately after login — no manual setup required.

**Use cases:**
- Platform/SaaS: provision databases for all users on signup
- Enterprise: give teams access to staging/production databases
- On-prem: DevOps pre-loads connections via Helm values or Docker volumes

## Quick Start

**1.** Create `seed-connections.yaml`:

```yaml
version: "1"

connections:
  - id: "prod-db"
    name: "Production Database"
    type: postgres
    host: "${DB_HOST}"
    port: 5432
    database: "${DB_NAME}"
    user: "${DB_USER}"
    password: "${DB_PASSWORD}"
    roles: ["*"]
```

**2.** Mount and set env vars:

```bash
docker run \
  -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e SEED_CONFIG_PATH=/app/config/seed-connections.yaml \
  -e DB_HOST=mydb.internal -e DB_NAME=mydb \
  -e DB_USER=reader -e DB_PASSWORD=secret \
  ghcr.io/libredb/libredb-studio:latest
```

**3.** Login — the connection appears in the sidebar with a lock icon.

---

## Sources

Studio builds the managed list from operator sources first, then adds the connections [platform discovery](#platform-discovery-caprover) finds, then the [built-in samples](#built-in-sample-connections).
The operator sources are read in a fixed order; in this version there is one, the seed file.
Two connections with one id inside the seed file fail it as an invalid config, and the error names the repeated id.
Two operator sources that declare one id stop the whole list, naming the id and where each one was declared, because neither may shadow the other.
A discovered connection whose id an operator source declares is dropped and reported as skipped, with the reason "id taken by the seed file".

### The seed file

`SEED_CONFIG_PATH` names a YAML or JSON file, and `/app/config/seed-connections.yaml` when it is unset or empty.
No file at the default path means no seed connections and no error.
A file named explicitly in `SEED_CONFIG_PATH` that does not exist also leaves Studio running without seed connections, and the [Seed sources card](#diagnostics) reports it as "Not found" with the path.
Any other read error, a parse error or a schema error fails the whole list (see [Error Handling](#error-handling)).

### Literal values

When `SEED_LITERAL_VALUES` turns literal mode on, every connection the seed file declares is used as written, as [Literal values written by a platform](#literal-values-written-by-a-platform) describes.
Each fill of the [operator cache](#the-operator-cache) runs with one reading of the switch, so every connection of one fill agrees.
A request that reads the switch with another value does not take the cached fill and starts a new one, so a change takes effect at the next request.
Discovered connections are always literal, whatever the switch says.

### The operator cache

The operator sources are read together at most once per `SEED_CACHE_TTL_MS` (default 60000), and concurrent requests share one read.
`${ENV_VAR}` references are resolved in that read, so a changed environment variable takes effect at the next one.
A read that fails is never cached: the next request reads again.
Tests clear the cache, and every source's own state, with `resetCache()` from `@/lib/seed`.

### The connection string refusal

A connection that sets `connectionString` on a type whose provider does not read it is refused when the file loads, and the whole file fails with `Seed connection "<id>" sets connectionString, which the <type> provider does not read: move the value into host, port, user, password and database`.
Earlier versions accepted such a file and the provider ignored the string, so the connection opened whatever the other fields said; a file that relied on that no longer loads.
An mssql seed that carried only a `connectionString`, for example, loaded and opened `localhost`, and is now refused.
The types whose provider reads it are postgres, mysql, sqlite, libsql, oracle, db2, clickhouse, mongodb and couchbase.
sqlite reads it as the database file path, with a `file:` prefix removed, although its provider's capability flag says it does not ([docs/providers/sqlite.md](./providers/sqlite.md)).
mssql does not read it, although its provider's capability flag says it does: the flag covers the connection form, which splits a pasted URI into fields, and the provider builds from those fields only ([docs/providers/mssql.md](./providers/mssql.md#44-connection-string-nuance)).
The 19 that refuse it are duckdb, mssql, druid, trino, cassandra, elasticsearch, opensearch, redis, prometheus, kafka, etcd, neo4j, milvus, qdrant, influxdb, influxdb3, oxia, databend and libredb.
To fix a refused file, move the value into `host`, `port`, `user`, `password` and `database`, and remove `connectionString`.

### Diagnostics

The admin Overview page (`/admin/overview`) shows a Seed sources card, fed by `GET /api/admin/seed-sources` (admin only, [`docs/API_DOCS.md`](./API_DOCS.md#get-apiadminseed-sources)).
For each operator source it shows the state (Loaded, Empty, Not found or Failed), the file path, the error with its code, the connections it listed, the connections it skipped with their reasons, and the names it ignored.
A connection skipped for an undefined `${ENV_VAR}` is listed with the variable in its reason, and the endpoint's record of the skip also names the field.
Every message names files, variables, fields and ids only, never a value, and never quotes a seed file.
The card hides itself when every source is empty with nothing skipped or ignored, which is an install with no seed file, and it refreshes once a minute.
`GET /api/connections/managed` carries no status, because every role can read it.

---

## Config File Format

The config file is YAML (`.yaml`, `.yml`) or JSON (`.json`). Format is auto-detected by file extension.

```yaml
version: "1"

defaults:                    # Optional — merges managed/environment/ssl only
  managed: true
  environment: production
  ssl:
    mode: require
    rejectUnauthorized: true

connections:
  - id: "analytics-pg"       # Required, unique, lowercase slug [a-z0-9-]
    name: "Analytics DB"      # Required, display name in UI
    type: postgres            # Required: postgres|mysql|sqlite|libsql|duckdb|mongodb|redis|oracle|db2|mssql|libredb|couchbase|clickhouse|druid|elasticsearch|opensearch|trino|cassandra|prometheus|kafka|etcd|neo4j|milvus|qdrant|influxdb|influxdb3|oxia|databend
    host: "${PG_HOST}"
    port: 5432
    database: analytics
    user: "${PG_USER}"
    password: "${PG_PASSWORD}"
    environment: production   # production|staging|development|local|other
    group: "Data Team"        # Group label in sidebar
    color: "#10B981"          # Hex color for environment badge
    roles: ["admin"]          # Who can see this connection
    managed: true             # Admin-controlled: not editable in the UI (default from `defaults`)
    ssl:
      mode: require
      rejectUnauthorized: true
    # serviceName: "ORCL"     # Oracle only
    # instanceName: "MSSQL$"  # SQL Server only
    # localDataCenter: "datacenter1"  # Cassandra only - REQUIRED there
    # authSource: "admin"     # MongoDB only - the database the user was created in
    # allowInsecureAuth: true # Db2 example - accept a password sent without TLS
    # saslMechanism: SCRAM-SHA-512  # Kafka only - PLAIN|SCRAM-SHA-256|SCRAM-SHA-512, a literal name

  - id: "dev-pg-server"
    name: "Shared dev PostgreSQL"
    type: postgres
    host: "${PG_DEV_HOST}"
    port: 5432
    database: ""              # Empty: every database this role can CONNECT to (providers/postgres.md 4.1.1)
    user: "${PG_DEV_USER}"
    password: "${PG_DEV_PASSWORD}"
    roles: ["*"]

  - id: "dev-mysql"
    name: "Dev MySQL"
    type: mysql
    host: "${MYSQL_HOST}"
    port: 3306
    database: devdb
    user: "${MYSQL_USER}"
    password: "${MYSQL_PASSWORD}"
    roles: ["*"]              # Everyone can see this
    managed: false            # User gets an editable copy
    environment: development

  - id: "events-druid"
    name: "Druid Events"
    type: druid
    host: "${DRUID_HOST}"
    port: 8888                # Router. The Broker's 8082 serves the same endpoint
    roles: ["*"]
    environment: production
    # No `database`: Druid reports exactly one catalog, always `druid`, so there is
    # nothing to select. No `connectionString` either - its HTTP SQL API has no URI
    # convention, so host and port are the whole address.
    # user/password are optional and only reach a cluster running druid-basic-security.

  - id: "lake-trino"
    name: "Trino Lakehouse"
    type: trino
    host: "${TRINO_HOST}"
    port: 8080                # The client protocol and the web UI share this port
    database: hive            # The CATALOG, not a database. Pins what the tree shows;
                              # a fully qualified name still reaches any other catalog.
    schema: default            # The session schema for unqualified table names. Without it,
                               # qualify names as schema.table in every statement.
    user: "${TRINO_USER}"
    roles: ["*"]
    environment: production
    # A `password` here would need `ssl.mode` set as well: the coordinator answers
    # 401 "Password not allowed for insecure authentication" over plain HTTP, even
    # with authentication switched off, so a password without TLS breaks a
    # connection that works without one.
    # No `connectionString`: jdbc:trino:// is not a form this build parses.

  - id: "events-ring"
    name: "Cassandra Ring"
    type: cassandra
    host: "${CASSANDRA_HOST}"
    port: 9042                     # The native protocol
    database: events               # The KEYSPACE, pinned for the session. Without it an
                                   # unqualified table name resolves to nothing.
    localDataCenter: datacenter1   # REQUIRED: the driver refuses to connect without it,
                                   # and a stock single-node install reports datacenter1.
    user: "${CASSANDRA_USER}"
    roles: ["*"]
    environment: production
    # No `connectionString`: no URI convention carries localDataCenter, so a pasted
    # one would produce a connection that cannot open.

  - id: "metrics-prom"
    name: "Prometheus Metrics"
    type: prometheus
    host: "${PROMETHEUS_HOST}"
    port: 9090                # The HTTP API and the web UI share this port
    roles: ["*"]
    environment: production
    # No `database`: one Prometheus server is one TSDB, so there is nothing to select.
    # No `connectionString` either: http:// and https:// already parse as ClickHouse.
    # user/password are optional. Both set send Basic auth (Grafana Cloud's scheme,
    # though its query API sits under a path prefix this version cannot reach); a
    # password alone is sent as a bearer token, for a token-guarded proxy. Over plain
    # HTTP either one is readable on the wire, so set `ssl` for a server across a
    # network you do not control.

  - id: "metrics-influx"
    name: "InfluxDB Metrics"
    type: influxdb
    host: "${INFLUX_HOST}"
    port: 8086                # The v1 /query API of 1.x and 2.x; a 3.x server answers it on 8181
    database: telegraf        # Optional: a statement that names its database reads that one
    user: "reader"            # A 1.x user granted READ on the database
    password: "${INFLUX_READER_PASSWORD}"
    ssl:
      mode: verify-full
    roles: ["*"]
    environment: production
    managed: true
    readOnly: true
    # On 2.x leave `user` out and put a read token for the bucket in `password`:
    # a password with no user is sent as a token. Without TLS to a host that is not
    # loopback the connection is refused unless it sets `allowInsecureAuth: true`.
    # No `connectionString`: http:// and https:// already parse as ClickHouse.

  - id: "metrics-influx3"
    name: "InfluxDB 3 Metrics"
    type: influxdb3
    host: "${INFLUXDB3_HOST}"
    port: 8181
    database: telegraf        # One connection reads one database
    password: "${INFLUXDB3_TOKEN}"   # Sent as a bearer token; this type takes no `user`
    ssl:
      mode: verify-full
    roles: ["*"]
    environment: production
    managed: true
    readOnly: true
    # On InfluxDB 3 Core every token is an admin token, so read-only is a property
    # of what Studio sends, never of the token.

  - id: "events-kafka"
    name: "Kafka Events"
    type: kafka
    host: "${KAFKA_HOST}"      # One bootstrap broker; the client learns the rest from it
    port: 9093
    saslMechanism: SCRAM-SHA-512   # A literal: PLAIN, SCRAM-SHA-256 or SCRAM-SHA-512
    user: "${KAFKA_USER}"
    password: "${KAFKA_PASSWORD}"
    roles: ["*"]
    environment: production
    ssl:
      mode: verify-full        # SASL over plaintext is refused, and verify-full keeps the
                               # credentials to brokers the CA vouches for
    # No `database`: one connection is one cluster, so there is nothing to select.
    # No `connectionString` and no `sshTunnel`: a Kafka client reaches every broker at
    # the address the broker advertises, which a tunnel to one address does not carry.

  - id: "edge-libsql"
    name: "Edge libSQL"
    type: libsql
    host: "${LIBSQL_HOST}"
    port: 8080                # sqld's HTTP port
    user: "${LIBSQL_USER}"
    password: "${LIBSQL_PASSWORD}"
    roles: ["*"]
    environment: production
    # A `user` sends `user` and `password` as HTTP Basic, the pair a self-hosted sqld
    # started with SQLD_HTTP_AUTH="basic:<base64(user:password)>" checks. Leave `user`
    # out to send `password` as a bearer token, which Turso Cloud and a sqld checking
    # JWTs read. No `database`: the database is the host. No `connectionString`: a
    # libsql:// URL means TLS and a token, and a `user` beside it is ignored.
```

### Field Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | Yes | — | Must be `"1"` |
| `defaults` | No | - | Supplies `managed`, `environment` and `ssl` where a connection omits them. No other field is merged, and `mcp` and `readOnly` are refused here (see [MCP opt-in](#mcp-opt-in)) |
| `defaults.managed` | No | `true` | Default managed state |
| `defaults.environment` | No | — | Default environment label |
| `defaults.ssl` | No | — | Default SSL config |
| `connections` | Yes | — | Array of connection definitions (min 1) |
| `connections[].id` | Yes | — | Unique slug: `[a-z0-9-]+`, max 64 chars |
| `connections[].name` | Yes | — | Display name, max 128 chars |
| `connections[].type` | Yes | - | Database type: `postgres`, `mysql`, `sqlite`, `libsql`, `duckdb`, `mongodb`, `redis`, `oracle`, `db2`, `mssql`, `libredb`, `couchbase`, `clickhouse`, `druid`, `elasticsearch`, `opensearch`, `trino`, `cassandra`, `prometheus`, `kafka`, `etcd`, `neo4j`, `milvus`, `qdrant`, `influxdb`, `influxdb3`, `oxia`, `databend` |
| `connections[].host` | No | — | Hostname or IP |
| `connections[].port` | No | — | Port number (1-65535) |
| `connections[].database` | No | — | Database name (Couchbase: the bucket. Druid has one catalog and ignores it. Trino: the **catalog**. PostgreSQL: empty reaches the whole server, every database the role can CONNECT to) |
| `connections[].schema` | No | — | Trino session schema, used to resolve unqualified table names inside the configured catalog |
| `connections[].skipObjectScan` | No | absent | `true` reads no catalog when the connection opens, so the editor is usable immediately and the object tree offers a load action instead of scanning. Useful for large catalogs, including managed connections whose settings cannot be edited in the UI |
| `connections[].user` | No | — | Username |
| `connections[].password` | No | — | Password (use `${ENV_VAR}` syntax) |
| `connections[].apiKeyId` | No | - | Elasticsearch only (#708): the API key's id, paired with `apiKeySecret` and preferred over `user` and `password` when both are set; every other engine refuses the pair when the file loads. Resolved like `password` |
| `connections[].apiKeySecret` | No | - | Elasticsearch only (#708): the API key's secret, paired with `apiKeyId`; use `${ENV_VAR}` syntax |
| `connections[].ssl.caCert` | No | absent | The CA certificate as PEM, or a `${ENV_VAR}` or `${vault:...}` reference that resolves to it, so a Kubernetes Secret can carry it into the environment ([providers/etcd.md](providers/etcd.md), section 12) |
| `connections[].ssl.clientCert` | No | absent | The client certificate as PEM, or a reference, resolved like `password` |
| `connections[].ssl.clientKey` | No | absent | The client key as PEM, or a reference; an unset reference skips the connection naming `ssl.clientKey`. Never inline a private key in a ConfigMap |
| `connections[].connectionString` | No | - | Full connection string (use `${ENV_VAR}`). Read only by postgres, mysql, sqlite (as the database file path), libsql, oracle, db2, clickhouse, mongodb and couchbase; every other type, mssql included, refuses it when the file loads, naming the connection and the type ([The connection string refusal](#the-connection-string-refusal)) |
| `connections[].roles` | Yes | — | Access control: `["*"]`, `["admin"]`, `["user"]`, `["admin", "user"]` |
| `connections[].managed` | No | from defaults | `true` = admin-controlled: not editable in the UI, its secrets stay on the server; `false` = an editable copy for the user |
| `connections[].readOnly` | No | absent | `true` refuses every write, value edit and maintenance operation on the connection, on an engine whose provider enforces it (etcd, Neo4j, Milvus, Qdrant, InfluxDB (InfluxQL), InfluxDB 3 (SQL) and Oxia); every other engine refuses `readOnly: true` when the file loads, naming the type and the field. Refused with `managed` false, on the connection or through `defaults.managed`, because an editable copy carries the credentials into the browser. A literal boolean: a `${ENV}` reference is refused |
| `connections[].environment` | No | from defaults | Environment badge |
| `connections[].group` | No | — | Group label |
| `connections[].color` | No | — | Hex color for badge (e.g., `#10B981`) |
| `connections[].ssl` | No | from defaults | SSL configuration |
| `connections[].serviceName` | No | — | Oracle service name |
| `connections[].instanceName` | No | — | SQL Server instance name |
| `connections[].localDataCenter` | No¹ | — | Cassandra local data centre (`datacenter1`). ¹Optional in the schema because no other engine has it, and **required by the Cassandra provider**: the driver refuses to connect without one |
| `connections[].saslMechanism` | No | - | Kafka: `PLAIN`, `SCRAM-SHA-256` or `SCRAM-SHA-512`, absent meaning none; `user` and `password` are sent only with a mechanism, and only over TLS. It takes a literal name: it is neither a credential nor an address, so a `${ENV}` or `${vault:...}` reference in it is refused when the file loads, naming the field, because the file is validated before any reference is resolved |
| `connections[].allowInsecureAuth` | No | absent | Db2, both InfluxDB types, Oxia and Databend (#786): `true` accepts that a connection with no TLS sends its password to the server in cleartext, which the Db2 provider otherwise refuses when the connection opens ([providers/db2.md](providers/db2.md)), and that an InfluxDB connection sends its password or token without TLS to a host that is not loopback, which both InfluxDB providers otherwise refuse before any socket ([providers/influxdb.md](providers/influxdb.md), [providers/influxdb3.md](providers/influxdb3.md)), and that an Oxia connection sends its token in cleartext, which the Oxia provider otherwise refuses when the connection opens ([providers/oxia.md](providers/oxia.md), section 4.6, where a token to this machine or through an SSH tunnel needs no tick), and that a Databend connection sends its password without TLS to a host that is not loopback, which the Databend provider otherwise refuses when the connection opens. Set `ssl` instead wherever the server offers TLS. Every other engine ignores it. A literal boolean: a `${ENV}` reference fails the whole file |
| `connections[].dataServers` | No | absent | Oxia only: the public addresses of a cluster's data servers, as `host:port` entries separated by commas or whitespace, at most 64. Exact entries only, never a pattern. A `${ENV}` or `${vault:...}` reference is resolved, as in `host`. Not a secret: it is listed with the connection, and the token it receives is not. Refused together with an SSH tunnel |
| `connections[].warehouse` | No | absent | Databend only: the warehouse every statement runs on, sent as the `X-DATABEND-WAREHOUSE` header. Databend Cloud requires one (the `warehouse=` value of its DSN) and resumes a suspended warehouse on the first statement, billing while it runs, so with one set Studio sends the connection no background health checks ([providers/databend.md](providers/databend.md)). A `${ENV}` or `${vault:...}` reference is resolved, as in `host`. Not a secret |
| `connections[].authSource` | No | — | MongoDB: the database its credentials live in (`admin` in the ordinary deployment). Without it the driver checks the user against the database being opened, which reports a credentials error |
| `connections[].mcp` | No | absent | `true` makes the connection visible to MCP clients whose token's role the connection's `roles` admit ([docs/MCP.md](MCP.md)). Anything but a boolean fails the whole file. An etcd or Oxia connection refuses `mcp: true` when the file loads: MCP is not offered for it |

### MCP opt-in

An MCP client reaches a connection only when its entry says `mcp: true`, and only when the connection's `roles` admit the role the client's token carries.
The opt-in is per connection: `defaults.mcp` is refused, because a default would opt in every connection the file later gains.
The built-in sample connections never carry it, so they are never visible to an MCP client.
A value that is not a boolean fails the whole file, as any invalid field does: `GET /api/connections/managed` then answers 500 with its named reason, and every MCP tool answers that the connection configuration could not be read.
With no seed file, or with no entry that opts in for the token's role, `list_connections` answers an empty list.

### A read-only cluster for everyone

`readOnly: true` makes a connection refuse every write, value edit and maintenance operation before any request, on an engine whose provider keeps the mode.
etcd's, Neo4j's, Milvus's, Qdrant's, both InfluxDB types' and Oxia's do today ([providers/etcd.md](providers/etcd.md), section 3.4, the Neo4j recipe below, [providers/milvus.md](providers/milvus.md) and [providers/qdrant.md](providers/qdrant.md), section 3.4 of each, the InfluxDB recipes above, and [providers/oxia.md](providers/oxia.md), section 3.5), and on every other engine the file is refused at load, with a sentence naming the type and the field.
The recipe is two seeds of one cluster: one every role reaches, read-only, and one for the people who may write.

```yaml
version: "1"
connections:
  - id: "cluster-read"
    name: "Cluster"
    type: etcd
    host: etcd.internal
    port: 2379
    user: "reader"
    password: "${ETCD_READER_PASSWORD}"
    ssl:
      mode: verify-full
      caCert: "${ETCD_CA}"
    roles: ["*"]
    managed: true
    readOnly: true
  - id: "cluster-write"
    name: "Cluster (write)"
    type: etcd
    host: etcd.internal
    port: 2379
    user: "writer"
    password: "${ETCD_WRITER_PASSWORD}"
    ssl:
      mode: verify-full
      caCert: "${ETCD_CA}"
    roles: ["admin"]
    managed: true
```

`managed: true` is written out on both, although it is the default, because a connection's own value overrides a file-wide `defaults.managed: false`.
The load refuses `readOnly: true` on a connection that is not managed: an unmanaged seed is copied into the browser of every user its roles admit, with its password and TLS client key, and Duplicate turns that copy into a connection of the user's own whose `readOnly` can be cleared.
`readOnly` is set per connection and never in `defaults`, which the load refuses, so a later connection in the file never inherits it.
The mode is a boundary only where etcd authenticates the client with a secret only the seeds hold, a password or a client certificate: on an etcd that authenticates nobody, a `user` who knows the address can reach it with a connection of their own.
A read-only connection shows a Read-only marker beside its name in the sidebar and in the editor header.

A connection type can declare credentials that would make a read-only seed a promise nobody keeps: a published default user and password, or, where the engine accepts a connection with no secret, no password at all.
Milvus declares both: its documented default `root` pair, and no password ([providers/milvus.md](providers/milvus.md), section 4.2).
A Milvus seed's read-only mode is a boundary only when the server has authorization enabled, which is not Milvus's default.
Qdrant declares the second: a read-only Qdrant seed with no key is refused, because a Qdrant server without a key accepts any key or none ([providers/qdrant.md](providers/qdrant.md), section 4.2).
Give a read-only Qdrant seed the server's read-only key or a read-scoped JWT, through a reference such as `password: "${QDRANT_READ_ONLY_KEY}"`.
Both InfluxDB types declare the second too: an InfluxDB 1.x server with authentication off, its default, and an InfluxDB 3 server started with `--without-auth` accept any credential or none, so a read-only InfluxDB seed with no password or token is refused.
Give a read-only `influxdb` seed a 1.x user granted READ, or a 2.x read token for the bucket, through a reference such as `password: "${INFLUX_READER_PASSWORD}"`, and a read-only `influxdb3` seed a token through a reference such as `password: "${INFLUXDB3_TOKEN}"`.
On a type that does, the seed loader refuses a `readOnly: true` connection whose credential matches, in two stages: load refuses what the file shows; resolution refuses the rest.
At load, a literal `user` and `password` that match, or an absent or empty `password`, fail the whole file with an error that names the connection and the `password` field and never repeats the value.
An absent or empty `password` fails the file whatever the `user` holds, a reference included.
A `${ENV}` or `${vault:...}` reference cannot be read at load, so a pair with a reference in either field passes there; once it resolves, the type's provider refuses the connection before anything is dialled if the resolved credential matches or is empty.
A value shaped like `${...}` that the resolver does not resolve, such as `${lower}`, is a literal and is checked as one.
An empty `user` with a password of the form `user:password` is read as that pair, so a token that carries a default credential is refused too.

### A read-only Neo4j graph

A Neo4j connection is read-only whatever `readOnly` says, because its provider refuses every write before it is sent ([providers/neo4j.md](providers/neo4j.md), section 3.1), so `readOnly: true` loads on a managed Neo4j seed and states what the connection does.
One seed every role reaches is enough, and `mcp: true` lets an MCP client list the connection and inspect its schema; `run_read_query` does not serve Neo4j.

```yaml
version: "1"
connections:
  - id: "graph"
    name: "Graph"
    type: neo4j
    host: neo4j.internal
    port: 7687
    database: neo4j
    user: "reader"
    password: "${NEO4J_READER_PASSWORD}"
    ssl:
      mode: verify-full
      caCert: "${NEO4J_CA}"
    roles: ["*"]
    managed: true
    readOnly: true
    mcp: true
```

Leave `database` out to read the user's home database; another database is another connection.
`verify-full` and `verify-ca` both check the host name, and through an SSH tunnel a verifying mode is refused, so use `require` with verification off there ([providers/neo4j.md](providers/neo4j.md), section 4.5).

---

## Credential Management

Keep the credentials of a config file you write by hand out of the file.
Use `${ENV_VAR}` syntax to reference environment variables:

```yaml
connections:
  - id: "prod-db"
    password: "${PROD_DB_PASSWORD}"        # Resolved from process.env at runtime
    connectionString: "${MONGO_URI}"       # Also works for connection strings
    user: "${DB_USER}"                     # Any resolvable field below can use ${} syntax
```

**How it works:**
1. The config file is read from disk (YAML/JSON) and validated as a whole.
2. `${VARIABLE_NAME}` patterns are resolved from `process.env` when the [operator cache](#the-operator-cache) is filled.
3. If a variable is undefined, that connection is **skipped**, the others are listed, and the [Seed sources card](#diagnostics) names the variable, with the field in the endpoint's record.
4. A literal password is used as written and logs a warning once per connection.
5. With `SEED_LITERAL_VALUES=true`, steps 2 to 4 do not happen: every value is used as written (see [Literal values written by a platform](#literal-values-written-by-a-platform))

**Resolvable fields:** `password`, `connectionString`, `user`, `host`, `database`, `dataServers`, `warehouse`, `apiKeyId`, `apiKeySecret`, and the TLS material under `ssl`: `ssl.caCert`, `ssl.clientCert` and `ssl.clientKey`.

### Literal values written by a platform

`SEED_LITERAL_VALUES=true` makes every value of the seed file a literal.
Studio then resolves no `${ENV_VAR}` and no `${vault:...}` reference in the file, neither when it lists connections nor when it opens one.
A value that looks like a reference is used as written: `user: "${DB_USER}"` connects as a user literally named `${DB_USER}`, an unset variable skips no connection, and Vault is never asked for a seed value.
The plaintext-password warning is not logged either, because every value in such a file is a literal on purpose.
At the first load in literal mode, one `info` line says so: `Seed config read in literal mode (SEED_LITERAL_VALUES): no ${ENV} or ${vault:...} reference is resolved`.
`true`, `1`, `on` and `yes` turn the mode on, trimmed and in any case.
`false`, `0`, `off`, `no` and an empty value leave it off.
Any other value leaves it off as well and logs one warning per process that names the value, so a typo shows in the log instead of passing silently.

The mode exists for a seed file that a platform writes from data its users control, such as the database names, user names and passwords they choose when they create a database.
Resolving a reference in such a file would hand Studio's own environment to whoever controls the field.
A platform user who names a database user `${JWT_SECRET}` would have Studio send its session signing secret, as that user name, to a database the platform user runs, and read it back from that database's log.
With the secret, that user could sign a Studio admin session.
Literal mode removes the resolution itself, so no value a platform user controls can make Studio read its environment or its Vault, including a value the platform failed to filter out.

Turn the mode on only for a file in which every value is meant literally: a file written by hand that relies on `${ENV_VAR}` or `${vault:...}` references stops resolving them.
Keep such a file `managed: true`, the default, so its passwords stay on the server, and mount it read-only from a directory other users on the host cannot enter.

### Vault References

A field can take its value from HashiCorp Vault instead of an environment variable:

```yaml
connections:
  - id: "prod-db"
    password: "${vault:secret/data/prod/postgres#password}"
    connectionString: "${vault:secret/data/prod/postgres#dsn}"   # Same path, one request
```

The part before `#` is the KV v2 path (`<mount>/data/<name>`) and the part after it is the key inside the returned data object. Only KV v2 is supported: the server reads `GET <VAULT_ADDR>/v1/<path>` and takes `data.data.<key>`, so a v1-shaped path (`secret/prod/postgres`) is refused with a message naming the shape it expects rather than read as an empty secret.

**Quote the value.** YAML reads an unquoted `#` as the start of a comment, so `password: ${vault:secret/data/prod/postgres#password}` sets the password to the literal text `${vault:secret/data/prod/postgres` and drops the key. The quotes above are not optional.

Whole-value match only, exactly like `${ENV_VAR}`: no partial interpolation, no concatenation, and the same resolvable fields (`password`, `connectionString`, `user`, `host`, `database`, `dataServers`, `warehouse`, `apiKeyId`, `apiKeySecret`, `ssl.caCert`, `ssl.clientCert`, `ssl.clientKey`).
A reference with no `#key` fails when the connection is opened.

A Vault reference is read lazily, one connection at a time:

1. Listing connections (`GET /api/connections/managed`) makes **zero** Vault requests. The reference is handed back unresolved, and for a `managed: false` connection it is the reference — not a secret — that reaches the browser.
2. Opening a connection reads the referenced path once, then caches the result per path for `VAULT_CACHE_TTL_MS` (default 60000). A second connection to the same path within that TTL makes no request.
3. A failure — Vault unreachable, the path or key missing, the token refused — fails that one connection with an explicit error. There is no fallback to an empty password, no retry loop and no fallback to an environment variable, and the failure never affects the boot or another connection.
4. The resolved value is never logged, never written to an error message and never reaches the audit log. The reference string may be logged; it is not a secret.

`${ENV_VAR}` resolution is unchanged: synchronous on the list path, and a dictionary lookup. Only `${vault:...}` is deferred.

#### Vault Environment Variables

Vault credentials come from the environment, never from the seed file — a seed file that could carry a token would make the product hold a new secret, which is the thing this feature exists to avoid.

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_ADDR` | — | Vault address with scheme and port (`http://vault.vault.svc:8200`). Required for the scheme to work |
| `VAULT_TOKEN` | — | Static token. Takes precedence over `VAULT_ROLE` when both are set |
| `VAULT_ROLE` | — | Kubernetes auth role, used when `VAULT_TOKEN` is unset. The login token's lease is tracked and refreshed before it lapses |
| `VAULT_K8S_TOKEN_PATH` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Projected service account token presented to the Kubernetes login |
| `VAULT_K8S_AUTH_PATH` | `kubernetes` | Mount path of the Kubernetes auth method; the login goes to `<VAULT_ADDR>/v1/auth/<path>/login`. Set it when the method is mounted elsewhere, such as one mount per cluster on a shared Vault. Leading and trailing slashes are ignored |
| `VAULT_NAMESPACE` | — | Vault Enterprise namespace, sent as `X-Vault-Namespace` when set |
| `VAULT_CACHE_TTL_MS` | `60000` | How long a read secret is cached |

Every one of these is optional. With none of them set, and no `${vault:...}` reference in the seed file, the application boots and behaves exactly as it does without this feature: no startup probe, no reachability check and no warning about Vault. A reference used without `VAULT_ADDR` fails with a message naming the missing variable.

#### Secret Rotation

A rotated secret becomes visible within `VAULT_CACHE_TTL_MS` (the secret cache) plus `SEED_CACHE_TTL_MS` (the parsed seed file cache) — 120 seconds with both defaults. No restart and no seed file change: the reference stays the same and only the value behind it moves.

#### Demo Stack

`docker-compose.vault-demo.yml` at the repository root starts Studio, PostgreSQL and a dev-mode Vault, writes the database password into Vault and the seed file into a volume Studio mounts. It pulls the published image, so it needs no source checkout:

```bash
docker compose -f docker-compose.vault-demo.yml up
```

That Vault is dev mode: in memory, unsealed, root token, no TLS, no policies and no audit device. It is for development and demonstration only and is not a production configuration — a real deployment should follow HashiCorp's [production hardening guide](https://developer.hashicorp.com/vault/tutorials/operations/production-hardening).

To see the payoff rather than a connection that merely works, rotate the secret and watch the connection pick it up:

```bash
# 1. Change the password in Vault and in PostgreSQL.
docker compose -f docker-compose.vault-demo.yml exec -T vault \
  vault kv put secret/prod/postgres password=rotated
docker compose -f docker-compose.vault-demo.yml exec -T postgres \
  psql -U demo -d demo -c "ALTER USER demo WITH PASSWORD 'rotated';"

# 2. Wait out VAULT_CACHE_TTL_MS (10s in that file), then open the
#    "Postgres (password from Vault)" connection again. It authenticates with
#    the new password, and no container was restarted.
```

In a real deployment the policy is one read on one path — `path "secret/data/prod/postgres" { capabilities = ["read"] }` — and the Kubernetes auth role binds that policy to the pod's service account. Prefer `VAULT_ROLE` to `VAULT_TOKEN`, so the credential is a lease rather than something long-lived.

### Credential Sources by Deployment

| Deployment | How to provide credentials |
|------------|---------------------------|
| **Docker** | `-e DB_PASSWORD=secret` |
| **Docker Compose** | `environment:` block or `.env` file |
| **Kubernetes** | `Secret` → `extraEnvFrom` in Helm values |
| **Vault** | `${vault:...}` references resolved at connect time, or External Secrets Operator → K8s Secret → `extraEnvFrom` |
| **AWS SSM and other secret managers** | External Secrets Operator → K8s Secret → `extraEnvFrom` (no direct resolver) |

### Kubernetes Example

```yaml
# Create a K8s Secret with credentials
apiVersion: v1
kind: Secret
metadata:
  name: seed-db-credentials
type: Opaque
stringData:
  PG_PASSWORD: "my-secret-password"
  MYSQL_PASSWORD: "another-secret"

---
# Reference in Helm values
extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

---

## Role-Based Access Control

Each connection has a `roles` field that controls which users can see it:

| Config | Who sees it |
|--------|-------------|
| `roles: ["*"]` | All authenticated users |
| `roles: ["admin"]` | Admin users only |
| `roles: ["user"]` | Regular users only |
| `roles: ["admin", "user"]` | Both (same as `["*"]`) |

Roles are matched against the JWT session's `role` field. The role is extracted server-side from the JWT token — never from client input.

**Current limitation:** The system supports `admin` and `user` roles only (matching the JWT `role` claim). Custom roles (e.g., `data-team`, `backend`) are planned for a future release with expanded OIDC role claim support.

### How Role Filtering Works

```
User logs in → JWT contains { role: "user" }
                    ↓
GET /api/connections/managed
                    ↓
Server reads config → filters by role
                    ↓
User sees only connections where roles includes "user" or "*"
```

---

## Managed vs. Unmanaged Connections

### `managed: true` (default)

- Connection appears with a **lock icon** in the sidebar
- Users **cannot edit or delete** it
- Credentials are **never sent to the client** — server resolves them at query time
- If admin updates the config (e.g., password rotation), all users get the new credentials automatically
- Best for: production databases, shared resources

### `managed: false`

- On first load, the connection is **copied to the user's local storage** with credentials
- User **can edit or delete** their copy
- Once copied, the connection belongs to the user — admin changes to the seed config won't affect existing copies
- If the user deletes their copy, the seed ID is recorded in a local "dismissed" list and the connection is **not** re-imported on subsequent loads (see [Dismissed Seeds](#dismissed-seeds) below)
- Best for: development databases, sandbox environments

### Comparison

| Behavior | `managed: true` | `managed: false` |
|----------|-----------------|-------------------|
| UI edit/delete | Locked | Allowed |
| Credentials on client | Never | Copied once |
| Password rotation | Automatic | User must re-import |
| Admin removes from config | Disappears for all | User copy remains |
| Server-side credential resolution | Yes | No (user has local copy) |
| User deletes their copy | N/A (locked) | Dismissed permanently — will not reappear |

### Dismissed Seeds

Deleting a `managed: false` connection from the sidebar does not simply remove it — the client records the seed's `id` in a local `dismissed_seeds` list (synced through the same write-through storage as connections). On every subsequent load, `dismissed_seeds` is checked before re-importing `managed: false` connections from `/api/connections/managed`, so a deleted seed connection stays gone even after the admin's config is untouched. There is currently no UI to un-dismiss a seed; the only way to bring it back is to clear the `dismissed_seeds` entry from local storage (see [Troubleshooting](#troubleshooting)).

---

## Custom Connections

`ALLOW_CUSTOM_CONNECTIONS` decides whether a signed-in user may open a connection of their own, one that is not in this file.
It is on when unset.
`false`, `0`, `off` or `no`, trimmed and in any letter case, switch it off; `true`, `1`, `on` and `yes` keep it on.
One pair of matching surrounding quotes, single or double, is stripped first, since an env file can keep them, so `"false"` switches it off.
Any other value fails closed: it switches custom connections off and logs one error naming the value and the accepted values, so a typo never leaves them open.

Switch it off where Studio shares a network with services its users must not reach, such as a platform's overlay network or a cluster namespace: with custom connections on, any account that can sign in can connect to any host and port that network reaches.
The switch limits the connections Studio itself opens, not what a seeded engine can reach on its own, for example through Postgres `dblink` or `postgres_fdw`, ClickHouse `remote()` or `url()`, MySQL `FEDERATED` tables or the brokers a Kafka cluster advertises, so grant a seed's account only what its users may reach from that engine.

Switched off, every route that builds a database provider refuses a connection the request supplies, before any provider is built, with `403` and `{ "error": "Custom connections are disabled on this server", "code": "CUSTOM_CONNECTIONS_DISABLED", "statusCode": 403 }`.
The code tells this refusal apart from the role check's, which is also a `403` and carries `AUTH_ERROR`.
The refusal is made in `resolveConnection()` (`src/lib/seed/resolve-connection.ts`), which every database route resolves its connection through, and `POST /api/admin/fleet-health` resolves each item through it too and reports a refused one as that item's error.
The agent runtime and the MCP endpoint only ever open a seed by its id, so nothing changes there.

| Connection | With custom connections off |
|------------|-----------------------------|
| `managed: true` seed, a connection [Platform discovery (CapRover)](#platform-discovery-caprover) found included | Listed, and opened by its id as before |
| `managed: false` seed | Listed and opened. Its editable copy keeps the id `seed:<id>`, and the server resolves that id from this file and ignores the copy's own fields, exactly as it does with the switch on |
| Built-in samples | Unmanaged seeds, so the row above applies |
| A connection the user created, or a duplicate of any connection | Hidden in the editor and refused by the server |

The editor reads the switch once per page load from `GET /api/connections/policy` and withholds every control that creates or repoints a connection of the user's own: New connection, Add Connection, the command palette's New Connection, Edit and Duplicate.
Delete stays; on an unmanaged seed's copy it dismisses the seed, as it always does, and deleting the open connection selects the first connection listed.
An open tab's refresh of the managed list (see [In an open tab](#in-an-open-tab)) follows the same rule: when it withdraws the open connection, or none is open, the connection it makes active is the first one listed, never a hidden one.
The admin pages, the monitoring page and the schema diff list connections under the same rule.
The user's own connections stay in their storage while hidden, and reappear when the switch is turned back on, each in the place it held in the saved order, even if the seeds around it were reordered meanwhile.

---

## Hot Reload

The config file is **cached in memory** with a TTL (default 60 seconds). When the file changes:

1. Next API request after TTL expires triggers a re-read
2. New connections appear, removed connections disappear
3. Updated credentials take effect immediately (for `managed: true`)
4. **No restart required**

On a DuckDB seed, a `roles` change that moves the seed between admins only and a non-admin role changes the file-access posture its one handle opens under (section 3.16 of [`docs/providers/duckdb.md`](./providers/duckdb.md)).
The first request after the re-read then closes the open handle and opens a new one: a statement still running on the old handle does not complete, and its session state (temporary tables, `SET` values) is lost.
It happens once per such edit.

### Tuning the Cache TTL

```bash
# Default: 60 seconds
SEED_CACHE_TTL_MS=60000

# Faster refresh (5 seconds) — useful during development
SEED_CACHE_TTL_MS=5000

# Slower refresh (5 minutes) — production with infrequent changes
SEED_CACHE_TTL_MS=300000
```

In Kubernetes, ConfigMap updates propagate in ~60-120s (kubelet sync period). Combined with the cache TTL, expect ~2-3 minutes for changes to take effect.

The same TTL governs the [Platform discovery (CapRover)](#platform-discovery-caprover) export: Studio re-reads that file at most once per `SEED_CACHE_TTL_MS` while its copy is fresh, and at most every 5 seconds (or once per `SEED_CACHE_TTL_MS` when that is shorter) once that copy has turned stale; the CapRover template sets the TTL to 5 seconds.
An open tab refetches the managed list every `max(SEED_CACHE_TTL_MS, 5000)` milliseconds, at most 60 seconds, while it is visible, and on focus, so a change to the seed file or to the export reaches it without a reload.
With the default of 60000 an open tab refreshes once a minute; the auto-connect template sets 5000, so its tabs refresh every 5 seconds.
A change to the seed file therefore reaches an open tab after at most `SEED_CACHE_TTL_MS` plus one refresh interval, about two minutes with the defaults; with a TTL above 60000 the tab still asks every 60 seconds, and the server answers most of those reads from its cache.
A refresh merges the answer exactly as a page load does: a `managed: false` seed keeps the editable copy the browser already holds, an unmanaged seed the user deleted stays deleted, and an answer that lists no connections withdraws every managed one; [In an open tab](#in-an-open-tab) says which connection stays open.
A refresh that fails changes nothing and shows nothing, and the next one tries again; the one exception is a session that has ended, which the server answers with `401` and the code `AUTH_REQUIRED`, and which sends the tab to the sign-in page, as any other request of the editor does.

---

## Linking to a Connection

A link can open the editor on one connection: `/?connection=<id>`, under `BASE_PATH` when one is set, where `<id>` is the connection's full id in the browser, `seed:<seed id>` for a seed connection.
The colon may be URL-encoded, as in `/?connection=seed%3Aprod-db`.
The editor reads the parameter once its connection list has loaded, opens that connection instead of the one it would open by default, and removes the parameter from the address bar, so a reload or a copied address does not repeat it.
Opened without a session, the link goes to the sign-in page, which returns to it after the user signs in.
When the list the user sees does not hold that id yet, the editor keeps its default selection and opens the connection at the first refresh of the managed list that lists it (see [Hot Reload](#hot-reload)), because a seed the server has not re-read yet is listed a little later.
A connection the user chooses while the link is pending cancels it, so a later refresh never switches away from it.
If the first refresh one seed-cache lifetime (`SEED_CACHE_TTL_MS`) after the load does not list it either, the editor shows a notice that reads the same whatever the cause: an id that does not exist, a seed whose `roles` leave the user out, or a connection of the user's own while [Custom Connections](#custom-connections) are switched off.
The notice therefore does not reveal which seed ids exist for other roles.
When the managed list cannot be loaded at all, the notice says so instead, and the link opens only a connection the browser holds itself.
The parameter belongs to the standalone editor page: the embeddable `StudioWorkspace` component takes its connections and its selection from its host and ignores the address bar.

---

## Deployment Examples

### Docker

```bash
docker run \
  -v ./seed-connections.yaml:/app/config/seed-connections.yaml:ro \
  -e SEED_CONFIG_PATH=/app/config/seed-connections.yaml \
  -e PG_PASSWORD=secret \
  -e JWT_SECRET=your-32-char-jwt-secret-here!! \
  -p 3000:3000 \
  ghcr.io/libredb/libredb-studio:latest
```

### Docker Compose

```yaml
services:
  libredb:
    image: ghcr.io/libredb/libredb-studio:latest
    ports:
      - "3000:3000"
    volumes:
      - ./seed-connections.yaml:/app/config/seed-connections.yaml:ro
    environment:
      SEED_CONFIG_PATH: /app/config/seed-connections.yaml
      JWT_SECRET: your-32-char-jwt-secret-here!!
      PG_PASSWORD: ${PG_PASSWORD}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    env_file:
      - .env  # Store credentials here
```

### Kubernetes (Helm)

**Option A — Inline config in values.yaml:**

```yaml
seedConnections:
  enabled: true
  config:
    version: "1"
    defaults:
      managed: true
      environment: production
    connections:
      - id: "prod-analytics"
        name: "Production Analytics"
        type: postgres
        host: analytics-db.internal
        port: 5432
        database: analytics
        user: readonly
        password: "${ANALYTICS_DB_PASSWORD}"
        roles: ["admin"]
        color: "#10B981"
      - id: "staging-api"
        name: "Staging API DB"
        type: mysql
        host: staging-mysql.internal
        password: "${STAGING_DB_PASSWORD}"
        roles: ["*"]
        managed: false
        environment: staging

extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

**Option B — External ConfigMap:**

```yaml
seedConnections:
  enabled: true
  existingConfigMap: "my-seed-connections"  # Pre-created ConfigMap
  configMapKey: "connections.yaml"          # Key within the ConfigMap

extraEnvFrom:
  - secretRef:
      name: seed-db-credentials
```

---

## Platform discovery (CapRover)

Studio can connect itself to the databases a CapRover server runs, with no seed file and no typed password.
A companion process, the exporter, reads the Docker socket and writes a file, and Studio turns every database it recognises in that file into a managed connection for the admin role.
It is off unless `SEED_DISCOVERY_PATH` is set.
The CapRover template that sets it up is `deploy/caprover/libredb-studio-autoconnect.yml`, needs Studio 0.18.0 or later, and is described in [`deploy/caprover/README.md`](../deploy/caprover/README.md#auto-connect-variant), which also covers adding discovery to an existing install.
What the Docker socket costs is recorded in [`docs/SECURITY.md`](./SECURITY.md#known-limits).

### The exporter

`docker/discover.mjs` ships in every image as `/usr/local/lib/libredb-studio/discover.mjs`, owned by root, so the web process cannot replace it.
Run it from the same image version as Studio, and when you upgrade, upgrade Studio first: a Studio older than the exporter can refuse its export with `invalid_export`, and then it withdraws every discovered connection.
It has no dependency and no listening port, and it sends GET requests only, to two Docker Engine API paths pinned to v1.44: the network list filtered by name, and `/v1.44/services?status=true`.
It must run as root with the socket mounted, so it has to replace the image entrypoint, because `docker-entrypoint.sh` drops every command it starts to uid 1001.
A CapRover one-click `command` replaces the entrypoint.
With Docker Compose or `docker run`, set the entrypoint instead, and give Studio the same volume and `SEED_DISCOVERY_PATH` (the fragment shows only the discovery settings):

```yaml
services:
  libredb:
    image: ghcr.io/libredb/libredb-studio:0.18.0
    environment:
      SEED_DISCOVERY_PATH: /app/discovery/services.json
    volumes:
      - discovered:/app/discovery
    networks:
      - default
      - captain-overlay-network
  discovery:
    image: ghcr.io/libredb/libredb-studio:0.18.0
    entrypoint: ["node", "/usr/local/lib/libredb-studio/discover.mjs"]
    environment:
      # Must name the overlay network the database services are on.
      DISCOVERY_NETWORK: captain-overlay-network
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - discovered:/app/discovery
volumes:
  discovered:
networks:
  captain-overlay-network:
    external: true
```

Studio must also join the network `DISCOVERY_NETWORK` names, because the discovered host names resolve only there: in Compose as an external network, as above, and with `docker run` through `--network`; CapRover creates its network attachable.

It lists Swarm services, so it needs a swarm manager: a node that sees the network but is not a manager reports `swarm_unavailable`, and an engine with no network of that name reports `network_not_found` first, because it asks for the network before the services.

Before its first scan it checks that the directory of `DISCOVERY_OUTPUT` is owned by its own uid and is not writable by group or others, and it exits non-zero otherwise.
A directory the web process could write would let it plant a link for the root process to follow.
For that reason the images never create `/app/discovery`: a named volume mounted there starts as root-owned with mode 0755.

Every `DISCOVERY_INTERVAL_MS` (10 seconds by default) it:

1. picks the network whose name equals `DISCOVERY_NETWORK` exactly, because Docker's name filter matches substrings;
2. keeps the services attached to that network, except CapRover's own (`captain-` prefix), Studio's own image, and the app names listed in `DISCOVERY_EXCLUDE`;
3. records for each the service id and name, the app name (the name without `srv-captain--`), the host alias on that network (`srv-captain--<app>`, or the service name for legacy and alias-less apps), the image, the task counts and the allow-listed environment keys below;
4. records the app names it left out because of `DISCOVERY_EXCLUDE` in the export's `excluded` list, sorted and at most 500, with nothing else about those apps;
5. writes the export atomically: a temporary file opened with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, given to `DISCOVERY_FILE_UID:DISCOVERY_FILE_GID` (1001:1001 by default), synced, then renamed over `DISCOVERY_OUTPUT`.

The temporary file always has the same name, `.<file name>.tmp` in the directory of `DISCOVERY_OUTPUT` (`.services.json.tmp` by default), so two exporters writing to the same volume would race.
Run one exporter per shared volume.

A service whose image or app name is empty, or whose name, host or image is longer than its bound, is left out of the export and counted in the scan's dropped values.
On a Docker error it keeps the services, the `excluded` list and the `generatedAt` of its last good scan, and updates only the status and `checkedAt`.
When no network is named exactly `DISCOVERY_NETWORK`, it also writes `network` as null.
After a restart it starts from empty lists, with `generatedAt` null until its first good scan.
It never logs a value from a service's environment.
Its variables are listed in `.env.example` under "Platform Discovery Exporter".
`DISCOVERY_INTERVAL_MS` takes an integer from 2000 to 2147483647, the longest delay Node's timers honour, and `DISCOVERY_FILE_UID` and `DISCOVERY_FILE_GID` take an integer from 0 to 4294967294.
A value outside its range, or one that is not a whole number, stops the exporter at start, before its first scan, with `<NAME> must be an integer of at least <minimum>, got "<value>"` or `<NAME> must be an integer of at most <maximum>, got "<value>"` in its log.

Every service on the network that is not excluded is listed with its name, host, image and task counts, database or not; only the environment is filtered.
The environment allow-list is exactly these ten keys, case-sensitive: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MYSQL_ROOT_PASSWORD`, `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `REDIS_PASSWORD`, `VALKEY_EXTRA_FLAGS`, `KEYDB_PASSWORD`, `DFLY_requirepass`.
`DFLY_requirepass` is mixed case because that is Dragonfly's own spelling.
The list lives once, as `ENV_ALLOW_LIST` in `docker/discover.mjs`, and a unit test fails when a key Studio reads is missing from it.
Every service in the export also carries `requirepassEnv`, which only the Redis detection and mapping read.
It is the name of the allow-listed variable that a `--requirepass $NAME` in the service's command refers to, or null when there is none, and never the command itself.

### Engine detection

Studio parses the image repository (digest, tag, registry host and a leading `library/` removed) and matches it:

| Repository | Studio type | Label |
|------------|-------------|-------|
| `postgres`, `postgis/postgis`, `timescale/timescaledb`, `timescale/timescaledb-ha`, `pgvector/pgvector` | `postgres` | PostgreSQL |
| `mysql` | `mysql` | MySQL |
| `mariadb` | `mysql` | MariaDB |
| `percona`, `percona/percona-server` | `mysql` | Percona |
| `mongo` | `mongodb` | MongoDB |
| `redis` | `redis` | Redis |
| `valkey/valkey` | `redis` | Valkey |
| `eqalpha/keydb` | `redis` | KeyDB |
| `dragonflydb/dragonfly` | `redis` | Dragonfly |

An image CapRover built itself (its last path segment starts with `img-captain-`, as the mariadb and keydb templates produce) is matched by its environment instead:

| Key present | Studio type | Label |
|-------------|-------------|-------|
| `MYSQL_ROOT_PASSWORD` | `mysql` | MySQL-compatible |
| `KEYDB_PASSWORD` | `redis` | KeyDB |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL |
| `MONGO_INITDB_ROOT_PASSWORD` | `mongodb` | MongoDB |
| `REDIS_PASSWORD`, with a `requirepassEnv` | `redis` | Redis |

Many apps CapRover builds carry these keys without being a database, so an environment match is listed only when a TCP connection to its port opens within 1 second.
A successful probe is cached for 30 seconds, a failed one is not cached, and at most 16 probes run at once.
A repository match is never probed: a stopped database stays listed and shows its connection error when opened.
Any other image is ignored and is not reported as skipped.

### Credential mapping

| Type | Port | User | Password | Database | Extra |
|------|------|------|----------|----------|-------|
| `postgres` | 5432 | `POSTGRES_USER`, else `postgres` | `POSTGRES_PASSWORD`, required | `POSTGRES_DB`, else the user | none |
| `mysql` | 3306 | `root` | `MYSQL_ROOT_PASSWORD`, required | `mysql` | none |
| `mongodb` | 27017 | `MONGO_INITDB_ROOT_USERNAME`, required | `MONGO_INITDB_ROOT_PASSWORD`, required | none | `authSource: admin` |
| `redis` (Redis) | 6379 | none | the variable `requirepassEnv` names, else none | `0` | none |
| `redis` (Valkey) | 6379 | none | the token after `--requirepass` in `VALKEY_EXTRA_FLAGS`, as written, quotes included, else none | `0` | none |
| `redis` (KeyDB) | 6379 | none | `KEYDB_PASSWORD`, else none | `0` | none |
| `redis` (Dragonfly) | 6379 | none | `DFLY_requirepass`, else none | `0` | none |

The host is always the exporter's host for that service and must match `^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$`; a service whose host does not is skipped with a reason.
A missing required field skips the service with a reason.
The official redis image ignores `REDIS_PASSWORD` on its own, and the redis one-click template makes it effective through `--requirepass $REDIS_PASSWORD` in its command, which is why the password comes through `requirepassEnv`.
The official valkey image passes `VALKEY_EXTRA_FLAGS` to the server unquoted, so quote characters around the `--requirepass` value are part of the password it enforces, and a value with a blank in it cannot be set at all; Studio therefore takes the token as written.
Credentials are a snapshot of the environment CapRover set: a password changed later inside the database makes the connection fail with an authentication error.

### What every discovered connection gets

- id `caprover-<app name>`, name `<app name> (<label>)`, group `CapRover`;
- `ssl: { mode: "disable" }`, so an app whose name contains a cloud provider's name is not mistaken for a managed cloud host;
- `managed: true`, `roles: ["admin"]`, no `mcp`, no `readOnly` and no `connectionString`, all set in code and never read from the export file.

The values are used as literal text.
A discovered value that looks like a reference, `${NAME}` or `${vault:...}`, is sent to the database as written, and Studio never resolves it from its own environment or from Vault, neither when listing connections nor when one is opened.
Any app on the CapRover network can carry these keys, and resolving a reference in them would hand Studio's own secrets to that app as a password.
The marker that does this is set by the discovery source, not derived from the id, so a seed-file connection whose id starts with `caprover-` keeps the usual resolution, unless `SEED_LITERAL_VALUES` makes every seed-file value a literal too ([Literal values written by a platform](#literal-values-written-by-a-platform)).
`GET /api/connections/managed` strips the marker, so its response shape is unchanged.

### Precedence

- The managed list holds the seed-file connections first, then the discovered ones, then the built-in samples.
- A discovered id that equals a seed-file id is dropped and reported as skipped, with the reason "id taken by the seed file".
- Two services can map to the same id, for example `srv-captain--foo` and a hand-made service named `foo`, which both become `caprover-foo`; the first one Studio accepts, in the order of the export, is listed, and every later one is reported as skipped, with the reason "id taken by another discovered service".
- An app named in the export's `excluded` list (the "Apps to skip" field, `DISCOVERY_EXCLUDE`) is never listed and, while Studio serves fresh data, is reported as skipped, with the reason "listed in Apps to skip".
- Each discovered connection is validated on its own with the seed schema; an invalid one is skipped with its reason and the others are listed.
- Discovered connections go through the same role filter as file seeds, so a standard user receives none of them, and naming a discovered id answers the same 404 as an unknown id.
  A standard user cannot read the export file through DuckDB either: a non-admin DuckDB handle opens with statement-level file access closed (section 3.16 of [`docs/providers/duckdb.md`](./providers/duckdb.md), control 3.17 in [`docs/SECURITY.md`](./SECURITY.md)), and the export is JSON, which DuckDB refuses to open as a database.
  An admin's own DuckDB connection can still read it (section 14.3 of [`docs/providers/duckdb.md`](./providers/duckdb.md)), so the admin login holds every discovered database's password.
- No discovery failure reaches the managed list: every error is caught inside the source, so file seeds and samples are listed as before.

### Freshness and state

Studio re-reads the export at most once per `SEED_CACHE_TTL_MS` while its copy is fresh, and concurrent requests share one read.
The age of `generatedAt` is checked on every request against the cached export.
A cached copy that has turned stale is re-read, at most every 5 seconds (or once per `SEED_CACHE_TTL_MS` when that is shorter), so the discovered connections are withdrawn once the file itself is older than `SEED_DISCOVERY_MAX_AGE_MS`, without waiting for the TTL, and a long `SEED_CACHE_TTL_MS` never withdraws the connections of an exporter that keeps writing.
For that, the exporter's `DISCOVERY_INTERVAL_MS` must stay well below `SEED_DISCOVERY_MAX_AGE_MS`; the defaults are 10 and 60 seconds.
A `generatedAt` ahead of Studio's own clock counts as fresh.

| Condition | State | Discovered connections |
|-----------|-------|------------------------|
| `SEED_DISCOVERY_PATH` unset | off (`discovery: null` in the admin status) | none |
| Export file missing | `waiting` | none |
| File unreadable, over 2 MiB, not JSON or not the expected shape | `error`, code `invalid_export` | none |
| `generatedAt` null and the exporter reports an error | `error`, with the exporter's code and message | none |
| `generatedAt` older than `SEED_DISCOVERY_MAX_AGE_MS` | `stale`, with the exporter's error if any | none, withdrawn |
| `generatedAt` fresh and the exporter reports an error | `error`, with the exporter's code and message | the last good scan |
| `generatedAt` fresh and status ok | `ok` | listed |

The exporter's codes are `socket_unavailable`, `swarm_unavailable`, `api_version`, `network_not_found`, `docker_error` and `limit_exceeded`.
When the file is still missing twice `SEED_DISCOVERY_MAX_AGE_MS` after Studio first looked, the waiting message says that the discovery app may not be running or may run on another node than Studio.
Studio's own messages about an unreadable or invalid file never quote the file's content.

The skipped list holds one entry per discovered service Studio refused, with its reason: a missing required variable, a host name Studio refuses, "the connection is not valid" followed by each field the seed schema refused and its issue code, such as id (too_big) for a hand-made service whose name is over 55 characters, "id taken by the seed file", "id taken by another discovered service", or "did not answer on port" followed by the port number, for an environment-matched candidate.
While Studio serves discovered data, that is in the state `ok` and in the state `error` with a fresh last good scan, the list also holds one entry per app name in the export's `excluded` list, after the others, with the reason "listed in Apps to skip".
An image that matches no engine is not a skipped entry, and neither is an app that is not on the CapRover network.

### Admin status

`GET /api/admin/discovery` (admin only, [`docs/API_DOCS.md`](./API_DOCS.md#admin-api)) and a card on the admin Overview page (`/admin/overview`) report the state and its message, the last successful scan, the exporter's error, the connected databases and the skipped apps with their reasons.
Neither carries a host name beyond app names, nor any environment value.
`GET /api/connections/managed` carries no status, because every role can read it.
While the request reached Studio over plain HTTP, or `AUTH_COOKIE_SECURE` is `false`, `off` or `0` in any letter case, and at least one database is connected, the card warns:

> The Studio session cookie can travel over plain HTTP, and it unlocks every discovered database.
> Enable HTTPS and Force HTTPS for this app in CapRover, then set AUTH_COOKIE_SECURE to true and restart.

The operator sources have a card of their own beside this one, described under [Diagnostics](#diagnostics); it shows whether or not discovery is on.

### In an open tab

After its first successful load, an open tab refetches the managed list every `max(SEED_CACHE_TTL_MS, 5000)` milliseconds, at most 60 seconds, while the tab is visible, and at once when the window regains focus or the tab becomes visible again.
The 5000 is the floor `NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS`, which is inlined at build time (see [Environment Variables](#environment-variables)).
An install that keeps the default `SEED_CACHE_TTL_MS` of 60000 therefore refreshes an open tab once a minute, while the auto-connect template sets 5000, so its tabs refresh every 5 seconds.
With the template's values a database appears or disappears in an open tab within about 20 seconds of the change in CapRover: the exporter scans every 10 seconds, Studio re-reads the export at most every 5, and the tab refreshes every 5.
The template's end text says about 30 seconds, which also covers a database that is still starting: an image CapRover built itself, as the MariaDB and KeyDB templates produce, is listed only once its database accepts connections.
The active connection stays open while its id is still listed; when it is withdrawn, the first remaining connection the sidebar lists becomes active and Studio says so once.
With `ALLOW_CUSTOM_CONNECTIONS` off that is never one of the user's own connections, which stay hidden (see [Custom Connections](#custom-connections)).
Pages that use the lighter connection list (the admin Overview and Operations tabs, Schema Diff and Monitoring) load it once and need a reload.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Config file not found at the default path | App runs normally, no seed connections. The warning is logged once for that path, and again only after the file has appeared and gone, so a short `SEED_CACHE_TTL_MS` does not repeat it on every re-read. |
| `SEED_CONFIG_PATH` set explicitly to a file that does not exist | App runs normally, no seed connections. The same once-per-path warning is logged, and the Seed sources card shows "Not found" with the path. |
| Config file unreadable (for example the path is a directory) | Endpoint returns a generic 500 with `reason: "seed-config-unreadable"`; the Seed sources card shows Failed with code `unreadable`. |
| `Failed to parse seed config at <path>: TAG_RESOLVE_FAILED at line L, column C` | A value YAML reads as a tag: it starts with `!`, or carries a tag such as `!!int` on text. Quote the value. Studio refuses the file as `unparseable` instead of loading the value as empty or as other text, and never prints the line; earlier versions loaded such a file with the value changed. |
| `connectionString` on a type whose provider does not read it | The whole file fails like any invalid config, and the error names the connection and the type ([The connection string refusal](#the-connection-string-refusal)). |
| Two connections with the same id in the seed file | The whole file fails like any invalid config, and the error names the repeated id, for example `connections.1.id: Connection id "pg" is declared more than once`. |
| Two operator sources declaring the same id | The whole list fails, and the error names the id and both origins. |
| Invalid YAML/JSON | `GET /api/connections/managed` returns a generic 500 with `reason: "seed-config-unreadable"` and logs the details server-side. `GET /api/admin/seed-sources` returns the parse message to an admin, and the Seed sources card shows it with code `unparseable`; a YAML error names its code and, where the parser has one, its line and column, and a JSON error says the file is not valid JSON; neither quotes a value. |
| Invalid config (Zod validation fails) | `GET /api/connections/managed` returns a generic 500 with `reason: "seed-config-unreadable"` and logs the validation errors server-side. `GET /api/admin/seed-sources` returns the validation message to an admin, and the Seed sources card shows it with code `invalid`; the message names the fields, never a value. |
| `mcp` that is not a boolean, or `mcp` in `defaults` | The whole file fails like any invalid config; every MCP tool answers that the connection configuration could not be read |
| `readOnly: true` on a connection whose type does not enforce it, on a connection whose effective `managed` is false, or `readOnly` in `defaults` | The whole file fails like any invalid config, and the error names the connection, the field and the reason |
| `readOnly: true` on a connection whose literal credential matches a default its type declares, or with no password where its type declares it accepts none | The whole file fails like any invalid config, and the error names the connection and `password`, never the value; a `${ENV}` or `${vault:...}` reference is checked once it resolves, and the connection is refused before anything is dialled |
| `mcp: true` on an etcd or Oxia connection | The whole file fails like any invalid config, and the error names `mcp` and the type, `etcd` or `oxia` |
| Unrecognized `version` | Endpoint returns 500. Future versions require code update. |
| `${ENV_VAR}` not defined | That connection is **skipped**. Others work normally. Error logged, and the Seed sources card lists the skip with the variable; the endpoint's record also names the field. |
| `${vault:...}` reference, Vault unreachable / path or key missing / token refused | The connection fails with an explicit error **when it is opened**. Listing connections is unaffected, and so is every other connection. |
| `${vault:...}` reference with no `#key`, or a v1-shaped path | Fails with an error naming the expected KV v2 shape. The value is never treated as a literal. |
| `${vault:...}` reference with `VAULT_ADDR` unset | Fails with a message naming the missing variable. |
| A value written as `${ENV_VAR}` or `${vault:...}` while `SEED_LITERAL_VALUES=true` | Used as written: no variable is read, the connection is not skipped and Vault is not asked, so a value that is not the real credential fails like any wrong credential when the connection is opened. |
| `SEED_LITERAL_VALUES` set to a value it does not recognize | References stay resolved, as with the mode off, and one warning per process names the value. |
| User role doesn't match any connection | Empty list returned. Normal behavior. |
| Seed connection not found at query time | 404 response. |
| User doesn't have access to seed connection | 403 response. |
| `SEED_DISCOVERY_PATH` set and the export file missing | No discovered connections and discovery state `waiting`, while file seeds and samples are unaffected. |
| Export file unreadable, over 2 MiB, not JSON or not the expected shape | No discovered connections and state `error` with code `invalid_export`, whose message never quotes the file. |
| Export older than `SEED_DISCOVERY_MAX_AGE_MS` (the exporter stopped or was deleted) | Discovered connections withdrawn; state `stale`. |
| The exporter reports a Docker error (socket, swarm, network, API) | The last good scan stays listed while it is fresh; state `error` with the exporter's code. |
| One discovered service maps to an invalid connection, or its id is taken by the seed file or by another discovered service | That service is skipped with a reason in the admin status; the others are listed. |
| An environment-matched candidate does not accept a TCP connection | Not listed and reported as skipped; listed on a later read once it accepts connections. |
| An app is named in "Apps to skip" (`DISCOVERY_EXCLUDE` of the exporter) | Never listed, and reported as skipped with the reason "listed in Apps to skip" while the export is fresh. |
| An unexpected exception inside the discovery source | No discovered connections and state `error` with code `discovery_failed`; file seeds and samples are unaffected. |

**Design principle:** a problem in the seed configuration fails the whole operator list, so a file read in part never lists a subset that looks complete.
A parse error, a schema error in any one connection, or two operator connections with one id make `GET /api/connections/managed` answer 500, and the Seed sources card shows the error.
The one exception is an undefined `${ENV_VAR}`: it skips only the connection that names it, and the card lists the skip.
Discovered connections are validated one by one, and a bad one never fails the list.

---

## Security Model

### Credential Protection

- `managed: true` connections: credentials **never reach the client**. The API strips every field `src/lib/storage/connection-secrets.ts` classifies as secret, which on a seed means `password`, `connectionString`, the Elasticsearch `apiKeyId` and `apiKeySecret` pair, and `ssl.clientKey`. Certificates (`ssl.caCert`, `ssl.clientCert`) are public and still reach it. Server resolves credentials at query execution time.
- That covers what the API returns, not what an engine answers a statement with. A managed Redis seed that authenticates with `requirepass` answers `CONFIG GET requirepass` with the password, so give a managed seed a least-privilege credential, for Redis an ACL user without `+config`.
- Config file should be mounted **read-only** (`:ro` in Docker, `readOnly: true` in Kubernetes).
- Use `${ENV_VAR}` for the secrets of a file you write by hand.
  Plaintext passwords trigger a warning log.
- Read a file that a platform writes from data its users control with `SEED_LITERAL_VALUES=true`, so that no value in it is resolved from Studio's environment or from Vault ([Literal values written by a platform](#literal-values-written-by-a-platform)).

### Role Enforcement

- User role is extracted from the JWT session **server-side** — never from client headers or request params.
- Every database operation (query, schema, health check, etc.) goes through `resolveConnection()` which verifies role access before returning credentials.
- Role check failures return 403 with no credential information.
- While `ALLOW_CUSTOM_CONNECTIONS` is off, `resolveConnection()` also refuses a connection supplied in the request with 403, so only seeds reach a provider (see [Custom Connections](#custom-connections)).

### Audit Trail

`resolveConnection()` (`src/lib/seed/resolve-connection.ts`) logs every seed-connection lookup through the structured logger:

- A successful resolution logs at `debug` level with `route`, `connectionId`, and `user`.
- A denied lookup (connection exists but the caller's role isn't in `roles`) logs at `warn` level with `route`, `connectionId`, `user`, and `role`, before the 403 is returned.

This is the standard application logger (`src/lib/logger.ts`), not a persisted audit-log entry — there is currently no dedicated `managed_connection` audit-ring-buffer event wired up for seed connections, despite that event type existing in `src/lib/audit.ts`'s `AuditEventType` union.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEED_CONFIG_PATH` | `/app/config/seed-connections.yaml` | Path to config file |
| `SEED_CACHE_TTL_MS` | `60000` | Cache TTL in milliseconds |
| `ALLOW_CUSTOM_CONNECTIONS` | `true` | `false`, `0`, `off` or `no` refuses every connection that is not a seed, and so does any unrecognised value; see [Custom Connections](#custom-connections) |
| `SEED_LITERAL_VALUES` | unset | `true`, `1`, `on` or `yes` (trimmed, any case) reads every seed value as written: no `${ENV_VAR}` or `${vault:...}` reference is resolved and the plaintext-password warning is not logged. `false`, `0`, `off`, `no` or empty keep references resolved, and so does any other value, with one warning ([Literal values written by a platform](#literal-values-written-by-a-platform)) |
| `SEED_DISCOVERY_PATH` | unset (off) | Path of the discovery export file inside the Studio container; see [Platform discovery (CapRover)](#platform-discovery-caprover) |
| `SEED_DISCOVERY_MAX_AGE_MS` | `60000` | Age of the export's `generatedAt` after which discovered connections are withdrawn; keep it well above the exporter's `DISCOVERY_INTERVAL_MS` (10000 by default) |
| `NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS` | `5000` | Shortest interval of an open tab's managed-list refresh, inlined at build time, so it only affects source builds and tests, not packaged artifacts |

The `VAULT_*` variables that back `${vault:...}` references are listed under [Vault Environment Variables](#vault-environment-variables).
The exporter's own variables (`DISCOVERY_*` and `DOCKER_SOCKET`) are read by `docker/discover.mjs` only, never by the Studio server, and are listed in `.env.example`.
`NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS` is inlined at build time like `NEXT_PUBLIC_MANAGED_POLL_MS` (see [Built-in Sample Connections](#built-in-sample-connections)), so it is not in `.env.example` and setting it on a running container has no effect.

These are unrelated to the embedded sample connection described below, which uses its own `LIBREDB_EMBEDDED_SAMPLE` / `LIBREDB_EMBEDDED_SAMPLE_PATH` variables.

---

## Built-in Sample Connections

Standalone deployments also get automatic, code-defined seed connections (none of this has any effect when embedded in libredb-platform — it is not part of the published `@libredb/studio` package surface):

- **Sample (LibreDB)** — on first startup, `src/lib/seed/libredb-sample.ts` creates an embedded LibreDB file (default `<data dir>/sample.libredb`, alongside the SQLite storage DB) and seeds it with example data — a `users` table, an `articles` document collection, and a couple of KV entries — one per LibreDB lens. Seeded synchronously during boot.
- **Sample (Employees)** — `src/lib/seed/sqlite-sample.ts` copies the vendored employees SQLite database (`seed-assets/sqlite/employee.db`, from [bytebase/employee-sample-database](https://github.com/bytebase/employee-sample-database) `dataset_small`, originally [datacharmer/test_db](https://github.com/datacharmer/test_db); see `seed-assets/sqlite/ATTRIBUTION.md`) to `<data dir>/sample-employees.db`. Seeded **asynchronously and fail-open**: boot never waits for the copy; while it is in flight `GET /api/connections/managed` lists the seed id in `pendingSeeds` and the client polls (1s, max 30 attempts; the interval constant is inlined at build time — `NEXT_PUBLIC_MANAGED_POLL_MS` only affects source builds and tests, not packaged artifacts) so the connection appears without a page refresh.

`getManagedConnections()` appends each sample to the managed-connections list once its file exists (`managed: false`). LibreDB is offered to all roles (`roles: ["*"]`); SQLite is offered only to administrators (`roles: ["admin"]`) because its adapters cannot confine statement-level file access. Both behave like other unmanaged seeds: editable, and if deleted they go to the dismissed list rather than reappearing.
Neither sample is ever visible to an MCP client, because neither carries `mcp: true`.

This is separate from the `SEED_CONFIG_PATH` file and needs no config of its own:

| Variable | Default | Description |
|----------|---------|-------------|
| `LIBREDB_EMBEDDED_SAMPLE` | `true` | Set to `false` (exact match) to disable the LibreDB sample |
| `LIBREDB_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample.libredb` | Override the LibreDB sample file's location |
| `SQLITE_EMBEDDED_SAMPLE` | `true` | Set to `false` (exact match) to disable the SQLite sample |
| `SQLITE_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample-employees.db` | Override the SQLite sample file's location |
| `SQLITE_EMBEDDED_SAMPLE_TEMPLATE` | `<cwd>/seed-assets/sqlite/employee.db` | Override the vendored template's location |

The sample files are only created if they don't already exist — the seeding is idempotent and never overwrites a user's edits.

---

## Troubleshooting

### Connections don't appear after login

1. Check if the config file exists at `SEED_CONFIG_PATH`
2. Check server logs for `Seed config file not found` warning.
   Studio logs it once per path per process, at the first look, and again only after the file has appeared and gone, so a long-running instance may not show it among its recent log lines.
3. Verify the YAML is valid: `cat seed-connections.yaml | python3 -c "import yaml,sys; yaml.safe_load(sys.stdin)"`
4. Check if `${ENV_VAR}` values are set: connections with unresolvable vars are skipped
5. `${vault:...}` references do not stop a connection appearing, but opening it fails with the Vault error. Check `VAULT_ADDR`, that the path is the KV v2 shape (`<mount>/data/<name>`) and that the token has a read policy on it. See [Secret Rotation](#secret-rotation) for how long a cached value can outlive a change in Vault.

### "Access denied" error when querying

The user's role doesn't match the connection's `roles` array. Check:
- User JWT role: login as admin vs user
- Connection `roles` field in config

### Credentials not updating after config change

- `managed: true`: Wait for TTL to expire (default 60s), or restart the app
- `managed: false`: The user has a local copy that never re-syncs from the config. Deleting it from the sidebar does not bring back the updated version either — it only marks the seed as dismissed (see [Dismissed Seeds](#dismissed-seeds)). To pick up new credentials, the user must delete their local copy from the `libredb_connections` entry in localStorage **and** remove the matching seed ID from `libredb_dismissed_seeds`, then reload.

### Two identical connections in sidebar

Clear browser localStorage (`libredb_connections` key) and refresh. This can happen if a connection was persisted before being marked as managed.

### A deleted seed connection won't come back

This is expected: deleting a `managed: false` connection adds its seed ID to `libredb_dismissed_seeds` in localStorage, and it is intentionally excluded from re-import on every subsequent load (see [Dismissed Seeds](#dismissed-seeds)). Remove the ID from that key (or clear it) to let the connection be re-imported.

### Discovered CapRover databases don't appear

1. Sign in as the admin: discovered connections are never listed for the standard user.
2. Open the admin Overview page and read the discovery status.
   There is no card at all while `SEED_DISCOVERY_PATH` is unset or for a user who is not an admin, so an install where discovery was added by hand and the variable was forgotten has no status to read: set it on the Studio app first.
   The card's badge reads Running for `ok`, Waiting for `waiting`, Stale for `stale` and Failed for `error`, and the steps below use the state names.
3. `waiting`: the export file does not exist yet.
   Check that the `-discovery` app is running, and on a cluster that it runs on the same node as Studio.
   If the exporter's log says `refusing to start: /app/discovery is owned by uid 0, not by this process (uid 1001)`, it was started through the image entrypoint, which a Compose `command:` alone does: set `entrypoint:` as in the fragment under [The exporter](#the-exporter).
4. `error` with `socket_unavailable`: the exporter cannot open the Docker socket.
   It must run as root with `/var/run/docker.sock` mounted.
5. `error` with `swarm_unavailable`: the exporter runs on a worker node, and so does Studio, because it reads that node's volume.
   Pin both apps to the same manager node under **App Configs**.
6. `error` with `network_not_found`: no Docker network has exactly the name `DISCOVERY_NETWORK` gives, or the exporter runs where that network does not exist, for example outside a swarm.
   Check the variable against `docker network ls` on the manager; CapRover's own network is `captain-overlay-network`.
7. `error` with one of these codes:
   - `invalid_export`: Studio refused the file at `SEED_DISCOVERY_PATH`, and the message says why: over 2 MiB, unreadable (the reason follows in parentheses), not JSON, or the first field that does not match the export's shape.
     Check that `SEED_DISCOVERY_PATH` is the exporter's `DISCOVERY_OUTPUT`, and for `EACCES` that `DISCOVERY_FILE_UID` is the user Studio runs as, because the file is mode 0600.
     A field that does not match can also mean that the exporter runs a newer image than Studio: deploy the same version to both.
     Studio also logs the reason as a `Discovery source error` warning when it appears or changes.
   - `docker_error`: a Docker failure no other code covers, such as an HTTP status other than 400 and 503, and the message is the daemon's own text when it sent one.
     The `-discovery` app's log repeats it.
   - `api_version`: Docker answered HTTP 400, which the exporter reads as an Engine API version the daemon does not serve.
     The exporter asks for v1.44, as CapRover does, so check that the Docker on the manager serves it.
   - `limit_exceeded`: the exporter hit one of its bounds, and its message says which: more than 500 services on the network, an export over 2 MiB, or a Docker answer over 16 MiB.
     For the first two it still exports the services that fit, in name order, so the databases after the cut are missing; an app named in `DISCOVERY_EXCLUDE` is not counted among the 500.
8. `stale`: the exporter stopped writing.
   Check its logs and restart it.
   The state also becomes `stale` while the exporter still runs, once its scans have kept failing for longer than `SEED_DISCOVERY_MAX_AGE_MS` since the last good one.
   The card then shows the exporter's error, so the cause is in steps 4 to 7.
9. A database in the skipped list carries its reason: a missing required variable, a host name Studio refuses, a connection the seed schema refuses ("the connection is not valid" followed by the field and its issue code, for example id (too_big) when a hand-made service's name is over 55 characters, too long for the 64-character id), an id the seed file already uses ("id taken by the seed file"), an id another discovered service already took ("id taken by another discovered service"), or no answer to the probe for an image CapRover built.
10. An app named in "Apps to skip" (`DISCOVERY_EXCLUDE` of the `-discovery` app) is in the skipped list with the reason "listed in Apps to skip", and the exporter writes nothing about it but its name.
   To connect it after all, remove it from `DISCOVERY_EXCLUDE` under the `-discovery` app's **App Configs** and save.
11. A database whose image is neither in the [detection table](#engine-detection) nor built by CapRover is not recognised: add it as a seed connection or by hand.

---

## Architecture

```
seed-connections.yaml (SEED_CONFIG_PATH)
        │
  ┌─────▼──────────────┐
  │ Operator sources    │  sources/file.ts: read + YAML/JSON parse + Zod validate + its own defaults
  └─────┬──────────────┘
        │
  ┌─────▼──────────────┐
  │ OperatorLoader      │  Fixed order + id collisions + ${ENV_VAR} → process.env (CredentialResolver)
  │                     │  + recorded skips + TTL cache + status for GET /api/admin/seed-sources
  └─────┬──────────────┘
        │
  ┌─────▼──────────────┐
  │ ConnectionFilter    │  Role filter → ManagedConnection[]; defines mergeDefaults, which the sources apply
  └─────┬──────────────┘
        │         ┌───────────────────────────────────────┐
        ├─────────┤ Platform discovery (discovery-*.ts,    │  Appended after the file seeds when
        │         │ reads SEED_DISCOVERY_PATH)             │  it is set; admin role only, literal
        │         └───────────────────────────────────────┘
        │         ┌───────────────────────────────────────┐
        ├─────────┤ Embedded samples (libredb-sample.ts,   │  Appended if enabled and the
        │         │ sqlite-sample.ts)                      │  sample file exists
        │         └───────────────────────────────────────┘
  ┌─────▼───────────────────────┐
  │ GET /api/connections/managed │  Auth + strip credentials for managed:true
  └─────┬───────────────────────┘                          ${vault:...} stays unresolved here
        │
  ┌─────▼────────────────────┐
  │ useConnectionManager     │  Merge managed + user connections
  └─────┬────────────────────┘
        │
  ┌─────▼────────────────────────────┐
  │ resolveConnection() (all routes) │  seed: prefix → server-side credential resolution
  └─────┬────────────────────────────┘  a literal connection (discovered, or a file seed with SEED_LITERAL_VALUES on) skips Vault
        │
  ┌─────▼────────────────────┐
  │ VaultClient (lazy)       │  ${vault:...} → KV v2 read + per-path TTL cache
  └──────────────────────────┘
```

**Module:** `src/lib/seed/` (17 files)

| File | Responsibility |
|------|---------------|
| `types.ts` | Zod schemas + TypeScript types |
| `operator-loader.ts` | Reads the operator sources in order: id collisions, `${ENV_VAR}` resolution with recorded skips, the TTL cache, one read at a time, and the status the admin card shows |
| `sources/types.ts` | The operator source contract: entries, skips, notes, reports and `OperatorSourceError` |
| `sources/config-text.ts` | Parse and validate one seed config text, naming its origin in every message, and merge its own `defaults` |
| `sources/file.ts` | The `SEED_CONFIG_PATH` source |
| `sources/registry.ts` | The enabled operator sources, in their fixed order |
| `credential-resolver.ts` | `${ENV_VAR}` resolution (eager) + `${vault:...}` resolution (lazy, per connection) |
| `vault-client.ts` | HashiCorp Vault KV v2 reads: env config, Kubernetes auth, per-path TTL cache |
| `connection-filter.ts` | Role filter, and `mergeDefaults`, which each operator source applies to its own connections (`sources/config-text.ts`) |
| `resolve-connection.ts` | Shared utility for all API routes |
| `libredb-sample.ts` | Built-in "Sample (LibreDB)" connection: file seeding + descriptor |
| `sqlite-sample.ts` | Built-in "Sample (Employees)" connection: vendored template copy + descriptor |
| `index.ts` | Public API: `getManagedConnections()`, `getPendingSeeds()`, `getSeedConnectionById()`, `getSeedConnectionByIdUnfiltered()` and `resetCache()` |
| `discovery-export.ts` | Zod schema and parser of the platform discovery export file, with its 2 MiB cap |
| `discovery-fingerprint.ts` | Image repository parsing, engine detection and credential mapping of discovered services |
| `discovery-probe.ts` | TCP probe for environment-matched candidates: 1 s timeout, 30 s positive cache, 16 at a time |
| `discovery-loader.ts` | Platform discovery source: cached read, freshness state, validation, admin status |

The exporter, `docker/discover.mjs`, lives outside `src/`: it ships in the container images only, and Studio never imports it.
