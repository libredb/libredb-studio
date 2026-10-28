# NETCONF Provider

Issue #1724, phase 1. One network device, read only, over NETCONF on SSH.

Every number in this file was measured against a running server or read out of this repository's
own source. Where a fact could not be measured, the sentence says so rather than rounding it off,
and where this phase does not do something, section 12 says so rather than leaving it to be
discovered.

The pinned server for every measurement below is Netopeer2 2.8.7 with sysrepo, built for arm64 and
run as `libredb-1724-live`. Two servers were measured in all: Netopeer2 and a second NETCONF
server used only to check that a rule was not one implementation's habit.

## 1. Overview

A NETCONF server stands in front of a router, a switch or any device that keeps its configuration
in YANG modules. It answers a small set of operations over one SSH session: the configuration it
holds (`<get-config>`), the configuration plus its operational state (`<get>`), either of those in
the NMDA form (`<get-data>`, RFC 8526), and the text of a module it implements (`<get-schema>`,
RFC 6022).

The provider sends those four and nothing else. There is no write path, and that is structural
rather than a setting: `requests.ts` builds five request bodies, four of them the reads above and
the fifth the `<close-session>` that ends the connection. No function in the provider builds an
`<edit-config>`, a `<copy-config>`, a `<delete-config>`, a `<commit>` or a `<lock>`.

MEASURED, both ways: against the pinned server, ten non-read operations were sent by hand under
the account this provider uses and every one answered `access-denied` with the NACM rule list
applied. The provider's own refusal comes first, so neither half of that pair is the only thing
standing between a user and a write.

### Concept mapping

| NETCONF | Studio |
|---|---|
| Datastore (`running`, `operational`, …) | container, first level, labelled Datastore |
| YANG module the device implements | container, second level, labelled Module |
| Top level container or list of a module | object of kind `node` |
| Anything below such a node | one entry in the Keys panel, kind `key` |
| A list entry's key leaves | the object's columns |
| The module's own YANG text | the node's Source tab |

### What a reader sees

A datastore holds modules and a module holds nodes, so the tree has two container levels: the
first engine in this repository to declare both container levels and a Keys panel. A node is a
relation. Below a node the Keys panel takes over, one level per page, and a key's Source tab shows
the XML the device sent for it.

## 2. Architecture

### 2.1 Where it sits

`src/lib/db/providers/network/netconf/`. The `network/` family was opened for this provider and
holds nothing else yet; the SNMP provider is expected to enter the same family and take the shape
set here.

### 2.2 Modules

| File | What it is |
|---|---|
| `dial.ts` | the SSH dial, through the shared egress rule |
| `auth.ts` | login failures, and which of them the user is told apart |
| `hostkey.ts` | the host key pin, its parser and its mismatch message |
| `framing.ts` | RFC 6242 framing, both forms, incremental and bounded |
| `session.ts` | one session: hello, request to reply matching, four end reasons |
| `requests.ts` | the four reads and the close, built from typed arguments |
| `keypath.ts` | RFC 8040 api-path key paths, their ordering and their level pages |
| `yangkeys.ts` | a list's key names, read lexically from the module's own text |
| `rows.ts` | rows out of a reply, every value carried as text |
| `reader.ts` | the layer between the session and the provider's surfaces |
| `reader-port.ts` | the XML reader as an interface rather than an implementation |
| `xml.ts` | that interface, over the reader this repository already has |
| `open.ts` | the composition: dial, session and reader, with the session limits |
| `node-ports.ts` | the real `ssh2` and socket ports |
| `objectkinds.ts` | who enumerates what: the object surface or the Keys panel |
| `labels.ts` | the engine's words for its own levels |
| `index.ts` | the provider class |

3,032 lines of source and 157 tests across 10 files, all passing.

### 2.3 The XML reader is inherited, not written here

`reader-port.ts` declares the reader as an interface and `xml.ts` binds it to the reader this
repository already has, `providers/industrial/mtconnect/xml.ts`. Not one character of XML is
scanned in this directory. That is decision K-10, which reads: the reader is written once, this
provider INHERITS it and adds only what it needs, and no dependency is added.

What it needs is namespace scopes. The inherited reader keeps a name as written and resolves
nothing, which is right for MTConnect, where a prefix classifies nothing; NETCONF is the opposite,
where a module IS its namespace. So `xml.ts` resolves `xmlns` and `xmlns:p` into bindings, carries
them down the tree, and splits each name into its local part and its namespace.

MEASURED before any of it was written, by handing the inherited reader two replies captured from
the fixture: `<get-config>` on `running`, 987,956 bytes, accepted in 31 ms at 25,003 elements, and
`<get-data>`, 234,120 bytes, accepted in 8 ms at 10,003 elements, both with their attributes
intact. The repository's other XML reader, `providers/objectstore/s3/xml.ts`, is not usable here
and K-10 says why: it drops attributes and strips prefixes, so an identityref value such as
`ianaift:ethernetCsmacd` would arrive meaning nothing.

The ONE unit conversion in the adapter is written down rather than silent: this port bounds text in
BYTES and the inherited reader bounds it in characters, which are the same number only while the
text is ASCII.

### 2.4 Registration and lifecycle

`connect()` opens one session and holds it; `disconnect()` closes it. The reader is created once
per connection, and every surface below goes through it, so there is one place where a session is
opened and one place where it is closed.

## 3. Design decisions

### 3.1 A JSON read request, not a query language

NETCONF has no query language. The console takes one JSON object:

```json
{
  "datastore": "running",
  "path": "ietf-interfaces:interfaces",
  "limit": 1000
}
```

`datastore` and `path` are required and refused by name when absent, so a user who leaves one out
is told which one. `limit` defaults to 1000 and is refused unless it is a positive integer. A path
segment may be module qualified (`module:node`) and may carry list keys (`node=key1,key2`,
percent-decoded), which is the RFC 8040 api-path form.

Every node name and module name in a path follows the YANG identifier grammar of RFC 7950 section 6.2: a letter or an underscore, then letters, digits, underscores, hyphens and dots.
A node name becomes an element name in the subtree filter, so a segment outside that grammar is refused by name before any request is built, in the editor query, the Keys panel and the Source tab alike, and the request builder checks every element name it writes once more.
Key values are data rather than names, so they keep any text: they are percent-decoded and written as an escaped element body.
`/` always separates segments, so no name can hold one, and a read names a module on its first node (`ietf-interfaces:interfaces`), because the reader selects the module by it.

The shape of the request is checked before any of its fields. An array parses as an object in
JavaScript, so it is refused explicitly: without that, the message said the request named no
datastore when the real problem was that it was not a request at all.

### 3.2 NMDA is decided by the YANG library, not by the hello

MEASURED, and this is the one place where believing the hello would have been wrong: both servers
announce NMDA in their hello with ZERO capabilities attached, while their YANG library lists
`ietf-netconf-nmda` and `<get-data>` is served and answers. The provider therefore reads RFC 8525's
library and decides from it.

`<get-config>` serves the configuration datastores, both servers serving it. `<get-data>` is used
for `operational` and `intended`, which `<get-config>` cannot reach.

### 3.3 `<get-data>` takes `<subtree-filter>`, not `<filter type="subtree">`

Found by running it, not by reading it: the first live `<get-data>` carried `<filter
type="subtree">`, the form `<get>` and `<get-config>` take, and the device answered "Node filter
not found as a child of get-data node". RFC 8526 section 3.1.1 names a different element.
No test could have caught this: every request test compared our text against our own expectation.

### 3.4 One request in flight per session

A probe that matched replies to requests by arrival order blamed the wrong operation as soon as the
server began sending notifications: it reported 17 replies to 12 requests. Replies are matched by
`message-id`, and a second request on a busy session is refused by the provider rather than queued.

On an end-of-message session a request that holds the `]]>]]>` separator is refused and nothing is written, because RFC 6242 section 4.3 keeps the separator out of the data and a peer would read the first one as the end of the message.
Chunked framing counts bytes, so the same text is ordinary data there and is framed as before.

### 3.5 Only implemented modules are listed

A YANG library lists modules the device implements and modules it merely imports. The tree lists
the implemented ones, because an imported module has no data of its own to read.

### 3.6 Reading the device's text, and the ways we got it wrong

Six defects in one class, all found by widening the fixture rather than by reading the code, and
every one of them produced a sentence that blamed the device:

- `message-id` was matched with a double-quote-only pattern, so a server using single quotes was
  reported as answering no `message-id`.
- It was then searched for in the WHOLE message, so a `message-id` appearing in the DATA answered
  the match: "the device answered message-id 999 to request 7" was the device's own configuration
  text being read as a protocol field.
- The repair took the first `<`, which is an XML declaration or a comment on a server that sends
  one. The reader now takes the first ELEMENT start tag, skipping the prolog, comments and DOCTYPE.
- A namespace-prefixed hello was refused, CITING RFC 6241 8.1, which does not say what the message
  claimed it said.
- A namespace-prefixed notification ENDED THE SESSION. That is the heaviest of the six, because it
  is a wrong action rather than a wrong sentence.
- A namespace-prefixed `<data>` was reported as no data at all.

Four further spellings were then measured and handled: an attribute on the element, a space before
`>`, a space inside the closing tag, and `<capability xmlns=…>`, which had read back as zero
capabilities.

### 3.7 Four end reasons, not one

A session used to end with one reason, `protocol`, written nine times in seven different sentences,
and one of those nine was OUR OWN defect ("a request is already in flight"). The reason is now
`protocol`, `deadline`, `incompatible` or `internal`, and the compiler's exhaustive switch showed
the cost of each existing call site immediately.

### 3.8 The read-only mode

`enforcesReadOnly: true`, and it is structural: see section 1.

## 4. Connection

### 4.1 Configuration fields

Host, port, username, and one of a password or a private key with an optional passphrase. The
default port is 830, which IANA registers as `netconf-ssh` and RFC 6242 section 3 names. Port 22
is the other port a device may serve on, and it is typed rather than offered.

No connection string. `netconf://host:830` is not a scheme anything in this product parses, and
inventing one would make it ours rather than the protocol's. MEASURED: every address a reader
would paste into such a field returns null from the URI parser, so the field would accept text it
could not use.

### 4.2 The host key pin

`hostKeyFingerprint` pins the device's host key. A wrong pin stops the handshake BEFORE any user
authentication packet is sent, measured directly and measured again through an SSH tunnel, where
the key checked is the device's and not the bastion's.

The failure carries `expected` and `seen` as FIELDS rather than inside a sentence, so a caller can
show them without parsing prose. `ssh2` raises its own error afterwards, but the path that fills
those fields always runs first, and a test holds that order.

### 4.3 TLS

Not applicable. RFC 6242 makes SSH the transport, so there is no TLS panel to get wrong and no
credential warning about one. `CREDENTIAL_WARNINGS` carries no entry for this engine, and the
reason is measured rather than assumed: there is no documented vendor default account to warn
about, no JWT, and the "no secret" case is unreachable because a missing, empty or wrong
credential all end in the same refusal.

### Connection string

`netconf` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/network/netconf/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `netconf` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/network/netconf/execution-ui.ts).
What a tree click and Generate Query write is `NETCONF_GENERATORS`, the `netconf` row of `DIALECT_GENERATORS`, declared in [`generators.ts`](../../src/lib/db/providers/network/netconf/generators.ts) and read by the engine-agnostic dispatcher in `src/lib/query-generators.ts`.

## 5. Query interface

### 5.1 The request

Section 3.1. One request per execution, no statement terminator, and `supportsExplain`,
`supportsTransactions` and `supportsResultPagination` all false.

### 5.2 Bounds are Studio's own

The `limit` is applied by this provider, not by the device: `supportsExternalQueryLimiting` is
false, so the bound is written into the generated request text where a reader can see and change
it. The Keys panel pages at 500 entries and caps at 1,000, and those are Studio's numbers too,
because the server answers a level unpaged.

### 5.3 Values are carried as text

Every value leaves as text. MEASURED, and this is why: `netconf-client` 2.0.8 answers
18446744073709552000 for a `uint64` of 18446744073709551615, because it parses the field as a
JavaScript number. A `uint64`, a `decimal64` and a binary leaf all survive as text and none of
them survives as a number.

### 5.4 A list's key leaves

`yangkeys.ts` reads a list's `key` statement out of the module's own text. MEASURED against nine
real modules: all 37 of their lists carry a `key` statement in the module that declares the list,
and 26 of those statements sit inside a `grouping`, which is why the reader is lexical over the
whole module rather than a walk of the data tree.

### 5.5 A container's click reads the list inside it

MEASURED, and it is the reason this rule exists rather than a convenience. The tree lists a
module's TOP LEVEL nodes, and in `ietf-interfaces` that is the container `interfaces`, not the list
`interface` inside it. So the shipped click asked for the container, and the row builder read it as
a list of its own name: ONE row with ONE column holding the JSON of all 5,000 entries, cut at the
64 KB cell bound. The same read typed by hand as `ietf-interfaces:interfaces/interface` answered 3
rows with four columns. The click was the bad path and the typed one was right, which is the wrong
way round.

The rule is narrow and the module's own text decides it: the addressed node declares no `key`
statement, AND its children carry exactly one distinct name, AND the module declares THAT name as a
list with keys. `ietf-keystore`'s `keystore` is the control and a real one: it also holds exactly
one child name, and that name is a container rather than a keyed list, so it keeps the old reading.
A keyless list (RFC 8040 section 3.5.3) is left alone rather than handled, because no measurement
of this fixture reaches one.

### 5.6 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/network/netconf/sql-grammar.ts`](../../src/lib/db/providers/network/netconf/sql-grammar.ts), the `netconf` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one JSON read request naming a datastore and a path, so no span of it is SQL (#1724).
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/network/netconf/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

## 6. Schema introspection

### 6.1 Two container levels

Datastore, then module. Declared in `containerLevels`, and the first provider here to declare two
levels and a Keys panel at the same time.

### 6.2 Two kinds

`node` (role `relation`, with columns and a source) and `key` (role `config`, enumerated by the
Keys panel, with a source). `objectkinds.ts` asserts the three rules the repository's own census
enforces, so a wrong declaration fails inside this directory rather than after a connection opens.

### 6.3 The columns are names, never values

A node's columns are the list's key leaves. No leaf VALUE appears in a description, and the reason
is measured: the read-only account that cannot perform a single write still reads `$6$` password
hashes and keystore entries out of the configuration. A description is built from names only, so
there is nothing in it to withhold.

This used to call a secret guard and branch on its answer with `withheld ? [] : []` — both arms
identical, the call's result discarded. It did nothing while looking like a check, which is worse
than no check, because a reader auditing the file saw the guard's name and stopped there. The guard
module was deleted and replaced by `tests/unit/db/netconf/no-outward-writes.test.ts`, which proves
the property in both directions instead of asserting it in a comment.

### 6.4 Object edit (#789): nothing to write

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`, and the absence is structural rather
than this version's scope: the provider builds four read operations and a close, and there is no
function anywhere in it that can build a write. A device's configuration is also the one thing a
reader least wants edited by accident from a browser, but that is not the reason here; the reason
is that the code to do it does not exist.

### 6.5 A node's source is the module's own text, a key's is the device's bytes

`readObjectSource` answers two different things and declares both as `origin: "stored"`:

- a `node` path (`[datastore, module, node]`) answers the module's YANG text as `<get-schema>`
  served it;
- a `key` path answers the XML bytes the device sent, sliced rather than re-printed from a parsed
  tree.

Neither is a reconstruction, which is what `regenerated` would have to say.

A node's `sourceLanguage` is `plaintext` and NOT `yang`. The installed editor registers 89 basic
languages and `yang` is not among them, measured against the bundle, and
`tests/isolated/monaco-language-ids.test.ts` refuses a language id the bundle does not register.
The house answer where a language is unregistered is the nearest REGISTERED id — Oracle renders
under `sql` rather than `plsql` — and YANG has no near relative among the 89, so rendering it as
`ini` or `sql` would colour it wrongly. `plaintext` says what is true: this product shows the
module's text and does not pretend to understand it. A key's XML is `xml`, which the bundle does
register.

## 7. Monitoring and health

The health read reports the session: whether it is open, and the server's `session-id` and
capability count from the hello. There are no performance metrics, no slow queries, no table or
index statistics and no storage statistics, and each of those answers empty rather than throwing,
because the truthful answer is that this engine publishes none of them.

## 8. Maintenance

None. `supportsMaintenance: false`, `maintenanceOperations: []`, and `runMaintenance` states a
refusal rather than answering empty: a maintenance operation would be a write.

## 9. Capabilities and labels

Declared: two container levels, the two object kinds, the `keyScan` declaration, its own
`queryDialect`, the default port 830, a schema refresh pattern that matches nothing, and
`enforcesReadOnly: true`.

The dialect is declared rather than omitted, and the cost of omitting it was measured rather than
argued: `resolveTabType` gives every provider whose `queryLanguage` is `"json"` and which declares
no dialect of its own MongoDB's tab type, and `offersCountQuery`, `offersCodeGeneration` and
`offersColumnProfiling` then all answer TRUE, because those readers consult a dialect spec only
when one is declared. A read-only device with no columns was offering column profiling and a count
query.

Not declared, each for a measured reason: `connectionStringSupport` (4.1), `explainFormat` (no
engine-side plan exists), `credentialWarnings` (4.3), and no entry in `ENGINE_URI_SCHEMES` (4.1).
This engine is not in `AGENT_EXECUTION_ENGINES` and has no engine overlay supplying `statistics` or `catalogCapture`: the
first takes an engine whose provider implements a read-only statement path (`queryReadOnly`), which
this one does not; the second and third take an engine that answers catalog statistics through SQL, and
this engine answers no SQL at all.

### SQL writing

[`netconf/sql-writing.ts`](../../src/lib/db/providers/network/netconf/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
No measurement stands behind this row; it uses the standard building blocks named above.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).

## 10. Error handling

### 10.1 Scope decides what is translated, not type

`countObjects` used to carry one catch that turned every error into the module's own count
sentence. It now mirrors the house rule (`providers/platform/kubernetes/objects.ts`): a
`QueryError` and a `TimeoutError` are translated, and everything else is RE-RAISED unchanged.

The reason is SCOPE and not type: an error that breaks this one read deserves that read's sentence,
while an error that breaks the whole connection must rise, or every module reads as "unavailable"
while the connection looks healthy. Three tests hold it, the third asserting that a `RangeError`
arrives as the SAME OBJECT, by identity, so a translation would break it.

### 10.2 Nothing this provider writes leaves the process

`tests/unit/db/netconf/no-outward-writes.test.ts` holds the property that replaced the deleted
guard module: no device value reaches a log, an export or a measurement artifact. It is proved in
both directions, and its limit is written beside it rather than implied.

## 11. Testing

157 tests across 10 files, with both transport ports faked except where a live server was the
point. The fixture is a real Netopeer2 2.8.7 container, and the measurements that came out of it
are the ones that found the defects no unit test could:

- A frame reader that held the partial message in a LOCAL variable. A feed that did not finish a
  message discarded it, and the bytes were already out of the buffer. A reply arriving as 4 frames
  (10240 × 3 + 8593) over 9 TCP segments produced one message with no opening tag and no
  `message-id`, and the session refused it with a true sentence that pointed nowhere near the loss.
- A reader that held TEXT and took a byte count from it, so a cut multi-byte sequence both corrupted
  the character and shifted the buffer off the frame. It now holds bytes and decodes once, when the
  message is complete.

The contract limit of that second repair was then measured for REACHABILITY rather than assumed: a
4-byte character was placed every 160 bytes and the raw frames were tapped. Netopeer2 SHORTENS the
chunk instead of splitting a character (10240 / 10236 / 10240 / 10208 / 10240 / 10240 / 10233 /
10195 / 10240 / 10236 / 2648), and all 11 chunks decoded on their own. Unreachable against this
server, so no byte-carrying transport was written; it is recorded in section 12 as the first thing
to look for on a real device.

Live numbers from the pinned server: dial 44 ms, a hello carrying 29 capabilities, `<get-schema>`
answering 39,313 characters, and `<get-data>` on `running` for `/interfaces` answering 234,120
bytes at 5,000 of 5,000 rows.

And the whole provider, through `createDatabaseProvider` rather than through its own seams, which
is the path a user takes: connect in 58 ms, five datastores, 52 modules, `ietf-interfaces`
answering the one node that is its own, a read answering 3 rows with the columns `name`,
`description`, `type` and `enabled`, the Keys panel walking two levels with its cursor, a key's
Source tab holding the device's own XML, a node's Source tab holding the module's YANG text, and a
clean disconnect.

THAT RUN FOUND THREE THINGS NO UNIT TEST COULD, and all three are of one kind: a shape that nothing
had ever been asked to satisfy.

- `TopLevelNode` was declared TWICE, differently, in `index.ts` and in `reader.ts`. The compiler
  refused the assignment the first time the implementation was given to the interface. The field
  the two disagreed about, `isList`, was read by nothing: its only values anywhere were the ones a
  test double made up.
- `topLevelNodes` never filtered by module. `ietf-interfaces`, `ietf-keystore` and
  `ietf-netconf-server` each answered the SAME three nodes, so choosing a module in the tree changed
  nothing. The cause is structural: a subtree filter selects elements BY NAME and this read names
  none, so no filter is sent at all. The namespace resolution of section 2.3 is what tells them apart.
- The shipped CLICK was the bad path while the hand-typed one was right. See section 5.5.

## 12. Known limitations

**The framing contract limit is unproven on real hardware.** See section 11: a server that cuts a
character at a chunk boundary would lose it in the transport decoder. Netopeer2 does not do this.
Whether any shipping device does is unmeasured.

**`with-defaults` on the operational datastore is unsettled.** No published default exists for the
setting, so none is assumed; this is specification section 11.3.
The provider sends no `with-defaults` parameter at all.
Measured 2026-10-13 on Netopeer2: on `operational`, `report-all` and `trim` in the NMDA namespace answered the same bytes as the request without the parameter, the older `ietf-netconf-with-defaults` namespace was refused with `operation-failed`, and that fixture holds too few default-valued leaves to tell "ignored" from "applied with nothing to add".

**Four session limits still carry their defaults.** They are bound to definitions and their sources
are written down, but no real device has been measured against them.

**The module-namespace map is module-scoped, not connection-scoped.** `requests.ts` holds the
namespaces the YANG library gave in one `Map` at module scope, filled per connection by
`rememberNamespace`. Two connections open at once to devices that implement the SAME module name
under DIFFERENT namespaces would therefore read the second device's namespace for the first. No
measurement reaches it - both fixtures serve the standard modules at their registered namespaces,
and a module name is expected to carry one namespace by RFC 7950 - so it is recorded here rather
than fixed on a guess about which connection should win.

**A comment inside a reply is refused rather than accepted.** The inherited reader names that
refusal, and this session did not change it, because the case is unreachable against everything
measured: neither captured reply carries one. A device that does send one gets a named refusal
instead of silence.

**Phase 2, `gnmi`, is not started.**

## Migration DDL

[`NETCONF_MIGRATION_DDL`](../../src/lib/db/providers/network/netconf/migration-ddl.ts) is what the schema-diff migration generator writes for `netconf`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
A node's shape is the device's YANG module, and this provider builds four read operations and a close, so there is no table DDL to wrap either (#1724).

The refusal reason it prints, verbatim:

- "A NETCONF node's shape is declared in the device's YANG module, which the device serves and a client reads, and this provider builds four read operations and a close, and nothing else, so there is no column definition here for anything to change."

## 13. References

- RFC 6241, NETCONF
- RFC 6242, NETCONF over SSH (framing, and the port)
- RFC 6022, NETCONF monitoring (`<get-schema>`)
- RFC 8040, RESTCONF (the api-path form the key paths use)
- RFC 7950, YANG 1.1 (the identifier grammar path names follow)
- RFC 8341, NACM (the access control the measurements ran under)
- RFC 8525, YANG library
- RFC 8526, NMDA (`<get-data>`, `<subtree-filter>`)
