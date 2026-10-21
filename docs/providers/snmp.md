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
reads `sysDescr.0` and `sysUpTime.0` from the device. `disconnect` closes the socket.

Four commands: `get`, `next`, `walk` and `table`. A walk stops when `read.ts` says it stops, and
nothing else decides: the end of a subtree, a budget, an OID that did not move forward, or
silence. A second place that decides when a walk is over is a second place that can disagree.

### 1.1 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/network/snmp/sql-grammar.ts`](../../src/lib/db/providers/network/snmp/sql-grammar.ts), the `snmp` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one of the four commands `get`, `next`, `walk` and `table`, which the provider parses before the socket is touched, so no span of it is SQL.
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` in `src/lib/db/destructive-commands.ts` instead of a SQL reading.
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

`snmp` has no connection string scheme, no `readTls` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/network/snmp/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `snmp` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/network/snmp/execution-ui.ts).

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

Two kinds, `table` and `scalars`. Counts are `{ unavailable }` with a reason and never zero: this
provider does not count by asking the agent, and a read outside an agent's view is
indistinguishable from absence on the wire, so a zero would be a claim nothing measured.

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

Ten tests drive the provider against a UDP listener that reads each datagram with the BER reader
and answers by building one. That listener is not a mock of this provider's encoder: a request
never sent cannot be received, and an answer this provider cannot parse cannot pass.

Both ends are asserted. What the agent got: version 1 on the wire, the community, the OIDs, two
objects in one request. What the caller got: the values, the type each was rendered as, and a
short table column reported as an absence rather than shifting the rows below it. A refused
statement sends nothing, and that is proved by counting the agent's datagrams rather than by
watching the throw.

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
- **MIB descriptors.** Names are resolved numerically. A descriptor reaching the read path is a
  defect rather than a condition, and says so.
- **IPv6 end to end.** Measured only against the library's own in-process agent.

## Migration DDL

[`SNMP_MIGRATION_DDL`](../../src/lib/db/providers/network/snmp/migration-ddl.ts) is what the schema-diff migration generator writes for `snmp`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
An object's type is the device's MIB module, and this provider's valve refuses any PDU that is not a Get, GetNext or GetBulk.

The refusal reason it prints, verbatim:

- "An SNMP object's type is declared in the MIB module the device was built with, not in columns a client can change, and this provider's valve refuses any PDU that is not a Get, GetNext or GetBulk, so there is no column definition to change."
