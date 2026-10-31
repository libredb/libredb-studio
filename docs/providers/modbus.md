# Modbus Provider

Modbus TCP, read-only: a device or a gateway in front of serial devices, read over a raw socket by
a client this repository owns.

Issue: [#1723](https://github.com/libredb/libredb-studio/issues/1723). Type-id `modbus`, the third
member of the `industrial/` family after OPC UA and MTConnect.

This document describes what the provider does TODAY. Where a part is built and not yet reached
from the product, the section says so in those words rather than describing the intention as if it
were behaviour.

## 1. Overview

Modbus is a register protocol, not a database protocol. A device holds four tables of 65,536 items
each - coils and discrete inputs hold single bits, input registers and holding registers hold
16-bit words - and that is the whole of its data model (MB 4.3).

### Concept mapping

| Modbus | Studio |
| :--- | :--- |
| Unit id | Container ("Unit") |
| Coil, discrete input, input register, holding register | Object kinds |
| A named point of the register map | Object |
| A 16-bit word or a single bit | Value |
| Device identification objects (43/14) | Connection details |

### What a reader sees

A tree of units, each holding the four kinds, each kind listing the points the register map names.
With no map the kinds exist and list nothing, and the panel says why: Modbus has no discovery. No
request lists what a device holds, and no register carries a name, a type or a unit.

## 2. Architecture

### 2.1 Where it sits

`src/lib/db/providers/industrial/modbus/`, reached through `createDatabaseProvider` in
`src/lib/db/factory.ts`. No library: the client is this repository's own over the shared egress
rule, as RabbitMQ's AMQP read client is.

### 2.2 Modules

| Module | What it owns |
| :--- | :--- |
| `constants.ts` | Ports, the MBAP bounds, the read limits, the timers |
| `pdu.ts` | The five requests MB-S1 allows: four reads and 43/14. Builds and bounds them |
| `valve.ts` | Re-checks every outbound ADU before it reaches a socket |
| `framing.ts` | Reads frames off a stream; decides what one frame is against the outstanding request |
| `client.ts` | Dials (plain or TLS) and runs one exchange |
| `session.ts` | Serialises exchanges, hands out transaction ids, times each one |
| `register-map.ts` | Parses the user's map and refuses a malformed one |
| `values.ts` | Decodes words into values, with word and byte order per point |
| `plan.ts` | Groups points into as few block reads as the limits allow |
| `objects.ts` | The tree, built from the map |
| `identification.ts` | Reads one 43/14 answer |
| `request.ts` | Parses one JSON read request, before any socket exists |
| `index.ts` | The provider class and its boundaries |

### 2.3 Why the provider carries its own client

`modbus-serial` 8.0.25 and `jsmodbus` 5.0.0 both encode writes. A client that can encode a write is
a client whose read-only posture is a promise rather than a property, and the measurement in #1723
section 4.9 is why that matters: three fixture servers took FC 06 from a client that presented
nothing, and over `mbaps` a certificate labelled "ReadOnly" wrote too. The device enforces nothing.
So the encoder here names four read function codes and 43/14 with MEI type 14, and there is no
function anywhere in the provider that builds a write.

### 2.4 The valve

The encoder cannot build a write, and the valve re-checks the bytes anyway, at the one place every
ADU passes through on its way out (`client.ts`, immediately before `socket.write`). It refuses a
function code outside the five, a 43 that carries any MEI type but 14, a protocol id other than 0,
and an MBAP length that disagrees with the frame it is on.

A refusal there is OUR defect and not the user's: it fires on bytes this code built. It is raised
before a byte is written, which is the only ordering under which the check means anything.

## 3. Design decisions

### 3.1 The register map is the data model

A point names a unit, a table, a zero-based PDU address, a type, and the orders a value wider than
one register needs. Orders have no default: common stacks disagree, and a wrong order reads as a
plausible number with no error at all (#1723 section 4.2), so the map states them or the point is
refused.

The address is the PDU address, counted from zero, exactly what goes on the wire. Vendor
documentation often numbers from one, and the two are not the same number.

### 3.2 No discovery, and an absent map is not an empty device

With no map, `countObjects` answers `{ unavailable }` with the no-discovery sentence rather than
`{ count: 0 }`. A zero would be a claim about the device, and Modbus has no request that supports
it. A map that is PRESENT and malformed is a different case and is reported as a configuration
fault, because the user wrote that document and can fix it.

### 3.3 Blocks, and why a block stops at a hole

Point reads are planned into as few block reads as the limits allow: 125 registers or 2000 bits per
request, one unit and one table per block. A block is cut wherever the map has no point, because
one undefined register inside a block fails the WHOLE block with exception 02 (MEASURED).

### 3.4 Nothing is held open between reads

A libmodbus server serving one client at a time left a second client's read unanswered for 3003 ms
while the first stayed open (#1723 section 4.7). A connection held between reads would lock out the
plant's own HMI. So `connect()` holds nothing. It parses the map AND dials once, closing the socket at once.

The dial is there because the map alone made `connect()` answer for a device that is not there:
MEASURED at 0 ms against a closed port. `src/app/api/db/test-connection/route.ts` then reports a
health failure after a successful connect as a degraded success, so an address with no device
answered `success: true` and the dialog saved the connection - which sends a reader to fix their
map when the fault is the address. With the dial, a closed port is refused and the refusal names
the address.

It is a dial and not a read, for the reason given in section 4.4: 43/14 is not mandatory, so a
device that refuses it is one that does not know the function rather than one that is not there.
And it is closed at once: what section 4.7 measured as dangerous is HOLDING a connection, not
opening one twice.

### 3.5 A late answer is not this answer's

Transaction ids are handed out once and never reused on a connection (TCP 4.4.1.3). A frame whose
id is not the outstanding one is discarded and the wait goes on; a frame that claims to answer this
request and cannot - wrong unit, wrong function code, a byte count that disagrees with what was
asked - ends the request. An unreadable frame ends the connection with it (MB-S4): after one there
is no state in which continuing on that socket is safe.

### 3.6 Bounds are ours, not the device's word

The frame reader takes only the bytes a frame still needs and holds at most one complete ADU, 260
bytes. The identification walk starts at object 0 and follows Next Object Id while More Follows is
0xFF, for a bounded number of rounds and only while the next object id increases; a walk cut short
returns what it has, with a warning.

### 3.7 A value is data

Strings decoded from registers, identification objects (the private objects 0x80 to 0xFF included)
and raw words are shown as text or hex, never rendered as markup. An object's bytes are read as
text only when re-encoding them gives the same bytes back: Buffer's UTF-8 decoder substitutes
U+FFFD rather than failing, so bytes that are not UTF-8 come back as a string either way and the
only reliable question is the round trip.

## 4. Connection

### 4.1 Configuration fields

Host, Port and the register map ([section 3.1](#31-the-register-map-is-the-data-model)), and nothing else. The default port is 502 (IANA `mbap`).

### 4.2 There is no credential field

Modbus TCP defines no authentication: no user, no password, no token. The form offers none because
there is none to offer. What protects a device is MODBUS/TCP Security or a network path you
control, and the read-only hint in the connection dialog says exactly that rather than implying
Studio's posture protects the device.

### 4.3 Unit ids

1 to 255. Unit 0 is a broadcast, which carries writes only and is never answered (SL 2.2), so it is
refused. 248 to 255 are reserved on a serial line; a point naming one is accepted with a warning,
because a gateway may still refuse it.

### 4.4 TLS

MODBUS/TCP Security listens on port 802. The dial path exists (`client.ts` uses `node:tls`) and the
chain and host name are checked; revocation is NOT checked, and the connection details say so in
those words. MEASURED on 13 October 2026: a stapled OCSP response saying revoked still completes
the connection under Node, and under Bun it never reaches the application.

### Connection string

`modbus` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/industrial/modbus/connection-string.ts)).
Its one seed-only field is `registerMap` (`SEED_ONLY_FIELDS.modbus` in [`connection-fields.ts`](../../src/lib/db/connection-fields.ts)): a seed carries the map to the connection, and since only the Modbus provider reads it, a seed of any other type that carries it is refused at load, naming the field.

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `modbus` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/industrial/modbus/execution-ui.ts).
What a tree click and Generate Query write is `MODBUS_GENERATORS`, the `modbus` row of `DIALECT_GENERATORS`, declared in [`generators.ts`](../../src/lib/db/providers/industrial/modbus/generators.ts) and read by the engine-agnostic dispatcher in `src/lib/query-generators.ts`.

## 5. Query interface

One JSON read request, in the Kafka style, in three shapes. Every shape is settled before any
socket exists.

```json
{ "read": ["voltage_l1", "frequency"] }
{ "unit": 1, "table": "holding_register", "address": 100, "count": 10 }
{ "identify": "regular" }
```

The schema is strict: a key the parser does not know is refused rather than ignored, because
ignoring it runs a different read from the one that was written. A name is checked against the map,
since a name means only what the map says it means. The protocol's bounds are not repeated in the
parser - it calls `checkRead`, so a limit cannot pass in one file while it fails in another.

### 5.1 The socket, and what this section used to say

This section used to say that `query()` refused and `getHealth()` read only the map. Both now reach
the device: the request is parsed, a socket is dialled for that read, the session serialises the
exchanges, and the socket is destroyed in `finally`. Nothing is held between reads.

The order matters and is measured: a request the parser refuses costs NO connection, so a mistake
in the console text never opens a socket. `tests/unit/db/modbus/wired.test.ts` runs the whole path
against a TCP server written by hand - the frame reader, the valve, the transaction ids and the
decoder all run for real - and asserts both ends: the bytes the device received are a read for the
address the map names, and the rows carry the value those bytes answered with.

`getHealth()` dials and reads ONE point at quantity 1. A connect alone is not health (§4.10
measured a TCP connect succeeding against an absent unit behind a gateway) and neither is the
socket's state (§5.1 of the issue measured ESTABLISHED for 144 seconds while no answer came).
With no map there is no point to read, so health makes a PLAIN DIAL instead: a TCP connection that
is opened and closed, and nothing is sent. It is deliberately not an identification read. 43/14 is
not mandatory in Modbus, so a device that refuses it is a device that does not know the function
rather than a device that is not there, and reporting that as a health failure would blame the
wrong side.

What the dial measures is exactly this much: THE ADDRESS ANSWERED A TCP CONNECTION. Nothing was
read, because no register map names a point to read, and nothing about the device's health follows
from it. The sentence is written here rather than returned, because `HealthInfo` has no field for
it: its one free-text field is `databaseSize`, and a sentence in a size field would be a worse
answer than the `unknown` that is there now.

What is still absent is MODBUS/TCP Security on a real device: the TLS dial exists and has never
been run against one (§12a item 3 of the specification).

### 5.2 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/industrial/modbus/sql-grammar.ts`](../../src/lib/db/providers/industrial/modbus/sql-grammar.ts), the `modbus` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one JSON read request against a register map, so no span of it is SQL (#1723).
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/industrial/modbus/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

### 5.3 SQL writing

[`modbus/sql-writing.ts`](../../src/lib/db/providers/industrial/modbus/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
No generator calls `quoteLiteral` for Modbus: a read request is JSON and names points.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).

## 6. Object edit (#789)

No kind accepts a write of any sort, and the absence is structural rather than this version's
scope. The encoder names four read function codes and device identification; there is no code in
the provider that can build a write, and the valve refuses one in case there ever is.

There is also nothing a write would mean here. A point is not a row: it is a line in a document the
user wrote, naming an address on a device. Editing the definition is editing the register map, which
is a connection field, not an object. Editing the VALUE would be writing to a plant.

## 7. Security

The requirements are in `docs/SECURITY.md` under MB-S1 to MB-S13. The short form:

- Read-only by construction, re-checked at the socket (MB-S1).
- The shared egress rule applies, and a link-local address is refused by default (MB-S10).
- The identification walk is bounded (MB-S6).
- A value is data, never markup (MB-S13).
- `mbaps` checks the chain and the host name, and not revocation, and says so.

## 8. Agent mode

Agent mode reads a Modbus device through `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/industrial/modbus/index.ts).
The request reader is [`agent-statement.ts`](../../src/lib/db/providers/industrial/modbus/agent-statement.ts), the reads, their bounds and their answers are [`agent-read.ts`](../../src/lib/db/providers/industrial/modbus/agent-read.ts), the per-device pacing is [`agent-pacing.ts`](../../src/lib/db/providers/industrial/modbus/agent-pacing.ts), and every other surface of an agent-mode handle is [`agent-surface.ts`](../../src/lib/db/providers/industrial/modbus/agent-surface.ts).
Every claim below about a device cites the capture [`tests/fixtures/modbus/2.3.0/agent-boundary/boundary.json`](../../tests/fixtures/modbus/2.3.0/agent-boundary/boundary.json), recorded by its `run.sh` against a fresh container of the pinned `docker/modbus` fixture (pymodbus 3.12.x) and of a single-client libmodbus device built from `single-client/` beside it, and written by [`tests/live/modbus-agent-boundary.ts`](../../tests/live/modbus-agent-boundary.ts).
Modbus has no credential, so the capture holds none; the script refuses to write one with a credential-shaped key.

### 8.1 The boundary

The boundary is a structural closed table: an agent read reaches the device only through the console's reader ([`read.ts`](../../src/lib/db/providers/industrial/modbus/read.ts)), whose two builders are `buildRead`, which sends Read Coils (01), Read Discrete Inputs (02), Read Holding Registers (03) or Read Input Registers (04), chosen by the table and never by the request, and `buildIdentification`, which sends Read Device Identification (43/14), over a socket whose one `socket.write` runs after the valve ([section 2.4](#24-the-valve)) re-reads the frame and refuses every other function code.
So no write, diagnostic, file record or FIFO request can be sent on the agent path.
[`agent-boundary.test.ts`](../../tests/unit/db/modbus/agent-boundary.test.ts) holds the agent's modules to naming no function code and building no frame, records every frame the agent path writes for every admitted shape (only 01, 02, 03, 04 and 43/14), and replays the capture; [`agent-provider.test.ts`](../../tests/unit/db/modbus/agent-provider.test.ts) pins each read's full request frame (function code, unit, address and quantity) on a real socket.

Modbus TCP has no credential to prove read-only: the pinned fixture takes a raw write from any client.
Measured raw (`rawWrites`, sent by the capture script on its own socket and never by Studio), function codes 5, 6, 15, 16, 22 and 23 were each answered and each changed the value it targeted, so the table is the boundary.
Every request the reader refuses reached the device not at all: the capture counts the connections made through a proxy in front of the fixture, and each refusal made none (`refusedBeforeSend`).

### 8.2 What an agent request may be

One JSON object in one of the console's three shapes ([section 5](#5-query-interface)), read by the console's own parser and written as the console writes it:

| Request | Sends |
| --- | --- |
| `{"read": ["name", ...]}` | the points the connection's register map names, planned into blocks as the console plans them, one read per block |
| `{"unit": U, "table": T, "address": A, "count": N}` | one read of one table, optionally decoded with `type`, `wordOrder` and `byteOrder` |
| `{"identify": "basic" \| "regular" \| "extended"}` | Read Device Identification from object 0, at the map's first unit as the console reads it, for at most 8 rounds |

Every other request is refused before anything is sent, with the parser's sentence followed by agent mode's list of reads: text that is not JSON, any key a shape does not name (`function`, `value`, `objectId`), a table that is not one of the four, unit 0 (the broadcast, which carries writes only) and anything above 255, an address past 65535, a block past the end of the table, more than 125 registers or 2000 bits, a count below one, an identification level other than the three, two shapes in one object, and a point name the connection's map does not declare.
A points read on a connection with no map is refused as having no map, never answered as an empty device ([section 3.2](#32-no-discovery-and-an-absent-map-is-not-an-empty-device)).
The admission, which has no connection in hand, reads a point name's shape alone; the provider reads the names against the map again before anything is sent.
The admission also refuses a request longer than 4,096 characters.

A points or block read answers a number of rows its request decides, so one past the row budget is refused before anything is sent, never cut (`Read-only execution exceeded the row budget: 5 rows > 4 allowed`); an identification answer's rows are the device's, so they are held to the row budget once read; every result is held to the byte budget.
An identification walk the device was still continuing after 8 rounds is refused rather than answered in part, where the console answers what it has with a warning ([section 3.6](#36-bounds-are-ours-not-the-devices-word)).
A failure is worded by its category and quotes nothing the device sent: the device's silence for one request's 3,000 ms, its exception by code with this provider's sentence for that code, an answer that cannot be read as an answer to this read, a value the map's declaration cannot decode, an address nothing answers, and settings the egress rule refuses.

### 8.3 Pacing

A device that serves one client at a time answers nobody else while a client holds its connection.
Measured on the single-client device (`lockout.singleClient`): a second client that sent a read while a first held its connection for 2000 ms was answered 2000 ms later, 0 ms after the first closed, and a client that dialled after a read closed was answered in 0 to 1 ms; one agent read held its connection for 1 ms (`agentReadHoldMs`).
So the lockout is the hold and nothing after it.
The pinned fixture cannot show it: it answered a second client in 0 ms while the first held its connection (`lockout.pymodbus`), as [`docker/modbus/README.md`](../../docker/modbus/README.md) records.

So, on the agent path:

- nothing is held open between reads: each read opens its own socket and destroys it before it settles, as the console does ([section 3.4](#34-nothing-is-held-open-between-reads));
- agent reads of one device never overlap, across every run and every connection of the server process, because the lanes are kept once per process, in a global every copy of the provider's module shares (Next.js loads the module once for the route handlers and again for instrumentation, which resumes agent runs), rather than on the cached provider; a lane is the device's host and port, never the unit, since a gateway serves every unit behind it over one connection, and a host written as a name and as an address is two lanes;
- a fixed gap of 1,000 ms (`MODBUS_AGENT_DEVICE_GAP_MS`), a chosen value rather than a measured one since the measured lockout is the hold itself, follows each agent read, measured from the moment its socket was destroyed, so the next one cannot queue straight behind it and leave the plant's own client no turn: at the measured hold that leaves the device free for all but about a thousandth of the time an agent spends on it; the capture's two agent reads sent at once through the server's pacer never overlapped (`maxOpen` 1) and the second dialled 999 ms after the first closed, as the proxy in front of the device heard it (`pacing`);
- one run sends at most 64 device requests (`MODBUS_AGENT_RUN_REQUESTS`), each read charged before it dials with the most it may send, one per planned block, one for a block, and 8 for identification, to the run's own ledger (`ReadOnlyStatementBudget.readAllowance`, one unit per device request), which a resumed run carries; a read that would pass the bound is refused before anything is sent, and a budget that carries no run is refused.

A read's time budget starts when it is asked for and covers its wait for its turn, the gap and the read itself.
Its execution time, the figure the agent rail and the run's database time show, is its own time on the device, from its turn to its socket's close: the wait and the gap are Studio's, and a read of a device that answers in a millisecond is never shown as taking the gap.
A read whose turn would come after its budget is refused at once in Studio's words, `Read-only execution exceeded the time budget: the read waited ...`, and keeps its place in the order until the read ahead of it ends, so the read behind it still never overlaps the one in front; a read still running at its deadline is refused in Studio's words and its socket destroyed.
Neither is ever worded as the device's failure, and the device's silence is never worded as Studio's budget.
A read that fails or is abandoned frees its lane when its own deadline passes at the latest, since its socket is destroyed by then; a dial still in flight at the deadline is awaited, for at most its own 3,000 ms bound, and destroyed once it opens before the lane is freed.

### 8.4 Values, and what each path reads

Values are the device's own readings, and Modbus has no credential to withhold, so agent mode answers them exactly as the console renders them ([section 3.7](#37-a-value-is-data)): coils and inputs as booleans, registers as words and as values decoded under the register map's declaration, and identification objects, the private objects 0x80 to 0xFF included, as text only when their bytes round-trip as text with no control byte and as hex otherwise.
Every result reaches the model inside the untrusted-content fence, whose closing marker a device's text cannot spell.
The register map is the connection's own configuration, and its point names reach the model as object names.

| Path | Handle | What it reads |
| --- | --- | --- |
| Investigation reads | agent read-only profile | one request of [section 8.2](#82-what-an-agent-request-may-be), paced as [section 8.3](#83-pacing) says |
| Investigation grounding, plan-mode grounding and the operations workflow's inventory | either agent profile | the register map's units and points by name, which sends nothing to the device; with no map it lists no unit and no point, and the grounding then says the device reported none rather than that the map is absent ([U189](../BACKLOG.md#u189-a-modbus-connection-with-no-register-map-is-grounded-as-a-device-that-reported-nothing)) |
| Connect and health | either agent profile | the console's own dial, and health's one-point read (a dial alone with no map), each taking its turn on the device's lane and waiting at most 9,000 ms for it |
| Console, overview, performance, storage, session, slow-query, table and index readings | either agent profile | nothing: each is refused with its reason, never answered with Studio's own figures or an empty reading |

### 8.5 Agent language pack

Statement-language family: `modbusread`.
Overlay: [`src/lib/agent/languages/modbusread/engines/modbus.ts`](../../src/lib/agent/languages/modbusread/engines/modbus.ts), with its client row in [`src/lib/agent/languages/modbusread/engines/client.ts`](../../src/lib/agent/languages/modbusread/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`.
Both overlays are empty, so the engine resolves to the `modbusread` family pack itself.
The `modbusread` statement-language family has no dialect-bound member.
This overlay overrides no Shared member, so every Shared member is the `modbusread` statement-language family's own.
The family offers the investigation workflow, through `run_read_query` with one request, and the operations workflow; it offers no query optimization or database assessment, since a device has no plan and no profile, and no data analysis, whose tools assume a store of records, and no workflow hands an answer to the editor.
The workflow classifier offers the model only these two.
The editor language id stays `modbus`, and the fence alias `modbusread` names this engine.
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.
No MCP tool runs a Modbus request: the family declares no MCP facet, `MCP_EXPOSABLE.modbus` and `MCP_STATEMENT_READ.modbus` are false ([B160](../BACKLOG.md#b160-modbuss-agent-reads-are-paced-per-device-and-it-has-no-mcp-surface)), and `READ_ONLY_ENFORCED.modbus` is unchanged.

## Migration DDL

[`MODBUS_MIGRATION_DDL`](../../src/lib/db/providers/industrial/modbus/migration-ddl.ts) is what the schema-diff migration generator writes for `modbus`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
What a register means is the device vendor's, written down in the user's register map, so there is no table DDL to wrap either (#1723).

The refusal reason it prints, verbatim:

- "A Modbus register has no column definition anywhere: the device holds 16-bit words and single bits with no name, no type and no unit, and what gives them meaning is the register map the user wrote, so there is nothing a client could change here."
