# RabbitMQ Provider

> RabbitMQ® support for LibreDB Studio, read-only: the management HTTP API for the tree, the details and the health panel, and Studio's own AMQP 0-9-1 read client for stream messages.
> The editor text is a JSON read request, declared `queryLanguage: "json"` with `queryDialect: "rabbitmq"`: one object that names a virtual host, a stream and where to start reading.
> Studio browses virtual hosts, streams, queues and exchanges, and reads stream messages; it never takes a message from a queue, publishes, declares, binds or deletes anything.
> This document is the single reference for the RabbitMQ provider: design, connection, the read request, errors, limits and tests.

| | |
|---|---|
| **Status** | Implemented |
| **Database type id** | `rabbitmq` |
| **Family** | Stream (`src/lib/db/providers/stream/rabbitmq/`) |
| **Driver** | None: the management API is read through Studio's shared node transport, and stream messages through a read-only AMQP 0-9-1 client of the provider's own, which can encode no publish, take or declare ([§3.2](#32-an-own-read-client-with-no-way-to-write)) |
| **Query language** | `json` with `queryDialect: "rabbitmq"`: a JSON read request of this product's own schema ([§5.1](#51-the-read-request)) |
| **Default port** | `15672`, the Management port; the AMQP port, `5672`, is a field of its own and may stay empty to browse only |
| **Connection string** | Not supported; an `https://` management address pasted into Host is taken ([§4.1](#41-fields)) |
| **SSH tunnel** | Refused: one tunnel carries one port, and the management API and AMQP use two |
| **Writes** | None, and none can be sent ([§3.1](#31-read-only-by-construction)) |
| **Maintenance** | None |
| **Query cancellation** | Supported: Stop ends a read, and a read stopped after it started returns the rows read so far with a warning ([§5.5](#55-stop-reasons-and-warnings)) |
| **Supported versions** | RabbitMQ 4.2 and later; an older broker is refused naming its version |
| **Verified against** | RabbitMQ 4.3.6 and 4.2.9, the official `rabbitmq:4.3.6-management` and `rabbitmq:4.2.9-management` images by digest in `database-compose.yml` ([§14](#14-testing)) |
| **Source** | [`src/lib/db/providers/stream/rabbitmq/`](../../src/lib/db/providers/stream/rabbitmq/) |
| **Tests** | [`tests/integration/db/rabbitmq-provider.test.ts`](../../tests/integration/db/rabbitmq-provider.test.ts) + [`tests/unit/db/rabbitmq/`](../../tests/unit/db/rabbitmq/) |
| **Tracking issue** | [#1656](https://github.com/libredb/libredb-studio/issues/1656), under [#424](https://github.com/libredb/libredb-studio/issues/424) |

---

## 1. Overview

A RabbitMQ broker holds queues, which hand each message to one consumer and remove it, and streams, which keep an append-only log that any number of readers can read from any offset without changing it.
Studio reads streams only, because reading a classic or quorum queue removes messages from it.
It shows queues and exchanges as configuration: their arguments, bindings, policies and counts.

### Concept mapping

| RabbitMQ | Studio |
|---|---|
| Virtual host | Container, one level; `/` is marked as the agent walk's default |
| Stream | Kind `stream`, role `relation`: nine fixed columns, readable |
| Classic or quorum queue | Kind `queue`, role `config`: detail and counts, never read |
| Exchange | Kind `exchange`, role `config`: detail and bindings |
| Stream message | One result row |

## 2. Architecture

Two endpoints serve one connection, on one host and one TLS setting:
- the management API (`/api/...`, default port 15672) answers every listing, detail, count, health and monitoring call, GET only, through a closed route table;
- the AMQP port (default 5672) serves stream reads only, one AMQP connection per read, opened by `query()` and closed before it returns.

| Module | Role |
|---|---|
| `index.ts` | `RabbitMQProvider`: composition, seams, capabilities |
| `connection-options.ts` | Every field rule, before any socket |
| `limits.ts` | The named constants of [§10](#10-limits) |
| `errors.ts` | Every sentence of [§11](#11-error-handling), the one error boundary |
| `management/routes.ts`, `management/client.ts`, `management/depth.ts` | The closed GET route table, its byte caps, the depth check and the typed decoders |
| `objects.ts`, `source.ts`, `tracking-probe.ts`, `monitoring.ts`, `access-check.ts` | The object surface, details, the queue check of Test Connection, health |
| `amqp/codec.ts`, `amqp/field-table.ts`, `amqp/frame-reader.ts`, `amqp/connection.ts`, `amqp/read-loop.ts`, `amqp/dial.ts` | The read client |
| `request.ts`, `read.ts`, `results.ts`, `render.ts` | The read request, the read path, the result and the rendering rules |
| `generators.ts`, `labels.ts` | What a tree click and "Generate Read Request" write, and the words the shared panels and plan mode use |

## 3. Design decisions

### 3.1 Read-only by construction

The read client has encoders for the protocol header, `connection.start-ok`, `tune-ok`, `open`, `close`, `close-ok`, `channel.open`, `channel.close-ok`, `basic.qos`, `basic.consume`, `basic.ack`, `basic.cancel-ok` and the heartbeat frame, and for nothing else.
No encoder exists for `basic.get`, `basic.reject`, `basic.nack`, `basic.recover`, `basic.publish`, or any `queue.*`, `exchange.*`, `tx.*` or `confirm.*` method, and a unit test holds the encoder table to that list and finds exactly one socket write site.
The management route table is GET only and has no route that takes a message.
A connection is read-only whether or not its read-only box is ticked.

### 3.2 An own read client, with no way to write

A general AMQP library can publish and take messages, so a read-only guarantee would rest on never calling half of it.
The provider's client is written for the one read it makes, and adds no dependency.

### 3.3 Streams only, checked twice

Before any frame, a read asks the management API for the object's type; a classic or quorum queue is refused naming its type.
The consume always carries `x-stream-offset`, which RabbitMQ refuses with 406 on anything but a stream, so a classic queue declared under a stream's name after the check still delivers nothing.

### 3.4 Object edit (#789): nothing to write

RabbitMQ declares no editable object kind and no write path.
Studio sends the broker GET requests and stream reads only, never a publish or a take, so object edit is not a decision a setting could reverse.

## 4. Connection

### 4.1 Fields

| Field | Label | Rule and hint |
|---|---|---|
| `host` | Host | A host name or a pasted `https://` management address; a path goes in Path prefix; an `amqp://` URL is not taken here |
| `port` | Management port | Default 15672; 15671 with TLS; 443 when a TLS proxy serves the management API |
| `amqpPort` | AMQP port | Digits 1 to 65535, or empty to browse only; Test Connection checks the management API only, and the AMQP port is checked on the first read |
| `apiPath` | Path prefix | For `management.path_prefix` or a reverse-proxy location, such as `/rabbitmq`; starts with `/`, one trailing `/` removed; no empty, `.` or `..` segment, no `%`, `?` or `#`, no segment named `api` |
| `user`, `password` | Username, Password | Required; no control character or DEL, and no colon in the username |
| SSL / TLS | SSL / TLS | One setting for both endpoints: `disable` is `http` and `amqp`, any other mode `https` and `amqps`; one CA set, so paste both CAs if AMQPS and HTTPS use different ones |
| `allowInsecureAuth` | Send the password without TLS | Drawn only while SSL mode is `disable` |

`database`, `namespaces` and `tlsServerName` are not offered, and a record from a seed or the API that sets one is refused naming the field: virtual hosts are discovered, and the TLS identity is always the host.

### 4.2 TLS and the password

Studio sends the password only over TLS or to the machine Studio runs on: a broker on another host, or in another container than Studio's, needs TLS on 15671 and 5671, or a tick in the box that sends the password without TLS, in clear text on both ports.
The box is one consent for the connection: ticked, every management request and every read sends the username and password where anyone on the path can read them.
`servername` is sent only for a DNS name, without one trailing dot (`mq.example.com.` is checked as `mq.example.com` on both endpoints), never for an IP literal, and a TLS failure is never retried without TLS.

### 4.3 The recommended account

```bash
rabbitmqctl add_user studio-reader '<password>'
rabbitmqctl set_user_tags studio-reader management
# Browse only, per virtual host: the broker refuses every take
rabbitmqctl set_permissions -p <vhost> studio-reader '^$' '^$' '^$'
# Or, with stream reads: the read pattern names the streams, regex characters escaped
rabbitmqctl set_permissions -p <vhost> studio-reader '^$' '^$' '^(orders\.v1|audit)$'
```

- Never use `guest`, which the official Docker image lets in from any host as an administrator.
- Use the `management` tag, not `monitoring`, which shows every user's connections; `set_user_tags` replaces a user's tags, so list them first with `rabbitmqctl list_users` when adapting an existing account.
- The read pattern is by name and also opens a classic or quorum queue of a matching name, which Test Connection checks; an unescaped `orders.v1` also matches a queue `orders-v1`; the pattern is a list of names, so a new stream is readable only after the pattern is widened.
- In Studio, set Host, Management port, SSL / TLS, user and password, and Path prefix only behind a proxy or `management.path_prefix`; leave AMQP port empty to browse only, and Test Connection then shows one caution, which is expected.
- On a cluster, point AMQP port at a node with a running replica, which holds on every node of a default cluster while all of them run.
- Set AMQP port; Test Connection does not open AMQP, so click "Read Last Chunk" on a stream to check it.

Studio checks for readable classic or quorum queues only when the broker has the rabbitmq_stream_management plugin; without it, check the read pattern by hand.
Stream reads do not need the plugin.

### 4.4 Test Connection

Test Connection checks the management API only: it signs in, reads the version, and adds cautions, never errors, in this order: the empty AMQP port, an active resource alarm, a user with permissions on no virtual host, and the classic or quorum queues the account can read.
The queue check runs only with the rabbitmq_stream_management plugin, which the official image does not enable, and which also starts the stream listener on port 5552 on all interfaces when enabled.

### 4.5 Behind a reverse proxy

A reverse proxy in front of the management API breaks the default virtual host `/`, sent as `%2F`, unless it passes encoded slashes through; RabbitMQ's [Using a Reverse Proxy in front of the HTTP API](https://www.rabbitmq.com/docs/management#http-api-proxy) gives the Nginx and Apache settings.
Set Path prefix to the location the proxy serves the API under.
A proxy that decodes `%2F` answers its own 404 for `/`, which Studio cannot tell from a missing virtual host, so that 404 gets the error table's sentence that names both causes (section 11).

### 4.6 Seeding a connection

A `readOnly: true` seed with the `guest`/`guest` pair is refused, as the dialog warns: guest/guest is RabbitMQ's default administrator, which the official Docker image accepts from any host; create a user for Studio (studio-reader) instead.

## 5. Query interface

### 5.1 The read request

One JSON object with the keys `vhost`, `stream`, `from` and `limit`, and no other, each written once:

```json
{"vhost": "/", "stream": "orders", "from": "last", "limit": 50}
```

- `vhost`, `stream`: required strings of 1 to 255 bytes, without NUL, and not `.` or `..`.
- `from`, default `"last"`: `"first"`, `"last"`, `"next"`, `{"offset": n}` (a JSON number up to 2^53 - 1, or a digit string up to 2^63 - 1), `{"timestamp": "<ISO-8601 with a zone>"}` or `{"age": "<n><unit>"}` with unit Y, M (months), D, h, m (minutes) or s.
- `limit`: 1 to 500, default 50.

A timestamp or age start uses the time the broker stored the messages; the timestamp column is the publisher's own property, which can be empty or differ.
Clicking a stream in the tree runs "Read Last Chunk", `{"vhost": v, "stream": s, "from": "last", "limit": 50}`, which returns the broker's last stored chunk, 1 to 25 messages measured, not 50 rows; "Generate Read Request" writes the same with `"from": "first"` without running it.

### 5.2 The result

| # | Column | Type | Value |
|---|---|---|---|
| 1 | `offset` | string | The stream offset, as a decimal string |
| 2 | `timestamp` | timestamp, nullable | The `timestamp` property, in UTC; null when absent |
| 3 | `exchange` | string | The publish exchange; `""` for the default exchange or an AMQP 1.0 publish |
| 4 | `routing_key` | string | The publisher's first routing key; the stream name for a message stored without one, as an AMQP 1.0 publish to the queue address is |
| 5 | `headers` | json | The headers by wire tag, names as delivered, `x-stream-offset` removed |
| 6 | `properties` | json | The other basic properties present, snake_case |
| 7 | `payload` | json | Parsed JSON, text, or `"<base64> (<n> bytes)"` |
| 8 | `payload_encoding` | string | `json`, `text`, `base64` or `amqp-1.0` |
| 9 | `payload_bytes` | integer | The declared body size |

Rows are in offset order; a row is a "Message".

### 5.3 Rendering rules

- A text value is shown as text only when it is valid UTF-8, otherwise in the base64 form; a byte-array header is always base64.
- 64-bit integers are decimal strings; NaN and infinities are `"NaN"`, `"Infinity"` and `"-Infinity"`.
- Header tables and arrays are shown to depth 8, a deeper subtree as `"[nested deeper than 8: N bytes]"`; empty tables and arrays are kept.
- A header name is an own property whatever it is, `__proto__` and the empty name included; a repeated name becomes an array in arrival order.
- A JSON payload is parsed only when it is valid UTF-8 starting `{` or `[` and nests at most 64 levels; a deeper one is shown as base64, never as text, so no renderer re-reads it as JSON.
- A body is labelled `amqp-1.0` only when its `type` property says so and the body parses as AMQP 1.0 sections, never by the property alone.

Values published over AMQP 1.0 are shown after RabbitMQ's conversion to AMQP 0-9-1.
On RabbitMQ 4.3.7 and later, values that AMQP 0-9-1 cannot represent are removed by the broker before Studio sees the message, for example uuid, char, decimal and described values in application properties and annotations at any depth, map entries whose key is not a string of at most 255 bytes, and a content type or encoding over 255 bytes. On every version, NaN and infinite floating-point values are removed. A header published over AMQP 0-9-1 whose value is a table or an array, and whose name does not start with x-, is not stored by a stream. Nothing in the message says a value was removed, and a nested map or list can arrive empty. Studio shows the message as the broker delivered it. To see those values, read the stream over AMQP 1.0 or the stream protocol.
A publisher that sends a uuid or a char in application properties is conformant to AMQP 1.0 3.2.5; the gap is the broker's conversion.

### 5.4 Bounds

Body bytes are kept up to 262,144 per message and 8 MiB per result; a larger body is kept as a prefix and the rest is discarded frame by frame without buffering. Peak RSS stays under the process baseline plus 3 times the result budget plus a fixed allowance that does not grow with the bytes discarded.
A cut body is transferred in full and only its first 262,144 bytes are kept; `payload_bytes` has the full size, and one warning counts the cut bodies.
One read transfers at most 64 MiB; a message larger than that cannot be shown.
The warning names the offset to read from to continue past it, or, when the cap is reached before the message's offset arrives, says that Studio cannot name it.
A declared body above 512 MiB is refused as a protocol violation before any body byte.

### 5.5 Stop reasons and warnings

A read that reaches its row limit ends without a warning.
Every other stop is one warning, listed first: no message within 1 s (which is not proof that the stream ends there), the 8 MiB result limit, the 64 MiB transfer limit, the broker's cancel, the broker closing the connection, the time limit, and Stop.
A read stops at `min(Query Timeout, 30 s)`.

### 5.6 Messages the broker cannot convert (541)

On RabbitMQ 4.2.x and 4.3.0 to 4.3.6, a message published over AMQP 1.0 that carries a uuid, char or nested described value, a non-string nested map key, a nested ulong, or a content type or encoding over 255 bytes ends every AMQP 0-9-1 read that reaches it: the broker closes the connection with 541 INTERNAL_ERROR.
Studio never presents such a read as complete:
- with rows read, the result keeps them and a warning names the last offset delivered and the request that steps past it, one offset at a time;
- with no row, the read fails with a sentence that says how to find the message: from a numeric start, step forward with `"limit": 1`; from a keyword or time start, read `"first"` with `"limit": 1` to learn the first offset, then halve numeric ranges of 500.

From 4.3.7 such messages are delivered with those values removed ([§5.3](#53-rendering-rules)); the handling stays on every version, because a development build reports `4.3.0+<sha>`.

## 6. Schema introspection

- Containers: `GET /api/vhosts`; `/` is marked as the session default for the agent walk when the account lists it.
- Each folder is one page of 500 names, never an `arguments` column and never a name filter:
  - Queues: `sort=name` with the queue totals, keeping classic and quorum rows;
  - Streams: `sort=type&sort_reverse=true` without the totals, reversed into the broker's ascending byte order;
  - Exchanges: `sort=name`; the default exchange `""` sorts first, shown as "(AMQP default)".
- A full Streams folder shows the 500 streams that sort last by name, badged "500+", and every stream beyond it is still readable by a typed read; when other queue types share the page, its sentence names the number of streams the page holds, and when they fill it, the folder says so instead of showing none.
- The Queues total beside a complete Streams folder is approximate, because it comes from two listings that are not taken at once.
- A folder the account may not read counts as unavailable with "This user has no permissions on virtual host {vhost}: grant them to show its queues and exchanges.", never 0.

A sampled count names its sample in the tree's badge title, "At least N: counted from" followed by:

| Folder | Sample |
|---|---|
| Streams, full | one page of {filtered_count} queues and streams sorted by type, which holds the 500 streams that sort last by name |
| Streams, full, fewer than 500 held | one page of {filtered_count} queues and streams sorted by type, which holds the {held} streams that sort last by name |
| Queues, above 500 | one 500-name page of {filtered_count} queues and streams, by name |
| Queues, above 500, Streams complete | one 500-name page of {filtered_count} queues and streams, by name, about {approximate} of them classic or quorum queues |
| Exchanges, above 500 | one 500-name page of {filtered_count} exchanges, by name |

The tree handles about 1,200 virtual hosts; past that the `/api/vhosts` answer passes its cap and the tree fails with the size sentence, and no typed vhost list works around it in v1.

## 7. Monitoring and health

`getHealth()` makes one GET, `/api/overview?columns=rabbitmq_version,product_name`; `getOverview()` two, the overview and `/api/health/checks/alarms`.
The performance, slow-query, session, table, index and storage panels answer empty with no GET: RabbitMQ has no query log, and Studio does not list broker connections, because they name other users and client addresses.
No node name and no other principal's name is shown.

## 8. AI agent and MCP

- A model receives virtual host, stream, queue and exchange names, kinds, the fixed stream columns, counts and the request language, each name inside the untrusted-content fence in plan mode and MCP.
- A model never receives a message cell, a consumer tag, a peer address, another user's name, a node name or a health-check body.
- Plan mode walks only `/`, at most 7 management GETs at any vhost count, and tells the model how many virtual hosts it did not read; it drafts a read request and never runs it.
- The plan-mode inventory names each object by its virtual host, a dot and its name, so the stream `orders` reaches the model as `/.orders`; the request language it is given says that `"stream"` takes only the part after `/.`.
- MCP `inspect_schema` makes 2 GETs per call (`/api/vhosts` and the chosen virtual host's Streams page), plus `connect()`'s 2 on a fresh instance; above 500 streams it sees the Streams folder's 500 names as the whole list, and a stream outside them is reached only by a typed read.
- MCP matches a named virtual host case-insensitively, so of `Billing` and `billing` a call naming `billing` reads the one listed first.
- There is no agent execution and no MCP `run_read_query` for RabbitMQ.

## 9. What Studio costs the broker

- On 4.3.5 and later every Studio management GET writes one `info` line in the broker's `user` log category, about 1,440 a day for one open tab's 60 s pulse plus 3 a minute while the admin fleet health is open; `log.user.level = warning` silences them.
- A wrong password writes 2 warning lines and one failed login per attempt, once a minute while a tab is open.
- The tree's first paint reads `/api/vhosts` and the three pages of `/`.
- Each connection select reads `/api/vhosts` and one Streams page per virtual host, 1 + min(V, 1,000) GETs at V virtual hosts, on every select, the embedded workspace included; the connection's `skipObjectScan` setting turns it off.
- A tree search reads `/api/vhosts` and the three pages per virtual host, 1 + 3V GETs, and is refused above 333 virtual hosts.
- Each read opens one AMQP connection; a read stopped early closes it without waiting for the broker's reply, which the broker may log as an unexpected close.

## 10. Limits

| Constant | Value | What it bounds |
|---|---|---|
| `RABBITMQ_TYPE` | "rabbitmq" | The type id every error of this provider is tagged with |
| `RABBITMQ_MIN_VERSION` | "4.2.0" | The oldest broker accepted |
| `RABBITMQ_READ_DEADLINE_MS` | 30,000 | A read's deadline, shortened by a lower Query Timeout |
| `RABBITMQ_READ_DEFAULT_ROWS` | 50 | Rows when `limit` is absent |
| `RABBITMQ_READ_MAX_ROWS` | 500 | The largest `limit` |
| `RABBITMQ_PREFETCH_MAX` | 10 | Deliveries in flight |
| `RABBITMQ_IDLE_MS` | 1,000 | The no-message stop |
| `RABBITMQ_RESULT_BUDGET_BYTES` | 8,388,608 | Kept bytes per result |
| `RABBITMQ_CELL_CHARS` | 65,536 | Characters per cell |
| `RABBITMQ_BODY_PREFIX_BYTES` | 262,144 | Kept bytes per body |
| `RABBITMQ_BODY_CEILING_BYTES` | 536,870,912 | The largest declared body |
| `RABBITMQ_READ_WIRE_BYTES` | 67,108,864 | Bytes one read transfers |
| `RABBITMQ_HEADER_FRAME_MAX_BYTES` | 536,870,912 | The largest content-header frame |
| `RABBITMQ_HEADER_VALUE_RETAINED_BYTES` | 262,144 | Kept bytes per header value |
| `RABBITMQ_HEADER_TABLE_RETAINED_BYTES` | 1,048,576 | Kept bytes per header table |
| `RABBITMQ_HEADER_DEPTH` | 8 | Header nesting shown |
| `RABBITMQ_FRAME_MAX_CEILING` | 131,072 | The largest frame size Studio accepts |
| `RABBITMQ_FRAME_MIN_BYTES` | 8,192 | The smallest frame size RabbitMQ allows |
| `RABBITMQ_HEARTBEAT_CEILING_S` | 60 | The largest heartbeat interval |
| `RABBITMQ_CLOSE_OK_WAIT_MS` | 1,000 | The wait for the broker's close reply |
| `RABBITMQ_LISTING_PAGE_SIZE` | 500 | Names per folder page |
| `RABBITMQ_MGMT_DEPTH` | 64 | Nesting of a management answer |
| `RABBITMQ_PAYLOAD_JSON_DEPTH` | 64 | Nesting of a payload shown as JSON |
| `RABBITMQ_MGMT_REQUEST_DEADLINE_MS` | 15,000 | One management GET, shortened by a lower Query Timeout |
| `RABBITMQ_BINDINGS_MAX_ROWS` | 1,000 | Bindings kept per answer |
| `RABBITMQ_BINDINGS_KEPT_BYTES` | 1,048,576 | Binding bytes kept per answer |
| `RABBITMQ_TEST_CHECK_MAX_VHOSTS` | 6 | Virtual hosts the queue check reads |
| `RABBITMQ_TEST_CHECK_MAX_QUEUES` | 50 | Queues the queue check probes |
| `RABBITMQ_TEST_CHECK_DEADLINE_MS` | 10,000 | The queue check's deadline |
| `RABBITMQ_SMALL_ANSWER_BYTES` | 65,536 | The cap of the small management answers |
| `RABBITMQ_ANSWER_BYTES` | 1,048,576 | The cap of listings and details |
| `RABBITMQ_BINDINGS_ANSWER_BYTES` | 16,777,216 | The cap of a bindings answer |
| `RABBITMQ_DEFAULT_MANAGEMENT_PORT` | 15672 | The Management port's default |
| `RABBITMQ_NAME_MAX_BYTES` | 255 | A name's length |
| `RABBITMQ_NAME_PROSE_CHARS` | 64 | Characters of a name shown in a sentence |
| `RABBITMQ_CAUTION_NAMED_QUEUES` | 5 | Queues named per caution |
| `RABBITMQ_CAUTION_MAX_VHOSTS` | 3 | Virtual hosts with a caution of their own |
| `RABBITMQ_LAST_HINT_BACKSTEP` | 50 | How far back the "last" hint suggests reading |
| `RABBITMQ_AMQP1_DESCRIPTOR_DEPTH` | 4 | Descriptor chain read before a body is shown as base64 |
| `RABBITMQ_READ_LIMITS` | perProvider 1, perEngine 4, queueDepth 16 | Stream reads per instance, per process, waiting |
| `RABBITMQ_MANAGEMENT_LIMITS` | perProvider 4, perEngine 16, queueDepth 64 | Management GETs |
| `RABBITMQ_BINDINGS_LIMITS` | perProvider 1, perEngine 2, queueDepth 16 | Bindings GETs |

## 11. Error handling

Every sentence comes from `errors.ts` and interpolates only the placeholders below; no sentence carries a username or broker text.
A name is written as a JSON string literal, with control, line-separator and bidirectional characters escaped as `\uXXXX`, and cut with `...` past 64 characters in prose; inside a request quoted in a sentence it is never cut.

| Case | Class | Sentence |
|---|---|---|
| Wrong password or unknown user | `AuthenticationError` | The broker refused this username and password on the management API. |
| The same over AMQP | `AuthenticationError` | The broker refused this username and password on the AMQP port. |
| `guest` from a remote host | `AuthenticationError` | This broker accepts this user only from its own host: create a dedicated user for Studio. |
| No management tag | `AuthenticationError` | This user may not use the management API: give it the management tag. |
| Below 4.2 | `DatabaseConfigError` | This broker runs RabbitMQ {version}; Studio supports 4.2 and later. |
| Unreadable version | `DatabaseConfigError` | This server's management API reports a version Studio cannot read; Studio supports RabbitMQ 4.2 and later. |
| No permissions on a virtual host | unavailable count, `QueryError` | This user has no permissions on virtual host {vhost}: grant them to show its queues and exchanges. |
| Missing virtual host over AMQP | `QueryError` | The broker has no virtual host {vhost}. |
| Missing virtual host or object | `QueryError` | Virtual host {vhost} has no queue, stream or exchange {name}, or the virtual host does not exist: refresh the tree. |
| A proxy's own 404 for a virtual host | `QueryError` | Virtual host {vhost} does not exist, or a proxy in front of the management API answered for it: refresh the tree. |
| Virtual host refused over AMQP | `AuthenticationError` | This user may not open virtual host {vhost} over AMQP: grant it permissions there. |
| Any other 530 | `AuthenticationError` | Virtual host {vhost} does not exist, or this user may not open it over AMQP: check both in the management UI. |
| Read refused | `QueryError` | This user may not read stream {name}: its read permission pattern on {vhost} does not match the name. |
| A classic or quorum queue | `QueryError` | {name} is a {type} queue; Studio reads streams only, because reading a queue removes messages. |
| Not a stream | `QueryError` | {name} is not a stream; Studio reads streams only. |
| No local replica, others online | `QueryError` | The node behind AMQP port holds no running replica of stream {name}; replicas are reported online on other nodes: point AMQP port at one of them. |
| No replica online | `QueryError` | No replica of stream {name} is reported online. |
| Replica starting | `QueryError` | The node behind AMQP port may still be starting its replica of stream {name}: read again in a few seconds. |
| Management port refused | `ConnectionError` | Nothing listens on {host}:{port}: check Management port and that the rabbitmq_management plugin is enabled. |
| Reset without HTTP | `ConnectionError` | {host}:{port} closed the connection without an HTTP answer: check that Management port is the management API (15672, or 15671 with TLS). |
| Not HTTP | `ConnectionError` | {host}:{port} answered with something that is not HTTP: this looks like an AMQP port, or this port needs TLS; Management port is usually 15672 (15671 with TLS). |
| A plain listener on a TLS connection | `ConnectionError` | {host}:{port} does not speak TLS: choose SSL mode disable under SSL / TLS, or use the TLS port (15671 for management, 5671 for AMQP). |
| Certificate not trusted for this host (wrong CA, self-signed, another name) | `ConnectionError` | {host}:{port} presented a certificate Studio does not trust for this host: check the CA certificate under SSL / TLS, and that the certificate names the host set in Host. |
| Client certificate refused by the broker | `ConnectionError` | {host}:{port} refused the TLS connection: check the client certificate and key under SSL / TLS (shown in verify-ca and verify-full). |
| Not the management API | `ConnectionError` | {host}:{port} has no RabbitMQ management API at /api/whoami: check Management port (15672, or 15671 with TLS) and Path prefix. |
| No AMQP session | `ConnectionError` | {host}:{port} did not start an AMQP session: check that AMQP port is 5672 (5671 with TLS). |
| AMQPS without TLS | `ConnectionError` | {host}:{port} expects TLS: choose an SSL mode under SSL / TLS, or use 5672. |
| AMQP unreachable | `ConnectionError` | Nothing listens on {host}:{port}: check the address and AMQP port. |
| AMQP port empty | `DatabaseConfigError` | Reading a stream needs AMQP port: set it on the connection (5672, or 5671 with TLS). |
| Password without TLS | `DatabaseConfigError` | This connection would send its password without TLS to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS and use the TLS ports (15671 for management, 5671 for AMQP). Or tick "Send the password without TLS", which this connection then does on every management request and read. |
| SSH tunnel | `DatabaseConfigError` | RabbitMQ connections cannot use an SSH tunnel: one tunnel carries one port, and the management API and AMQP use two. |
| Protocol violation | `ConnectionError` | The server at {host}:{port} broke the AMQP 0-9-1 protocol ({fact}); the read was stopped. |
| Missed heartbeats | `ConnectionError` | {host}:{port} stopped answering during the AMQP handshake. |
| Waiting for a read slot | `TimeoutError` | Waited {n} s for a read slot; the stream was not read. |
| No TCP accept | `TimeoutError` | No answer from {host}:{port} within {n} s. |
| TLS not finished | `TimeoutError` | {host}:{port} accepted the connection but did not finish the TLS handshake within {n} s. |
| Handshake or consume | `TimeoutError` | Waited {n} s for the broker to start the read of stream {name}; nothing was read. |
| Read slots full | `QueryError` | Too many stream reads are running on this Studio server; try again when one ends. |
| 541 while starting | `QueryError` | The broker closed the connection (541 INTERNAL_ERROR) while starting the read of stream {name}; this can happen when the stream is deleted at that moment. Refresh the tree and read again. |
| Management answer too large | `QueryError` | The broker's answer for {route} is larger than the {cap} Studio accepts. |
| Management answer too deep | `QueryError` | The broker's answer for {route} nests deeper than 64 levels, which Studio does not accept. |
| Redirect | `ConnectionError` | {host}:{port} answered with a redirect, which Studio does not follow: set Host, Management port and Path prefix to the management API itself. |
| Server error | `ConnectionError` | The management API at {host}:{port} answered with a server error ({status}). |
| Not JSON | `ConnectionError` | {host}:{port} answered with something that is not the management API's JSON: check Management port and Path prefix. |
| Wrong shape | `QueryError` | The broker's answer for {route} is not in the shape Studio reads. |
| Management timeout | `TimeoutError` | The management API at {host}:{port} did not answer {route} within {n} s. |
| Frame size too small | `ConnectionError` | The broker proposed a frame size of {n} bytes, below the 8,192 RabbitMQ requires. |
| No PLAIN | `ConnectionError` | The server at {host}:{port} offers no PLAIN login, the only one Studio uses. |
| Another protocol | `ConnectionError` | {host}:{port} speaks another protocol version than AMQP 0-9-1: check that AMQP port is 5672 or 5671, not 5552 or 15672. |
| Encoded answer | `ConnectionError` | {host}:{port} answered with a compressed or encoded body, which Studio does not read: check Path prefix and any proxy in front of the management API. |
| Connection failed | `ConnectionError` | The connection to {host}:{port} failed before the management API answered completely. |
| Anything else | `QueryError` | Studio could not read the broker's answer for {route}. |

The shared egress refusals of `DB_HTTP_BLOCK_PRIVATE_HOSTS` apply to both endpoints and pass through unchanged.
The web server replaces every `TimeoutError`'s sentence with its shared timeout sentence, so the timeout sentences above are not yet shown through the query route.

## 12. Standards and deviations

AMQP 0-9-1 is the AMQP Working Group's specification "Version 0-9-1, 13 November 2008", in two normative parts: a [PDF](https://www.rabbitmq.com/resources/specs/amqp0-9-1.pdf) for the model, the framing and the wire format, and an [XML file](https://www.rabbitmq.com/resources/specs/amqp0-9-1.xml) that holds every class and method rule.
RabbitMQ's [errata](https://www.rabbitmq.com/amqp-0-9-1-errata), [extensions](https://www.rabbitmq.com/docs/extensions) with the [extended XML](https://www.rabbitmq.com/resources/specs/amqp0-9-1.extended.xml), and [conformance page](https://www.rabbitmq.com/docs/specification) are the vendor's reading, cited as vendor documentation.
AMQP 1.0 is the [OASIS standard of 29 October 2012](https://docs.oasis-open.org/amqp/core/v1.0/os/), cited only for how a 1.0-published message arrives.
Every link was read on 2026-10-12; clauses are cited by section number, because the PDF has no numbered links.

| Topic | Clause |
|---|---|
| Negotiation | PDF 2.2.4, 2.3.3, 4.2.2; XML `connection.start`, `start-ok`, `tune`, `tune-ok`, `open` |
| Frames | PDF 2.3.5, 4.2.3, 4.9; XML `connection.tune` `frame-max` rule `minimum`, `frame-min-size` |
| Data types | PDF 2.3.2, 4.2.1 `field-value`, 4.2.5.3, 4.2.5.4, 4.2.5.5 |
| Content | PDF 2.3.5.2, 4.2.6, 4.2.6.1, 4.2.6.2, 3.1.1 |
| Heartbeats | PDF 2.3.5.3, 4.2.7; XML `frame-heartbeat` |
| Closing and errors | PDF 2.3.6, 2.3.7, 4.5, 4.8; XML `connection.close` rule `stability`; reply codes 320, 402, 403, 404, 406, 501, 530, 540, 541 |
| Methods used | XML `basic.qos`, `basic.consume`, `basic.deliver`, `basic.ack`, `basic.cancel`; PDF 3.1.6 to 3.1.8, 4.3 |
| Methods refused | XML `basic.get`, `basic.reject`, `basic.recover`, `recover-async`, `basic.publish`, `queue.declare` `passive`; extended XML `basic.nack`; class `basic` client chassis `MAY` |
| SASL PLAIN | [RFC 4616 2](https://www.rfc-editor.org/rfc/rfc4616.html#section-2), [5](https://www.rfc-editor.org/rfc/rfc4616.html#section-5) |
| HTTP Basic | [RFC 7617 2](https://www.rfc-editor.org/rfc/rfc7617.html#section-2) |
| TLS server name | [RFC 6066 3](https://www.rfc-editor.org/rfc/rfc6066.html#section-3), [RFC 8446 9.2](https://www.rfc-editor.org/rfc/rfc8446.html#section-9.2) |
| URI paths | [RFC 3986 2.2](https://www.rfc-editor.org/rfc/rfc3986.html#section-2.2), [2.4](https://www.rfc-editor.org/rfc/rfc3986.html#section-2.4), [3.3](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.3), [5.2.4](https://www.rfc-editor.org/rfc/rfc3986.html#section-5.2.4) |
| HTTP GET | [RFC 9110 9.2.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.1), [9.3.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.1) |
| AMQP 1.0 messages | [3.2](https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-messaging-v1.0-os.html#section-message-format), [3.2.5](https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-messaging-v1.0-os.html#type-application-properties), [1.6.16 char](https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-types-v1.0-os.html#type-char), [1.6.18 uuid](https://docs.oasis-open.org/amqp/core/v1.0/os/amqp-core-types-v1.0-os.html#type-uuid) |

Vendor documentation, RabbitMQ 4.3, read on 2026-10-12:

| Topic | Page |
|---|---|
| Errata to 0-9-1 | [AMQP 0-9-1 Errata](https://www.rabbitmq.com/amqp-0-9-1-errata), sections 3, 10, 11, 12, 13, 16 and 29 |
| Conformance and frame minimum | [Compatibility and Conformance](https://www.rabbitmq.com/docs/specification); `FRAME_MIN_SIZE` 8192 in [`rabbit_framing.hrl`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.6/deps/rabbit_common/include/rabbit_framing.hrl) |
| Extensions | [Extensions](https://www.rabbitmq.com/docs/extensions), [Authentication failure notification](https://www.rabbitmq.com/docs/auth-notification), [Consumer Cancel Notification](https://www.rabbitmq.com/docs/consumer-cancel), [Negative Acknowledgements](https://www.rabbitmq.com/docs/nack) |
| Stream reads | [Streams, Consuming](https://www.rabbitmq.com/docs/streams#consuming), [Global QoS](https://www.rabbitmq.com/docs/streams#global-qos), [Message Encoding](https://www.rabbitmq.com/docs/streams#limitations-message-encoding) |
| Prefetch | [Consumer Prefetch](https://www.rabbitmq.com/docs/consumer-prefetch#overview) |
| Heartbeats | [Detecting Dead TCP Connections with Heartbeats](https://www.rabbitmq.com/docs/heartbeats#heartbeats-timeout) |
| Conversions | [AMQP 1.0 to AMQP 0.9.1](https://www.rabbitmq.com/docs/conversions#amqp-amqpl), [Type Conversions](https://www.rabbitmq.com/docs/conversions#amqp-amqpl-types) |
| Management API | [HTTP API Reference, Overview](https://www.rabbitmq.com/docs/http-api-reference#overview) |
| Names, delivery limit, permissions, TLS | [Queue Names](https://www.rabbitmq.com/docs/queues#names), [Poison Message Handling](https://www.rabbitmq.com/docs/quorum-queues#poison-message-handling), [Access Control](https://www.rabbitmq.com/docs/access-control), [TLS Support](https://www.rabbitmq.com/docs/ssl) |

Deliberate deviations from a MUST:
- PDF 4.2.3: "A peer MUST NOT send frames larger than the agreed-upon size. A peer that receives an oversized frame MUST signal a connection exception with reply code 501 (frame error)." RabbitMQ sends a content-header frame as one frame whatever its size, as its errata says ("RabbitMQ currently ignores the frame-max for methods and content headers"), so Studio accepts content-header frames up to `RABBITMQ_HEADER_FRAME_MAX_BYTES`, Studio's own limit, and holds method and body frames to the negotiated size.
- PDF 2.3.7: "From this point onwards a peer that wishes to close the channel or connection MUST do so using a hand-shake protocol." A read stopped by the result budget, the transfer cap, the deadline or Stop writes `connection.close` and destroys the socket without waiting for `close-ok`, because `close-ok` would arrive only after the body Studio refuses to read; the broker may log an unexpected close.
- PDF 4.2.6.2: a body split into frames is to be stored as a single set. Studio keeps a body's first 262,144 bytes and steps over the rest, which `payload_bytes` and a warning make visible on every row; the 512 MiB refusal is a client limit PDF 4.9 permits ("The server or client may also impose its own limits on resources").

Readings of the text this provider follows:
- PDF 4.2.5.3: "Long strings, stored as a 32-bit unsigned integer length followed by zero or more octets of data. Long strings can contain any data." Studio keeps the bytes and shows a value as text only when it is valid UTF-8, otherwise as base64.
- XML `connection.tune` rule `minimum` sets 4,096 as the smallest frame size; RabbitMQ refuses a `frame-max` below its own 8,192, so Studio refuses a proposal below 8,192 and names RabbitMQ as the reason.
- PDF 2.2.4: "The client accepts or lowers these parameters (Tune-Ok)." Studio never sends a heartbeat or `frame-max` above the server's proposal.
- PDF 4.2.7: no incoming octet for two heartbeat intervals closes the connection without the handshake; the heartbeat frame type is 8, as in the XML, although the PDF's 4.2.3 lists 4 (errata section 29).
- XML `connection.close` rule `stability`: "After sending this method, any received methods except Close and Close-OK MUST be discarded." A delivery that arrives after Studio's close is never a row.
- XML class `basic`: `<chassis name = "client" implement = "MAY" />`; a client that encodes `qos`, `consume`, `ack` and `cancel-ok` and nothing else of the class is conformant, and `x-stream-offset` is RabbitMQ's argument, cited to its docs.
- PDF 3.1.1: "The server MAY add information to content headers but it MUST NOT remove or modify existing information." A stream stores AMQP 1.0, so RabbitMQ adds `x-stream-offset`, drops 0-9-1 headers that hold a table or an array, and from 4.3.7 removes values 0-9-1 cannot hold; Studio shows the message as delivered.
- PDF 4.2.5.5: "Duplicate fields are illegal." Studio does not choose one of them: a repeated name becomes an array of its values.
- PDF 4.2.5.3: short strings "may not contain binary zero octets", so a NUL in a virtual host or stream name is refused before any frame.
- RFC 4616 2 and 5, RFC 7617 2: an empty credential, a NUL or control character, and a colon in the username are refused before any socket, and a password is not sent without TLS to a host that is not this machine unless the connection consents.
- RFC 6066 3: "Literal IPv4 and IPv6 addresses are not permitted in "HostName"", so `servername` is sent only for a DNS name.
- RFC 3986 2.2 and 2.4: the virtual host `/` is sent as `%2F` and a literal `%` as `%25`, so a virtual host named `%2F` is `%252F`; by 3.3 and 5.2.4 the segments `.` and `..` are removed from a path, so a virtual host, queue, stream or exchange named `.` or `..` cannot be addressed and is refused with a sentence.
- RFC 9110 9.2.1: the management seam sends GET only; the `info` log line RabbitMQ 4.3.5 and later writes per request is the logging that clause calls safe.
- AMQP 1.0 3.2.5: application-property values are simple types, and uuid and char are simple types, so a publisher that sends them is conformant; the 541 of [§5.6](#56-messages-the-broker-cannot-convert-541) is the broker's conversion.

## 13. Clusters

- The management endpoint may be any node or a load balancer: every node returns the same queue and consumer view, and counts lag up to a statistics interval.
- A stream read needs the AMQP connection to land on a node that holds a replica of the stream, which holds on every node with default stream replication while all replica nodes run; otherwise it depends on the node reached, and the error names which replicas are reported online.
- No claim is made about latency on multi-host clusters or about managed services.
- No read is retried and no connection is re-opened automatically.

## 14. Testing

### 14.1 How the tests work

The unit tests under `tests/unit/db/rabbitmq/` drive each module through injected seams (clock, deadline signals, the management transport and the AMQP dial), never `mock.module()`.
The integration test, [`tests/integration/db/rabbitmq-provider.test.ts`](../../tests/integration/db/rabbitmq-provider.test.ts), runs the whole provider against recorded answers: the management API through a stub keyed by method, path and sorted query, and the broker's AMQP bytes through a fake peer, from the captures under `tests/fixtures/rabbitmq/<version>/`, each naming its image, digest, broker version and seed.

```bash
bun tests/run-tests.ts tests/unit/db/rabbitmq tests/integration/db/rabbitmq-provider.test.ts
```

### 14.2 The fixture

`database-compose.yml` holds `rabbitmq` (4.3.6 by digest) and `rabbitmq-init`, which runs [`tests/live/rabbitmq-seed.ts`](../../tests/live/rabbitmq-seed.ts); the profiles `rabbitmq-42` (4.2.9, the permanent home of the 541 close), `rabbitmq-cluster` (three 4.3.6 nodes) and `rabbitmq-tls` (certificates generated at start).

```bash
eval "$(bun tests/live/rabbitmq-seed.ts --env)"
docker compose -f database-compose.yml up -d rabbitmq rabbitmq-init
```

The compose file holds no password: every RabbitMQ service reads `RABBITMQ_LIVE_ADMIN_PASSWORD` and `RABBITMQ_LIVE_FIXTURE_PASSWORD` from the shell with no default, a broker refuses to start without the first, and the seed's `--env` prints the two export lines that build them.
The seed refuses a broker that is already seeded, because a stream publish appends and would move every offset the captures key on; remove the two containers to seed again.
Its users, all with the fixture password the seed builds: `studio-reader` (management tag, reads the streams the seed table marks), `studio-browse` (`^$ ^$ ^$`), `studio-wide-read` (reads everything, for the read-only check and the positive Test Connection caution), and `studio-untagged` (no tag, for the "Not management user" answer).

The seed table, one row per queue and stream; a stream's offsets are the order of its messages:

<!-- seed-table:start -->
| Vhost | Name | Type | Messages, by offset | Read by |
|---|---|---|---|---|
| `/` | `st-orders` | stream | 0 to 4: JSON order; 5: PNG signature and 56 pattern bytes; 6: empty body; 7: 1 MiB pattern body; 8: 15 MiB pattern body; 9: HTML; 10: terminal escapes; 11: invalid UTF-8; 12: every basic property and typed headers | R-S7 offsets 9 to 12; the capture gate (0 to 6 and 9 to 12 whole, 7 and 8 as a prefix and a digest) |
| `/` | `st-events` | stream | 0 to 999: JSON event | Read Last Chunk and the from forms |
| `/` | `st-routes` | stream | 0: default exchange, timestamp 1760000000; 1: ex-routes-direct, key rk-a; 2: ex-routes-topic, key orders.eu.created; 3: ex-routes-direct, key rk-x, header CC [rk-cc]; 4: default exchange, empty body, no properties; 5: timestamp zero, 1970; 6: timestamp 253402300800, the year 10000 | the exchange and routing_key columns |
| `/` | `st-amqp10` | stream | 0: amqp-value string (AMQP 1.0); 1: amqp-value map (AMQP 1.0); 2: amqp-sequence (AMQP 1.0); 3: two data sections (AMQP 1.0); 4: typed application properties (AMQP 1.0); 5: data with a footer (AMQP 1.0); 6: amqp-value with a footer (AMQP 1.0); 7: amqp-value null (AMQP 1.0); 8: one empty data section (AMQP 1.0) | R-S7 AMQP 1.0 bodies and the amqp-1.0 encoding |
| `/` | `st-spoof` | stream | 0: 0-9-1, type amqp-1.0, an encoded amqp-value body; 1: AMQP 1.0 data, annotation x-basic-type amqp-1.0 (AMQP 1.0); 2: 0-9-1 control | R-S7: the spoof does not trigger the AMQP 1.0 label |
| `/` | `st-uuid-key` | stream | 0: annotation x-map with a uuid key (AMQP 1.0) | R-S7: delivered with a 16-byte key on the pinned releases, without the entry on a fixed build |
| `/` | `st-hostile-headers` | stream | 0: headers __proto__, constructor and an empty name; 1: x-deep, a table nested 12 levels; 2: x-wide, a table of 4,000 keys; 3: markup in the body and a header | R-S7 header depth, width and key names; the markup component case |
| `/` | `st-buffer-shape` | stream | 0: a JSON object shaped like a Node Buffer | U119: how the results grid renders a JSON payload shaped like a Node Buffer |
| `/` | `st-g2-poison-mid` | stream | 0 to 1: good (AMQP 1.0); 2: poison: a uuid application property (AMQP 1.0); 3: good (AMQP 1.0) | R-S17, a numeric and a keyword start |
| `/` | `g9-poison` | stream | 0 to 4: good; 5: poison: annotation x-char, a char (AMQP 1.0); 6 to 9: good | R-S17, a poison between 0-9-1 messages |
| `/` | `h1-props` | stream | 0: good (AMQP 1.0); 1: poison: a content type of 300 bytes (AMQP 1.0); 2: good (AMQP 1.0) | R-S17 offset 1 |
| `/` | `h3-solo` | stream | 0 to 1: good, its own chunk (AMQP 1.0); 2: poison: a uuid application property, its own chunk (AMQP 1.0); 3: good, its own chunk (AMQP 1.0) | R-S17, one chunk per offset |
| `/` | `h3-wide` | stream | 0 to 9: good, x-wide of 4,000 keys; 10: poison: a uuid application property (AMQP 1.0); 11 to 12: good, x-wide of 4,000 keys | R-S17 with costly header tables |
| `/` | `st-restricted` | stream | 0 to 1: JSON | the consume 403 as studio-reader, whose pattern does not name it |
| `/` | `st-invoices-0` | stream | 0 to 3: through the super stream exchange, key 0 | a super stream partition |
| `/` | `st-invoices-1` | stream | 0 to 3: through the super stream exchange, key 1 | a super stream partition |
| `/` | `st-invoices-2` | stream | 0 to 3: through the super stream exchange, key 2 | a super stream partition |
| `billing` | `st-billing-audit` | stream | 0 to 9: JSON audit | a second virtual host |
| `/` | `q-classic-orders` | classic | 0 to 2: JSON | the queue detail; the R-S1 oracle |
| `/` | `q-classic-empty` | classic | empty | an empty queue |
| `/` | `q-classic-dead` | classic | empty | the dead-letter target |
| `/` | `q-quorum-payments` | quorum | 0 to 2: JSON | a quorum queue with a dead-letter exchange |
| `/` | `q-quorum-nodlx` | quorum | 0 to 2: JSON | a quorum queue |
| `/` | `q-canary` | classic | empty | the R-S1 control take; the live check publishes its one message |
| `billing` | `q-billing-invoices` | classic | 0 to 1: JSON | a classic queue in billing |
| `billing` | `q-billing-ledger` | quorum | 0 to 1: JSON | a quorum queue in billing |
<!-- seed-table:end -->

### 14.3 The live read-only check

[`tests/live/rabbitmq-read-only.ts`](../../tests/live/rabbitmq-read-only.ts) runs every provider surface, reads included, as `studio-wide-read`, which may read every queue, and asks the broker's own counters whether anything was taken: the whole `queue_delivery_metrics` row of every classic and quorum queue is compared before and after, absent rows included; one control take of the canary's message must move `queue_get_total` by exactly 1, else the check fails as broken.
It also checks a cancel after the read started, the 403 for a stream outside `studio-reader`'s pattern, Test Connection's caution as each user, and that no connection named "LibreDB Studio" is left 6 s after the run, with a positive control.
CI runs it in the Functional Smoke job against a fresh 4.3.6 broker; 4.2.9 is run by hand against the `rabbitmq-42` profile.

### 14.4 Record of live runs

<!-- live-record:start -->
- 2026-10-12, RabbitMQ 4.3.6 (`sha256:8dd6e357...`), compose fixture: `tests/live/rabbitmq-read-only.ts --dedicated` passed 122/122; the control take moved `queue_get_total` by 1.
- 2026-10-12, RabbitMQ 4.2.9 (`sha256:9e9fd21d...`), `rabbitmq-42` profile, by hand: passed 122/122.
- 2026-10-12, the capture gate: offsets 7 and 8 of `st-orders`; the shown cell matches the pattern, and the whole body is proven by SHA-256 over the received prefix and every skipped byte on the provider's no-copy path.
- 2026-10-12, the consume backstop: a classic queue answered the provider's consume with 406 and delivered nothing.
- 2026-10-12, a 50 ms round trip: 10 stored messages read in full, stopped idle after 1,425 ms.
- 2026-10-12, a vhost of 520 classic queues, 1 quorum queue and 510 streams filled in 5,296 ms; the Streams folder held 500 streams.
<!-- live-record:end -->

## 15. Known limitations

- The tree handles about 1,200 virtual hosts, and there is no typed virtual host list.
- A full Streams folder shows at most the last 500 stream names; MCP sees those as the whole list.
- Compressed sub-entry batches published over the stream protocol are not delivered to an AMQP 0-9-1 reader, and offsets inside them are skipped.
- On 4.2.x and 4.3.0 to 4.3.6 a message the broker cannot convert ends every read that reaches it ([§5.6](#56-messages-the-broker-cannot-convert-541)).
- Managed services are not claimed: none was tested.

## 16. References

- RabbitMQ is a trademark of Broadcom, Inc. in the U.S. and other countries; LibreDB Studio is not affiliated with or endorsed by Broadcom.
- [RabbitMQ documentation](https://www.rabbitmq.com/docs), [Streams](https://www.rabbitmq.com/docs/streams), [Management Plugin](https://www.rabbitmq.com/docs/management).
