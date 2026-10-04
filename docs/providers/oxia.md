# Oxia Provider

The `oxia` type-id: read-only browsing, key lookups, lists and range scans over Oxia's gRPC client API, tested against Oxia 0.16.10 and 0.17.1.
Source: [`src/lib/db/providers/keyvalue/oxia/`](../../src/lib/db/providers/keyvalue/oxia/).
Tests: [`tests/unit/db/oxia/`](../../tests/unit/db/oxia/) and [`tests/integration/db/oxia-provider.test.ts`](../../tests/integration/db/oxia-provider.test.ts).
Tracking issue: [#424](https://github.com/libredb/libredb-studio/issues/424).

## Before you connect

Six facts decide whether the first connection works.

1. Where Studio runs decides what to type in Host:

| Where Oxia and Studio run | Host | Data servers |
|---|---|---|
| `oxia standalone` on this machine, Studio on this machine | `localhost` | empty |
| `oxia standalone` on this machine, Studio in Docker | `host.docker.internal`; on Linux, start Studio's container with `--add-host=host.docker.internal:host-gateway` | empty |
| An Oxia cluster | the cluster's bootstrap service, with Studio running inside the cluster | every data server's public address |

2. A port-forward or an SSH tunnel reaches a standalone server, never a cluster's leaders: a cluster sends clients to the addresses its data servers advertise, which the forward does not carry (section 4.4 gives the workaround, section 4.5 the tunnel rule).
3. Namespace: empty means `default`, names are case sensitive, and `oxia standalone` has only `default`.
4. Token: an OIDC JWT, which expires; a standalone server takes no token at all; and a token grants read and write on every namespace, because Oxia has no authorization.
5. TLS: the server certificate must name every leader host the cluster advertises, as well as the host you type.
6. What this version does not do: write, watch notifications or open sessions; and the Keys panel discovers folders on its first page only, within the bounds of section 6.4.

## 1. Overview

Studio reads an Oxia namespace through a gRPC client of its own, shows its shards in the object tree and every key in the Keys panel, and runs one `oxia client` read command per run in the editor.
It reads only, whatever the connection's Read-only toggle says: no call Studio can make writes, opens a session or watches notifications.
Each key opens in a Source tab with its value and its version metadata.

### Concept mapping

| Oxia | Studio |
|---|---|
| A namespace | A connection property, Namespace; one namespace per connection |
| A shard | The object kind `shard`, listed under Shards, with its hash range and leader in its Source tab |
| A key | The object kind `key`, enumerated by the Keys panel and opened in the Source tab |
| A value | The `value` cell of a result and the Value part of the Source tab |
| Version metadata | The version columns of a result and the Metadata part of the Source tab |
| A session and an ephemeral record | A badge on the Metadata part: ephemeral, deleted when its session ends |
| A secondary index | `--index` on `get`, `list` and `range-scan` |
| A partition key | `-p` on `get`, `list` and `range-scan` |

## 2. Architecture

The provider is the first gRPC member of the `keyvalue` family, composed over a narrow client seam so that every module above the wire is tested without a server.

### 2.1 Where it sits

`OxiaProvider` extends `BaseDatabaseProvider`, and every module talks to Oxia only through the `OxiaClient` interface of `client.ts`.
`grpc-client.ts` is the one provider file that imports `@grpc/proto-loader` and the generated descriptor, and it reaches `@grpc/grpc-js` only through PR A's shared transport in `src/lib/db/grpc/`, the only importer of grpc-js in the repository.
Its stub is structural: it is built from the descriptor filtered to an allowlist, `GetShardAssignments`, `Read`, `List`, `RangeScan` and `Health/Check`, so no write, session, notification or watch method exists in it.
The console's modules are pure and shipped to the browser, because the editor, the confirmation gate and the generators read them; everything else runs on the server.

### 2.2 Modules

| File | What it owns | Runs on |
|---|---|---|
| `client.ts` | The seam: `OxiaClient`, its wire-mirroring types, the allowlisted RPC names and the walk answer types | server |
| `constants.ts` | Every number and fixed name of the provider | browser |
| `connection-options.ts` | The connection to options, every field refusal, the dial policy over the leaders a shard map names, the TLS identity | server |
| `errors.ts` | The one error table, in the adapter's half and the provider's half, and every sentence other modules quote | server |
| `grpc-client.ts` | The allowlisted stub over the shared transport, one channel per admitted address, the bearer token, the deadlines, the per-stream limits and `cancel()` | server |
| `proto/descriptor.ts` | The descriptor generated from the vendored `client.proto` and `health.proto` | server |
| `routing.ts` | The shard map's validation and the XXH3 router that names a key's shard | server |
| `order.ts` | The two key orders, their encoders, the order probe's decisions and the range arithmetic of each order | browser |
| `merge.ts` | The merge of shard answers under the merge bound, and the comparison get's winner | server |
| `cursor.ts` | The Keys panel's cursor and its two refusals | browser |
| `walks.ts` | Every sequence of calls: the order probe, the Keys panel pages, folder discovery, the console's walks and the limited client | server |
| `lexer.ts` | The console's tokens and shell words | browser |
| `commands.ts` | The command table, the parser and every refusal sentence of a command | browser |
| `guard.ts` | The confirmation gate's reading of a command: no destructive operation | browser |
| `values.ts` | A value's encoding, the hex forms, shown keys and timestamps | server |
| `results.ts` | The result grid's columns, cells and notices | server |
| `execute.ts` | One command's run over the walks | server |
| `objects.ts` | The object surface: the `shard` and `key` kinds and their Source tabs | server |
| `key-scan.ts` | The Keys panel's pages | server |
| `monitoring-reads.ts` | Health and the overview | server |
| `labels.ts` | The labels, the statement language and the key order in words | browser |
| `generators.ts` | The commands Generate Command writes | browser |
| `index.ts` | The composition root: the session, the declarations, the snapshot cache, the order verdict's lifetime, the run registry and the one failure path | server |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` builds the options, refusing every bad field before any socket, then the client, then reads the shard map once, which runs the dial policy over every leader it names; it runs no order probe.
Test Connection is `connect()`, so a cluster whose leaders cannot be dialled fails there, not on the first click.
`disconnect()` ends every run and closes every channel.
The shard map is cached briefly and read again when a call reports that a shard moved, and the key order is probed on the first walk and kept for the provider's life, except an `assumed` or `empty` verdict, which is probed again on every walk (section 3.2).

### 2.4 The client, and why

The client is this repository's own, on `@grpc/grpc-js` and `@grpc/proto-loader` through the shared gRPC transport of `src/lib/db/grpc/`, which the etcd and Milvus providers use too, so the provider adds no package.
The vendor client `@oxia-db/client` was set aside: it takes no TLS material, takes no `AbortSignal`, so a cancelled run cannot stop its streams, and it ships a native addon.
The wire definitions are Oxia's `client.proto` at the tag `v0.16.10` (commit `c72b0bfce3fa0058fe200462b64f0d502dd56b02`), vendored under `proto/` with its licence, its NOTICE and the SHA-256 `9daaa46ad75c7066d43ae48190825daef62846351ff9800f26383202a71fd979`.
`proto/descriptor.ts` is generated from it by `node scripts/generate-oxia-descriptor.mjs` and is never edited by hand; `proto/README.md` records every vendored file's digest, and the descriptor test holds them.
No data call is ever retried, so no read is sent twice and no failure is hidden behind a second attempt.

## 3. Design decisions

Each decision below is the reason a behaviour of the provider is what it is.

### 3.1 Read-only v1

Studio's Oxia support reads only in this version.
An Oxia server has no authorization: any client it accepts may write any key of any namespace, and the usual tenant is Apache Pulsar, whose control plane keeps its metadata there.
A write from Studio would change a Pulsar cluster's metadata with no undo and no protected prefix, so writes wait for a design of their own (section 13).

### 3.2 Key order probed, not configured

An Oxia namespace sorts its keys in one of two orders, hierarchical or natural, and no released server reports which, so Studio probes it and keeps the verdict.
Every walk, merge and range depends on the verdict, so a wrong one would hide keys.
The order is learned in one of five ways, each the `learnedBy` of the verdict: `ceiling-probe`, `decisive-list` and `pair-sample` decide it from the keys read, `assumed` means the keys read could not tell the orders apart, and `empty` means the namespace held no key.
The shard Source tab says how, in these words:

- `hierarchical, detected from key order` or `natural, detected from key order`, for the three ways that decide it;
- `hierarchical: no key holds /`, when every shard ended with no key holding `/`, where both orders sort keys alike;
- `hierarchical, assumed: Studio could not tell the orders apart from the keys read`, when the probe's byte cap ended the reading first;
- `empty namespace`.

An `assumed` or `empty` verdict is probed again on the next walk, so it gives way to a detected one as soon as keys allow.

### 3.3 The dial policy

A cluster's shard map names a leader address for each shard, and Studio sends the token to every leader it dials, so it dials only an address the connection names.
A leader is dialled when it is byte for byte the authority Studio sent to the endpoint, or when it is listed under Data servers; every other leader refuses the connection with one of these sentences, as `admitLeaders` words them:

- through a port-forward or tunnel: `This connection reaches Oxia through a port-forward or tunnel at <sentAuthority>, but the cluster sends clients to <leader> for its shards, which this machine cannot be assumed to reach. Run Studio where <leader> resolves and is reachable; the Oxia provider doc shows the hosts-file and per-pod port-forward workaround.`
- a server that calls itself by another name on the same port: `This server calls itself <leader>: type <leader host> in Host, or add <leader> to Data servers.`
- leaders the connection does not list: `The cluster sends clients to data servers this connection does not list: <a>, <b>. Studio dials only the endpoint and the addresses under Data servers, and sends the token to no other. To allow them, list under Data servers these addresses and every other data server of the cluster: <a>, <b>`
- more leaders than Data servers can hold: `The cluster sends clients to <n> data servers this connection does not list, more than the 64 that Data servers can hold, so Studio cannot reach this namespace's shards and nothing was read.`

In the unlisted-leaders sentence the clause "and every other data server of the cluster" precedes the list, and the list of every refused address, at most 64 of them, ends the sentence, ready to paste into Data servers, with nothing after it.
More than 64 distinct refused leaders refuse the connection outright with the last sentence, since Data servers could not hold them.
This policy is [row 3.14](../SECURITY.md) of the security page.

### 3.4 Internal keys

Oxia keeps its own internal records, secondary index entries among them, under the prefix `__oxia/`, and Studio reads none of them.
The parser refuses a key, a bound or a prefix under it before any call:

> Keys under __oxia/ are Oxia's own bookkeeping, which Studio never reads.

The adapter refuses it again at the seam, so no surface reaches it by another path:

> Keys under __oxia/ are Oxia's own internal records, which Studio does not read.

The client can call only the four read methods and the health check, and never asks for internal keys: [row 3.15](../SECURITY.md) of the security page.

### 3.5 The read-only mode

The Read-only toggle, a seed's `readOnly` and an agent execution profile all set the mode, and the provider enforces it whatever its source, because it sends no write at all.
A write command names the mode only while the mode holds:

> put writes, and this connection is read-only. Studio's Oxia support also reads only in this version, so turning the mode off would not run it: write with the oxia CLI.

and otherwise:

> put writes, and Studio's Oxia support reads only in this version: write with the oxia CLI.

The connection dialog says the same under the Read-only toggle:

> Oxia connections are read-only in this version, whether or not this is ticked: Studio sends Oxia no write.

A read-only seed of one standalone server on this machine, managed, with no token and no Data servers, is `tests/fixtures/seed-connections/oxia-read-only-config.yaml`.

### 3.6 Machine access

No agent execution and no MCP: the provider implements no read-only query path, and an Oxia connection is not exposed to MCP clients, because Oxia key paths name Pulsar tenants, namespaces and topics ([B100](../BACKLOG.md#b100-oxia-has-no-agent-execution-and-no-mcp-surface)).
Plan mode drafts one read command that a person runs, in the grammar of section 5.
The agent's grounding carries shard rows only, never a key name, a value, version metadata or a leader address, because the `key` kind is enumerated by the Keys panel and no listing of every kind reads it.
The confirmation gate posts nothing to the query-safety analysis for an Oxia command.

### 3.7 Lossless integers

Every 64-bit integer Oxia sends, `version_id`, `modifications_count`, `session_id` and the shard ids, is shown as its exact decimal string, never through a JavaScript number.
`version_id` is counted per shard, so two keys on different shards may carry the same version.

## 4. Connection

A connection names one endpoint, one namespace and, for a cluster, the data servers Studio may dial.

### 4.1 Configuration fields

| Field | Meaning |
|---|---|
| Host | A name or address only. For Pulsar's oxia://host:6648/ns, type host here, 6648 in Port and ns in Namespace. If Studio runs in a container, localhost is that container: use host.docker.internal. |
| Port | The data server's public port: 6648, the CLI's default, unless the server was started with another |
| Token | An OIDC token, sent as a bearer token on every call; empty for a server without authentication. A token grants read and write on every namespace: Oxia has no authorization. A token needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. |
| Namespace | Empty means default, the only namespace of oxia standalone. Names are case sensitive, and a cluster's namespaces are in its coordinator configuration. |
| Data servers | Only for a cluster that advertises other addresses: every data server's public address (servers[].public in the coordinator configuration) as host:port, separated by commas or spaces, at most 64. List every server, not only today's leaders. Patterns are not accepted, because the token would follow any address a pattern matches. Leave empty for oxia standalone. |
| Send the password without TLS | Oxia receives the token on every call, so with no SSL mode it crosses the network in cleartext, to the host and to every data server; the connection is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one. |
| SSL / TLS | The mode, the CA, and the client certificate and key, for the endpoint and every data server alike |
| SSH Tunnel | A bastion that forwards the one endpoint, for a standalone server (section 4.5) |
| Read-only | The mode of section 3.5 |

The Host, Token, Namespace, Data servers and consent rows are the hints the connection dialog shows under each field.
There is no User field: Oxia has no user name, and a connection that carries one is refused.
A Namespace is refused before any call when it is not short text:

> The Namespace must be at most 300 bytes of text with no control characters; empty means default. Nothing was sent.

### 4.2 Authentication

The token is sent as `authorization: Bearer <token>` on every call, health included.
It is checked for the characters a bearer token can carry before anything is sent:

> The Token holds a character a bearer token cannot carry: only letters, digits and . _ ~ + / = - are allowed, with no space, tab or line break. Paste the token again; nothing was sent.

When the server refuses the token, Studio reads only the start of the server's reason against a closed list and words each cause itself, so no server text is shown:

| Cause | Sentence |
|---|---|
| No token sent | This Oxia server requires a token: paste one under Token. |
| Not a JWT | Oxia could not read the Token as a JWT: paste the whole token under Token. |
| Unknown issuer | Oxia does not trust the issuer of the Token: use a token from an issuer this server is configured for. |
| Wrong audience | The Token was issued for an audience this Oxia server does not accept: use a token issued for this server. |
| Bad signature | Oxia could not verify the Token's signature: use a token signed by a key this server trusts. |
| Expired | The Token expired at \<tokenExpiry\>: paste a current token under Token. |
| Expired, with no readable expiry | The Token expired: paste a current token under Token. |
| No user name claim | Oxia accepted the Token's signature but found no user name in it: use a token that carries the claim this server reads as the user name. |
| Any other reason | Oxia refused the Token. |

`<tokenExpiry>` is the token's own `exp` claim, read locally from the configured token and written as ISO 8601, never parsed from the server's answer.
Oxia has no authorization, so no sentence speaks of a permission the token lacks.

The connection dialog warns about a token whose payload declares no expiry:

> This token declares no expiry, so it stays valid until the identity provider's signing key changes, and Oxia has no authorization, so it reads and writes every namespace. Prefer a token with an expiry.

A read-only seed without a token is not refused: no token makes an Oxia server read-only, so the mode is a promise of what Studio sends, with a token or without one.

### 4.3 TLS

The shared SSL / TLS panel applies to the endpoint and to every listed data server alike: `disable` sends plaintext, `require` encrypts without verifying the certificate, `verify-system` verifies against the system's CAs, and `verify-ca` and `verify-full` against the pasted CA.
Each channel verifies its own host: the endpoint's certificate must name the host you typed, and each leader's must name that leader's advertised host, so a cluster's certificate names every data server's advertised host.
An IP address is verified against the IP in the certificate, with the server name `oxia.invalid` sent in its place, since a TLS server name cannot be an address; through an SSH tunnel the identity is the tunnel's far end.

A self-signed set for a test server, with a SAN for every host clients reach it by:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 365 -subj "/CN=oxia-test-ca"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=oxia"
printf 'subjectAltName=DNS:localhost,DNS:oxia-0.example.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile server.ext
```

Start the data server with `oxia server --tls-cert-file server.crt --tls-key-file server.key`, then choose `verify-full` and paste `ca.crt` under SSL / TLS.

### 4.4 Data servers and the dial policy

A leader is dialled when it is byte for byte the authority Studio sent, or when its parsed `host:port` is one of the entries under Data servers (section 3.3).
Entries are exact `host:port` addresses with a port, separated by commas or spaces, at most 64; a name ending in a dot is refused, and so is a wildcard, because a pattern would let the token follow any address it matches:

> Each Data servers entry must be host:port with a port, separated by commas or spaces: the \<n\> entry is not.

> Data servers entries name exact addresses: a wildcard (*) is not accepted, because it would match any service a tenant can create, and the token would follow.

> Data servers entries must not end the host with a dot: write the name without the final dot.

> Data servers holds more than 64 addresses; list only the cluster's data servers.

`<n>` is the entry's position, as an ordinal: 1st, 2nd, 3rd; no entry's text is echoed.
A seed file sets it as `connections[].dataServers` ([SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)).
Data servers is part of the key a cached provider is kept under, since that provider holds the dial policy, but not of the connection fingerprint that seals a plan, because it only admits or refuses the leaders the cluster at Host and Port advertises.

Three recipes:

- Standalone: leave Data servers empty; a standalone server names the authority Studio sent as the leader of every shard.
- A cluster with Studio inside it: type the bootstrap service in Host and list every `servers[].public` address of the coordinator configuration; with the Helm chart these are `<release>-N.<release>-svc.<namespace>.svc.cluster.local:6648`, one per data server.
- A cluster reached from outside: Studio must run where the leaders resolve, so either run Studio in the cluster, or give each advertised host a hosts-file entry pointing at this machine and run one `kubectl port-forward pod/<release>-N <port>` per data server on the advertised port, then list the advertised addresses under Data servers.

### 4.5 SSH tunnel

The dialog offers the SSH tunnel on every Oxia connection.
A tunnel forwards one address, so it reaches a standalone server, whose leader is the address Studio sent.
A cluster's leaders are other addresses, which Studio would dial directly, outside the tunnel, so a tunnel together with Data servers is refused before any socket:

> Data servers cannot be used with an SSH tunnel: the tunnel carries one address, and Studio would dial the data servers directly, outside it. Clear Data servers, or turn the tunnel off.

### 4.6 A token needs TLS off this machine

A token over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection, because Oxia receives it on every call:

> This connection would send its token without TLS to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or, if authentication is off on this server, clear the token. Or tick "Send the password without TLS", which then also covers every address under Data servers.

The same rule holds for every listed data server, which no tunnel carries; the consent box covers them too:

> This connection would send its token without TLS to the data server \<address\>, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, or, if authentication is off on this server, clear the token. Or tick "Send the password without TLS", which then also covers every address under Data servers.

### 4.7 Server versions

Supported: Oxia 0.16.2 and later; 0.16.1 and older carry four published security advisories.
Measured: `oxia/oxia:0.16.10` (`sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322`) and `oxia/oxia:0.17.1` (`sha256:165bf4f3803153f23be3ba699f6430ab1463cdeaa46e341ff32c3eaed0d1b7d6`), which speak two error models, both read (section 10).

An Oxia 0.16 standalone server (measured on 0.16.10) stops sending shard assignments to every client after one request whose authority is not `host:port`, which Studio never sends, until restarted (upstream #1450, about standalone mode only). 0.17.1 is not affected; fixed on main by #1450, in no 0.16 release as of 2026-10-04.

Recommended: 0.17.1.
A 0.16 release is named here once one carries #1450.

### 4.8 Pulsar's oxia:// URL

Pulsar names its Oxia metadata store as `oxia://host:6648/ns`.
The URL is not pasted whole: type `host` in Host, `6648` in Port and `ns` in Namespace.

## 5. Query interface

The editor runs one read command per run, written as `oxia client` writes it.

### 5.1 The command

The text is one `oxia client` command, with `oxia client` or `oxia` before it stripped, read as POSIX shell words: single and double quotes, backslash escapes, and `#` comments to the end of a line.
A pipe, a redirect or a second command is refused, and so is any global flag but a matching `-a` or `-n`.
A prompt sign, `$` or `%`, pasted before the command is dropped.
A command holds at most the command text bound of section 5.6, so a key longer than that cannot be named in the console; the Keys panel and the Source tab still read it.

### 5.2 Commands and flags

| Verb | Aliases | Arguments | Flags |
|---|---|---|---|
| `get` | none | `KEY` | `-t\|--comparison-type`, `-p\|--partition-key`, `--index`, `--hex`, `-v\|--include-version` |
| `list` | `ls` | `[MIN [MAX]]` | `-s\|--key-min`, `-e\|--key-max`, `-p\|--partition-key`, `--index`, `--prefix`, `--limit` |
| `range-scan` | `scan` | `[MIN [MAX]]` | `-s\|--key-min`, `-e\|--key-max`, `-p\|--partition-key`, `--index`, `--prefix`, `--limit`, `-v\|--include-version`, `--hex` |

Flags are read as cobra and pflag read them: anywhere among the arguments, `--` ends them, a long flag takes `=value` or the next word, a short flag its attached rest or the next word, and a boolean flag never takes a value; a flag given twice is refused.
A value flag written last, with no value after it, is refused, `<flag>` being the flag as typed:

> \<flag\> takes a value: write it after \<flag\>.

`-t` takes `equal`, `floor`, `ceiling`, `lower` or `higher`, and `equal` is the default.
`-s` is inclusive and `-e` exclusive; an empty `-e` means to the end.
`--prefix` and `--limit` are Studio's own: `--prefix P` reads every key beginning with P under either key order, and takes no bounds.
`--hex` shows the value as hex whatever it holds, and `-v` is accepted and changes nothing, because the grid always shows the version.
`list` answers 500 keys by default and `range-scan` 100 records, because its rows carry values, and both refuse `--limit` above 500, the most rows a Studio result holds.
`secondary_index_key` is a column of `get --index` only.

### 5.3 Refused commands

Every refusal comes before any call, with its sentence.

| Command | Sentence |
|---|---|
| `put` | put writes, and Studio's Oxia support reads only in this version: write with the oxia CLI. |
| `delete` | delete writes, and Studio's Oxia support reads only in this version: write with the oxia CLI. |
| `del` | del writes, and Studio's Oxia support reads only in this version: write with the oxia CLI. |
| `delete-range` | delete-range writes, and Studio's Oxia support reads only in this version: write with the oxia CLI. |
| `notifications` | notifications keeps a stream open until it is stopped, and Studio runs one bounded read per command: run it with the oxia CLI. |
| `sequence-updates` | sequence-updates keeps a stream open until it is stopped, and Studio runs one bounded read per command: run it with the oxia CLI. |

A write verb names the read-only mode while it holds (section 3.5).

| Flag | Sentence |
|---|---|
| `--internal-keys` | --internal-keys lists Oxia's own bookkeeping keys under __oxia/, which Studio never reads. |
| `--request-timeout` | --request-timeout is refused: the connection's Query Timeout bounds every command. |
| `--auth-token` | --auth-token is refused: the connection's Token field authenticates every call, and a token typed here would be kept in the query history. |
| `--auth-token-file` | --auth-token-file is refused: the connection's Token field authenticates every call, and a token typed here would be kept in the query history. |
| `--help`, `-h` | Studio prints no help: the provider doc lists every command and flag Studio runs. |

A key, a bound or a prefix under `__oxia/` is refused with the sentence of section 3.4.
A `-a` or `-n` that does not name the connection's own endpoint or namespace is refused with a sentence that names the connection's value and never the typed one: Host, Port and Namespace on the connection decide where a command runs.

> -a names another address than this connection's \<host\>:\<port\>: Host and Port on the connection decide where Studio connects.

> -n names another namespace than this connection's `<namespace>`: Namespace is set on the connection, and empty means default.

`--index` with an empty upper bound is refused, because Oxia reads index keys up to the upper bound and an empty one reads nothing:

> --index needs an upper bound: Oxia reads index keys up to MAX (or -e), and an empty upper bound reads nothing.

A word holding U+0000 is refused, because no command line can carry it:

> The word at line \<line\>, column \<column\> holds a NUL character, which no command line can pass: open such a key from the Keys panel, where its Source tab reads it.

Keys holding U+0000 or a carriage return are reached from the Keys panel and the key's Source tab only.

### 5.4 Examples

One key:

```oxia
get /admin/policies/public
```

The greatest key at or below a key:

```oxia
get -t floor /a/b
```

A key written with a partition key:

```oxia
get -p tenant-a /pk/tenant-a/1
```

A key by its secondary index:

```oxia
get --index by-email alice@example.com
```

The secondary keys of an index from `a` up to `b`, which needs `-e`:

```oxia
list -s a -e b --index by-email
```

Every key under a prefix:

```oxia
list --prefix /admin/
```

```oxia
list --prefix /admin/policies/ --limit 50
```

The keys from `/a` up to `/b`:

```oxia
list -s /a -e /b --limit 20
```

Every record under a prefix, with its value:

```oxia
range-scan --prefix /values/
```

Values shown as hex:

```oxia
range-scan --hex --prefix /managed-ledgers/
```

### 5.5 Result shape

`get` and `range-scan` answer one row per record, with the columns `key`, `value`, `value_encoding`, `version_id`, `modifications_count`, `created_timestamp`, `modified_timestamp`, `ephemeral`, `session_id`, `client_identity`, and `secondary_index_key` last for `get --index`; `list` answers one column, `key`.
The names are the CLI's own.
`value_encoding` is `hex` when `--hex` was given or the value is not printable UTF-8 text, `json` when the text parses as JSON, and `text` otherwise; printable means no control byte but tab, line feed and carriage return, and no DEL.
A hex cell is lowercase hex pairs; the Source tab dumps the value in the layout of Go's `hex.Dumper`, which the CLI prints.
A cell cut at the cell bound reads `json, cut`, `text, cut` or `hex, cut`.
The timestamps are ISO 8601 UTC with milliseconds; `ephemeral` is true when the record carries a session id; `client_identity` is the identity the writing client reported, not one the server checked.
A value larger than the receive cap is withheld: its row keeps its version, its `value` reads `value larger than 16 MiB, withheld` and its `value_encoding` reads `withheld`.

### 5.6 Bounds

| Bound | Value |
|---|---|
| Receive cap | 16 MiB per message, on every channel |
| Console run budget | 8 MiB of keys and values kept per console run |
| Per-stream received limit | 4 MiB per Keys panel stream, 8 MiB per console stream |
| Walk page | 16 MiB of keys kept per Keys panel page, across its shards |
| Shard streams | 8 shard streams in flight per run, whatever the shard count |
| Shard map | 1,024 shards at most |
| Leader address and index name | 300 bytes |
| Rows | `list` 500 keys and `range-scan` 100 records by default; `--limit` from 1 to 500 |
| Command text | 65,536 bytes of UTF-8 |
| Grid cell | 65,536 characters |
| Source hex dump | 65,536 bytes of a value |
| Permits | 4 shard calls per connection and 16 per process, with a queue of 64 |

A walk page keeps its share of the page's kept bytes for each shard, and at least one key, so a shard cut by its share is read on the next page and the page stays exact.
A comparison get asks every shard without values, picks the winner, then reads the winner's value with one exact get on its shard; if that read misses, the run says the record changed while the command ran (section 10).
Every shard call takes one limiter permit, the shard map read and the health check included, and gives it back when the call ends.
The worst case in flight across the process is 16 permits x (the largest per-stream limit, 8 MiB, plus one message under the 16 MiB receive cap) = 16 x 24 MiB = 384 MiB of received messages across every Oxia provider of the process; plus what runs keep for their answers: 8 MiB per console run and 16 MiB per Keys panel page, each plus one key per shard of the round.

Both stops of a `range-scan`, the receive cap and the run budget, end it as a result holding the rows read and a notice, never as an error:

> The result stopped after \<n\> records, at the 8 MiB of keys and values a console result holds: narrow the range, or list the keys and get the values one by one.

> The result stopped after \<n\> keys, at the 8 MiB of keys a console result holds: narrow the range.

> A record in this range is larger than the 16 MiB receive cap, so range-scan stopped after \<n\> records: list the keys with list, then read each with get, which shows such a value's version and withholds the value.

The second is `list`'s; `<n>` is the number of rows the result holds.
A single record larger than the run budget and smaller than the receive cap is kept as the last row, with the budget notice.

### 5.7 Cancellation and the confirmation gate

Cancel ends every stream of the run at once, and a run's deadline is the connection's query timeout.
No command writes, so the confirmation gate never asks; a command it refuses by its vocabulary is refused before a run, with the sentences of section 5.3.

### 5.8 Natural-order notice

Pulsar reads a folder's children with `list -s P/ -e P//`, which bounds them only under hierarchical order.
On a namespace that sorts keys naturally, a list or scan with those bounds carries a notice that points to `--prefix P/`, which reads everything under `P/` under either order; on a hierarchical namespace, a range whose lower bound ends in `//` carries the matching notice.

## 6. Schema introspection

The tree shows shards; keys are listed in the Keys panel and opened in the Source tab.

### 6.1 The object surface

Two kinds: `shard` (Shard, Shards), listed in the tree in shard id order with its hash range, and `key` (Key, Keys), which the Keys panel enumerates.
No prefix kind is declared: a folder is a view of the Keys panel, not an object Oxia holds, so the tree draws no folder of keys.
Listing the `key` kind answers:

> Keys are listed in the Keys panel and with list in the console.

The tree is never empty on a reachable namespace: every namespace has at least one shard, and a shard map with none is refused (section 10).
No container level is declared: the namespace is a connection property.

### 6.2 Object source

A shard's Source tab is JSON: the namespace, the shard id, its hash range, its leader as the parsed `host:port`, the key order and how it was learned (section 3.2), and the shard count.
A key's Source tab has two parts.
The Value part shows JSON pretty-printed, text as stored, or a hex dump; an empty value and a withheld value each have their own sentence instead of a value.
The Metadata part shows the version fields of section 5.5 with the value's encoding and size, and an ephemeral record carries a badge in its label, naming the session it ends with.

### 6.3 Generated commands

A key click opens the Source tab and a folder click only toggles, so no click reaches the generators.
Generate Command writes `get <key>`, with the `list --prefix` and `range-scan` forms as comments under it.

### 6.4 The Keys panel

A page asks 500 keys by default and at most 1,000, in the namespace's own key order, resumed by a cursor that carries the order it was cut under.
A cursor cut under the other order, or one this provider did not write, is refused:

> This cursor was cut under the other key order than this namespace is now detected to have: start the walk again.

> This cursor was not written by the Oxia provider: start the walk again.

A key on a page with more following that is too long for a cursor stops the walk:

> A key on this page is longer than 65,536 bytes, so the Keys panel cannot page past it; read the keys after it in the editor with list --key-min.

Oxia publishes no key count, so the panel reads "Scanned n" with no total.
The first page of a walk with no pattern, and only that page, discovers the namespace's top-level folders, never under a folder, because under a folder the cost grows with its children.
Discovery stops at whichever comes first: 256 rounds, 2,048 calls or 3,000 ms; a capped discovery reports the folders found so far and nothing as skipped, and the walk itself still reaches every key.
That is the limit: on a namespace whose top level holds very many nodes, or many keys of its own under natural sorting, the first page names the first 256 steps' worth of folders.
Narrowing by prefix is the answer, and the panel's prefix search reaches any depth.
The first page lists each key once: a folder representative that the walk's first page also returns appears in the walk only.
A representative the first walk page did not reach comes back on a later page, so after a full walk "Scanned n" may exceed the distinct key count by at most the representatives a later page returns again.
A shard whose keys do not fit one page stops the page:

> A shard's keys are too large for one page of the Keys panel: narrow the walk with a prefix.

The panel holds keys up to its held-key limit (`HELD_KEY_LIMIT`), past which it asks for a narrower prefix.

### 6.5 Object edit (#789): nothing to write

No editable kind: v1 reads only.
Neither kind declares a row write or a source edit, because the provider sends Oxia no write (section 3.1).

## 7. Monitoring & health

Health reads the shard map afresh, runs the dial policy over every leader, then asks `grpc.health.v1.Health/Check`, each under the health deadline or the query timeout, whichever is shorter.
It is healthy when every step passes and Check answers SERVING.
A server that answers Check SERVING but sends no shard map within the deadline answers:

> The server answers health but serves no shard map: The server accepted the connection but its shard map did not arrive within \<n\> s, so nothing was read. A data server that has not yet received its shard assignments from the coordinator answers this way: check the coordinator, then try again.

A Check that answers anything but SERVING:

> Oxia answered the health check with \<STATUS\>: it serves no reads now.

The overview shows the shard count as its one counted object; the client API reports no version, uptime or size, so those read N/A, and the namespace, the key order and each leader are in each shard's Source tab.
The other panels are empty, with these states:

- Slow queries: Oxia keeps no query log
- Sessions: Oxia does not list client sessions
- Tables: Oxia has no tables: its shards are listed under Shards, and its keys in the Keys panel and with list in the console.

## 8. Maintenance

None: Oxia compacts its own storage, and Studio sends it no maintenance.
The provider declares no maintenance operation, so Admin > Operations offers nothing for an Oxia connection.

## 9. Capabilities & labels

Every capability is written, since the base's defaults are SQL's:

| Capability | Value |
|---|---|
| `queryLanguage` | `"json"` |
| `queryDialect` | `"oxia"` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` |
| `supportsResultPagination` | `false` |
| `supportsTransactions` | `false` |
| `declaresForeignKeys` | `false` |
| `tablesAreDerivedGroupings` | `false` |
| `enforcesReadOnly` | `true` |
| `supportsMaintenance` | `false` |
| `maintenanceOperations` | `[]` |
| `supportsConnectionString` | `false` |
| `defaultPort` | `6648` |
| `statementTerminator` | `"none"` |
| `containerLevels` | `[]` |
| `objectKinds` | `OXIA_OBJECT_KINDS` |
| `keyScan` | `OXIA_KEY_SCAN` |
| `schemaRefreshPattern` | `"(?!)"` |

`queryLanguage` `"json"` means only "not SQL", as for etcd; `schemaRefreshPattern` matches nothing, because no read changes the tree.

| Label | Text |
|---|---|
| `entityName` | Shard |
| `entityNamePlural` | Shards |
| `rowName` | Key |
| `rowNamePlural` | Keys |
| `selectAction` | List Keys |
| `generateAction` | Generate Command |
| `analyzeAction` | Shard Statistics |
| `vacuumAction` | Compact |
| `searchPlaceholder` | Search shards... |
| `analyzeGlobalLabel` | Statistics |
| `analyzeGlobalTitle` | Not available |
| `analyzeGlobalDesc` | Oxia keeps no statistics to update. |
| `vacuumGlobalLabel` | Compact |
| `vacuumGlobalTitle` | Not available |
| `vacuumGlobalDesc` | Oxia compacts its own storage, and Studio sends it no maintenance. |
| `slowQueriesEmptyState` | Oxia keeps no query log |
| `sessionsEmptyState` | Oxia does not list client sessions |
| `tableStatsCaption` | Oxia has no tables: its shards are listed under Shards, and its keys in the Keys panel and with list in the console. |

`statementLanguage`, the sentence plan mode states for the grammar, is built from the command table of section 5.2, so it names every verb and flag the parser takes.

## 10. Error handling

One closed table maps every failure to a sentence, for both of Oxia's error models: 0.16 sends its own status codes 100 to 112, and 0.17 sends standard gRPC codes with an `ErrorInfo` reason in the domain `oxia.io`, which Studio does not read, because the code alone decides the row.
Studio reads a failure's gRPC code and grpc-js's own local texts, and no grpc-js error text is ever shown; no sentence carries server text, a token, or an address but a validated `host:port`.
`<operation>` is the caller's words: Keys panel page, get, list, range-scan, connection test, health check or object read.

| Failure | Sentence |
|---|---|
| Not initialized (0.16 code 100; 0.17 Unavailable from the server) | Oxia is not ready to serve this namespace yet: its data server has no shard assignments from the coordinator. Try again shortly. |
| Leadership changing (0.16 codes 101, 102, 104, 112; 0.17 FailedPrecondition, Aborted) | Shard \<id\>'s leadership is changing on the server, so the \<operation\> stopped: run it again. |
| Not the leader (0.16 code 106) | The data server at \<leader\> is no longer the leader of shard \<id\>, so the \<operation\> stopped: run it again, and Studio reads the shard map afresh. |
| Cancelled by the server (0.16 code 103; Cancelled while the run was not) | The server cancelled the \<operation\>: run it again. |
| A state a read does not expect (0.16 codes 105, 107, 108, 109, 111) | Oxia answered the \<operation\> with state error \<code\>, which a read does not expect. |
| No such namespace (0.16 code 110; 0.17 NotFound on the shard map) | No namespace \<name\> on this server (names are case sensitive). Namespace is set on the connection; empty means default, the only namespace of oxia standalone. A cluster's namespaces are in its coordinator configuration. |
| No such shard (0.17 NotFound on a read) | Shard \<id\> is not on the server any more (the shard map changed, for example by a split): run it again, and Studio reads the shard map afresh. |
| Invalid argument | Oxia refused the \<operation\>'s request as invalid. |
| Permission denied (the server checks the authority) | This Oxia server checks the address clients dial and refused \<sentAuthority\>: connect by an address its operator allows. |
| Unimplemented | The server at \<host\>:\<port\> does not serve Oxia's client API: check that Port is the data server's public port (6648 by default), not the admin port (6651) or the metrics port. |
| No connection, plaintext | No Oxia answered a plaintext connection at \<host\>:\<port\>. If this Oxia serves TLS, choose an SSL mode under SSL / TLS; otherwise check the host, the port and the tunnel. |
| No connection, TLS, on Node | No Oxia answered a TLS connection at \<host\>:\<port\>: check the host, the port, the SSL mode and the tunnel. |
| No connection, TLS, on Bun, no client certificate | No TLS connection to Oxia at \<host\>:\<port\> was established, and this runtime does not report why. No client certificate is configured: if this Oxia requires one, add it under SSL / TLS; otherwise check the host, the port, the SSL mode and the tunnel. |
| No connection, TLS, on Bun, with a client certificate | No TLS connection to Oxia at \<host\>:\<port\> was established, and this runtime does not report why: check the host, the port, the SSL mode, the client certificate and the tunnel. |
| Connection refused | Nothing accepted a connection at \<host\>:\<port\>: check Host and Port, and that Oxia's public port (6648 by default) is published. |
| Connection refused on this machine | Nothing accepted a connection at \<host\>:\<port\>: check Host and Port, and that Oxia's public port (6648 by default) is published. If Studio runs in a container, localhost is the container itself: use the address of the machine Oxia runs on (with Docker Desktop, host.docker.internal). |
| Name not resolved | Studio could not resolve \<host\>: check Host. If Studio runs in a container, the name must resolve inside that container. |
| TLS, untrusted chain | The server's certificate is not signed by the CA under SSL / TLS: paste the CA that issued Oxia's certificate. |
| TLS, wrong name | The certificate does not name \<host\>: connect by a name or address the certificate carries. |
| TLS, wrong name, with Data servers | The certificate does not name \<host\>: connect by a name or address the certificate carries. A cluster's certificate must also name every data server's advertised host. |
| TLS on a plaintext port | This port did not answer TLS: set SSL mode to disable, or use Oxia's TLS port. |
| Client certificate required, none configured | This Oxia requires a client certificate, and none is configured: add the client certificate and key under SSL / TLS. |
| Client certificate required, one configured | Oxia asked for a client certificate and did not accept the one configured under SSL / TLS. |
| Client certificate refused | Oxia refused the client certificate under SSL / TLS: it must be issued for client authentication by the CA Oxia trusts. |
| Client certificate expired | Oxia refused the client certificate under SSL / TLS because it has expired (client certificate expired): paste a current one. |
| Any other TLS failure | The TLS connection to Oxia failed. |
| Unauthenticated | The sentences of section 4.2 |
| Deadline | The \<operation\> reached its deadline of \<n\> ms. |
| Cancelled by the user | The \<operation\> was cancelled. |
| Cancelled before it was sent | The \<operation\> was cancelled before Studio sent it. |
| A list message over the receive cap | The server sent a list message larger than the 16 MiB receive cap: narrow the walk with a prefix. |
| Any other message over the receive cap | The server sent a message larger than the 16 MiB receive cap during the \<operation\>. |
| Connection lost | The connection to Oxia was lost during the \<operation\>: run it again. |
| Connection closed | This connection to Oxia is closed: connect again. |
| No shard map within the deadline | The server accepted the connection but its shard map did not arrive within \<n\> s, so nothing was read. A data server that has not yet received its shard assignments from the coordinator answers this way: check the coordinator, then try again. |
| An answer not in the expected form | Oxia's answer to the \<operation\> was not in the form Studio reads, so nothing was shown. |
| The comparison get's winner changed | The record this \<operation\> selected changed while this command ran: run it again. |
| Resource exhausted | Oxia refused the \<operation\> for lack of resources (gRPC code 8). |
| Any other code | The \<operation\> failed with gRPC code \<code\>. |
| No code | The \<operation\> failed, and the failure carried no gRPC code. |
| A thrown value that is not an Error | The Oxia provider received a thrown value that is not an Error. |

A deadline on a shard call reads the shard map once more before it is worded: a shard that is gone gets the no-such-shard sentence, a shard whose leader moved the leadership sentence, and any other the deadline sentence; nothing is retried.
A leadership, leader or shard failure drops the cached shard map, so running the command again reads it afresh.
The shard-map deadline's sentence names the deadline the call ran under, and only that cause, because Studio always sends `host:port` as the authority.

A shard map Studio cannot route by is refused before anything is read, with the reason:

- The server's shard map is not one Studio can route by (the namespace is missing from the answer), so nothing was read.
- The server's shard map is not one Studio can route by (more than 1,024 shards), so nothing was read.
- The server's shard map is not one Studio can route by (no shards), so nothing was read. The namespace may still be starting: try again shortly.
- The server's shard map is not one Studio can route by (two shards share an id), so nothing was read.
- The server's shard map is not one Studio can route by (a shard id is not a 64-bit integer), so nothing was read.
- The server's shard map is not one Studio can route by (a shard has no hash range), so nothing was read.
- The server's shard map is not one Studio can route by (the hash ranges leave a gap or overlap), so nothing was read.
- The server's shard map is not one Studio can route by (the key router is not XXHASH3), so nothing was read.
- The server's shard map is not one Studio can route by (a leader address is not host:port within 300 bytes), so nothing was read.
- The server's shard map is not one Studio can route by (the shard map is larger than 16 MiB), so nothing was read.

The adapter refuses three keys before any request:

- Keys under __oxia/ are Oxia's own internal records, which Studio does not read.
- The key holds a lone UTF-16 surrogate, which is not text and names no Oxia key: type it again.
- An index name is one word without "/", at most 300 bytes.

The dial-policy refusals are in section 3.3, and the field refusals in sections 4.1 to 4.6.

## 11. Testing

The unit tests run without a server; the integration test replays answers recorded from real servers; the live checks run by hand against the fixtures.

### 11.1 How the tests work

Each module has its unit test under `tests/unit/db/oxia/`.
Above the adapter, the walks, the console, the object surface and the provider run over one shared `OxiaClient` fake; below it, the adapter runs over a recorded wire, an `OxiaWireTransport` passed to `createGrpcOxiaClient`, and no test replaces a module.
Four kinds of test hold the provider: unit tests per module, the recorded wire, the cluster dial policy over synthetic shard maps, and the live checks.
The key order tests compare every walk against the sorted truth under both orders, and the router is held to the server's own XXH3 vectors.
The seam guard holds that only the adapter reaches the transport and that its stub holds the allowlist alone.

### 11.2 Run it

```sh
bun tests/run-tests.ts tests/unit/db/oxia/
bun tests/run-tests.ts tests/integration/db/oxia-provider.test.ts
```

### 11.3 The live fixtures

`database-compose.yml` holds the Oxia servers, each bound to 127.0.0.1 and pinned by digest.
A plain `up` starts `oxia` and `oxia-seed` only: a 0.16.10 standalone server with three shards and the `full` key set.
The rest start by profile: the `oxia-natural` profile two natural-order servers, the `oxia-017` profile the 0.17.1 server, the `oxia-auth` profile a TLS and OIDC server, and the `oxia-cluster` profile a coordinator with three data servers for the dial policy.
[`docker/oxia/README.md`](../../docker/oxia/README.md) says how to start and seed each one and what every seeded key is for.

### 11.4 The raw seeder, the evidence harness and the live check

`tests/live/oxia-seed-raw.ts` is the one writer: it adds the keys the CLI cannot write, those holding U+0000 and the bulk keys, to the two seeded standalone fixtures only, and refuses any other server.
`tests/live/oxia-evidence.ts` records the captures the integration test replays, through the real adapter, and checks that it changed nothing.
`tests/live/oxia-live-check.ts` drives a real provider against the fixtures on Node and Bun, both server lines, the auth fixture and the cluster, and fails on any key count or version that changed.
All three run by hand, in that order, after the compose seed.

## 12. Running Oxia for Studio

A standalone server for Studio on the same machine:

```sh
docker run -d --name oxia -p 127.0.0.1:6648:6648 oxia/oxia:0.17.1 oxia standalone --public-addr 0.0.0.0:6648
```

`--public-addr 0.0.0.0:6648` makes the server listen on every interface of its container, so the published port reaches it.
Then connect with Host `localhost`, the default port and an empty Namespace.
A cluster is installed with the `oxia-cluster` Helm chart of `oxia-db/helm-charts`; run Studio in the same cluster, type the bootstrap service in Host and list each data server under Data servers (section 4.4).
For TLS, start each data server with `--tls-cert-file` and `--tls-key-file`; for OIDC, with `--auth-provider-name oidc` and `--auth-provider-params` naming the issuer, the allowed audiences and the user name claim, as `database-compose.yml`'s `oxia-auth` service does.

## 13. Known limitations

- Connections are read-only: no write, typed or confirmed ([D205](../BACKLOG.md#d205-oxia-connections-cannot-write)).
- Ephemeral records are shown with their session, but no session is made or listed ([D206](../BACKLOG.md#d206-oxia-ephemeral-records-and-sessions-are-shown-never-made-or-listed)).
- No notifications watch ([D207](../BACKLOG.md#d207-no-bounded-notifications-watch-on-oxia)).
- No namespace list, and no list of data servers: both are typed ([D208](../BACKLOG.md#d208-oxia-namespaces-and-data-servers-cannot-be-listed)).
- Data servers takes exact addresses only, never a wildcard.
- A port-forwarded cluster cannot be read without the hosts-file workaround of section 4.4 ([D209](../BACKLOG.md#d209-a-port-forwarded-oxia-cluster-cannot-be-read)).
- Pulsar's `oxia://` URL is not split on paste ([D210](../BACKLOG.md#d210-pasting-pulsars-oxiahost6648ns-does-not-split-it)).
- A token is pasted, never read from a file ([D211](../BACKLOG.md#d211-an-in-cluster-studio-cannot-read-its-oxia-token-from-a-file)).
- grpc-js resolves names itself, so the HTTP egress guard does not cover Oxia ([D212](../BACKLOG.md#d212-grpc-providers-are-outside-the-http-egress-guard)).
- No metrics panel ([D213](../BACKLOG.md#d213-no-oxia-metrics-panel)).
- The key order is probed, because no released server reports it ([D214](../BACKLOG.md#d214-key-order-is-probed-because-no-released-oxia-reports-it)).
- The first Keys page discovers folders within 256 rounds and its other bounds, and a deeper or wider tree is narrowed by prefix ([D216](../BACKLOG.md#d216-the-oxia-keys-panel-discovers-folders-on-its-first-page-only)).
- A 0.16 standalone server needs the version note of section 4.7 ([D217](../BACKLOG.md#d217-studios-oxia-doc-recommends-0171-because-of-a-016-standalone-lock)).
- The cluster dial policy is checked live by hand only ([D218](../BACKLOG.md#d218-the-oxia-cluster-dial-policy-is-checked-by-hand-only)).
- No agent execution and no MCP surface ([B100](../BACKLOG.md#b100-oxia-has-no-agent-execution-and-no-mcp-surface)).
- `client_identity` is what the writing client reported, which the server does not check.

## 14. References

- Oxia: [repository](https://github.com/oxia-db/oxia), [documentation](https://oxia-db.github.io/), [key sorting](https://oxia-db.github.io/docs/features/oxia-key-sorting).
- Oxia releases [v0.16.10](https://github.com/oxia-db/oxia/tree/v0.16.10) and [v0.17.1](https://github.com/oxia-db/oxia/tree/v0.17.1); the vendored `client.proto` is from commit `c72b0bfce3fa0058fe200462b64f0d502dd56b02`.
- Upstream [#1450](https://github.com/oxia-db/oxia/pull/1450), the standalone authority fix, and [#1388](https://github.com/oxia-db/oxia/pull/1388), the key order in the shard assignments.
- The Helm chart: [oxia-db/helm-charts](https://github.com/oxia-db/helm-charts).
- Pulsar's [metadata store](https://pulsar.apache.org/docs/administration-metadata-store/), which Oxia serves.
