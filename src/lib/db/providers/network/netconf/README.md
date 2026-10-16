# `netconf` provider

Issue #1724. One network device, read only, over NETCONF on SSH. The reader-facing document is
[`docs/providers/netconf.md`](../../../../../../docs/providers/netconf.md); this file is for
someone opening this directory.

The `network/` family was opened for this provider and holds nothing else yet. The SNMP provider is
expected to enter it next and take the shape set here.

## The modules, and the measurement each one came from

| File | What it is | The measurement behind it |
|---|---|---|
| `dial.ts` | the SSH dial, through the shared egress rule | the flag is read inside `socketEgress`, so a name resolving to localhost is accepted with the flag off and refused with it on, and `169.254.169.254` is refused either way by the link-local rule |
| `auth.ts` | login failures, and which the user is told apart | the two passphrase failures are raised inside `connect()` before any packet and with different text; a wrong password, an unknown user and a password to a key-only account all end in one sentence |
| `hostkey.ts` | the pin, its parser and its mismatch message | a wrong pin stops the handshake before any user-authentication packet, directly and through an SSH tunnel, where the key checked is the device's and not the bastion's |
| `framing.ts` | RFC 6242 framing, both forms, incremental and bounded | Netopeer2 accepts a chunk size with a leading zero, which RFC 6242 4.2 forbids, so the client refuses it; the buffer holds BYTES and decodes once, because holding text and counting bytes off it corrupted a split character and shifted the buffer off the frame |
| `session.ts` | one session: hello, request-to-reply matching, four end reasons | a probe that matched replies by arrival order blamed the wrong operation as soon as the server sent notifications, reporting 17 replies to 12 requests |
| `requests.ts` | the four reads and the close, built from typed arguments | ten non-read operations answered `access-denied` with the NACM rule list applied; `max-depth` 0 is refused and 1 is empty; `yin` is listed and refused |
| `keypath.ts` | RFC 8040 api-path key paths, their ordering and level pages | 16 measured key values round-trip and none keeps the separator; the default sort is not UTF-8 byte order and the escaped text sorts in a third order again |
| `yangkeys.ts` | a list's key names, read lexically from the module's own text | all 37 lists of nine real modules carry a `key` statement in the module that declares the list, 26 of them inside a `grouping` |
| `rows.ts` | rows out of a reply, every value as text | `netconf-client` 2.0.8 answered 18446744073709552000 for a `uint64` of 18446744073709551615, because it parsed it as a number |
| `reader.ts` | the layer between the session and the provider's surfaces | the hello announces NMDA with ZERO capabilities while the library lists `ietf-netconf-nmda` and `<get-data>` is served, so the library decides |
| `reader-port.ts` | the XML reader as an interface, not an implementation | the repository's S3 reader drops attributes and strips prefixes, and an identityref value such as `ianaift:ethernetCsmacd` means nothing without its binding |
| `xml.ts` | that interface, over `industrial/mtconnect/xml.ts` | the inherited reader accepted both captured replies unchanged, 987,956 bytes in 31 ms and 234,120 in 8 ms, with their attributes intact; what this adds is namespace scopes (decision K-10) |
| `open.ts` | the composition: dial, session, reader, and the session limits | the dial, host-key check and subsystem open took 44 ms cold and 212 ms on a later run; the five-request sequence took 350 ms in all |
| `node-ports.ts` | the real `ssh2` and socket ports | `ssh2` hands over bytes, and a character split across two TCP segments becomes two lost characters if each segment is decoded on its own, with nothing raising an error |
| `objectkinds.ts` | who enumerates what: the object surface or the Keys panel | `enumerableKinds()` excludes a kind declaring `enumeratedBy`, so a Keys-panel kind that leaves it absent is ALSO walked by the object surface, which compiles and passes every unit test |
| `labels.ts` | the engine's own words for its levels | — |
| `index.ts` | the provider class: reads, empty answers, stated refusals | the nearest read-only precedent returns empty for the metric surfaces and throws for `runMaintenance` |

## What is deliberately not here

**No XML parser.** `xml.ts` is an adapter and scans nothing; the parser is the repository's own
(K-10), and no dependency is added.

**No secret guard module.** There was one, and it was deleted rather than kept: its only live call
site branched on its answer with `withheld ? [] : []`, both arms identical and the result
discarded. A guard that does nothing while looking like a check is worse than no check. The
property it claimed is now held by `tests/unit/db/netconf/no-outward-writes.test.ts`, proved in
both directions.

**Phase 2, `gnmi`.** Not started (K-04).

## Checking it

```sh
node_modules/.bin/tsc --noEmit
node_modules/.bin/biome format src/lib/db/providers/network/netconf tests/unit/db/netconf
node_modules/.bin/eslint src/lib/db/providers/network/netconf tests/unit/db/netconf
node scripts/only-check.mjs
bun test tests/unit/db/netconf
```

Running the repository's own chain is the point rather than a formality, and it found three classes
of problem a standalone run could not see: the repository forbids a `.ts` extension on a relative
import where the standalone runner needs one (24 errors); it keeps no `*.test.ts` under `src/` and
runs `bun:test` rather than `node:test`; and `node:assert`'s `ok` narrows a type where
`bun:test`'s does not, which six assertions relied on.

Connecting the provider to a device found three more that the suite could not, and they are listed
in `docs/providers/netconf.md` section 11.
