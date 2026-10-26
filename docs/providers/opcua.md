# OPC UA Provider

> Canonical reference for the `opcua` provider. Measured against four server stacks on
> 2026-10-11/12; every number below names the server it was measured on.

Issue: [#1677](https://github.com/libredb/libredb-studio/issues/1677).
Source: [`src/lib/db/providers/industrial/opcua/`](../../src/lib/db/providers/industrial/opcua/).

## 1. Overview

OPC UA (IEC 62541, the OPC 10000 series) is how plant equipment publishes what it is doing. A
server holds an **address space**: a graph of nodes, each with a node id, a node class, a browse
name, and, where the class is `Variable`, a value with a status code and two timestamps. There is
no table, no schema, no query language and no transaction. A client **browses** the graph, **reads**
attributes, and where a node is historized, **reads raw history**.

This provider does those three things and nothing else. It is read-only **by construction**, not by
a setting: see [2.4](#24-the-client-and-why).

### Concept mapping

| OPC UA | Studio | Note |
|---|---|---|
| Server endpoint | Connection | One connection is one endpoint URL. There is no container level. |
| Address space | Keys panel | One level is one Browse. |
| Node (any class) | Key | Addressed by an escaped browse path, not by node id. |
| `Variable` node's value | Object source (`node` kind) | Opens in a Source tab, JSON, rendered. |
| Raw history | Query result | One row per value, capped at 10,000. |
| Namespace index (`ns=`) | — | A position in the server's own table, supplied per session (Part 6 5.1.12). Sent as the reader typed it and never rewritten, which is a hazard for a saved request: see [12](#12-known-limitations). |
| Method | A listed row, never called | 448 of 460 methods reported `UserExecutable` true to an anonymous session on the first fixture. |

### The four servers every measurement names

| Server | Version | How it is pinned |
|---|---|---|
| Microsoft OPC PLC | 2.15.10 | by digest, `sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c` |
| open62541 | 1.5.9 | `ci_server` |
| Python `asyncua` | 2.1.0 | stock server, stock user manager |
| Eclipse Milo demo | 1.1.0-SNAPSHOT | public demo build |

They disagree about nearly everything a client would like to rely on, which is why this provider's
bounds are its own. The disagreements are tabulated where they bite: [5.4](#54-bounds),
[4.7](#47-server-versions-and-what-they-disagree-about), [10](#10-error-handling).

## 2. Architecture

### 2.1 Where it sits

`src/lib/db/providers/industrial/opcua/` is the first provider under `industrial/`. It is reached
through `createDatabaseProvider` like any other and extends `BaseDatabaseProvider`.

Three dependencies, all pure JavaScript with no native addon: `node-opcua-client` 2.187.16 (126
packages in its own closure, measured as a fresh lockfile holding only it) and
`node-opcua-certificate-manager` 2.187.16, which the bridge imports directly for the strict trust
store, plus `node-opcua-server` 2.187.16 as a **devDependency**, which is the in-process server the
integration suite starts. Measured on 2026-10-26: the three together add 117 packages to the
lockfile, counted by removing them and regenerating it. The three move together and to one version:
the packages of that monorepo are published only when they change, so a release the three do not
all share leaves one pin behind, and a server and client split across releases install a second
`node-opcua-types`, whose classes then register twice ("Class EUInformation already in
constructorMap"). `bun.lock` holds one copy each of `node-opcua-certificate-manager` and
`node-opcua-types`.

Both production packages are declared in `serverExternalPackages`, because two modules under them
cannot be bundled, measured by removing both names and building: `node-opcua-crypto` 6.2.3 computes
its certificate store as `fileURLToPath(new URL("../../certificates/", import.meta.url))`, which
Turbopack reads as a module request and cannot resolve — the directory is absent from the installed
package — and `@ster5/global-mutex` requires `proper-lockfile`, an optional dependency this tree
does not install. Three errors, and no others.

### 2.2 Modules

| File | What it holds |
|---|---|
| `constants.ts` | The numbers and fixed names, each with the server it was measured on. Two live beside their only reader instead: the Keys page's default and maximum are in `key-scan.ts`, because they are what its capability declares |
| `client.ts` | The eight services this provider can call, and nothing else (O-S1) |
| `session.ts` | This provider's rules over the library, stated without importing it: the endpoint pair, the pin, the credential refusal, the translation of every throw |
| `library.ts` | The one module that imports `node-opcua-client`; three library defaults overridden |
| `hostname-guard.ts` | One guard over `dns.lookupService`, installed before the library loads |
| `session-pool.ts` | One session per connection, opened once, closed on every path out |
| `connection.ts` | The dialog's fields read into options, every refusal before the dial |
| `security.ts` | Endpoint, identity policy, certificate pin |
| `pki.ts` | Where the client's own key pair and trust store live |
| `node-id.ts` | Node-id grammar; the escaped browse path the Keys panel walks |
| `limits.ts` | Chunk sizes: ours first, the server's only when smaller and real |
| `key-scan.ts` | One level is one Browse; the capability the panel reads |
| `walk.ts` | The bounded whole-tree walk, which no UI action calls |
| `read-request.ts` | The JSON read request, parsed strictly |
| `history.ts` | Raw history, two paging strategies, bounded by a value cap |
| `results.ts` | Rows: one per node, or one per historical value |
| `objects.ts` | The `node` kind, value rendering, AccessLevel decoding |
| `errors.ts` | Status codes to sentences, written from four servers' answers |
| `labels.ts` | The provider's labels |
| `capabilities.ts` | What is declared before any connection |
| `index.ts` | `OpcuaProvider` |

### 2.3 Registration & lifecycle

`connect()` reads the connection first and opens the session second, so every refusal the dialog
can earn happens **before a socket exists**: a wrong scheme, a password with no username, a pin
that is not a thumbprint, a relative PKI root, a security mode the provider does not know. One
configuration refusal arrives later and says so: a PKI root that cannot be written, because the
certificate manager creates its directories lazily ([4.4](#44-the-pki-directory)).
`disconnect()` closes the session and never throws. `isConnected()` answers from the pool.

### 2.4 The client, and why

[`client.ts`](../../src/lib/db/providers/industrial/opcua/client.ts) declares an interface naming
eight services:

`GetEndpoints` · `CreateSession` · `ActivateSession` · `Browse` · `BrowseNext` · `Read` ·
`HistoryRead` · `CloseSession`

Eight services, **ten members**: `BrowseNext` appears twice, with and without
`releaseContinuationPoints`, and `HistoryRead` three times, for a page, a continuation and a
release. Naming them apart is what lets a caller hand a continuation point back without being able
to forget to, and it adds no service to the list. `CreateSession` and `ActivateSession` have no
member of their own: they are what opening the session does, and the only module that can open one
is `library.ts`.

There is no `Write`, no `Call`, no `HistoryUpdate`, no `AddNodes`/`DeleteNodes`,
`AddReferences`/`DeleteReferences`, and no `CreateSubscription`/`CreateMonitoredItems`.

The library's own session carries `write`, `call`, `historyUpdate`, `addNodes` and
`createSubscription2` **on the same object** as the eight reads. Handing the provider that object
would make the read-only guarantee a habit; handing it this interface makes it a type. A caller who
wanted to write would have to widen this file first, which is a reviewable change rather than a
forgettable one, and
[`tests/unit/db/opcua/seam.test.ts`](../../tests/unit/db/opcua/seam.test.ts) asserts both the member
list and that `library.ts` is the only module in the directory that imports the library — `session.ts`
states the rules over it and stays clean, so a test of those rules runs with the library outside its
own import graph.

On a plant floor the difference is not academic. Measured on the issue's first fixture: an
**anonymous** session wrote a variable with status `Good`, and 448 of 460 method nodes reported
`UserExecutable` true to it, among them `ResetToServerDefaults`. The server will not stop a client.
This is what stops us.

## 3. Design decisions

### 3.1 A JSON read request, not a query language of Studio's own

The editor text is one JSON document in the Kafka style, with two shapes and nothing else
([5.1](#51-the-request)). A server answers no queries, so inventing a SQL-ish surface over Browse
and Read would promise joins, filters and aggregates that do not exist. The result is tabular so
that Studio's own layer can group and filter it afterwards.

### 3.2 Keys are escaped browse paths, not node ids

The Keys panel addresses a level by a literal text prefix and derives folders from a separator
inside the key (`KeyScanOptions.level`). A browse path fits — `Objects/OpcPlc/SlowUInt1` — except
that a browse name may contain the separator. Measured on the first fixture: four names contain
`/`, four contain `:`, four contain `.`, and one contains every candidate at once
(`Special_"!§$%&/()=?`´\+~*'#_-:.;,<>|@^°€µ{[]}`, shipped deliberately by Microsoft).

So the separator is **escaped**, not chosen: `/` in a segment becomes `%2F` and a literal `%`
becomes `%25` (`%` first, or the escape would be escaped again). The pair is reversible on every
string, verified against all seven names measured on the fixture, four of which contain the
separator. Node ids are not usable as paths at all: 1,299 of the fixture's 6,769 cannot be built
from their own browse name, and the Eclipse Milo demo writes whole paths into its ids
(`1:Metals/SouthMotor`), which the separator would then split.

### 3.3 More rows than nodes is correct

The address space is a directed acyclic graph, not a tree. Re-measured on the documented fixture by
browsing every node, one Browse each: 6,768 nodes under `i=85`, the folder itself making **6,769**,
reached over 6,865 references and **7,040 distinct browse paths**, because 41 of them hang off more
than one parent — 39 twice, and two of them thirty times each
(`DataAccess_DataItem_BaseDataVariableType_Instance1_Definition` and its `_ValuePrecision`).

**Parents and paths are two counts, and the panel shows the second.** 41 nodes have more than one
PARENT; **215** have more than one PATH, because every descendant of a multi-parent node inherits
its extra paths — so the extra rows are not 41 but 215, over 6,769 nodes. Each path is a path the
server publishes; a tree that showed a node once would have to privilege a parent the server does
not. No cycles were found — an exhaustive enumeration with no visited set
terminates at 7,040 paths, a memoised count over each node's parents agrees, and the
deepest node sits at depth 7 — but the walk keeps a visited set anyway
([5.5](#55-the-bounded-walk)): without one, those 41 nodes' subtrees are browsed again for every
path into them.

**These figures replaced larger ones that could not be reproduced**, and the replacement is worth
stating because this document's authority is that its numbers were measured. It used to say 8,756
nodes over 11,004 paths with 1,697 multi-parent nodes at depth 9, and then 7,003 paths, which was a
counting mistake of its own: path counts summed in BFS-level order, which is not a topological order
of a DAG. The node and path counts of the first set come from an OPC PLC started with an extra
`--alm`, which adds the alarms subtree — measured on that server: 8,753 nodes, 11,000 paths, depth 9
and nine namespaces, so even there the old 8,756 and 11,004 are three and four out. The multi-parent
figures belong to no configuration at all: the real count is 41 on both. The command in
[`tests/fixtures/opcua/README.md`](../../tests/fixtures/opcua/README.md) is the one every figure
here is measured against.

### 3.4 The read-only mode

`enforcesReadOnly` is true and the connection's read-only checkbox cannot turn writing on, because
there is nothing to turn on ([2.4](#24-the-client-and-why)). The dialog says so in those words
rather than drawing a control whose reason is invisible.

### 3.5 Methods are listed and never called

A `Method` node appears as a row of its own kind, `method`, and never as a folder. Opening it shows
the sentence `A method: never called by this provider, and with no Value attribute, so
BadAttributeIdInvalid is expected.` in its Source document, which is where a node's own words are
shown; a result grid has six columns and no room for it. On a plant floor a call is an actuation.
The second half of that sentence was missing until a browser run read the document of
`Server/GetMonitoredItems`: a Method has no Value attribute either, so its status is `Bad` for the
same reason an Object's is, and the one class excluded from the rule below was the one left showing
a status code with nothing explaining it.

### 3.6 Our own bounds before the server's

Part 5 6.3.11 reads "Any operational limits Property that is provided shall have a non zero value",
so a reader of the specification alone would take a published limit as either real or absent. Three
of four stacks break that rule, and two serve requests well past the limit they publish
([5.4](#54-bounds)). Every chunk size is therefore ours first and the server's only when the
server's is **smaller and real**.

### 3.7 Nothing falls back to something weaker

A security mode the provider does not recognise is refused rather than defaulted. A server that
offers no endpoint in the requested mode is refused rather than connected in a weaker one. A PKI
root is never resolved to the LIBRARY's default, which works on a developer's machine and cannot
work in the image; it falls back to a directory Studio owns instead, inside the data directory it
already writes ([4.4](#44-the-pki-directory)). A relative one is still refused, because it would
resolve against whatever directory the server happened to start in, and a root that cannot be
written refuses the connection in its own words rather than blaming the endpoint.

## 4. Connection

### 4.1 Configuration fields

| Field | Label in the dialog | Meaning |
|---|---|---|
| `host` | Endpoint URL | `opc.tcp://host:port/path`. The whole address: host and port are read **from** it. |
| `user` | Username | Empty for an anonymous session. |
| `password` | Password | Refused without a username. |
| `securityMode` | Security mode | `None`, `Sign` or `SignAndEncrypt`, chosen with three buttons. Default `SignAndEncrypt`. Studio's own `sslMode` and the shared SSL panel are **not** read: their vocabulary (`require`, `verify-full`) names nothing a server offers, so this entry declares `showSslPanel: false`. |
| `securityPolicyUri` | — (seed file only) | Optional. An endpoint is a **mode and a policy**, so the policy of the endpoint chosen for the mode is what the session dials with; naming one here narrows the choice to that pair and is refused when the server offers no such pair. |
| `serverCertificateThumbprint` | Server certificate | SHA-256, 64 hex characters; colons and spaces ignored. Refused together with `securityMode: None`, because a pin cannot be enforced there ([4.5](#45-the-certificate-pin)). |
| `clientCertificatePath` / `clientPrivateKeyPath` | — (seed file only) | Supplied together or not at all. |
| `sshTunnel` | SSH Tunnel | Standard Studio tunnel. The address is rebuilt rather than replaced: the tunnel rewrites `host` to the local end, which for this engine is the whole URL, so the dialled URL keeps the scheme and path the reader typed and takes the local authority. A tunnel the factory has not opened is refused rather than dialled. |

**The three rows with no label are seed-file fields, and that is deliberate.** A policy URI is a
string nobody types correctly from memory, and a certificate and a key are files on the host Studio
runs on: all three are deployment facts, so they are declared in `seed-connections.json`
([`docs/SEED_CONNECTIONS.md`](../SEED_CONNECTIONS.md)) and nowhere in the dialog. They reached the
provider from no surface at all until a review traced them — code with no way in, and a deployment
story in [4.4](#44-the-pki-directory) built on it. `securityMode` and
`serverCertificateThumbprint` are declared in the seed schema too, and they have to be: zod strips
an undeclared key in silence, and a seeded connection naming `SignAndEncrypt` and a thumbprint
reached this provider with **neither** — an unpinned connection dialled with the library's default,
which trusts a server on first sight.

**And no port box.** The dialog drew one for every engine that takes a host, so this engine showed
a port field holding `4840` beside an endpoint URL that carries its own port: measured in a browser,
a reader could type `54840` into it and the dial still went to the port in the URL — a correction the
box could not make. It is drawn from the declaration now (`connectionFields`, which for this engine
names no port), by the same rule as every other field, and the endpoint takes the whole row. The
`defaultPort` of `4840` stays as the IANA-registered port for `opc.tcp`, which is what a seeded
connection reads. Nothing shows it to a reader: the login screen's example connection is built from
`SIGNATURE_URIS`, which this engine is not in, and the dialog draws no port box for it.

**And the endpoint box starts empty.** It used to start at `localhost`, the generic host default,
under the label "Endpoint URL" and beside a placeholder reading `opc.tcp://plc.example.net:4840/` —
so a reader who picked this engine and pressed Test Connection was refused for a value Studio had
put there. Measured in a browser. The same declaration decides it: an engine whose address is one
URL takes no port field, and for those the untouched default is cleared. Only the UNTOUCHED default:
an endpoint the reader typed survives a change of engine, and `localhost` comes back when they pick
an engine addressed by host and port.

There is no connection-string toggle: the endpoint URL _is_ the address, so there is one place a
reader can be wrong and one place to correct. A credential in the URL (`opc.tcp://user:pw@host`) is
refused, because it would be written into a saved connection's address.

### 4.2 Authentication

Anonymous when no username is given, `UserName` when one is. A password with no username is refused
(`A password with no username names no identity.`). Certificate and issued-token identities are not
in this version.

### 4.3 Security modes, and where a password is protected

`None` encrypts nothing and authenticates nobody. Measured: with a strict certificate manager a
`None` connect still succeeds and `checkCertificate` is **never called at all**, so a certificate
pin cannot be enforced on a `None` channel even in principle.

The password itself may still be encrypted on a `None` channel, where the server's `UserName` token
declares its own policy (Part 4 7.41). Captured on the wire against OPC PLC: 2,428 bytes written,
no plaintext present, the token's `encryptionAlgorithm` `rsa-oaep`, the encrypted password 256
bytes. But **stock `asyncua` declares the token's policy as `None`**, and then nothing encrypts it.

So the rule reads the _effective_ policy — the token's own, or the endpoint's where the token's is
null — and refuses only an effective `None`. It is applied in `session.ts` after `GetEndpoints` and
before the session, because the token's policy is a fact only the server can state (Part 4 7.41) and
because a refusal before `CreateSession` has sent nothing:

> This connection would send its password to a host that is not this machine with nothing
> encrypting it: the security mode is None and the server's UserName token declares no policy of its
> own either. Choose Sign and Encrypt under security, or connect through an SSH tunnel.

Exempt when the host is loopback or the connection is tunnelled, which is the rule
[`qdrant.md`](./qdrant.md) 4.6 states and every provider with a secret follows.

### 4.4 The PKI directory

`LIBREDB_OPCUA_PKI_ROOT` defaults to `<data directory>/opcua-pki` — the directory Studio already
owns and writes to, which holds the storage database — and the variable overrides it. It used to be
REQUIRED, with no default, because the LIBRARY's default cannot work in the image (`os.homedir()` is
`/nonexistent` there). That reasoning was right about the library and wrong about the remedy:
measured end to end in a browser, a reader who installed Studio, picked OPC UA and pressed Test
Connection was told the engine needs a directory nobody had mentioned, so the engine could not be
used at all until they found an environment variable. A deployment that mounts its data directory
(the chart's PVC, a Docker volume) gets what this section asks for without setting anything; a
deployment that shares ONE client identity between replicas still sets the variable.

The client generates its own key pair
and self-signed certificate on a first connect — even in `None` mode — and keeps `trusted`,
`rejected` and `issuers` beside them.

The library's default root is the platform's config directory:

| Platform | Default root |
|---|---|
| Linux | `$HOME/.config/node-opcua-default-nodejs/PKI` |
| macOS | `$HOME/Library/Preferences/node-opcua-default-nodejs/PKI` |

Measured on `ghcr.io/libredb/libredb-studio:0.18.2`: the process runs as uid 1001 whose passwd
entry is `/nonexistent`, `os.homedir()` is `/nonexistent`, the directory does not exist and `mkdir`
there fails `EACCES`. The LIBRARY's default is not awkward in the image, it simply cannot work.

Hence the fallback is Studio's own data directory rather than the library's, and an absolute path
where the variable is set: a relative one would resolve against whatever directory the server
happened to start in. A root that cannot be written refuses in its own words, naming the directory
and this variable — measured with the data directory made read-only, where the refusal used to blame
the endpoint of a server that was listening. A connection may also supply its own certificate and
key, which is what a mounted secret is for: two replicas sharing one key present **one** identity
for a server administrator to trust once.

### 4.5 The certificate pin

Without a pin, any certificate the trust list accepts is accepted — and the library's default trust
list accepts everything. Measured on `node-opcua-client` 2.187.3, and re-read in the 2.187.16 source
(`getDefaultCertificateManager`): the shared default certificate manager is built with
`automaticallyAcceptUnknownCertificate: true`; a `SignAndEncrypt` connect to a server nobody had
ever seen **succeeded** and wrote that server's certificate into
`PKI/trusted/certs`; the server was then recreated with a new certificate and the next connect
trusted that one too, with no prompt and no error. Part 4 6.1.3 says the opposite in as many words:
"Applications shall never communicate with another application that they do not trust."

So the certificate manager is strict, and a pin is checked **before the session exists**: the
thumbprint - SHA-256 over the certificate's DER, the form `openssl x509 -fingerprint -sha256`
prints - is read from `GetEndpoints` and compared there. Measured, the library's own
`checkCertificate` fires exactly once and before `CreateSession`, so a wrong pin refuses with zero
`CreateSessionRequest` on the wire. The refusal names both thumbprints and says nothing was sent.

**What the pin catches is an honest rotation, not an attacker**, and that holds on the two modes where
a pin is allowed at all. (With `None` it is refused outright, for the reason this section's last
paragraph gives.) The thumbprint it compares comes from this provider's own `GetEndpoints` dial,
which is unsecured by construction (`library.ts` builds that client with `MessageSecurityMode.None`),
while the certificate the session actually uses comes from a second, independent discovery that
`node-opcua` performs inside `connect` (`client_base_impl.js` `fetchServerCertificate`). Nothing binds
the two, so a host answering the typed address can serve one certificate to the pin dial and its own
to the channel dial. That grants nothing on `Sign` or `SignAndEncrypt`, because the strict manager
still answers `BadCertificateUntrusted` for a certificate the trust list does not hold; it means the
pin's value is narrower than the word suggests. `docs/BACKLOG.md` U130 records comparing the pin
against the session's own certificate.

**The trust list is the gate; the pin narrows it.** A pin is a check, not a trust decision, so
pinning a thumbprint does not make an unknown certificate acceptable: measured against OPC PLC with
a fresh PKI root, a `SignAndEncrypt` connect answers `BadCertificateUntrusted` until the server's
certificate is in the trust list, pinned or not. An administrator puts it there once —
`<LIBREDB_OPCUA_PKI_ROOT>/trusted/certs/` — which is the certificate exchange an OPC UA deployment
does anyway, and the refusal says so.

**And the refusal names THIS connection's own root**, because it is the only answer a secured connect
gives and the browser offers no way to move a file: it used to say "rejected/" and "trusted/certs"
without ever saying where those are. The resolved root is interpolated into the sentence
(`errors.ts`), so a reader is told, for example, `... wrote the certificate it was offered into
/app/data/opcua-pki/rejected: MOVE that file into /app/data/opcua-pki/trusted/certs`. The dialog's
own hint under Security mode says the same thing before the press, because the standing mode is
`SignAndEncrypt` and a first connect to a server nobody has trusted yet meets this wall.

### 4.6 One endpoint, the one typed

The endpoint dialled is the one a reader typed, never one the server advertises. This is a
measurement, not a precaution: OPC PLC advertises `opc.tcp://<container id>:50000/`, which resolves
nowhere outside the container, and Milo advertises the client's own host with the server's internal
port. Measured, this provider's dial makes zero DNS lookups of the advertised host and opens one TCP
connection, to the typed one, with a decoy listener never touched. `endpointMustExist` is therefore
false — true would fail against every OPC PLC and every Milo behind a port map.

### 4.7 Server versions and what they disagree about

| Fact | OPC PLC 2.15.10 | open62541 1.5.9 | asyncua 2.1.0 | Milo 1.1.0 |
|---|---|---|---|---|
| `MaxNodesPerRead` published | 2,500 | 0 | 10,000 | 10,000 |
| … enforced | yes (2,501 fails whole) | no (served 20,000) | no (served 10,500) | yes |
| `MaxNodesPerBrowse` published | 2,500 | 0 | 10,000 | 250 |
| Browse continuation points | 10 | 32 | none handed back | 250 |
| History continuation points | 100 | — | none handed back | — |
| `CurrentSessionCount` (`i=2277`) | readable | readable | `Good`, empty Variant | `BadNotReadable` |
| Wrong password | `BadUserAccessDenied` | `BadUserAccessDenied` | **accepts anything** | `BadIdentityTokenInvalid` |
| History of a non-historized node | `BadHistoryOperationUnsupported` per node | `BadNotSupported` at service level | `Good`, zero values | — |

Stock `asyncua`'s default user manager returns a user for any username and any password, including
an invented one. That is the server's behaviour, not a bug here, and it is why the error table is
keyed on four servers rather than one.

### 4.8 SSH tunnel

Supported through Studio's shared tunnel. A tunnel also exempts the plaintext-identity refusal
([4.3](#43-security-modes-and-where-a-password-is-protected)).

**Which side holds what**, because this provider had it backwards twice. `tunnelledConnection`
(`src/lib/db/factory.ts`) hands a provider the forward's LOCAL `host` and `port` — the address to
dial — and carries the pair the reader typed under `TUNNEL_FAR_END`, which for this engine means the
far end's `host` IS the endpoint URL, since the factory opens the forward with
`createSSHTunnel(id, sshTunnel, connection.host, connection.port)`. So the URL is parsed from the
far end and dialled at the local pair: `opc.tcp://plc.example.net:4840/milo` through a forward on
57321 is dialled as `opc.tcp://127.0.0.1:57321/milo`. Read the other way round, it dialled the local
address at the REMOTE port, and the unit test agreed with it because its fixture inverted the pair
too. A tunnel the factory has not opened is refused rather than dialled.

### Connection string

`opcua` has no connection string scheme, no `readTls` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/industrial/opcua/connection-string.ts)).
`securityMode`, `serverCertificateThumbprint`, `securityPolicyUri`, `clientCertificatePath` and `clientPrivateKeyPath` are its seed-only fields, declared in `SEED_ONLY_FIELDS` in `src/lib/db/connection-fields.ts` (#1677): on any other engine the provider never reads them, so a seed of another engine that carries one would be listed as pinned or as encrypted and be neither, and is refused by name.
The last three are the fields the dialog has no box for, because they are deployment facts: the policy to insist on, and the client certificate and key to present.
A server with a trust list of its own has to be given a stable client certificate before it will accept a secured channel, and a file path is how a deployment names one, which is the seed file's job and not a text box's.

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `opcua` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/industrial/opcua/execution-ui.ts).

## 5. Query interface

### 5.1 The request

One JSON object per run, in one of exactly two shapes. A key the parser does not know is refused,
because ignoring it would run a different read from the one the reader wrote.

Current values:

```json
{ "read": ["ns=3;s=SlowUInt1", "ns=3;s=FastUInt1", "i=2258"] }
```

Raw history:

```json
{
  "history": "ns=3;s=HistorianInt32",
  "start": "2026-10-12T00:00:00Z",
  "end": "2026-10-12T01:00:00Z",
  "limit": 500
}
```

`read` is a non-empty array of node ids. `history` is one node id; `start` and `end` are ISO 8601
instants; `limit` is 1 to 10,000 and defaults to the cap. A node id must satisfy the Part 6 5.1.12
grammar — `i=`, `s=`, `g=` or `b=`, optionally behind `ns=` or `nsu=` — and is refused here rather
than at the server, because a refusal before the request is a sentence a reader can act on and a
status code afterwards is not. Measured why it matters: `asyncua` answers a history read of a node
that keeps no history with `Good` and zero values, so a reader who mistyped would see an empty table
and conclude the node is empty rather than wrong.

### 5.2 Result shape

Both shapes answer the same six columns:

`nodeId` · `value` · `shape` · `statusCode` · `sourceTimestamp` · `serverTimestamp`

**One Read, not ten.** (Ten attributes: `OPCUA_READ_ATTRIBUTES` lists `Value` and nine beside it.) A Read takes (node, attribute) pairs, so a node's value and the nine
attributes beside it — node class, data type, value rank, array dimensions, AccessLevel,
UserAccessLevel, Historizing, Description, DisplayName — travel in one request rather than in one
request each. Eight of the nine reach a surface: the Source document shows them. `DisplayName` is
read and shown nowhere yet; it is in the set because a row's own label is the next thing a panel
asks for, and asking for it later would cost a second request per node. That is also why a stated limit is divided before it is compared: a server's limit
counts operations, and one node costs ten of them.

A value read answers one row per node **in the order the request named them**; a history read one
row per value in the server's order. `shape` is how the value was rendered: `null`, `boolean`,
`number`, `bigint`, `string`, `datetime`, `bytes` (hex), `array` or `object` (JSON). A value is
data: a string holding HTML or ANSI escapes is shown as text and never rendered as markup, and a
ByteString is hex because it need not be text at all — measured, one node on the first fixture holds
bytes that are not valid UTF-8, and decoding them would substitute replacement characters for the
reader's own data.

**A bad status is a row, not a dropped row.** A Read answers `Good` with a value, `Uncertain` with
a value, or `Bad` with none, per node. Dropping the bad ones would say the node does not exist,
which is a different and wrong statement. A node the server did not answer for at all reads
`BadNoAnswer`, which is this provider's own word and not a server's code.

### 5.3 History paging

A history read has no natural end. Measured on the pinned fixture: the node's history has a fixed
origin and a moving end, because the server back-fills synthetic values from before its own start
and appends one every 10 seconds. The same 24-hour window walked eight times over nineteen minutes
answered 11 pages, then 12, then 13.

So the read is capped, and the result **says why it stopped** — as a `warnings` entry on the
result, carrying the server's status code in the warning's own `code`, because that is the one
channel a result has and the one `StatsBar` draws. It was a `notice` field cast onto `QueryResult`
with `as`, which is a field no surface reads: the cast is why the typecheck was quiet, the route
answered the sentence in the body, and the reader saw an empty grid and nothing else — the exact
failure this sentence exists to prevent.

| End | What the reader is told |
|---|---|
| `exhausted` | The server had no more values in this window; _n_ were read. |
| `refused` | the server's own sentence for the code it answered, with the count read before it. |
| `value-cap` | The read reached its cap of _n_ values, and the node holds more. |
| `no-continuation` | _n_ values were read, and the rest of the window is unreachable. |
| `empty-pages` | _n_ values were read, and the read stopped: the server answered more than ten pages in a row that held no values and a continuation point each. |
| `request-budget` | _n_ values were read, and the read stopped after 300 requests: this server answers so few values per request that reading the rest would be a storm rather than a read. |

**A page may be smaller than the number asked for**, and that is the server's choice: measured on
OPC PLC, asked for 1, 50, 100, 101, 250, 500, 1,000 and 5,000 values it answered 1, 50, 100, 100,
100, 100, 100 and 100. So the page size is the ceiling of one request rather than the size of a
page, and what makes a read finish is the cap.

**Three bounds end a history read, and each one exists because the others leave a gap.** The value
cap (10,000) ends a read that makes progress. `OPCUA_HISTORY_EMPTY_PAGE_LIMIT` (10) ends one that
makes none. And `OPCUA_HISTORY_MAX_REQUESTS` (300) ends the one in between: a server that answers
ten empty pages and then one value, for ever, resets the empty-page counter every eleventh page and
so meets neither of the other two until the cap — measured against such a client, 109,990 requests
inside one HTTP request. 300 is far above any real read: the whole of the fixture's historized node
is 21 requests, and the value cap at the 100 values a page this server really answers is 100.

**A page with a continuation point and no values in it moves nothing**, and following one for
ever was an unbounded loop: the value cap ends a read only because each page carries values.
Measured with a server that answers Good, zero values and a point: 50,000 HistoryReadNext calls and
still going, one HTTP request that never answered, and the session held for all of it. Part 11 does
not forbid such a page — a server may be stepping over a gap in its own archive — so ten in a row
are followed and then the read stops with `empty-pages` and releases the point. None of the four
servers measured ever answered one.

**A short page is therefore not the end of the history**, and reading it as one is a mistake this
provider made: Part 11 5.3.2 lets a server return fewer values than asked for, so a server that
caps its pages below the ask and hands back no continuation point would have had its FIRST page read
as the whole of a node's history, with nothing on screen saying so. Only a page with nothing in it
ends the window. The cost is one extra round trip per read, the one that comes back empty, and the
loop stays bounded because every page that continues it carries at least one value and the cap
returns first.

Two paging strategies, because not every server offers the first. OPC PLC hands back a continuation
point. `asyncua` **never** hands one back — measured, a read with `numValuesPerNode: 5` returned 5
values and no continuation point — so there the next page starts just after the last source
timestamp. The result reports which strategy was used.

**The window AND the page size are fixed once, and every page carries both.** A server validates a
continued read against the details of the read that handed out the point — `ReadRawModifiedDetails`,
which holds the window and `numValuesPerNode`. Measured on OPC PLC, each of these answered
`BadContinuationPointInvalid` on a later page:

| What changed between pages | What the reader got |
|---|---|
| an open-ended window resolved per call (`new Date()` seconds later) | the first page, reported as "the window is exhausted" |
| the page size shrunk as the cap came closer (500, 500, 200 for a cap of 1,200) | 800 of 1,475 values, reported as exhausted |

With both fixed, a cap is exact and says so: measured against the same node, which held 1,667
values at that moment and 2,000 when the figures were re-measured — it gains one every 10 s, which
is why the live check reads the node's whole history first and chooses its caps from that rather
than from a number written here,
caps of 1,200, 700, 500 and 101 answered exactly that many over 12, 7, 5 and 2 pages, each ending
`value-cap`. The cap is honoured by **slicing** what came back, never by asking for less.

The release carries them too, which is the only way the server's slot is handed back: the library's
`readHistoryValue` convenience takes no `releaseContinuationPoints` at all, so this provider calls
the `HistoryRead` service itself.

**A refusal is not an empty window.** The status of every page is read before its values, and
anything but `Good` or `Uncertain` ends the read with the server's own code and its own sentence.
Measured: a node that keeps no history answers `BadHistoryOperationUnsupported` with zero values, a
node that does not exist answers `BadNodeIdUnknown` with zero values, and before this both arrived
as an empty table with nothing said.

`numValuesPerNode` is always set, never left to the server: Part 11 6.5.3 reads 0 as "no
maximum", and `node-opcua-client` sends 0 when the caller says nothing
(`options.numValuesPerNode || 0`), so a read that said nothing got whatever page the server felt
like — 100 values on OPC PLC, 1,100 in one response on `asyncua`. `returnBounds` is explicitly
false: the library defaults it **true**, which on open62541 turned a one-hour read of a historized
node into two rows whose value is null. `isReadModified` is false — raw history only in v1.

### 5.4 Bounds

| Bound | Value | Why |
|---|---|---|
| Nodes per Read | 200 nodes (2,000 operations) | ours; a stated limit counts operations and is divided by the ten attributes a node costs, so 250 nodes would sit exactly on OPC PLC's enforced 2,500 |
| Nodes per Browse | 20 | a Browse answer carries every child of every node asked about |
| Client message ceiling | 2 MiB | the library's; enforced on Milo, where crossing it kills the channel, and not on OPC PLC, where an 8.11 MB answer succeeded and 2,500 nodes earned `BadEncodingLimitsExceeded` with the session alive |
| History values per page | 500 | set explicitly, never left to the server |
| History value cap | 10,000 | what makes an endless read finish |
| Keys page | 200 default, 1,000 max | one level's own list |

A limit counts as published only when the read was `Good`, the Variant was not empty, and the value
is above zero. open62541 publishes eight limits all reading 0; `asyncua` publishes twelve of which
six read `Good` with an empty Variant; OPC PLC publishes `MaxSessions` as 0. Absent, empty and zero
therefore all mean "the server stated no limit", never "the limit is zero". `BadTooManyOperations`
is a status to map, never the safety net.

Read and Browse need **two** sizes: Milo publishes 10,000 for Read and 250 for Browse on the same
server, a forty-fold difference, because a Browse answer's size is unbounded in a way a Read's is
not.

**An oversized answer kills the channel on one server and not on another, which is why the bound is
ours.** Measured on Milo: one Browse of 100 nodes answered
`max message size exceeded: 2097152 : total message size 2162655`, and every later request on that
session then failed `Invalid Channel BadConnectionClosed`, with no recovering it. Measured on OPC
PLC: a Browse of 1,000 nodes answered 8.11 MB — four times the ceiling — and succeeded, because the
library replaces a `maxChunkCount` of 0 with its own default of 0, which means no limit; a Browse of
2,500 nodes was refused `BadEncodingLimitsExceeded` and the session stayed usable. So the batch
sizes stay inside the ceiling for the server that enforces it, and both codes are in the error
table.

### 5.5 The bounded walk

[`walk.ts`](../../src/lib/db/providers/industrial/opcua/walk.ts) walks the address space breadth
first under a node budget and a depth budget, and reports which it spent. **No UI action calls it**:
the documented fixture holds 6,769 nodes, the deepest at depth 7, and the Milo demo holds at least 60,000 with one
level of 10,000 children in a single Browse answer, where an unbounded walk is unbounded in the
literal sense.

The visited set is not an optimisation. Without it the same subtree is re-browsed for every path
into it — 7,040 browses instead of 6,769, which is 4.0% wasted on the documented fixture and 25.7%
on the same image started with `--alm` (11,000 instead of 8,753) — and unterminating on a server
with a genuine cycle.

### 5.6 Cancellation

A read in flight is bounded by the chunk sizes and the value cap rather than by a cancel signal: a
request is at most 200 nodes or 500 values, and a history read stops at its cap, handing the
server's continuation point back at that point — every earlier page's point is consumed by the
request that follows it, which is the other way a slot is not left held.

### 5.7 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/industrial/opcua/sql-grammar.ts`](../../src/lib/db/providers/industrial/opcua/sql-grammar.ts), the `opcua` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: the console takes one JSON read request naming node ids, so no span of it is SQL (#1677).
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` in `src/lib/db/destructive-commands.ts` instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

## 6. Schema introspection

### 6.1 The object surface (#789)

One kind, `node`, `role: "relation"`, `hasColumns: false`, `hasSource: true`,
`sourceLanguage: "json"`, `enumeratedBy: "key-browser"`. A node has attributes defined by its type
in the server's model, not columns, so a column list would promise a grid the node does not have.

`enumeratedBy` is the member that makes the panel work, and it was missing. `keyBrowserKind` reads
it, and `Studio.tsx`'s `onOpenKey` falls through to the generated-read branch without it: the
generated read for this engine is a `//` comment, so a reader who clicked a node to see its value
was answered `JSON Parse error: Unrecognized token '/'`. Every test passed, because no test clicked.

`listObjects`, `describeObject` and `describeObjects` all refuse with one sentence:

> Nodes are listed in the Keys panel, one level at a time, which is the only surface that browses
> them.

That keeps the kind out of the Objects tree, out of inventory and search, and out of the agent's
grounding walk, which is correct for a graph of this depth.

**And the sidebar opens on Keys for it.** An engine that declares a key walk and NO enumerable
object kind — MQTT and OPC UA are the only two — has nothing to put in the Objects tab, so opening
there asked this provider for an inventory it refuses by design and the reader's first screen after
connecting carried a red "Schema Error" toast quoting that refusal. Measured in a browser, which is
the only place it could be: every unit and route test passed throughout. Three rules close it, each
read from the declaration rather than from a type-id:

1. `relationKindIds` no longer names a kind the Keys panel enumerates, so the inventory is never
   asked for one (`src/lib/db/object-kinds.ts`). Measured over all 33 shipped declarations, exactly
   one answer changes: `opcua`, from `["node"]` to `[]`.
2. The sidebar's default tab is Keys where nothing is enumerable, and that default is **derived every
   render rather than stored** (`src/components/sidebar/Sidebar.tsx`). Storing it was a defect of its
   own, found by a second review: one OPC UA or MQTT connection left `keys` in the sidebar's state
   for good, so the next Redis, etcd, Oxia or S3 connection opened on a key walk nobody asked for —
   on Redis an unrequested `SCAN` — with the object tree absent until the reader found the tab. The
   reader's own choice is still kept, and kept with the connection they made it on, so a chosen
   Objects is not carried onto an engine that has nothing to put there.
3. The Objects tab, when a reader presses it, says where the nodes are (`tree-listed-elsewhere` in
   `src/components/object-tree/ObjectTree.tsx`). It used to say "the engine answered, and reported
   nothing at this level" — a claim about a server holding 6,769 nodes, and false. In the embedded
   workspace, which ships no API routes and therefore no key walk, it says they are not listed there
   at all rather than naming a tab that is not drawn.

**No agent meets any of this**, and that is worth saying where a reader would otherwise wonder what
`inspect_schema` answers for such an engine: `MCP_EXPOSABLE.opcua` is `false`
([`src/lib/db/compatibility.ts`](../../src/lib/db/compatibility.ts)), a seed file naming `mcp: true`
on this engine is refused when it loads, and no OPC UA connection is ever visible to an MCP tool.
Measured over all 33 shipped declarations: every engine that enumerates a kind in the Keys panel —
etcd, Oxia, S3, MQTT and OPC UA — is `false` there, so this round wrote a sentence for
`inspect_schema` to answer with, found no caller that could ever read it, and took it out again.

`countObjects()` answers `{}`. A server publishes no count of its nodes, and a number produced from
whatever one Browse returned would be a total with nothing behind it: 6,769 nodes on the measured
server and over 60,000 on another, neither published.

`listContainers()` answers `[]` and `containerLevels` is empty: one connection is one server
endpoint.

### 6.2 Object source (#789)

Clicking a key opens one part, `node` — which is what `enumeratedBy: "key-browser"` above buys —
with the node id, the node class as the server answered it, the
value, its shape, its status code, both timestamps, data type, value rank, array dimensions,
`accessLevel` and `userAccessLevel` as words, `historizing`, `keepsHistory`, the description, and a
`note` for a class that has no value of its own — as JSON,
`form: "complete"`, `origin: "rendered"`. All of it arrives in the one Read that fetched the value
([5.2](#52-result-shape)); engineering units and the EU range are properties of their own nodes and
are not read in this version.

**A class that has no Value attribute says so, and its value is `null`.** Part 3 5.5.1 gives a
Value attribute to Variables alone, so a Read of an Object, a View, an ObjectType or a DataType
answers `BadAttributeIdInvalid` — and the document showed that code and nothing else, which reads as
a failure of Studio's. It now carries a `note` naming the class and the rule
(`Object has no Value attribute, so the BadAttributeIdInvalid below is expected, not a failed read.`)
for every class but Variable, Method and Unspecified; a Method carries the same fact inside its own
note ([3.5](#35-methods-are-listed-and-never-called)). Measured on the first page the Keys panel
draws, where `Locations` and `NetworkSet` are both childless Objects.

**The sentence is one line and under 110 characters, and that is a measurement rather than taste.**
The document is JSON in an editor that does not wrap, so the first version of this note — 205
characters, ending "what this node has is its children, listed in the Keys panel" — ran off the right
edge at about 110 and the reader never reached the half that explained the status. That tail was also
FALSE on the two nodes the rule was measured against: `Locations` and `NetworkSet` are drawn with no
twisty and list nothing under them. Both were found by looking at a screenshot of the document. Two keys were wrong beside it, and are not now: `value` was the empty STRING,
because a Bad answer still carries a DataValue whose cell text is empty, while `valueShape` said
`null` next to it; `value` is `null` where there is none, and `""` only where a Variable really
holds the empty string.

A path that names no node is refused rather than answered: `{"path":[""]}` used to come back 200
with a document for the Objects folder, because an empty segment leaves no segments and no segments
resolve to `i=85`. The route refuses an empty path array in its own words; this is the same refusal
for the path that survives it.

`rendered` rather than `stored`, because a server keeps no text for a node: this is a structured
definition Studio prints. Saying `stored` would show a reconstruction as if it were the author's own
bytes.

`accessLevel` is decoded into words (Part 3 8.57: `CurrentRead` 1, `CurrentWrite` 2, `HistoryRead` 4) rather than shown as a number, and both levels are shown because they differ in practice:
measured on the first fixture, an admin identity saw `UserAccessLevel` 3 against `AccessLevel` 1 on
`Server/Auditing`.

Two keys answer the history question, because two attributes do: `historizing` is the node's own
`Historizing` attribute as the server answered it — `null` where it answered nothing — and
`keepsHistory` is that OR'd with the `HistoryRead` bit of `AccessLevel`, which is the other way a
server says the same thing and is the one that decides whether a history read can answer. Printing
the derived value under the attribute's own name would report an attribute the server did not set,
and that is not hypothetical: this document said so while the code emitted one key, `historizing`,
holding the derived value, so a Variable whose server-reported `Historizing` is false was shown as
`historizing: true`. Found by reading this paragraph against the code it describes.

### 6.3 Object edit (#789)

**Not offered**, and the reason travels with the part:
`This provider has no code that can write to an OPC UA server.`

This is the same absence as everywhere else in this provider, stated at the one surface where a
reader would otherwise expect a Save button. A node's value is writable in the protocol — Part 4
names a `Write` service, and measured, the first fixture accepted an anonymous write with status
`Good` — so the absence here is this product's decision and not the server's restriction. It is
enforced by the client seam in [2.4](#24-the-client-and-why), not by this declaration.

### 6.4 The Keys panel

| Capability | Value | Why |
|---|---|---|
| `separator` | `/` | path keys, with `/` and `%` escaped inside a segment |
| `cursor` | `opaque` | `after:<the last key the page returned>`; `"0"` both starts a level and ends one, which is the route's own spelling, so a cursor of ours is prefixed and can never be mistaken for it |
| `pattern` | `prefix` | a path key is a literal prefix, not a glob |
| `totalScope` | `none` | a server publishes no count of its nodes |
| `levels` | `{}` | the first segment is `Objects`; no row of another kind stands for it |
| `defaultCount` / `maxCount` | 200 / 1,000 |  |

One level is one Browse, and it is never a sample: measured, a single Browse of the busiest node
under `i=85` answered its 100 children in one call. The level is addressed by re-browsing from
`i=85` along the path's own segments. `TranslateBrowsePathToNodeIds` would do it in one request —
measured at 4 ms against 5 ms for walking down at depth 4 — but it is not one of the eight services
the seam allows, and the seam's value is that the list is exhaustive. At the documented fixture's
measured depth of 7 the walk costs seven Browses and about 10 ms on loopback, once per folder
opened.

**A browse continuation point is handled and was not reachable to measure on the fixture.** OPC PLC
never paged a Browse in any of our runs — 30 consecutive browses of `i=85` handed back none, and the
widest level in its whole address space answers its 100 children in one response. That figure is the
real one, re-measured by walking the server bounded by nodes rather than by requests: 6,769 nodes
over 6,769 browses, one per node, the widest level `ReferenceTest/Scalar/Scalar_Static/Scalar_Static_Mass/Scalar_Static_Mass_Boolean`
with 100 children. This sentence used to say 37, which is the widest level a shallow walk reaches
(`Server/ServerCapabilities/AggregateFunctions`) and not the widest there is. So the following and
releasing of a browse point is covered by the unit suite's own paging server rather than by a live
measurement, and this sentence says so rather than implying otherwise.

A level follows `HierarchicalReferences` (`i=33`) **with its subtypes**, which is what reaches
6,769 nodes over 6,865 references on OPC PLC. Naming `Organizes`, `HasComponent` and `HasProperty` one by
one would miss whatever a server's own model adds.

A cursor is not a continuation point. The level contract wants a cursor valid in every process
serving the connection; a continuation point is session state, and scarce (OPC PLC allows 10 at
once, `asyncua` hands none back). Every continuation point this provider receives is consumed or
released inside the same request.

A path segment that matches nothing is a config error rather than an empty page — an empty list
would say the folder exists and is empty. **And the refusal names the reader's own spelling where it
can.** A browse name is compared exactly, so `telemetry` typed into the prefix box where the server
named `Telemetry` matches nothing; the sentence used to offer one cause only, that the address space
may have changed since the folder was opened, which is the right guess for a folder the panel opened
minutes ago and the wrong one for a typo. A name on that level differing only in case or surrounding
space is quoted instead: `No node named telemetry under OpcPlc. This level holds Telemetry, which
differs from it only in case or spacing, and a browse name is matched exactly.`

**Each row is drawn by its own segment, not by the whole path.** The panel draws a row per level,
with the ancestors above it on screen, so a key's full name repeats what the reader can already see:
measured on the fixture at the sidebar's own width, eight sibling rows under
`OpcPlc/Telemetry/Historian/HistorianInt32/HA Configuration/` all drew the same 59 leading characters
and clipped before the part that tells them apart. The full path stays the row's `title` and is what
activating it addresses. **S3 shares this rule and no other engine does**, measured over every
shipped declaration: S3 and OPC UA are the two that declare `levels`, and for S3 — whose keys are
object paths under a bucket — it reads the same way. MQTT declares a key walk and no levels, and the
glob engines are untouched by design: Redis's folders are globs a walk inferred rather than levels a
server listed, and its keys are flat names a reader addresses whole.
A key whose name ENDS in the separator keeps its full name, because its own last segment is empty.

**A folder whose own listing was refused keeps that on its row**, not only in the panel's banner:
the banner is cleared by the next folder that lists, and a refused folder left open and empty is
drawn exactly like a folder that really holds nothing. Measured in a browser by opening a folder
whose level answered an error and then another that did not.

**A type word every row on a level shares is dropped from the layout** and kept for a screen reader.
It cost 56px the name needed: measured at depth 6 on the fixture, thirteen rows all reading
`variable` left about 100px for the name and two siblings drew the same clipped text. A level that
MIXES types keeps the column, because there it is the only thing saying which row can be read, and a
level with a single row keeps it too, since one word is not a repetition.

**A row that is both a key and a folder takes the key's glyph**, for the same reason: under a level
walk its label is its own segment with the separator, exactly like a pure folder's, so the glyph was
the only difference left and it was the folder's. Measured in a browser on `Server/ServerStatus` —
the Variable that bears children, which this provider has a rule for ([6.4](#64-the-keys-panel)) —
drawn identically to the ten pure folders above it. The twisty and the trailing separator still say
it opens.

**A server publishes no "has children" flag, so the provider measures it.** Part 4's
`ReferenceDescription` carries the node id, the browse name, the display name, the node class, the
reference type and the type definition — nothing about children — and the only way to know is to
browse. So a level costs **one extra Browse round**, in chunks of 20, over the rows that could have
children (a `Method` is never asked: it is listed and never browsed). Measured, a 100-child level is
five more requests, about 10 ms on loopback, once per folder a reader opens.

Deriving it from the node class instead draws every Variable as a folder: measured on this
repository's own in-process server, `Plant/Temperature` came out a folder with nothing inside it, and
on OPC PLC `SlowUInt1` answered zero children. A folder that opens empty costs the reader a click to
learn nothing, and a leaf that really has children hides them, which is why this is the one place the
answer is paid for rather than guessed.

**What the page answers is two lists, and that is the level contract** (`KeyScanLevels` in
`src/lib/db/types.ts`): `keys`, the entries directly under the pattern, and `prefixes`, the folders
one separator deeper, each ending in the separator. The panel draws an expandable row from
`prefixes` alone, so a folder put in `keys` is a leaf the reader cannot open. The pattern the panel
sends carries the separator when a reader OPENS a folder — `OpcPlc/` — and carries none when a
reader types in the filter box: `OpcPlc` then names the level above and keeps the entries whose keys
begin with it, which is what `sentPattern` sends and what the route checks the answer against. Both
are measured: a pattern read as a level rather than as a filter answered keys with a separator after
the pattern, and the route refused the page with HTTP 500 naming this provider.

Entries are sorted by UTF-8 byte order, not JavaScript's UTF-16 order, and the cursor names the last
KEY the page returned, so the next page starts at the first key after it in that order — after the
name, not at the position following it, so a node deleted between two pages neither restarts the
level nor repeats a row. A cursor is bound to its level and refused with a sentence when it belongs
to another or was not written here; `"0"` ends a level, because `use-key-scan.ts` reads that and
nothing else as the end of a walk.

**The folder flag is measured for the PAGE and not for the level**, which is the difference between
a bounded cost and one that grows with the server: measured on a level 10,000 children wide, asking
about every child cost 501 Browse requests to answer one page of 200 rows and the whole 501 again on
the next page. A page of 200 is 10 requests at 20 nodes each whatever the level holds.

**Two children of one browse name are one row.** Part 3 does not make a browse name unique among a
node's children, and both produce one path key, which the contract allows only once; the row that
survives is the one that is not a Method, so it can still be opened. The node ids differ, which is
the cost of naming a node by its path.

**A request without `level` is refused**, with the sentence that an address space is browsed one
level at a time. A walk of the whole key space would need a cursor over a graph that no server
publishes, and answering one level while calling it a walk would be a sample presented as a listing.
The panel asks a levels-declaring provider for a level every time, so nothing in the product meets
that refusal.

## 7. Monitoring & health

A server publishes almost none of what these panels ask for, and **absence and zero are different
facts** — so what cannot be read is refused or named, and nothing is filled in with 0:

| Surface | Answer |
|---|---|
| `getOverview()` | the product name with its software version, and the uptime, both read from `Server/ServerStatus` ([below](#71-what-the-overview-card-really-reads)); size `"unknown"`; `tableCount` and `indexCount` **0**, because the shape takes a number and a server has neither |
| `getHealth()` | size and cache ratio `"unknown"`, no sessions, no slow queries |
| `getStorageStats()` / `getTableStats()` / `getIndexStats()` | **refused**, with this provider's own sentence ([below](#72-a-panel-that-cannot-be-read-refuses-rather-than-reporting-zero)) |
| `getSlowQueries()` | `[]`, and `getLabels().slowQueriesEmptyState` says why in the panel |
| `getActiveSessions()` | `[]`, and `getLabels().sessionsEmptyState` says why in the panel |
| `getPerformanceMetrics()` | `{}` |

`CurrentSessionCount` (`i=2277`) is a number, not a session list, and it is not portable either:
OPC PLC and open62541 answer it, `asyncua` answers `Good` with an empty Variant, and Milo answers
`BadNotReadable (0x803A0000)` even to an authenticated session. Where it cannot be read it is
reported as unavailable, never as zero.

### 7.1 What the Overview card really reads

This card said `unknown` for the version and the uptime, and a browser pass found both sitting in the
server's own `ServerStatus` (`i=2256`), which Part 5 makes mandatory. One Read of it answers, measured
on the documented fixture:

```
productName     IoT Edge OPC UA PLC
softwareVersion 2.15.10 (OPC UA SDK 1.5.378.176)
startTime       2026-10-12T15:28:49.204Z
currentTime     2026-10-12T19:06:57.320Z
state           Running
```

so the card now reads `IoT Edge OPC UA PLC 2.15.10 (OPC UA SDK 1.5.378.176)` and an uptime of
`currentTime - startTime` — **the server's own two instants**, because a client whose clock is wrong
is the normal case on a plant floor and must not turn a running server into one that started in the
future. A field the structure does not carry is left out rather than guessed, a server that refuses
the node falls back to `unknown`, and a server whose two instants contradict each other reports no
uptime rather than a negative one ([`overview.ts`](../../src/lib/db/providers/industrial/opcua/overview.ts)).

### 7.2 A panel that cannot be read refuses rather than reporting zero

`[]` from these three reads is drawn as a MEASUREMENT: the Tables panel reported "0 tables, 0 rows,
0 B" and "No tables found." against a server whose own tree lists nine root folders, and the Storage
card summed that nothing into `0 B`. Found by opening the dashboard in a browser — every unit test
passed, because each was right that the list is empty.

They now reject with one sentence, `An OPC UA server holds an address space of nodes rather than
tables, and publishes no table, index or size statistics: there is nothing here to measure. The nodes
themselves are in the Keys panel.` `base-provider.ts` settles each panel separately and records a
rejected one under `errors[panel]`, which the dashboard draws in the engine's own words.

**The two CORE panels keep their empty arrays**, because four rejections are read as a dead
connection: slow queries and sessions say why through `getLabels()` instead, the member ten other
providers use for exactly this. Their defaults are written for a SQL server, and that is not a
theoretical mismatch — the Queries panel told an OPC UA reader to install `pg_stat_statements`, a
PostgreSQL extension, and the Sessions panel said "No active sessions found." against a server that
was holding this very session.

## 8. Maintenance

`supportsMaintenance: false`, `maintenanceOperations: []`. `runMaintenance` refuses:

> Maintenance would be a write, and this provider has no code that can write to a server: its
> client exposes eight read services and nothing else.

The Analyze and Vacuum controls are labelled `Not available` with that reason in the dialog, rather
than drawn disabled with no explanation.

## 9. Capabilities & labels

| Declaration | Value |
|---|---|
| `enforcesReadOnly` | true, structurally |
| `queryLanguage` / `queryDialect` | `json` / `opcua` |
| `defaultPort` | 4840 |
| `supportsResultPagination` | false |
| `createTable` | absent |
| `supportsTransactions`, `declaresForeignKeys`, `supportsInlineRowEdit`, `supportsTestDataGeneration`, `supportsExplain` | false |
| `supportsExternalQueryLimiting` | false |
| `supportsConnectionString` | false |
| `schemaRefreshPattern` | `(?!)` |
| `statementTerminator` | `none` |
| `tablesAreDerivedGroupings` | false |

`schemaRefreshPattern` is `(?!)` rather than an empty string: the base class's SQL pattern, compiled
case-insensitively, would match a read of a node named `drop` and reload the tree for it.

Labels: entity **Node**/**Nodes**, row **Value**/**Values**, select action **Read**. Generate,
analyze and vacuum read `Not available`, each with its reason.

### SQL writing

[`opcua/sql-writing.ts`](../../src/lib/db/providers/industrial/opcua/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
No measurement stands behind this row; it uses the standard building blocks named above.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).

## 10. Error handling

A status code becomes a sentence a reader can act on, and the code always travels with it. The table
is written from four servers because the same failure is reported four ways — a wrong password is
`BadUserAccessDenied` on three stacks and `BadIdentityTokenInvalid` on Milo. A code the table does
not know travels as itself rather than as a guess: `The server answered <code>.`

Codes about what the reader **typed** raise `DatabaseConfigError`, so the remedy is shown where the
remedy lives: `BadUserAccessDenied`, `BadIdentityTokenInvalid`, `BadIdentityTokenRejected`,
`BadCertificateUntrusted`, `BadSecurityChecksFailed`, `BadSecurityModeRejected`,
`BadSecurityPolicyRejected`, `BadNodeIdUnknown`, `BadNodeIdInvalid`. Everything else is a
`QueryError`.

**Only the message of a library error ever leaves this provider.** That is a security rule, not
tidiness: measured, `node-opcua-client` throws an `Error` carrying `request` and `response`, so
`JSON.stringify(error)` emits the `ActivateSessionRequest` including `userName`. The message itself
is clean, and `messageOf()` is the only way out.

**Every library call on the way to a session is translated, GetEndpoints included.** It was the one
that was not, and it is the one that meets a dead server: measured through the query route against a
closed port, the reader was answered HTTP 500 `INTERNAL_ERROR` with three lines of the library's own
prose, newlines inside the JSON error field, and `Err = (connect ECONNREFUSED 127.0.0.1:54999)`. A
500 reads as "Studio broke"; a wrong host or port is a 400 that names the address. The refusal now
reads `This connection could not be opened to opc.tcp://…: <the library's reason>`, on one line,
with the remedy added only where the library gave none.

**A username where the server takes none is this provider's sentence, not the library's.** The
dialog draws Username and Password for every OPC UA connection and plenty of servers — the fixture
among them — offer Anonymous only. Measured before the check existed: `Cannot find USERNAME user
token policy in end point description`, node-opcua's internal string, grammar mistake included. The
endpoint's token list is already in hand when the session is opened, so the refusal names what the
server does accept and what to do: _This server takes no username on its None endpoint: it accepts
Anonymous, Certificate. Clear the username and password to connect anonymously…_

**A session the server has forgotten is replaced once, and that is what the error text promises.**
`BadSessionIdInvalid`'s sentence says "reading again opens a new one"; measured before it could,
three reads in a row answered the same code, `isConnected()` kept saying true, and the connection
was unusable until Studio restarted. `OpcuaSessionPool.withSession` now drops the dead session and
runs the read once more on a fresh one — safe because every operation here is a read — and a second
stale answer is reported rather than retried. `BadSessionClosed`, `BadServerNotConnected` and
`BadConnectionClosed` count as the same fact; `BadTimeout` does not, because a server that was slow
once is still the same session.

**A closed connection is a typed refusal, and a provider can be connected again.** Pressing a key
after Disconnect used to answer HTTP 500 `INTERNAL_ERROR`; it is now a 400 that says to connect
again — and connecting again works, which it did not: the pool latches closed on purpose, so
`connect()` builds a new one rather than refusing for ever with a sentence naming the one call it
had just made impossible.

## 11. Testing

### 11.1 The unit suite

[`tests/unit/db/opcua/`](../../tests/unit/db/opcua/) — 377 tests across 18 files: one per module
with its own rules, plus the seam guard, the provider class, the library bridge and the hostname
guard. `capabilities.ts`, `client.ts`, `constants.ts` and `labels.ts` have no file of their own;
what they declare is asserted where it is read. Every test was mutation-verified as it was written: a
deliberate break in the code it covers makes it fail. 48 mutations caught while they were written,
and 113 more run against the finished suite by an independent review: 101 caught, 12 survivors, each
one now covered (see below).

The seam guard is the load-bearing one: it asserts the eight-member client interface and that no
module in the directory except `library.ts` imports `node-opcua-client` — `library.ts` is the one
module that may, which is what section 2.2 and the directory's own README say, and this line read
`session.ts` until a review compared the three.

A second round of review mutated 113 lines one at a time and 12 survived, every one of them a test
that could not fail rather than a defect: the middle row of a three-valued security decision with no
case at all, a history fake that ignored the `startTime` it was there to test, a field compared
against the constant that built it. Each is now covered by a test that fails when the line changes,
and the two findings underneath them — a level that never reported itself finished, and a pin
dropped on the seeded path — are in sections 6.4 and 4.1.

### 11.2 The integration suite

[`tests/integration/db/opcua-provider.test.ts`](../../tests/integration/db/opcua-provider.test.ts) —
22 tests over a **recorded server**. Every answer replayed there was captured from OPC PLC 2.15.10,
pinned by digest, by [`tests/live/opcua-evidence.ts`](../../tests/live/opcua-evidence.ts), which
drives this provider's own library bridge against it;
[`tests/fixtures/opcua/README.md`](../../tests/fixtures/opcua/README.md) lists each file and the
command that wrote it. The replay opens no socket, so it needs no plant in CI, and everything above
the socket runs: the connection's refusals, the session pool, the seam, the request parser, the
chunking, the level walk, the Source document, the history paging and the error table.

Two of those captures are the measurements the provider is built around: an anonymous session was
told `accessLevel: 3` — read **and write** — and a continuation whose window differs from the read
that handed out the point answers `BadContinuationPointInvalid`.

### 11.3 The in-process server, and the dialog

[`tests/integration/db/opcua-server.test.ts`](../../tests/integration/db/opcua-server.test.ts) — 19
tests against a **real server in this process**: `node-opcua-server` 2.187.16, a devDependency, is
started on a loopback port in `beforeAll` with a two-node address space of its own. It needs no
container, and it is where the library really runs: GetEndpoints, the secure channel, CreateSession,
the encoder and the status codes are all the library's. It adds a third stack to the
operational-limits measurement, publishing **0** for both continuation-point counts.

[`tests/components/ConnectionModal-opcua.test.tsx`](../../tests/components/ConnectionModal-opcua.test.tsx)
— 9 tests that render the real dialog. They read each hint from the declaration it is drawn from
rather than repeating the sentence here, and then hold it to what it has to say: searching the DOM
for whatever the declaration happens to hold proves the text was rendered and nothing about the
text, so each hint is also asserted to name the three modes and the refusal, or the thumbprint's
hash and length, and each control to POINT at its hint with `aria-describedby`. The security mode is
a button group, which has no `aria-describedby` to inherit, and it had none until this test asked.
They exist because a declared field is not a drawn one:
`securityMode` and `serverCertificateThumbprint` were declared, labelled and hinted while the dialog
drew neither, and only a render could see that.
[`e2e/opcua-provider.spec.ts`](../../e2e/opcua-provider.spec.ts) is the same ground in a browser.

[`e2e/opcua-screens.spec.ts`](../../e2e/opcua-screens.spec.ts) is the other half, and it is the one
that earns its keep: it connects to the real fixture through the dialog, walks the address space,
opens a node, reads a value and reads history, and writes a screenshot at every step for a person to
look at. It is skipped when the fixture is not listening, so CI never fails on it. Three defects
came out of looking at those pictures, each invisible to every other suite: the engine could not be
connected at all in a default install (the PKI root had no default), connecting greeted the reader
with a red "Schema Error" toast, and the first screen was an empty Objects tab instead of the Keys
panel. A fourth was a test of mine, caught the same way — the walkthrough had been typing its read
request into the Source tab's read-only editor and measuring the document it could not edit.

**Every step of it is required, and that was a fifth defect of the same kind.** The steps were
written as `if (await locator.count() > 0)`, and the tabs are `role="tab"` rather than buttons, so
the step that presses Objects and Keys matched nothing, skipped itself and reported a pass — for the
one thing the spec exists to show. A walkthrough whose steps are optional certifies a product it
never touched, so each step now asserts: the Keys tab is selected by default, the Objects tab says
where the nodes are, a node opens with its class, an Object node says it has
no value of its own, a read answers a status, and a capped history read says it was capped.

**And fifteen pictures were not enough.** Driving the surfaces this walkthrough never opens — the
monitoring tabs, the two secured modes, the Keys panel's own controls, the console's refusals, the
life of a connection after it is made, and the dialog before anything is typed — took 437 more
screenshots and found defects that no suite could see, because none of them is about an answer being
wrong. Four were in SHARED code and are fixed here rather than recorded, each with its measurement:

| What a reader met | Measured | Now |
|---|---|---|
| Test Connection looked like it did nothing | the answer is the last child of the dialog's scrolling body while the buttons are pinned: 24 of its 163 px on screen, no character legible, at every window size and in both themes, on OPC UA, Redis and MQTT alike | the panel scrolls itself into view when the answer arrives |
| A refused query drew its sentence at 1.98:1 | `--destructive` is `#7f1d1d` in the dark theme, a SURFACE red used as text; `--studio-danger` is the foreground red the rest of the product uses, 6.85:1 on the same ground | the failure block and the script-failure banner both read `danger` |
| Pivot's Generate SQL replaced a JSON request with SQL | this engine declares `queryLanguage: "json"`, and the generated `SELECT` cannot be parsed by it; the editor's contents were gone, with the undo stack the only way back | the control is withheld where the engine does not read SQL |
| A screen reader was told nothing about which engine is chosen | the chosen card is a tint and a glow, with no `aria-pressed`, while the security-mode buttons three fields below already answer | `aria-pressed` on every engine card |

Three more belong to the product rather than to this provider and are recorded instead: `U127` (a
connection cannot be edited on a phone), `U128` (the grid truncates the identifying column while free
width sits beside it) and `U129` (the Docs tab reports "0 tables" on an engine that has none).

### 11.4 The live check

[`tests/live/opcua-live-check.ts`](../../tests/live/opcua-live-check.ts) — 12 checks that ask what
only a server can answer: whether a run leaves a session behind, whether history really pages,
whether a wrong pin refuses before `CreateSession`, whether a level ever reports itself finished and
pages without repeating a row, whether a Variable that bears children is answered as a key AND a
folder (no capture has such a node), whether a closed port and a username the server does not take
come back as this provider's own sentences rather than the library's, and whether a PKI root that
cannot be WRITTEN names the directory and the variable instead of blaming the endpoint — that last
one only a real certificate manager can answer, because it creates its directories lazily, and it
reports itself unmeasurable rather than passing when the process can write the directory anyway. It is not part of `bun run test`; the runner excludes `tests/live/`.

```bash
bun tests/live/opcua-live-check.ts
```

Measured against the pinned fixture, all twelve: `CurrentSessionCount` **one higher** while a run
holds its session and back to what it was afterwards — a delta rather than an absolute, because the
count is the server's and anything else connected to it counts too; every session a run opened
closed; a history read paging by continuation point and ending on its own; a capped history read
exact at every cap it derives from what the node holds when it runs — the node grows, so caps
written here would measure the clock — each ending `value-cap`; a node that keeps no history and a
node that does not exist told apart by their own codes; the wrong pin refused with the session count
unchanged; 7 endpoints over 3 modes and 4 policies, advertising a container hostname that resolves
nowhere outside Docker; a policy the server does not offer refused; a `SignAndEncrypt` dial reaching
the server's own endpoint for it and refused only by the trust list; the Keys panel's own request
answering folders as prefixes with no entry repeated between pages; a Variable that bears children
answered as a key AND a folder; a dead endpoint and a username the server does not take answered in
this provider's own sentences; and a PKI root that cannot be written naming the directory and the
variable rather than the endpoint.

### 11.5 Run it

```bash
bun tests/run-tests.ts tests/unit/db/opcua tests/integration/db/opcua-provider.test.ts \
  tests/integration/db/opcua-server.test.ts tests/components/ConnectionModal-opcua.test.tsx
```

`node` must be on `PATH`; the runner shells out to it.

### 11.6 The fixtures

The four servers in [1](#the-four-servers-every-measurement-names). OPC PLC is pinned by digest
because its `:latest` moved during the measurements, and `--hn` is what adds the one historized
node. Every figure quoted in this document and in `constants.ts` was taken from one of them and
names which.

**The flags are part of the fixture**, which a review proved by walking the server: OPC PLC's
address space depends on them, so a figure is reproducible only against the command
[`tests/fixtures/opcua/README.md`](../../tests/fixtures/opcua/README.md) states. Started that way it
holds 6,769 nodes and eight namespaces; with one more flag, `--alm`, it holds 8,753 and nine. Every
address-space figure in this document was re-measured on 12 Oct 2026 against the documented command,
and the ones that disagreed with it were replaced ([3.3](#33-more-rows-than-nodes-is-correct)).

## 12. Known limitations

1. **No subscriptions.** `CreateSubscription` and `CreateMonitoredItems` are outside the seam, so
   there is no live value feed; a read is a read.
2. **No method calls**, by decision ([3.5](#35-methods-are-listed-and-never-called)).
3. **No writes**, by construction ([2.4](#24-the-client-and-why)).
4. **Raw history only.** No modified history, no aggregates, no `ReadProcessedDetails`.
5. **`UserName` and anonymous identities only.** No certificate or issued-token identity.
6. **`opc.tcp` only.** No WebSocket and no HTTPS transport.
7. **A history read of a node that keeps no history** is reported three ways by three servers; the
   node's `Historizing` attribute is read instead of the failure being interpreted.
8. **`LIBREDB_OPCUA_PKI_ROOT` overrides a default rather than being required.** The default is
   `<data directory>/opcua-pki`; the LIBRARY's own default is still never used, deliberately
   ([4.4](#44-the-pki-directory)).
9. **No whole-tree walk from the UI.** The walk exists, bounded, and nothing in the interface calls
   it ([5.5](#55-the-bounded-walk)).
10. **A node id saved with `ns=` may address a different node later.** A namespace index is a
    position in the server's table, supplied per session; this provider sends what the reader typed
    and rewrites nothing, so a request kept in query history and run after a server restart can
    read another node. Re-measured, and this is the measurement that shows it: the documented
    fixture publishes eight namespaces, and a second container from the same digest with the same
    flags publishes the same eight in the same order - except entry 1, `urn:OpcPlc:<hostname>`,
    which names that container and no other. Add one start-up flag and the indices move: with
    `--alm` the array is nine entries, `AlarmsInstance` is inserted at index 6, and `ReferenceTest`
    and `Diagnostics` shift from 6 and 7 to 7 and 8 - so a saved `ns=6;s=...` addresses a different
    namespace on the same software with one flag changed. Typing the `nsu=` form avoids it.
11. **A port that accepts TCP but does not speak OPC UA holds the request for about a minute.**
    Measured against a socket that accepts the connection and never answers a HEL: **60 s**, then
    the typed refusal, carrying the library's own `Timeout(A) in waiting for...`. A closed port is
    immediate (ECONNREFUSED); it is the half-open case that waits, and nothing here shortens it,
    because a slow plant server and a wrong port look identical until one of them answers.
12. **A secured connection needs the server's certificate in the trust list**, pinned or not
    ([4.5](#45-the-certificate-pin)). This is the OPC UA certificate exchange rather than a
    limitation of this provider, and the refusal names it; but a reader who expects a dialog-only
    `SignAndEncrypt` connection meets `BadCertificateUntrusted` first.
13. **No whole-space key walk**: `scanKeysPage` answers a level and refuses a request without
    `level` ([6.4](#64-the-keys-panel)).
14. **The library resolves this host's name at import time, and that can throw.**
    `node-opcua-hostname` calls `prepareFQDN()` at module scope without awaiting it, and inside it
    `dns.lookupService` is called with whatever `dns.lookup(os.hostname())` answered. An address with
    a zone index makes `lookupService` **throw** rather than call back, inside a callback where the
    library's own try/catch cannot see it — and Node's default for an uncaught exception is to exit.
    Measured on the development host: Node 24.14.0 answered `::1` and nothing happened; Bun 1.4.2
    answered `fe80::18aa:2794:76e0:ef24%15` and the error arrived uncaught. Two things follow, both
    in this provider: `hostname-guard.ts` turns that throw into the error callback the library
    already handles (it falls back to `os.hostname()`), and the factory imports the library when a
    session is opened rather than when a provider is built, so nothing that merely constructs a
    connection loads it.

## Migration DDL

[`OPCUA_MIGRATION_DDL`](../../src/lib/db/providers/industrial/opcua/migration-ddl.ts) is what the schema-diff migration generator writes for `opcua`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
A node's attributes are defined by its type in the server's own model, and this provider has no code that writes to a server (#1677).

The refusal reason it prints, verbatim:

- "An OPC UA node has attributes defined by its type in the server's own model, not columns, and this provider has no code that can write to a server, so there is no column definition to change."

## 13. References

- OPC 10000-3 (Part 3), Address Space Model — node classes, `AccessLevel` (8.57), `ValueRank`
  (5.6.2), the Objects folder (5.5.3)
- OPC 10000-4 (Part 4), Services — trust rules (6.1.3), status codes (7.38), `UserTokenPolicy`
  (7.41)
- OPC 10000-5 (Part 5), Information Model — operational limits (6.3.11)
- OPC 10000-6 (Part 6), Mappings — node id string form (5.1.12)
- OPC 10000-11 (Part 11), Historical Access — `ReadRawModifiedDetails` (6.5.3)
- [`node-opcua`](https://github.com/node-opcua/node-opcua) 2.187.16
- Issue [#1677](https://github.com/libredb/libredb-studio/issues/1677)
