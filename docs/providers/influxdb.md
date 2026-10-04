# InfluxDB (InfluxQL) Provider

The `influxdb` type-id: read-only time-series browsing and querying in InfluxQL over InfluxDB's v1 `/query` API, on InfluxDB 1.x, 2.x and 3.
Source: [`src/lib/db/providers/timeseries/influxdb/`](../../src/lib/db/providers/timeseries/influxdb/).
Tests: [`tests/unit/db/influxdb/`](../../tests/unit/db/influxdb/) and [`tests/integration/db/influxdb-provider.test.ts`](../../tests/integration/db/influxdb-provider.test.ts).

## 1. Overview

The dialog names this type "InfluxDB (InfluxQL)".
Studio sends one InfluxQL statement per run, a `SELECT`, a `SHOW` or an `EXPLAIN`, as a form POST to `/query`, and shows the answer as a grid.
It browses databases and their measurements, with each measurement's time column, tag keys and field keys.
It writes nothing: no write route exists in its route table, its read policy refuses every statement that is not one read before any request, and no maintenance operation exists.
It runs no Flux, sends a password or token without TLS only to this machine, through an SSH tunnel or with the connection's own consent, and shows MCP clients the schema alone.

### 1.1 Concept mapping

| InfluxDB | Studio |
|---|---|
| A server (any line) | One connection |
| A 1.x or 3.x database | A container of the one level, Database |
| A 2.x bucket | A database, through the bucket's virtual DBRP mapping |
| A retention policy | Not a level: a tree read uses the database's default policy; name another in the statement (section 5.7) |
| A measurement | An object of the one kind, Measurement |
| A tag key | A column of type `tag` |
| A field key | A column typed as `SHOW FIELD KEYS` types it (`float`, `integer`, `unsigned`, `string`, `boolean`) |
| A series | Rows of a result; a `GROUP BY` tag is a leading column of each row |
| A point | A row, with its `time` column |

### 1.2 Tested versions

| Line | Image |
|---|---|
| InfluxDB OSS 1.13.1 | `influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0` |
| InfluxDB OSS 2.9.1, a bucket read as a database through its virtual DBRP mapping | `influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e` |
| InfluxDB 3 Core 3.12.0, through its v1-compatible `/query` | `influxdb:3.12.0-core@sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076` |

Documented as untested, and claimed nowhere until a probe measures one: InfluxDB Enterprise 1.x, InfluxDB Cloud (TSM), InfluxDB Cloud Serverless (which needs an explicit DBRP mapping, section 4.8), InfluxDB Cloud Dedicated and InfluxDB Clustered.

## 2. Architecture

### 2.1 Where it sits

`InfluxDBProvider` extends `BaseDatabaseProvider` in the `timeseries` family.
The directory `src/lib/db/providers/timeseries/influxdb/` serves two type-ids, one per query language: this one, and `influxdb3`, "InfluxDB 3 (SQL)", which reads InfluxDB 3 in Apache DataFusion SQL over `/api/v3/query_sql` and is documented in [influxdb3.md](./influxdb3.md).
The two classes share the connection layer and nothing else: no `influxql-*` module imports an `sql-*` module, nor the reverse.
The factory imports the directory's `index.ts`, which re-exports the two provider classes and nothing else.

### 2.2 Modules

| File | What it owns |
|---|---|
| `connection-options.ts` | The endpoint, the one Authorization header, the plaintext rule and its consent, the TLS material, the database field, the seed stage and the bounds |
| `routes.ts` | The two closed route tables; the only file of the directory that holds a path |
| `client.ts` | The route-table client over the shared `node:http(s)` transport (`src/lib/db/http/node-transport.ts`) |
| `versions.ts` | The version read from the `/ping` and `/health` bodies, and the per-generation table |
| `errors.ts` | Every failure worded as one of the repository's error classes, server text through `serverText` redaction |
| `run-database.ts` | The database a run uses |
| `monitoring.ts`, `labels.ts` | The health and overview mappings, and the labels of both types |
| `influxql-lexer.ts` | InfluxQL read as tokens exactly as the influxql v1.4.1 scanner reads it |
| `influxql-policy.ts` | The read policy, shared by the editor's confirmation gate and the provider |
| `influxql-quote.ts`, `influxql-generators.ts` | Identifier and string quoting, and the preview and Generate Query texts |
| `influxql-results.ts`, `influxql-objects.ts` | A `/query` answer as a result, and the object surface |
| `influxql-provider.ts` | The provider: lifecycle, declarations, the connect sequence and each call's permit, deadline and error context |
| `sql-*.ts` | The `influxdb3` type's modules ([influxdb3.md](./influxdb3.md)) |
| `index.ts` | The composition root the factory imports |

`influxql-lexer.ts`, `influxql-policy.ts`, `influxql-quote.ts` and `influxql-generators.ts` are pure and shipped to the browser, because the editor, the confirmation gate and the tree read them; they import only each other and types.
The editor's InfluxQL language and completion live in `src/lib/editor/influxql-language.ts` and `influxql-completions.ts`, over the same lexer.
Two tests hold the layout: `tests/unit/db/influxdb/seam-guard.test.ts` fails when a file imports from another provider directory, or an `influxql-*` module imports an `sql-*` module or the reverse, and `tests/unit/db/influxdb/browser-modules.test.ts` fails when a browser module imports a Node built-in, `Buffer` or a server module.

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` checks the connection's fields first, then sends `GET /ping`, `GET /health` when `/ping` names no version (section 4.6), and the authenticated read `SHOW DATABASES`, whose listing is kept for the run database's only-visible step (section 4.7).
All three share one deadline (section 5.5).
`disconnect()` closes the connection's keep-alive agent, which drops every request in flight.
The transport never goes through an `http_proxy` or `https_proxy` variable and never follows a redirect: use an SSH tunnel to reach a private endpoint.

## 3. Design decisions

### 3.1 Read-only

An `influxdb` connection is read-only whatever its read-only flag says.
On 1.x and 2.x the v1 `/query` route runs whatever statement a credential may run, `DROP DATABASE` included, so Studio's read policy (section 3.3) is the only boundary between a Studio user and a write unless the credential itself is a READ user or a read token (section 13).
The route table (section 5.2) has no write route, and the provider has no maintenance operation.

### 3.2 No Flux

Studio runs no Flux on any line, and its route table has no `/api/v2/query` and no other `/api/v2/` path.
Flux is a server-side programming language, not a query: measured on 2.9.1, a read-only bucket token made the server issue HTTP GET and POST requests, dial TCP, and read table names out of the server's own SQLite metadata store through `sql.from`, so no read-only Flux policy can be sound.
Flux is in maintenance mode, and InfluxDB 3 does not run it.
Text that is recognisably Flux is refused with its own sentence (section 3.5).

### 3.3 The read policy

`influxql-policy.ts` decides, in the browser and again on the server, whether a text runs; it reads tokens, never text, and it is fail-closed.
The verdict is the same whatever line the server reports.

1. The text is at most 65,536 bytes of UTF-8, counted before it is read.
2. It is read by a lexer that reads exactly as the influxql v1.4.1 scanner does: InfluxDB 1.13.1 pins influxql v1.4.1, and 2.9.1 pins v1.3.0, whose scanner is identical; InfluxDB 3.12.0 parses `/query` with a separate Rust parser, which the differential corpus (section 11) also covers.
   A text that does not lex (a control character, a character outside ASCII outside quotes, a character InfluxQL has no meaning for, a string, quoted name, regex or comment that never closes, a line break inside a string, quoted name or regex, an escape InfluxQL does not have) is refused naming the line and column.
3. A `/` starts a regular expression or divides by where it stands, the scanner's operand rule: after a token that ends an operand it divides, everywhere else it starts a regex, so `SHOW MEASUREMENTS ON "db" WITH MEASUREMENT = /re/` reads as the parser reads it; a `/*` is a comment in every position.
4. Flux is refused before the lexical faults, because Flux text commonly lexes with faults and the Flux sentence is the useful one.
5. A bound parameter (`$name`) is refused: Studio never sends parameters, and a bound one could supply a regex the policy never read.
6. Exactly one statement runs, beginning with `SELECT`, `SHOW` or `EXPLAIN`; an `EXPLAIN` runs only before a `SELECT` or a `SHOW`.
   InfluxDB 3 needs no semicolon between two statements (3.12.0 runs `SHOW DATABASES SHOW DATABASES` as two), so a `SELECT`, `SHOW` or `EXPLAIN` where no statement of this one begins is refused as a second statement, and a word only a writing statement uses (`DELETE`, `DROP`, `CREATE`, `ALTER`, `GRANT`, `REVOKE`, `KILL`, `INSERT`, `SET`) is refused anywhere outside quotes, comments and regular expressions.
7. A bare `INTO` at any depth is refused, because `SELECT ... INTO` writes.
8. Keywords are folded to upper case over ASCII alone, so no locale changes a verdict.

The HTTP method is not a boundary: `/query` runs a write the same over GET and POST, and only the policy stops it.
Each refusal class and its sentence is in section 5.3.

### 3.4 Two connection types, one per query language

InfluxDB 3 answers both InfluxQL (on the v1-compatible `/query`) and SQL (on `/api/v3/query_sql`), with different answers, types and rules, so Studio offers two connection types instead of a language switch on one.
This one speaks InfluxQL to every line; "InfluxDB 3 (SQL)" speaks SQL to InfluxDB 3 alone.
An InfluxDB 3 server can be reached by both, one connection each.

### 3.5 Coming from InfluxDB 2.x and Flux

Flux is out because a Flux script can make the server open network connections and read its own files even with a read-only token (section 3.2):

> This is Flux, which Studio does not run: Flux can make the server open network connections even with a read-only token. Write it in InfluxQL; docs/providers/influxdb.md, section Coming from InfluxDB 2.x and Flux, has a translation table.

On 2.x every bucket is reachable from InfluxQL as a database through its virtual DBRP mapping: the bucket `home` is database `home` with its default retention policy.
A bucket whose name holds a `/` is read as `db/rp`, so the bucket `telegraf/autogen` is database `telegraf` with retention policy `autogen`.

| Flux | InfluxQL |
|---|---|
| `from(bucket: "home")` | `FROM "home".."m"` |
| `range(start: -1h)` | `WHERE time > now() - 1h` |
| `filter(fn: (r) => r.host == "a")` | `WHERE "host" = 'a'` |
| `aggregateWindow(every: 1m, fn: mean)` | `SELECT mean("f") ... GROUP BY time(1m)` |
| `last()` | `SELECT last("f")` |
| `limit(n: 10)` | `LIMIT 10` |

No InfluxQL statement does what `pivot()`, `join()` or `map()` do, and a statement cannot read across buckets.

### 3.6 Machine access

The type is offered to MCP clients for the two metadata tools (`MCP_EXPOSABLE`), which see database, measurement and column names and types only.
Agent execution and MCP `run_read_query` refuse InfluxDB, because the provider implements no `queryReadOnly`; plan mode drafts InfluxQL in the language of `statementLanguage` (section 5.1) and runs nothing.

## 4. Connection

### 4.1 Configuration fields

| Field | What it takes |
|---|---|
| Host | A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443. |
| Port | `8086` by default, the 1.x and 2.x HTTP port; an InfluxDB 3 server answers `/query` on `8181` |
| User | A 1.x user name; empty for a 2.x or 3.x token |
| Password or token | 1.x: the user's password. 2.x and InfluxDB 3: an API token, with User empty. |
| Database | A 1.x database, a 2.x bucket, or an InfluxDB 3 database: the default for a run, not a filter. Empty: the only database the credential can list, or name it in the statement as "db".."measurement". |
| Send the password without TLS | Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked. |

The connection-string box is not offered, because Studio reads `http://` and `https://` there as ClickHouse; a pasted address belongs in the Host box.
The consent box is drawn only while SSL Mode is disable.
The dialog's read-only box says:

> InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.

An empty Host is refused before anything else:

> An InfluxDB connection needs a host.

### 4.2 Authentication

The credential travels as one `Authorization` header, set once per connection, and nowhere else: never in a URL, a query string or a form body.

| User | Password or token | Header sent |
|---|---|---|
| set | set | `Basic base64(user:password)`, a 1.x user (2.x and 3.x read the password as the token) |
| empty | set | `Token <password>`: a token on 2.x and 3.x, read as `user:password` on 1.x |
| empty | empty | none |
| set | empty | refused |

`Bearer` is never sent on this type.
A 1.x server reads `Token <secret>` as `user:password`, so a 1.x password with User empty is refused by the server, and Studio says:

> InfluxDB 1.x reads a password with no user as user:password; fill User with the user name.

The refusals made before any request name the field and never the value:

> A user without a password sends nothing InfluxDB reads; fill Password or token, or clear User.

> User holds a colon, which Basic authentication cannot carry; check the user name.

> The connection's database holds a control character.

A User or Password or token holding a character outside printable ASCII is refused with "User holds a character outside printable ASCII, which an HTTP header cannot carry; re-enter it." or the same sentence naming Password or token.
A password or token is opaque, so the dialog warns about nothing.
A read-only seed connection without a password or token is refused, with this warning:

> Credential warning: An InfluxDB 1.x server with authentication off, its default, and an InfluxDB 3 server started with --without-auth accept any credential or none, so a read-only seed without a password or token promises a boundary the server does not keep.

### 4.3 A password or token needs TLS off this machine

A connection with a password or token, SSL Mode disable and no SSH tunnel, to a host that is not a loopback address or `localhost`, is refused before any socket opens:

> This connection would send its password or token to InfluxDB without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS (docs/providers/influxdb.md has a TLS recipe for each version), connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Inside a container, localhost is the container itself, not the host. Nothing was sent.

Ticking Send the password without TLS lifts the refusal for that connection only.
Inside a container `localhost` is the container, so a Studio container reaching an InfluxDB on its host names the host's address, which is not loopback, and needs TLS, a tunnel or the consent.

### 4.4 TLS recipes

Serve the HTTP API over TLS on each line:

- 1.x, in `influxdb.conf`: `[http]` with `https-enabled = true`, `https-certificate = "/etc/ssl/influxdb.pem"` and `https-private-key = "/etc/ssl/influxdb-key.pem"`.
- 2.x: `influxd --tls-cert=/etc/ssl/influxdb.pem --tls-key=/etc/ssl/influxdb-key.pem`.
- 3.x: `influxdb3 serve --tls-cert /etc/ssl/influxdb.pem --tls-key /etc/ssl/influxdb-key.pem`.

A self-signed certificate for a test server:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout influxdb-key.pem -out influxdb.pem -subj "/CN=<host>" -addext "subjectAltName=DNS:<host>"
```

Pick the SSL mode to match: `verify-ca` with the CA certificate pasted under SSL / TLS for a certificate a CA of yours signed (the self-signed certificate is its own CA), `verify-full` to check the host name as well, and `require` for a self-signed certificate you do not paste.
`require` encrypts the connection but checks no certificate, so it sends the password or token to whatever peer answers.

### 4.5 SSH tunnel

The SSH tunnel panel carries the connection to a server Studio cannot reach directly.
Through a tunnel the plaintext rule reads the tunnel as the transport, sentences name the tunnel's far end, and a certificate is checked against the far end's name.

### 4.6 Server versions

Studio reads the version from bodies, never from a response header: a 3.x server answers `/ping` with a JSON body (`version`, `product_name`), and a 1.x or 2.x server answers it with a 204 and no body, so Studio then reads the `/health` body's `version`, which needs no credential.
The version changes no verdict of the read policy; it decides only whether `_internal` is browsed, how a 401 is worded and what the overview names.

| Line | Version read from | `_internal` |
|---|---|---|
| InfluxDB 1.x | `/health`, `version` `1.13.1` | listed and run |
| InfluxDB 2.x | `/health`, `version` `v2.9.1` | hidden and refused |
| InfluxDB 3 | `/ping`, `version` and `product_name` | hidden and refused: it holds the server's token table |
| InfluxDB | neither body readable: a proxy that strips `/health`, or a 1.x server with `ping-auth-enabled`, whose `/health` answers 401 | hidden and refused, failing closed |

A server whose version Studio cannot read still connects; the authenticated read decides.

### 4.7 The database a run uses

`/query` takes the database a statement reads as the form field `db`.
Studio chooses it per run, in this order:

1. A statement that names `_internal`, in a source at any depth or after `ON`, on a line that hides it, is refused:
   > Studio does not read the _internal database on this server; on InfluxDB 3 it holds the server's token table.
2. One database named in the statement (`"db".."m"`, `"db"."rp"."m"` or `ON "db"`) is sent as `db`; several send none, and the server decides.
   InfluxDB 3 refuses a statement that names more than one:
   > InfluxDB 3 reads one database per InfluxQL statement; name one database in the statement.
3. A statement that reads no database is sent with none.
4. Otherwise the connection's Database field; a field set to `_internal` on a line that hides it is refused with the sentence of step 1.
5. Otherwise the only database the credential lists at connect, `_internal`, `_monitoring` and `_tasks` never counted.
6. Otherwise the run is refused:
   > Choose a database: open the statement from a database in the tree, set Database on the connection, or name it in the statement as "db".."measurement".

Sent with no database: `SHOW DATABASES`, `SHOW USERS`, `SHOW GRANTS FOR`, `SHOW QUERIES`, `SHOW STATS`, `SHOW DIAGNOSTICS`, `SHOW SHARDS`, `SHOW SHARD GROUPS`, `SHOW SUBSCRIPTIONS`, `SHOW CONTINUOUS QUERIES`.

### 4.8 InfluxDB Cloud

The cloud products are untested (section 1.2).
InfluxDB Cloud Serverless answers InfluxQL only for a bucket with an explicit DBRP mapping, so on a host ending in `.cloud2.influxdata.com` or `.influxdb.io` an unknown database adds:

> On InfluxDB Cloud Serverless, InfluxQL needs a DBRP mapping for the bucket first; see docs/providers/influxdb.md.

Create the mapping with `influx v1 dbrp create --bucket-id <bucket-id> --db <database> --rp <policy> --default`.

## 5. Query interface

### 5.1 The request

What runs, as plan mode states it:

```text
InfluxQL: one SELECT, SHOW or EXPLAIN statement, no INTO, no Flux; name a measurement as "db".."measurement".
```

Every run is `POST /query` with no URL query string and an `application/x-www-form-urlencoded` body of exactly `db`, `q`, `chunked=true` and `chunk_size`.
It is a form POST because 3.12.0 refuses a GET whose request target passes 65,534 characters (414), while a 64 KiB form body answers 200 on all three lines, and because the statement then stays out of URL access logs and proxy request-line limits.
`epoch` is never sent, so times arrive as RFC3339 text with nanoseconds.

### 5.2 The routes

| Route | URL query keys | Form keys |
|---|---|---|
| `GET /ping` | none | none |
| `GET /health` | none | none |
| `POST /query` | none | `db` (optional), `q` (required), `chunked=true`, `chunk_size=1000` |

The client builds a request from a row and nothing else, so no other path or key reaches the wire: never `u`, `p`, `params`, `epoch`, `rp`, `pretty`, `async`, `time_format` or `verbose`.

### 5.3 What the policy refuses

The first keyword is one of `SELECT`, `SHOW` and `EXPLAIN`.
Every other text is refused before any request, with one of these sentences.

- A text with no statement, such as `-- nothing here`:
  > There is no statement to run.
- Flux, such as `from(bucket: "home") |> range(start: -1h)`:
  > This is Flux, which Studio does not run: Flux can make the server open network connections even with a read-only token. Write it in InfluxQL; docs/providers/influxdb.md, section Coming from InfluxDB 2.x and Flux, has a translation table.
- A text that does not lex, such as the microsecond unit written `µ` in `SELECT * FROM home WHERE time > now() - 10µs`:
  > The statement holds a character outside ASCII at line 1, column 43, outside quotes, which InfluxQL does not read. Write the microsecond unit as `u`.
- A string that never closes, as in `SELECT * FROM home WHERE room = 'Kitchen`:
  > A string that starts at line 1, column 33 never closes.
- A character InfluxQL has no meaning for, as in `SELECT * FROM {home}`:
  > InfluxQL has no meaning for the character at line 1, column 15 outside quotes.
- A bound parameter, as in `SELECT * FROM home WHERE room = $room`:
  > Studio does not send bound parameters; write the value in the statement.
- A second statement after a `;`, as in `SELECT * FROM home; DROP DATABASE home`:
  > InfluxQL runs one statement at a time here; remove the text after the first `;` (line 1, column 19).
- A second statement with no `;`, which InfluxDB 3 runs, as in `SHOW DATABASES SHOW DATABASES`:
  > InfluxQL runs one statement at a time here; remove the text from line 1, column 16 on, where a second statement begins.
- A statement that is not a read, as in `DROP DATABASE home`:
  > Only SELECT, SHOW and EXPLAIN statements run on an InfluxDB connection in Studio: this one begins with DROP.
- An `EXPLAIN` of anything but a read, as in `EXPLAIN DROP DATABASE home`:
  > EXPLAIN runs here only before SELECT or SHOW: this one is followed by DROP.
- A word only a writing statement uses, as in `SELECT * FROM home DROP`:
  > This statement holds the word DROP, which only a writing statement uses, and an InfluxDB connection in Studio runs reads only; if DROP is a name, write it in double quotes.
- `INTO`, as in `SELECT mean(temp) INTO other..x FROM home`:
  > SELECT ... INTO writes into a measurement, which Studio does not do.
- A text longer than 65,536 bytes of UTF-8, here one of 65,537:
  > This statement is 65,537 bytes; an InfluxDB connection in Studio sends at most 65,536.

The editor's confirmation gate asks the same policy, so the editor refuses what the server would.

### 5.4 Result shape

Every series of the answer is flattened into one grid.
A `GROUP BY` tag is a leading column of each row, a `measurement` column leads only when the result spans more than one measurement, and `time` is RFC3339 text with nanoseconds and `Z`.
An integer past 2^53, an int64 or a uint64, reaches the grid as its exact digits, as a string.
A statement's own error inside a 200 is an error, never an empty result (section 10).
A truncated 200, whose body ends before it completes, is a failure, never zero rows (section 10).
When the answer holds results for more than one statement although the policy read one, Studio shows no row and reports the disagreement between its reader and the server (section 10).
An InfluxQL `LIMIT` acts per series, so a result can hold more rows than its `LIMIT`; the provider's own row cut (section 5.5) bounds the grid and reports itself on `wasLimited`.
When the server cuts a result at its `max-row-limit` it marks it partial, and Studio shows the notice "InfluxDB marked this result partial: the server cut it (max-row-limit)." with the rows.

### 5.5 Bounds

| Bound | Value |
|---|---|
| Statement text | 65,536 bytes of UTF-8, counted before the text is read |
| Response | 16 MiB per answer, past which the socket is closed and the run fails |
| Rows | 10,000 rows per result, reported on `wasLimited` |
| Cells | 250,000 cells (rows times columns) per result |
| Chunk size | `chunk_size=1000` points per document of the chunked answer |
| Listings | 2,000 names per database or measurement listing; a count past it is a floor |
| Statement deadline | the connection's query timeout |
| Tree, connect and monitoring | 10 seconds for each call, every read of the call included, under the query timeout |
| In flight | 2 requests per connection and 2 per type in this process, with a queue of 64 |
| Preview | the newest points of the last `1h`, `LIMIT 50` per series (section 5.9) |

The response cap and the in-flight bound were measured together in a `node:26.10.0-trixie-slim` container under a 512 MiB memory limit and a 384 MiB heap flag: with both types kept full at the cap the worst case peaks at 230 to 271 MiB at 16 MiB (about 280 to 321 MiB with the app's own baseline), and with that baseline passes 512 MiB at 32 MiB.
`chunk_size` 1,000 was measured against the server's default of 10,000 over 1,000,000 points: the server's memory grew 0 to 9 MiB against 12 to 19 MiB, and the largest document was 57 KB against 574 KB.

### 5.6 Time, cancellation and the confirmation gate

A run waits as long as the connection's query timeout, then Studio closes the connection, which stops the query on the server.
Cancel does the same: Studio drops the socket and never sends `KILL QUERY`.
Dropping the socket stops the query on every tested line: 1.x aborts it at once, 3.x frees its CPU within 2 seconds, and on 2.9.1 a query that takes 21.84 seconds when left alone fell from 105 to 122 percent CPU to 1 percent within 250 ms of the drop at 4 seconds.
The confirmation gate asks nothing for an InfluxDB statement: every statement that runs is a read.

### 5.7 Retention policies

A tree read uses the database's default retention policy, through `"db".."m"`.
A measurement written only into another policy reads empty there, until the statement names the policy: `SELECT * FROM "db"."rp"."m"`.
`SHOW RETENTION POLICIES ON "db"` lists them.

### 5.8 Timestamps and charts

Times are UTC, written with `Z`.
The same InfluxDB 3 row reads `...Z` through this type and without a zone through `influxdb3`, so a timestamp copied from one type into a statement of the other needs its `Z` added or removed.
For the Charts tab, order by time ascending and pick `time` as the x axis.
A `GROUP BY` tag result draws one line through every series.
Two Charts defects are filed: the default x axis is the first text column, not `time` (U79), and "Group by hour" reads a `Z` timestamp in local time (U80).

### 5.9 Previews

A tree click on a measurement writes the newest points of the last hour:

```text
-- Newest points of the last hour, LIMIT 50 per series. No row means no point is newer: widen 1h below.
SELECT * FROM "home".."home" WHERE time > now() - 1h ORDER BY time DESC LIMIT 50
```

The first comment line says that `LIMIT` acts per series and what an empty result means: no point is newer than the window.
Widen the window by changing `1h` to `1d`, `30d` or another duration.
Generate Query writes the same read and examples under it, here for the seeded `home` measurement, whose first numeric field by name is `co`:

```text
-- Newest points of the last hour, LIMIT 50 per series. No row means no point is newer: widen 1h below.
SELECT * FROM "home".."home" WHERE time > now() - 1h ORDER BY time DESC LIMIT 50
-- A wider window: WHERE time > now() - 1d
-- One point per minute: SELECT mean("co") FROM "home".."home" WHERE time > now() - 1h GROUP BY time(1m)
-- Another retention policy: SELECT * FROM "home"."<rp>"."home" (SHOW RETENTION POLICIES ON "home" lists them)
-- Tag values: SHOW TAG VALUES ON "home" FROM "home" WITH KEY = "room" (on InfluxDB 3 add WHERE time > 0)
-- For the Charts tab: ORDER BY time ASC, and choose time as the x axis.
```

Every name goes through the quoter, so a hostile measurement name such as `we"ird name;x` gives a text that passes the policy as one read.
InfluxDB 3.12.0 answers `SHOW TAG VALUES` over a default time window, so a tag of older data lists nothing until `WHERE time > 0` is added; 1.13.1 has no such window.

### 5.10 Examples

```sql
SHOW DATABASES
SHOW MEASUREMENTS ON "home"
SHOW FIELD KEYS ON "home" FROM "home"
SELECT mean("temp") FROM "home".."home" WHERE time > now() - 1d GROUP BY time(1h), "room"
SELECT last("hum") FROM "home".."home" GROUP BY "room"
EXPLAIN SELECT count("co") FROM "home".."home"
```

## 6. Schema introspection

### 6.1 The object surface

One container level, Database (`containerPathShapes: "exact"`), from `SHOW DATABASES`.
One object kind, Measurement, from `SHOW MEASUREMENTS ON "db"`, which is not time-windowed on 3.x either (measured: old-only data is listed).
A measurement's columns are `time`, then its tag keys (`SHOW TAG KEYS ON "db" FROM "m"`), then its field keys with their types (`SHOW FIELD KEYS ON "db" FROM "m"`), each in server order.
No row count, size, index or foreign key is read, because no route reports one Studio can state honestly.
Every catalog text passes the read policy before it is sent, as a user's text does.
A container path is one database:

> An InfluxDB container path is [database], received ["home","autogen"]

### 6.2 `_internal` and the system databases

`_internal` is listed and runnable on 1.x, where it holds the server's monitoring data, and hidden from the tree and refused as a run target on InfluxDB 2.x, on InfluxDB 3 and whenever the line is unknown (section 4.6).
On 2.x the system buckets `_monitoring` and `_tasks` are listed when the credential lists them.
None of `_internal`, `_monitoring` and `_tasks` counts as the only visible database (section 4.7).

### 6.3 Object edit (#789): nothing to write

No kind accepts row writes or source edits: an `influxdb` connection is read-only (section 3.1).

## 7. Monitoring & health

Health is `GET /ping`, reachability only, never evidence of what the credential may read.
The overview gives the server's version and `tableCount`, the measurements across the databases visible at connect; the count is a floor, and says so, only when a listing cap cut one.
A database whose listing the server refuses counts none.
Slow queries are not read:

> InfluxDB keeps no query log Studio reads; 1.x SHOW QUERIES shows other users' statements and is not read.

Sessions are not read either:

> InfluxDB has no session list: every request stands alone.

Performance, storage, table and index statistics are empty: no route Studio reads reports them, and `/metrics` is never read.

## 8. Maintenance

None: InfluxDB compacts its own storage and keeps no statistics to update.

> InfluxDB has no maintenance operation in Studio, and the connection is read-only, so nothing was sent.

## 9. Capabilities & labels

| Capability | Value |
|---|---|
| `queryLanguage` | `"influxql"` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` |
| `supportsResultPagination` | `false` |
| `supportsTransactions` | `false` |
| `declaresForeignKeys` | `false` |
| `tablesAreDerivedGroupings` | `false` |
| `enforcesReadOnly` | `true` |
| `supportsMaintenance` | `false` |
| `maintenanceOperations` | `[]` |
| `supportsConnectionString` | `false` |
| `defaultPort` | `8086` |
| `statementTerminator` | `"none"` |
| `containerLevels` | one level, Database (`schema`) |
| `containerPathShapes` | `"exact"` |
| `objectKinds` | one kind, Measurement (`measurement`), with columns, no source, no row writes |
| `schemaRefreshPattern` | `"(?!)"` |

`supportsExternalQueryLimiting` is false because an InfluxQL `LIMIT` acts per series, so a `LIMIT` the shared limiter added would not bound a result, and `supportsResultPagination` is false because no offset is applied: the text carries its own bounds.

| Record | Value |
|---|---|
| `READ_ONLY_ENFORCED.influxdb` | `true` |
| `MCP_EXPOSABLE.influxdb` | `true` |

| Label | Text |
|---|---|
| `entityName` | Measurement |
| `entityNamePlural` | Measurements |
| `rowName` | point |
| `rowNamePlural` | points |
| `selectAction` | Preview Newest Points |
| `generateAction` | Generate Query |
| `searchPlaceholder` | Search measurements... |
| `statementLanguage` | InfluxQL: one SELECT, SHOW or EXPLAIN statement, no INTO, no Flux; name a measurement as "db".."measurement". |
| `slowQueriesEmptyState` | InfluxDB keeps no query log Studio reads; 1.x SHOW QUERIES shows other users' statements and is not read. |
| `sessionsEmptyState` | InfluxDB has no session list: every request stands alone. |
| `analyzeAction` | Measurement Statistics |
| `vacuumAction` | Compact Storage |
| `analyzeGlobalLabel` | Statistics |
| `analyzeGlobalTitle` | Not available |
| `analyzeGlobalDesc` | InfluxDB keeps no planner statistics to update, and Studio reads no row count or size it cannot state honestly. Nothing runs from here. |
| `vacuumGlobalLabel` | Compact |
| `vacuumGlobalTitle` | Compaction Is the Server's Own |
| `vacuumGlobalDesc` | InfluxDB compacts its storage on its own schedule, and a connection in Studio is read-only. Nothing runs from here. |

## 10. Error handling

A server's error body is read the way its line sends it: 1.x `{"error": ...}`, 2.x `{"code", "message"}`, 3.x `{"error": ...}` or plain text.
Its words reach a sentence only through `serverText`, cut to 500 characters, so a text that holds any form of the password, the token or `user:password` is withheld whole.
In the table, [text] is the server's words and [endpoint] is the host and port as configured.

| Answer | What Studio says |
|---|---|
| 401, a user and password | InfluxDB refused the user and password. |
| 401 on 1.x, a password with no user | InfluxDB 1.x reads a password with no user as user:password; fill User with the user name. |
| 401 on 2.x | InfluxDB 2.x refused the token: put an API token in Password or token with User empty. |
| 401 on 3.x | InfluxDB 3 refused the token. |
| 403 at connect on `SHOW DATABASES` | This user may not run SHOW DATABASES; check its grants. |
| 403 on 1.x, `requires READ` | This user cannot read database [database], or it does not exist. |
| 403 on 1.x, another statement | This user may not run this statement: [text] |
| 400 parse error on 1.x or 2.x | InfluxDB could not parse the statement: [text] |
| 404 on `/query` | This server has no InfluxDB /query endpoint at [endpoint]. |
| 404 on `/ping` | This server does not answer InfluxDB's /ping at [endpoint]; check Host and Port. |
| `database not found` in a 200 | InfluxDB has no database named in this run, or this credential cannot see it: [text]; on a cloud host followed by "On InfluxDB Cloud Serverless, InfluxQL needs a DBRP mapping for the bucket first; see docs/providers/influxdb.md." |
| no database in a 200 | the choose-a-database sentence of section 4.7 |
| several databases in one statement on 3.x | InfluxDB 3 reads one database per InfluxQL statement; name one database in the statement. |
| `insufficient permissions` on 2.x | This token may not run this statement on that bucket: [text] |
| an infinity on 1.x or 3.x | InfluxDB could not encode a value of this result (an infinity), so it sent no rows; filter that value out. |
| `KILL QUERY` by an administrator | The query was stopped on the server (an administrator ran KILL QUERY). |
| the 3.x Core file limit | InfluxDB 3 Core refuses a query that would read more than its file limit (432 Parquet files, about 72 hours, by default). Add a time range such as WHERE time >= now() - INTERVAL '1 day', or raise --query-file-limit on the server. |
| an InfluxQL feature 3.x lacks | InfluxDB 3 does not implement this InfluxQL feature: [text] |
| a parse error in a 200 on 3.x | InfluxQL could not parse the statement: [text] |
| any other statement error | InfluxDB refused the statement: [text] |
| a 200 that is not JSON | InfluxDB answered with text Studio cannot read as a result. |
| results for more than one statement | InfluxDB returned results for more than one statement, although Studio read the text as one statement. Nothing was shown; please report this, it means Studio's InfluxQL reader and the server disagree. |
| a partial result (a notice, with the rows) | InfluxDB marked this result partial: the server cut it (max-row-limit). |
| the answer ended after the server accepted the query | InfluxDB failed while running this query after accepting it, so its reason did not reach Studio; it is in the server log. Common causes: a division by zero, a failed cast. |
| an answer over the cap | The result is larger than 16 MiB, the most Studio reads for one answer; add a LIMIT or a narrower time range. |
| the deadline | InfluxDB did not answer within [ms] ms, so Studio stopped waiting and closed the connection, which stops the query on the server. |
| cancel | The query was cancelled. |
| TLS | The TLS connection to InfluxDB at [endpoint] failed: check the SSL mode and the CA under SSL / TLS. [code] |
| unreachable | No complete answer arrived from InfluxDB at [endpoint], and the request was not sent again. [code] |
| a redirect | InfluxDB at [endpoint] answered with a redirect Studio does not follow. |
| an encoding | InfluxDB at [endpoint] answered with an encoding Studio does not follow. |
| any other status | InfluxDB answered HTTP [status]: [text] |
| anything else | The request to InfluxDB failed in a way Studio does not recognise. |

A truncated answer is a failure, never zero rows and never "unreachable": a 200 whose body ends before it completes, at zero bytes or mid-line, by FIN or RST, gets the truncation sentence.
Neither the password nor the token reaches an error, a result, a log line or a notice.

## 11. Testing

### 11.1 How the tests work

The unit tests under `tests/unit/db/influxdb/` drive each module on its own: the lexer against the scanner's rules, the policy over every refusal class and a Turkish default locale, the route tables, the client over a recording transport and over a local `node:http` server that records the exact request line, headers and body.
The integration test, `tests/integration/db/influxdb-provider.test.ts`, runs the real client, connect sequence, object surface, query pipeline, results shaping and error table over answers captured from the three tested lines (`tests/fixtures/influxdb/`), handed to the provider through its client factory as an injected recording transport; no `mock.module()` is used.
The differential corpus (`tests/fixtures/influxdb/<version>/differential/`), captured on all three lines, holds texts on which a naive reader and the scanner disagree, each followed by a constant hidden statement: `tests/unit/db/influxdb/influxql-differential.test.ts` shows that each line would have run the hidden statement, and that the policy refuses every such text.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/integration/db/influxdb-provider.test.ts
bun tests/run-tests.ts tests/unit/db/influxdb/provider-doc-influxdb.test.ts
bun run test
```

`provider-doc-influxdb.test.ts` reads every label, hint, sentence, route, bound, capability, generated text, tested image and seed field this document states back from the code.

### 11.3 The live evidence

`bun tests/live/influxdb-evidence.ts` runs by hand against the compose services of section 12 and rewrites the captures.
Its plan, `tests/live/influxdb-evidence-plan.ts`, is pure, and `tests/unit/live/influxdb-evidence-plan.test.ts` holds what it may send: every corpus entry ends in the constant hidden statement `SHOW DATABASES` and runs as the read principal where the line has one, every other text passes the read policy, every `INTO` shape names a database that exists on no line, and no entry names a write or admin route.
The harness refuses to write a capture that holds a form of a secret.
`docker/influxdb/seed.sh` is the only thing that writes to the servers; the harness never imports or runs it.

## 12. Running InfluxDB for Studio

`database-compose.yml` holds `influxdb1` (127.0.0.1:8087, InfluxDB 1.13.1), `influxdb2` (127.0.0.1:8086, 2.9.1), `influxdb3` (127.0.0.1:8181, 3.12.0 Core), the one-shot `influxdb-seed`, and behind the `influxdb-filelimit` profile `influxdb3-filelimit` (127.0.0.1:8182); [`docker/influxdb/README.md`](../../docker/influxdb/README.md) says how to start, seed and reach them, and which principals exist.

```bash
docker compose -p libredb-studio -f database-compose.yml up -d --wait influxdb1 influxdb2 influxdb3
docker compose -p libredb-studio -f database-compose.yml up -d influxdb-seed
```

Give a shared connection a principal the server itself keeps read-only.
On 1.x, a user granted READ on the database, created by an admin:

```sql
CREATE USER "reader" WITH PASSWORD '<password>'
GRANT READ ON "home" TO "reader"
```

On 2.x, a token that reads one bucket, with User left empty in Studio:

```bash
influx auth create --org <org> --read-bucket <bucket-id> --description "Studio read-only"
```

As a seed connection ([`docs/SEED_CONNECTIONS.md`](../SEED_CONNECTIONS.md)):

```yaml
id: "metrics-influx"
name: "InfluxDB Metrics"
type: influxdb
host: "${INFLUX_HOST}"
port: 8086
database: telegraf
user: "reader"
password: "${INFLUX_READER_PASSWORD}"
ssl:
  mode: verify-full
roles: ["*"]
managed: true
readOnly: true
```

## 13. Known limitations

- The server keeps a read-only boundary of its own on 1.x and 2.x only with a READ user or a read bucket token, recommended for every shared connection; with an admin credential Studio's read policy is the only boundary.
- On InfluxDB 3 Core every token is an admin token, so read-only is a property of what Studio sends, never of the token.
- A server whose version Studio cannot read (a proxy that strips `/health`, a 1.x server with `ping-auth-enabled`) is treated as generation unknown, which hides `_internal`.
- Enterprise 1.x, Cloud (TSM), Cloud Serverless, Cloud Dedicated and Clustered are untested (D202), and Enterprise resource tokens are handled from documentation alone (D201).
- No Flux console (D196).
- No retention-policy level in the tree (D199).
- No running-queries panel, and the overview is all monitoring shows (D200).
- No EXPLAIN strategy: `EXPLAIN` runs as a statement and its plan is rows (D198).
- The fail-closed lexer refuses some valid reads: the `µ` duration (write `u`), `{` or `[` anywhere outside quotes, and any `$param`.
- The plaintext consent survives a Host or Port change in the dialog (D204).
- No agent execution and no MCP `run_read_query` (B94).
- The Charts tab defects of section 5.8 (U79, U80).

## 14. References

- The influxql scanner and parser at v1.4.1, the version InfluxDB 1.13.1 pins: [`scanner.go`](https://github.com/influxdata/influxql/blob/v1.4.1/scanner.go) and [`parser.go`](https://github.com/influxdata/influxql/blob/v1.4.1/parser.go); and at v1.3.0, the version 2.9.1 pins: [`scanner.go`](https://github.com/influxdata/influxql/blob/v1.3.0/scanner.go).
- The InfluxDB 1.x HTTP API (`/query`, `/ping`, `/health`): [docs.influxdata.com/influxdb/v1/api](https://docs.influxdata.com/influxdb/v1/api/).
- The InfluxDB 2.x v1 compatibility API and DBRP mappings: [docs.influxdata.com/influxdb/v2/api-guide/influxdb-1x](https://docs.influxdata.com/influxdb/v2/api-guide/influxdb-1x/) and [docs.influxdata.com/influxdb/v2/query-data/influxql/dbrp](https://docs.influxdata.com/influxdb/v2/query-data/influxql/dbrp/).
- The InfluxDB 3 Core HTTP API, its v1-compatible `/query` included: [docs.influxdata.com/influxdb3/core/api](https://docs.influxdata.com/influxdb3/core/api/).
- [`docker/influxdb/README.md`](../../docker/influxdb/README.md) and [`tests/fixtures/influxdb/README.md`](../../tests/fixtures/influxdb/README.md).
- The companion type: [influxdb3.md](./influxdb3.md).
