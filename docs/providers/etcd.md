# etcd Provider

The `etcd` type-id: read-write key-value browsing over etcd's gRPC API, tested and claimed on etcd 3.7.2.
Source: [`src/lib/db/providers/keyvalue/etcd/`](../../src/lib/db/providers/keyvalue/etcd/).
Tests: [`tests/unit/db/etcd/`](../../tests/unit/db/etcd/) and [`tests/integration/db/etcd-provider.test.ts`](../../tests/integration/db/etcd-provider.test.ts).
Tracking issue: [#1089](https://github.com/libredb/libredb-studio/issues/1089), under [#424](https://github.com/libredb/libredb-studio/issues/424).

## 1. Overview

Studio reads and writes an etcd cluster through a subset of `etcdctl`'s command line, shows its keys as prefix groups in the object tree and every key in the Keys panel, edits a key's value through a guarded transaction, and offers compaction, defragmentation and alarm disarm to an admin.
It is Kubernetes-aware: every write that touches a Kubernetes key prefix or kube-apiserver's `compact_rev_key` is refused before any write is sent, a Kubernetes protobuf or encrypted value and every secret are withheld on every surface, and a Kubernetes JSON or CBOR value is shown with its label.
It is bound to Studio's RBAC through a seed-declared read-only mode, admin-only cluster operations and machine-access refusals: no agent execution and no MCP.

### Concept mapping

| etcd | Studio |
|---|---|
| One cluster | One connection, with no database or container level |
| A key prefix such as `/apisix/routes/` | A row of Key Prefixes, drawn `/apisix/routes/*` |
| A key | A row of the Keys panel, opened in the Source tab |
| A member | A row of Members, with its raised alarms as its status |
| A lease, a user, a role | A row of Leases, Users or Roles |
| `etcdctl get`, `put`, `del`, `txn`, `watch` and the rest | One command per run in the editor |
| `etcdctl compaction`, `defrag`, `alarm disarm` | The three cards of Admin > Operations |

## 2. Architecture

### 2.1 Where it sits

`EtcdProvider` extends `BaseDatabaseProvider` in the `keyvalue` family beside Redis, and every module talks to etcd only through the `EtcdClient` interface of `client.ts`, each through the slice it uses.
`grpc-client.ts` is the one file that imports `@grpc/grpc-js`, and it names only the allowlist of RPCs `tests/unit/db/etcd/seam-guard.test.ts` holds.
`lexer.ts`, `commands.ts`, `keys.ts` and `guard.ts` are pure and shipped to the browser, because the confirmation gate, the generators and the editor's tokens provider read them; `write-policy.ts`, which decides the read-only mode and the Kubernetes refusals, runs on the server only.

### 2.2 Modules

| File | What it owns |
|---|---|
| `client.ts` | The seam: `EtcdClient`, its request and answer types, and `EtcdError` |
| `grpc-client.ts` | The one gRPC channel, its credentials, the token and its renewal, the `hasleader` table, deadlines and aborts |
| `proto/` | The vendored etcd v3.7.2 protos and the descriptor generated from them by `scripts/generate-etcd-descriptor.mjs` |
| `connection-options.ts` | The connection to options, with the endpoint, credential and TLS checks |
| `lexer.ts`, `commands.ts` | Every quoting rule, the `schemaRefreshPattern` that reloads the tree after a write, built from those rules, and the etcdctl subset as a declared table |
| `keys.ts`, `permissions.ts`, `guard.ts` | Byte ranges, the protected set, the prefix-group rule, the readable and writable scopes, and the command classes |
| `values.ts`, `results.ts`, `write-policy.ts` | Value classes, result shapes, and the read-only and Kubernetes decisions |
| `execute.ts`, `watch.ts` | One command within its bounds, and the bounded watch |
| `objects.ts`, `key-scan.ts`, `edit.ts` | The object surface, the Keys panel's pages, and the guarded value edit |
| `monitoring.ts`, `monitoring-reads.ts`, `maintenance.ts` | The monitoring panels and the three maintenance operations |
| `errors.ts`, `labels.ts`, `index.ts` | The one error table, the labels, and the composition root |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` checks the endpoint, the credentials and the TLS panel first, opens one gRPC channel, and runs the connect sequence of section 4.2; `disconnect()` closes that channel.
After `disconnect()` no socket of the Studio process stays open to the endpoint, including one whose peer never answered the TLS handshake or never sent HTTP/2's settings, and nothing is dialled again.
The one exception is a TCP connect still under way when the connection closes, which grpc-js gives no way to abort: it is ended the moment the peer answers it, or the kernel gives up on it first (on Linux after `tcp_syn_retries`, six retries by default).
The channel never goes through an `http_proxy`, `https_proxy` or `grpc_proxy` variable: use an SSH tunnel to reach a private endpoint.

### 2.4 The client, and why

The client is `@grpc/grpc-js` 1.14.5 with `@grpc/proto-loader` 0.8.1, pinned exactly, over a JSON descriptor of the v3.7.2 protos generated ahead of time, with `protobufjs` 7.6.6 pinned as a devDependency for the generator.
It was chosen by measurement: it passed every check on Node 24 and Node 26, and under Bun all but the two error texts Bun does not report, once two pieces of this provider's own code were in place, a server-name override for a TLS connection to an IP address and `call.cancel()` on every end of a watch.
`microsoft/etcd3` was set aside: it fails TLS to an IP address on Node 26 and Bun, loads its protos from disk at run time, cannot cancel a call in flight, and has had no functional commit since 2023-07-30.
etcd's JSON gateway is not used, because it cannot carry client-certificate authentication with RBAC on, and neither k3s's embedded etcd nor kine serves it.

## 3. Design decisions

### 3.1 An etcdctl subset, not a query language of Studio's own

The editor text is one `etcdctl` command, parsed from a declared table with etcdctl's own names and flag spellings, so a documented command pastes and runs with the prompt, the environment prefix and the path it is printed with.
A flag etcdctl has and the subset does not take is refused by name with its reason, and a flag etcdctl does not have is refused as unknown.
The highlighter and the parser read one quoting module, so what the editor draws as one word is one word and holds the same bytes.

### 3.2 Kubernetes writes are refused (E8)

The protected prefixes are `/registry/`, `registry/`, `/kubernetes.io/`, `kubernetes.io/`, `/openshift.io/`, `openshift.io/`, `/bootstrap/`, `bootstrap/`, `/k3s/`, `k3s/`, `/rke2/` and `rke2/`, and the protected key is `compact_rev_key`, kube-apiserver's compaction clock at the root of the key space.
A write whose key, range or prefix meets the protected set is refused before any request: `put`, `del` in every spelling, a write in either branch of a `txn`, and a `put --lease`.
A `lease revoke` deletes every key its lease holds, so it first reads those keys with one `LeaseTimeToLive` that asks for them, and is refused with nothing revoked when one of them is protected, or when etcd will not show them, because Kubernetes attaches its keys to leases.
The refusal names the prefix and says that Kubernetes objects are written through the Kubernetes API, or names `compact_rev_key` and says that kube-apiserver owns it.
Under a prefix this list does not name, such as a custom `--etcd-prefix`, a single-key write is read first and refused when the stored value is a Kubernetes protobuf envelope or an encrypted value, naming the key and its label and never the value.
A top-level single-key `put` or `del` that passes is sent as one transaction guarded by the `mod_revision` its read returned, and it is refused, with nothing written, when the key changed or vanished in between.
A WRITE-only grant cannot put or del a single key through Studio, because the read that guards the write needs READ, and for the same reason a user who may not read every key of a lease cannot revoke that lease through Studio.

### 3.3 Values that are never shown (E9)

One ordered table decides every value on every surface, the first matching row winning: a key under `/registry/secrets/`, `registry/secrets/`, `/kubernetes.io/secrets/`, `kubernetes.io/secrets/`, `/bootstrap/` or `bootstrap/` is withheld whatever it holds; a value beginning `k8s:enc:` is withheld with its provider and key name; a value beginning with the Kubernetes protobuf envelope is withheld with its `apiVersion` and `kind`; a CBOR value under a protected prefix is shown as base64 labelled `kubernetes-cbor`; a JSON value under a protected prefix is labelled `kubernetes-json`; and any other value is `json`, `text` or `base64`.
Withheld means the value is replaced by its label and its size, for example "Kubernetes protobuf (v1, Pod), 1,204 bytes", while the key's metadata stays.
The same rule classifies a previous value, the pairs of a `del --prev-kv`, a watch event's previous value, a `txn` answer, the Source tab, an edit conflict, an export and every agent read.
A secret stored under a custom prefix in an envelope Studio does not know is shown.

### 3.4 The read-only mode (E6)

A connection with `readOnly: true`, or a provider opened read-only by an agent execution profile, refuses every write command, every value edit and every maintenance operation before any request, naming where the mode was set:

| Where the mode was set | The refusal |
|---|---|
| The operator's seed file | This connection is read-only (set in the operator's seed file). |
| A connection of the user's own | This connection is read-only: turn off Read-only in its settings to write. |
| An agent execution profile, on a connection that is not read-only | This run opens the connection read-only (agent execution profile). |

Where a connection's own mode and a profile's both hold, the connection's sentence is the one given.
A read-only connection shows a "Read-only" marker beside its name in the sidebar and in the editor header, titled "Writes, value edits and maintenance are refused on this connection", the Operations tab shows "This connection is read-only: use a read-write connection for maintenance" in place of its cards, and Generate Command writes the read alone.
The mode binds a `user` only on a managed seed and only where etcd authenticates the client, by a password or a client certificate whose secret the managed seed keeps on the server.
On an etcd that authenticates nobody, and on a connection of the user's own, the mode is a safety rail and not a boundary, because a `user` can connect to any host and port with a connection of their own, and can turn off Read-only on one.

The recipe is two seeds of one cluster: one every role reaches, read-only, and one for the people who may write.

```yaml
version: "1"
connections:
  - id: "cluster-read"
    name: "Cluster"
    type: etcd
    host: etcd.internal
    port: 2379
    user: "reader"
    password: "${ETCD_READER_PASSWORD}"
    ssl:
      mode: verify-full
      caCert: "${ETCD_CA}"
    roles: ["*"]
    managed: true
    readOnly: true
  - id: "cluster-write"
    name: "Cluster (write)"
    type: etcd
    host: etcd.internal
    port: 2379
    user: "writer"
    password: "${ETCD_WRITER_PASSWORD}"
    ssl:
      mode: verify-full
      caCert: "${ETCD_CA}"
    roles: ["admin"]
    managed: true
```

`managed: true` is written out on both, although it is the default, because a connection's own value overrides a file-wide `defaults.managed: false`, and the seed loader refuses `readOnly: true` on a connection that is not managed.
The same recipe, with what each field does, is in [SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md#a-read-only-cluster-for-everyone).

### 3.5 Machine access (E12)

The provider implements no read-only query path, so the agent's execution mode refuses etcd, and plan mode drafts reads for the user to run.
The `agent-operations` profile, which reaches every engine, opens the provider read-only, so it is refused every write in the third sentence of the table above.
An etcd seed with `mcp: true` is refused when the seed file loads: "mcp is not offered for etcd: the product does not expose this engine to MCP clients. Remove mcp from this connection."

### 3.6 Measurements

The bounds of section 5.4 and the walk's bounds of section 6.1 are measured on a fixture of 200,000 keys under 1,000 groups, a flat directory of 200,000 two-segment keys, and a first segment mixing both shapes; section 11.4 records the numbers and the commands.

## 4. Connection

### 4.1 Configuration fields

| Field | Meaning |
|---|---|
| Host | A name or address only. For etcdctl's --endpoints=https://10.0.0.5:2379, type 10.0.0.5 here, 2379 in Port, and choose an SSL mode under SSL / TLS. |
| Port | `2379` by default, etcd's client port |
| User | Leave User and Password empty to sign in with the client certificate under SSL / TLS (shown in verify-ca and verify-full): etcd uses its Common Name as the user when the server runs with --client-cert-auth. When both are set, etcd uses the password. |
| Password | etcd receives the password, then a token on every call, so a password needs an SSL mode other than disable, with or without an SSH tunnel. |
| SSL / TLS | The mode, the CA, and the client certificate and key |
| SSH Tunnel | A bastion that forwards the one endpoint |
| Read-only | Refuse every write, value edit and maintenance operation on this connection (section 3.4) |

The Host, User and Password rows are the hints the connection dialog shows under each field.
There is no Database field and no connection string: one connection is one cluster, and there is no etcd URI convention to parse.
A host that holds a colon and is not an IPv6 literal, such as one typed `https://10.0.0.5`, is refused with "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS."

### 4.2 Authentication

With a User and a Password, Studio signs in with `Authenticate` on connect and sends the token on every call; on "invalid auth token", "user name is empty" or "revision of auth store is old" it signs in once more, concurrent calls share the one renewal, a read is sent once more, and a second failure is raised.
A write is sent once more only after "invalid auth token" or "user name is empty", which left a write unapplied when measured (section 11.4); a write that met "revision of auth store is old" waits for the renewal and is then raised with the sentence that it may have been applied, because no write could be made to meet that answer and be measured.
A write that met "invalid auth token" or "user name is empty" is not sent again when its deadline comes before that renewal answers, or when the renewal fails, and is raised without the sentence that it may have been applied: with etcd's answer, or with the renewal's own failure when that failure applies nothing either, such as a lost quorum.
A User or a Password over no TLS is refused with "A User or Password needs TLS on etcd: choose an SSL mode under SSL / TLS, or clear them. A plaintext etcd with password authentication cannot be connected."
With a client certificate and no password, etcd reads the certificate's Common Name as the user when the server runs with `--client-cert-auth`; with both, etcd authenticates the password.
The connect sequence answers each of etcd's refusals in words of its own: a password on an etcd without authentication, authentication on with no credential configured, a certificate whose Common Name is no etcd user, and a server that did not read the certificate.

### 4.3 TLS

| Mode | Channel | Chain | Name |
|---|---|---|---|
| `disable`, or no TLS panel | plaintext | not checked | not checked |
| `require` | TLS | not checked | not checked |
| `verify-system` | TLS | the pasted CA, or the runtime's roots when none is pasted | checked |
| `verify-ca` | TLS | the pasted CA, or the runtime's roots when none is pasted | checked, as in `verify-full`, by decision: not every other provider checks it in this mode |
| `verify-full` | TLS | the pasted CA, or the runtime's roots when none is pasted | checked |

`verify-system` is the mode with nothing to paste, but the dialog still draws the CA field in it, and a pasted CA replaces the runtime's roots in every mode that checks the chain, so leave it empty to verify a publicly signed endpoint.
A panel with no mode, which a seed file may write, verifies as `verify-full`, and a `rejectUnauthorized` the panel sets decides in any TLS mode whether the chain and the name are checked.
The certificate is checked against the connection's host, or against the far end of the SSH tunnel when one carries the connection, never against the tunnel's local `127.0.0.1`.
A certificate that carries only an IP address verifies for that IP.
A client certificate is entered in `verify-ca` or `verify-full`; the dialog still sends a certificate a later switch to another mode hid, a defect of the shared dialog filed as U60.
Under Bun a chain failure, a name failure and a port that answers with bytes that are not TLS are named as under Node, but a handshake the server refused, for a missing client certificate or one from another CA, carries no cause: a TLS connection that fails with no cause named says that the runtime does not report why, and names a missing client certificate from the connection's own configuration.
etcd's own plaintext port is not such a port: it closes the connection on a TLS hello, a failure that names no cause under either runtime, so it reads as a failure to connect, worded under Node as "No etcd answered a TLS connection at 10.0.0.5:2379: check the host, the port, the SSL mode and the tunnel." and under Bun as the sentence that the runtime does not report why.

### 4.4 One endpoint

A connection names one endpoint, and Studio dials that endpoint, or the local end of its tunnel, and nothing else: the client URLs `member list` shows are data and are never dialled, and `--cluster` is refused.
A DNS name that resolves to several members reaches the next one when the first fails, through grpc-js's `pick_first` policy.
A member that stops answering without closing its connection, such as a lost host, a partition or a frozen VM, is found by an HTTP/2 keepalive ping sent every 10 seconds while a call is open: a ping unanswered for 6 seconds drops the connection and fails that call, and the next command reaches the next member of such a name.
Every call carries etcd's `hasleader` metadata except the calls a member answers from its own state (`Status`, `Defragment`, `LeaseLeases`, a serializable `MemberList`, a serializable `Range`, and a read-only `txn` of serializable gets), so a call that needs the leader fails at once during a lost quorum instead of waiting seven seconds.
A connection whose member has no leader is refused at once with the lost-quorum error, so the provider never connects in a degraded state, and only a provider connected before the loss goes on answering the calls a member answers from its own state.

### 4.5 SSH tunnel

An SSH tunnel is supported, because etcd advertises no address the client follows, so one forward carries every call and the TLS identity rule of section 4.3 keeps verification true through it.

### 4.6 Server versions

etcd 3.7 is tested and claimed; `Status.version` is read at connect and shown, and nothing is refused by version, so a feature an older server lacks fails in that server's own words.
A user who is not root cannot connect to an etcd below 3.7 with authentication on, because it then answers `AuthStatus` and `Status` to the root role alone, and the connect fails in etcd's permission denied (section 4.7).
With authentication off, such an etcd answers both to every caller.
The Storage tab reads the version too: a server before 3.6 sends no storage quota, and 3.6.0 to 3.6.5 send one left at its default as 0, so a 0 from 3.6 or later is read as the 2 GiB default (section 7).
Kubernetes distributions ship older etcd: k3s v1.35.5 embeds etcd 3.6.7, below the nested-transaction RBAC fix of 3.6.9 and the open-ended watch fix of 3.6.14 and 3.7.1.

### 4.7 A user who is not root

etcd refuses a whole range the caller's grants do not cover, so the walks of the tree and the Keys panel read the user's grants at connect (`UserGet` for itself, `RoleGet` for each of its roles) and walk each readable range on its own.
A group keeps the ranges it may read, and every read Studio generates for it reads those ranges and no other bytes; the counts say which scope they cover.
Plan mode's inventory marks a group the user may read only in part as partly readable, beside its name and naming none of the ranges, and tells the model that a read of the whole group is refused and is not to be drafted.
Listing leases needs READ on every leased key in the cluster, and listing users and roles needs the root role, so those folders carry etcd's refusal as a note instead of a list.
etcd lists no permission for the root role, which may read and write every key, so the result of `role get root` carries the warning "The root role may read and write every key, whatever permissions etcd lists for it.", and the root role's Source tab heads its permissions with the same words.
Every walk that reads keys (the prefix groups and their count, a key's Source tab, a Keys panel page, the overview, the Tables tab, and a value edit's build on a read-write connection) reads `AuthStatus` first, and reads the grants again when the auth store's revision has moved since they were read, when authentication has been turned back on, or when a call has met etcd's "revision of auth store is old" since, so a grant an admin changes is seen from the next such walk, whatever token etcd issues.
Where an admin has turned authentication off, the walk reads every key, as a connection made with authentication off does, and reads no grant.
A connection made while authentication was off has no user whose grants to read, so it reads nothing before its walks: if an admin turns authentication on, etcd's own refusal answers its walks until it connects again.
With authentication on, an etcd below 3.7 answers `AuthStatus` and `Status` to the root role alone, whatever the credential (measured on 3.6.0 and 3.6.6), so a connection there that signs in as root reads `AuthStatus` before each walk, as on 3.7.
A user who is not root cannot connect to such an etcd: a client certificate is refused with "etcd refused the auth status: this connection's etcd user is not granted all of it. (etcd: permission denied)", and a password with the same sentence naming "the endpoint status".
Typed commands and the surfaces that walk no key (the member, lease, user and role listings and their Source tabs, health, the Storage tab, the maintenance cards and a value edit's apply) send nothing before their own requests and use the grants as they were last read, so a refusal they meet after such a change can name a range the user has lost, or leave out one it gained, until the next walk.

## 5. Query interface

### 5.1 The grammar

#### Words

The command line is split into words by the POSIX shell's quoting rules: single quotes keep everything literally, double quotes escape only `"`, `\`, `$`, a backquote and a newline, a backslash outside quotes escapes the next character, and a `#` that begins a word starts a comment.
Studio runs no shell, so text a shell would expand or reject is refused rather than taken literally: an unquoted or double-quoted `$` before anything but a blank, the end of the word or a closing double quote; an unquoted or double-quoted backquote; a `~` that begins a word, or follows the `=` or a `:` of an unquoted `NAME=` word; an unquoted `=` that begins a word holding more than it, which zsh expands to a command's path (a lone `=` stays data); unquoted braces holding an unquoted comma, or a `..` whether its dots are quoted or not, which a shell expands into several words, so unquoted JSON such as `{"a":1,"b":2}` is refused; a backslash that ends the text; and an unquoted `;`, `&`, `|`, `<`, `>`, `(` or `)`.
Glob characters are data, as a shell passes them when nothing matches.

#### One command per run

Blank and comment lines before the command are skipped, and so are a leading prompt `$` or `%`, `env`, `ETCDCTL_API=3` and an `etcdctl` word with or without a path, so `./etcdctl put`, `% etcdctl put` and `env ETCDCTL_API=3 etcdctl del` run as pasted.
Any other environment assignment is refused by name, and a command that pipes, reads standard input or passes connection flags is refused naming what it refused.
After any command but `txn`, which reads the lines below it as its body, blank and comment lines are skipped too, and a second command line is refused, naming its line, with the advice to select the line to run, because the editor then sends the selection alone.
Before the command word, and between a command group and its subcommand, the only flag taken is `--command-timeout`: any other is refused, a command's own flag included, which etcdctl runs there when it is written with `=` (`etcdctl --prefix=true get /a/`, `etcdctl member --consistency=s list`), so write it after the command and its subcommand.
The one global flag taken is `--command-timeout=<duration>`, a Go duration, and a value above the connection's query timeout is refused, naming it; Studio applies it to every command it runs, while etcdctl applies it to `get`, `put`, `del`, `lease grant`, `lease revoke`, `member list`, `endpoint`, `alarm` and `auth status`, and for `watch` it is the watch window, refused above the cap of section 5.3.
Every other global flag is refused by name: `--endpoints`, `--user`, `--password`, `--cacert`, `--cert`, `--key`, `--insecure-transport`, `--insecure-skip-tls-verify`, `--insecure-discovery`, `--discovery-srv`, `--discovery-srv-name` and `--auth-jwt-token`, because the connection decides where Studio connects and as whom; `--dial-timeout`, `--keepalive-time` and `--keepalive-timeout`, because the connection decides how Studio keeps its channel to etcd; `--max-request-bytes` and `--max-recv-bytes`, because Studio bounds every request and every answer itself; `--write-out` and `--hex`, because the grid decides the output; and `--debug`, because it switches on etcdctl's own client logging, which Studio does not have.

#### Commands

| Command | Arguments | Flags taken | Class | Confirmation |
|---|---|---|---|---|
| `get` | `<key> [<range_end>]` | `--prefix`, `--from-key`, `--limit`, `--rev`, `--keys-only`, `--count-only`, `--consistency` | read | none |
| `put` | `<key> <value>`, or `<key>` with `--ignore-value` | `--lease`, `--prev-kv`, `--ignore-value`, `--ignore-lease` | write | one click |
| `del` | `<key> [<range_end>]` | `--prefix`, `--from-key`, `--prev-kv`, `--range` | write, destructive with a range | one click for a key; the prefix or start key typed for a range; the connection's name for the whole key space |
| `txn` | the body below | none | read, or write when a branch writes | none, one click, or typed when a branch deletes a range |
| `watch` | `<key> [<range_end>]` | `--prefix`, `--rev`, `--prev-kv` | read, bounded | none |
| `lease grant` | `<ttl seconds>` | none | write | none |
| `lease revoke` | `<hex id>` | none | write, destructive | the lease id typed |
| `lease timetolive` | `<hex id>` | `--keys` | read | none |
| `lease list` | none | none | read | none |
| `lease keep-alive` | `<hex id>` | `--once`, required | write | none |
| `member list` | none | `--consistency`, `l` by default | read | none |
| `endpoint status` | none | none | read | none |
| `endpoint health` | none | none | read | none |
| `alarm list` | none | none | read | none |
| `auth status` | none | none | read | none |
| `user list` | none | none | read | none |
| `user get` | `<name>` | `--detail` | read | none |
| `role list` | none | none | read | none |
| `role get` | `<name>` | none | read | none |

Refused, each with its reason: `--sort-by`, `--order` and the four revision filters, because the server then loads the whole range; `--print-value-only` and `--stream`; a `put` value beside `--ignore-value`, and a `--lease` other than 0 beside `--ignore-lease`; a `del --prev-kv` with a range, because etcd builds that answer whole with no limit; `txn` with `-i` or `--interactive`, because Studio has no terminal to prompt in and reads the body from the lines below `txn`; `watch` with `-i`, `--progress-notify` or a command after `--`; `lease keep-alive` without `--once`; and `--cluster` on `endpoint`.
Refused by name: `compaction`, `defrag` and `alarm disarm`, which are the admin cards of section 8; `member add`, `member remove`, `member update`, `member promote`, `move-leader`, `snapshot save`, `downgrade validate`, `downgrade enable`, `downgrade cancel`, `auth enable`, `auth disable`, `user add`, `user delete`, `user passwd`, `user grant-role`, `user revoke-role`, `role add`, `role delete`, `role grant-permission` and `role revoke-permission`, which this version does not offer; `lock` and `elect`, which block until another client acts; and `make-mirror`, `check perf`, `check datascale`, `endpoint hashkv`, `version`, `completion`, `options` and `help`.
`--` ends flag parsing on every command but `watch`, so a key or value beginning with `-` is written `put -- -key value` or `put key -- -value`.
An empty key with `--prefix` or `--from-key` is the whole key space, and an empty key without either is refused.

#### The txn body

The lines after `txn` are read the way etcdctl reads its standard input: compares, an empty line, success requests, an empty line, failure requests.
A compare is `<target>("<key>") <op> "<value>"` with the targets `create`, `mod`, `version`, `value` and `lease` and the operators `=`, `!=`, `<` and `>`; a quoted key or value is a Go string literal, so `"a\nb"` stores a newline, and a string in backquotes is taken raw.
etcdctl 3.7.2 cannot run a lease compare, because it passes the value as a string and its client library panics with "bad value"; Studio reads the lease id in hex, the spelling of `--lease` and `lease list`, not the README's decimal.
A request line is split the way etcdctl splits it, so `put k it's` is one value, and a quoted word followed directly by another character, or a quote left open, is refused.
A `#` line directly above a compare or a request, or after the last section, is a comment; any other `#` line is refused, because it would make an empty section.
A ranged `get` in a txn, other than a `--count-only` one, is sent with its `--limit`, or with `ETCD_READ_BOUNDS.firstPageSize` when none is typed, and a `--limit` above `ETCD_READ_BOUNDS.firstPageSize` is refused, naming it, because etcd builds a txn's whole answer at once and cannot page it.
A branch whose rows could pass the row limit is refused.

### 5.2 Result shape

Every write answers at least one row: `put` answers `key` and `revision`, `del` answers `deleted` and `revision`, and `txn` answers `succeeded` and `revision` and then one row per executed request.
A key or value that is not UTF-8 is shown as base64, a key beside its own `key_encoding` column, and a value beside `value_encoding`, which is `withheld`, `kubernetes-cbor`, `kubernetes-json`, `json`, `text` or `base64`, as is a previous value's `prev_value_encoding`.
A value whose cell would pass the cell bound of section 5.4 is shown cut, a base64 one at a whole group of three bytes so that it still decodes, and its encoding gains `, cut`, such as `text, cut` or `base64, cut`, with one warning counting the cut values; a key and a label are never cut.
Revisions, versions, counts and TTLs are decimal strings, a member id is lowercase hex without padding, and a lease id is 16 lowercase hex digits; either id is read in any padding and case, though a lease id is never read with a sign.
etcd also grants a lease id a client chose, a negative one included, which `lease list` and a key's `lease` column print as Go's `%016x` prints it, the sign counted within the minimum width of 16 characters, as in `-000000000000005` for `-5`: Studio does not address such a lease, so every command that takes a lease id refuses one with a sign before any request, and the Leases folder leaves the lease out (section 6.1).

### 5.3 The bounded watch

A watch runs for its window, `--command-timeout` when given, else 5 seconds, and the window's cap is the connection's query timeout less `ETCD_READ_BOUNDS.watchMarginMs`: a `--command-timeout` above the cap is refused, naming it, a default window longer than the cap is shortened to it and its warning says so, and a query timeout at or below the margin leaves no window, so a watch is refused.
A watch ends early at the row limit or the byte budget, and its end is one warning naming the range, the window and the cause.
A compaction, a permission refusal or a server cancellation ends the watch as an error, never as a quiet window; the stream is always cancelled when the watch ends.
A watch etcd refuses with one of the three answers of section 4.2 is created once more after the one sign-in; when its window closes before that sign-in answers, it ends with etcd's refusal, since it watched nothing, while a cancel or the query timeout met then still reads as a cancel or a timeout.
A live watch panel is filed as U56.

### 5.4 Bounds

| Bound | Value | What it bounds |
|---|---|---|
| `DEFAULT_QUERY_LIMIT` | 500 | The rows of one result; a `--limit` above it is refused |
| `ETCD_READ_BOUNDS.firstPageSize` | 100 | The first page of a paged `get`, and a ranged `get` in a `txn` |
| `ETCD_READ_BOUNDS.maxPageSize` | 500 | The largest page the paged `get` grows to |
| `ETCD_READ_BOUNDS.byteBudget` | 8,388,608 | The bytes of keys and values a `get` or a `watch` holds; a `txn` is bounded in its request instead, and its answer by the receive cap |
| `ETCD_READ_BOUNDS.cellLimit` | 65,536 | The characters of one value's cell, cut at a character boundary, its encoding then gaining `, cut` |
| `ETCD_READ_BOUNDS.watchMarginMs` | 1,000 | The milliseconds a watch at the cap leaves before the query timeout |
| `ETCD_RECEIVE_CAP_BYTES` | 16,777,216 | The largest single answer the channel accepts |

Every page of one read is pinned to its first page's revision, and a read the budget stops answers the rows it holds with a warning naming the bound and the key it stopped before.
The six lists etcd answers whole, from `lease list`, `lease timetolive --keys`, `user list`, `role list`, `user get --detail` and `role get`, show their first `DEFAULT_QUERY_LIMIT` entries with a warning naming how many etcd answered, since only the receive cap bounds them on the wire.
etcd's `Range` limits a page by its count of keys alone, so a page whose answer the receive cap refuses is asked again from the same key and revision with half its limit, and the read goes on from that size; only a single key larger than the cap fails, naming the cap (measured: twenty values of 1 MiB answered 20,972,150 bytes, past the 16 MiB cap, at a first page of 100).
An answer past the receive cap to a `put` or `del` says that etcd applied the write, and to a `txn` that one of its branches ran, because etcd answers a write only after applying it.
Bound `params` are refused with a `DatabaseConfigError` before any request, and an empty list binds nothing and is not refused: an etcdctl command has no placeholders, and ignoring the values would run a different command from the one the caller built.

### 5.5 Cancellation and the confirmation gate

Cancelling a read or a watch stops it; a write already sent is not stopped and the cancel answers false, because aborting the call cannot undo a request etcd may have applied, so its outcome is unknown until the key is read again.
The confirmation gate reads the provider's own parser, so what runs and what asks are one parse, and it never sends an etcd statement to the model provider.
A prefix delete asks for the prefix typed exactly, `/app/` and `/App/` being different prefixes; a key holding a newline is typed in Go's quoted form.

## 6. Schema introspection

### 6.1 The object surface (#789)

#### Kinds and folders

| Kind | Folder | Row | Source |
|---|---|---|---|
| `prefix` | Key Prefixes | the group, `/apisix/routes/*` | none |
| `key` | none: the Keys panel | the key | the value and its metadata |
| `member` | Members | `<name> (<id>)`, with its alarms as its status | JSON |
| `lease` | Leases | the lease id | JSON |
| `user` | Users | the user name | JSON |
| `role` | Roles | the role name | JSON |

Leases leaves out a lease with a negative id, which Studio does not address (section 5.2), and its count is then a floor that says how many it left out.

#### The prefix-group rule

Groups are disjoint key ranges decided by the set of keys, never by their order.
For each first segment `F`, if every key under `F/` has exactly two segments, `F/*` is one group; otherwise every key of three or more segments belongs to the group of its first two segments, `F/S/*`, and `F`'s two-segment keys belong to no group.
A key of one segment belongs to no group, and so does a key whose first segment is not UTF-8, or whose second segment is not UTF-8 under a deep first segment.
So APISIX's `/apisix/plugins` beside `/apisix/routes/1`, a flat configuration key such as `/feature-flag`, and `compact_rev_key` belong to no group and are reached through the Keys panel, or with a typed `get` in the embedded workspace, which hides the panel.
No row is named after a key: every group ends in `/`, is drawn with a trailing `*`, and is read with `--prefix`.

#### Listing, counting and scale

| Bound | Value | What it bounds |
|---|---|---|
| `ETCD_GROUP_CAP` | 1,000 | The groups one walk records, below the inventory's 5,000 |
| `ETCD_WALK_KEY_CAP` | 100,000 | The keys one walk reads |
| `ETCD_WALK_SEGMENT_BUDGET` | 20,000 | The keys one first segment may take before it is recorded undecided |
| `ETCD_WALK_FIRST_PAGE` | 100 | The walk's first page, grown while pages stay small |
| `ETCD_TABLE_STATS_CONCURRENCY` | 8 | The per-group counts of the Tables tab in flight at once |

The walk reads keys only, at one revision, and jumps past a group once a page has found it.
Past a cap the Key Prefixes count is a floor counted from "one key-prefix walk capped at G groups", "one key-prefix walk that stopped after S keys" or "one key-prefix walk that read at most P keys under any one prefix", with G, S and P the values of `ETCD_GROUP_CAP`, `ETCD_WALK_KEY_CAP` and `ETCD_WALK_SEGMENT_BUDGET` above, and the tree badges it.
A first segment that reaches the per-segment budget is listed as `F/*`, titled "At least P keys; this prefix was not read to the end, so its deeper groups are not listed".
A compaction between the pages of the walk is reported as such, and the walk is run again.
Members come from a serializable `MemberList`, so during a lost quorum a provider connected before the loss still lists the Members folder, while the key-prefix walk fails at once with the lost-quorum error and a new connection is refused (section 4.4).

### 6.2 Object source (#789)

A key's Source tab shows its value, as JSON when it parses as JSON and as plain text otherwise, and its metadata: `create_revision`, `mod_revision`, `version`, the lease with its TTL, `value_encoding` and `value_bytes`.
A value that is not UTF-8 is shown as base64 and is not editable; a withheld value shows its label; an empty value reads "The value is empty (0 bytes)." and a whitespace-only one "The value holds only whitespace (N bytes).", and either is edited with a typed `put`.
A member's source holds its URLs and, for the member this connection reaches only, its `Status`; a lease's source its TTLs and keys; a user's its roles; and a role's its permissions, with `prefix` where a range is exactly a prefix range.

### 6.3 Object edit (#789)

A key's value is the one thing the product writes on its own, through the Source tab's edit, and it is written as one guarded etcd transaction.
The build reads the key once, for its value and its `mod_revision`, and issues a plan whose unit is that transaction in etcdctl's txn words, in the order etcdctl's txn format writes them: the compare `mod("<key>") = "<mod_revision>"`, the success `put --ignore-lease <key>` with the edited text as the value, and the failure `get <key>`.
The compare's key is Go-quoted, the put's and the get's are txn request words, and a key that begins with `-` is written after `--` in both.
The preview shows the unit with the value counted, for example `txn mod("/app/cfg") = "7" put --ignore-lease /app/cfg <value, 12 characters> get /app/cfg`.
`--ignore-lease` keeps a lease attached to the key, and the failure `get` reads the key in the same round trip, which also gives kine, the k3s datastore, the one update shape it accepts.

The apply parses the unit with the editor's own parser and sends exactly that transaction, built from the unit alone, and a plan whose keys or compare revision differ from what it is addressed to is refused before any request.
The outcome is `applied` when the compare holds, and `conflict`, with the value the key holds now, when it was changed since the build read it.
It is `refused`, with nothing written, through a read-only provider, for a key deleted since the read, and for an answer etcd gives before it can apply a write, such as "request is too large" or a permission denied.
"database space exceeded" is answered after etcd applied the write, so the provider reads the key once: a `mod_revision` still equal to the plan's proves nothing was written and is `refused`, and any other reading is `interrupted`.
Every other answer after the send is `interrupted`, with `committed: "unknown"`, because the write can still commit.

The edit is not offered, and the Source tab says why, for a key's metadata ("etcd keeps a key's metadata itself: only its value is edited."), a value that is not UTF-8 text ("The value is not UTF-8 text, so it is shown as base64 and is not edited here."), an empty or whitespace-only value, a value Studio withholds, a value longer than the Source tab shows, and a key the connection's etcd user may read but not write.
A text identical to the stored value is refused with "This text is identical to the value etcd holds."
Deletes and creates are typed commands, `del` and `put`: no kind declares `acceptsRowWrites`, so the grid offers no row insert, delete or cell edit, and Import Data offers no etcd target.
The pair `["etcd", "key"]` in `EXPECTED_EDITABLE_KINDS` ([`tests/helpers/object-edit-expectation.ts`](../../tests/helpers/object-edit-expectation.ts)) holds the declaration and this section together.

### 6.4 The Keys panel

The Keys panel walks the key space with `/` as its separator, one keys-only page at a time from a cursor pinned to the first page's revision, `ETCD_KEY_SCAN.defaultCount` keys a page by default and `ETCD_KEY_SCAN.maxCount` at most.

| Bound | Value | What it bounds |
|---|---|---|
| `ETCD_KEY_SCAN.defaultCount` | 500 | A page when the panel names no size |
| `ETCD_KEY_SCAN.maxCount` | 1,000 | The largest page the panel may ask for |

The pattern box takes a prefix, not a glob: `/app/*` walks `/app/` and never `/apple/x`, and a `*` typed elsewhere is data.
The total is the exact count of the keys the walk covers at its revision, and for a user who is not root, of the keys under the ranges it may read.
A key that is not UTF-8 is left out and counted on one line, because a key decoded with replacement characters would address another key.
Scan all stops after 10,000 keys, and a key left out counts toward that cap as a named key does, because etcd read it and it took its room on the page.
Activating a key opens its Source tab; a compaction between pages asks to start the walk again, and so does a page that would read other ranges than the walk's first page, after the grants were read again (section 4.7) or under another prefix.
The embedded workspace ships no Keys panel; a key is read there with a typed `get`.

## 7. Monitoring & health

Health reads `Status` of the member this connection reaches, then the alarm list, which covers every member, and raises instead of answering healthy in two cases: a member with no leader raises the lost-quorum error, and an alarm raised on any member raises "etcd reports active alarms: ...", naming every alarm and the Admin > Operations card that disarms them once their cause is fixed.
Test Connection then reports the connection as connected but degraded, with that sentence, and fleet health reports it as an error.
The overview gives the version, the exact key count and the member's size on disk; for a user who is not root the count covers the ranges it may read and the Tables card says so.
Storage is one row for the answering member, its usage the size on disk over the quota the member runs under, a quota of 0 from 3.6 or later read as the 2 GiB default (3.6.0 to 3.6.5 send the flag's 0, and 3.6.6 and later answer the default themselves), and "-" when the quota is disabled (a negative `--quota-backend-bytes`) or not reported (a server before 3.6 sends none); the Tables tab counts each group's keys when it opens, "The key-prefix groups; a key in no group is counted in the Overview and not here".
etcd keeps no query log and reports no client sessions, and its performance metrics are not read.

## 8. Maintenance

Three cards of Admin > Operations, each for an admin, each audited, and each confirmed by typing the connection's name:

| Operation | Label | Title | Description |
|---|---|---|---|
| Compaction | "Compact history" | "Compact history" | "Removes every revision before the current one. History reads before it fail, and a watch from an older revision is cancelled." |
| Defragmentation | "Defragment" | "Defragment the member" | "Rebuilds the database file of the member this connection reaches, and only that member. That member blocks reads and writes while it runs." |
| Alarm disarm | "Disarm alarms" | "Disarm alarms" | "Clears every raised alarm. Defragment every member that alarm list names first: a NOSPACE alarm comes back on the next write if the database is still over its quota." |

On an etcd with auth on, all three need the etcd root role, and a refusal reads "Compaction, defragmentation and alarm disarm need the etcd root role; this connection signs in as <user>".
A NOSPACE recovery is compaction, then defragmentation of every member that `alarm list` names, one at a time and through one connection per member, then disarm, because defragmentation is not replicated and one connection reaches one member.
A read-only connection offers none of the three.

## 9. Capabilities & labels

`queryLanguage: "json"` with `queryDialect: "etcd"`, `tablesAreDerivedGroupings: true`, `containerLevels: []`, `defaultPort: 2379`, `enforcesReadOnly: true`, and `false` for explain, table creation, transactions, inline row edits, result pagination, external query limiting, connection strings and foreign keys.
A key-prefix row is labelled "Key Prefix", its rows "Key", its read "Get Keys" and its generator "Generate Command"; a click on a group runs `get <group> --prefix --limit=50`, and Generate Command writes that read with the other forms commented below it, or the read alone on a read-only connection.
A group whose prefix holds a carriage return, a line separator (U+2028) or a paragraph separator (U+2029), which the editor does not keep as the command line spells them, is read through a `txn` whose `get` names the prefix in Go quoting, and Generate Command's one other form for it is the commented `txn` template.

## 10. Error handling

A failure before the request left Studio is a connection error; "etcdserver: no leader" is a lost quorum with nothing applied; a write that met a failure after it was sent says that it may have been applied and that the key should be read again before the command is run again; a read's deadline is a timeout; a permission refusal names the command, the range and what the user may read, "etcd user reader may read: /app/ (prefix), /config/a"; and every other answer is etcd's own words after Studio's.
The tree's Key Prefixes listing and the Tables tab's per-group counts, whose refusals the agent reads as well, name what the user may read as every key or as how many ranges instead, "etcd user reader may read: 2 ranges", and the listing names no range it asked for, because each is one of the user's grants and may be a single key.
The token, the password and a value never reach an error.
A key is named in every message as etcdctl's command line takes it: bare when it reads back as itself, shell-quoted otherwise, and in Go's `%q` form when it holds bytes that are not UTF-8 or a rune Go's `%q` escapes, such as a control character, a bidi override or a zero-width space.
A lease id past the largest int64, or written with a sign, is refused before any request.

## 11. Testing

### 11.1 How the tests work

The unit tests drive each module through a fake client, the integration test drives the provider over the real adapter and answers captured from etcd 3.7.2 (`tests/fixtures/etcd/`), and the TLS tests run real handshakes against local servers under Bun and Node.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/integration/db/etcd-provider.test.ts
bun run test
```

### 11.3 The live fixtures

`database-compose.yml` holds `etcd` (127.0.0.1:2379), `etcd-cluster` (127.0.0.2 to 127.0.0.4, port 2379), `etcd-auth` (12379, TLS with client certificates) and `etcd-auth-password` (12479, TLS with a password); [`docker/etcd/README.md`](../../docker/etcd/README.md) says how to start and seed them and what each key is for.

### 11.4 The live check

`tests/live/etcd-live-check.ts` runs a real `EtcdProvider` against the fixtures of section 11.3 and fails on any change it made outside its scratch prefix `/libredb-live-check/` (keys, values, revisions, leases, users and roles), after driving every refusal of section 3.2 and the three read-only arms of section 3.4 live.
It runs by hand, once per fixture, with the fixtures' certificates copied out as `docker/etcd/README.md` shows: `ETCD_LIVE_CERTS=/tmp/etcd-auth-certs bun tests/live/etcd-live-check.ts --service etcd`, and the same with `etcd-cluster`, `etcd-auth` or `etcd-auth-password`.
The measurements below take flags of their own: `--ke14` and `--ke15` add KE14 and KE15 to the `etcd-cluster` run, `--ke12` adds KE12 to the `etcd-auth-password` run, and `--ke16` alone runs the five-minute KE16 watch against `etcd`.
The 401,440-key numbers and the watch at the cap come from `--service measure --seed` and then `--service measure`, against an etcd that no compose file defines: TLS on 127.0.0.1:2389 with a certificate that names 127.0.0.1 and chains to the CA in `ETCD_LIVE_CERTS`, no authentication, and the container name `libredb-etcd-measure`, which the member-size readings ask `docker stats` for.
KE13 comes from `--drive-cluster-container <bundle dir>`, which runs a Node build of the live check in a `node:26.10.0-trixie-slim` container on the network `etcd-lane-e_default`, so the compose project has to be named `etcd-lane-e`; KE8 comes from `tests/live/etcd-tunnel-check.ts`, with `LIVE_SSH_PASSWORD` set and an SSH bastion on 127.0.0.1:12222 that the repository does not define either; and no committed command makes the ten-second KE16 run.
Measured on 2026-10-01 against etcd 3.7.2, with every before and after snapshot identical: 92 of 92 checks passed on `etcd`, 99 of 99 on `etcd-cluster` with the KE14 and KE15 measurements, 98 of 98 on `etcd-auth` as root and as the reader, and 79 of 79 on `etcd-auth-password`.
The walk's bounds of section 6.1 and the read bounds of section 5.4 were measured on 401,440 keys (200,000 in one flat directory sorting first, 200,000 under 1,000 groups, and values of 64 KiB and 1 MiB): the tree's walk took 290 ms and its count read "one key-prefix walk that stopped after 100,000 keys"; the table statistics of its 388 groups took 350 ms; a get of twenty 1 MiB values answered 7 rows in 99 ms with the member at 320.6 MiB before and 421.2 MiB after, and a get of 1,000 values of 64 KiB answered 127 rows in 48 ms with the member at 421.2 MiB before and 433.7 MiB after, each stopped by the byte budget.
A watch at the cap returned 10 ms after its window at a query timeout of 5,000 ms, so the margin stays 1,000 ms.
Through the network alias the three members of `etcd-cluster` share inside the compose network, stopping the answering member cost 0 reads, the next read answered from another member in 2 ms, and no pause between two write answers passed 28 ms, under Node v26.10.0 (KE13).
On `etcd`, under Bun 1.4.2 and Node 24.14.0, the keepalive's pings during a 32-second quiet watch and at calls made after 11 seconds idle were all answered, while a channel that pinged every 2 seconds was closed after 8 seconds by etcd's too_many_pings GOAWAY; no committed command makes this run.
With two of three members stopped, endpoint status, a serializable get, a serializable member list, lease list, a read-only txn of serializable gets and defragment answered in 2 to 14 ms, and the linearizable get and member list failed within 2 ms with the lost-quorum sentence (KE14).
Sent with the `hasleader` metadata to the same member, each of those six failed with "etcdserver: no leader" under Bun and Node (the six `etcd-cluster/*-no-leader-hasleader` captures of `tests/fixtures/etcd/`, 2026-10-01), which is why section 4.4 sends them without it.
A value edit whose Txn met its deadline while two followers were paused was applied in 3 of 3 runs, and every one was reported as possibly applied; a top-level put in the same state was never sent, because the read before it met its deadline first (KE15).
A write that met `etcdserver: invalid auth token` or `etcdserver: user name is empty` was not applied, so such a write is sent once more after its one renewal; no write could be made to meet `etcdserver: revision of auth store is old`, so a write that does keeps the sentence that it may have been applied (KE12).
A five-minute watch under Bun saw 297 of the 298 writes made one a second from its start to its close, with no stall and its slowest paged read taking 11 ms, and a ten-second watch at 23 writes a second saw every one of 232 writes in three runs of three (KE16).
Through a real SSH tunnel, `verify-full` accepted the far end's name and refused an address the certificate does not carry (KE8).

## 12. Connecting to a Kubernetes control-plane etcd

Managed Kubernetes services (EKS, GKE, AKS) do not expose their etcd at all, so there is nothing to connect to; this section is for a cluster you run.
A default k3s uses kine, not etcd, and exposes no network etcd; k3s runs etcd only when started with `--cluster-init`.
Open an SSH tunnel to a control-plane node, and connect as the node sees etcd: Host `127.0.0.1` and Port `2379`, which kubeadm's etcd server certificate names beside `localhost`; read the names of a k3s server certificate before you rely on `127.0.0.1`.
Choose SSL mode `verify-full`: through the tunnel Studio checks the certificate against `127.0.0.1`, the far end the tunnel names, and never against its local forward.
On kubeadm the CA is `/etc/kubernetes/pki/etcd/ca.crt` and a client certificate and key are `/etc/kubernetes/pki/etcd/healthcheck-client.crt` and `/etc/kubernetes/pki/etcd/healthcheck-client.key`; on k3s they are `/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt`, `/var/lib/rancher/k3s/server/tls/etcd/client.crt` and `/var/lib/rancher/k3s/server/tls/etcd/client.key`; all of them are readable by root only.
etcd authentication is off on both, so that certificate reads and writes everything, and it belongs only in the two managed seeds of section 3.4.
Put the CA, the certificate and the key in a Kubernetes Secret and pass them to Studio as environment variables, with `extraEnvFrom` and a `secretRef`, or with `extraEnv` and `valueFrom.secretKeyRef`, which maps a file-named key such as `ca.crt` to a variable such as `ETCD_CA`; then the seed file references them as `ssl.caCert: "${ETCD_CA}"`, `ssl.clientCert: "${ETCD_CLIENT_CERT}"` and `ssl.clientKey: "${ETCD_CLIENT_KEY}"`, and a multi-line PEM passes through unchanged.
A variable name matches `^[A-Z_][A-Z0-9_]*$`, so a Secret passed whole with `extraEnvFrom` has keys of that shape.
Never put the client key in `seedConnections.config`: that value is a ConfigMap, and a ConfigMap is not a secret.
Studio refuses every write under `/registry/` and to `compact_rev_key`, and withholds every Secret and every protobuf or encrypted object; what remains writable is what etcd holds outside Kubernetes' own roots.
kube-apiserver compacts etcd every 5 minutes, so Compact history is for a NOSPACE recovery only, and it forces every watcher behind the current revision to list again; a Keys panel walk that a compaction overtakes asks to start again.

## 13. Known limitations

- A `put`'s value is part of the statement text, so it reaches query history and saved queries, as a Redis `SET` does.
- A user who can open a connection can always read what etcd lets its credentials read.
- The editor path writes no audit event for any engine: only the value edit of the Source tab and the maintenance cards are audited.
  An editor-path audit for every engine is filed as U55.
- `readOnly` binds a `user` only on a managed seed and only where etcd authenticates the client; a saved connection puts its credentials in the user's browser, and the user can clear the toggle.
- A read-only seed restrains only the seeded connection: a `user` can post a connection of their own to the same host and port.
  On an etcd that authenticates nobody, it restrains nobody who knows the address.
- Cancelling a write in the editor shows it as cancelled even when etcd applied it: read the key again before you run the command again.
  The editor's handling of the cancel route's answer is filed as U61.
- Kubernetes writes are refused by prefix, and by content only where a single-key write meets a stored envelope: under a custom prefix, a range write, a value written between a `txn`'s read of its single-key targets and its send, a `lease revoke`, a new key, and a key holding Kubernetes JSON or CBOR are not recognised.
- A secret stored under a custom prefix in an envelope Studio does not know is shown.
- A connection names one endpoint; a list of endpoints with failover is filed as D131.
- A Kubernetes protobuf value is withheld, never decoded; decoding it behind the label is filed as D130.
- The watch is bounded; a live watch panel is filed as U56.
- The connection dialog sends a client certificate the current SSL mode no longer draws, filed as U60.

## 14. References

- The design: issue #1089, "Cloud-native control plane".
- etcd's API reference and its authentication guide, v3.7.
- [`docker/etcd/README.md`](../../docker/etcd/README.md) and [`tests/fixtures/etcd/README.md`](../../tests/fixtures/etcd/README.md).
