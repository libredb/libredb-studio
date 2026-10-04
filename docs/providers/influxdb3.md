# InfluxDB 3 (SQL) Provider

The `influxdb3` type-id: read-only browsing and querying of InfluxDB 3 in SQL, over `/api/v3/query_sql`, tested on InfluxDB 3 Core 3.12.0.
Source: [`src/lib/db/providers/timeseries/influxdb/`](../../src/lib/db/providers/timeseries/influxdb/), the `sql-*` modules and the shared connection layer.
Tests: [`tests/unit/db/influxdb/`](../../tests/unit/db/influxdb/) and [`tests/integration/db/influxdb3-provider.test.ts`](../../tests/integration/db/influxdb3-provider.test.ts).

## 1. Overview

The connection type is labelled "InfluxDB 3 (SQL)" in the dialog, and it reads InfluxDB 3 through the SQL its server runs, Apache DataFusion.
It lists the tables of one database, describes their columns, previews their newest rows, and runs one read statement per request.
It writes nothing: no route Studio can send writes, the read policy refuses every writing statement before the request, and InfluxDB 3 Core's planner refuses them as well.
To query InfluxDB 1.x, 2.x or 3.x in InfluxQL, use the InfluxDB (InfluxQL) type, [influxdb.md](./influxdb.md).

### 1.1 Concept mapping

| InfluxDB 3 | Studio |
|---|---|
| One server | One connection, which reads one database of it, the session database |
| A database | The session database: the connection's Database field, or the only one the token lists; no tree node |
| A table (a measurement) | A row of Tables at the top of the tree |
| A tag, a field, `time` | A column, typed `tag`, the field's type, or `time` |
| A row | A row of the grid |
| A token | The Token field, sent as a bearer token |

### 1.2 Tested versions

Tested against InfluxDB 3 Core 3.12.0, image `influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076`, captured 2026-10-04.
InfluxDB 3 Enterprise speaks the same API and is not tested; its database tokens are handled from InfluxData's documentation ([D201](../BACKLOG.md)).
InfluxDB Cloud Serverless and Cloud Dedicated serve SQL only over Arrow Flight, which Studio does not use, so this type cannot reach them: connect to them with InfluxDB (InfluxQL) ([D202](../BACKLOG.md)).

## 2. Architecture

### 2.1 Where it sits

One directory, `src/lib/db/providers/timeseries/influxdb/`, serves two type-ids with two independent classes over one shared connection layer: `influxdb` with `InfluxDBProvider`, documented in [influxdb.md](./influxdb.md), and `influxdb3` with `InfluxDB3Provider`, documented here.
`InfluxDB3Provider` extends `SQLBaseProvider`, so the shared SQL limiter, statement splitter and generators serve it under the DataFusion grammar row.
`sql-provider.ts` is the one file of the directory that imports a module under `src/lib/db/providers/` outside it, `@/lib/db/providers/sql/sql-base`, and the seam guard (`tests/unit/db/influxdb/seam-guard.test.ts`) allows that one import and no other.
No `sql-*` module imports an `influxql-*` module, and no `influxql-*` module imports an `sql-*` one.

### 2.2 Modules

| File | What it owns |
|---|---|
| `sql-provider.ts` | `InfluxDB3Provider`: the declarations, the connect sequence, each call's permit, deadline and error context |
| `sql-policy.ts` | The read policy: one statement, six leading keywords, no writing word, the text cap |
| `sql-results.ts` | A jsonl answer to fields and rows, with exact integers, the row cut and the cell budget |
| `sql-objects.ts` | The database listing, the table listing, the column read, the one-segment path rule |
| `connection-options.ts` | Shared: the endpoint, the bearer header, the plaintext rule and its consent, TLS, the bounds |
| `routes.ts`, `client.ts` | Shared: the closed route tables, and the only client that builds a request from them |
| `versions.ts`, `errors.ts` | Shared: the version from `/ping` and `/health`, and the one error table of both types |
| `run-database.ts`, `monitoring.ts`, `labels.ts` | Shared: the session database, the overview and health, the labels of both types |
| `index.ts` | The two provider classes the factory imports, and nothing else |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` builds the options, then reads `GET /ping` (and `GET /health` when `/ping` names no version), then the database listing, then settles the session database; each read shares one surface deadline, and a failure closes the client.
`disconnect()` closes the client, which stops every request in flight.
The transport never goes through an `http_proxy` or `https_proxy` variable and never follows a redirect: use an SSH tunnel to reach a private endpoint.

## 3. Design decisions

### 3.1 Read-only

Studio sends no write to InfluxDB 3: no line protocol write, no database, table, token, cache, plugin or trigger route exists in the route table, and no maintenance operation is offered.
The read-only mode is declared (`READ_ONLY_ENFORCED`, `enforcesReadOnly`), and every statement passes the read policy before any request whether the connection's Read-only box is ticked or not.

### 3.2 Defence in depth

Three layers stand between a statement and a write.
The closed route table holds four routes, of which `POST /api/v3/query_sql` is the only one that carries a statement, so no request can reach a write endpoint.
The read policy (section 5.3) admits one statement that leads with a read keyword and holds no writing word, and refuses everything else before the request.
InfluxDB 3 Core's planner refuses every SQL write form on the query route, measured on 3.12.0; the policy does not rest on that staying true.

### 3.3 Why not the vendor clients

The client is Studio's own, over the shared `node:http(s)` transport, and it adds no package.
`@influxdata/influxdb3-client` reads over Arrow Flight, which rounds 64-bit integers and nanosecond times to what JavaScript numbers hold, offers no cancel and no per-connection CA, and opens gRPC sockets outside the HTTP egress guard; `@influxdata/influxdb-client` queries Flux only.
Reading `query_sql` as jsonl keeps every integer exact and every request inside the egress guard, at the cost of exact column types and a server-side cancel, filed as [D197](../BACKLOG.md).

### 3.4 Machine access

MCP is offered (`MCP_EXPOSABLE`): `list_connections` and `inspect_schema` see the session database's tables and columns, as the tree does, and never `_internal` or a `system.*` table.
Neither agent execution nor MCP `run_read_query` runs a statement on this type, because the provider implements no read-only query path for them ([B94](../BACKLOG.md)); plan mode drafts statements in the language section 5.1 names.

## 4. Connection

### 4.1 Configuration fields

| Field | Rule |
|---|---|
| Host | A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443. |
| Port | `8181` by default, the InfluxDB 3 HTTP port |
| Token | Empty only for a server started with --without-auth. On InfluxDB 3 Core every token is an admin token. |
| Database | The one InfluxDB 3 database this connection reads. Empty: the only database the token can list; with more than one, set it here. |
| Send the password without TLS | Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked. |
| Read-only | InfluxDB connections are read-only whether or not this is ticked: Studio sends no write. |

There is no User field: InfluxDB 3 has no user name.
The connection-string box is not offered, because it reads `http://` and `https://` as ClickHouse; paste the address into Host.

### 4.2 Authentication

The token travels as one header, `Authorization: Bearer <token>`, on every request, and never in a URL, a body, an error or a log line.
A Token left empty sends no header, which only a server started with `--without-auth` accepts.
A user name from a seed file or the API is refused when the connection opens:

> InfluxDB 3 has no user name: clear User and put the token in Token.

A token holding a character an HTTP header cannot carry is refused before any request, naming the field and never the value:

> Token holds a character outside printable ASCII, which an HTTP header cannot carry; re-enter it.

A read-only seed with no token is refused when the file loads, because a server started with `--without-auth` keeps no boundary:

> Credential warning: An InfluxDB 3 server started with --without-auth accepts any token or none, so a read-only seed without a token promises a boundary the server does not keep.

### 4.3 Version and the wrong server

On InfluxDB 3 `GET /ping` needs the token and answers the product and version, "InfluxDB 3 Core" and "3.12.0" on the tested server.
InfluxDB 1.x and 2.x answer `/ping` with no body, so the provider then reads `GET /health`, whose `version` names the line, and refuses a 1.x or 2.x server before any `/api/v3` call:

> This server is InfluxDB 2.9.1, which has no SQL endpoint: connect with InfluxDB (InfluxQL).

A server with no SQL route answers the query or listing route with 404:

> This server has no InfluxDB 3 SQL endpoint. InfluxDB Cloud Serverless and Dedicated serve SQL only over Flight, which Studio does not use: connect with InfluxDB (InfluxQL).

A server that answers the SQL route with something other than JSON, such as an HTML page, gets:

> InfluxDB at [endpoint] answered the SQL request with [content type], not JSON, so it is not an InfluxDB 3 SQL endpoint; check Host, Port and the connection type, or connect with InfluxDB (InfluxQL).

A `/ping` answered 403 means a resource token, such as an InfluxDB 3 Enterprise database token: the connection goes on with no version and needs the Database field.
With Database empty it is refused:

> This token cannot read the server's version, which an InfluxDB 3 Enterprise database token cannot; set Database on the connection.

### 4.4 The session database

A connection reads exactly one database, its session database, settled once when it connects.
It is the Database field when that is set; else the only database the token lists through `GET /api/v3/configure/database?format=json`, with `_internal`, `_monitoring` and `_tasks` never counted.
Otherwise the connection is refused, naming up to ten names, then "and N more", when the token lists several:

> This InfluxDB 3 server has more than one database (bench, home), and a connection reads one: set Database on the connection.

> This InfluxDB 3 token can list no database; create one on the server or set Database on the connection.

> This token cannot list the server's databases, which an InfluxDB 3 Enterprise database token cannot; set Database on the connection.

A Database the readable listing does not hold, matched exactly and case-sensitively, is refused when the connection opens; a token that cannot read the listing connects as before, after a bounded `SELECT 1` against the Database it names:

> InfluxDB 3 has no database named [database], or this token cannot see it.

`_internal` holds the server's token table on InfluxDB 3, so it is never a session database:

> Studio does not read the _internal database on this server; on InfluxDB 3 it holds the server's token table.

The tree shows the session database's tables at the top level with no database node, and the monitoring overview names the database (section 7).
A server with several databases needs one connection per database; a session that reads several is [U81](../BACKLOG.md).

### 4.5 A token needs TLS off this machine

A token over no TLS is refused before any socket unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection, because on InfluxDB 3 Core every token is an admin token that reaches server-side code:

> This connection would send its password or token to InfluxDB without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS (docs/providers/influxdb.md has a TLS recipe for each version), connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Inside a container, localhost is the container itself, not the host. Nothing was sent.

With SSL mode `disable` the dialog offers "Send the password without TLS"; ticked, the refusal is lifted for that connection only.
A consent given for one host survives an edit of Host or Port ([D204](../BACKLOG.md)), so untick it when the connection moves.
A server with no token opens anywhere.

### 4.6 TLS

Start the server with a certificate and its key: `influxdb3 serve --tls-cert <cert.pem> --tls-key <key.pem>` with the server's other options.
A self-signed certificate for a test server comes from one line:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem -subj "/CN=<host>" -addext "subjectAltName=DNS:<host>"
```

Then choose SSL mode `verify-ca` and paste `cert.pem` as the CA, which checks the server; or `require`, which encrypts and does not check the certificate, so it sends the admin token to whatever answers.
`verify-system` uses the runtime's roots and `verify-full` also checks the host name; the SSL panel maps one way and is never retried weaker.
The TLS recipes of InfluxDB 1.x and 2.x are in [influxdb.md](./influxdb.md).

### 4.7 SSH tunnel

A tunnel is offered; through it, the plaintext rule judges and the TLS identity is the tunnel's far end, never its local forward.

## 5. Query interface

### 5.1 The statement

The language plan mode writes in, and what the editor runs:

```text
Apache DataFusion SQL as InfluxDB 3 runs it, not InfluxQL and not Flux: one SELECT, WITH, VALUES, SHOW, EXPLAIN or DESCRIBE statement; unquoted names fold to lower case; the time column is "time"; filter time with now() - INTERVAL '1 hour'.
```

It is SQL, not InfluxQL and not Flux; Flux is not run by either InfluxDB type ([D196](../BACKLOG.md)).

### 5.2 The routes

| Request line | URL query keys | JSON body keys |
|---|---|---|
| `GET /ping` | none | none |
| `GET /health` | none | none |
| `POST /api/v3/query_sql` | none | `db` (required), `q` (required), `format` = `jsonl` |
| `GET /api/v3/configure/database` | `format` = `json` | none |

The body of a statement is `JSON.stringify` of exactly `db`, `q` and `format`, with `db` the session database; no other route, key or path can be built.
`/health` is read only for a server whose `/ping` names no version, and `configure/database` only when the connection opens.

### 5.3 The read policy

The first keyword, behind comments and opening parentheses, is one of `SELECT`, `WITH`, `VALUES`, `SHOW`, `EXPLAIN` and `DESCRIBE`.
The text is one statement: a `;` followed only by whitespace and comments still makes one.
The statement holds no word only a writing statement uses (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`, `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `INTO`) outside quotes, no `$` outside quotes and no character outside ASCII outside quotes.
A text is at most 1,048,576 bytes of UTF-8.
Everything the policy refuses is refused before the request, with these sentences:

| Statement | Refusal |
|---|---|
| `SET x TO 1` | Only SELECT, WITH, VALUES, SHOW, EXPLAIN and DESCRIBE run on an InfluxDB 3 connection in Studio: this statement begins with SET. |
| `DROP TABLE home` | This statement holds the word DROP, which only a writing statement uses, and an InfluxDB 3 connection in Studio is read-only; if DROP is a column or table name, write it in double quotes. |
| `WITH x AS (SELECT 1) DELETE FROM home` | This statement holds the word DELETE, which only a writing statement uses, and an InfluxDB 3 connection in Studio is read-only; if DELETE is a column or table name, write it in double quotes. |
| `SELECT * INTO copy FROM home` | This statement holds the word INTO, which only a writing statement uses, and an InfluxDB 3 connection in Studio is read-only; if INTO is a column or table name, write it in double quotes. |
| `SELECT 1; SELECT 2` | InfluxDB 3 runs one SQL statement per request; remove the text after the first `;`. |
| `SELECT 'x` | The statement has a string, a quoted name or a comment that never closes. |
| `SELECT $1` | This statement holds a `$` outside quotes (line 1, column 8): Studio sends no bound parameters and reads no dollar-quoted string on an InfluxDB 3 connection; write the value as a '...' string, and a name holding `$` in double quotes. |
| `SELECT * FROM hömé` | This statement holds a character outside ASCII outside quotes (line 1, column 16); write names that need it in double quotes. |

An empty text, or one of comments only:

> There is no statement to run.

A text over the cap, here one byte over:

> This statement is 1,048,577 bytes; an InfluxDB 3 connection in Studio sends at most 1,048,576.

The engine accepts `$1` and `?` placeholders, but the route body has no parameter key, so a run with bound parameters is refused:

> Studio does not send bound parameters; write the value in the statement.

### 5.4 The DataFusion grammar

The statement splitter, the row limiter, the confirmation gate and the read policy read text under one measured grammar row, `DATAFUSION_GRAMMAR` in `src/lib/sql/grammar.ts`, so they cannot disagree about where a comment or a literal ends.

| Field | Value | Measured on 3.12.0 Core |
|---|---|---|
| `hash` | `"code"` | `SELECT 1 AS x # c` is a parser error, so `#` starts no comment |
| `bracket` | `"subscript"` | `SELECT [1,2][1] AS x` answers 1; brackets build and index arrays and never quote a name |
| `blockComment` | `"nesting"` | `SELECT 1 /* a /* b */ c */ AS x` answers 1 |
| `alternateQuoting` | `false` | `SELECT q'[x]' AS x` is a parser error |
| `doubleSlashComment` | `false` | `SELECT 1 AS x // c` is a parser error |
| `script` | `{"blocks":"none","separatorLine":null,"unit":"statement"}` | the default (#1312): DataFusion has no procedural bodies and no separator line, so every code `;` ends a statement |

A string literal doubles its quote (`'it''s'`) and a backslash in it is data; Studio writes every literal that way and never the `E'...'` form.
A name is double-quoted with `""` doubling, and an unquoted name folds to lower case.

### 5.5 Result shape

The answer is read as jsonl, one JSON object per line.
The columns are the ordered union of the keys the lines name: with `SELECT *` the engine's alphabetical order, an explicit projection's own order, and a key that first appears on a later line appended.
An integer beyond 2^53 reaches the grid as its exact digits, and NaN and the infinities arrive as null.
A timestamp is the engine's text, UTC with nanoseconds and no zone suffix; write `time AT TIME ZONE 'UTC'` in the statement to see a `Z`.
An all-null column and the columns of an empty result cannot be known, because JSON leaves out a null cell and an empty answer has no line; no column type is reported.
A line that is not a JSON object, or one nested deeper than 64 levels, is refused as unreadable:

> InfluxDB 3 answered with a line Studio cannot read as a row.

The answer is read line by line up to the row cut, so a body of many short lines never holds more than the cut's worth of rows.

### 5.6 Bounds

| Bound | Value |
|---|---|
| Statement text | 1,048,576 bytes of UTF-8, counted before the text is read |
| Response | 16 MiB (16,777,216 bytes) per answer; past it the socket is closed and no row is kept |
| Rows | 10,000 rows per result, the backstop under the limiter's own page; the cut is reported as limited |
| Cells | 250,000 cells (rows times columns) per result |
| In flight | 2 calls per connection and 2 per server type in this process, with a queue of 64 |
| Run deadline | the connection's query timeout |
| Tree, connect and monitoring | 10 seconds, or the query timeout when it is shorter |
| Table listing | 2,000 tables; past it the count is a floor |

An answer over the response cap fails with:

> The result is larger than 16 MiB, the most Studio reads for one answer; add a LIMIT or a narrower time range.

The cap and the in-flight bound were measured together in the image runtime under its heap flag and the chart's 512Mi memory limit, with both InfluxDB types kept full at the cap: the process peaked at 230 to 271 MiB at 16 MiB and two calls per type, and above 512 MiB at 32 MiB.
A 16 MiB answer still holds about 290,000 narrow rows, far over the row cut, so the cap refuses only an answer that already needs a narrower statement.

### 5.7 Pagination and Load More

The shared limiter appends `LIMIT` and `OFFSET` to a statement (`supportsResultPagination: true`), so a preview shows its first page and Load More reads the next.
A statement that leads with `(`, or already carries a large `LIMIT`, is not limited by the shared limiter and is bounded by the row cut and the response cap only.
Load More pages over `ORDER BY "time" DESC`, and rows of different series share a timestamp, so a page boundary inside a tie can repeat or skip a row between pages.
Add the tag columns to `ORDER BY` for stable pages, for example `ORDER BY "time" DESC, "room"`.

### 5.8 One database per connection

Every statement runs against the session database; DataFusion cannot name another database in a statement, and one that tries gets a sentence that says so:

> InfluxDB 3 found no table edge.iox.numbers: this connection reads one database, home, and a statement cannot name another database; set Database on the connection to read another.

A describe or preview asked by MCP or plan mode with a path longer than the table alone is refused before any request:

> This InfluxDB 3 connection reads one database, home, whose tables have no database prefix; set Database on the connection to read another.

### 5.9 Previews and Generate Query

A tree click runs the newest rows of the last hour, newest first, with no `LIMIT` in the text: the preview's page size travels as the limiter's bound, appended after `ORDER BY "time" DESC`, so Load More works.
The first comment line says what an empty result means: the table has no row newer than the window, which the line says how to widen.
For the table `home`:

```sql
-- Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.
SELECT * FROM "home" WHERE "time" >= now() - INTERVAL '1 hour' ORDER BY "time" DESC
```

Generate Query writes the same statement with three commented examples below it, naming the table's first integer or float field:

```sql
-- Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.
SELECT * FROM "home" WHERE "time" >= now() - INTERVAL '1 hour' ORDER BY "time" DESC
-- A wider window: WHERE "time" >= now() - INTERVAL '1 day'
-- One row per minute: SELECT date_bin(INTERVAL '1 minute', "time") AS minute, avg("co") FROM "home" WHERE "time" >= now() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 1
-- Timestamps are UTC with no zone suffix; time AT TIME ZONE 'UTC' shows a Z.
```

Every name Studio writes is double-quoted, `time` included, and no generated text ends with `;`.
The window is one hour because InfluxDB 3 Core refuses a query that would read more than its file limit, and a wider window met that limit on the measured file-limit fixture.
Count and Profile are offered and run with no time window, because a windowed count would answer a different question under the same button; past Core's file limit either one gets the file-limit sentence:

> InfluxDB 3 Core refuses a query that would read more than its file limit (432 Parquet files, about 72 hours, by default). Add a time range such as WHERE time >= now() - INTERVAL '1 day', or raise --query-file-limit on the server.

### 5.10 Cancellation and the confirmation gate

Stop aborts the run in Studio and closes its socket; the server frees the query's work within about two seconds, measured on 3.12.0, but receives no cancel request, because the HTTP route has none ([D197](../BACKLOG.md)).
A disconnect stops every request in flight or waiting.
The text is SQL, so the editor's SQL confirmation gate reads it: a typed `DELETE` or `DROP` asks for confirmation, and the provider then refuses it with the read policy's sentence, a documented cost of being SQL.
The Explain button is not offered ([D198](../BACKLOG.md)); a typed `EXPLAIN` returns its plan as rows.

### 5.11 Timestamps and charts

A timestamp through this type carries no zone, and the same row read through InfluxDB (InfluxQL) ends in `Z`, so a timestamp copied from one type into a statement of the other needs its `Z` added or removed.
For the Charts tab, order by `time` ascending and choose `time` as the x axis: the default x axis is the first tag ([U79](../BACKLOG.md)), and "Group by hour" reads a `Z` time in local time ([U80](../BACKLOG.md)).

## 6. Schema introspection

### 6.1 The object surface

There is no container level, as with Qdrant: the session database's tables are the top-level objects, and an object path is one segment, the table.
`configure/database` is read only when the connection opens, for the session database.
Tables come from `information_schema.tables` where `table_schema = 'iox'`, in name order, at most 2,000.
A table's columns come from `system.influxdb_schema`: `time`, then the tags, then the fields, each in the server's order, typed `time`, `tag` or the field's type.
No row count, size, index or foreign key is shown, because the engine cannot state them honestly.

### 6.2 What is never listed

`_internal` is neither listed nor a session database, because it holds `system.tokens`.
No `system.*` table is listed, because the listing reads `table_schema = 'iox'` only.
An admin token can still read two of them by name in a statement: `system.processing_engine_trigger_arguments`, which holds the arguments, secrets included, of the server's processing-engine plugins, and `system.queries`, which holds the text of every query the server ran, other users' included.

### 6.3 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: the type reads only (section 3.1).
The absence is `influxdb3`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` holds that entry and this section together.

## 7. Monitoring & health

Health is `GET /ping`, reachability only, never evidence of what the token may read.
The overview's version names the server and the session database, `InfluxDB 3 Core 3.12.0, database home` on the tested server, because no tree node names the database.
Its table count is the session database's tables; past the listing cap it is a floor, counted from "the first 2,000 tables the session database's table listing returned".
Uptime, size and the connection limit read "N/A" or 0, because no route Studio reads reports them.
Slow queries are not read:

> InfluxDB 3 records queries in a server-wide table that shows other users' statements and marks a streamed query finished early, so Studio does not read it.

Sessions are not read either:

> InfluxDB has no session list: every request stands alone.

Performance, storage, table and index statistics are empty, and `/metrics` is never read ([D200](../BACKLOG.md)).

## 8. Maintenance

None: no Admin > Operations card and no tree control is offered, because InfluxDB 3 compacts its own storage and the connection is read-only.

## 9. Capabilities & labels

| Capability | Value |
|---|---|
| `queryLanguage` | `"sql"` |
| `defaultPort` | `8181` |
| `enforcesReadOnly` | `true` |
| `supportsResultPagination` | `true` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsExplain` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` |
| `supportsTransactions` | `false` |
| `supportsMaintenance` | `false` |
| `supportsConnectionString` | `false` |
| `identifierQuoting` | `"double-always"` |
| `statementTerminator` | `"none"` |
| `READ_ONLY_ENFORCED` | `true` |
| `MCP_EXPOSABLE` | `true` |

`previewTimeWindow` declares the one-hour window of section 5.9, and `containerLevels` is absent.

| Label | Value |
|---|---|
| `entityName` | Table |
| `entityNamePlural` | Tables |
| `rowName` | row |
| `selectAction` | Preview Newest Rows |
| `generateAction` | Generate Query |

`statementLanguage` is the text of section 5.1, which names Apache DataFusion SQL and says it is not InfluxQL or Flux: Apache DataFusion SQL as InfluxDB 3 runs it, not InfluxQL and not Flux: one SELECT, WITH, VALUES, SHOW, EXPLAIN or DESCRIBE statement; unquoted names fold to lower case; the time column is "time"; filter time with now() - INTERVAL '1 hour'.

## 10. Error handling

| Answer | What Studio says |
|---|---|
| 400 `ParserError` | InfluxDB 3 could not parse the SQL statement: [server text] |
| 400 a table of another database | InfluxDB 3 found no table [table]: this connection reads one database, [database], and a statement cannot name another database; set Database on the connection to read another. |
| 400 `Error during planning` | InfluxDB 3 could not plan the statement: [server text] |
| 400 a malformed Authorization header | InfluxDB 3 could not read the Authorization header; re-enter the token. |
| 401 | InfluxDB 3 refused the token. |
| 403 on a read | This token may not read database [database]. |
| 404 `database not found` | InfluxDB 3 has no database named [database], or this token cannot see it. |
| 404 on a route | This server has no InfluxDB 3 SQL endpoint. InfluxDB Cloud Serverless and Dedicated serve SQL only over Flight, which Studio does not use: connect with InfluxDB (InfluxQL). |
| 405 | InfluxDB 3 does not implement this statement: [server text] |
| 500 the file limit | InfluxDB 3 Core refuses a query that would read more than its file limit (432 Parquet files, about 72 hours, by default). Add a time range such as WHERE time >= now() - INTERVAL '1 day', or raise --query-file-limit on the server. |
| 500 `Resources exhausted` | InfluxDB 3 ran out of the memory it allows one query: [server text] |
| 500 with any other text | InfluxDB 3 refused the statement: [server text] |
| The server ended the answer after accepting it | InfluxDB failed while running this query after accepting it, so its reason did not reach Studio; it is in the server log. Common causes: a division by zero, a failed cast. |
| A line that is not a row | InfluxDB 3 answered with a line Studio cannot read as a row. |
| Over the response cap | The result is larger than 16 MiB, the most Studio reads for one answer; add a LIMIT or a narrower time range. |
| The deadline | InfluxDB did not answer within [milliseconds] ms, so Studio stopped waiting and closed the connection, which stops the query on the server. |
| Stop | The query was cancelled. |
| TLS | The TLS connection to InfluxDB at [endpoint] failed: check the SSL mode and the CA under SSL / TLS. [code] |
| Unreachable | No complete answer arrived from InfluxDB at [endpoint], and the request was not sent again. [code] |
| A redirect | InfluxDB at [endpoint] answered with a redirect Studio does not follow. |
| A content encoding | InfluxDB at [endpoint] answered with an encoding Studio does not follow. |
| Anything else | The request to InfluxDB failed in a way Studio does not recognise. |

A 500 with a text body is the statement's refusal, never a server-down error: a schema error answers 500 on 3.12.0, for example `SELECT "nope" FROM "home"` reads "InfluxDB 3 refused the statement: Schema error: No field named nope. ...".
The server's text is shown after Studio's sentence, cut to 500 characters, and a text that holds the token in any form Studio sends is withheld whole.
The token never reaches an error, a result, a log line or a capture.

## 11. Testing

The unit tests in `tests/unit/db/influxdb/` drive each module on its own: `sql-policy.test.ts`, `sql-results.test.ts`, `sql-objects.test.ts` and `sql-provider.test.ts` for this type, and the shared layer's tests beside them.
`tests/integration/db/influxdb3-provider.test.ts` drives the provider over the real client with answers captured from InfluxDB 3 Core 3.12.0 (`tests/fixtures/influxdb/3.12.0-core/`), handed in through the constructor's client factory and a recording transport, with no module mock.
This file's quotes are read back from the code by `tests/unit/db/influxdb/provider-doc-influxdb3.test.ts`.

```bash
bun tests/run-tests.ts tests/integration/db/influxdb3-provider.test.ts
bun run test
```

The captures are written by `bun tests/live/influxdb-evidence.ts` against the compose services of section 12, and only by it: every statement of its plan passes the read policy before the first request, and `docker/influxdb/seed.sh` is the only writer.
[`tests/fixtures/influxdb/README.md`](../../tests/fixtures/influxdb/README.md) says what each capture holds.

## 12. Running InfluxDB 3 for Studio

`database-compose.yml` holds `influxdb3` (127.0.0.1:8181, InfluxDB 3 Core 3.12.0, database `home`, token `apiv3_libredb-influxdb3-admin-token`) and, behind the profile `influxdb-filelimit`, `influxdb3-filelimit` (127.0.0.1:8182, the same server started with `--query-file-limit 1`); [`docker/influxdb/README.md`](../../docker/influxdb/README.md) says how to start and seed them.

```bash
docker compose -p libredb-studio -f database-compose.yml up -d --wait influxdb3
```

On a server of your own, create a database with `influxdb3 create database <name>` and a token with `influxdb3 create token --admin`, and give Studio the token and the database.
Serve over TLS (section 4.6) whenever Studio is not on the same machine.
A seed connection takes the same fields, as [SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md) shows:

```yaml
  - id: "metrics-influx3"
    name: "InfluxDB 3 Metrics"
    type: influxdb3
    host: "${INFLUXDB3_HOST}"
    port: 8181
    database: telegraf
    password: "${INFLUXDB3_TOKEN}"
    ssl:
      mode: verify-full
    roles: ["*"]
    managed: true
    readOnly: true
```

The token goes in `password`, there is no `user`, and `allowInsecureAuth: true` is the seed's form of the consent of section 4.5.

## 13. Known limitations

- On InfluxDB 3 Core every token is an admin token, so read-only is a property of what Studio sends, never of the token: the same token reaches every write, token and plugin route outside Studio.
- SSL mode `require` sends the token to a server whose certificate is not checked.
- Studio reads `query_sql` as jsonl, with no Arrow Flight: column types are what JSON carries, and a stopped query gets no server-side cancel ([D197](../BACKLOG.md)).
- An all-null column and the columns of an empty result cannot be known, and no column type is reported.
- One connection reads one database; a server with several needs one connection each ([U81](../BACKLOG.md)).
- A page boundary inside a tie of `time` can repeat or skip a row; add the tag columns to `ORDER BY` for stable pages.
- Count and Profile read the whole table and meet Core's file limit on a large one.
- An admin token reads plugin secrets and other users' query text from `system.*` tables by name.
- InfluxDB 3 Enterprise is not tested, and Cloud Serverless and Dedicated cannot be reached by this type ([D201](../BACKLOG.md), [D202](../BACKLOG.md)).
- No agent execution and no MCP `run_read_query` ([B94](../BACKLOG.md)).

## 14. References

- The InfluxDB 3 Core HTTP API reference: `/api/v3/query_sql`, `/api/v3/configure/database`, `/ping` and `/health`.
- The InfluxDB 3 Core `serve` options: `--tls-cert`, `--tls-key`, `--without-auth`, `--query-file-limit`.
- Apache DataFusion's SQL reference, the dialect InfluxDB 3 runs.
- [`docker/influxdb/README.md`](../../docker/influxdb/README.md) and [`tests/fixtures/influxdb/README.md`](../../tests/fixtures/influxdb/README.md).
