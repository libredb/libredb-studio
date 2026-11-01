# Sparkplug B Provider

Issue #1720. One MQTT broker, read only, over the Eclipse Sparkplug B 3.0.0 topic namespace.

Every number in this file was measured against a running broker or read out of this repository's own
source. Where a fact could not be measured, the sentence says so rather than rounding it off.

The brokers behind the measurements are Eclipse Mosquitto 2.1.2 and HiveMQ CE 2026.5, each with its
Sparkplug Aware extension, and Eclipse Mosquitto 1.5.11 where an MQTT 3.1.1 broker was needed. The
reference encoder is Eclipse Tahu `sparkplug-payload` 1.0.3.

## 1. Overview

One subscription reads a plant's own published structure: the groups and edge nodes a broker
carries, the metrics their birth certificates define, and the values their data messages send.

### Concept mapping

| Studio | Sparkplug |
|---|---|
| Catalog | Group (`group_id`, 4.1) |
| Schema | Edge node (`edge_node_id`, 4.1) |
| Relation | The node's own metrics, and one object per device under it |
| Column | A metric a birth certificate declared, with its datatype (6.4.6) |

A group and an edge node exist only in the topic, which is why both are read from it and never
guessed. A device is addressed through the node that owns it (4.1.5), so it is an object kind rather
than a third container level.

### What a reader sees

A tree of groups and edge nodes, a metric's name, alias, datatype, the last value the read carried
with that value's own timestamp, its `is_historical`, `is_transient` and `is_null` flags, its Quality
(6.4.9), which certificate defined it, and whether that certificate was a live birth or the copy an
aware broker had stored.

A read is what one window delivered, never a census of the plant.
Sparkplug has no command that lists edge nodes or devices, and a birth certificate is published at QoS 0 and not retained, so an edge node that published nothing in the window looks exactly like one that is gone.
Agent mode reads on that condition: every agent answer states the window it listened for and what it counted, and says that an edge node or device not seen may still exist (section 14).

## 2. Architecture

### 2.1 Where it sits

`src/lib/db/providers/industrial/sparkplug/`, the second member of the `industrial/` family after OPC
UA.

### 2.2 Modules

| Module | What it holds |
|---|---|
| `topics.ts` | The namespace parser, and the read's subscription filters |
| `decode.ts` | A bounded protobuf reader of this repository's own |
| `values.ts` | Every datatype 0 to 34, read under the declared type |
| `state.ts` | What one read knows: births, deaths, sequence gaps, last values |
| `encoder.ts` | The five packets a read can send, and no sixth |
| `session.ts` | One bounded read: dial, subscribe, take, disconnect |
| `fold.ts` | The join from received messages to read state |
| `results.ts`, `objects.ts`, `request.ts`, `labels.ts`, `constants.ts` | The console's surfaces |

### 2.3 Why the provider carries its own session

The shipped MQTT read returns a map keyed by TOPIC, one row per topic, and its request carries
`filter` in the singular. A Sparkplug read depends on the ORDER of successive messages on one topic:
a sequence gap is read from two consecutive data messages (6.4.3), a rebirth replaces a definition
mid-read (5.17), and the specification warns a death can arrive after the next birth. Fifty data
messages on one topic collapse to one row in that shape.

The cost is stated rather than hidden: two directories carry a similar dial, and that duplication is
the evidence for extracting a shared transport later, which is separate work because extracting it
has to widen the shipped result shape.

### 2.4 Why the decoder is this repository's own

Measured against four published Sparkplug codecs on npm: given an Int32Array one refuses the whole
payload, another refuses on the array, and a third returns the array as `null` WITH NO ERROR. A
reader that cannot tell "empty" from "unreadable" cannot report what it lost.

## 3. Design decisions

### 3.1 Read-only is an absence of code, not a setting

`encoder.ts` encodes CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT, and has no function
that writes a PUBLISH. The decoder half is the import path: the subpath `mqtt-packet/parser.js` is
the packet reader and reaches no writer, while the package root re-exports `generate` and
`writeToStream`.

The directory holds exactly five `.write(` call sites, all in `session.ts`, and each is handed a
packet that encoder produced. A sixth write, or a write passed bytes from anywhere else, fails a
guard in `tests/helpers/mqtt-seam-holdings.ts`.

### 3.2 The CONNECT takes no will parameter at all

Specification 5.4 registers an edge node's death certificate as its MQTT will. A reader that
registered one would publish a death on a plant's broker when its own socket dropped. There is no
argument that could set it, so no later edit can set one by passing a value.

### 3.3 QoS 0, and a caller cannot raise it

4.2.1 publishes births at QoS 0. A subscription at a higher QoS would ask the broker to store
messages for this reader, which is the opposite of taking nothing away.

### 3.4 The filters do not overlap

MQTT 5.0 4.7.2 keeps a wildcard from matching a topic beginning with `$`, so the stored certificates
under `$sparkplug/certificates/` need a filter of their own. 3.3.4 lets a server deliver a message
once per matching filter, so two filters that overlap would double a read. The filters this provider
sends are held non-overlapping by a property test.

### 3.5 A refusal's SCOPE is the thing a reader acts on

Four end reasons are refusals and each sends a reader somewhere different: a socket that never opened
(the address), a broker that refused the connection (the credentials), a broker that refused every
subscription (the filter), and a broker that accepts no wildcard subscriptions (the broker itself).
They were one value until a stock EMQX made the difference concrete: it refuses `#` out of the box
with SUBACK 135, and `#` is the filter a Sparkplug read uses when no group is named, so a refused
subscription read exactly like a quiet plant.

One filter refused out of several is still a read, and a thinner one: a broker with no `$sparkplug`
tree commonly refuses the stored-certificate filter and grants the ordinary one.

### 3.6 A value is read under its datatype, never under the field that carried it

6.4.6 says a data message cannot name or type its own values. The datatype comes from the
certificate wherever one named the metric, and a metric that carries its own name may carry its own
datatype, which is the only case where the message is the authority. Signs are recovered from the
datatype's width, because 6.4.17 carries Int8, Int16 and Int32 in a uint32 field and never says how a
negative value is written.

64-bit values are carried as exact decimal TEXT rather than as numbers, because a 64-bit integer
does not survive a JavaScript number.

### 3.7 The protocol's own words are not reserved

5.3 identifies an edge node's birth-death sequence as a metric NAMED `bdSeq`, and there is no field
number to find it by, so finding it means matching a name. Nothing stops an edge node publishing a
metric of its own under that name. Where two carry it this provider takes NEITHER rather than the
first: a wrong `bdSeq` matches a death to the wrong birth, which is reported to a reader as a node
that died when it did not.

### 3.8 The last value in a window wins

6.4.5 lets one window carry the same metric many times, and a row is one line, so the first would be
the oldest.

### 3.9 A window is not a census

A read subscribes for one window and reports what arrived in it.
An edge node publishes its birth when it connects or when a host asks it to rebirth, and its data only when a value changes, so a quiet node and a vanished one produce the same window.
No surface of this provider claims that a node or device does not exist, or that it is offline: the tree's short status says "not seen in this read", and its liveness part says why that is not "gone".
On the agent path the same rule is a sentence every answer carries (section 14.3).

## 4. Connection

### 4.1 Configuration fields

Host, Port, and Group. The group is one `group_id`, or empty for every group: a group is a level of
the topic and not a thing on the broker that can be subscribed to on its own, so an empty field reads
every group under `spBv1.0`.

### 4.2 There is no credential field, and that is deliberate

The session can carry a user and a password and the encoder sets their flags, but nothing passes them
from a connection yet, and this provider declares only the three fields it reads. A field that is
collected and dropped is worse than one that is absent.
A password would still travel in cleartext whenever the socket is plain, with no SSL / TLS panel or the `disable` mode (below), so a credential field needs more than the connection passing it to the session: it also has to refuse, or warn on, a plain socket.

TLS is not absent: the broker is dialled over TLS from the connection's SSL / TLS panel, which the dialog offers for this engine.
`sparkplugTlsMaterial` in [`connection-options.ts`](../../src/lib/db/providers/industrial/sparkplug/connection-options.ts) reads the panel through the shared `nodeTlsMaterial`, so its mode, CA and client certificate are what the handshake uses, and a malformed panel is refused by name before any socket exists.
With no panel, or the `disable` mode, the socket is plain.
Through an SSH tunnel the certificate is checked against the broker the user named, not the local forward.

### Connection string

`sparkplug` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/industrial/sparkplug/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `sparkplug` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/industrial/sparkplug/execution-ui.ts).
What a tree click and Generate Query write is `SPARKPLUG_GENERATORS`, the `sparkplug` row of `DIALECT_GENERATORS`, declared in [`generators.ts`](../../src/lib/db/providers/industrial/sparkplug/generators.ts) and read by the engine-agnostic dispatcher in `src/lib/query-generators.ts`.

## 5. Query interface

A read request is a JSON object and every field in it is optional: the window in seconds and the row
limit fall back to their defaults when they are absent, births are included unless `includeBirths`
says otherwise, and a group, an edge node or a device narrows the read to less than the whole plant. `rebirth`, `hostId`, `command` and `publish` are refused BY NAME rather than ignored, each
with the sentence that says why, and any unknown key is refused with the list of the fields that
exist.

The window travels to the reader rather than being echoed back: an earlier version accepted `seconds`
up to 300, printed it in the result's own sentence, and served rows from the read the connect had
already done, so a user who asked for 42 seconds was told they got 42 and got 3.

A console read's rows are a sample of its window, and its second warning says which budget ended it.
Agent mode does not use this request: it has a closed table of four reads of its own, answered as counts and flags (section 14.2).

### 5.1 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/industrial/sparkplug/sql-grammar.ts`](../../src/lib/db/providers/industrial/sparkplug/sql-grammar.ts), the `sparkplug` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one JSON read request naming a group, an edge node and a window, so no span of it is SQL (#1720).
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/industrial/sparkplug/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

## 6. Schema introspection

### 6.1 Two container levels

Group, then Edge node. Both come from the topic, which is the only place they exist (4.1).

### 6.2 Two kinds

The edge node's own metrics, and one object per device under it. Both declare columns, and both
declare a readable source.

### 6.3 Nullability is not a column property here

`is_null` is a flag on one VALUE in one message (6.4.5), not a property of the definition, so a birth
certificate cannot say a metric is nullable.

### 6.4 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`, and the absence is structural rather
than this version's scope: this provider's encoder has no function that writes a PUBLISH, so there is
no packet it could send that changes a metric. A metric's shape is declared by the birth certificate
its edge node publishes, which only the edge node can publish.

### 6.5 An object's source is the certificate that defined it

A node's Source tab renders its NBIRTH and a device's its DBIRTH, as JSON, because a Sparkplug
payload is protobuf and the decoded object is its only readable form. The part says which copy it is:
a stored certificate's values are birth-time values, which 10.1.4 states outright.

## 7. Monitoring and health

A read reports what it saw and what it could not: how many edge nodes and devices, how many stored
and live certificates, how many nodes published with no certificate in hand, how many deaths arrived,
how many sequence gaps, and how many values arrived under an alias no certificate could name.

There is no "online" count, and that is a measured decision rather than an omission: a node that
published nothing during the window and has a stored certificate is indistinguishable from one that
is running and quiet. The three states a read can tell apart are "not seen in this read", "published
during this read" and "a death arrived during this read".

## 8. Maintenance

None. There is no packet this provider can send that writes.

## 9. Capabilities and labels

`enforcesReadOnly` is true, the provider declares no `createTable`, and `supportsMaintenance`, `supportsExplain`,
`supportsTestDataGeneration`, `supportsResultPagination` and `supportsTransactions` are false. The
dialect record declares `offersCountQuery: false`: a broker publishes no count, and a metric is not a
table.

`catalogSessions` is NOT declared, and the reason is factual rather than scope: that flag says a
connection reaches a whole server and names no catalog, each request running in the catalog the
caller picks. A Sparkplug connection reaches ONE broker, and the catalog-level thing is the Group,
which is a field of the connection rather than a catalog chosen per request.

The panel never says "Sparkplug Compatible" or "Host Application". A Host Application MUST publish
STATE (1.4.1, 10.1.2), and this provider publishes nothing.

### 9.1 Machine access

A read's completeness cannot be proved, so a read handed to an agent carries that with it, or it is not handed over: an agent asked whether a machine is running must not receive the absence of its edge node from one window as evidence that it is gone.

Agent mode reads a plant on that condition (section 14).
Every agent answer states the window it listened for, what it counted in that window and why it stopped, its scope is never `complete`, and it says that an edge node or device not seen in the window may still exist; the tool description, the grounding note and the posture say the same, and none of them says a node is online or offline.
Agent mode is metadata only: no group, edge node, device or host application id, metric name, value, property or stored certificate reaches it.

`MCP_EXPOSABLE.sparkplug` is `false`, as for MQTT, and `MCP_STATEMENT_READ.sparkplug` is `false`, so every MCP tool refuses a Sparkplug connection; no MCP surface that carries the same window and sentence is designed yet ([B165](../BACKLOG.md#b165-sparkplugs-agent-reads-count-what-one-window-delivers-with-ids-withheld-and-it-has-no-mcp-surface)).

### SQL writing

[`sparkplug/sql-writing.ts`](../../src/lib/db/providers/industrial/sparkplug/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
No generator calls `quoteLiteral` for Sparkplug: a read request writes its names into JSON.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).

## 10. Error handling

### 10.1 Every refusal leaves as a `QueryError`

A payload this reader cannot read is refused with the name of the bound it hit rather than dropped
silently, and nothing partial is returned. One refused payload inside a read is one message missing
from the state and is counted, because a refusal that stopped the whole fold would throw away every
message after it and report a larger loss as a smaller one.

### 10.2 A refusal is named for what this reader did

A STATE body this reader cannot parse is counted as "could not read as JSON" rather than "is not
JSON". 3.0 does make a STATE body JSON, but Sparkplug 2.2 carried host state as the plain strings
`ONLINE` and `OFFLINE` (2.2 section 7.5), so a body that is not JSON is not automatically a malformed
one, and an operator reading our sentence should not be sent to their vendor.

## 11. Testing

Unit tests cover the namespace parser, the value layer, the decoder, the read state, the encoder, the
session's fragmented feeding, the fold and the result rows. One end-to-end test drives the whole path
from bytes on a wire to a read state through the session's own transport seam, with no socket, at
chunk sizes 1, 3, 7, 64 and 4096, because a broker writes on its own boundaries and a packet's length
prefix can be split across two chunks.

Mutation testing holds the rules rather than the line count: each entry breaks one rule and the suite
must go red. The set carries a control mutation that changes nothing and must SURVIVE, because a run
reporting every mutation caught looks identical to a run that measured nothing.

## 12. Known limitations

- A Sparkplug 2.2 host's STATE is not read. 2.2 published it at `STATE/<scada_host_id>`, outside the
  `spBv1.0` namespace, and every filter this read sends is inside it.
- No credential fields, as section 4.2 states; TLS comes from the SSL / TLS panel, not from a field of this engine's own.
- The four connection refusals carry one error code and are told apart only by their sentences. The
  information exists one layer up as the read's end reason and is flattened at the throw; carrying it
  through waits on a typed failure field on the shared error.
- No read is complete, in the editor or in agent mode: an edge node or device that published nothing in the window may still exist (section 3.9), and every agent answer says so.
- How often a window of 3, 10 or 60 seconds actually catches a certificate is unmeasured. A birth is
  published at QoS 0 and not retained, so on a broker that does not store certificates a reader sees
  one only while an edge node connects or answers somebody else's rebirth.

## Migration DDL

[`SPARKPLUG_MIGRATION_DDL`](../../src/lib/db/providers/industrial/sparkplug/migration-ddl.ts) is what the schema-diff migration generator writes for `sparkplug`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
A metric's shape is the birth certificate its edge node publishes, and the encoder has no function that writes a PUBLISH, so there is no table DDL to wrap either (#1720).

The refusal reason it prints, verbatim:

- "A Sparkplug metric's shape is declared in the birth certificate its edge node publishes, not in columns a client can change, and this provider's encoder has no function that writes a PUBLISH, so there is no column definition to change."

## 13. References

- Eclipse Sparkplug 3.0.0 specification, sections 4.1, 4.2.1, 5.3, 5.4, 5.10, 5.17, 6.4.x, 10.1.4
- MQTT 5.0: 1.5.5, 3.2.2.3.11, 3.3.4, 3.9.3, 4.7.2
- `docs/providers/mqtt.md` for the transport this provider does not share, and why

## 14. Agent mode

Agent mode reads a plant through `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/industrial/sparkplug/index.ts).
The request reader is [`agent-statement.ts`](../../src/lib/db/providers/industrial/sparkplug/agent-statement.ts), the read, its bounds and its answers are [`agent-read.ts`](../../src/lib/db/providers/industrial/sparkplug/agent-read.ts), and every other surface of an agent-mode handle is [`agent-surface.ts`](../../src/lib/db/providers/industrial/sparkplug/agent-surface.ts).

### 14.1 The boundary

The boundary is the structural closed table of [section 3.1](#31-read-only-is-an-absence-of-code-not-a-setting) and [section 3.2](#32-the-connect-takes-no-will-parameter-at-all): the encoder holds CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT and no function that writes a PUBLISH, and CONNECT takes no Will.
An agent read reaches the wire only through the session's `readOnce`, whose five writes are the only ones in this directory; the agent's modules write nothing themselves and import no encoder, which `tests/helpers/mqtt-seam-holdings.ts` holds, and [`agent-provider.test.ts`](../../tests/unit/db/sparkplug/agent-provider.test.ts) pins every packet each read writes: CONNECT with Clean Start and no Will bit, one SUBSCRIBE, UNSUBSCRIBE and DISCONNECT, and nothing else.
This provider sends no credential (section 4.2), so no credential can be the boundary either: a broker that lets an anonymous client publish takes whatever its client sends, and the encoder is what keeps Studio from sending one.

### 14.2 What an agent request may be

One JSON object, with the key `read` and the console's own names for the levels, `group`, `edgeNode` and `device`, each written once:

| Request | What it sends | What it answers |
| --- | --- | --- |
| `{"read": "window"}` | one SUBSCRIBE to `spBv1.0/#` (or to the connection's own group, `spBv1.0/<group>/#`), for one window | one row of totals: `groups_seen`, `edge_nodes_seen`, `devices_seen`, `messages`, `nbirth`, `ndeath`, `ndata`, `dbirth`, `ddeath`, `ddata`, `other_messages`, `metrics`, `payload_bytes`, `messages_not_decodable`, `payloads_not_kept` |
| `{"read": "group", "group": "G"}` | one SUBSCRIBE to `spBv1.0/G/#` | one row for that group: `seen`, `messages`, the six counts by type, `birth_seen`, `death_seen`, `last_seen_ms`, `metrics`, `payload_bytes`, `messages_not_decodable`, `payloads_not_kept` |
| `{"read": "edgeNode", "group": "G", "edgeNode": "E"}` | one SUBSCRIBE to the node's own `NBIRTH`, `NDEATH` and `NDATA` topics, written in full | the same row for that edge node, with the three device counts null |
| `{"read": "device", "group": "G", "edgeNode": "E", "device": "D"}` | one SUBSCRIBE to the device's own `DBIRTH`, `DDEATH` and `DDATA` topics, written in full | the same row for that device, with the three node counts null |

Every row opens with the window's own columns: `window_ms` (how long the window ran, from the start of the read with the dial inside it: 3,000 ms unless the broker or a budget ended it sooner), `listened_ms` (how long the subscription listened, from the SUBSCRIBE to the end of the read, never more than `window_ms`), `stop_reason` (an end reason of the session: `time-budget`, `message-budget`, `byte-budget`, `broker-closed`, `subscription-refused` or `wildcards-unavailable`), `scope` (always `window`, never `complete`), `broker_reason_code` where the broker refused the subscription, and `subscriptions_refused`, how many of the read's filters the broker refused while it granted the rest.
A group, edge node or device not seen answers `seen: false`, zero counts and a null `last_seen_ms`, never that it does not exist.
`last_seen_ms` is the last message's, counted from the SUBSCRIBE as `listened_ms` is, while the counts, `metrics` and `payload_bytes` are the window's, and every exact answer says so; `birth_seen` and `death_seen` say whether the window saw a birth or a death, never whether the object is online or offline now.
`metrics` counts the metrics the birth and data messages carried; a payload is decoded only to count them, and one the decoder refuses is counted in `messages_not_decodable` with its message still counted by type.
In the window read, `other_messages` counts what is not an edge node's or device's own birth, death or data: host application state, a command another client sent, and topics outside the namespace's form.

Everything else is refused before anything is sent, in agent mode's words with the list of reads and "Nothing was sent.", decided by the request's text and the connection's own Database field alone: a key other than these four (a topic, a filter, a window, `rebirth`, `hostId`, `command`, a payload, a will, a certificate), a read outside the four (a publish, `NCMD`, `DCMD`, a rebirth, host state), an id with `+` or `#`, an id with `/`, a group named `STATE` (host applications publish their state at `spBv1.0/STATE/<host id>`), an id that is not one topic level of 1 to 1,024 bytes of well-formed UTF-8 with no null character, a group other than the one the connection's Database field names, and a request longer than 4,096 characters.
No request can reach `$sparkplug/` or a shared subscription: the model writes no topic, and every filter is Studio's own.
A filter the model writes would let it find ids one level at a time, which is why an exact read names every level above it in full and the edge node and device reads subscribe to exact topics with no wildcard at all.
The exact reads answer whether that one object was seen and nothing about any other: a hit and a miss differ only in that object's own figures, and a group read answers no count of the edge nodes or devices in it, so no answer can be narrowed toward an id the request did not name.
The answer does not echo the id the request named.
A time budget too short for the window and a second to settle (4,000 ms) is refused rather than shortened; the window's clock starts before the dial, so the read ends on it whatever the broker does.
A window ended by Studio's message or byte budget is answered as the window it was, with that stop reason.
A result past the byte budget is refused.
A failure is worded by its kind (an address that could not be reached, a certificate not trusted, a refused connection with its reason code, a handshake that never finished, an answer that is not MQTT 5.0, the time budget), never in the broker's or the transport's words.

### 14.3 What is withheld, and why

Group, edge node, device and host application ids are stored values: they name the plants, machines and people behind them, as an MQTT topic or an S3 key does.
So are metric names, metric values, properties, datasets, templates, aliases and the birth certificates an aware broker stores.
None of them reaches agent mode through a row, a column name, a warning, an error, the grounding or Operate.

Every answer carries the window's own account (how long it listened to what, why it stopped and what it counted), on an exact read the sentence that `last_seen_ms` is the last message's, a sentence for refused subscriptions and uncounted payloads where there were any, and the completeness sentence: "An edge node or device not seen in the window may still exist: Sparkplug has no command that lists edge nodes or devices, a birth certificate is published at QoS 0 and not retained, and an edge node that published nothing in the window looks exactly like one that is gone, so no answer is a complete count of the plant, and no answer says that a node or device is online, offline or absent, only what the window saw."

| Path | Handle | What it reads |
| --- | --- | --- |
| Investigation reads | agent read-only profile | one fresh session per read of [section 14.2](#142-what-an-agent-request-may-be) |
| Connect | either agent profile | a handshake that subscribes to nothing: CONNECT and DISCONNECT |
| Investigation grounding and plan-mode grounding | either agent profile | nothing: the tree answers its reason, so the run is told why no id is listed and how to read one the question names |
| The tree, an object's listing and description, its birth certificate, the console | either agent profile | nothing: each is refused with its reason |
| Overview, health, performance, slow-query, session, table, index and storage readings | either agent profile | nothing: each answers its reason, never Studio's own figure or an empty reading |

### 14.4 Agent language pack

Statement-language family: `sparkplugread`.
Overlay: [`src/lib/agent/languages/sparkplugread/engines/sparkplug.ts`](../../src/lib/agent/languages/sparkplugread/engines/sparkplug.ts), with its client row in [`src/lib/agent/languages/sparkplugread/engines/client.ts`](../../src/lib/agent/languages/sparkplugread/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`.
Both overlays are empty, so the engine resolves to the `sparkplugread` family pack itself.
The `sparkplugread` statement-language family has no dialect-bound member.
This overlay overrides no Shared member, so every Shared member is the `sparkplugread` statement-language family's own.
The family offers the investigation workflow, through `run_read_query` with one read request, and the operations workflow; it offers no query optimization or database assessment, since a broker has no plan and no profile, and no data analysis, whose tools need stored values, and no workflow hands an answer to the editor.
The investigation rule tells the model to read a group, edge node or device the question names directly, to read the window only for the plant's totals, never to guess an id, and to report an object not seen as not seen in that window, never as absent or offline.
A plan of the investigation is prose: the editor's console request reads metric values, which agent mode never reads, and plan mode is ungrounded on it, as agent mode is.
The editor language id stays `sparkplug`, and the fence alias `sparkplugread` names this engine.
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.
No MCP tool reads a Sparkplug plant: the family declares no MCP facet, `MCP_EXPOSABLE.sparkplug` and `MCP_STATEMENT_READ.sparkplug` are false ([B165](../BACKLOG.md#b165-sparkplugs-agent-reads-count-what-one-window-delivers-with-ids-withheld-and-it-has-no-mcp-surface)), and `READ_ONLY_ENFORCED.sparkplug` is unchanged.
