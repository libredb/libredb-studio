# Databend Provider

The `databend` type-id: self-hosted Databend and Databend Cloud over Databend's own HTTP query API (`POST /v1/query`), with no driver dependency of any kind.
Every statement is the body of one HTTP request, its answer is read by following the `next_uri` chain the server hands back, and every request goes through the shared node transport.
This document is the single reference point for the provider: design, architecture, usage and tests.

`DB_HTTP_BLOCK_PRIVATE_HOSTS=true` blocks loopback, private, link-local and other non-public HTTP destinations; it is off by default so local connections work.

| | |
|---|---|
| **Status** | Implemented |
| **Database type id** | `databend` |
| **Family** | SQL (`src/lib/db/providers/sql/databend/`) |
| **Driver** | None: HTTP only, over the shared node transport (`src/lib/db/http/node-transport.ts`) |
| **Query language** | `sql` |
| **Default port** | `8000`, the query node's HTTP handler; Databend Cloud serves HTTPS on 443 ([4.1](#41-configuration-fields)) |
| **Connection pooling** | One keep-alive agent per connection, three sockets; every statement runs in a session of its own ([3.4](#34-every-statement-runs-in-a-session-of-its-own)) |
| **Connection string** | Not offered: a pasted `https://` address goes into Host, which splits it, and a `databend://` DSN into Paste URL of a new connection, which fills the fields ([4.1](#41-configuration-fields)) |
| **EXPLAIN** | `databend-text`: plain `EXPLAIN` in both modes, never `EXPLAIN ANALYZE`, and no plan for the shapes that run while binding ([5.6](#56-explain-is-the-planning-form-only)) |
| **Writes** | Every statement Databend accepts runs as written; no inline row edit, no object edit ([6.3](#63-object-edit-789-not-in-this-version)) |
| **Transactions** | Not exposed: a transaction a statement leaves open is rolled back when the statement ends ([3.5](#35-what-a-statement-leaves-open-is-closed)) |
| **Maintenance** | `kill` only: `KILL QUERY` on a session id from the Sessions panel ([8](#8-maintenance)) |
| **Query cancellation** | Yes: Stop sends the statement's kill link and reports a cancel only when the kill answered ([5.8](#58-cancellation-and-deadlines)) |
| **Verified against** | `datafuselabs/databend:v1.2.951-nightly@sha256:f63585cae3e096d62580ad51d92abd2f64b57b196af3b51cb01ecae381ec874b`, the pinned image of the local fixture (`version()` answers `v1.2.951-nightly-9b7eeff9a8`), and the version floor `datafuselabs/databend:v1.2.881@sha256:847b20b0cfbadaa8dd87fc5c023db1d07042e9be6231dfc8303e75feefd94bf8` (`v1.2.881-ca29960f5c`), each run by digest through the live check on 2026-10-08 ([11.3](#113-the-live-check)). Databend Cloud: on 2026-10-08 a throwaway test tenant running `1.2.951-nightly-9b7eeff9a8`, the pinned build, passed the live check through its gateway, 22 of 22 checks with the cold start skipped, and all 18 evidence scenarios ([11.3](#113-the-live-check)); one resume was timed outside Studio ([4.4](#44-databend-cloud-warehouse-cold-start-and-billing)), and a cold start through Studio, paging on a multi-node warehouse, the billed request count, a warehouse name with `_` and a plain-HTTP request are not run yet |
| **Source** | [`src/lib/db/providers/sql/databend/`](../../src/lib/db/providers/sql/databend/) and [`src/lib/explain/databend-text.ts`](../../src/lib/explain/databend-text.ts) |
| **Tests** | [`tests/integration/db/databend-provider.test.ts`](../../tests/integration/db/databend-provider.test.ts) + [`tests/unit/db/databend/`](../../tests/unit/db/databend/) + [`tests/unit/lib/explain/databend-text.test.ts`](../../tests/unit/lib/explain/databend-text.test.ts) |

## 1. Overview

The connection type is labelled "Databend" in the dialog.
It reads and writes Databend through the same HTTP query API that BendSQL and the official drivers use: a statement is posted as JSON, the server answers with rows and a link to the next page, and the provider follows the links until the server ends the statement.
It lists catalogs, databases, tables, views, materialized views and dynamic tables, describes their columns, shows their DDL, runs any one statement per request, explains a SELECT, and reads the monitoring panels from `system` tables.
The same type serves a self-hosted query node and a Databend Cloud warehouse: a Cloud connection names its warehouse, and a self-hosted one usually leaves Warehouse empty.

Studio does not use Databend's MySQL handler (port 3307) or its Flight SQL handler (port 8900).

### 1.1 Concept mapping

| Databend | Studio |
|---|---|
| A query node, or a Databend Cloud warehouse | One connection |
| A catalog (`default`, or an external one) | The first container level, Catalog |
| A database | The second container level, Database |
| A table, a view, a materialized view, a dynamic table | An object of kind `table`, `view`, `materialized_view` or `dynamic_table` |
| A SQL user and its password | User and Password, sent as Basic authentication on every request |
| A warehouse | The Warehouse field, sent as the `x-databend-warehouse` header |
| A session | One per statement, chosen by Studio and ended with the statement |

## 2. Architecture

### 2.1 Where it sits

The provider is `DatabendProvider` in `src/lib/db/providers/sql/databend/index.ts`, and it extends `SQLBaseProvider`, so the shared SQL limiter, statement splitter and generators serve it under the Databend grammar row.
`index.ts` is composition and delegation only: it owns the lifecycle, the `getCapabilities()` literal, each statement's permit and deadline, and the mapping of a `DatabendError` onto the house error classes.
The one import outside the directory under `src/lib/db/providers/` is `../sql-base`, and the seam guard (`tests/unit/db/databend/seam-guard.test.ts`) holds that, holds `routes.ts` as the only file with a `/v1/` literal, and holds `http-transport.ts` as the only importer of `createNodeTransport`.
Inside `src/lib/db` nothing branches on the type id: what differs is declared by capabilities, the grammar row and the compatibility records.

### 2.2 Modules

| File | What it owns |
|---|---|
| `index.ts` | `DatabendProvider`: the declarations, `connect()` and its cautions, each statement's permit, deadline and run, the object and monitoring calls |
| `connection-options.ts` | The endpoint, the Basic header, the user-agent, the warehouse header, TLS, the plaintext rule and its consent, the bounds, the secret forms |
| `http-transport.ts` | The I/O loop of one statement: the POST, the pages, the final or the kill, the end-open, the retries |
| `transport.ts` | The transport's types: the statement request, the outcome, the notices and `DatabendError` with its closed categories |
| `routes.ts` | The only paths Studio sends to, and the rule that accepts a `next_uri` |
| `answer.ts` | One HTTP answer read into a typed answer or a refusal, and the result-mode notice |
| `retry.ts` | Whether a failed request is sent again, and after how long |
| `session.ts` | The per-statement ids, the session header, the session warnings and the end-open plan |
| `auth-latch.ts` | The process-wide sign-in latch |
| `cloud-host.ts` | Which hosts are Databend Cloud's, and the warehouse an older Cloud host names (section 4.4) |
| `errors.ts` | Every failure's category and the sentence a person reads, through `serverText` |
| `sql-text.ts` | The statement guard |
| `decode.ts` | Cells to grid values, column names and the DML count |
| `objects.ts` | The tree, describe, bulk describe, object source and the `no_password` caution |
| `introspect.ts` | The monitoring panels, health and the kill statement |
| `labels.ts` | The labels and the kill's maintenance spec |
| `src/lib/explain/databend-text.ts` | The EXPLAIN strategy: which statements may be explained, and the plan tree |

### 2.3 Registration & lifecycle

`createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)) builds `DatabendProvider` for the `databend` type.
The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` builds the connection options, which refuse a bad field before any socket, opens the transport, runs `SELECT version() AS server_version` under the surface deadline, then reads the connect-time cautions of section 4.5 best effort; a failure of the probe closes the transport.
`disconnect()` aborts every statement, waiting or running, and the transport's close kills each running one under its own 5 seconds.
The transport never goes through an `http_proxy` or `https_proxy` variable and never follows a redirect: use an SSH tunnel to reach a private endpoint.

## 3. Design decisions

### 3.1 One statement per request, and the guard before it

Databend's `/v1/query` runs one statement per request, and when the first of several is an INSERT or REPLACE it drops the rest without an error.
So the provider refuses text with more than one statement, and text with none, before any request.
The same guard refuses every place where Databend's lexer ends a construct somewhere Studio's reading does not, because there the confirmation gate would have read a different statement from the one that runs: section 5.2 lists each with its sentence.
In the editor, a selection of several statements goes to Studio's multi-statement route, which splits it under the same grammar row and sends each statement on its own.

### 3.2 The loop ends on the absence of a link

The answer's `state` is display only.
The loop follows `next_uri` and stops when an answer carries none, when an answer carries an in-body `error`, at a budget of section 3.10, or past a poll bound of one poll per second of the statement's deadline plus a fixed allowance, which a server that never ends a statement meets with this fault:

> Databend's answer did not follow its HTTP protocol (more answers than one statement may take), so Studio stopped and cancelled the statement.

Every exit after the server registered the statement sends one close: the final link when the server already ended it (an in-body error, a budget cut, a complete result), else the kill.

### 3.3 A link is rebuilt from Studio's own id, never followed as given

Every path Studio sends is built in `routes.ts` from the query id Studio chose: `POST /v1/query`, `/v1/query/<id>/page/<n>`, `/v1/query/<id>/final`, `/v1/query/<id>/kill` and `POST /v1/session/logout`.
A `next_uri` is accepted only when it is exactly the page or final path of this statement, compared as text, so an absolute URL (even one on the same origin), `//`, a backslash, a percent sign, a query string, a fragment, a dot segment, another statement's id and any longer text are each refused as "a next_uri link of a shape Studio does not follow".
`stats_uri`, `final_uri` and `kill_uri` are never read.
The first answer must also be for Studio's query id and session, from a node id of the accepted shape, before any page is asked for.
Every later page must be for the same query id and session, and a page that holds a schema or rows must hold the schema the rows before it were kept under, the same names and types in the same order; a page with neither is a long poll still running.
A page that breaks either rule is a protocol fault that names another statement, another session or another schema (section 10); none of its rows is kept, and the statement is closed under its own query id and session.
The captures, on the local fixture and on Databend Cloud, were taken without a client session, so they show only the same query id and schema on every later page.
That every later page also echoes Studio's own session was measured live under Studio's headers on the pinned v1.2.951-nightly and on v1.2.881.

### 3.4 Every statement runs in a session of its own

One cached provider serves every caller of a connection, so session state cannot belong to a user's editor tab.
Each statement gets a fresh session id that Studio chooses, sent as `x-databend-session` with its POST, pages, final and kill, and the session ends with the statement.
So `USE`, `SET`, `SET ROLE`, `SET VARIABLE`, `BEGIN` and a temporary table last for their own statement only, and the result carries a warning where the server reports the change (section 5.5).
A session id cannot carry state across users: the server keeps a session's state per user (measured, UC3).

### 3.5 What a statement leaves open is closed

The end-open reads the server's flags on the last answer, never the SQL text.
A transaction the answer reports `Active` is rolled back with a `ROLLBACK` posted under a new query id with the echoed session, and the result says so:

> The statement left a transaction open, and each statement runs in its own session, so Studio rolled it back.

When the ROLLBACK does not report `AutoCommit` for its own id, the warning is instead:

> The transaction may stay open until Databend's idle timeout (4 hours).

The ROLLBACK's own links are followed inside its 5 seconds and under the poll bound of section 3.2 for those 5 seconds, 105 links; a chain that does not end within both gets the ROLLBACK's close warning below.

A session the answer says still needs keep-alive holds a temporary table, and a `POST /v1/session/logout` ends it, which drops the table:

> Each statement runs in its own session, so Studio ended it, which dropped the temporary tables it created.

A POST that may have reached the server with no answer gets a kill and one logout, since the session id is Studio's own.
So does a POST whose HTTP 200 could not be read, malformed or past a bound of section 3.10: the server may have run the statement in Studio's session, and a temporary table it made would otherwise outlive it.
An auth refusal, a middleware 400 or a fail-to-start answer sends nothing more: a kill, ROLLBACK or logout would carry the refused credential again and count toward a lockout.
A close that Databend answers with a refused sign-in counts the same: the sign-in is latched (section 3.7), and the statement's remaining closes, a resent kill, the ROLLBACK and the logout among them, are not sent.
A close's HTTP 200 acknowledges it unless its body is a gateway's refusal, which may come over HTTP 200 as over any other status, so a kill refused that way is no acknowledged cancel and a sign-in refused that way is latched.
Each close is best effort under its own 5 seconds, off the statement's signal; one that does not answer is a warning on a finished statement, never an error that would report a committed write as failed:

> The statement finished, but Studio's request to close the finished statement (final) got no answer within 5 seconds.

> The statement finished, but Studio's request to roll back the transaction it left open got no answer within 5 seconds.

> The statement finished, but Studio's request to end its session (logout) got no answer within 5 seconds.

One answered with anything but its acknowledgment, an error status, a refused sign-in, an answer the transport does not read (one past the 16 MiB cap, one under a content-encoding other than identity, a redirect, or one cut short once it began) or, on the ROLLBACK's links, an HTTP 200 that could not be read, says so instead:

> The statement finished, but Studio's request to close the finished statement (final) was answered with an error.

> The statement finished, but Studio's request to roll back the transaction it left open was answered with an error.

> The statement finished, but Studio's request to end its session (logout) was answered with an error.

A kill that is not acknowledged is reported by the statement's own outcome (section 5.8), never by one of these.

A ROLLBACK left unsent after a refused sign-in gives the warning that the transaction may stay open, and a logout left unsent says it was not sent rather than that it went unanswered:

> The statement finished, but Databend then refused the sign-in, so Studio did not send its request to end its session (logout), or any further request for this statement.

### 3.6 Retries

A statement POST the server may have received is never sent again, because Databend could run it twice.
The one exception is a Databend Cloud gateway's `ProvisionWarehouseTimeout`, which the gateway answers without forwarding, so the POST goes again with the same ids while the warehouse resumes.
A Stop or the deadline in the wait between two such attempts sends nothing more, neither a kill nor a logout, since no attempt reached the warehouse, and the run reads as cancelled or timed out (section 5.8).
A GET of the chain (a page, the final, the kill) is sent again after a network failure or an intermediary's 429, 502, 503, 504 or 520, since the server re-serves each of them, and after a gateway's `ProvisionWarehouseTimeout` over any status, HTTP 200 included, within the same three GET attempts.
The backoff is 1, 2, 4, 8 and 8 seconds, each 20 percent either way, a `Retry-After` in seconds honoured, and never a wait that reaches the time left: at most six POST attempts and three GET attempts.
A page that gave no answer within its attempt timer, with statement time left, is asked for again at once, one time, inside the three GET attempts; a second silence ends the statement with "No answer arrived from Databend (a page of the result did not arrive in two attempts)".
ROLLBACK and logout are never retried.

### 3.7 The sign-in latch

Databend counts failed sign-ins for a user under a password policy, and five within 15 minutes lock that user for 15 minutes, during which the right password is refused too (measured, L10: the sixth wrong password and then the right one answer HTTP 500 with code 2215).
Studio retries on its own (the connection pulse, the fleet check, a tree read and a probe sent at once on activation), so the latch lives in the process: once Databend refuses a sign-in, on any request of a statement, its kill, ROLLBACK and logout included, that Studio process sends that password to that server again only after 15 minutes, or after the credential changes.
Each Studio process holds a latch of its own, so several replicas each send a refused password once per 15 minutes, and five or more can still lock the user ([D252](../BACKLOG.md)).
A gateway's sign-in refusal latches over any HTTP status, 200 included, and only an answer proves a sign-in, never a refusal.
Two connections with the same key share the latch, a disconnect does not clear it, and a restart does.
The key is an HMAC-SHA-256, keyed by random bytes each process draws once, over the scheme, the far end, the SSH bastion route, the user and the password; no secret is kept, and a key seen outside the process cannot be used to test a guessed password.
The far end's host is framed in one spelling: an IPv6 address however it is written, and a host name with or without its final dot, are one key, while an error still names the host as configured.
Until a key has had an answer, one statement holds it and the others wait until it has sent its last request, its closes included, so a refused password is sent once.
The latch holds 256 keys: a new one takes the place of an expired key first, then of the oldest proven one, and of the oldest latched one only when every key is latched and live; a proof never takes a latched key's place, so its key stays unproven.
A latched key is refused with no request:

> Databend refused this sign-in at [time] UTC, so this Studio server will not send this password again before [until] UTC, or until it changes.

### 3.8 Literals, never bound parameters

The HTTP API's `params` are not sent, so a run with bound parameters is refused before any request:

> Databend's HTTP API takes no bound parameters from Studio; write the value in the statement.

Every value Studio writes itself is a literal through `quoteLiteral` under `"databend"`, with the quote and the backslash doubled, because Databend's string escapes include the backslash; every name is a backtick identifier with the backtick doubled.
Quoting was measured round-trip on 14 values and 15 identifiers under both SQL dialects (L4): every value and name read back byte-equal.

### 3.9 Basic on every request

Every request carries `Authorization: Basic` with the user and the password, the empty password included: Databend answers a request with no `Authorization` header 401 with code 5100 even for a `no_password` user (measured, UC1 and UC2).
There is no token exchange and no server-minted session, so each request costs one password check on the server; the credential travels in that one header and never in a URL, a body, an error or a log line.

### 3.10 Bounds, and what they were measured against

| Bound | Value |
|---|---|
| One answer | 16 MiB (16,777,216 bytes) per HTTP answer; past it the socket is destroyed, the statement is killed and the run fails as too large, and a close's answer past it is a refused close (section 3.5) |
| Rows of one answer | the page the statement asked for, `max_rows_per_page` |
| Columns of one answer | 250,000, the cell budget, since a wider schema keeps no row; inside them, 750,000 keys and commas, three per column |
| The rest of one answer | 65,536 arrays, objects, keys and values outside its rows and columns |
| Nesting of one answer | 64 arrays and objects deep, the answer's own object included; a real answer nests 3 |
| A refusal | its first 65,536 characters are read; a longer one is read by its HTTP status alone |
| Answer text per statement | 16 MiB (16,777,216 bytes) across its pages; past it the rows read so far are kept and the result is marked limited |
| Cells | 250,000 cells (rows times columns) per result; past it the rows read so far are kept and the result is marked limited |
| Rows | the limiter's page for a bounded statement, and 100,000 rows for an unlimited one |
| Server warnings | the first 100 different ones of a statement are shown; past them one warning counts the rest, which are never kept |
| Page | at most 10,000 rows per page, with a 10-second long poll (section 5.1) |
| In flight | 2 statements per connection and 2 per server type in this process, with a queue of 64; the tree, monitoring and connect reads hold the same permits |
| Sockets | 3 per connection, one more than the statements, so a kill always has one |
| Run deadline | the connection's query timeout, also sent as `max_execute_time_in_seconds` |
| Tree, connect and monitoring | 10 seconds, or the query timeout when it is shorter |
| Kill, final, ROLLBACK and logout | 5 seconds each, off the statement's own signal |
| Monitoring lists | 50 sessions and 20 slow queries by default, at most 500 |
| Sign-in latch | 15 minutes per refused sign-in, at most 256 entries |

What one answer costs before the budgets apply is bounded by these, not by its 16 MiB.
Before an answer is parsed, one pass over its text counts what parsing it would build, outside strings: its rows, its columns and their keys, every other array, object, key and value, and how deep its arrays and objects nest.
An answer past a bound of the table is refused without being parsed, as a protocol fault that names what was too large (section 10), and the statement is killed; when it is the POST's own answer, its session is logged out too (section 3.5).
The nesting bound keeps a parsed answer within the stack of whatever reads it whole, such as the copy of the echoed session a ROLLBACK sends back, which Node 24 fails to write from a few thousand levels (4,460 measured on 24.14).
A row's cells are bounded by the answer's bytes alone, since a page wider than the cell budget is legal and the budget cuts it once it is read.
The answer is parsed with no reviver, a key named `__proto__` is looked for afterwards, and the rows are checked where they lie and never copied.
Measured on Node 24 with the old space limited (`wire-heap.test.ts`): a page of 16 MiB of `[]` rows, one of `[null]` rows, and a JSON refusal of 16 MiB of `[]` or `""` are each refused or cut within about 11 MiB of old space.
A statement of 20 pages of 60,000 different warnings each ran Node out of a 64 MiB old space while every warning was kept, and keeps 100 of them within it now.

A cut result says which budget it reached:

> The result reached Studio's statement budget of 16,777,216 bytes of answer text, so only the rows before it are shown.

> The result reached Studio's statement budget of 250,000 cells, so only the rows before it are shown.

> The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.

A server that sends different warnings on every page would otherwise fill the statement's budget of answer text with warnings, so the ones past the first 100 are only counted:

> Studio shows the first 100 different warnings of this statement and left out the [count] more that Databend sent past them, repeats included.

The bounds were measured together (L9) in the container image under its 384 MiB heap flag, against the local fixture, through the real transport: two statements at once, each stopped at the 16 MiB budget of answer text, peaked at 149.7 MiB of heap used (39 percent of the limit) and 201.8 MiB committed.
The server cuts a page at about 4 MiB of block memory, and display text multiplies it: a page of 1,024 rows of 8 columns of 512 control characters each is 24 MiB of JSON, past the 16 MiB answer cap at any page of more than about 650 rows, so such a result fails as too large, by design; a bounded statement whose row cut keeps the page smaller is shown (600 rows were 14.1 MiB).
400 Boolean columns at 10,000 rows are 15.3 MiB, under the cap; 420 or more would also be too large at a full page.
The cap stays at 16 MiB by the owner's decision.
Every budget was verified on the local fixture.
Through the Databend Cloud gateway the live check read 100,000 rows whole over the page chain and cut a statement at the 16 MiB budget of answer text; the bounds of one answer, the cell budget and the warning bound were not run there.
No SQL provider bounds the statement text it is handed ([D249](../BACKLOG.md)).

## 4. Connection

### 4.1 Configuration fields

| Field | Rule |
|---|---|
| Host | A host name or address, or a pasted https:// address, which is split into Host and Port. Databend Cloud: the host from Connect in the Cloud console, on port 443 with SSL mode verify-system. Self-hosted: the query node, port 8000 unless http_handler_port was changed. |
| Port | `8000` by default, the query node's HTTP handler; 443 comes from a DSN or an https:// paste, and choosing an SSL mode keeps the port, so set 443 by hand for Databend Cloud |
| User | A SQL user. On Databend Cloud: cloudapp, or a user created with CREATE USER; the email you sign in to the Cloud console with is not a SQL user. |
| Password | Sent with User as Basic authentication on every request; empty is sent as an empty password |
| Database | The current database for names a statement does not qualify. Empty means default. |
| Warehouse | Databend Cloud: the warehouse= value of the DSN from Connect. A suspended warehouse resumes on the first statement, opening the connection included, because it reads the object tree, and is billed while it runs; with Warehouse set, Studio sends no background health checks. Self-hosted: leave empty unless your cluster routes requests by warehouse. |
| Send the password without TLS | Ticked, the password crosses the network in cleartext to this host. Databend Cloud never needs this: it serves HTTPS on port 443. |

The connection-string box is not offered, because it reads `http://` and `https://` as ClickHouse; a pasted address goes into Host, and a DSN goes into Paste URL of a new connection, which fills the fields.
Paste URL reads `databend://`, `databend+http://` and `databend+https://` as BendSQL reads a DSN: TLS unless `sslmode=disable` (`databend+http://` without TLS), the DSN's port, else 443 with TLS and 80 without, the path as Database and `warehouse=` as Warehouse, or, with no `warehouse=`, the warehouse an older Databend Cloud host names (section 4.4).
A paste that names a host sets Warehouse, clearing it when the DSN names none, and clears Send the password without TLS, which no DSN carries, so a box ticked for an earlier connection or paste never sends the password in cleartext to the pasted host.
It keeps a password, user or database the DSN does not carry, so check them after a second paste ([D250](../BACKLOG.md)).
A spelling Studio does not connect with fills no field and says what to paste instead; a DSN's `sslmode=require` or `sslmode=enable` fills SSL mode verify-system, not the unverified `require` of section 4.3, and says so; and a `tls_ca_file`, or an `sslmode` BendSQL does not read, fills the other fields and says what to set under SSL / TLS:

| Paste | What Studio says |
|---|---|
| `databend://cloudapp@host:443/db#x` | The DSN contains #, which ends a URL: percent-encode it as %23, or type the password in its own field. |
| `databend://cloudapp:pa/ss@host:443/db` | The DSN has an @ after a / or ?, which end the address part of a URL: percent-encode a /, ? or @ in the user or password as %2F, %3F or %40, or type the password in its own field, and an @ in the path or a parameter as %40. |
| `databend://host:443/db?role=analyst@corp` | The DSN has an @ after a / or ?, which end the address part of a URL: percent-encode a /, ? or @ in the user or password as %2F, %3F or %40, or type the password in its own field, and an @ in the path or a parameter as %40. |
| `databend://cloudapp@host:443/db?access_token=t` | Token and key-pair sign-in are not supported in this version: paste a DSN that signs in with a SQL user and password, or fill the fields. |
| `databend+flight://root@localhost:8900/` | Flight SQL (port 8900) is not supported: paste the HTTP DSN, databend://, for port 8000 or 443. |
| `databend+grpc://root@localhost:8900/` | Flight SQL (port 8900) is not supported: paste the HTTP DSN, databend://, for port 8000 or 443. |
| `jdbc:databend://localhost:8000/default` | This is a JDBC URL, which reads TLS and ports differently (TLS off and port 8000 by default). Paste the databend:// DSN from Connect, or fill the fields. |
| `export BENDSQL_DSN="databend://root@localhost:8000/"` | Paste the DSN itself: the databend:// text inside the quotes. |
| `databend://cloudapp@host:443/db?sslmode=require` | sslmode=require in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system. |
| `databend://cloudapp@host:443/db?sslmode=enable` | sslmode=enable in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system. |
| `databend://cloudapp@host:443/db?tls_ca_file=/etc/databend/ca.pem` | Studio reads no CA file path from a DSN, so tls_ca_file was not applied: paste the certificate's contents into the CA field under SSL / TLS. |
| `databend://cloudapp@host:443/db?sslmode=verify-full` | sslmode=verify-full is not a Databend DSN mode (BendSQL reads disable, require and enable), so SSL mode was left as it was: choose one under SSL / TLS. |

An `@` past the address part is refused even after the sign-in's own `@`, since a password can hold an unencoded `@` before its `/`; percent-encoded, as in `databend://root:pw@host:443/db?role=analyst%40corp`, the text reads one way.
`tls_ca_file` is not applied, nor is an `sslmode` other than `disable`, `require` and `enable`: each gets its caution above.
Such an `sslmode` leaves SSL mode as it was, so a DSN without a port gets the scheme's: 80 for `databend+http://` and 443 for `databend://` and `databend+https://`.
Any other parameter, `warehouse` and the sign-in ones refused above aside, is not applied either: it is named in a warning, never valued, and the other fields are filled in:

> Not applied: [names]. Studio's Databend connection takes host, port, user, password, database, warehouse and TLS; the other fields were filled in.

The SSL / TLS panel and the SSH tunnel are offered.
`readOnly: true` is refused for this type, because the provider does not enforce a read-only mode: a seed file that sets it is refused when the file loads, and a connection from the API before any provider is built.
Connect with a database role that cannot write instead.

Each field is checked when the connection opens, before any socket, and a refusal names the field and never the value:

> User is required: Databend signs in every request as a SQL user, root on a fresh self-hosted node. Nothing was sent.

> User holds a colon, which Basic authentication cannot carry; check the user name. Nothing was sent.

> User holds a control character, which Databend does not accept in a sign-in; re-enter it. Nothing was sent.

> Password holds a control character, which Databend does not accept in a sign-in; re-enter it. Nothing was sent.

> User holds a broken character, a lone UTF-16 surrogate, which cannot be sent as UTF-8; re-enter it. Nothing was sent.

> Password holds a broken character, a lone UTF-16 surrogate, which cannot be sent as UTF-8; re-enter it. Nothing was sent.

> Warehouse must be 1 to 63 letters, digits, hyphens or underscores, as the warehouse is named in Databend Cloud. Nothing was sent.

> Query timeout must be a whole number between 1 and 2147483647 milliseconds.

A field of the wrong type from a seed file or the API is refused naming the field:

> The connection's [field] must be [type]; nothing was sent.

A connection with its SSH tunnel on that arrives without the tunnel is never dialled directly:

> This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Databend was not dialled directly: the tunnel opens only when both Host and Port are set.

### 4.2 Sign-in

User and Password travel as `Authorization: Basic` on every request (section 3.9).
A refused sign-in is latched (section 3.7) and reads:

> Databend refused the sign-in for this user.

The server's own text follows as a sentence of its own, and under a password policy that locked the user, so does:

> Under a password policy, five failed sign-ins lock the user for 15 minutes for every client, and the right password is refused until then.

On Databend Cloud, or with Warehouse set, the refusal adds:

> On Databend Cloud, sign in with a SQL user of the warehouse; the console login is not a SQL user.

Through the Databend Cloud gateway a refused sign-in is a 401 of kind `AuthorizationFailed` wrapping the query node's own 401 and code, and a lockout a 500 wrapping code 2215; both are read and latched like a direct answer, as is either kind over another status, HTTP 200 included.
A refused sign-in on any request of a statement, its kill, final, ROLLBACK or logout included, is latched the same way.
A 401 with no sign-in code, on a follow-up request of a running statement, reads "Databend refused a follow-up request of this statement." and is not latched.
On the statement's own POST such a 401 refused the request before anything ran, so it reads "Databend refused the request before running it: [server text]." with the server's text cut and scrubbed as section 10 says, or "Databend refused the request before running it." when the answer carries no text, sends nothing more, and is not latched either.
A connection that signs in as `root` with no password gets a warning in the dialog:

> Credential warning: Signing in as root with no password works only when the server's root user has no password, and such a user accepts any password or none, so anyone who can reach the server signs in as its administrator. Set a password for root on the server, or connect as a user of your own.

### 4.3 TLS and the password rule

A password over no TLS is refused before any socket unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection:

> This connection would send its password to Databend without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Nothing was sent.

With SSL mode `disable` the dialog offers "Send the password without TLS"; ticked, the refusal is lifted for that connection only, and a seed writes it as `allowInsecureAuth: true`.
A DSN pasted into Paste URL unticks it (section 4.1), so it is ticked again only for the pasted host.
Databend Cloud serves HTTPS on 443 with a public certificate: choose `verify-system`.
A self-hosted query node serves plain HTTP on 8000 unless its HTTP handler is given a certificate; then choose `verify-ca` with its CA, or `verify-full` to check the host name too.
Through an SSH tunnel the certificate is checked against the tunnel's far end, never the local forward.
SSL mode `require` encrypts without checking the certificate, so an active man in the middle reads the password; a connection with a password under SSL mode `require` is told so when it opens (section 4.5).
A Databend DSN's `sslmode=require` is not this mode: it verifies the certificate, so a paste fills verify-system (section 4.1).

### 4.4 Databend Cloud: warehouse, cold start and billing

A Databend Cloud connection names its warehouse, sent as `x-databend-warehouse` on every request; a self-hosted server ignores the header unless its cluster routes by warehouse (it logs one WARN line per request, measured, UC4).
A suspended warehouse resumes on any request and is billed while it runs, and opening the connection is a request: it runs the version probe and then reads the object tree.
So with Warehouse set the provider declares `resumesBilledCompute`, and Studio sends the connection no background health checks: no connection pulse and no fleet check, only what a person asks for.
Nor does Studio open it by itself: the connection Studio makes active at sign-in or on a reload, from a link, when the server changes the connection list or when the person deletes the open connection reads nothing past its declaration, which opens no connection, until the person picks it, loads its objects, opens the Schema tab of the phone layout or runs a statement; until then the AI assistant has no schema of it, and its object tree says:

> Studio opened this connection without reading it, because any request to it can resume compute that is billed while it runs. The editor is ready to use.

A host under `databend.com`, `databend.cn` or `tidbcloud.com` is Databend Cloud's, and the provider declares `resumesBilledCompute` for it with Warehouse empty too.
BendSQL and databend-jdbc count the same three domains as Databend Cloud's when they choose their presign mode for uploads, not for billing, and Databend's Cloud guides name the service TiDB Cloud Lake in their data-integration pages; declaring the capability stops the background checks, so a host under `tidbcloud.com` that does not serve Databend loses its pulse and its fleet check, is not read when Studio makes it active by itself, and its monitoring page shows the billed-compute note; nothing else changes.
The older host form `<tenant>--<warehouse>.gw.<region>.default.databend.com` names a warehouse and reaches it with no `x-databend-warehouse` header (measured on the test tenant, 2026-10-08), so a pulse would resume it and bill it.
For such a host the sentences of this section and of section 10 name the warehouse the host carries, as they name a Warehouse, while only the Warehouse field is sent as the header; a DSN paste of that form fills Warehouse from the host unless the DSN has `warehouse=` (section 4.1).
Databend's docs show that form under `databend.com` and `databend.cn` only, so Studio reads no warehouse from a host under `tidbcloud.com`.
A probe, tree or monitoring read that outlasts its budget on a named warehouse is most likely a resume, and reads:

> Warehouse "[warehouse]" did not answer within [seconds] seconds; it may be resuming. Try again in a minute, or resume it in the Databend Cloud console.

It is a `ConnectionError`, which Studio's routes answer with HTTP 503 and the sentence itself, so the object tree, the monitoring page and Test Connection show it as written.
On the Personal plan a resume can take minutes, so a first Test Connection may meet this sentence and pass a minute later.
Measured through Studio's UI on 2026-10-08, against the test tenant's warehouse while it was suspended: two runs of `SELECT 1` about 13 seconds apart, and the tree read the first one released, met this sentence, every request of them answered HTTP 503 with it 10 or 20 seconds after it was sent, and a `SELECT 1` sent 3 minutes later answered in 979 ms.
A gateway's `ProvisionWarehouseTimeout` sends the POST again with the same ids (section 3.6).
The gateway's other refusals name the field to check:

> Databend Cloud refused the warehouse "[warehouse]": check Warehouse against the DSN on the warehouse's Connect page.

> Databend Cloud needs a warehouse: set Warehouse from the DSN on the warehouse's Connect page.

> Databend Cloud does not know this host: check Host against the DSN on the warehouse's Connect page.

A Cloud user who attaches a network policy must allow the egress IP of the server Studio runs on, not the browser's.

Measured on the test tenant (I19): the gateway forwards `x-databend-session` and `x-databend-query-id` and echoes both, and pages a result with origin-relative `next_uri` links as a local node does (25,000 rows over three pages and a final).
Its refusal is `{"error":{"kind":"<Kind>","message":"..."}}`, the kind nested under `error`, and for a refusal of the query node the message wraps that node's own status and code; the provider reads the kind nested or top-level and unwraps the wrapped status and code, never other message text.
A valid sign-in that may not run a statement is refused 403 `ForbiddenAccessUser`, which is a refusal of that statement and never latches the sign-in:

> Databend Cloud refused this statement for this user: [server text].

No `Authorization` reaching the gateway is 401 `AuthorizationRequired`; Studio always sends one (section 3.9), so something in between dropped it:

> No sign-in reached Databend Cloud: a proxy between Studio and Databend may drop the Authorization header.

After the warehouse was suspended in the console, the first `SELECT 1` from a plain HTTP client answered in 4.33 s and the next two in 0.19 s each: the gateway held the POST while the warehouse resumed, with no 503, 429 or `ProvisionWarehouseTimeout` (measured, C2).
A user granted only its own database is refused `USE default` and `USE system` there (1063), so set Database to that database.

### 4.5 Connect-time cautions

After the probe, `connect()` reads three cautions best effort, and a read that fails is no caution, never a failed connect.
They are shown as warnings of the connection:

> Database "[database]" is not in the default catalog's databases, so unqualified names will not resolve: check Database, or leave it empty.

> The user "[user]" is created with no_password, so the server accepts any password for it.

> This connection does not check Databend's TLS certificate (SSL mode require), so an active man in the middle can read the password every request sends. Choose a verify mode with the server's CA under SSL / TLS.

The `no_password` read is `system.users` for the connection's own user, which needs no grant (measured, UC2).
The TLS caution is given only to a connection with a password, since without one there is no password to read.

### 4.6 Version floor

The provider asks every answer in the `display` result mode, which Databend added in v1.2.881; an older server accepts the setting and drops it from its echo (measured on v1.2.883-nightly, L7), so nothing is refused.
When the first answer's echoed settings do not hold `http_json_result_mode` equal to `display`, the result carries one of:

> Databend did not confirm the display result mode, which servers older than v1.2.881 do not have, so Studio may show some values differently from how Databend displays them. Upgrade the server to v1.2.881 or later.

> Databend answered in the result mode "[mode]", not "display", so Studio may show some values differently from how Databend displays them.

The live check passed on v1.2.881 for everything it covers except materialized views, which v1.2.881 does not have (`DROP MATERIALIZED VIEW` is a parse error there).

## 5. Query interface

### 5.1 The request

A statement is `POST /v1/query` with a JSON body built field by field: `sql`, the `session` (its `settings`, and `database` when Database is set) and the `pagination`.

| Pagination key | Value |
|---|---|
| `wait_time_secs` | `10` |
| `max_rows_per_page` | `10,000`, or the row cut plus one when that is smaller |
| `max_rows_in_buffer` | twice `max_rows_per_page` |

Every statement pins `format_null_as_str`, `http_json_result_mode` (`display`) and `binary_output_format` (`hex`), and sends the query timeout as `max_execute_time_in_seconds`.
A statement Studio writes itself (the tree, describe, source, monitoring and the probe) also pins `sql_dialect` (`PostgreSQL`), `quoted_ident_case_sensitive` and `timezone` (`UTC`), all seven of them, whatever the user's global settings say; a user statement runs under the server's own dialect and time zone.
The live check read every pinned setting back from the server's echo on both builds.

The connection's headers are `authorization`, `accept`, `user-agent` (`libredb-studio/<version>`, never a browser word, which Databend reads as its worksheet mode), `x-databend-client-caps` (`session_header`, which asks for the client session) and, with Warehouse set, `x-databend-warehouse`.
A request may add only `x-databend-session`, `x-databend-query-id`, `x-databend-route-hint` and `x-databend-sticky-node`, the closed list the shared transport enforces.
`POST /v1/session/logout` ends a session that holds a temporary table (section 3.5).

### 5.2 The statement guard

Every statement a person sends, Run and the Explain button included, passes `databendStatementRefusal` before any request; the tree, monitoring and the probe send only statements Studio writes itself.
It reads the text under the Databend grammar row and refuses, with these sentences:

| Statement | Refusal |
|---|---|
| `SELECT 1; SELECT 2` | Databend runs one statement per request, and when the first is an INSERT or REPLACE it drops the rest without an error. Run the statements one at a time. |
| `INSERT INTO t VALUES (1); DELETE FROM t` | Databend runs one statement per request, and when the first is an INSERT or REPLACE it drops the rest without an error. Run the statements one at a time. |
| `-- only a comment` | There is no statement to run: the text holds only comments. |
| `SELECT 'x` | A quote or comment in this text never closes, so Studio cannot tell where the statement ends. |
| `SELECT 1 -- c\fSELECT 2` | This text holds a form feed, which ends a -- comment in Databend but not in Studio's reading. Remove it and run again. |
| `SELECT $a$ x $a$` | A dollar-quoted run in this text is tagged ($name$), which Databend reads as a variable and not a quote, so the text between two tags is code there and Studio cannot tell where the statement ends. Use $$ quoting and run again. |
| `SELECT a$$x$$` | A $$ run in this text follows a name with no space, which Databend reads as part of the name and not a quote, so Studio cannot tell where the statement ends. Put a space before the $$ and run again. |
| `SELECT * FROM @s\'; DROP TABLE t; --'` | A stage name (@...) in this text holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, so Studio cannot tell where the statement ends. End the name with a space, or write the location quoted ('@stage/path') where the statement takes one, and run again. |
| `SELECT 1 FROM @s--;DROP TABLE t` | A stage name (@...) in this text holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, so Studio cannot tell where the statement ends. End the name with a space, or write the location quoted ('@stage/path') where the statement takes one, and run again. |
| `SELECT 1 FROM @s/*;DROP TABLE t;*/` | A stage name (@...) in this text holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, so Studio cannot tell where the statement ends. End the name with a space, or write the location quoted ('@stage/path') where the statement takes one, and run again. |
| `SELECT 2<<@s--;SELECT 3 AS hidden` | A stage name (@...) in this text holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, so Studio cannot tell where the statement ends. End the name with a space, or write the location quoted ('@stage/path') where the statement takes one, and run again. |
| `SELECT /*+ ; */ 1` | An optimizer hint (/*+ ... */) in this text holds a semicolon, which Databend reads as code and Studio as a comment. Remove the semicolon from the hint and run again. |
| `/*+ ' */ SELECT 1 AS shown -- ' */ SELECT 2 AS hidden` | An optimizer hint (/*+ ... */) in this text holds a character that can make Databend end the hint at a later */ than Studio does, so Studio cannot tell which statement runs. Keep the hint to names, numbers and plain quoted values, and run again. |

The form feed row's `\f` stands for the character itself.
Each stage row is one statement to Studio and, without the guard, a stage token, a `;` and a second statement to Databend.
Databend's stage token runs to the first Unicode white space, comma, semicolon, quote or parenthesis, and takes `\'`, `--`, `/*`, a dollar quote and a bracket into the name, where Studio's reading opens a quote, a comment, a literal or an array that can end past it (measured on v1.2.951: `SELECT 1 FROM @s--;DROP TABLE t` is "unexpected `DROP`" at the DROP).
A stage name a space ends passes: `SELECT * FROM @s -- note` is sent.
An `@` that ends the JSON operator `<@` opens no stage name, because Databend's lexer takes the longest token: `SELECT parse_json('[1]')<@/*c*/parse_json('[1,2]') AS r` is sent, and answers true.
The lexer reads a run of `<` in pairs from its start, so after `<<` the `@` opens a stage name, as in the last stage row (measured on v1.2.951: that row is "unexpected `SELECT`" at its second SELECT).
The rows from the form feed down are refused inside an array literal too, whose contents are code to both readers.
The last row is the measured case: without the guard Databend ends the hint at the second `*/` and answers `hidden`, a statement the confirmation gate never saw.
A plain hint passes: `SELECT /*+ SET_VAR(timezone='UTC') */ now()` is sent.
Databend's backslash escapes are a fact of the grammar row (`backslashAlwaysEscapes`), so a backslash before a quote never ends a literal in Studio's reading either, and a backslash before a line feed inside a literal leaves it unterminated, as Databend's lexer does ([S2](../BACKLOG.md)).

### 5.3 The Databend grammar

The statement splitter, the row limiter, the confirmation gate, the guard and the EXPLAIN screen read text under one grammar row, `DATABEND_GRAMMAR` in `src/lib/sql/grammar.ts`.

| Field | Value | Why |
|---|---|---|
| `hash` | `"code"` | `#` starts no comment |
| `bracket` | `"subscript"` | brackets build and index arrays and never quote a name |
| `blockComment` | `"flat"` | a `/* */` comment does not nest |
| `alternateQuoting` | `false` | no `q'[...]'` form |
| `doubleSlashComment` | `false` | `//` starts no comment |
| `backslashAlwaysEscapes` | `true` | a backslash escapes the next character inside `'...'` and `"..."`, the first shipped row to declare it |
| `script` | `{"blocks":"none","separatorLine":null,"unit":"statement"}` | the default: no procedural block and no separator line, so every code `;` ends a statement |
| `trailingLimitClauses` | `["\\s+FORMAT\\s+\\w+\\s*$"]` | a trailing `FORMAT <name>` must follow the row bound, so the limiter appends `LIMIT` before it (measured, L3: `SELECT 1 FORMAT JSON LIMIT 5` is a parse error) |

A top-level `SELECT TOP n` is a bounded statement to the shared limiter, so no `LIMIT` is appended to it: Databend refuses `TOP` and `LIMIT` together (L3).

### 5.4 Result shape

In the `display` result mode every cell arrives as text or null, and the grid value is read from the column's declared type, with one outer `Nullable(...)` stripped for the read and the declared type kept verbatim in `columnTypes`.
`Boolean` `1` and `0` are true and false; an integer type is a number when it is a safe integer, else its exact text, so an `Int64` or `UInt64` from 2^53 up is never rounded; `Float32` and `Float64` are numbers when finite, and `NaN` and the infinities stay text.
Every other type (Decimal, dates, timestamps, intervals, String, hex Binary, geo types, Variant, Array, Map, Tuple, Vector, Bitmap) is its text verbatim; a nested NULL there is a bare `NULL`.
A `Timestamp` is shown in the server's global time zone without an offset, and a `Timestamp_Tz` with its offset.
Columns are named through `uniqueFieldNames`, so a repeated name gets a suffix and an empty one becomes "(No column name)", and rows are keyed by position.
A DML statement answers one row in a `UInt64` column `number of rows inserted`, `updated` or `deleted`; its count is the result's row count, as Trino reports an update count, and the row is kept.
The result's row count is a number, so a count from 2^53 up is the nearest one, which can be off in its last digits, while the kept row holds the exact count as text.
Studio's own reads take a figure the same way: an object's row count and size in the tree and the monitoring panels' counts, sizes and durations are exact below 2^53 and the nearest number from 2^53 up.
DDL answers no result set.

### 5.5 Session state does not carry over

Because each statement runs in a session of its own (section 3.4), a statement that changes its session gets a warning:

> USE succeeded, but each statement runs in its own session, so it does not carry over. Set Database on the connection, or qualify names.

> Each statement runs in its own session, so a session-level SET or UNSET does not carry over. SET GLOBAL and UNSET GLOBAL change the setting for every session.

> SET GLOBAL changed [setting] for every session, and the change persists.

> SET ROLE does not carry over to the next statement.

The role warning appears when the echoed role differs from the one the connect probe saw.
A server warning, such as the one for a setting name the server ignores, is shown as it is, through `serverText`.

### 5.6 EXPLAIN is the planning form only

The Explain button and the automatic estimate both send plain `EXPLAIN <statement>`, never `EXPLAIN ANALYZE`, which runs the statement and bills a full run.
Plain `EXPLAIN` still runs some subqueries while it binds: a subquery in a table function's argument, a PIVOT value subquery and a MATERIALIZED CTE (measured on v1.2.951, L5: `EXPLAIN SELECT * FROM numbers((SELECT nextval(s)))` moved the sequence, and `set_cache_capacity` nested in an argument subquery moved a cache's capacity).
A MATERIALIZED CTE executes under EXPLAIN when a client session is present, which Studio always sends, and its temporary table does not outlive the statement.
Derived tables and `IN` or `EXISTS` subqueries bind without executing.
So the strategy offers a plan only for a SELECT-shaped statement and declines the shapes that can run while binding; "Estimate" below is the automatic estimate, "Explain" the button:

| Statement | No plan in |
|---|---|
| `SELECT * FROM numbers(3)` | Neither |
| `SELECT * FROM (SELECT 1) d` | Neither |
| `SELECT * FROM t WHERE a IN (SELECT a FROM u)` | Neither |
| `SELECT * FROM numbers((SELECT count(*) FROM t))` | Estimate |
| `SELECT * FROM t WHERE a IN ((SELECT a FROM u))` | Estimate |
| `SELECT * FROM numbers((SELECT nextval(s)))` | Both |
| `SELECT nextval(s)` | Both |
| `WITH t AS MATERIALIZED (SELECT 1 AS a) SELECT * FROM t` | Both |
| `SELECT * FROM t PIVOT (sum(a) FOR b IN (SELECT b FROM u))` | Both |
| `SELECT * FROM fuse_vacuum2()` | Both |
| `SELECT /*+ SET_VAR(timezone='UTC') */ 1` | Both |
| `SELECT $a$ x $a$` | Both |
| `SELECT * FROM @~/--, numbers((SELECT nextval(s)))` | Both |
| `SELECT parse_json('[1]')<@/*c*/parse_json('[1,2]') AS r` | Neither |
| `SELECT 'x` | Both |
| `INSERT INTO t SELECT 1` | Both |

The estimate declines a subquery at parenthesis depth 2 or more, which is where a table function's argument sits; a depth-1 subquery nested in another parenthesis is declined too, which costs a plan and runs nothing.
The Explain button sends an argument subquery that names none of the words below, so the binder runs that read.
The names that decline both modes, as a word or a quoted name, are `MATERIALIZED`, `PIVOT`, `NEXTVAL`, `FUSE_AMEND`, `SET_CACHE_CAPACITY`, `FUSE_VACUUM2`, `FUSE_VACUUM_TEMPORARY_TABLE`, `FUSE_VACUUM_DROP_AGGREGATING_INDEX`, `FUSE_VACUUM_DROP_INVERTED_INDEX`, `SYNC_CRASH_ME`, `ASYNC_CRASH_ME`, `USER_TASK_CANCEL_ONGOING_EXECUTIONS` and `TASK_DEPENDENTS_ENABLE`.
A form feed, an optimizer hint, a tagged dollar run, a stage name holding a backslash or running into a comment, a dollar quote or a bracket, and a run that never closes decline both modes, as the guard refuses them on Run.
An `@` that ends a `<@` operator opens no stage name here either.
Without the decline and the guard, the stage row's subquery runs hidden: measured on v1.2.951, `EXPLAIN SELECT * FROM @~/--, numbers((SELECT count(*) FROM numbers(7)))` planned a `numbers` scan of 7 rows, so Databend ran the argument subquery that Studio reads as a comment after the user stage `@~/`.
Over the generated queries of the other dialects, 3 of 50 SELECT-shaped texts got no estimate, all three the SQL Server row's bracketed names, which Databend reads as code.
When the Explain button declines a statement that leads with SELECT or WITH, its toast says why in one of these sentences, [word] being MATERIALIZED or PIVOT, [construct] a MATERIALIZED CTE or a PIVOT, and [name] the declined name in lower case; the automatic estimate declines without a word:

> This statement names [word], and Databend can run part of a statement with [construct] while it plans it, so Studio does not ask Databend for this statement's plan.

> This statement names [name], which writes or acts when Databend runs it, and Databend can run part of a statement while it plans it, so Studio does not ask Databend for this statement's plan.

> This statement has an optimizer hint (/*+ ... */), which Databend reads as code and Studio as a comment, so Studio cannot check what Databend would run while planning it and does not ask Databend for this statement's plan.

> A stage name (@...) in this statement holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, so Studio cannot check what Databend would run while planning it and does not ask Databend for this statement's plan.

> This statement holds a form feed, which ends a -- comment in Databend but not in Studio's reading, so Studio cannot check what Databend would run while planning it and does not ask Databend for this statement's plan.

> A dollar-quoted run in this statement is tagged ($name$), which Databend reads as a variable and not a quote, so Studio cannot check what Databend would run while planning it and does not ask Databend for this statement's plan.

> A quote or comment in this statement never closes, so Studio cannot check what Databend would run while planning it and does not ask Databend for this statement's plan.

The first two name a word the statement holds anywhere in its code, a column or an alias included, not a construct Studio found.
The hint, form feed and tagged run sentences end with the advice below only when the statement with that one hint or form feed taken out, or that run quoted with `$$`, would get a plan; otherwise the sentence stands alone:

> Remove the hint to see the plan.

> Remove the form feed to see the plan.

> Use $$ quoting to see the plan.

A statement that leads with neither is told that only SELECT statements can be explained, and after any decline the Explain tab shows no plan, never the plan of the statement before.
The plan is drawn as a tree from the one `explain` column, a node's properties as its detail and `estimated rows` as its row estimate; the raw tab shows the text as Databend printed it.

### 5.7 What the SQL INSERT export writes

The SQL INSERT export writes each value as a Databend literal: hex `Binary` through `unhex`, `Variant` through `parse_json`, and the integers and floats exactly, `NaN` and both infinities included.
A cell of a type Databend has no literal for (`Array`, `Map`, `Tuple`, `Bitmap`, `Interval`, `Geometry`, `Geography`, `Vector`) skips its row, named by row and column in a comment, so no row is written in a wrong form; a NULL cell of those types replays.
The comment names the type by its outer name, with `Nullable` unwrapped and its arguments dropped (`Map` for `Nullable(Map(String, Int32))`), cut at 64 characters, and the column name and the type have every character outside printable ASCII replaced by `?`, because both are the server's own text and a line break in either would end the comment and put the rest in the file as a statement.
Measured by the live check: every row of the every-type table replayed equal or was skipped by name on both builds.

### 5.8 Cancellation and deadlines

Stop sends the statement's kill link; the run reads as cancelled only when the kill answered 200 with no gateway refusal in its body, or an answer reported code 1043:

> The query was cancelled.

A kill that does not answer reads:

> Studio asked Databend to stop the statement and got no answer, so it may still finish.

A cancel before the first answer can miss a statement that is already running, so a kill answered 404 is sent again at 250, 500 and 1,000 ms, and the run reports that the statement may have run, with "cancelled before its first answer" as the cause.
A Stop or the deadline while the POST waits to be sent again after a Databend Cloud `ProvisionWarehouseTimeout` sends no kill and no logout, and the run reads as cancelled or timed out, since the gateway forwarded none of the attempts (section 3.6).

Stop also ends the editor's wait for the run's own answer, so the editor reads the outcome from the cancel route, which waits for the stopped run to end, at most 15 seconds, the 5 seconds each of the kill, ROLLBACK and logout it may still send.
The route answers `cancelled: true` only when the run read as cancelled, or was stopped before anything was sent, and the editor shows "Query Cancelled".
A kill that got no answer, a kill Databend refused and a statement that finished before the kill reached it answer `cancelled: false`, and the editor shows "Cancel Not Confirmed": the statement may still be running, or it finished first.

The query timeout is sent as `max_execute_time_in_seconds` and is also Studio's deadline; when it passes Studio kills the statement, and when Databend acknowledged the kill, or an answer reported code 1043, the run reads:

> The statement did not finish within [seconds] seconds, so Studio cancelled it.

A statement Studio writes itself (the tree, describe, source, monitoring and the probe) reads so at its deadline whatever the kill answered, before or after its first answer, since checking before running it again means nothing for Studio's own statements; on a named warehouse it reads as the resuming sentence of section 4.4 instead.
For a user statement, after the first answer, a kill that Databend did not acknowledge leaves the outcome unknown, as it does for Stop:

> The statement did not finish within [seconds] seconds, and Databend did not acknowledge Studio's request to stop it, so it may still finish: check before running it again.

With no first answer by then the cause reads "no first answer within [seconds] seconds".
The first of these sentences reaches a caller of the provider itself, such as an embedded host's route; Studio's own routes answer it with HTTP 408 and their own sentence, "Query timed out. Please try a simpler query or increase timeout.", and Chromium sends a POST answered 408 on a kept-alive connection again, so in the browser a statement that reaches its deadline can run up to three times, each with its kill ([X27](../BACKLOG.md)).
A statement that waits for a statement slot longer than its deadline sends nothing:

> Studio's Databend statement slots stayed busy for [seconds] seconds, so nothing was sent. Try again when a running statement finishes.

The resuming sentence of section 4.4 and the slot wait above are no statement's timeout: each is a `ConnectionError`, which Studio's routes answer with HTTP 503 and the sentence itself.

## 6. Schema introspection

### 6.1 The tree

The tree has two container levels, Catalog and Database, and four object kinds, each read from the catalog's own `system.tables` by its `table_type`: `table` (`BASE TABLE`), `view` (`VIEW`), `materialized_view` (`MATERIALIZED VIEW`) and `dynamic_table` (`DYNAMIC TABLE`).
Catalogs come from `system.catalogs`, and a catalog's databases from its own `system.databases` without `system` and `information_schema`; the session's database is marked in the default catalog.
An object's row count and size come from `system.tables`, the nearest number from 2^53 up (section 5.4), and a materialized view is listed with neither, since its row there says 0 rows and 0 bytes whatever it holds (measured on the pinned image).
One statement counts every kind of a database; a `table_type` spelling no kind is read from is raised by name, never dropped:

> Databend reported an object of table_type "[type]", which Studio has no object kind for.

A kind that is not declared is refused:

> Databend has no object kind "[kind]" in Studio.

A table's columns come from `system.columns` in declared order (measured, L1), and its search indexes from `default.system.indexes`, which describes the default catalog only; there is no primary key (Databend refuses every `PRIMARY KEY` form, L11) and no foreign key.
`describeObjects` reads every column of a kind in one statement, measured to keep each object's rows contiguous and in declared order (L2), and refuses a bad bound:

> A Databend bulk column read limit must be a positive whole number, received [limit].

`system.columns` answers no rows, silently, for a view that no longer plans, such as one whose base table was dropped, so the names come from `system.tables` and such a view is never handed over as complete with no columns:

> Databend lists no columns for "[object]", as it does for a view that no longer plans, so Studio shows no column list rather than an empty one.

A bulk read leaves it out and says so in its truncation reason: "Databend listed no columns for "[object]", as it does for a view that no longer plans, so it was left out".
A materialized view's `system.columns` rows include its internal `_mv_source_row_id`, which `SELECT *` does not show and a select of it refuses, so it is left out for that kind only.
A read the statement budget cut is never handed over as complete:

> Databend's answer to the [surface] reached Studio's statement budget of 16,777,216 bytes of answer text, so Studio shows none of it rather than part of it.

A bulk read instead drops the partly read last object and says "the bulk column read stopped at Studio's statement budget of 16,777,216 bytes of answer text, so the object it was reading was left out"; the bound is named in the unit it reached, rows, cells or bytes of answer text.

### 6.2 Object source

Every kind has a source, labelled "Definition".
A table, view or dynamic table is read with `SHOW CREATE TABLE <catalog>.<database>.<name> WITH QUOTED_IDENTIFIERS`, which quotes every name so the DDL re-runs; provider statements run under the PostgreSQL dialect, so the names are double-quoted.
A materialized view is read with `SHOW CREATE MATERIALIZED VIEW`, since `SHOW CREATE TABLE` refuses one with 1302, and its DDL comes back with backticks (L6).
The part is `regenerated` and `complete`, since the DDL runs as given, and a caller's character bound marks it truncated without changing its form.
The DDL is the answer's one row, which the statement budget keeps or drops whole and never cuts, so a definition read that reached the budget is refused rather than shown, as the reads of section 6.1 are:

> Databend's answer to the definition reached Studio's statement budget of 16,777,216 bytes of answer text, so Studio shows none of it rather than part of it.

An object Databend does not hold is Databend's own error, 1025 for a table and 1003 for a database (measured on the pinned image), and an answer with no definition text is raised naming the object, never shown as a part:

> Databend answered no definition for "[object]".

Databend lists an object in `system.tables` for any grant on it, or on its database other than `USAGE` alone, while `SHOW CREATE` needs `SELECT` on the object, or for a materialized view on its source table (its `visibility_checker.rs` and `privilege_access.rs`), so it can refuse the definition of an object the tree lists, with 1063.
That refusal is the part, never a raise: it holds Databend's own words in place of a definition, withheld when they hold the password and cut at 300 characters, as a refusal's text is (section 10).
Measured on the pinned image, `studio_reader` reading `studio_demo.notes` is refused with `Permission denied: privilege [Select] is required on 'default'.'studio_demo'.'notes' for user 'studio_reader'@'%' with roles [public,studio_ro]`.

### 6.3 Object edit (#789): not in this version

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: object edit is not implemented in this version, and Databend declares no key, so a row edit would have no row identity.
The absence is `databend`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` holds that entry and this section together.
Databend has `ALTER TABLE ... MODIFY COLUMN`, which changes type, nullability and comment with the data kept (L8); the schema-diff generator does not emit it, because its MySQL spelling fails `NOT NULL` on an empty table and drops a default it does not restate.

## 7. Monitoring & health

Every panel is a provider statement under the surface deadline, and every read covers the default catalog only: walking every external catalog for one panel would cost a statement per catalog.
When Databend answers one of the codes 1003, 1025, 1063, 1112, 1119 or 1002 (an unknown database, an unknown table, a permission denied, a licence denied, an unknown catalog, not implemented), the panel is empty; any other error propagates, so a timeout is never hidden behind an empty panel.

- Overview: the version is `version()`; uptime is "unknown" and the connection limit 0, because Databend publishes neither; the size is the compressed data plus index size of the default catalog's base tables, "N/A" when that read degraded; the active count is the running statements of `system.processes`, Studio's own statements left out (below).
- Sessions: one row per running statement of the server or warehouse, every user's included, from `system.processes`, which needs no grant, since Databend creates a session per HTTP request.
  The kill target is the row's session id.
  Its state is "active" while it runs a statement (`command` `Query`), the word the Active card and the Overview count, and "aborting" (`Aborting`) while a `KILL CONNECTION` or a server shutdown ends its session; the panel's own kill, a `KILL QUERY`, leaves it "active" until the statement stops.
  Databend's query id of the statement is not shown: a session row of the panel has no field for one.
  Studio's own statements are left out (below).
- Slow queries: `system_history.query_history`, the finished statements of the last 24 hours, slowest first.
- Table and storage statistics: the default catalog's base tables, largest first, and one row per database.
- Index statistics: `default.system.indexes`; no size per index and no scan counter exist, so the size is "N/A" and the scans 0.
- Performance: every figure absent, never a fabricated zero.
- Health: the overview, the 10 slowest queries and 10 sessions; the cache hit ratio is "N/A".

Studio reads the panels at once, two statements at a time, so `system.processes` lists Studio's own statements beside the ones the panels are for: the reading one, a sibling panel's read, the object tree's.
The Sessions panel and the active count leave out, by the query id it was sent under (`current_query_id`), every statement this Studio process wrote itself and had in flight while the read ran: a tree, describe, source, connect, monitoring or kill statement, from before its request until its last close ended.
Studio generates each query id from a random UUID, so another client can neither predict one nor run a statement under one while Studio's runs: measured on the pinned image, a statement another user sent under a running statement's query id was refused with `query_id [query id] already exists`, and one the same user sent started nothing.
Nothing is matched on statement text, so a user's statement is listed and counted whatever it says, the editor's statements included, and so is every statement of another Studio process, its monitoring reads included.
The row's `id`, the kill target, is a session id Databend makes for each request, not the client session id Studio sends: measured on the pinned image and on v1.2.881, a running statement was listed under an `id` other than its client session id, and under its own query id as `current_query_id`.
The Sessions panel asks Databend for 2 rows past its limit, as many statements as Studio runs at once, so that leaving Studio's own out still fills it, and shows at most its limit.
The active count reads the query ids of the 500 newest running statements beside Databend's count of them all, so the count is whole past 500, and leaves Studio's own out only among those 500.
The empty states and caption say what each list covers:

On the measured Cloud tenant `system_history.query_history` answered 1003, so the slow-query panel was empty there.

> Query stats come from system_history.query_history, which needs Databend's history tables (not every Databend Cloud tenant has them) and GRANT SELECT ON system_history.*, and fills in batches, so the newest statements arrive late.

> No statement is running: this list covers every user's running statements on the server or warehouse, not only this connection's.

> The base tables of the default catalog, largest first; other catalogs are not read.

With Warehouse set, or on a Databend Cloud host, no pulse or fleet check runs (section 4.4); a panel opened by a person resumes the warehouse like any other request.

## 8. Maintenance

The one operation is "Kill Query": `KILL QUERY '<session id>'` on a session the Sessions panel lists, which stops that session's current statement and needs the global SUPER privilege.
The target is the session id, not the HTTP query id, which `KILL QUERY` answers 1053 for; it is checked before a statement is built:

> Stopping a statement needs its session id, which the Sessions panel lists.

> A Databend session id is 1 to 64 letters, digits and hyphens, as the Sessions panel lists it.

A kill Databend accepts is answered with the provider's own message, which the maintenance route returns to its caller:

> Asked Databend to stop the current statement of session [session id].

The Sessions panel does not show that message, and words a kill its own way for every engine ([U98](../BACKLOG.md)).
Its kill button opens a "Terminate Session?" dialog, which says the action "will forcefully end the connection and may cause data loss if the session has uncommitted transactions", and a kill that went through is toasted "Session [session id] terminated successfully".
On Databend the session is not ended: only the statement it is running is stopped, and a session of another client, such as BendSQL, runs its next statement.

The panel offers the kill to every Studio admin, whatever the connection's SQL user holds.
Without SUPER, Databend refuses the kill with 1063 before it looks for the session, the statement keeps running, and an error toast shows Databend's refusal as Databend wrote it.
Measured on the pinned image, `studio_reader`'s kill of another session's statement is refused with `Permission denied: privilege [Super] is required on *.* for user 'studio_reader'@'%' with roles [public,studio_ro]. Note: Please ensure that your current role have the appropriate permissions to create a new Object`, and the statement finished as if no kill had been sent.
On Databend Cloud a SQL user whose roles do not hold SUPER was refused the same way (measured on 2026-10-08), so a kill from the Sessions panel needs a SQL user granted it, for example through `GRANT SUPER ON *.* TO ROLE <role>`.
With SUPER granted to its role, the panel's kill stopped a running statement on the test tenant, and that statement's editor read "Aborted query, because the server is shutting down or the query was killed." (measured on 2026-10-08).
Stop in the editor needs no privilege: it sends the statement's own kill link in the statement's own session (section 5.8).

Any other operation sends nothing:

> Databend has no "[operation]" operation in Studio: the only one it runs is stopping a session's current statement (kill).

The analyze and vacuum cards are never drawn, and are worded true all the same:

> Databend refreshes table statistics with ANALYZE TABLE, which Studio does not send; run it in the editor.

> Databend's VACUUM TABLE removes data files past the Time Travel retention period, which Studio does not send; run it in the editor.

## 9. Capabilities & labels

| Capability | Value |
|---|---|
| `queryLanguage` | `"sql"` |
| `defaultPort` | `8000` |
| `supportsExplain` | `true` |
| `explainFormat` | `"databend-text"` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsResultPagination` | `true` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` |
| `supportsTestDataGeneration` | `false` |
| `supportsTransactions` | `false` |
| `declaresForeignKeys` | `false` |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `["kill"]` |
| `supportsConnectionString` | `false` |
| `identifierQuoting` | `"backtick-always"` |
| `containerPathShapes` | `"exact"` |
| `READ_ONLY_ENFORCED` | `false` |
| `MCP_EXPOSABLE` | `true` |
| `READS_FILE_ACCESS_POSTURE` | `false` |
| `CONNECTION_STRING_ACCEPTED` | `false` |

`containerLevels` are Catalog and Database, and `objectKinds` are `table`, `view`, `materialized_view` and `dynamic_table`, each with columns and a SQL source.
`resumesBilledCompute` is declared when Warehouse is set or the host is Databend Cloud's (section 4.4).
`schemaRefreshPattern` re-reads the tree after a statement that leads with `CREATE`, `DROP`, `ALTER`, `RENAME`, `UNDROP`, `TRUNCATE` or `REPLACE`.
MCP's metadata tools and plan mode work; agent execution and MCP `run_read_query` do not run a statement on this type ([B103](../BACKLOG.md)).
Import Data has no target on Databend: Studio draws the IMPORT control for every connection, and its dialog writes only into an existing object of a kind that declares `acceptsRowWrites`, which no Databend kind does (section 6.3), or into a table it creates, which `supportsCreateTable: false` withholds, so it offers only Close and says:

> Studio's import has no target on this connection: it offers no existing table here to write into and cannot create one.

Load rows with `INSERT` or `COPY INTO` in the editor instead.

| Label | Value |
|---|---|
| `entityName` | Table |
| `entityNamePlural` | Tables |
| `rowName` | row |
| `selectAction` | Select Top 50 |
| `generateAction` | Generate Query |
| `analyzeGlobalTitle` | Not Run from Studio |
| `vacuumGlobalTitle` | Not Run from Studio |

## 10. Error handling

Classification reads Databend's code, the gateway's kind, the HTTP status, the transport's failure kind and Studio's own cancel and deadline state, never message text.
Every server text passes `serverText` with the connection's secret forms (the password and `user:password`) before any sentence is built from it, and is cut afterwards: 300 characters of a refusal, 1,000 of a statement error, so a text that holds a form is withheld whole and never shown in part.

| What happened | What Studio says |
|---|---|
| An in-body error over HTTP 200 | the server's text, and the results panel shows it under "The query failed."; when the text points into the statement with `--> SQL:<line>:<col>`, Databend's own excerpt in it marks the position with a caret, the editor marks nothing, and the error carries it as `position`, the character it names counted from 1 (8 for `SELECT nope`), which the query route returns in its answer's `details` |
| An in-body 1003 unknown database on a user statement | the server's text, then "Database is the current database for unqualified names: check it, or leave it empty." |
| A fail-to-start answer (nothing ran) | the server's text, then "Nothing ran." |
| A sign-in refused, or locked | Databend refused the sign-in for this user. (section 4.2) |
| A latched sign-in | Databend refused this sign-in at [time] UTC, so this Studio server will not send this password again before [until] UTC, or until it changes. |
| A follow-up request refused 401 with no sign-in code | Databend refused a follow-up request of this statement. |
| A Cloud statement refused `ForbiddenAccessUser` | Databend Cloud refused this statement for this user: [server text]. |
| A Cloud request with no sign-in, `AuthorizationRequired` | No sign-in reached Databend Cloud: a proxy between Studio and Databend may drop the Authorization header. |
| A middleware 400, or the POST refused 401 with no sign-in code | Databend refused the request before running it: [server text]. |
| A middleware 400, or the POST refused 401 with no sign-in code, with no server text | Databend refused the request before running it. |
| A gateway's warehouse or host refusal | the sentences of section 4.4 |
| A 503 or 429 on a GET past its retries, with no warehouse named | Databend did not answer within [seconds] seconds ([cause]). Try again in a minute. |
| No answer to the POST | No answer arrived from Databend ([cause]). If the request reached it, Databend may have run the statement: check before running it again. |
| Any other non-200 answer | Databend answered HTTP [status] before the statement finished: [server text]. |
| An answer that breaks the protocol | Databend's answer did not follow its HTTP protocol ([fault]), so Studio stopped and cancelled the statement. |
| TLS | [transport error]. Self-hosted Databend serves plain HTTP on 8000 unless TLS is configured: set SSL mode to disable, or enable TLS on the query node; a certificate error means the CA or host name does not match. |
| Unreachable, on a probe or a tree read | The server at [host]:[port] did not answer Databend's HTTP API ([cause]). It listens on 8000 self-hosted and 443 on Databend Cloud; 3307 (MySQL) and 8900 (Flight SQL) are not used. |
| Stop, and the deadline | the sentences of section 5.8 |

With Warehouse set, or on an older Databend Cloud host that names its warehouse (section 4.4), the no-answer sentence of the POST, of a dropped connection and of a stop before the first answer adds "A suspended warehouse may still be starting.", and a 503 or 429 on a GET past its retries reads as the resuming sentence of section 4.4.
A user statement whose connection drops gets the no-answer sentence rather than the unreachable one, because the statement may have run.
The [fault] of the protocol sentence is one of: "a 200 answer that is not JSON", "a body that does not parse as JSON", "a key named __proto__", "the field [field] of the wrong type", "a cell that is neither text nor null", "a row of [cells] cells for [columns] columns", "a link Studio does not follow", "a next_uri link of a shape Studio does not follow", "an answer for another statement", "an answer for another session", "an answer for another session; a proxy may drop the X-DATABEND-SESSION header", "a later page with another schema" and "more answers than one statement may take".
An answer past a bound of section 3.10 names what was too large: "more rows than the page Studio asked for", "a schema larger than a result can keep", "more values than one answer may hold" or "nesting deeper than one answer may have".
Each category becomes a house class at the provider's boundary: `auth` an `AuthenticationError`, `config` a `DatabaseConfigError`, `timeout` a `TimeoutError`, `cancelled` a `QueryCancelledError`, a statement error or a too-large answer a `QueryError`, and the rest a `ConnectionError`.
Studio's own read that outlasts its deadline on a named warehouse, and a statement that waited for a statement slot past its deadline, are `unavailable`, as a gateway's `ProvisionWarehouseTimeout` is, so Studio's routes show their sentences with HTTP 503 rather than the sentence of a timeout (section 5.8).

## 11. Testing

### 11.1 How the tests work

The unit tests in `tests/unit/db/databend/` drive each module on its own, and the transport tests run it over a scripted node transport with injected time, so no test waits on a real timer.
The wire tests (`wire.test.ts`, `wire-tls.test.ts`, `wire-bounds.test.ts`, `wire-retry.test.ts`) run the transport over the real shared transport against a local `node:http` or `node:https` server that replays the committed captures.
`tests/integration/db/databend-provider.test.ts` drives the provider over the captures of `tests/fixtures/databend/`, written by `tests/live/databend-evidence.ts` against the local fixture and scrubbed of every id, address and credential; [`tests/fixtures/databend/README.md`](../../tests/fixtures/databend/README.md) says what each holds.
This file's quotes, bounds, settings, grammar fields, capabilities and labels are read back from the code by `tests/unit/db/databend/provider-doc.test.ts`.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/integration/db/databend-provider.test.ts
bun tests/run-tests.ts tests/unit/db/databend/provider-doc.test.ts
bun run test
```

### 11.3 The live check

`tests/live/databend-live-check.ts --target <name>` runs every scenario through a real `DatabendProvider` against a running server, and writes only to `studio_demo` and `libredb_demo`.
On a local server S7 also creates the user `studio_scratch` under the password policy `studio_scratch_policy` for its one wrong password, and drops both before it ends; on Databend Cloud it creates no user.
On 2026-10-08 it passed 22 of 22 checks on the pinned v1.2.951-nightly and 21 of 21 on v1.2.881, by digest; the cold start was skipped on both, since it needs a warehouse to suspend, and the materialized-view check on v1.2.881, which has none.
It covered DDL, DML and MERGE in `studio_demo`; 100,000 rows over 10 pages; a statement past the 16 MiB budget of answer text cut and marked limited; Load More; an unknown table and a syntax error with its position; a wrong password latched so that a second instance sent no request; a cancel and a server deadline, each with one kill answered 200; a lone `BEGIN` rolled back; `USE` and the session echo; the seven pinned settings echoed as sent; a least-privilege user refused a write; the tree, columns and DDL of a table, a materialized view and a view over a dropped table; and the every-type export replay of section 5.7.
On Databend Cloud, on 2026-10-08, it passed 22 of 22 checks on a test tenant of the same build through the gateway, the 100,000 rows and the 16 MiB budget included, as a user that owns `studio_demo` through its role; the cold start was skipped, since the tenant's SQL user may not suspend its warehouse, and multi-node paging is not run yet.
[`docker/databend/README.md`](../../docker/databend/README.md) has the commands, the floor build's included.

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from "@/lib/db/factory";

const provider = await createDatabaseProvider({
  id: "databend-cloud",
  name: "Databend Cloud",
  type: "databend",
  host: "<tenant host from Connect>",
  port: 443,
  user: "cloudapp",
  password: process.env.DATABEND_PASSWORD,
  warehouse: "<warehouse from the DSN>",
  ssl: { mode: "verify-system" },
  createdAt: new Date(),
});

await provider.connect();
const result = await provider.query("SELECT number FROM numbers(10)");
console.log(result.fields, result.rows.length, result.executionTime);
const tables = await provider.listObjects(["default", "default"], "table");
await provider.disconnect();
```

### 12.2 Running Databend for Studio

`database-compose.yml` holds `databend-http` (127.0.0.1:8000, the pinned image above, databases `libredb_demo` and `studio_demo`) and its one-shot seed `databend-http-seed`; [`docker/databend/README.md`](../../docker/databend/README.md) says how to start them and what the fixture holds.
Name both services: an unnamed `up` starts every engine of the file.

```bash
docker compose -f database-compose.yml up -d databend-http databend-http-seed
curl -sS -u "$DATABEND_USER:$DATABEND_PASSWORD" -H 'content-type: application/json' -d '{"sql":"SELECT version()"}' http://127.0.0.1:8000/v1/query
```

On a server of your own, create a SQL user with `CREATE USER <name> IDENTIFIED BY '<password>'` and grant it what Studio should reach; serve TLS on the HTTP handler whenever Studio is not on the same machine.
Create the objects a least-privilege user reads from a session whose current role is not `public`: an object is owned by the role that was current when it was created, and every user holds `public`, so every user may write what `public` owns.
On the Databend Cloud test tenant, a database and tables created as `cloudapp`, whose current role was `public`, were writable by a user granted only `SELECT` (measured 2026-10-08).

### 12.3 A seed connection

A seed takes the same fields, as [SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md) shows; `warehouse` resolves `${...}` references like `host`:

```yaml
  - id: "analytics-databend"
    name: "Databend Cloud"
    type: databend
    host: "${DATABEND_HOST}"
    port: 443
    user: "${DATABEND_USER}"
    password: "${DATABEND_PASSWORD}"
    warehouse: "${DATABEND_WAREHOUSE}"
    ssl:
      mode: verify-system
    roles: ["*"]
    managed: true
```

`readOnly: true` is refused for this type when the seed file loads (section 4.1), and `allowInsecureAuth: true` is the seed's form of the consent of section 4.3.

## 13. Known limitations

- Databend has no read-only session Studio can open, and SELECT-shaped writers exist (`nextval` and six table functions), so there is no agent execution and no MCP `run_read_query` ([B103](../BACKLOG.md)).
- The confirmation gate does not know Databend's destructive forms: `INSERT OVERWRITE`, `REPLACE INTO`, `MERGE INTO`, `OPTIMIZE TABLE ... PURGE`, the `VACUUM` forms, `FLASHBACK TABLE`, `COPY INTO ... PURGE = true`, `REMOVE @stage`, `EXECUTE IMMEDIATE`, `CALL`, a `SETTINGS (...)` clause and the SELECT-shaped writers run with no confirmation ([D246](../BACKLOG.md)).
- A dollar-quoted run tagged other than `$$` (`$name$`) is refused, because Databend reads `$name` as a variable; use `$$`.
- A form feed is refused anywhere in the text, because it ends a `--` comment in Databend.
- A stage name (`@...`) holding a backslash, `--`, `/*`, a dollar quote or a bracket is refused, because Databend's stage token takes each into the name while Studio reads a quote, a comment, a literal or an array there; a space ends the name, so a comment can follow it.
- The stage refusal holds where nothing is hidden too: a name or path that itself holds such a run, as `@s[1]` and `@s/a--b.csv` do, is one stage name to Databend, which a space would cut short; write such a location as a quoted string in a `FROM` or a `COPY`, `FROM '@s/a--b.csv'`, which Databend reads as the same stage location, and with `LIST` and `REMOVE`, which take only the bare name, name the stage alone and match the path with `PATTERN`.
- An optimizer hint whose body holds a `;`, a quote other than a plain single-quoted value, a backslash, `$`, `@`, `~`, `--` or `/*` is refused, because Databend tokenizes a hint's body and can end it at a later `*/`.
- A temporary table and a transaction end with their statement: each statement runs in a session of its own, so the provider rolls back an open transaction and ends a session holding a temporary table.
- `USE`, `SET`, `SET VARIABLE` and `SET ROLE` last for their own statement only; set Database on the connection, qualify names, or use `SET GLOBAL`.
- A statement whose answer is lost may have run: the provider never resends such a POST, and says so.
- There is no HTTP proxy support: the transport ignores `http_proxy` and `https_proxy`; use an SSH tunnel.
- Databend's error text, cut and with the password withheld, reaches AI and MCP: it is part of the error a person can hand to the AI assistant, and MCP's metadata tools return it to the calling agent.
- Studio lists no stage, and a stage or `COPY` statement makes Databend itself read or write the storage it names with the server's own credentials, outside the HTTP egress guard; Studio works with stages and `COPY` only as statements a person writes.
- A materialized view's internal `_mv_source_row_id` is left out of its columns; a materialized view needs a build newer than v1.2.881.
- Databend lists no columns for a view that no longer plans, such as one over a dropped table, so Studio shows it with no column list rather than as complete.
- Studio's own monitoring reads are left out only by the Studio process that sent them, so another Studio process's reads show among the running statements; past 500 running statements, the active count leaves Studio's own out only among the 500 newest.
- The Sessions panel shows no query id for a running statement, since its session row has no field for one; `system.processes` holds it as `current_query_id`.
- One HTTP answer over 16 MiB fails as too large, so a result of very wide display text, such as many columns of control characters, fails when its page is large rather than being shown; the result's own budget of answer text is 16 MiB too.
- A result wider than 250,000 columns fails as a protocol fault rather than being shown with no row, and a refusal longer than 65,536 characters is read by its HTTP status alone, its code and kind unread (section 3.10).
- The sign-in latch holds 256 keys: with every one latched and live, a successful sign-in on another key is not recorded, so that key's statements go one at a time until a latch expires.
- A statement shows its first 100 different server warnings, and one more warning counts those Databend sent past them, which are not shown (section 3.10).
- A server older than v1.2.881 is not refused: the result says the display mode was not confirmed, and some values may read differently.
- EXPLAIN gives no plan for the shapes of section 5.6, and the Explain button says which reason declined it; the Explain button's argument subqueries run as reads while binding.
- Every user's running statements on the server or warehouse are in the Sessions panel, and a running `CREATE USER` or `ALTER USER` with `IDENTIFIED BY` shows its password unmasked there, because Databend masks only `PASSWORD = '...'`.
- Studio's client-chosen session ids mean Databend writes no `login_history` row for a successful sign-in; failed sign-ins and every statement in `query_history` are still recorded.
- A cluster that forwards a request to another node (a sticky node or a warehouse route) forwards it, `Authorization` included, over plain HTTP unless that node's HTTP handler has TLS.
- A hostile or impersonated endpoint holds the password it receives and can return it transformed, in an encoding Studio does not list, so Studio withholds only the forms it sends.
- A `Timestamp` is shown in the server's global time zone without an offset (a session `SET timezone` does not carry over), and a `Timestamp_Tz` with its offset.
- A DML statement's row count, an object's row count or size and a monitoring figure from 2^53 up are the nearest number, not the exact one; a result cell keeps such an integer exact, as text (section 5.4).
- No path-prefixed reverse proxy: Databend's links are origin-relative, so the server must answer at the root of its host and port, with no path prefix.
- The monitoring panels and sums cover the default catalog only.
- The SQL INSERT export cannot write `Array`, `Map`, `Tuple`, `Bitmap`, `Interval`, geo or `Vector` values: each such row is skipped by name.
- Import Data has no target on Databend (section 9): load rows with `INSERT` or `COPY INTO` in the editor.
- A kill stops the session's current statement, not the session, though the Sessions panel's dialog and toast speak of ending it ([U98](../BACKLOG.md)): a session of another client, such as BendSQL, runs its next statement.
- Every budget was verified locally; through Databend Cloud's gateway, on one warehouse, only the 100,000-row read and the 16 MiB budget of answer text ran, and multi-node paging is not run yet.
- A first statement or Test Connection on a suspended Databend Cloud warehouse fails with the resuming sentence while the resume outlasts the 10-second connect budget, and passes once the warehouse runs (section 4.4).
- One Studio process runs at most two Databend statements at a time, across every Databend connection and user, the tree, monitoring and connect reads included; a third waits for a slot up to its deadline, and a tree read that waited 10 seconds says the slots stayed busy (section 3.10).
- In the browser a statement that reaches its deadline can run up to three times: the query route answers a run that timed out with HTTP 408, which Chromium sends again on a kept-alive connection ([X27](../BACKLOG.md)).
- A seed edited to add a Warehouse while it is open keeps its pulse until the page is reloaded ([U97](../BACKLOG.md)).
- The sign-in latch is one Studio process's: several replicas each send a refused password once per 15 minutes, so five or more can still lock a user under a password policy ([D252](../BACKLOG.md)).
- Driver-based SQL providers hold a whole result with no cell or byte budget, which Databend's provider has ([D247](../BACKLOG.md)), and the pulse of other engines resends a refused password, which the latch prevents here within one Studio process ([D248](../BACKLOG.md)).

## 14. References

- Source: [`src/lib/db/providers/sql/databend/`](../../src/lib/db/providers/sql/databend/)
- Explain strategy: [`src/lib/explain/databend-text.ts`](../../src/lib/explain/databend-text.ts)
- Shared transport: [`src/lib/db/http/node-transport.ts`](../../src/lib/db/http/node-transport.ts) and [`src/lib/db/http/endpoint.ts`](../../src/lib/db/http/endpoint.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Tests: [`tests/integration/db/databend-provider.test.ts`](../../tests/integration/db/databend-provider.test.ts) and [`tests/unit/db/databend/`](../../tests/unit/db/databend/)
- Fixture: [`docker/databend/README.md`](../../docker/databend/README.md) and [`tests/fixtures/databend/README.md`](../../tests/fixtures/databend/README.md)
- Security posture: [`docs/SECURITY.md`](../SECURITY.md), row 0.6
- Databend's HTTP handler reference: the `/v1/query` API, its `session`, `pagination` and `next_uri` fields, and `/v1/session/logout`.
- Databend's SQL reference: `EXPLAIN`, `KILL QUERY`, `SHOW CREATE TABLE`, `system.processes` and `system_history.query_history`.
- Databend Cloud: warehouses, the Connect page's DSN, and auto-suspend.
