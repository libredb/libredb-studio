# MTConnect Provider

Issue #1722. One MTConnect agent, read only, over HTTP.

Every number in this file was measured against a running agent or read out of this repository's
own source. Where a fact could not be measured, the sentence says so rather than rounding it off.

The pinned agent for every measurement below is `mtconnect/agent:2.8.0.3`, and the captured
answers are in `tests/fixtures/mtconnect/2.8.0.3/`, taken from `https://demo.mtconnect.org` with
the date, the URL and the agent version recorded beside them.

## 1. Overview

An MTConnect agent stands in front of machine tools. It publishes a device model and a stream of
observations, and it answers five kinds of request: the device model (`probe`), the current value
of every data item (`current`), a page of the buffer (`sample`), the asset documents it holds
(`assets`) and one asset by id (`asset`).

The provider reads those five and nothing else. There is no write path, and that is structural
rather than a setting: the request table holds nine routes and every one of them is a GET.

### Concept mapping

| MTConnect | Studio |
|---|---|
| Device | container, one level, labelled Device |
| Data item | object of kind `dataitem`, a relation with three columns |
| Condition | object of kind `condition`, a relation with three columns |
| Asset | object of kind `asset`, configuration with a document |
| Observation | one row |
| Sequence number | the row's primary column |

### What a reader sees

A device is a container. Under it, data items and conditions are relations whose rows are
observations: value, timestamp and sequence. An asset is a document, and the Source tab shows the
XML the agent answered.

## 2. Architecture

### 2.1 Where it sits

`src/lib/db/providers/industrial/mtconnect/`, the second member of the `industrial/` family after
OPC UA (#1677). It rides the shared HTTP transport (`src/lib/db/http/`) and the shared console
grammar (`src/lib/db/console/`).

### 2.2 Modules

| File | What it is |
|---|---|
| `xml.ts` | The reader: attributes and namespace prefixes preserved, CDATA and an optional prolog accepted, DOCTYPE and ENTITY refused before parsing, plus a streaming walker over observations that reports the root it opened |
| `xml-bounds.ts` | The reader's bounds, each beside the measurement it was sized from |
| `model.ts` | The `probe` answer indexed by `dataItemId`, with the freshness test on `instanceId` |
| `rows.ts` | One observation to one row, joined with the model for category, type and units |
| `routes.ts` | The closed route table, the six published routes left out with reasons, the refused parameters, the console dialect and the console's derived view of the table |
| `guard.ts` | Phase 0: everything refused before a socket opens, including the `path` subset |
| `client.ts` | One operation, a GET of a route from the table, with the byte caps and the request ceiling |
| `connection-options.ts` | The address as dialled: the scheme and TLS material from the SSL / TLS panel, and the Path prefix |
| `capabilities.ts` | What the provider declares about itself |
| `index.ts` | The provider class and the refusal boundary |
| `agent-statement.ts` | Agent mode's reader of one request line, the console's guard with the list of routes in its refusals |
| `agent-read.ts` | One agent read: the device model read fresh, the request, the budgets and the failure categories |
| `agent-withheld.ts` | The agent's adapter connections, withheld on every agent-mode handle, and why |
| `agent-surface.ts` | What an agent-mode handle answers outside `queryReadOnly` |

### 2.3 Why the provider carries its own XML reader

The two readers already in the tree drop the attributes and namespace prefixes an MTConnect
document keeps its data in. MEASURED: neither could read one of the thirteen captured documents;
this one reads all thirteen.

Two dependency candidates were measured as well, and each failed a requirement this provider has,
so neither was taken.

### 2.4 Registration and lifecycle

The type id is `mtconnect`. `connect()` proves an agent is answering and reads the buffer window
with the one read every schema version from 1.3 to 2.8 answers, `sample?count=1`. MEASURED: 908 to
960 bytes for that read across three models.

The device model is read once and held. MEASURED: re-reading `probe` costs 2,918,819 bytes and a
70 ms median on a 500 device model, so holding it is a requirement rather than an optimisation. It
is read again only when the Header's `instanceId` changes.

## 3. Design decisions

### 3.1 A request line, not a query language

The editor text is one request line in the agent's own URL grammar with GET implied. It is not a
query language, so the provider declares `queryDialect: "mtconnect"`.

Issue #424 gave a provider whose text is not a query language no read-only statement path.
That rule is lifted for MTConnect's agent mode, on the precedent of kubectl and S3, whose command lines are their statements: the request line is the statement.
`queryReadOnly` reads one request line with the console's own guard and route table and sends it on an agent-mode handle only, so the editor's text and the agent's statement are one grammar, and the boundary is the closed route table of section 3.2 ([section 14](#14-agent-mode)).

`queryLanguage` reads `"json"` beside it. That field is a closed union of five languages and a
request line is none of them; the type says a dialect is declared "only beside
`queryLanguage: json`". kubectl and S3 declare the same pair for a command line.

### 3.2 Nine routes, read rather than completed

MEASURED on the pinned agent with `AllowPut` unset: `GET /swagger` answered 200 with 15 routes and
15 operations, every one a GET. The table is nine of those fifteen.

An earlier draft had ten, and the tenth, `/{device}/asset/{assetIds}`, DOES NOT EXIST: it was
completed by symmetry rather than read. A test that pinned the count is what sent that draft back
to the document.

The six left out, and why, are in `MTC_ROUTES_LEFT_OUT` with their measurements: four are aliases
of routes already in the table, one is `/cancel/id={string}`, the one published GET that acts
rather than reads, and one is a second spelling of the asset route. `/swagger` is a seventh entry
there and is not one of the fifteen.

### 3.3 One request at a time per agent

MEASURED on the pinned agent: while a 300 alternative `path` ran in a loop, the median of
`sample?count=1` on the same agent rose from 1.4 ms to 74.1 ms, a factor of 51, with a worst case
of 169.9 ms. The agent serves the shop floor's own clients, so a careless read from Studio degrades
the plant's monitoring. The limiter holds one permit per agent.

### 3.4 Caps are in bytes, not in rows

MEASURED across four models: `current` is about 164 bytes an observation, and `probe` about 110
bytes a data item on a generated model and 190 on the richer demo one. Bytes per observation hold
steady across a factor of a hundred in model size, while bytes per data item move with how rich the
model is, so a cap counted in rows is quietly wrong on a rich model. There IS a row cap as well,
and it is a different thing: the byte caps bound what the transport will READ, and the row cap
bounds what a walk will KEEP. The next section is about what the result says when it meets one.

### 3.5 A read that the row cap cut says so

There is a row cap as well as the byte caps, and `sample` is the read that meets it: `ROW_CAP` is
10,000 observations, and a walk that reaches it stops there. What matters is what the result then
says about itself. The cap is reported on `QueryResult.pagination.wasLimited`, which is the field
the house keeps for a bound a PROVIDER applied - the InfluxDB row cut uses the same one - and the
results strip renders it as *"Studio bounded this result. Anything beyond the bound is not in it."*

It is not a warning, because the warning channel carries notices the ENGINE attached and this bound
is ours; and it is not a refusal, because the observations that did arrive are good. It was
measured as a defect first: `readObservations` had reported the cap since it was written, and the
provider dropped the return value, so a cut read looked whole.

### 3.6 The request has an 8 KiB ceiling, and crossing it is silent

MEASURED with a raw socket: a request whose whole header block was 8,153 bytes was answered, and
one of 8,216 bytes got no answer at all, the agent writing zero bytes and closing the connection.
The limit is on the header block rather than on the path, so the provider budgets the whole request
target and leaves room for the headers. There is no error document in that case, so the sentence
the reader gets is the provider's own.

### 3.7 A non-MTConnect answer gets our own sentence

MEASURED through a reverse proxy: a 401 came back as `text/html`, nginx's own page, not as an
`MTConnectError`. The root element is checked, and anything else is named as what it is. This holds
whether or not authentication is ever offered, because a proxy can answer with HTML for a 401, a
403, a 502 or a maintenance page.

An `MTConnectError` answer is the agent's own refusal, and it reaches the reader as the agent's sentence and code on every route, `current` and `sample` included.
A `path` that matches nothing (`INVALID_XPATH`) or a `from` that has left the buffer (`OUT_OF_RANGE`) is an error the reader sees, never an empty grid.

On `current` and `sample` the root is learned in the same pass that reads the observations: the walker reports the root element it opened and walks only an `MTConnectStreams` document, so an answer is parsed once and never also held as a whole tree (#1787). An `MTConnectError` answer is small and is then read as a tree for the agent's sentence, and any other root gets the sentence above.

A refusal from the reader says WHO refused, and that was a defect first. Eleven of the reader's
sixteen refusals are Studio's own rule applied to a document that is well-formed XML and often
perfectly good MTConnect: a DOCTYPE or an entity declaration, refused before parsing so no DTD is
expanded; an XML comment, refused because no agent measured so far sends one; a processing
instruction after the root opened; and each of the six bounds in `xml-bounds.ts`, every one of them
a number this repository chose. The remaining five - malformed input, two roots, text after the
root, stray markup, a character XML 1.0 does not allow - are the document's own defect.

All sixteen used to arrive as one sentence, *"The answer could not be read as an MTConnect document
(doctype)"*, which tells a plant operator their agent sent something broken. It did not, and an
operator reading that takes our rule to their vendor, who finds nothing wrong because there is
nothing wrong. `MTC_XML_REFUSAL_OWNER` now marks each reason, a Studio rule leaves as
`refused-by-rule` saying *"Studio refused this answer: ... this is Studio's rule, not a fault in the
agent"* with the rule's own reason and, for a bound, its figure; a document defect leaves as
`unreadable` saying the answer is not readable XML.

### 3.8 The read-only mode

There is nothing to enforce. MEASURED: with `AllowPut = true` the agent's own Swagger grows from 15
operations to 39, among them a PUT that sets an observation and a POST that injected a Fault which
`/current` then served like any other observation. The guarantee cannot rest on an agent setting,
so it rests on the client's shape: the client seam takes no method argument and no body parameter.

## 4. Connection

### 4.1 Configuration fields

| Field | What it is |
|---|---|
| Host | The agent's host. A pasted `http(s)://` address is split into Host and Port by the Host box |
| Port | The agent's port. Default 5000, the port the reference agent listens on out of the box and the one the pinned image exposes |
| Path prefix | The path a reverse proxy puts in front of the agent, the field RabbitMQ already carries as `apiPath` |

### 4.2 There is no credential field

The standard defines no authentication, and the agent's own interface takes none.

MEASURED behind an nginx proxy asking for Basic: `/mtc/probe` without credentials answered HTTP 401
with `WWW-Authenticate: Basic realm="MTConnect"` and a 179 byte `text/html` body; with the correct
credentials it answered 200 and 244,195 bytes of `MTConnectDevices`; with a wrong password the
password appeared neither in the body nor in the headers.

So the mechanism works, and a Basic field was still left out of this version: this product refuses
to send a password without TLS to a host that is not this machine, which rules out the most common
shop floor case, an http agent behind a proxy asking for Basic. What a reader gets instead is the
proxy's own answer, named as not being an MTConnect document.

### 4.3 TLS

The scheme follows the SSL / TLS panel: with no panel, or the `disable` mode, the provider dials `http`, otherwise `https`.
The panel's mode, CA and client certificate are what the handshake uses, so an agent with a private CA or one that asks for a client certificate is read the same way as any other HTTPS engine.
A TLS failure is reported as one, and the provider never retries over `http`.
Through an SSH tunnel the certificate is checked against the agent the user named, not the local forward.

The Path prefix is put in front of every route, so `/mtc` reads `/mtc/probe`, `/mtc/current` and so on.
It is a path only: a query, a fragment, percent-encoding, a space or an empty, `.` or `..` segment is refused before any request.

### Connection string

`mtconnect` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/industrial/mtconnect/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `mtconnect` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/industrial/mtconnect/execution-ui.ts).
What a tree click and Generate Query write is `MTCONNECT_GENERATORS`, the `mtconnect` row of `DIALECT_GENERATORS`, declared in [`generators.ts`](../../src/lib/db/providers/industrial/mtconnect/generators.ts) and read by the engine-agnostic dispatcher in `src/lib/query-generators.ts`.
Its editor language, `mtconnect`, is the row in `EDITOR_LANGUAGES` declared in [`editor-language.ts`](../../src/lib/db/providers/industrial/mtconnect/editor-language.ts): how the editor registers and tints it, and its completion source and formatter where it has one.

## 5. Query interface

### 5.1 The request line

```
GET /current?path=//DataItem[@category="CONDITION"]
```

The method is optional and only GET is accepted. A `#` line above the request is a comment, which
the guard drops. Two request lines in one text are refused as two rather than run as the first.

### 5.2 What phase 0 refuses before a socket opens

| Rule | Measurement behind it |
|---|---|
| Path at most 4,096 bytes ONCE ENCODED | `URLSearchParams` writes a space as `+`, one byte, and a quote as `%22`, three; a path of 3,000 quotes becomes 9,000 bytes |
| Every path parameter at most 256 bytes encoded | An asset id of 5,000 characters passed before this bound existed |
| At most 32 alternatives in a path | The agent's cost above that was never measured |
| No path inside a predicate | Same reason: never measured |
| `starts-with` and `contains` only | The two functions measured to work |
| No `/` or `|` inside a quoted value | MEASURED: the agent rewrites the inside of the quotes, so what runs is not what was written |
| Six parameters refused by name | `interval`, `heartbeat` and `frequency` are streaming; `format` and `pretty` are not in the standard; `device` belongs in the path, and MEASURED `/assets?device=<unknown>` answered 200 with every asset in the buffer |
| A `%` that starts no valid escape | Refused by name with the pair it sits in; before this rule it left as a bare `URIError` with no sentence |

### 5.3 The path subset, measured against the live agent

| Path | Answer |
|---|---|
| `//DataItem[@type="POSITION"]` | 200, matched |
| `//m:DataItem[@category="CONDITION"]` | 200, matched |
| `//Axes`, `//*`, `//Linear|//Rotary` | 200, matched |
| `//DataItem/@id` | 400 InvalidXPath, and the cause is certain: the agent's own prefixing produces `m:@id` |
| `//DataItem[@name="a/b"]` | 400 InvalidXPath, and the cause could NOT be separated from "no match" |

### 5.4 Values the older console kinds could not carry

`path` is an XPath; `count` may be negative, and MEASURED `count=-3` answered 200 with the newest
three rows; a sequence number runs to 2^64-1, past the safe integer. The shared console took one
change for this provider, a `"text"` query value kind, and the numeric rules stay in phase 0 where
the Header's window and the buffer size can be read.

### 5.5 Result shape

One row per observation: device, component, data item id, name, category, type, value, units,
timestamp and sequence, with a condition's `nativeCode`, `nativeSeverity`, `qualifier` and
`conditionId` where it carries them. Rows are sorted by timestamp and then by sequence, because the
agent does not answer in order; the sequence comparison is by length first, since a sequence is an
unsigned decimal and text order puts `100000000` before `99999999`.

MEASURED on the demo: 38 observations carry an empty value, and only 31 of them are conditions. The
other 7 are EVENT items, so an empty value is a third state, distinct from `UNAVAILABLE`, which is
shown as the word the agent printed rather than as an empty cell.

### 5.6 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/industrial/mtconnect/sql-grammar.ts`](../../src/lib/db/providers/industrial/mtconnect/sql-grammar.ts), the `mtconnect` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one request line in the agent's own URL grammar, so no span of it is SQL (#1722).
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/industrial/mtconnect/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

## 6. Schema introspection

### 6.1 One container level

Devices. A container path is the device name exactly as the probe document spells it, so
`containerPathShapes` is `"exact"`, and the shared check refuses a path of the wrong length by name
rather than letting it reach the model lookup and come back as "no such device".

### 6.2 Three kinds

`dataitem` and `condition` are relations; `asset` is configuration with a document in `xml`.

MEASURED on the demo model: 143 data items carry no `name` at all and 3 more carry a `name` equal
to their `id`, so the tree labels an item by its component path and id where the name adds nothing.

### 6.3 No Keys panel

MEASURED, and it is a mechanical fact rather than a preference: `enumerableKinds` excludes a kind
that declares `enumeratedBy` from the tree, the inventory and the agent's grounding, so one kind
cannot have both the Prometheus pattern and the Keys panel. The panel would also buy nothing here:
a device holds at most about 123 items, against the unbounded key spaces the six `keyScan`
providers browse.

### 6.4 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`, and the absence is structural rather
than this version's scope: every route this provider sends is a GET, and the client seam has no
method argument and no body parameter to carry a write. An asset's Source tab states the same in
its own words, as the part's `edit.reason`.

### 6.5 An asset's document is the agent's own bytes

`readObjectSource` answers the asset read's own text rather than a re-render of the parsed tree, so
its `origin` is `stored`: a re-render would reorder attributes, drop the prolog and re-indent, and
none of that is the asset the plant holds.

## 7. Monitoring and health

The Header of a read without `from` and `to`: `instanceId`, `firstSequence`, `lastSequence`,
`nextSequence` and `bufferSize`. MEASURED: with `to` given, `firstSequence` is the request's own
`from` rather than the buffer's start, so buffer facts come only from a read without either.

## 8. Maintenance

None. A maintenance operation would be a write, and there is no request in this provider that
writes.

## 9. Capabilities and labels

Declared: one container level, `containerPathShapes: "exact"`, the three object kinds, the dialect,
the default port, a schema refresh pattern that matches nothing, and `enforcesReadOnly: true`.

Not declared, each for a measured reason: `keyScan` (6.3), `agentWalkScope` (10.2),
`explainFormat`, `identifierQuoting`, `readsFileAccessPosture`, `rowActions`, `supportsSchemas`,
`machineNames` and `implicitCommitStatements`.

### SQL writing

[`mtconnect/sql-writing.ts`](../../src/lib/db/providers/industrial/mtconnect/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
No generator calls `quoteLiteral` for MTConnect: a request line writes its names into a URL.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).

## 10. Error handling

### 10.1 Every refusal leaves as a `QueryError`

MEASURED on `origin/main`: `providers/platform/kubernetes/objects.ts:348` turns a `QueryError` or a
`TimeoutError` into `{ unavailable: error.message }` and re-throws everything else, and
`src/lib/db/errors.ts` defines `isQueryError` as `instanceof QueryError`. A refusal thrown as a
plain `Error` is therefore handled as an unexpected failure and the sentence it carries never
reaches the reader.

This provider had that defect in its first version. `MtcRefusal` and `MtcClientError` both derive
from `Error`, and only the `query()` path converted one of them, so every byte cap, every request
ceiling and every guard refusal from `connect()`, from the tree's reads and from an asset's Source
tab left as a plain `Error`. The conversion now happens at one boundary in `index.ts`, and the two
classes are left as they are rather than re-parented: the shared base ends its constructor with
`Object.setPrototypeOf`, so a subclass of it answers `false` to `instanceof` its own name unless
every constructor puts the prototype back.

### 10.2 MCP, and the adapter addresses

`MCP_EXPOSABLE` answers true. The Agent device carries the agent's own adapter addresses: MEASURED
on the demo probe, three devices (Agent, OKUMA, Mazak), of which the Agent device holds 20 items,
four of them `ADAPTER_*`, and `current` answered two `ADAPTER_URI` values that are real internal
addresses.

Neither shared declaration withholds them. `machineNames: "withheld"` is refused on a `relation`
kind. `agentWalkScope` is an allow list: it keeps the one container marked `isSessionDefault` plus
the paths `alsoWalk` names, and it cannot say "every device except this one"; its `whenNoDefault`
arm cannot run here at all, because the parent default is only assigned for a level below the
deepest and this provider declares one level.

So the provider withholds them itself, on every handle opened for an agent-mode profile, which is
the handle the MCP metadata tools acquire as well as agent mode's own: every data item inside an
`Adapter` component is left out of the tree, the device model and every observation answer, and
an answer counts what it left out ([section 14.3](#143-what-is-withheld-and-why)). The editor's
handles show them, as they always have. MCP's `run_read_query` does not serve this engine
(`MCP_STATEMENT_READ.mtconnect` is false).

## 11. Testing

The unit files under `tests/unit/db/mtconnect/` read the thirteen captured documents
rather than fixtures written to suit the code. Each file addresses the real module: no
stand-in, and no local copy of a rule the shared modules own.

| File | What it holds |
|---|---|
| `xml.test.ts` | The reader, its bounds and every refusal |
| `rows.test.ts` | Row building, the model's rows, the assets' rows and the sort, including the digit boundary the captured page cannot reach |
| `guard.test.ts` | Phase 0, route by route and rule by rule, including the comment lines the dialect promises |
| `client.test.ts` | The caps, the ceiling and the non-MTConnect answer |
| `console-view.test.ts` | The console's derived view of the route table, and the three values no older kind could carry |
| `capabilities.test.ts` | Every flag by name, the exact key set, and the tab type |
| `kinds.test.ts` | The three kinds against the shared rules |
| `refusal-type.test.ts` | What type a refusal is when it leaves the provider |
| `agent-provider.test.ts` | The agent path over a recording transport: every request pinned whole and held to the nine GET routes, every refusal before the network, the budgets and their edges, the failure categories and the agent-mode handle's other surfaces |
| `agent-withheld.test.ts` | The adapter connections decided from the agent's own model and stream, and an asset document rendered as text |

## 12. Known limitations

- Streaming is out of scope: `interval` and `heartbeat` are refused by name, because an answer that
  never ends cannot be carried by the shared transport.
- No credential field (4.2).
- The `path` subset is narrower than XPath, and each exclusion is a measurement rather than a
  preference (5.2).
- The Agent device's adapter addresses are shown on an editor handle; every agent-mode handle, the
  MCP metadata tools' included, withholds them (10.2).
- A composition's own name is carried where the observation has one; MEASURED on 6 of 478.

## Migration DDL

[`MTCONNECT_MIGRATION_DDL`](../../src/lib/db/providers/industrial/mtconnect/migration-ddl.ts) is what the schema-diff migration generator writes for `mtconnect`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
An agent's device model is the agent's own and every route this provider sends is a GET, so there is no table DDL to wrap either (#1722).

The refusal reason it prints, verbatim:

- "An MTConnect data item's shape is declared in the agent's own device model, not in columns a client can change, and every request this provider sends is a GET, so there is no column definition to change."

## 13. References

- MTConnect Standard Part 1 to Part 5, schema versions 1.3 to 2.8
- The agent's own Swagger document, which is the authoritative route list
- `https://demo.mtconnect.org`, the public demo agent, for every live measurement
- `tests/fixtures/mtconnect/2.8.0.3/README.md`, the provenance of the captured answers

## 14. Agent mode

Agent mode reads an MTConnect agent through `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/industrial/mtconnect/index.ts).
The request reader is [`agent-statement.ts`](../../src/lib/db/providers/industrial/mtconnect/agent-statement.ts), the read, its bounds and its answers are [`agent-read.ts`](../../src/lib/db/providers/industrial/mtconnect/agent-read.ts), the withheld adapter connections are [`agent-withheld.ts`](../../src/lib/db/providers/industrial/mtconnect/agent-withheld.ts), and every other surface of an agent-mode handle is [`agent-surface.ts`](../../src/lib/db/providers/industrial/mtconnect/agent-surface.ts).
Every claim below about an agent cites the capture [`tests/fixtures/mtconnect/2.8.0.4/agent-boundary/boundary.json`](../../tests/fixtures/mtconnect/2.8.0.4/agent-boundary/boundary.json), recorded by its `run.sh` against the compose fixture's adapter and two agents of the pinned image, one with the fixture's own `AllowPut = false` and one with `AllowPut = true`, and written by [`tests/live/mtconnect-agent-boundary.ts`](../../tests/live/mtconnect-agent-boundary.ts).
The fixture has no credential, and the capture holds none and no host name; the script checks both before it writes.

### 14.1 The boundary

The boundary is the structural closed route table of [section 3.2](#32-nine-routes-read-rather-than-completed): the request line is read by the console's own guard against nine routes, every one a GET, and sent by `readOnce` or `readObservations` in `client.ts`, which take no method argument and no body parameter.
So no PUT, POST or DELETE, no `/cancel`, no `/swagger`, no alias of a route and no streaming request can be sent on the agent path.
[`agent-provider.test.ts`](../../tests/unit/db/mtconnect/agent-provider.test.ts) records every request the agent path sends through the provider's transport seam and holds each one, whatever the case, to a GET of a route of the table with no body, no form and the one `accept` header.

No agent setting can be the boundary.
Measured raw (`raw`, sent by the capture script with `fetch` and never by Studio): with `AllowPut = false` the agent's Swagger lists 15 GET operations, and a PUT and a POST of an observation answered 400 with `INTERNAL_ERROR` and changed nothing; with `AllowPut = true` it lists 15 GET, 9 PUT, 9 POST and 6 DELETE operations, and the same PUT and POST answered 200 and changed the observation they named.
A GET of `/cancel/id=1` answered 404 `INVALID_URI` on both.
The agent's buffer did not move across every agent read (`state`: the next sequence read 36 before and after, with no observation in between).

### 14.2 What an agent request may be

One request line, the statement, written as the console writes it with GET implied ([section 5.1](#51-the-request-line)), read by the console's own guard (`guardRequestLine`):

| Route | Answers |
| --- | --- |
| `/probe`, `/{device}/probe` | the device model, one row per data item |
| `/current`, `/{device}/current` | the current observations, one row per observation |
| `/sample`, `/{device}/sample` | a page of the buffer, one row per observation |
| `/assets`, `/{device}/assets` | the assets, one row per asset with its document |
| `/asset/{assetIds}` | assets by id, one row per asset with its document |

Everything [section 5.2](#52-what-phase-0-refuses-before-a-socket-opens) refuses is refused here too, before anything is sent, in agent mode's words: the guard's sentence followed by the list of the nine routes and their keys, and "Nothing was sent." (`refusedBeforeSend`: a PUT, a POST, a DELETE, `/cancel/id=1`, `/assets/{id}`, `/swagger`, `interval`, `heartbeat`, `frequency`, a second request line, a `path` function outside the subset, `//Adapter` and `starts-with()` each sent no request).
Two rules are agent mode's own.
A path parameter written `.` or `..` is refused as a dot segment, since a URL resolves it to another path.
And a `path` is narrower than the console's: one or more `//DataItem` alternatives joined by `|`, each with at most one predicate of equality tests `@attribute="value"` on `@id`, `@name`, `@type`, `@subType` or `@category`, joined by `and` or `or`, and every value one that a data item agent mode reads holds, as `/probe` lists it.
The console's `contains()` and `starts-with()` and a test on any other element are refused before anything is sent, and a value no read data item holds is refused after the model read and before the request, in the same words whether the value is a withheld adapter id or no id at all.
The reason is measured (`pathOracle`): the agent itself answers a path that matches a withheld adapter item with 200 and one that matches nothing with 400 `INVALID_XPATH`, for `contains()`, for `starts-with()` and for an exact `@id`, so a path that could test a withheld id for a text would let a model read the adapter's address back one character at a time; agent mode refuses each hit and its miss alike.
Since every value must be one of an item agent mode answers, whether a path is admitted is decided from what it answers, never from what it withholds, and a path selects a withheld item only by a type, subtype, category or name that an answered item holds too, never by its address.
A `count` past the row budget is refused before anything is sent, and the admission also refuses a request longer than 4,096 characters.

Each read reads the device model first, with `GET /probe` on the handle's one permit (each provider instance holds its own, with four MTConnect requests at once across Studio), and then sends the request (`reads[].sent`), so the device a request names, the rows' join and the withheld items are decided from the model the agent serves at that read, and nothing of one read is kept for the next.
A device the model does not hold is refused after the model read and before the request.

A read is counted one row per observation, data item or asset.
An observation walk stops at the first row past the row budget and the read is refused, never answered in part; a device model or an asset answer past it is refused with its count; a result past the byte budget, an answer past the route's byte cap ([section 3.4](#34-caps-are-in-bytes-not-in-rows)) and a read past its time budget, which covers the model read, the wait for the permit and the request, are refused in Studio's words.
`count`, `from`, `to` and `at` select observations the buffer already serves to any client, and nothing withheld depends on them, so they are no oracle; nor is `path`, under the rule above.
A failure is worded by its category: the agent's own error document by its error code when the code is one the standard names, never by its text; a transport failure by its kind with the time budget; a document that is not MTConnect, an unreadable answer and an answer Studio's reader refuses by its own rule ([section 3.7](#37-a-non-mtconnect-answer-gets-our-own-sentence)) each by its category, never in the agent's words.

### 14.3 What is withheld, and why

Observations and asset documents are the machine's own data, so agent mode answers them as the console renders them ([section 5.5](#55-result-shape)), inside the untrusted-content fence.
An asset's attributes are its row's columns as on the console, and its document is a `document` column of XML text rendered from the parsed tree: attributes and text escaped, a CDATA section as text and an entity as the character it stood for, so nothing the agent wrote is handed on as markup; a DOCTYPE, an entity declaration, a comment or a processing instruction refuses the read by Studio's own rule.

Withheld on every agent-mode handle are the agent's own adapter connections.
The agent writes an `Adapters` component under its Agent device and one `Adapter` component per adapter it reads from, and that component's name (`shdr://` and the adapter's host and port), its id, every one of its data item ids and the `ADAPTER_URI` value carry the network address of another system, measured on the fixture and on the demo ([section 10.2](#102-mcp-and-the-adapter-addresses)).
No column of such an observation can be shown without the address, so every data item the model places inside an `Adapters` or `Adapter` component, and every observation whose component stream is one, is left out, and the answer warns how many it left out with the reason (`reads`: `/current` answered 16 rows and withheld 6, `/current?path=//DataItem[@category="EVENT"]` answered 13 and withheld 4, and no answer carried the adapter's address).
The agent's other items (its availability, the devices it added, changed or removed, its asset counts) are answered, and so is every other device.

| Path | Handle | What it reads |
| --- | --- | --- |
| Investigation reads | agent read-only profile | `GET /probe`, then one request of [section 14.2](#142-what-an-agent-request-may-be) |
| Investigation grounding and plan-mode grounding | either agent profile | the device model the handle read when it opened: devices, data items and conditions by name, the adapter connections left out, no value and no asset; the asset count answers its reason and no asset is listed |
| Connect | either agent profile | one `GET /probe`, and nothing else (`connect.sent`) |
| MCP metadata tools | either agent profile | the same device model, through the same withheld set |
| Console, overview, health, performance, slow-query, session, table, index and storage readings | either agent profile | nothing: each is refused with its reason, never answered with Studio's own figures or an empty reading |

### 14.4 Agent language pack

Statement-language family: `mtconnectread`.
Overlay: [`src/lib/agent/languages/mtconnectread/engines/mtconnect.ts`](../../src/lib/agent/languages/mtconnectread/engines/mtconnect.ts), with its client row in [`src/lib/agent/languages/mtconnectread/engines/client.ts`](../../src/lib/agent/languages/mtconnectread/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`.
Both overlays are empty, so the engine resolves to the `mtconnectread` family pack itself.
The `mtconnectread` statement-language family has no dialect-bound member.
This overlay overrides no Shared member, so every Shared member is the `mtconnectread` statement-language family's own.
The family offers the investigation workflow, through `run_read_query` with one request line, and the operations workflow; it offers no query optimization or database assessment, since an agent has no plan and no profile, and no data analysis, whose tools assume a store of records, and no workflow hands an answer to the editor.
The investigation rule tells the model to read what the question names directly, a device's or a data item's current values or a window of its history, and to read `/probe` only for a data item neither the question nor the inventory names.
Plan mode's safety strip is the shared one, which is true here: an agent-mode handle reads only the device model when it opens, and that one read grounds the plan; plan mode follows the provider's `statementLanguage` label, which names the console's request line, its routes and what is never drafted.
The editor language id stays `mtconnect`, and the fence alias `mtconnectread` names this engine.
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.
No MCP tool runs an MTConnect request: the family declares no MCP facet and `MCP_STATEMENT_READ.mtconnect` is false ([B163](../BACKLOG.md#b163-mtconnects-agent-reads-withhold-the-adapter-connections-and-it-has-no-mcp-statement-read)), `MCP_EXPOSABLE.mtconnect` stays true for the metadata tools, and `READ_ONLY_ENFORCED.mtconnect` is unchanged.
