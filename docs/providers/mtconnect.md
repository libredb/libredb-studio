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
| `xml.ts` | The reader: attributes and namespace prefixes preserved, CDATA and an optional prolog accepted, DOCTYPE and ENTITY refused before parsing, plus a streaming walker over observations |
| `xml-bounds.ts` | The reader's bounds, each beside the measurement it was sized from |
| `model.ts` | The `probe` answer indexed by `dataItemId`, with the freshness test on `instanceId` |
| `rows.ts` | One observation to one row, joined with the model for category, type and units |
| `routes.ts` | The closed route table, the six published routes left out with reasons, the refused parameters, the console dialect and the console's derived view of the table |
| `guard.ts` | Phase 0: everything refused before a socket opens, including the `path` subset |
| `client.ts` | One operation, a GET of a route from the table, with the byte caps and the request ceiling |
| `capabilities.ts` | What the provider declares about itself |
| `index.ts` | The provider class and the refusal boundary |

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
query language, so the provider declares `queryDialect: "mtconnect"` and no `queryReadOnly`, which
is the rule issue #424 sets for a provider whose text is not a query language.

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

The scheme follows the SSL setting: with no SSL configuration the provider dials `http`, otherwise
`https`.

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

## 10. Error handling

### 10.1 Every refusal leaves as a `QueryError`

MEASURED on `origin/main`: `providers/platform/kubernetes/objects.ts:348` turns a `QueryError` or a
`TimeoutError` into `{ unavailable: error.message }` and re-throws everything else, and
`errors.ts:244` defines `isQueryError` as `instanceof QueryError`. A refusal thrown as a plain
`Error` is therefore handled as an unexpected failure and the sentence it carries never reaches the
reader.

This provider had that defect in its first version. `MtcRefusal` and `MtcClientError` both derive
from `Error`, and only the `query()` path converted one of them, so every byte cap, every request
ceiling and every guard refusal from `connect()`, from the tree's reads and from an asset's Source
tab left as a plain `Error`. The conversion now happens at one boundary in `index.ts`, and the two
classes are left as they are rather than re-parented: the shared base ends its constructor with
`Object.setPrototypeOf`, so a subclass of it answers `false` to `instanceof` its own name unless
every constructor puts the prototype back.

### 10.2 MCP, and the one thing that cannot be withheld

`MCP_EXPOSABLE` answers true. The Agent device carries the agent's own adapter addresses: MEASURED
on the demo probe, three devices (Agent, OKUMA, Mazak), of which the Agent device holds 20 items,
four of them `ADAPTER_*`, and `current` answered two `ADAPTER_URI` values that are real internal
addresses.

Both ways of withholding them were measured and NEITHER works. `machineNames: "withheld"` is
refused on a `relation` kind. `agentWalkScope` is an allow list: it keeps the one container marked
`isSessionDefault` plus the paths `alsoWalk` names, and it cannot say "every device except this
one"; its `whenNoDefault` arm cannot run here at all, because the parent default is only assigned
for a level below the deepest and this provider declares one level. Declaring a scope would not
hide that device; it would leave the grounding walk reading none of the three.

So the exposure is an acceptance, named here, and not a mitigation.

## 11. Testing

193 tests in eight files under `tests/unit/db/mtconnect/`, over the thirteen captured documents
rather than over fixtures written to suit the code. Each file addresses the real module: no
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

## 12. Known limitations

- Streaming is out of scope: `interval` and `heartbeat` are refused by name, because an answer that
  never ends cannot be carried by the shared transport.
- No credential field (4.2).
- The `path` subset is narrower than XPath, and each exclusion is a measurement rather than a
  preference (5.2).
- The Agent device's adapter addresses are visible to an MCP client (10.2).
- A composition's own name is carried where the observation has one; MEASURED on 6 of 478.

## 13. References

- MTConnect Standard Part 1 to Part 5, schema versions 1.3 to 2.8
- The agent's own Swagger document, which is the authoritative route list
- `https://demo.mtconnect.org`, the public demo agent, for every live measurement
- `tests/fixtures/mtconnect/2.8.0.3/README.md`, the provenance of the captured answers
