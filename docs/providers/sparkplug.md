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

## 4. Connection

### 4.1 Configuration fields

Host, Port, and Group. The group is one `group_id`, or empty for every group: a group is a level of
the topic and not a thing on the broker that can be subscribed to on its own, so an empty field reads
every group under `spBv1.0`.

### 4.2 There is no credential field, and that is deliberate

The session can carry a user and a password and the encoder sets their flags, but nothing passes them
from a connection yet, and this provider declares only the three fields it reads. A field that is
collected and dropped is worse than one that is absent. Declaring credentials without TLS would be
worse still: it would carry a password in cleartext, and half an authentication is worse than none.

## 5. Query interface

A read request is a JSON object and every field in it is optional: the window in seconds and the row
limit fall back to their defaults when they are absent, births are included unless `includeBirths`
says otherwise, and a group, an edge node or a device narrows the read to less than the whole plant. `rebirth`, `hostId`, `command` and `publish` are refused BY NAME rather than ignored, each
with the sentence that says why, and any unknown key is refused with the list of the fields that
exist.

The window travels to the reader rather than being echoed back: an earlier version accepted `seconds`
up to 300, printed it in the result's own sentence, and served rows from the read the connect had
already done, so a user who asked for 42 seconds was told they got 42 and got 3.

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

`enforcesReadOnly` is true and `supportsMaintenance`, `supportsExplain`, `supportsCreateTable`,
`supportsTestDataGeneration`, `supportsResultPagination` and `supportsTransactions` are false. The
dialect record declares `offersCountQuery: false`: a broker publishes no count, and a metric is not a
table.

`catalogSessions` is NOT declared, and the reason is factual rather than scope: that flag says a
connection reaches a whole server and names no catalog, each request running in the catalog the
caller picks. A Sparkplug connection reaches ONE broker, and the catalog-level thing is the Group,
which is a field of the connection rather than a catalog chosen per request.

The panel never says "Sparkplug Compatible" or "Host Application". A Host Application MUST publish
STATE (1.4.1, 10.1.2), and this provider publishes nothing.

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
- No credential or TLS fields, as section 4.2 states.
- The four connection refusals carry one error code and are told apart only by their sentences. The
  information exists one layer up as the read's end reason and is flattened at the throw; carrying it
  through waits on a typed failure field on the shared error.
- How often a window of 3, 10 or 60 seconds actually catches a certificate is unmeasured. A birth is
  published at QoS 0 and not retained, so on a broker that does not store certificates a reader sees
  one only while an edge node connects or answers somebody else's rebirth.

## 13. References

- Eclipse Sparkplug 3.0.0 specification, sections 4.1, 4.2.1, 5.3, 5.4, 5.10, 5.17, 6.4.x, 10.1.4
- MQTT 5.0: 1.5.5, 3.2.2.3.11, 3.3.4, 3.9.3, 4.7.2
- `docs/providers/mqtt.md` for the transport this provider does not share, and why
