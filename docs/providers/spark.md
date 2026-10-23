# Apache Spark Provider

Apache, Apache Spark and Spark are either registered trademarks or trademarks of The Apache Software Foundation in the United States and/or other countries.
LibreDB Studio has no affiliation with and is not endorsed by The Apache Software Foundation.

> Apache Spark support for LibreDB Studio: Spark SQL over Spark Connect to a self-hosted Spark 4.1 or later, tested on 4.1.3 and 4.2.0.
> Studio speaks Spark Connect's gRPC protocol through its shared gRPC transport and reads results as Arrow batches, with no Spark client library.
> This document is the reference for the Apache Spark provider: connecting, the recommended Spark-side setup, sessions, how a statement runs, results, the tree, features, the confirmation gate, security, errors, the embedded package and the evidence.

|                        |                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **Status**             | Implemented                                                                                      |
| **Database type id**   | `spark`                                                                                          |
| **Family**             | SQL (`src/lib/db/providers/sql/spark/`)                                                          |
| **Driver**             | `@grpc/grpc-js` through the shared gRPC transport, with no Spark client library; `apache-arrow` 21.2.0 decodes result batches |
| **Query language**     | `sql` (Spark SQL)                                                                                |
| **Default port**       | 15002                                                                                            |
| **Connection string**  | Not stored: a pasted `sc://` address is decomposed into fields                                   |
| **EXPLAIN**            | `spark-text`: `EXPLAIN FORMATTED`, which plans the statement and runs nothing                    |
| **Writes**             | Whatever the server allows; the confirmation gate asks before Spark's replacing and code-loading forms |
| **Transactions**       | None                                                                                             |
| **Maintenance**        | None                                                                                             |
| **Query parameters**   | Not supported: Studio sends no bound parameters                                                  |
| **Query cancellation** | Supported: Studio sends Interrupt by the run's tag                                               |

## 1. What it is

The provider reaches a Spark Connect server only: gRPC with Arrow results, on port 15002 unless the server was started on another port.
It needs Spark 4.1 or later, the first release that splits large results into chunks Studio can read, and it was tested on Spark 4.1.3 and 4.2.0.
`connect()` reads the server's version with one AnalyzePlan call before anything else, and a server below 4.1.0 is refused with `This server runs Spark <version>. Studio connects to Spark 4.1 and later, the first release that splits large results into chunks Studio can read.`
A pre-release of exactly 4.1.0 (`-preview<n>`, `-rc<n>`, `-SNAPSHOT`) reads as below the floor.
A probe refused at the version check that the server cannot release, on a server without ReleaseSession, is remembered by the connection's id and its configured endpoint, the far end under an SSH tunnel, at most 256 such entries per process.
The next connect of that connection reads the version on the remembered session, so repeated refusals hold one server session, not one per attempt.
`createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)) builds the provider for the type id `spark`.

| Spark | Studio |
| --- | --- |
| Spark Connect server | The connection (Host and Port) |
| Catalog | Container, level 0, labelled "Catalog" |
| Namespace | Container, level 1, labelled "Namespace", in Spark's own spelling |
| Table, view, function | Object kinds ([section 7](#7-the-tree)) |
| Spark session | One per Studio request, released at its end, and one for the tree and the panels while the connection is open ([section 4](#4-sessions-and-scripts)) |

| File | Role |
| --- | --- |
| `src/lib/db/providers/sql/spark/index.ts` | The provider: capabilities, object kinds, lifecycle |
| `src/lib/db/providers/sql/spark/connection-options.ts`, `namespace.ts`, `sc-uri.ts` | The field checks, name spelling and the paste |
| `src/lib/db/providers/sql/spark/grpc-client.ts`, `requests.ts` | The allowlisted RPCs and the request builders |
| `src/lib/db/providers/sql/spark/session.ts`, `heartbeat.ts` | Sessions and the heartbeat |
| `src/lib/db/providers/sql/spark/execute.ts`, `result-stream.ts`, `statement-shape.ts` | Runs, budgets and the refusals before any call |
| `src/lib/db/providers/sql/spark/ipc-guard.ts`, `arrow.ts`, `schema.ts`, `values.ts`, `temporal.ts`, `variant.ts`, `wkb.ts` | The result reader and the value mapping |
| `src/lib/db/providers/sql/spark/introspect.ts`, `monitoring.ts` | The tree and the monitoring panels |
| `src/lib/db/providers/sql/spark/errors.ts`, `status-details.ts`, `version.ts` | The error table and the version floor |
| `src/lib/explain/spark-text.ts` | The EXPLAIN strategy |

### 1.1 What this provider is not

- The Spark Thrift Server and HiveServer2 are not this provider: that transport collects results on the driver and loses types, and it would need a shared module of its own.
- Kyuubi and the Livy Thrift Server speak the same HiveServer2 protocol and are not this provider either.
- Livy's REST API is not this provider: it rounds DECIMAL and truncates TIMESTAMP on the server and returns at most 1000 rows.
- Databricks is not this provider: it would be a type id of its own, and a pasted Databricks Connect address is refused ([section 2.5](#25-paste-url)).
- Managed endpoints (EMR, Dataproc, CDE, Databricks Connect) are not supported: each needs a vendor token or header hook.
- Spark 3.5 and 4.0 servers are refused at connect with their version named: they have no result chunking under a 16 MiB message cap, and 3.5 has no ReleaseSession.

## 2. Connecting

### 2.1 Fields

The dialog draws these fields in this order, and Paste URL beside them.

| Label | Field | Default | Hint | Refusal |
| --- | --- | --- | --- | --- |
| Host | `host` | none, required | `The host of the Spark Connect server, or of a TLS proxy in front of it. Spark Connect listens on 15002 unless the server was started on another port. Paste an sc:// address with Paste URL.` | `Host is required: the name or address of the Spark Connect server, or of the TLS proxy in front of it. Nothing was sent.` |
| Port | `port` | 15002 | none | the shared port validator's sentence |
| Token | `password` | empty: no token | `The server's spark.connect.authenticate.token (Spark 4.0 and later), sent on every call. Leave it empty for a server without a token. Studio sends a token only over TLS or an SSH tunnel, unless the host is this machine.` | `Token takes printable ASCII with no space at either end: a gRPC header cannot carry other characters, and Spark compares the token exactly. Nothing was sent.` |
| Catalog | `database` | empty: the server's default catalog, `spark_catalog` unless `spark.sql.defaultCatalog` says otherwise | `The catalog unqualified names resolve in, and the one the tree opens first. Empty: the server's default catalog.` | `Catalog takes one catalog name without dots, as spark.sql.catalog.<name> names it. Nothing was sent.` |
| Namespace | `schema` | empty: the catalog's current namespace | `The namespace in that catalog, written as in Spark SQL: parts joined by dots, a part with other characters in backticks. Empty: the catalog's current namespace.` | `Namespace takes a Spark SQL namespace: parts joined by dots, each a letter or _ followed by letters, digits or _, or written in backticks with a backtick doubled; at most 8 parts. Nothing was sent.` |

Every refusal is raised before any socket opens, and none repeats the value it refuses.
A Catalog that is not blank is trimmed before it is checked, because Spark looks the name up literally in `SET CATALOG`; Host and Namespace are checked and used as written.

There is no User field: every Studio request uses one fixed Spark Connect identity ([section 10](#10-security)), and Token is the credential.
A seed or an API call that sets `user` is refused with `Apache Spark connections take no user: every Studio request uses one fixed Spark Connect user id, and Token is the credential. Clear User. Nothing was sent.`

There is no Read-only toggle: Spark has no engine-side read-only mode, so a `readOnly: true` connection is refused before anything is dialled ([section 10](#10-security)).

The SSH tunnel and the SSL / TLS panel are both offered.
An enabled tunnel that did not open is refused with `This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Apache Spark was not dialled directly: the tunnel opens only when both Host and Port are set.`
The query timeout defaults to 60,000 ms, and a value outside its range is refused with `Query timeout must be a whole number between 1 and 2147483647 milliseconds.`

### 2.2 Token and TLS

The token takes printable ASCII with no space at either end, inner spaces allowed, because a gRPC header cannot carry other characters and Spark compares the token exactly.
It is sent as `authorization: Bearer <token>` on every call, and no such header is sent without a token.
The token travels only over TLS, through an SSH tunnel, or to a loopback host: a token to any other host without TLS is refused before any socket, with no opt-out, as Spark's own clients refuse it.

Spark Connect has no TLS of its own, so a remote server is reached through a TLS proxy in front of it or through the SSH tunnel.
The measured proxy is nginx with HTTP/2 and `grpc_pass` to the Spark Connect port ([section 3](#3-the-recommended-spark-setup)).
The SSL modes are read by the shared gRPC transport as for every gRPC provider:

| SSL mode | What Studio checks |
| --- | --- |
| disable | Plaintext gRPC; a token goes only to a loopback host or through the tunnel |
| require | Encrypts without verifying the certificate |
| verify-system | Verifies the certificate against the system trust store, or a pasted CA, and checks that it names Host; the mode the paste sets for TLS |
| verify-ca | Verifies the certificate against the pasted CA and checks that it names Host, as verify-full does |
| verify-full | Verifies the certificate against the pasted CA, or the system trust store, and checks that it names Host |

verify-ca is not "CA only": the shared transport checks the certificate's name in verify-ca as in verify-full, as the TLS table of [`etcd.md`](etcd.md) says.
With a tunnel, the tunnel's far end is the host the TLS identity and the plaintext rule read.

### 2.3 A server without a token

A default Spark 4.x server has no token, and Studio connects to it, with this caution from `connectWarnings()` after every connect that sent no token:

`This connection sends no token, and the server ran its calls: any client that reaches <host>:<port> can run statements on this Spark server. Set spark.connect.authenticate.token on the server and in Token.`

A server without a token ignores a token it is sent, so Test connection also sends one call without the configured token, and when the server answers it, shows:

`This connection sends a token, but the server also ran a call sent without one: it does not check tokens, so any client that reaches <host>:<port> can run statements on this Spark server. Set spark.connect.authenticate.token on the server.`

### 2.4 Test connection

Test connection runs the field checks, opens the channel, reads the version on a probe session, sets up the metadata session and reads the current catalog and namespace.
What a user sees for each outcome:

| Outcome | Class | Sentence |
| --- | --- | --- |
| Nothing listening | `ConnectionError` | `No Spark Connect server answered at <host>:<port>. Start it with sbin/start-connect-server.sh, or check Host and Port (15002 by default).` |
| TLS chosen, the server speaks plaintext gRPC | `ConnectionError` | `TLS was chosen, but <host>:<port> answered without TLS. Spark Connect has no TLS of its own: point Host at a TLS proxy in front of it, or set SSL mode to disable and use an SSH tunnel.` |
| Plaintext to a TLS port, or a port that is not gRPC | `ConnectionError` | `<host>:<port> did not answer as a plaintext gRPC server: it expects TLS (choose an SSL mode under SSL / TLS), or it is not the Spark Connect port (15002 by default).` |
| Certificate not trusted | `ConnectionError` | `The server's certificate is not signed by a CA Studio trusts. Paste the CA of the TLS proxy under SSL / TLS (verify-ca or verify-full).` |
| Certificate does not name the host | `ConnectionError` | `The server's certificate does not name <host>. Set Host to a name or address the certificate lists.` |
| Certificate expired or not yet valid | `ConnectionError` | `The server's certificate has expired or is not yet valid. Renew the TLS proxy's certificate, or check this machine's clock.` |
| Client certificate required | `ConnectionError` | `The TLS proxy asked for a client certificate and did not get one it accepts. Add the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).` |
| Client certificate refused | `ConnectionError` | `The TLS proxy refused the client certificate under SSL / TLS: it must be issued by a CA the proxy trusts for clients.` |
| No token on a token server | `AuthenticationError` | `This Spark Connect server requires a token. Set Token to the server's spark.connect.authenticate.token.` |
| Wrong token | `AuthenticationError` | `Spark refused the token. Set Token to the server's spark.connect.authenticate.token.` |
| Server older than 4.1 | `ConnectionError` | the version sentence of [section 1](#1-what-it-is) |
| Version text not readable | `ConnectionError` | `Studio could not read this server's Spark version (<text>).` |
| Not a Spark Connect endpoint | `ConnectionError` | `The gRPC server at <host>:<port> does not answer Spark Connect's AnalyzePlan, so it is not a Spark Connect server.` |
| Connected without a token | caution | the first caution of [section 2.3](#23-a-server-without-a-token) |
| A token the server does not check | caution, Test connection only | the second caution of [section 2.3](#23-a-server-without-a-token) |

The version in a sentence is the server's text, withheld whole when it holds the token and otherwise cut to 64 characters.
The two client-certificate rows are read under Node; under Bun the same failures read as nothing listening ([section 10](#10-security)).
The row of a port that is not gRPC needs that port's answer: a TLS server that closes on plaintext bytes, and under Node on Windows a port that answers HTTP/1.1, read as nothing listening.

### 2.5 Paste URL

The paste box reads Spark's documented address form, `sc://host[:port][/][;key=value]*`, into fields; nothing is stored as a connection string.

| Part | What the paste does |
| --- | --- |
| `host` | Host; a bracketed IPv6 literal keeps its brackets |
| `:port` | Port; absent means 15002 |
| `token=` | Token, percent-decoded as Spark's 4.2.0 Python and Scala clients read it, so a `%` inside the token is written `%25`; an empty value fills no Token |
| `use_ssl=true`, in any case | SSL mode `verify-system`, TLS with the system trust store, on any host |
| `use_ssl=false`, in any case | SSL mode `disable` only when the host is literally `localhost` or no token is set; beside a token to any other host TLS stays on |
| `token=` with no `use_ssl` | SSL mode `verify-system` unless the host is literally `localhost`; no token and no `use_ssl` is SSL mode `disable` |
| `user_id`, `user_agent`, `session_id`, `grpc_max_message_size` | Not applied, and named in the notice: Studio sends a fixed identity, opens a session per request and sets its own receive cap |
| any other parameter | Not applied and counted in the notice, never named, since its value may be a secret |

TLS follows Spark's 4.2.0 Python and Scala clients: it is on when `use_ssl` is true in any case, or when a token is set and the host is not `localhost`, so `use_ssl=false` turns TLS off only on `localhost` or without a token.
A `use_ssl` whose value is neither true nor false is not applied and is named in the notice.

The paste refuses, filling nothing, with one of these sentences:

- `A Spark Connect address has no path: remove everything between the host and the first ;.`
- `Host takes no user name or password inside the address: put the token in Token.`
- `This is a Databricks Connect address. Studio's Apache Spark connection reaches open-source Spark Connect servers; Databricks is not supported in this version.`
- `Paste the sc:// address itself, without jdbc:.`
- `A Spark Connect address starts with sc://.`
- `The address names no valid host: expected a host name, an IPv4 address or an IPv6 address in brackets.`
- `The address names no valid port: expected an integer from 1 to 65535.`
- `The token in the address is not valid percent-encoding: write a % sign inside the token as %25.`

A refused address that holds a token parameter or a user part clears the paste box, and a Databricks address always does, because the text may hold a secret; any other refused text stays in the box to be corrected.

### 2.6 Seeding

An Apache Spark connection is seeded with fields only ([SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)); keep the token out of the file:

```yaml
connections:
  - id: "spark-lakehouse"
    name: "Spark lakehouse"
    type: "spark"
    host: "spark-proxy.internal"
    port: 443
    password: "${SPARK_TOKEN}"
    database: "spark_catalog"
    schema: "analytics"
    ssl:
      mode: "verify-full"
    roles: ["admin", "user"]
```

A seed that sets `connectionString` or `readOnly: true` for `spark` is refused when the file loads; one that sets `user` loads, and its connection is refused at connect with the User sentence of [section 2.1](#21-fields).

### Connection string

Apache Spark has no connection string scheme, no `readTls` and no seed load check ([`connection-string.ts`](../../src/lib/db/providers/sql/spark/connection-string.ts)).
It has no scheme on purpose, though its `sc://` address is pasted and decomposed by `parseSparkConnectUri`: the login signature prints every scheme with the tail `user@db.internal:<port>/app`, and Spark's grammar refuses both a user part and a path, so the hero would show an address the product refuses.

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `spark` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/sql/spark/execution-ui.ts).

## 3. The recommended Spark setup

Set `spark.connect.authenticate.token` on the server (Spark 4.0 and later), or `SPARK_CONNECT_AUTHENTICATE_TOKEN` in its environment, and put the same value in Token.
Put a TLS proxy in front of the Spark Connect port, or reach it through the SSH tunnel.
With nginx, raise `grpc_read_timeout` and `grpc_send_timeout` (60 s by default) above the connection's query timeout: a statement whose session switched progress messages off sends nothing on its stream until it ends, and nginx then ends the stream at its read timeout while Spark runs the job on.

```nginx
server {
  listen 443 ssl;
  http2 on;
  ssl_certificate     /etc/nginx/certs/server.pem;
  ssl_certificate_key /etc/nginx/certs/server.key;
  location / {
    grpc_pass grpc://spark-connect:15002;
    grpc_read_timeout 300s;
    grpc_send_timeout 300s;
  }
}
```

Where a boundary is wanted, give Studio a Spark Connect server and a token of its own.
Storage permissions are the boundary: Spark has no read-only session, and a token lets its holder run whatever the server allows.
The driver's web UI shows every session's statement text without authentication by default, so protect it as the operator's own surface.

## 4. Sessions and scripts

Every Studio request gets a Spark session of its own, created for that request and released when its request scope ends: Studio's query routes end it, and in the embedded package a host that passes a scope ends it ([section 12](#12-embedded-package)).
A script's statements run in the same request, so they share one session: a temp view, a `SET` or a `USE NAMESPACE` made by one statement is seen by the next, and by nothing after the request.
A `query()` call outside a request scope runs in a session of its own, released when the statement ends.
The provider also keeps one metadata session for the tree, the overview and health; it never runs a user statement.
A disconnect of the provider releases every request, statement and metadata session, and the version probe session of a connect it cuts, as the end of this section says.

At most 8 of the statements the provider writes run on one connection's metadata session at once, and the rest wait for a slot, served in arrival order.
A statement's wait for a slot and for the metadata session's setup counts against the connection's query timeout.
One never sent whose deadline passes while it waits for a slot or for the metadata session's setup, or at its send, is refused with `The statement was not sent: the connection's query timeout (<n> ms) passed before Studio could send it.`; for one sent once already, on a session the server then closed, a deadline that passes before it is sent again reads the lost-session sentence below instead.
One still waiting when the connection's close begins is refused with `The query was cancelled.`

Every new session starts with one Config call that sets `spark.sql.variable.substitute=false`, `spark.sql.execution.arrow.compression.codec=none`, `spark.sql.execution.arrow.useLargeVarTypes=false`, `spark.connect.session.resultChunking.maxChunkSize=4194304`, `spark.sql.execution.arrow.maxRecordsPerBatch=1000`, `spark.connect.progress.reportInterval=2s` and `spark.sql.connect.enrichError.enabled=true`.
Substitution is off so that `${...}` is never expanded and the text Spark parses is the text the confirmation gate read; Arrow compression is off because Studio reads only uncompressed results.
The metadata session also gets `spark.sql.legacy.keepCommandOutputSchema=false` and `spark.sql.debug.maxToStringFields=10000`, so the tree reads SHOW output by its current column names and DESCRIBE spells a struct type whole.
When Catalog is set, the session then runs `SET CATALOG '<catalog>'`; when Namespace is set, `USE NAMESPACE` with every part of the namespace in backticks, never the bare `USE`, so the first part of a namespace is never read as a catalog.
The Config call has its own 10 s deadline, and the two setup statements share the connection's query timeout, counted from the start of the session's setup, because a catalog can be slow on first use: a Hive metastore client starting, or a Glue or REST catalog behind a slow endpoint.
A setup statement that runs past that time, or whose connection fails, ends with a sentence that names the statement ([section 11](#11-errors)), never with the sentence of a server that did not answer: the server answered the session's Config call just before.
A user's statement waits for its session's setup to end and then fails with that sentence; a metadata statement waits only until its own deadline, as above, so a connect whose metadata session's setup runs past the query timeout fails with the not-sent sentence.

Refused before any call is sent:

- a statement whose first code word is `BEGIN`: `Spark SQL scripting blocks (BEGIN ... END) do not run in this version of Studio. Run the statements one at a time; temp views and SET values carry from one to the next within one run.`
- bound parameters: `Studio sends no bound parameters to Spark; write the value in the statement.`
- a Unicode space (U+00A0, U+1680, U+2000 to U+200A, U+2028, U+202F, U+205F, U+3000) outside a string, a quoted name or a comment: `This statement holds a non-breaking or other Unicode space outside a string. Spark reads it as a space and Studio's editor does not, so the confirmation prompt and the row limit could read the statement differently; replace it with an ordinary space.`
- an address written without quotes, in Spark's URI form of a name, in which the editor starts a comment or a raw string where Spark reads part of the address (one holding `--`, ending in `/` before a `*`, or ending in `r` before a quote): `This statement holds an address written without quotes, such as a://b, in which Studio's editor starts a comment or a raw string where Spark reads part of the address, so the confirmation prompt and the row limit could read the statement differently; put the address in backticks or quotes.`

An address without those shapes, such as `ADD JAR hdfs://x/y.jar`, reads alike to both and is not refused.

Global temp views live in `global_temp` and are shared by every client of the Spark server, by Spark's design; the tree does not list them, and they are reachable by name.

The session id a server answers is sent back with every later call of that session, so a server restart during a request is caught and reported, never retried: `The Spark server restarted during this request, and the session it held is gone. Run it again.`
A session Spark closed by idle expiry reads `Spark closed the session this request was using (it idled out, or the server restarted). Run it again.`
The metadata session is set up again once when the server closed it, and its read is repeated once on the new session.
When the repeated read meets a closed session again, or a statement's deadline passes before it is sent again, while it waits for the new session's setup or at the send itself, the read fails with `Studio's Spark session for the tree and the panels was closed by the server (it idled out or the server restarted), and a new one could not complete the read.`
A release that cannot reach the server is logged and left to Spark's 60-minute idle timeout.

Closing a connection, at a disconnect, when its own connect fails, when a second connect displaces it while it is still opening, or, once it is connected, when a second connect replaces it or fails, first closes its metadata slots and its sessions to new work, then stops its runs, releases its sessions, waits for its connect's version read and the probe's release, and closes its channel.
From the moment the close begins, no session setup sends a further step and no metadata read sends anything more.
A statement then still waiting for a slot or for its session's setup, and every later one on that connection, ends with `The query was cancelled.`
A tree or panel read that fails once its connection's close began ends with the same sentence, whatever its call met, so a channel the close shut never reads as a server that did not answer.
A connect that a disconnect or a second connect cut ends with that sentence too and never records a reachability error; a second connect closes the connection of a connect still opening at once, and a cut connect that ends after a later connect began, the one that displaced it or one begun after a disconnect cut it, never replaces the last error that later connect left, whether it is still opening, connected, failed or disconnected since.
`connect()` answers only once every connection it displaced or replaced is closed, and `disconnect()` only once every close in progress has ended, so no channel of the provider is left open.
A connect that a disconnect or a second connect cut once its version read was sent still releases its probe session: the close waits for the version answer and then for the probe's release, each under a 10 s deadline of its own, before it closes the channel.

## 5. How a statement runs

Every statement is first sent as a command.
A command (SHOW, DESCRIBE, DDL, SET, USE, INSERT) runs on the driver and answers inline with one Arrow batch and no Spark job.
A query answers with its plan, which a second ExecutePlan call runs as a relation, its schema first and then its Arrow batches.
Studio cannot tell the two kinds apart before Spark parses the text, and a query read the other way would cost a Spark job for every SHOW.

Results arrive in chunks of 4 MiB under the 16 MiB message cap, and Spark closes a relation batch at 1,000 rows a batch.
One ExecutePlan stream is bounded at 32 MiB received ([section 6](#6-results)).
An inline command answer is never chunked, so one larger than 16 MiB fails with `Spark answered this command in one message larger than Studio reads (16 MiB), and a command's answer cannot be split. Narrow it, for example with LIKE or IN.`
No reattachable execution is asked for: Studio's channel never re-sends a call, so a broken stream is reported as a failed statement and its Spark work is interrupted, never resumed.

While a run's stream is open, a heartbeat sends one Config read every 15 s on that session and channel, which keeps the connection and the session alive through Spark's keepalive rule.
A connection the server still closes that way reads `The connection to Spark was closed by the server's keepalive rule while the statement ran. Studio asked Spark to stop the statement; run it again.`

Stop and a closed tab send Interrupt by the run's tag, which reaches both steps of the run, and the Spark job fails with its tasks killed: `The query was cancelled.`
A run stopped while its session is still being set up sends neither its statement nor an Interrupt, and ends with the same sentence.
Stop hands the Interrupt to the channel and aborts the run's stream one turn of the event loop later, without waiting for the Interrupt's answer, so the Interrupt leaves ahead of the stream's reset on the shared connection.
A run stays reachable by Stop until it has ended and its Interrupt, if it sent one, answered or failed, and no run is sent more than one Interrupt; a Stop also reaches a run whose connection is still closing.
Every other early end of a stream also sends Interrupt by tag, once, because cancelling a gRPC call alone leaves the Spark job running.
A run that starts once its connection's close began is refused as cancelled before it asks for a session, and nothing is sent for it.

The connection's query timeout bounds each run: `The statement ran past the connection's query timeout (<n> ms); Studio asked Spark to stop it.`
A run whose statement Studio has not sent before, and whose deadline passes before Studio sends it, such as while its session is still being set up, is not sent, and no Interrupt follows: `The statement was not sent: the connection's query timeout (<n> ms) passed before Studio could send it.`
A deadline that passes between the two steps sends no second ExecutePlan call, and the run's Interrupt follows, with the first of these two sentences.
A metadata statement whose deadline passes before Studio sends it again, on a new session after the server closed the one it was first sent on, is not sent again, and ends with the lost-session sentence of [section 4](#4-sessions-and-scripts).
A dropped connection reads `The connection to Spark dropped while the statement ran. Studio asked Spark to stop it; run it again.`, and any other failure of the stream `The connection to Spark failed while the statement ran (<status text>). Studio asked Spark to stop it; run it again.`

### 5.1 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/sql/spark/sql-grammar.ts`](../../src/lib/db/providers/sql/spark/sql-grammar.ts), the `spark` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
Its grammar is `SPARK_GRAMMAR`, the one reading the statement splitter, the row limiter, the confirmation gate and query-event redaction share, so they cannot disagree about where a literal or a comment ends.
The lexical facts are read off Spark's lexer and parser at tag v4.2.0 (`SqlBaseLexer.g4`, `SqlBaseParser.g4`), and the comment facts were measured on Spark 4.2.0.
`#` is no token outside a literal, `[` is a subscript (`arr[0]`, `m['k']`), names are quoted with backticks, and `/` is division with no `//` comment.
Block comments nest at every level, and `/*+` opens a hint Spark lexes as code that opens no level inside a comment (both measured on 4.2.0).
A backslash escapes inside `'...'` and `"..."` under every setting, and `r'C:\'` is a raw literal that takes none.
A backslash right before a line feed continues a `--` comment, and a lone carriage return ends one as a line feed does; the reader follows both.
Other engines read that carriage return as comment text, and one connection type can reach servers that disagree, so a text whose `--` comment holds one with code after it is treated as ambiguous here as everywhere: the confirmation gate asks and the row limiter leaves it unbounded ([which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading)).
Three readings the shared reader does not follow: a backslash before a line feed continues a literal, Unicode spaces count as white space, and an unquoted address (`a://b`) is one token; the provider refuses the last two before any call.
The row bound goes before a trailing `OFFSET`, since `LIMIT` must precede it.
`readsSqlText` is `true`: the editor text is SQL, and the provider extends `SQLBaseProvider`.
Redaction is `sql` with no name quote: a redacted statement keeps its words, and every literal and quoted run becomes `?`.

## 6. Results

Every value is exact and JSON-safe.

### 6.1 Types

One row per column of the every-type row captured from Spark 4.2.0: the column's declared Spark type, and its cell as `cellValue` decodes it from that Arrow batch.

| Column | Spark type | Cell |
| --- | --- | --- |
| `c_boolean` | `boolean` | `true` |
| `c_tinyint` | `tinyint` | `-7` |
| `c_smallint` | `smallint` | `-300` |
| `c_int` | `int` | `-70000` |
| `c_bigint_safe` | `bigint` | `9007199254740991` |
| `c_bigint_large` | `bigint` | `9223372036854775807` |
| `c_float` | `float` | `0.1` |
| `c_double` | `double` | `1.5` |
| `c_double_nan` | `double` | `null` |
| `c_double_inf` | `double` | `null` |
| `c_decimal` | `decimal(10,2)` | `12345678.91` |
| `c_decimal_neg` | `decimal(4,2)` | `-0.05` |
| `c_decimal_38` | `decimal(38,0)` | `12345678901234567890123456789012345678` |
| `c_string` | `string` | `héllo, wörld` |
| `c_string_collated` | `string collate UTF8_LCASE` | `Ab` |
| `c_char` | `char(5)` | `ab   ` |
| `c_varchar` | `varchar(10)` | `abc` |
| `c_binary` | `binary` | `{"type":"Buffer","data":[0,255,16]}` |
| `c_date` | `date` | `2026-10-13` |
| `c_date_min` | `date` | `0001-01-01` |
| `c_timestamp` | `timestamp` | `2026-10-13 12:34:56.789+00:00` |
| `c_timestamp_ntz` | `timestamp_ntz` | `2026-10-13 12:34:56.123456` |
| `c_ym_interval` | `interval year to month` | `INTERVAL '3-7' YEAR TO MONTH` |
| `c_year_interval` | `interval year` | `INTERVAL '3-0' YEAR TO MONTH` |
| `c_dt_interval` | `interval day to second` | `INTERVAL '1 02:03:04.567891' DAY TO SECOND` |
| `c_hour_interval` | `interval hour` | `INTERVAL '1 02:00:00' DAY TO SECOND` |
| `c_array` | `array<int>` | `[1,2,null]` |
| `c_map` | `map<string,int>` | `{"a":1,"b":2}` |
| `c_map_nested_key` | `map<array<int>,string>` | `[[[1],"x"]]` |
| `c_struct` | `struct<x:int,y:string>` | `{"x":1,"y":"two"}` |
| `c_variant` | `variant` | `{"a":[true,null],"b":1.10}` |
| `c_null_int` | `int` | `null` |
| `c_void` | `void` | `null` |
| `c_calendar_interval` | `interval` | `14 months 25 days 18367000008 microseconds` |

The cells are what the Arrow batch alone gives, which is how a command's inline answer is read.
A query's result also carries Spark's schema, which names an interval column's fields, so the grid shows `c_year_interval` as `INTERVAL '3' YEAR` and `c_hour_interval` as `INTERVAL '26' HOUR`.
`columnTypes` carry Spark's spellings as that schema gives them; Spark reports `char(n)` and `varchar(n)` columns as `string`.
NaN and the infinities are JavaScript numbers in the rows, which JSON writes as `null` above, and both statement routes write them as words before they reach the grid.
A top-level binary cell is a `Buffer`, which serializes as shown and which the grid renders as binary.

A `bigint` is a number within plus or minus (2^53 - 1) and its decimal digits as a string beyond.
A decimal is always its exact text, the scale's digits kept; a legacy negative scale appends its zeros and writes no point.
A `float` is the shortest decimal that reads back as the same float32.
A `timestamp` is the UTC instant with `+00:00`, a `timestamp_ntz` the same text with no offset, the fraction with trailing zeros removed.
`geometry(srid)` and `geography(srid)` (Spark 4.2) read as `SRID=<srid>;<WKT>`, or `SRID=<srid>;WKB(<hex>)` for a form the reader does not decode.
`time(p)` is off by default on Spark; a statement that reaches it reads `TIME values are switched off on this Spark server; CAST the column to STRING to read it.`

### 6.2 Nested values

Inside an array, map or struct every value is JSON-safe: an int64 is a number when safe and digits otherwise, a decimal its text, a binary value `\x<hex>` text, temporal values their texts, a variant its JSON text as a string.
A map is an object keyed by its key texts when the key type is scalar and the texts are all distinct, and an array of `[key, value]` pairs otherwise, so no entry is lost.
A cell whose layout does not match its type is refused, naming its column: `Spark sent a <type> value in column "<column>" that Studio could not read, so the result is not shown.`
Before a type said with a vowel sound the sentence writes `an`, as in `an int value` and `an array value`.

VARIANT is decoded per the Variant encoding spec into JSON text: a decimal keeps its scale's digits (`1.10`), a double is written as JavaScript writes it, a timestamp in ISO 8601 with `T` and `+00:00`, binary in base64, object fields in their stored order.
It therefore differs from Spark's own `to_json(v)` in three ways: Spark strips trailing decimal zeros, writes doubles in Java's text, and separates date and time with a space.
Select `to_json(v)` to see Spark's rendering.

### 6.3 Budgets

A statement keeps at most 100,000 rows and 16 MiB of decoded cost, and one ExecutePlan stream receives at most 32 MiB.
A row's cost is 8 bytes for every value at every depth plus the UTF-8 length of a string and the byte length of a binary value, read from the Arrow offsets before any value is built.
Each kept batch also counts 1,024 bytes once, with its first kept row.
When a budget ends the result, Studio interrupts the run and shows the rows it kept with one warning:

- `The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.`
- `The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown.`
- `The result reached Studio's limit of 32 MiB received from Spark for one statement, so only the rows before it are shown.`

A batch too large to fit under the stream bound before any row arrived fails the statement: `Spark sends this result in Arrow batches of about <n> MiB, and the first one does not fit in the 32 MiB Studio reads for one statement, so no row is shown. Add a smaller LIMIT, or select fewer or narrower columns.`
The editor's LIMIT 500 usually ends a statement first; the budgets bound what the limiter cannot, such as queries led by `FROM`, `TABLE` or `VALUES` and every statement of a script but the last.
Load More is not offered ([section 8.6](#86-off-in-this-version)).

`spark.driver.maxResultSize` (1g by default) can stop a large result on the server first: `The result is larger than the server's spark.driver.maxResultSize; add a LIMIT or select fewer columns.`
A session that set the Arrow codec or the large types for itself gets its result refused, with the way back named:

- `Spark compressed this result (spark.sql.execution.arrow.compression.codec is <codec> in this session), and Studio reads only uncompressed results. Run SET spark.sql.execution.arrow.compression.codec=none, or leave the setting out.`
- `Spark sent this result with large string and binary types (spark.sql.execution.arrow.useLargeVarTypes is true in this session), and Studio reads only the standard ones. Run SET spark.sql.execution.arrow.useLargeVarTypes=false, or leave the setting out.`
- `Spark sent a result message larger than 16 MiB because result chunking is off in this session (spark.connect.session.resultChunking.maxChunkSize is 0 or less). Run SET spark.connect.session.resultChunking.maxChunkSize=4194304, or leave the setting out.`

## 7. The tree

### 7.1 Catalogs and namespaces

Catalogs come from three sources on the metadata session: the current catalog of `SHOW CURRENT NAMESPACE`, `SHOW CATALOGS`, and the configured `spark.sql.catalog.<name>` keys, whose values are never read.
The current catalog comes first and is flagged as the session default, the rest by name.

Namespaces come from `SHOW NAMESPACES IN <catalog>`, and the tree names each as Spark spells it: its parts joined by dots, a part in backticks only where Spark quotes it.
Every statement Studio writes for a namespace puts every part of it in backticks, and the tree's statements put the catalog and the object's name in backticks too, because Spark's spelling leaves a reserved word such as `select` bare, and a statement that names it bare does not parse under `spark.sql.ansi.enforceReservedKeywords=true`.
For every catalog but `spark_catalog`, which holds single-level databases, the walk goes on breadth first to at most 8 levels and 1,000 namespaces.
Past either bound the listing is refused, never shown shorter: `This catalog has more than 1,000 namespaces, or nests them more than 8 levels deep, more than Studio walks for its tree. Query its objects by name.`
A namespace path Studio cannot read as Spark spells it is refused before any statement: `Studio cannot read this namespace as Spark spells it, so no statement was sent.`
A listing that names a namespace outside the one asked about is refused: `Spark listed a namespace that is not inside the one Studio asked about, so the list is not shown.`
A configured catalog that cannot load fails its expansion with Spark's own text and stays in the list.

A tree answer is read whole or not at all:

- `Spark's answer for this list is larger than Studio reads for its tree (100,000 rows or 16 MiB), so the list is not shown. Query its objects by name.`
- `Spark's answer for this list is larger than the batch size this server allows for a command's answer (spark.connect.grpc.arrow.maxBatchSize), so the list is not shown. Query its objects by name.`

### 7.2 Kinds

| Kind | Role | Columns | Definition | Listed by |
| --- | --- | --- | --- | --- |
| `table` | relation | `DESCRIBE TABLE` | `SHOW CREATE TABLE`, regenerated by Spark | `SHOW TABLES IN`, minus the names `SHOW VIEWS IN` lists |
| `view` | relation | `DESCRIBE TABLE` | `SHOW CREATE TABLE`, the stored view text | `SHOW VIEWS IN`, persistent views only |
| `function` | routine | none | none | `SHOW USER FUNCTIONS IN` |

A catalog that cannot hold views or functions answers `MISSING_CATALOG_ABILITY`, which the tree reads as none of that kind.
Local temp views never appear, since the metadata session runs no user statement.
A kind the tree does not know reads `Apache Spark has no object kind "<kind>" in Studio's tree.`

### 7.3 Columns and definitions

Columns come from `DESCRIBE TABLE`, read by column name until Spark's first section header; types keep Spark's spelling.
A function's columns are read as none, with no statement, and its definition read is refused: `Studio reads no definition for an Apache Spark <kind>.`
Below the provider, a column read of any other kind is refused with `Studio reads no columns for an Apache Spark <kind>.`; the provider itself refuses a kind it does not declare before that, with the sentence of [section 7.2](#72-kinds).

`describeObjects` runs one `DESCRIBE TABLE` per object, one at a time in listing order, and describes at most 1,000 objects in one read, whatever the caller's limit.
That is a stated deviation from one round trip per container: open-source Spark has no catalog view that lists every table's columns, and `SHOW TABLE EXTENDED` spells types differently and loads every table.
When more objects remain past the bound, the read reports them as truncated, with the bound and its reason; a listing that ends exactly at the bound is not truncated.
A caller's limit at or below 1,000 bounds the read and keeps the caller's own truncation reason; with no limit, or a larger one, the reason is `Studio describes at most 1,000 objects in one read, since Apache Spark needs one DESCRIBE TABLE per object`.
A limit that is not a whole number above 0 is refused before any statement: `An Apache Spark bulk column read limit must be a positive whole number, received <limit>.`
An object Spark answers `TABLE_OR_VIEW_NOT_FOUND` for, one dropped since the listing, is left out, and any other failure fails the whole read.
For functions the read sends no statement and answers no details.
The whole read runs under one deadline, the connection's query timeout from the read's start: each statement runs in the time left, and once it is up the read fails with a timeout sentence of [section 5](#5-how-a-statement-runs), or with the lost-session sentence of [section 4](#4-sessions-and-scripts) for a statement sent once on a session the server closed, and sends none of its remaining statements.

Definitions come from `SHOW CREATE TABLE`.
Only the refusals Spark gives for an object it holds but cannot print become the definition's unavailable sentence, in Spark's own text:

- a temporary view: `EXPECT_PERMANENT_VIEW_NOT_TEMP`, which Spark 4.1.3 and 4.2.0 answer first, or `UNSUPPORTED_SHOW_CREATE_TABLE.ON_TEMPORARY_VIEW`;
- a metric view: `UNSUPPORTED_SHOW_CREATE_TABLE.ON_METRIC_VIEW`;
- a transactional Hive table: `UNSUPPORTED_SHOW_CREATE_TABLE.ON_TRANSACTIONAL_HIVE_TABLE`;
- a Hive table whose features or serde configuration the statement cannot print: `UNSUPPORTED_SHOW_CREATE_TABLE.WITH_UNSUPPORTED_FEATURE` or `UNSUPPORTED_SHOW_CREATE_TABLE.WITH_UNSUPPORTED_SERDE_CONFIGURATION`.

Any other failure fails the read, and the read of an object that does not exist fails with Spark's text, which names it.

The tree declares no foreign keys and no indexes: Spark's PRIMARY KEY and FOREIGN KEY are informational and limited to some catalogs, and no Spark SQL statement lists indexes.
A statement led by `CREATE`, `DROP`, `ALTER`, `REPLACE`, `REPAIR` or `MSCK` refreshes the tree.

## 8. Features

### 8.1 Explain

The Explain action sends `EXPLAIN FORMATTED <statement>` for a statement led by SELECT or WITH, in both of its modes.
Spark plans it without running it, so it starts no Spark job.
The plan opens as a tree built from the physical plan, each node's numbered details below it, and the raw tab shows the text as Spark printed it.
No plan is requested beside an ordinary run.

### 8.2 Monitoring

| Panel | What it shows |
| --- | --- |
| Overview | The version, start time and uptime from the metadata session, and the table count of the current namespace with a "counted from" line that names it; no size and no connection count |
| Health | One AnalyzePlan round trip; size and cache ratio "N/A" |
| Performance | Nothing |
| Slow queries | Empty: `Spark keeps finished statements in the driver's web UI, which Studio does not read in this version.` |
| Sessions | Empty: `Spark Connect sessions are listed in the driver's web UI, which Studio does not read in this version. Studio's own sessions last one request each, except the one for the tree and the panels, which Studio keeps while the connection is open.` |
| Tables | Refused: `Spark keeps table statistics only where its catalog stores them, and Studio does not read them in this version.` |
| Indexes | Empty: no Spark SQL statement lists indexes |
| Storage | Refused: `Spark reports no storage figure Studio can read in this version.` |

A catalog with no current namespace, which Spark spells as an empty name, shows a table count of 0 and no "counted from" line.
The overview's version is the server's text as the version sentences of [section 2.4](#24-test-connection) quote it: withheld whole when it holds the token, and otherwise cut to 64 characters.

The 60 s connection pulse sends one AnalyzePlan on the metadata session, which also keeps that session from idling out.

### 8.3 Plan mode and agent operations

Plan mode works: the model is told to write Spark SQL, and the grounding walk reads only the session's current namespace, or, when the current catalog holds no such namespace, that catalog's namespaces.
The walk still lists the namespaces of every other catalog, to count what it did not read.
When the listing of a catalog fails there, one that cannot load or one past the bounds of [section 7.1](#71-catalogs-and-namespaces), the walk goes on without it.
The first five such catalogs the walk meets are named to the model as not read, each with the text of its failure on one line, each run of whitespace and control characters read as one space and the text cut at 200 code points; the rest are counted in one sentence, `<n> more Catalogs were not read: listing their Namespaces failed as well, and they are not named here.`, or `1 more Catalog was not read: listing its Namespaces failed as well, and it is not named here.` for one.
A catalog that cannot load fails with Spark's own text: the test services' `studio_unloaded` catalog, which nothing loads, answers `requirement failed: Option 'url' is required.`
A failed listing of the current catalog ends the walk, and the run's inventory is then unavailable whole.
Agent execute mode and the editor hand-over are refused at the start, because Spark has no engine-side read-only mode, so the provider has no read-only query path.
The agent operations workflow reads the panels of [section 8.2](#82-monitoring) and receives the two refusals as such.

### 8.4 MCP

An opted-in seed offers `list_connections` and `inspect_schema` for an Apache Spark connection.
`run_read_query` refuses Spark, because it serves only engines with a read-only query path.

### 8.5 Export

CSV, JSON and Markdown export the grid's values as for every engine.
SQL INSERT export writes Spark literals: strings with backslash escapes, binary as `X'..'`, NaN and the infinities as `CAST('NaN' AS DOUBLE)` and its two siblings, `DATE '...'`, `TIMESTAMP_LTZ '...'`, `TIMESTAMP_NTZ '...'`, ANSI interval literals as rendered, and `PARSE_JSON(<json literal>)` for a VARIANT.
`decimal(p,s)` and `bigint` cells are written as unquoted digit text, and any other text under those types is refused as `UnwritableValue`.
An array, map or struct cell is written `FROM_JSON(<json literal>, <declared type literal>, MAP('mode', 'FAILFAST'))`, so a value Spark cannot read fails the INSERT instead of being stored as NULL.
The `MAP('mode', 'FAILFAST')` option is what makes it fail: without it `FROM_JSON` stores NULL for a value it cannot read.
A nested type holding a `binary`, `variant`, `geometry`, `geography`, `char` or `varchar`, or a map whose key is not a string, at any depth, is refused as `UnwritableValue`, and so are geospatial cells.
A nested `bigint` past 2^53 fails its INSERT, a known limit.
The DDL of an export names Spark's types: `STRING`, `DOUBLE` and `BINARY`.

### 8.6 Off in this version

| Feature | Why |
| --- | --- |
| Format | Both formatter modes change valid Spark SQL text, so no Format button or action is shown |
| Inline row edit | Spark keys are informational, and writes depend on the table format |
| Create Table | Table creation depends on the table format and the catalog; write the DDL in the editor |
| Import Data | No Spark kind takes row writes and Create Table is off, so the dialog offers only Close and says `Studio's import has no target on this connection: it offers no existing table here to write into and cannot create one.` Load rows with INSERT in the editor |
| Test data generation | Writes depend on the table format, and the generator would write to a shared cluster |
| Load More | A page would run the whole statement again on the cluster, and pages without ORDER BY can repeat or drop rows |
| Column profiler | Profiling runs full-scan aggregate jobs on tables a cluster's other users share |
| Transactions | Spark has no transactions across statements |
| Maintenance | ANALYZE runs a job on the cluster, and table formats run their own maintenance |

`runMaintenance` answers `Apache Spark has no maintenance operations in Studio.`, and the maintenance descriptions read `Spark computes table statistics with ANALYZE TABLE, which runs a job on the cluster; Studio does not run it in this version.` and `Spark has no VACUUM of its own; table formats such as Delta and Iceberg run their own maintenance.`

### 8.7 Object edit (#789)

Object edit is not in this version: no Spark kind accepts definition edits, and a view's or a table's definition is read only.

### 8.8 SQL writing

[`spark/sql-writing.ts`](../../src/lib/db/providers/sql/spark/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalBackslash` and read back by `unquoteBackslash`: every escape, the quote's included, is spelled with a backslash, and doubling is not part of the grammar.
A name is quoted by `identifierBacktickDoubled`: a backtick name with an inner backtick doubled and a backslash as data.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
Spark's lexer pairs a backslash with the next character inside `'...'` under every setting, so the quote is written `\'` as Spark's own `Literal.sql` writes it; a doubled quote is an escape only from 4.1, so it is not used.
Spark SQL (4.1 and 4.2) quotes a name in backticks and doubles a backtick inside it, the form its own `quoteIfNeeded` writes; a double-quoted text is a string literal in Spark, so the standard form would turn a name into a string.
Names are case-insensitive there, so quoting never changes which object a name means.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field spells a result export's column types through `ddlTypes`: Spark SQL has no TEXT, DOUBLE PRECISION or BLOB, and its spellings are `STRING`, `DOUBLE` and `BINARY`.
No Spark server read a probe column back, so it holds `NOTHING_STANDS_ALONE` and every bare name is re-spelled portably until one does.
A binary cell is written by `binaryStandardHex`, which Spark reads as a BINARY literal.
`nonFinite` writes `CAST('NaN' AS DOUBLE)`, `CAST('Infinity' AS DOUBLE)` and `CAST('-Infinity' AS DOUBLE)`, Spark's documented special floating-point values.
`typedLiteral` writes the temporal, interval and nested cells, from the engine's own [`spark/typed-literals.ts`](../../src/lib/db/providers/sql/spark/typed-literals.ts).
`NO_BARE_SPELLING` completes it.

## 9. The confirmation gate

The gate asks before every DELETE, DROP, TRUNCATE, ALTER, GRANT, REVOKE, UPDATE and MERGE as for every SQL engine, and the Spark grammar row adds these forms.

At the operative keyword:

- `CREATE OR REPLACE` replaces a table, view or function.
- `REPLACE TABLE` replaces a table.
- `LOAD DATA` loads files into a table, OVERWRITE replacing it.
- `CALL` runs a catalog procedure the gate cannot read.
- `EXECUTE IMMEDIATE` runs text the gate cannot read.
- `ADD` covers `ADD JAR`, `ADD FILE`, `ADD ARCHIVE` and their plurals, which load code or make the driver fetch a URL.

Anywhere in the statement's code:

- `INSERT OVERWRITE` overwrites a table or writes a directory, also inside a FROM-led multi-insert.
- `EVOLUTION OVERWRITE` overwrites a table in Spark 4.2's `INSERT WITH SCHEMA EVOLUTION OVERWRITE`.
- `REPLACE WHERE`, `REPLACE ON` and `REPLACE USING` replace rows of the table an INSERT names.
- `USING JAR`, `USING FILE` and `USING ARCHIVE` load code for a function.
- `DROP PARTITIONS` and `SYNC PARTITIONS` remove partitions from the catalog in REPAIR TABLE.
- `USING '<command>'`, the word followed by a string, as `TRANSFORM (...) USING '<command>'`, `MAP ... USING` and `REDUCE ... USING` start an external process; `USING (id)` and `USING parquet` do not ask.
- `REFLECT`, `JAVA_METHOD` and `TRY_REFLECT` call a Java method on the cluster; they match as whole words, so a name such as `reflection` does not ask, and as a name in backticks or double quotes that a `(` follows, such as `` `reflect`(...) ``.
- `IDENTIFIER(...)(...)` calls a function whose name an expression computes, which the gate cannot read; the same shape in `CREATE TABLE IDENTIFIER('t') (a INT)` asks too.
- `$$...$$` and `$tag$...$tag$` hold a dollar-quoted body, such as a Spark 4.2 metric view's YAML (`CREATE VIEW ... WITH METRICS LANGUAGE YAML AS $$...$$`), whose expressions the gate does not read.

A `SET` with `=` or a `RESET` of `spark.sql.variable.substitute`, `spark.sql.defaultCatalog` or any key under `spark.sql.catalog.` asks, and so does a bare `RESET`, which restores every key.
Not asked, on purpose: a plain INSERT, CREATE without REPLACE, `USE` and `SET CATALOG`, which change only the request's own session, and CACHE, UNCACHE, CLEAR CACHE and REFRESH, which change no data.

The editor reads Spark text as Spark's lexer does:

- `r'...'`, `R'...'`, `r"..."` and `R"..."` are raw strings that take no escapes and end at the first quote of their own kind.
- `/*+` opens an optimizer hint that Spark reads as code, not a comment, so the gate reads what follows it as code.
- a backslash right before a line feed continues a `--` comment onto the next line, and one before CR LF does not.
- a lone carriage return ends a `--` comment, and a CR LF pair ends it once.
- `${...}` is never substituted, so the text Spark parses is the text the gate read.

The gate is a second look, not a boundary: it keeps a user from running a replacing, overwriting or code-loading statement without a prompt, and the boundary is the server's own permissions ([section 10](#10-security)).

## 10. Security

Spark can run statements that read or write files and load code on the cluster, and there is no engine-side read-only mode: no setting makes a session read-only, and a session can bind another catalog plugin.
Studio therefore treats every Spark statement as write-capable: a `readOnly: true` connection is refused before anything is dialled, agent execute mode and MCP `run_read_query` refuse, and the gate is a second look.
A connection's token lets its holder run whatever the Spark server allows, so a boundary on Spark's side is the operator's: storage permissions, or a Spark Connect server for Studio with its own token.

The token is the connection's `password` field, stored, masked and resolved (`${ENV}`, `${vault:...}`) as every password is.
It is sent only in the `authorization` header, and never in plaintext to a host that is neither loopback nor tunnelled.
Every server text in a message passes the token redaction, and the provider writes no server text to the log.
The paste names parameters it does not apply but never their values.

Every request carries the fixed identity `user_context { user_id: "libredb-studio", user_name: "libredb-studio" }` and `client_type: "libredb-studio"`, never a Studio user's name or email, because Spark does not verify it and its job descriptions and web UI show it.
The driver's web UI shows every session's statement text without authentication by default; protect it as the operator's own surface.

Studio treats every answer from the server as untrusted input and bounds it:

- one message at most 16 MiB, with results asked in 4 MiB chunks, and one ExecutePlan stream at most 32 MiB received;
- a statement keeps at most 100,000 rows and 16 MiB of decoded cost, each value's cost known before the value is built;
- every Arrow stream passes a check of its framing, schema, buffer lengths and types before `apache-arrow` reads it, and a compressed batch is refused;
- the result schema is bounded at a depth of 64 and 10,000 fields;
- the Variant and WKB readers check every offset and bound their depth, and a Variant's text is bounded by the statement budget left while it is written;
- error details are read by a bounded decoder, and at most 5 causes of at most 1,024 characters are kept, never a stack frame;
- the namespace walk stops at 1,000 namespaces or 8 levels;
- a chunk sequence with a gap, a repeat or a row count that disagrees with its batch is refused.

Each bound is a unit test against a stub gRPC server or a hand-built Arrow stream.

Isolation between Studio users: one cached provider serves every Studio user of a connection, but no two requests run their statements on a shared Spark session, and the metadata session they share runs no user statement, so no user sees another's `SET`, `USE` or temp view.
The global temp views in `global_temp` are shared by every client of the Spark server, by Spark's design.
A run is cancelled only through its own query id.

Control 3.22 of [`docs/SECURITY.md`](../SECURITY.md) lists what the provider enforces: a session per request for its statements, substitution and compression off in every session, the token rule and every bound above.
The private-host egress guard does not cover a Spark connection, because grpc-js resolves names itself; this gap, D212, is listed under [Known limits](../SECURITY.md#known-limits).

Known limits:

- under Bun, a client-certificate failure reads as no Spark Connect server answering, because the TLS proxy's alert reaches the status text under Node only.
- a result of more than about 16,000 tiny batches is cut by the 16 MiB budget, with its bytes warning, because each kept batch counts 1,024 bytes beside its values.
- a legacy negative-scale decimal whose scale is below -38 is refused as unreadable.

## 11. Errors

Each failure becomes one of the repository's error classes at the provider boundary, and every server text passes the token redaction.

| Category | What arrives | Class | Sentence |
| --- | --- | --- | --- |
| `config` | a field check | `DatabaseConfigError` | [section 2.1](#21-fields) |
| `unsent` | a call its own signal ended before it left Studio; only a run's signal ends, once Stop or a close marked the run cancelled or the run ended, so a run reports `cancelled` instead and this sentence does not reach a user from a run | `QueryCancelledError` | `The statement was cancelled before it was sent.` |
| `not-connected`, `tls` | UNAVAILABLE, a refused or unknown host, a TLS cause | `ConnectionError` | [section 2.4](#24-test-connection) |
| `unauthenticated` | UNAUTHENTICATED | `AuthenticationError` | [section 2.4](#24-test-connection) |
| `connection-dropped`, `stream-failed` | the stream broke while the statement ran, or the connection failed while a session setup statement ran: UNAVAILABLE, a peer's reset or a proxy's answer | `ConnectionError` | [section 5](#5-how-a-statement-runs); for a setup statement, `The connection to Spark failed while Studio set up the session with <step> (<status text>). Run it again.` |
| `ping-goaway` | the server's keepalive rule closed the connection | `QueryError` | [section 5](#5-how-a-statement-runs) |
| `receive-cap` | a message over 16 MiB | `QueryError` | [section 5](#5-how-a-statement-runs), [section 6.3](#63-budgets), and for a control call `Spark sent an answer larger than Studio reads in one message (16 MiB), so this request could not complete.` |
| `command-batch-bound` | Spark's own one-batch bound on a command answer | `QueryError` | `Spark answers a command in one Arrow batch, and this answer is larger than the batch size this server allows (spark.connect.grpc.arrow.maxBatchSize). Narrow it, for example with LIKE or IN.` |
| `batch-too-large` | the stream bound before any batch arrived whole | `QueryError` | [section 6.3](#63-budgets) |
| `deadline` | the query timeout, while the statement ran, before Studio could send it, before Studio could send again a metadata statement sent once on a session the server closed, or while a session setup statement ran | `QueryError` | [section 5](#5-how-a-statement-runs); for a statement sent again, the lost-session sentence of [section 4](#4-sessions-and-scripts); for a setup statement, `Spark did not finish setting up the session with <step> within the connection's query timeout (<n> ms); the catalog may be slow to answer. Run it again, or raise Query Timeout in the connection.` |
| `cancelled` | Stop, a closed tab, Spark's `OPERATION_CANCELED` or SQL state `HY008`, a statement that runs, starts or waits once its connection's close began, a tree or panel read that fails once its connection's close began, or a connect that a disconnect or a second connect cut | `QueryCancelledError` | `The query was cancelled.` |
| `session-closed`, `session-changed` | `INVALID_HANDLE.SESSION_CLOSED`, `SESSION_NOT_FOUND`, `SESSION_CHANGED` | `QueryError` | [section 4](#4-sessions-and-scripts) |
| `unimplemented`, `version` | not a Spark Connect server, or below the floor | `ConnectionError` | [section 2.4](#24-test-connection) |
| `unreadable` | a result Studio could not read | `QueryError` | `Spark sent a result Studio could not read (<what>), so it is not shown.` |
| `refused` | a tree request Studio declines: a list past its bounds, a namespace Studio cannot read as Spark spells it, a kind the tree does not know or one with no columns or no definition to read, or a bulk column read limit that is not a whole number above 0 | `QueryError` | [section 7](#7-the-tree) |
| `spark` | Spark's own error | `QueryError` | Spark's text, then `Cause: <innermost cause>` |

A Spark error carries its error class, SQL state and error id; Studio fetches the details once and adds the innermost cause as a `Cause:` line when it says something the text does not, such as "Permission denied" under a missing-file error.
A local failure of the client reads `The Spark client stopped the call before it reached the server. Nothing was sent.`, never the client's own message, which could repeat a header.
Sentences Studio adds:

- `UNSUPPORTED_TIME_TYPE`: the TIME sentence of [section 6.1](#61-types).
- a SparkException that names `spark.driver.maxResultSize`: the sentence of [section 6.3](#63-budgets).
- UNKNOWN with no message and no details: `Spark stopped this statement with an internal error and reported no reason (gRPC UNKNOWN). A statement nested thousands of levels deep is one known cause; the Spark driver log has the rest.`
- any other call that ends with no reason: `The server ended this call with gRPC <code name> and gave no reason. The Spark driver log, or the log of a proxy in front of Spark, has the rest.`

## 12. Embedded package

A host that embeds Studio renders the exported `ConnectionModal` and reads `connectWarnings()` for the tokenless caution.
The embedded package mounts no route, so a host that passes a request scope ends it with `endOpenQueryTransaction(scope)`: the scope's session lives until the host ends it, or until the provider disconnects, and one left idle before then, or whose release cannot reach the server, lives until Spark's 60-minute idle timeout.
Only Interrupt stops Spark work, so a host stops a statement with `cancelQuery`; cancelling its own call leaves the Spark job running.
The package depends on `apache-arrow` 21.2.0, pinned exactly.

## 13. Testing and evidence

| Layer | Files |
| --- | --- |
| Unit | `tests/unit/db/spark/`, one file per module, against a fake Spark Connect server (`tests/helpers/spark-connect-server.ts`) and hand-built Arrow streams (`tests/helpers/spark-ipc.ts`) |
| Doc | `tests/unit/db/spark/provider-doc.test.ts` holds this page to the code: its sentences, numbers, kinds, gate forms and the type table |
| Integration | `tests/integration/db/spark-provider.test.ts` runs the real provider over recorded Spark answers, through the recorded transport of `tests/helpers/spark-fixtures.ts` |
| Live | `tests/live/spark-evidence.ts` writes the captures by hand from the compose services, entry by entry from the catalog in `tests/live/spark-evidence-plan.ts` |

The captures are under `tests/fixtures/spark/4.2.0/` and `tests/fixtures/spark/4.1.3/`, one RPC exchange per file, recorded on 2026-10-13 from `apache/spark:4.2.0@sha256:fc64959c04bd87b0ac686be9aaa9008b69cdb1afc695400528279c8b01f43d89` and `apache/spark:4.1.3@sha256:bf9d035a7c32a8ca46aa58d6348182ffd7d2dff6409206ecfbb3915ff1fef211`; [`tests/fixtures/spark/README.md`](../../tests/fixtures/spark/README.md) lists each one.
The replay matches a call by its RPC and its request, both read through the provider's own codec with the ids the client chooses at random masked, and a request no capture matches fails its case.
The one BUILT step every case shares is in the answer: the request's own ids are written into it, and every call of one session gets one server-side session id, because each capture comes from its own run and the provider reads a changed id as a restarted server.
Two cases are BUILT from captures and labelled so: the version refusal, the 4.2.0 version answer rewritten to 3.5.9 and 4.0.4, and a nested namespace listing, the session catalog's `SHOW NAMESPACES` answer rewritten to multi-part spellings, since no catalog of the open-source fixture nests.
Nothing in CI contacts Spark.

To repeat the captures by hand:

1. Start the services: `docker compose -f database-compose.yml up -d spark`, `docker compose -f database-compose.yml --profile spark-4-1 up -d spark-4-1`, and, with `SPARK_CONNECT_TOKEN` set to a token of your choosing and `SPARK_TLS_DIR` to a directory outside the repository, `docker/spark/make-certs.sh "$SPARK_TLS_DIR"` then `docker compose -f database-compose.yml --profile spark-auth up -d spark-auth spark-tls`.
2. Set every variable the harness reads through `tests/helpers/spark-live.ts`: `SPARK_CONNECT_TOKEN`, 16 to 256 letters, digits or the characters `. _ ~ + / = -`, and `SPARK_TLS_DIR`, both as in step 1, and `SPARK_LIVE_TARGET` (127.0.0.1:15002), `SPARK_LIVE_TARGET_41` (127.0.0.1:15003), `SPARK_LIVE_TARGET_AUTH` (127.0.0.1:15004), `SPARK_LIVE_TARGET_TLS` (127.0.0.1:15005), `SPARK_LIVE_UI` (http://127.0.0.1:4040) and `SPARK_LIVE_UI_41` (http://127.0.0.1:4041).
   Every target and driver UI must be a loopback address, and a variable that is missing or refused stops the harness with exit code 2 before any socket opens.
3. Create the sample objects with `bun tests/live/spark-evidence.ts --setup <service>` for `spark`, `spark-4-1` and `spark-auth`, write the captures with `--capture <service>` for each of the four services, or `--capture <service> <entry> ...` to retake some entries, then render the fixtures README with `--readme`.
   The harness dials a service only once `docker port` lists its target for the fixture container running the pinned image, and an answer other than the catalog expects stops the run with exit code 1, so a surprise is reported rather than recorded.
4. Stop the services with `docker compose -f database-compose.yml --profile spark-4-1 --profile spark-auth down`.

A surface changed in the catalog, the text that tells what an entry's captures record, needs no retake.
The render-only `bun tests/live/spark-evidence.ts --surfaces` contacts no server and reads no variable: it rewrites that surface in every capture, every other byte as written, and `--readme` then regenerates the fixtures README.

### References

- Spark Connect overview: https://spark.apache.org/docs/4.2.0/spark-connect-overview.html
- The Spark Connect client connection string: https://github.com/apache/spark/blob/v4.2.0/sql/connect/docs/client-connection-string.md
- Configuration: https://spark.apache.org/docs/4.2.0/configuration.html
- Spark SQL reference: https://spark.apache.org/docs/4.2.0/sql-ref.html
- Spark Connect protos at tag v4.2.0, commit `32f7299601108917fb01920a54e084595b7b3bf8`: https://github.com/apache/spark/tree/v4.2.0/sql/connect/common/src/main/protobuf/spark/connect
- Variant encoding spec: https://github.com/apache/parquet-format/blob/master/VariantEncoding.md

## Migration DDL

[`SPARK_MIGRATION_DDL`](../../src/lib/db/providers/sql/spark/migration-ddl.ts) is what the schema-diff migration generator writes for `spark`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
No transaction spans two Spark SQL statements (the provider declares `supportsTransactions: false`), so `transactionWrapper` is `null` (#284).
A modified column is a comment: on Spark 4.1.3 and 4.2.0 a session-catalog parquet column's type change fails with NOT_SUPPORTED_CHANGE_COLUMN (0A000) while a comment change succeeds, and on 4.2.0 the same table refuses `SET` and `DROP NOT NULL` with UNSUPPORTED_FEATURE.TABLE_OPERATION (0A000) and takes `SET` and `DROP DEFAULT`.
A DSv2 catalog decides for itself, so the answer is the catalog's and the table format's.
Spark 4.1 and later parse `FOREIGN KEY ... REFERENCES` (SPARK-51207) as an informational `NOT ENFORCED` constraint, kept only by a DSv2 catalog that implements constraints.
A session-catalog table refuses every constraint operation (SPARK-54761): on 4.2.0 a parquet table refuses `ADD CONSTRAINT ... FOREIGN KEY`, with or without `NOT ENFORCED`, `DROP CONSTRAINT` and a `CREATE TABLE` that declares one, each with UNSUPPORTED_FEATURE.TABLE_OPERATION (0A000).
So keys, foreign keys and index changes are comments.
The fields it takes unchanged from `src/lib/db/migration-ddl/shared.ts` are `standardAddColumn`, `standardColumnDef`, `standardDropColumn` and `standardDropTable`.

Every refusal reason it can print, verbatim:

- "Whether a column's type, nullability or default can change depends on the catalog and the table format; write the change by hand."
- "Apache Spark: Cannot generate index DDL. Spark SQL's index statements work only in a catalog whose tables support indexes; write the index change by hand."
- "Spark accepts a foreign key only as an informational NOT ENFORCED constraint, in a catalog that implements constraints."
- "Spark accepts a primary key only as an informational NOT ENFORCED constraint, in a catalog that implements constraints."
