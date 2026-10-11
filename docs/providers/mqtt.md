# MQTT Provider

Read-only access to an MQTT broker's topic tree, over MQTT 5.0 (issue #1635).

Every rule below is followed by its evidence: a measurement we ran, a source line in this repository, a clause
of the OASIS MQTT 5.0 specification, or a cited line in a third-party implementation at a named version. Where
a rule is a choice rather than a measurement, it is marked CHOICE and its cost is stated.

## Before you connect

Read this section first. It explains the one thing about this provider that differs from every other engine
Studio connects to.

**MQTT has no command that lists topics.** There is no `SHOW TABLES`, no `SCAN`, no catalog. A client learns a
topic exists only by subscribing to a filter and waiting for a message on it. A topic that nobody published to
during the read is indistinguishable from a topic that does not exist.

That is a property of the protocol, not a gap in this provider. The consequence runs through every screen:

- **This provider never says a read was complete.** It cannot be established, so it is not claimed.
- **It says a read was incomplete only where it can prove it**: a refused subscription, a broker that closed
  the connection, or a message skipped for being over the inbound limit.
- **It never infers incompleteness from timing.** Measured across twelve cases, the quiet gap before a lossless
  read ran 214 ms to 4,013 ms and before a lossy one 5,954 ms to 19,894 ms: the two sets do not separate, and
  the ordering is inverted. A silence threshold would have been wrong in both directions.

## 1. Overview

A connection subscribes once to a discovery filter, collects what the broker delivers until one of Studio's own
budgets ends the read, and disconnects. The topic names become the tree in the Keys panel. Clicking a topic
reads that one topic's payload.

### Concept mapping

| MQTT | Studio |
|---|---|
| Broker | Connection |
| Topic | Key, in the Keys panel |
| Topic level (`a/b/c`) | Folder in the tree, `/` as the separator |
| Retained message | A row that exists without live traffic |
| Message Expiry Interval | The row's type cell, as the server reported it |
| Payload | The topic's Source tab |
| `$SYS` | Not read at all unless the filter names it: `#` never matches a `$` root |

A broker has no tables, no indexes, no schema, no sessions a client can list and no statistics to read. Every
surface that would show one says so rather than showing an empty panel.

## 2. Architecture

### 2.1 Where it sits

`src/lib/db/providers/keyvalue/mqtt/`, beside Redis, etcd and Oxia. The Keys panel is the surface; there is no
query console in this version.

### 2.2 Modules

| File | What it holds |
|---|---|
| `constants.ts` | Every number and fixed name, in one pure module |
| `encoder.ts` | The five packets this provider can write |
| `valve.ts` | The one-way valve, outbound and inbound |
| `session.ts` | One connection and one read over it |
| `key-scan.ts` | The Keys panel's capability and its page |
| `objects.ts` | The `topic` object kind and the Source tab |
| `labels.ts` | The provider's labels |
| `index.ts` | The provider class |

### 2.3 Registration & lifecycle

`connect()` performs the read, and the Keys panel's first page is drawn from it. Opening a folder or typing a
prefix narrows the read already held and issues no request; the refresh button performs a new read that
replaces the tree (section 5). Two reads are never merged into one tree.

### 2.4 The decoder, and why

The decoder is `mqtt-packet` 9.0.2, imported by the subpath `mqtt-packet/parser.js` and never by the package
root. The distinction is the point, and an earlier version of this provider got it wrong. The package root is
three lines:

```js
exports.parser = require('./parser').parser
exports.generate = require('./generate')
exports.writeToStream = require('./writeToStream')
```

Importing the root puts the packet writer in the build, one call away from a PUBLISH, and three reviewers in
turn loaded that module and generated one to show it: `30060003612f6278`, a real eight-byte PUBLISH. The
subpath is `module.exports = Parser`, a class carrying the parser factory as a static, and `generate` and
`writeToStream` are both `undefined` on it. `tests/unit/db/mqtt/outbound.test.ts` asserts that from the
loaded module, and asserts the root carries both, so the difference between the two paths is pinned rather
than described. `src/types/db-drivers.d.ts` declares only the subpath's own surface, so a later `generate(...)`
does not compile.

It was chosen for the reason that matters in a module parsing bytes from an untrusted source: it is the
decoder with by far the widest deployment among MQTT packet parsers on npm, and it carries no advisory that
applies to 9.0.2. The encoder, the connection manager and the valve are this repository's own.

## 3. Design decisions

### 3.1 Read-only is structural, not a mode

`encoder.ts` exports functions for CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT. There is no function
that writes a PUBLISH, and `encodeConnect` takes no Will parameter, so neither can be produced by a caller, a
configuration mistake or a later edit that forgets the rule. `enforcesReadOnly` is therefore true whatever the
connection's read-only checkbox says.

### 3.2 The one-way valve

`valve.ts` re-checks the bytes themselves before they reach the socket. The encoder is our code; the valve is
about everything that is not: a library upgrade, a transport that retries a frame, a future helper. It refuses
any packet type outside the five, and refuses a CONNECT whose Will flag is set.

### 3.3 The inbound size limit is ours, and is not declared to the broker

CHOICE. Declaring a Maximum Packet Size in CONNECT makes the loss invisible: "Where a Packet is too large to
send, the Server MUST discard it without sending it and then behave as if it had completed sending that
Application Message" [MQTT-3.1.2-25].

The limit is 8 MiB, `MQTT_MAX_INBOUND_BYTES` in `constants.ts`, and a message over it is skipped by byte count
without its body ever being buffered. Measured both ways on the same server with the same retained message,
whose payload is 12 MiB, comfortably over the limit:

| | Result | What Studio reports |
|---|---|---|
| Limit declared in CONNECT | The broker silently discards the message | "nothing missing" |
| Limit not declared, enforced by us | We read the header, skip the body, never allocate | `The message on "buyuk/olcum" is 12,582,926 bytes, larger than this connection reads, and was skipped.` |

The figure is the packet's Remaining Length, which is the number the header declares and the only one in hand
when the decision is made; the frame on the wire is five bytes longer.

A message at or under 8 MiB is delivered and read normally; the limit exists for the one that is not.

The limit has to live in the valve because no package can carry it. Measured across twenty-six packages, in
none of them can an inbound bound of our own be applied before memory is committed. Two do check before
allocating and neither can carry this work: `@seriousme/opifex` 2.3.0 hardcodes 4 KB, does not expose it on its
public API and reconnects by itself; `@qualithm/mqtt-wire` 0.3.1 checks correctly but is a server library with
no client state machine.

### 3.4 Never a slow consumer

No work is done on the receive path. Bytes come off the socket as fast as they arrive and are processed
separately, so the broker never sees Studio as slow and never starts dropping on its behalf. If our own buffer
fills, that ends the read cleanly rather than pushing back on the broker: pushing back is what turns a visible
end into a silent loss. This is also why the tree holds names only and why every read carries a budget.

### 3.5 Maximum QoS 0, as a requirement

The five-packet set is conforming only at QoS 0. At QoS 1 the receiver MUST answer each message with a PUBACK,
and at QoS 2 with PUBREC and PUBCOMP (section 4.3), none of which this provider can write, so a higher QoS
would stall the read instead of failing visibly.

### 3.6 Shared and exclusive filters are refused before SUBSCRIBE

`$share/`, `$queue/` and `$exclusive/` are refused, case sensitively. A shared subscription hands each message
to exactly one member of the group, so a read-only tool silently eats commands meant for a device: in our lab,
of twenty commands published to a shared filter, ten went to Studio and never reached the device. No broker
reports that it happened, and Mosquitto, EMQX and HiveMQ all answer SUBACK Granted, so the check has to
happen before the packet is sent.

The comparison is case sensitive because `$SHARE/...` in uppercase is an ordinary topic carrying real data.

### 3.7 The Keys panel cursor

CHOICE. The provider answers `cursor: "0"`, which `types.ts:779` defines as "this walk reached the end". Cost:
the panel's "Scan more" is disabled, so a reader cannot ask for the rest.

The alternative was worse. A live cursor would make each "Scan more" open a second connection and merge its
answer into the first tree, and two half-reads merged produce a tree that never existed on the server at any
instant: in our measurement read one held A, B, C; between the reads A was deleted and D was added; read two
held B, C, D; the merge showed four topics where the server never had more than three.

### 3.8 The discovery filter default is `#` alone

CHOICE. `#` never matches a topic whose first character is `$` ([MQTT-4.7.2-1]), so a default read does not
reach `$SYS` at all and no `$SYS` branch appears in the tree. Nothing in this provider special-cases it; the
protocol does. Cost: a reader who wants broker statistics types `$SYS/#` by hand, and it is then an ordinary
first level like any other. Reasons: `$SYS/#` is the widest form the tree can take, it changes
under the reader with no action of theirs, and on EMQX it carries each device's client id, username and IP
address, so a default that pulled it would put that on screen for anyone who opens the panel.

## 4. Connection

### 4.1 Configuration fields

| Field | Meaning |
|---|---|
| Host | The broker's name or address. In a container, `localhost` is that container: use `host.docker.internal` |
| Port | 1883 plain, 8883 with TLS. The IANA assignment for MQTT |
| User / Password | A broker credential, if the broker checks one |
| Topic filter | What to subscribe to. Empty means `#`. Carried in the Database field, as Oxia's namespace is |
| Allow insecure authentication | The consent for a password sent with no SSL mode to a host that is not this machine, which is refused without it. See 4.4 |
| SSL / TLS | The transport. `disable` is plain TCP. See 4.5 |

There is no connection-string box. Host and port say everything a `mqtt://` URI would.

### 4.2 Client identity

The client id is the fixed prefix `libredb-` plus a mandatory cryptographically random suffix of eight bytes,
rendered as sixteen hex characters. Neither half is a setting: there is no client-id field, and changing the
prefix means changing `MQTT_CLIENT_ID_PREFIX` in `constants.ts`. A broker that enforces `clientid_prefixes`
and refuses this one answers CONNACK 0x85, which Studio names in full.

The suffix is what matters. MQTT ends the older session when a second connection arrives with the same id
(Session Taken Over, 0x8E, section 3.1.4), so a colliding id disconnects whoever connected first.

This is the shape the reference client uses, with a weaker suffix and a fixed prefix: `mosquitto_sub -I` is
implemented as `snprintf(cfg->id, ..., "%s%d", cfg->id_prefix, getpid())`
(`mosquitto/client/client_shared.c`, v2.1.2). Our suffix is random rather than the process id, because
process ids are small and repeat across container restarts.

A zero-length client id, which makes the server assign one, is not offered.

### 4.3 Session

Clean Start with a Session Expiry Interval of zero. Nothing is left behind for the broker to queue for a client
that is not coming back, which is itself one of the ways a broker silently drops a device's messages. Both are
asserted byte by byte off the written CONNECT in `tests/unit/db/mqtt/outbound.test.ts`, because neither is
visible in a replayed capture: a capture records what a correct CONNECT produced.

### 4.4 Credentials in the clear

A password sent with no SSL mode crosses the network in cleartext. Studio refuses that combination unless the
host is this machine or an SSH tunnel carries the connection, and the Allow insecure authentication box is the
override for a reader who has a reason. The remedy the hint names first is an SSL mode, not the override.

### 4.5 TLS

The five SSL modes mean here exactly what they mean everywhere else in Studio, which is the rule stated in
`src/lib/types.ts` and followed by Redis, MongoDB, Couchbase, Kafka and Prometheus:

| Mode | Transport | The broker's certificate |
|---|---|---|
| `disable` | Plain TCP | Not used |
| `require` | TLS | **Not checked.** A self-hosted broker ordinarily presents a self-signed certificate, and refusing it would make the ordinary local TLS deployment unreachable |
| `verify-system` | TLS | Checked against the runtime's own trust store, with nothing to paste |
| `verify-ca` | TLS | Checked against the CA certificate pasted into the panel |
| `verify-full` | TLS | Checked, including the host name |

An explicit `rejectUnauthorized` on the connection overrides the mode's default in either direction.

Three details are worth knowing:

- **The panel's three certificate boxes are used.** A CA certificate, a client certificate and its private key
  are passed to the TLS dial as `ca`, `cert` and `key`. A broker signed by a private CA is reachable in
  `verify-ca` with the CA pasted in, and a broker that asks for a client certificate gets one.
- **A broker addressed by an IP literal verifies against its IP SAN.** The server name and the identity are
  two different things. Node refuses an IP address as a TLS server name, so a connection to `10.0.0.5` sends
  no server name at all, and the certificate is checked against `10.0.0.5` itself, which reads the
  certificate's IP SAN. A hostname is sent as typed, because SNI reads it.
- **Through an SSH tunnel the certificate is checked against the far end.** The socket dials the local
  forward, and the certificate belongs to the broker the tunnel reaches, so the forward's address is not the
  identity. This is the same rule `tlsAgentOptions` applies for every provider that speaks HTTP.
- **A failed verification says so.** In a `verify-` mode a self-signed broker fails with the certificate error
  rather than a timeout, so the cause is on screen rather than inferred.

### 4.6 SSH tunnel

Offered, and it works as it does for every other engine: the tunnel carries the TCP connection and the broker
sees a local client. It is also the remedy the password hint names for a broker with no TLS, because a tunnel
encrypts the credential the broker cannot.

With TLS on as well, the certificate is checked against the tunnel's far end rather than against the local
forward, which is the second bullet in 4.5.

### 4.7 Server versions

MQTT 5.0 only. The CONNECT declares version 5 and the decoder is built for version 5, so a broker that does
not speak 5.0 refuses the handshake rather than half-working: a 5.0 broker refusing the version answers 0x84
(Unsupported Protocol Version), and a 3.1.1 broker answers the older CONNACK's return code 1. Studio names
both. A code outside the fourteen in 10.1 is reported as itself in both bases. The brokers measured are in
section 8.

## 5. The read

A read ends on one of Studio's own budgets: elapsed time (3 seconds), message count (50,000) or bytes (32 MiB).
It never ends on an inferred signal, and the retain flag is a per-row label rather than a stop signal. Two of
these three had no test that could produce them until a mutation run found that out; all three now do, in
`tests/unit/db/mqtt/session.test.ts`.

A read can also end because the broker ended it. The six end reasons and the sentence each produces are in
section 10.

**Refresh reads the broker again.** Opening a connection performs one read, and the Keys panel's first page is
drawn from it, so opening costs one read rather than two. A refresh, which asks for the same first page
again, performs a new read and replaces the tree, its row types and the sentence that explains it. A first
page with a different pattern is the panel narrowing what it shows, and is answered from the read already
held: typing a prefix opens no connection. This is what makes "Reading again, or narrowing the topic filter,
sees more" true: a topic the broker retained after the connection opened appears on a refresh, and one it no
longer retains disappears. There is no second page to ask for, by the choice in 3.7.

The retain flag is not a stop signal because it cannot be one. Measured in the lab, against the broker
versions named:

| Broker | Retained topics present | Delivered when the first non-retained message arrived |
|---|---|---|
| Mosquitto 2.1.2 | 10,005 | 10,005 |
| HiveMQ CE | 10,000 | 650 |
| EMQX 5.8.9 | about 10,000 | 1,000 |

The second column is what a client would have had to trust for "the retained set has arrived" to mean the read
is done. One broker delivered everything, one stopped at 650 of 10,000 and one at 1,000: there is no number a
client can wait for.

Every read reports what it saw, why it stopped, and what it can prove it lost. `scope` has two values,
`incomplete` and `unknown`; `complete` is not one of them. `MQTT_KEY_SCAN.totalScope` is `none`, which tells
the panel not to read the page's `total` at all; the field itself is `0` on every page, because the shape
requires a number and there is no count a broker publishes.

## 6. Objects

### 6.1 The `topic` kind

One object kind, `topic`, enumerated by the key browser. Declaring it is what opens a topic's payload in a
Source tab rather than a generated read, and it is also what keeps the kind out of the Objects tree, out of
inventory and search, and out of the agent's grounding walk.

Counts are the exception: `POST /api/db/objects/counts` returns the provider's own answer verbatim, so this
provider simply counts nothing. A broker publishes no count of its topics, and a number produced from what one
read happened to see would be a total with nothing behind it.

### 6.2 The Source tab

Clicking a topic opens a second read subscribed to that one topic, which is the only read that keeps a payload.
The tree itself holds names only: holding every payload is the single most effective way to become a slow
reader, which is when a broker starts dropping messages on Studio's behalf.

### 6.3 Lifetime, and why nothing is computed from it

The row's type cell carries the server's own Message Expiry Interval and nothing is derived from it. The wire
carries what is left of a message's lifetime, never its age: age would be the publisher's original value minus
what arrived, and the first term is never transmitted.

Two of the five brokers in section 8, HiveMQ CE and NanoMQ, do not reduce the value at all. Mosquitto does:
measured on 2.1.2, a message published with an expiry of 3,600 seconds was delivered at 3,588. `[MQTT-3.3.2-6]`, in section 3.3.2.3.3, reads:
"The PUBLISH packet sent to a Client by the Server MUST contain a Message Expiry Interval set to the received
value minus the time that the Application Message has been waiting in the Server." The requirement carries no
exception for retained delivery, and section 3.3.1.3 describes exactly that wait, so HiveMQ CE and NanoMQ
returning the publisher's original value is a departure from the clause. Studio does not branch on it: a client
cannot tell a conforming small number from a non-conforming one, so the number is shown as the server's answer
and the label says so.

### 6.4 Object edit (#789): nothing to write

MQTT declares no editable object kind and no write path; a topic's Source tab is read-only. This is not a
decision that could be reversed by a setting: this provider has no code that can write to a broker.

## 7. Monitoring & health

A broker keeps no catalog and publishes no statistics a subscriber can read, so Health reports what the last
read saw and nothing else. There are no slow queries, no active sessions, no table or index statistics and no
maintenance operations.

## 8. Measured broker behaviour

| Broker | Status | Notes |
|---|---|---|
| Mosquitto 2.0.22 / 2.1.2 | Supported | Delivers the retained set in one burst at subscribe time. A broker-side queue limit can truncate a large retained set; raising `max_queued_messages` fixes it |
| EMQX 5.8.9 / 6.3.1 | Supported, but not with the default filter | Refuses `#`, `+/#` and `$SYS/#` out of the box, with SUBACK 135, from loopback as well as from anywhere else: a stock `acl.conf` carries `{deny, all, subscribe, ["$SYS/#", {eq, "#"}, {eq, "+/#"}]}`. So on a stock EMQX the default filter reads nothing and the panel says the subscription was refused; a branch such as `sensors/#` is granted and reads. A retained message over 1 MB is acknowledged to the publisher and never stored |
| HiveMQ CE | Supported | Does not decrement message expiry, contrary to `[MQTT-3.3.2-6]` |
| NanoMQ | Supported with a caveat | Sends a `MaximumPacketSize` one above the largest expressible packet, which a strict client library rejects. Does not decrement message expiry |
| RabbitMQ 4, MQTT plugin | Connects, discovery does not work | Does not deliver retained messages to a wildcard subscription, only to an exact topic. SUBACK is Granted in both cases, so the tree simply comes back empty |

## 9. Capabilities & labels

`getCapabilities()` answers before any connection, and every surface a broker does not have is declared absent
by name rather than left to a default.

| Capability | Value | Why |
|---|---|---|
| `enforcesReadOnly` | `true` | Structural, not a setting: see 3.1 |
| `queryLanguage` | `json` | The tab's editor language, shared with Kafka |
| `queryDialect` | `mqtt` | Its own, so a connection never falls through to MongoDB's tab (#427) |
| `defaultPort` | `1883` | The IANA assignment |
| `supportsResultPagination` | `false` | There is no second page to ask a broker for: see 3.7 |
| `supportsTransactions` | `false` | A broker has no transaction |
| `declaresForeignKeys` | `false` | A broker has no schema |
| `keyScan` | `MQTT_KEY_SCAN` | `cursor: "decimal"`, `totalScope: "none"`, no level scan |

`MQTT_LABELS` names the entity "Topic" and the row "Message". The three actions a broker cannot perform,
Generate, Analyze and Vacuum, read "Not available" with the reason beside them, because a disabled control
with no reason reads as a defect: Analyze says a broker keeps no catalog and no statistics a client can read,
and Vacuum says maintenance would be a write and this provider has no code that can write to a broker.

### 9.1 Machine access

`MCP_EXPOSABLE.mqtt` is `false`, as for etcd, Oxia and S3. A read whose completeness cannot be proved is not a
read an agent should be handed without a reader looking at it: an agent asked "is the sensor reporting?" would
receive the absence of a topic as evidence it does not exist, which is exactly the inference "Before you
connect" says cannot be drawn.

## 10. Error handling

Every failure names a cause, and names a remedy wherever one exists.

### 10.1 A refused connection

CONNACK carries a reason code, and `connackSentence()` turns thirteen of them into a sentence. The number
travels with the sentence in both bases, because a reader searching for it finds the broker's own
documentation.

| Code | What Studio says |
|---|---|
| 0x01 | the broker does not speak MQTT 5.0, which this provider requires: a subscription's reason code and a message's remaining lifetime exist only in 5.0 |
| 0x81 | the broker could not read the CONNECT packet |
| 0x82 | the broker rejected the CONNECT as not allowed on this connection |
| 0x83 | the broker hit an error of its own that it does not describe further |
| 0x84 | the broker does not support MQTT 5.0, which this provider requires |
| 0x85 | the broker refused the client id |
| 0x86 | the username or password is wrong |
| 0x87 | this account is not authorized to connect |
| 0x88 | the broker is unavailable |
| 0x89 | the broker is busy |
| 0x8a | this client is banned |
| 0x8c | the broker asked for an authentication method this provider does not offer |
| 0x97 | the broker's connection quota is full |
| 0x9f | the broker's connection rate limit was reached |

The codes are Table 3-1's. `0x01` is the exception and is deliberate: it is not a 5.0 code at all, but a
3.1.1 broker answers the older CONNACK whose return code 1 means "unacceptable protocol version", and that is
the broker this provider's version policy meets most often.

A code outside the list is reported as itself in both bases rather than guessed at. No sentence echoes a
username or a password.

### 10.2 Why a read ended

Every page carries the reason its read ended, as a sentence rather than a token.

Each cell below is `endReasonSentence()`'s own string, verbatim, trailing full stop included. The panel reads
it as the tail of a longer sentence, which is why each begins in lower case.

| Reason | The sentence |
|---|---|
| `budget-time` | the read reached its time budget. Reading again, or narrowing the topic filter, sees more. |
| `budget-messages` | the read reached its message budget. A narrower topic filter sees more of what matters. |
| `budget-bytes` | the read reached its byte budget. A narrower topic filter sees more of what matters. |
| `server-disconnect` | the broker closed the connection before the budget ran out, so the list is short of what the filter matched. |
| `subscription-refused` | The sentence for the broker's own reason code, in the table below. |
| `transport-closed` | the connection closed before the budget ran out, so the list is short of what the filter matched. |

`subscription-refused` names the remedy that fits the broker's reason code, because the remedies differ: a
stock EMQX refuses `#` and grants `sensors/#` in the same breath, while a broker with no wildcard support
refuses every narrower wildcard too. Each sentence ends with the code in both bases.

| Code | The sentence |
|---|---|
| 0x87 | the broker refused the subscription, so nothing could be read under this filter. Brokers commonly refuse the widest filters and grant narrower ones: try a branch, such as sensors/# instead of # |
| 0x83 | the broker refused the subscription with an error of its own that it does not describe further |
| 0x8f | the broker read the topic filter as invalid. A filter is levels separated by /, with + for one level and # only as the last level: check the filter rather than narrowing it |
| 0x97 | the broker's subscription quota is full, so it accepted no new subscription. This is a limit on the broker rather than anything about the filter |
| 0x9e | the broker does not support shared subscriptions |
| 0xa2 | the broker does not support wildcard subscriptions at all, so no filter carrying + or # can be used on it, however narrow. Typing one exact topic name reads that topic |
| Any other | the broker refused the subscription, so nothing could be read under this filter |

### 10.3 A handshake that never finishes

A server that accepts the TCP connection and then says nothing is the failure that usually hangs a client.
Three separate clocks make it impossible here: the dial itself is timed, the read carries its time budget, and
a read that reaches the end with no CONNACK fails rather than resolving an empty tree. An empty tree would be
the wrong answer, not an empty one.

A broker that hangs up before answering is reported as having closed the connection without answering the
handshake, and one that sends a DISCONNECT first has its reason code named. No cause is guessed: a TLS-only
port does not close a plain connection this way, because its TLS alert arrives as bytes and the read ends in
the decoder instead.

## 11. Testing

### 11.1 How the tests work

Nothing in CI contacts a broker. The provider's transport is a seam, so every test drives it with bytes:
hand-encoded packets where the point is a packet our encoder cannot produce, and four recorded broker captures
where the point is a real broker's wire.

The structural claims are asserted structurally. The valve is handed a PUBLISH directly rather than being
observed not to send one; the write sweep counts `.write(` call sites across the whole provider directory; the
decoder's import specifier is pinned, and the package root is loaded alongside it as the control.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/unit/db/mqtt/ tests/integration/db/mqtt-provider.test.ts
```

| File | What it holds |
|---|---|
| `tests/unit/db/mqtt/valve.test.ts` | The one-way valve, inbound and outbound, and the Variable Byte Integer |
| `tests/unit/db/mqtt/outbound.test.ts` | What reaches the wire: the CONNECT field by field, the SUBSCRIBE, and the decoder's specifier |
| `tests/unit/db/mqtt/session.test.ts` | The client id, the CONNACK sentences, the three budgets, and the payload the tree does not hold |
| `tests/unit/db/mqtt/inbound-limit.test.ts` | The 8 MiB skip, including a body spanning chunks and the heap it does not grow |
| `tests/unit/db/mqtt/key-scan.test.ts` | The page, its truncation report and every end-reason sentence |
| `tests/unit/db/mqtt/provider.test.ts` | The declarations, the refusals, and the dial against a loopback server |
| `tests/integration/db/mqtt-provider.test.ts` | The four captures, replayed |
| `tests/unit/key-browser-line-contrast.test.ts` | The panel's text colours, as contrast ratios |
| `e2e/mqtt-provider.spec.ts` | The connection dialog in a browser |

### 11.3 The captures

`tests/fixtures/mqtt/captures/` holds four recordings, each the bytes one broker sent:

| Capture | Why it exists |
|---|---|
| `mosquitto-2.1.2.json` | The ordinary case |
| `hivemq-ce.json` | A second implementation's framing of the same thing |
| `nanomq.json` | A topic beginning with `/`, whose first level is empty and legal |
| `mosquitto-rap.json` | Retain As Published: both messages arrive with the retain bit set, including the one published live |

Each replay asserts the topics by name and the type of each, so a decoder that recorded nothing fails here.

## 12. Known limitations

- No query console. MQTT has no query language, and the Keys panel needs no query text.
- No agent mode, for the reason in 9.1.
- No WebSocket transport. A broker reached over `ws://` or `wss://` cannot be connected to in this version;
  plain TCP and TLS are the two transports.
- No vendor list APIs. EMQX exposes a real retained count over its management HTTP API; using it would need an
  admin account, it is not MQTT, and it does not exist on every broker. Candidate for a later version.
- `$SYS` is not subscribed to by default, for the reasons in 3.8.
- The Keys panel cannot ask for a second page, by the choice in 3.7.

## 13. References

- OASIS, *MQTT Version 5.0*, OASIS Standard, 7 March 2019. The clauses cited above:
  - [MQTT-3.1.2-25], section 3.1.2.11.4: a server MUST discard a packet too large to send
  - [MQTT-3.3.2-6], section 3.3.2.3.3: Message Expiry Interval is decremented by the time waited
  - [MQTT-4.7.2-1], section 4.7.2: a wildcard never matches a topic beginning `$`
  - Section 3.1.4, Session Taken Over; section 4.3, the QoS acknowledgement flows; section 1.5.5, the
    Variable Byte Integer
- Mosquitto's reference client, v2.1.2, `client/client_shared.c`: `mosquitto_sub -I` builds its id as
  `snprintf(cfg->id, ..., "%s%d", cfg->id_prefix, getpid())`. Cited in 4.2 by the code it contains rather
  than by a line number, which moves between releases.
- The design: issue [#1635](https://github.com/libredb/libredb-studio/issues/1635), "Read-only MQTT provider".
