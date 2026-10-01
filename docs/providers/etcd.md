# etcd Provider

The `etcd` type-id: read-write key-value browsing over etcd's gRPC API, tested and claimed on etcd 3.7.2.
Source: [`src/lib/db/providers/keyvalue/etcd/`](../../src/lib/db/providers/keyvalue/etcd/).
Tests: [`tests/unit/db/etcd/`](../../tests/unit/db/etcd/) and [`tests/integration/db/etcd-provider.test.ts`](../../tests/integration/db/etcd-provider.test.ts).
Tracking issue: [#1089](https://github.com/libredb/libredb-studio/issues/1089), under [#424](https://github.com/libredb/libredb-studio/issues/424).

## 1. Overview

Studio reads and writes an etcd cluster through a subset of `etcdctl`'s command line, shows its keys as prefix groups in the object tree and every key in the Keys panel, edits a key's value through a guarded transaction, and offers compaction, defragmentation and alarm disarm to an admin.
It is Kubernetes-aware: every write that touches a Kubernetes key prefix or kube-apiserver's `compact_rev_key` is refused before any request, a Kubernetes protobuf or encrypted value and every secret are withheld on every surface, and a Kubernetes JSON or CBOR value is shown with its label.
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

## 3. Design decisions

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

## 6. Schema introspection

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
