# SNMP

A read-only provider for SNMP agents. It speaks SNMPv2c over UDP today, carries a complete and
measured SNMPv3 security layer that has nowhere to be configured yet, and writes nothing, ever.

Every number in this document was measured on 13 October 2026 against net-snmp 3.29.2 on
macOS 27 with Bun 1.4.2, or against datagrams captured from it. Where something was not
measured, the document says so instead of estimating.

## 1. What it does

`connect` checks the connection record, resolves the host through the repository's shared egress
policy, and opens one UDP socket connected to the agent. `query` parses the statement before the
socket is touched, asks, and renders each value by the tag the AGENT put on it. `getOverview`
reads `sysDescr.0` and `sysUpTime.0` from the device; one the agent does not answer, or answers with an exception such as `noSuchObject`, is shown as no figure rather than as an empty one. `disconnect` closes the socket.

`listObjects`, `describeObject` and `describeObjects` answer from the bundled MIB modules and send nothing (section 6).
`getHealth` is a real read of the agent (section 6.3).
`queryReadOnly` is agent mode's, with the SNMP security modules withheld (section 13).

Four commands: `get`, `next`, `walk` and `table`, which reads a conceptual table by its entry (`table ifEntry`), since the sub-identifier after the named node is read as the column. A walk stops when `read.ts` says it stops, and
nothing else decides: the end of a subtree, a budget, an OID that did not move forward, or
silence. A second place that decides when a walk is over is a second place that can disagree.

### 1.1 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/network/snmp/sql-grammar.ts`](../../src/lib/db/providers/network/snmp/sql-grammar.ts), the `snmp` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one of the four commands `get`, `next`, `walk` and `table`, which the provider parses before the socket is touched, so no span of it is SQL.
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/network/snmp/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

## 2. Why v2c only, today

This is a fact about the connection form, not a preference. The shared connection record carries
a host, a port, a user and a password. SNMPv3 needs a security level, a privacy passphrase, a
context name and an engine id pin, and none of those exist on that record until the registration
change adds the form.

The v3 layer itself is written and measured. The captured 63-byte discovery request and the
137-byte authPriv request are both reproduced byte for byte from their own recorded inputs: the
authPriv payload is decrypted with the localised key, re-encrypted with the salt the capture
carries, and re-signed. Key derivation matches RFC 3414 appendix A.3.2 exactly. What the layer
lacks is somewhere for an operator to type.

## 3. The community is a single secret

v2c carries the community in clear in every datagram, and this provider has no transport
security to put under it. The community is read from the password field because that is what a
community is: one secret, with no user beside it. `public` and `private` are the documented
defaults every device ships with, and a connection using one is a connection anybody who knows
SNMP can make.

Reaching past this machine with a community needs the operator's explicit consent, the same
`allowInsecureAuth` the rest of the repository uses.

### Connection string

`snmp` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/network/snmp/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `snmp` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/network/snmp/execution-ui.ts).
What a tree click and Generate Query write is `SNMP_GENERATORS`, the `snmp` row of `DIALECT_GENERATORS`, declared in [`generators.ts`](../../src/lib/db/providers/network/snmp/generators.ts) and read by the engine-agnostic dispatcher in `src/lib/query-generators.ts`.

## 4. Refusals carry a reason a caller can branch on

Every refusal in this repository arrives as a `QueryError`, which carries one code for all of
them. Without something more, the only thing separating "your passphrase is wrong" from "the
clock has drifted" is English prose, and a sentence serves the person reading it while serving
nothing that branches.

`UsmError` therefore carries a `failure` field with twelve values. Three of them send an operator
to three different places:

| failure | what it means | where the operator goes |
| --- | --- | --- |
| `digestMismatch` | the answer was not written by the engine this connection authenticated to | the credential |
| `outsideWindow` | the answer's clock is more than 150 seconds from this engine's | the clock |
| `engineRestarted` | the engine reports a different boot count | discovery, again |

### 4.1 An RFC citation describes OUR reading, not the device's compliance

`localizeKey` used to refuse with "an engine ID is 5 to 32 octets (RFC 3411 section 5), this one
is N". That identity comes out of the agent's discovery answer THROUGH OUR PARSER, so the same
sentence appears when our own read of the field is wrong, and an operator who believes it writes
to their vendor about a defect that is in here. It now says what this connection read.

The same words in `connection-options.ts` are correct and stay: that value is what the operator
typed into the pin field, so the citation explains why their own input is refused. The test for
both says which is which, because the lesson is a distinction and not a ban.

## 5. What it does NOT do, and why

### 5.1 It does not act on a `usmStatsWrongDigests` Report

That Report arrives unauthenticated, necessarily: an agent that cannot verify our digest cannot
sign its complaint either. The datagram carries no evidence it came from the engine, and anything
on the path can send one. Acting on it would let any party on the network break a working
connection by asserting that a credential is wrong.

The cost is real and is stated rather than hidden: an operator with a genuinely wrong passphrase
sees silence rather than "your key is wrong". That is the price of not trusting an unsigned
claim.

### 5.2 It does not split a request on `tooBig`

`tooBig` is mapped to a reading, so a caller learns the answer was never sent rather than that
nothing is there. No code reacts to it by halving the request and asking again. This is an absent
feature, not a defective one, and writing it needs a measurement nobody has taken: how many OIDs
a real agent carries before it refuses.

### 5.3 It never writes

The valve inspects every outgoing datagram structurally and refuses any PDU that is not a Get,
GetNext or GetBulk. It parses the message rather than scanning it for tag bytes, because a byte
scan reports a false positive from inside ciphertext, at different offsets under different
runtimes.

### 5.4 SQL writing

[`snmp/sql-writing.ts`](../../src/lib/db/providers/network/snmp/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
No measurement stands behind this row; it uses the standard building blocks named above.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).

## 6. Objects

Two kinds, `table` and `scalars`.
A kind's count is the number of objects its folder lists from the bundled catalog: 36 tables and 16 scalar groups.
It counts definitions, never instances on the agent, which this provider does not count: a read outside an agent's view is indistinguishable from absence on the wire, so a number of instances would be a claim nothing measured.
The count was `{ unavailable }` before the catalog was wired, and the object tree draws a refused folder as a leaf, so the two folders could not be opened; found on 28 October 2026 by opening them in a browser against the fixture.

### 6.1 The catalog comes from the bundled modules

`listObjects`, `describeObject` and `describeObjects` read [`mib-tree.ts`](../../src/lib/db/providers/network/snmp/mib-tree.ts) and send the agent nothing, so they answer before `connect` as well as after it.
The tree shows what the bundled modules define, not what a given agent serves, so a listed table may hold no rows on a device; that cost is the one `objects.ts` states.
What each object is comes from [`mib-objects.ts`](../../src/lib/db/providers/network/snmp/mib-objects.ts), generated by `scripts/generate-snmp-mib-objects.ts` from net-snmp 5.9.4's `snmptranslate -Td`, and where it is comes from `mib-names.ts`, so the two never carry the same fact twice.
The bundled set holds 36 tables and 16 scalar groups.

A table is listed by its descriptor (`ifTable`), and a scalar group by the node its scalars hang under (`system`, `interfaces`, `tcp`).
Both are listed in the order an agent walks them, by sub-identifier value, never by dotted text.
A table the module marks `deprecated` or `obsolete` carries that word as its status; a current one carries none.
There is no paging to honour: `listObjects` answers a whole kind, and `describeObjects` applies a caller's `limit` and says so in the shared truncation sentence.

### 6.2 What a description carries

A table's columns are the columns its entry declares, in sub-identifier order; a scalar group's columns are its scalars.
Each column's `type` is the textual convention where there is one (`InterfaceIndex`, `DisplayString`) and the SMI syntax otherwise (`Counter32`).
`baseType` is the syntax a textual convention is built on, and is absent when there is none.
`declaredType`, which the column tooltip shows, is the syntax, the MAX-ACCESS and the object identifier together: `InterfaceIndex, read-only, 1.3.6.1.2.1.2.2.1.1`.
The shared column shape has no field for an access level or an object identifier, so they travel in the one field that is a declaration shown to a person.
A column whose MAX-ACCESS is `not-accessible` or `accessible-for-notify` cannot be read on its own, and is marked not projectable.

A table's index is its entry's INDEX clause, reported as one unique index named after the entry; an AUGMENTS entry carries the INDEX of the entry it augments (`ifXTable` is indexed by `ifIndex`).
An index column the table holds is primary and never absent, because its value is part of every instance's identifier; every other column may be absent from a row.
A table whose INDEX, its own or one taken through AUGMENTS, names another table's column holds no column for that part of the index.
`ifXTable` (indexed by `ifIndex` through AUGMENTS) and `hrProcessorTable` (indexed by `hrDeviceIndex`) have no primary column at all; `hrPartitionTable` marks only `hrPartitionIndex`.

A name the bundled modules do not define is refused with the reason `explainUnknown` gives, and a name of the other kind (`system` asked for as a table) is refused by its kind rather than described as the wrong one.

### 6.3 Health is a real read

`getHealth` sends one Get of `sysDescr.0` and `sysUpTime.0` through the same exchange and valve as every read, and times it.
It answers the shared health shape plus three fields of its own: `uptime` (hundredths of a second, as `sysUpTime.0` reads), `description` (`sysDescr.0`) and `roundTripMs`.
An object the agent answers with an exception, or leaves out of its answer, is named in place of its value (`unavailable: the agent answered noSuchObject for sysDescr.0`), never rendered as one.
An answer carrying a non-zero error-status, such as `genErr`, fails the read and names the status, because such an answer sends the request's own names back with NULL values that would otherwise render as an empty description and uptime.
The shared figures an agent has no notion of are sentences that say so: `databaseSize` and `cacheHitRatio`.
`activeConnections` is left out rather than sent as a zero, slow queries and sessions are empty, and an agent that does not answer fails the read rather than reporting a healthy nothing.
Measured on 28 October 2026 against the pinned fixture under Bun 1.4.2 and Node 26.12.1: the description read back as the fixture's `sysDescr` and the round trip took 0 to 1 ms on loopback.

### 6.4 Object edit (#789): nothing to write

This provider declares no editable kind and implements no edit surface, and that is not a gap
left for later. SNMP's write operation is `Set`, and the whole point of this provider is that it
has no write path at all: the valve refuses a Set before it reaches the socket, and the refusal
is tested. An object edit would need exactly the thing this provider is built not to have.

The absence lives here and in `src/lib/db/providers/network/snmp/valve.ts`, and the test that
reads this section exists so the absence cannot be shipped silently.

## 7. Limits, and both sides of each

A limit tested from one side can be loosened for free, and loosening is the direction that
matters. Each of these is tested at the value itself and one past it.

| limit | value | why |
| --- | --- | --- |
| engine id | 5 to 32 octets | RFC 3411 section 5 |
| time window | 150 seconds either side | RFC 3414 section 2.2.3 |
| boot ceiling | 2147483647 | RFC 3414 section 2.2.2; needs a person, not a retry |
| digest | 12 octets | RFC 3414 section 6.3.1 |
| privacy salt | 8 octets | RFC 3826 section 3.1.2.1 |
| max repetitions | 50 | an unbounded GetBulk killed the fixture agent |
| varbinds per request | 400 | 500 carried, 600 raised EMSGSIZE |

The engine id ceiling is worth its own sentence. Nothing exercised a pin between 17 and 32
octets, so halving it to 16 would have refused every real engine identity without a test
noticing. The identity net-snmp wrote in the capture is 17 octets, and it is now the test.

## 8. The engine's counters are a clock

Discovery learns the engine's boots and time once, and they are a clock rather than a constant.
A connection that kept sending the discovered value drifts out of the window a couple of minutes
into use, and the agent answers by refusing a credential that was never wrong.

The clock moves forward and never backward: an answer reporting an earlier time is old or
replayed, and moving the clock back would widen the window a replay has to land in. A restart,
which the boot count announces, resynchronises even though its time is lower.

A `notInTimeWindow` Report is answered by asking again, once. It is the engine saying the timing
was wrong rather than the credential, and saying in the same breath what the timing should be.
Once and not forever: an engine answering every attempt with the same Report would otherwise have
the client asking until the deadline. No other Report earns a retry.

## 9. Request ids come from `node:crypto`

Over UDP anything on the path can answer, and a counter that starts at one on every connection
makes a guessable id. A guessed id is an answer this provider would match to a question it did
not ask. The connected socket and the valve both narrow that; this narrows it further and costs
nothing.

## 10. Notices are shown once

The connection check's cautions and the bundled MIB modules' notices ride with the first result
and then stop. A notice repeated on every read is a notice an operator stops reading. They travel
in `QueryResult.warnings`, which is the repository's own surface for this.

## 11. How it is tested

The end-to-end tests in `tests/unit/db/snmp/provider-end-to-end.test.ts` drive the provider against a UDP listener that reads each datagram with the BER reader and answers by building one.
That listener is not a mock of this provider's encoder: a request never sent cannot be received, and an answer this provider cannot parse cannot pass.

Both ends are asserted.
What the agent got: version 1 on the wire, the community, the OIDs, two objects in one request.
What the caller got: the values, the type each was rendered as, and a short table column reported as an absence rather than shifting the rows below it.
A refused statement sends nothing, and that is proved by counting the agent's datagrams rather than by watching the throw.

The health read is driven the same way: a full answer, an object answered with an exception, an object left out of the answer, an answer carrying a non-zero error-status, and an agent that stops answering.
The catalog needs no listener, because it sends nothing: `tests/unit/db/snmp/mib-tree.test.ts` and `tests/unit/db/snmp/provider.test.ts` hold the listing order, the batch limit, the column and index shapes and the refusals to the bundled modules.

`tests/live/snmp-live-check.ts` runs the same surfaces against the pinned Net-SNMP fixture in CI.
Beside the reads, it lists the catalog on a provider that never connected, checks that a described table's columns are the ones a walk of that table returns, and reads health from the agent.

## 12. What it still does not do

Written here so the first real device is a measurement and not a surprise. None of these is a
known defect; they are the places where the evidence stops.

- **The v3 connection form.** The security layer is measured; there is nowhere to configure it.
- **A real v3 Report.** None was captured. The discovery reader's envelope half runs through the
  same parameter reader that reproduces a real net-snmp datagram byte for byte, and one test
  reads the engine identity straight out of those real bytes. The Report half is checked against
  a Report the test file builds, which is our bytes against our own expectation.
- **authPriv over a socket.** The crypto is reproduced exactly against real bytes, but the socket
  path has been driven end to end only at authNoPriv, because a listener that answers at
  authPriv needs the privacy key and would be testing our own encryptor against itself.
- **The window against an agent that has been up for weeks.** The captured engine reports boots 0
  and time 10, so every window case is driven from constructed values.
- **Modules this build does not carry.** A descriptor resolves against the index generated from the bundled MIB modules, and the catalog lists only what they define.
  A name from any other module is refused with the reason `explainUnknown` gives, and a table the catalog lists may hold no rows on a given agent.
- **IPv6 end to end.** Measured only against the library's own in-process agent.

## 13. Agent mode

Agent mode reads an SNMP agent through `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/network/snmp/index.ts).
The statement reader is [`agent-statement.ts`](../../src/lib/db/providers/network/snmp/agent-statement.ts), the agent's client is [`agent-client.ts`](../../src/lib/db/providers/network/snmp/agent-client.ts), the reads and their answers are [`agent-read.ts`](../../src/lib/db/providers/network/snmp/agent-read.ts), and every other surface of an agent-mode handle is [`agent-surface.ts`](../../src/lib/db/providers/network/snmp/agent-surface.ts).
Every claim below about an agent cites the capture [`tests/fixtures/snmp/5.9.4/agent-boundary/boundary.json`](../../tests/fixtures/snmp/5.9.4/agent-boundary/boundary.json), recorded by its `run.sh` against a fresh container of the `docker/snmp` image (Net-SNMP snmpd 5.9.4, one `rocommunity` over `view everything`) and written by [`tests/live/snmp-agent-boundary.ts`](../../tests/live/snmp-agent-boundary.ts).
The capture records no credential value: a withheld subtree read raw is recorded by its instance count, its columns without their instance suffixes and whether anything carried the community, and the script refuses to write a capture holding the community or its spelling as an instance suffix.

### 13.1 The boundary

The boundary is a structural closed table: every agent read goes through `SnmpAgentClient`, which holds three requests and nothing more, the Get, the GetNext and the GetBulk, RFC 3411 section 2.8's Read Class, each sent through the provider's exchange, whose valve ([section 5.3](#53-it-never-writes)) parses every outgoing datagram and refuses any other PDU.
So no Set, notification or Response can be sent on the agent path; a GetBulk carries non-repeaters 0 and the documented max-repetitions cap of 50, and a request at most the documented 400 identifiers ([section 7](#7-limits-and-both-sides-of-each)).
[`agent-provider.test.ts`](../../tests/unit/db/snmp/agent-provider.test.ts) pins every request in full against an agent on a real UDP socket (PDU type, community, identifiers, non-repeaters and max-repetitions), and [`agent-boundary.test.ts`](../../tests/unit/db/snmp/agent-boundary.test.ts) holds the agent's modules to the three read PDUs and replays the capture.

A v2c community cannot be proved read-only from the client.
Measured raw (`rawSet`), a Set with the fixture's read-only community is refused by the agent with `noAccess`; the agent path's own reads leave the agent's `snmpInSetRequests` where it was (`agentPathSentNoSet`).
That counter is no witness on its own: `run.sh` sends the refused raw Set before the capture reads it, and it still reads 0, so Net-SNMP does not count a Set it refuses `noAccess`, and the evidence that the agent path sends no Set is the closed table and the `snmpInPkts` count below.
The rights of a community live in the view-based access control tables, which are among the withheld modules below, so neither a credential nor a proof read is the boundary: the table is.
Every statement the reader refuses, and every `get` or `next` of a withheld identifier, reaches the agent not at all: its `snmpInPkts`, read raw before and after them, moved by the one read after them alone (`notSentReachedNothing`).

### 13.2 What an agent statement may be

One of the console's four commands, read by the console's own parser and resolver ([section 1](#1-what-it-does)), as the console writes it:

| Statement | Sends |
| --- | --- |
| `get OID [OID ...]` | one GetRequest naming every identifier that is not withheld |
| `next OID [OID ...]` | one GetNextRequest naming every identifier that is not withheld |
| `walk SUBTREE` | GetBulkRequests from the subtree, max-repetitions 50, until the subtree ends |
| `table ENTRY` | GetBulkRequests from the entry, shaped into one row per index as the console shapes them (`table ifEntry`) |

An identifier is written numerically, with or without a leading dot, or by a name the bundled modules define ([section 6.1](#61-the-catalog-comes-from-the-bundled-modules)).
The console's `walk SUBTREE limit N` is read as the console reads it, and agent mode does not offer it: `N` sets only the first GetBulk's max-repetitions and caps no rows, so the row budget is the read's.
The reader reads every statement under the console's own walk budget whatever the run's row budget, so the admission, which has no run, and the provider refuse the same statements with the same sentence.
Every other statement is refused before anything is sent, with the parser's sentence followed by agent mode's list of commands: `set`, `trap`, `inform`, `bulkwalk`, any other word, a malformed identifier, an arc above 2^32-1, more than 128 arcs, an identifier of one arc (`walk 1`, which BER cannot encode), a name the bundled modules do not define, a second argument a command does not take, and a `limit` above the console's walk budget of 5,000.
The admission refuses a statement longer than 4,096 characters.
Each read opens an exchange of its own, with the request's time budget as every request's deadline and as the read's, and closes it when it ends, so no socket, request id or pending answer of one call reaches the next, and the console's one-time notices ([section 10](#10-notices-are-shown-once)) are never touched.
[`agent-exchange.test.ts`](../../tests/unit/db/snmp/agent-exchange.test.ts) holds that every exchange opened for a read is closed after an answer, an agent's refusal and the time budget, and that the agent's client refuses a GetBulk above the max-repetitions cap before anything is sent.

A walk or table past the row budget is refused, never cut: a walk stops as soon as it holds one row more than the budget (`Read-only execution exceeded the row budget: 44 rows > 3 allowed` in `overBudget`), and a table stops as soon as it holds one index more than the budget.
A table is bounded by its rows, not by its objects, so a table of 300 interfaces of 22 columns each, 6,600 objects, is answered under a budget of 500 rows.
A walk the agent leaves unfinished (an empty answer, an answer that does not move forward) and a walk or table past the console's request or inbound-byte bounds are refused too, since a part of a subtree read as the whole is the failure [`read.ts`](../../src/lib/db/providers/network/snmp/read.ts) names.
A failure is worded by its category and quotes nothing the agent sent: a read the agent never answered within the time budget is silence (`Read-only execution exceeded the time budget: no answer within ...ms`), which names the other things silence can mean over v2c; `tooBig`, an error-status by its number, a report, a refused credential and an unreachable agent each have their sentence.
Studio's own refusals (the row, byte and time budgets, the closed table) are worded as Studio's, never as the agent's: a walk the agent was still answering when the time budget ran out is refused as `the agent was still answering the walk after ...ms, Studio's time budget for one read`, and a read stopped by the read's own deadline after the agent had answered is refused as `the read did not finish within ...ms, Studio's time budget for one read, while the agent was still answering`, neither of them as silence.

### 13.3 Values, and what is withheld

Values are the device's own management readings, so agent mode reads and answers them, rendered exactly as the console renders them ([`rows.ts`](../../src/lib/db/providers/network/snmp/rows.ts) and [`values.ts`](../../src/lib/db/providers/network/snmp/values.ts)): an octet string is text only when the bytes are showable text and hex otherwise, so no control byte reaches an answer, and every result reaches the model inside the untrusted-content fence.
A `get` or `next` answers an exception (`noSuchObject`, `noSuchInstance`, `endOfMibView`) as the row's type with no value, since it is the agent's answer; a walk drops them, as the console does.

Withheld, by the prefix of the parsed and resolved identifier and never by the text written, are the SNMP framework's security and target modules, the transport security modules, the USM Diffie-Hellman objects and Net-SNMP's access control extension:

| Module | Root | Holds |
| --- | --- | --- |
| `SNMP-SSH-TM-MIB` (RFC 5592) | 1.3.6.1.2.1.189 | the SSH transport's session counters and the security names its sessions map to |
| `SNMP-TSM-MIB` (RFC 5591) | 1.3.6.1.2.1.190 | the transport security model's settings for how a security name is formed |
| `SNMP-TLS-TM-MIB` (RFC 6353) | 1.3.6.1.2.1.198 | the certificate fingerprints and the security names they map to, for the TLS and DTLS transports |
| `SNMP-USM-DH-OBJECTS-MIB` (RFC 2786) | 1.3.6.1.3.101 | the Diffie-Hellman key-change objects of SNMPv3 users and their public values |
| `NET-SNMP-VACM-MIB` (Net-SNMP) | 1.3.6.1.4.1.8072.1.9 | Net-SNMP's access control extension, indexed by the group names that may read or write each view |
| `SNMP-TARGET-MIB` (RFC 3413) | 1.3.6.1.6.3.12 | the addresses notifications and proxied requests are sent to, and the security names that reach them |
| `SNMP-NOTIFICATION-MIB` (RFC 3413) | 1.3.6.1.6.3.13 | the notification filters and the targets they name |
| `SNMP-PROXY-MIB` (RFC 3413) | 1.3.6.1.6.3.14 | the proxy forwarding rules and the security names they map |
| `SNMP-USER-BASED-SM-MIB` (RFC 3414) | 1.3.6.1.6.3.15 | the SNMPv3 user names and their key-change objects |
| `SNMP-VIEW-BASED-ACM-MIB` (RFC 3415) | 1.3.6.1.6.3.16 | the access control tables, indexed by security names |
| `SNMP-COMMUNITY-MIB` (RFC 3584) | 1.3.6.1.6.3.18 | the community strings and the security names they map to |

Every other identifier under 1.3.6.1.6.3, the SNMP engine and MPD objects among them, is read: only the six framework roots above are withheld, never the subtree that holds them, and `walk 1.3.6.1.6.3` is admitted and steps over the six.
The sentence agent mode repeats in its tool description, its investigation rule, its grounding and every refusal (`SNMP_WITHHELD_MODULES_TEXT` in [`agent-statement.ts`](../../src/lib/db/providers/network/snmp/agent-statement.ts)), and the plan-mode label, name each of the eleven modules by its own root, never as the modules under 1.3.6.1.6.3, since a model read that wording as the whole subtree withheld and refused the admitted walk.
The bundled modules define none of the eleven, so no name resolves into them and only a numeric identifier reaches them; the roots are the module identities those RFCs assign, and `netSnmpVacmMIB` (`netSnmpObjects 9`) in the image's own `NET-SNMP-VACM-MIB.txt`.
An instance suffix there can spell a name (the access control tables are indexed by security name, Net-SNMP's by group name), so a value is not the only thing withheld:

- a `get` or `next` naming an identifier inside one does not send it, so not even a `noSuchInstance` tells whether a guessed community exists, and answers a row naming the module's root, typed `withheld`, with no value, and a warning naming the module and why;
- a `next` whose answer lands inside one answers the same row, never the identifier the agent sent back or its value;
- a `walk` or `table` whose subtree contains one of them (`walk 1.3.6.1.2.1`, `walk 1.3.6.1.4.1`, `walk 1.3.6.1.6.3`) steps over it: each answer is read only up to its first object inside one, the next GetBulk starts at the root with its last arc one higher (1.3.6.1.4.1.8072.1.10 after Net-SNMP's table, 1.3.6.1.6.3.17 after the five adjacent framework roots 12 to 16), so no request ever starts inside one, and the answer warns every withheld module the subtree contains, whether or not the agent holds it, so the warning tells the model nothing about the device;
- a `walk` or `table` whose subtree lies inside one, or is its root, is refused before anything is sent;
- a GetBulk that over-reads past an admitted subtree into one passes nothing of it on, as every over-read past a subtree is dropped.

Measured raw on the fixture (`withheld`): the access control module answers 42 instances under `view everything`, Net-SNMP's access table 12, indexed by group name, the user-based module 7 (its statistics), the target module 3, and the community, notification, proxy, SSH, TSM, TLS and Diffie-Hellman modules none; on this fixture no value or instance suffix of any of them carries the community, which a device configured through `SNMP-COMMUNITY-MIB` would.
Measured through the agent path (`steppedOver`): `walk 1.3.6.1.4.1` answers 1,701 rows and `walk 1.3.6.1.4.1.8072.1` 1,250, none of them inside a withheld subtree, each warning `NET-SNMP-VACM-MIB`; `walk 1.3.6.1.6.3` answers the framework's own engine and statistics objects and warns the six framework modules.
The community, read from the connection's password field, never reaches an answer, an error, a warning or the grounding; SNMPv3 has no connection form yet ([section 2](#2-why-v2c-only-today)), so no v3 key or passphrase reaches the agent path today.

Each agent-mode path reads this much:

| Path | Handle | What it reads |
| --- | --- | --- |
| Investigation reads | agent read-only profile | one command of [section 13.2](#132-what-an-agent-statement-may-be), its values as the console renders them, the withheld modules above stepped over or answered withheld |
| Investigation grounding, plan-mode grounding and the operations workflow | either agent profile | the bundled catalog's tables and scalar groups with their declared columns, which sends nothing and holds none of the withheld modules, even on a handle that never connected; the reason they are withheld reaches the run through `run_read_query`'s description, the investigation rule and the grounding advice in agent mode, and through the `statementLanguage` label in plan mode |
| Health | either agent profile | the console's own Get of `sysDescr.0` and `sysUpTime.0` ([section 6.3](#63-health-is-a-real-read)) |
| Console, overview, performance, storage, session, slow-query, table and index readings | either agent profile | nothing: each is refused with its reason, never answered with an empty reading or a zero |

### 13.4 Agent language pack

Statement-language family: `snmpget`.
Overlay: [`src/lib/agent/languages/snmpget/engines/snmp.ts`](../../src/lib/agent/languages/snmpget/engines/snmp.ts), with its client row in [`src/lib/agent/languages/snmpget/engines/client.ts`](../../src/lib/agent/languages/snmpget/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`.
Both overlays are empty, so the engine resolves to the `snmpget` family pack itself.
The `snmpget` statement-language family has no dialect-bound member.
This overlay overrides no Shared member, so every Shared member is the `snmpget` statement-language family's own.
The family offers the investigation workflow, through `run_read_query` with one command, and the operations workflow; it offers no query optimization or database assessment, since an agent has no plan and no profile, and no data analysis, whose tools assume a store of records, and no workflow hands an answer to the editor.
The workflow classifier offers the model only these two.
The editor language id stays `snmp`, and the fence alias `snmpget` names this engine.
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.
No MCP tool runs an SNMP statement: the family declares no MCP facet, `MCP_EXPOSABLE.snmp` and `MCP_STATEMENT_READ.snmp` are false ([B158](../BACKLOG.md#b158-snmps-agent-reads-withhold-the-security-and-target-modules-and-it-has-no-mcp-surface)), and `READ_ONLY_ENFORCED.snmp` is unchanged.

## Migration DDL

[`SNMP_MIGRATION_DDL`](../../src/lib/db/providers/network/snmp/migration-ddl.ts) is what the schema-diff migration generator writes for `snmp`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
An object's type is the device's MIB module, and this provider's valve refuses any PDU that is not a Get, GetNext or GetBulk.

The refusal reason it prints, verbatim:

- "An SNMP object's type is declared in the MIB module the device was built with, not in columns a client can change, and this provider's valve refuses any PDU that is not a Get, GetNext or GetBulk, so there is no column definition to change."
