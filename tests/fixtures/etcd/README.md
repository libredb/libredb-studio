# etcd fixtures

Verbatim answers of etcd v3.7.2 to `@grpc/grpc-js` 1.14.5, captured from the services of `database-compose.yml` before any provider code was written (spec 10, gate 4).
A test that needs a real etcd answer loads one of these files through `tests/helpers/etcd-fixtures.ts` instead of writing its own, and the provider's integration test runs the real adapter over the recorded transport that helper builds.
The capture harness is `tests/live/etcd-evidence.ts`, run by hand and never by `bun run test`.
It calls every surface separately, records a pass or the verbatim error, and renders the three generated blocks below from the files and its run report, so no value in them was typed by hand.

## Provenance

The servers, their seeded keys, their users and roles, and their certificates are those of `docker/etcd/README.md`.
Every server runs the image `database-compose.yml` pins by digest, read from the running container when the harness starts.
Every capture names that image and digest, the cluster, and the member that answered it, from the answer's header or, for an answer without one, from the member's own `Status`.
A capture that no member answered names `none`: a refused socket, a TLS failure, a deadline before any answer, a connection the harness dropped, an answer past this client's receive cap, and a cancel on the client.

<!-- generated:provenance -->
| Service | Image | Digest | Cluster id | Members that answered | Captured | Runtimes |
|---|---|---|---|---|---|---|
| `etcd` | `gcr.io/etcd-development/etcd:v3.7.2` | `sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3` | 15812935348987335903 | 13653403111078390177 | 2026-09-30T16:29:55.373Z to 2026-09-30T21:29:29.912Z | bun 1.4.2, bun 1.4.2 and node 24.14.0, node 24.14.0 |
| `etcd-cluster` | `gcr.io/etcd-development/etcd:v3.7.2` | `sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3` | 4743283766027114114 | 14609290428206289688, 8857620542826090066 | 2026-09-30T16:29:59.127Z to 2026-09-30T16:30:11.001Z | bun 1.4.2, bun 1.4.2 and node 24.14.0, node 24.14.0 |
| `etcd-auth` | `gcr.io/etcd-development/etcd:v3.7.2` | `sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3` | 18242060571022570213 | 1380394221505655472 | 2026-09-30T16:30:12.393Z to 2026-09-30T16:30:12.689Z | bun 1.4.2, bun 1.4.2 and node 24.14.0, node 24.14.0 |
| `etcd-auth-password` | `gcr.io/etcd-development/etcd:v3.7.2` | `sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3` | 9341064349964996272 | 11100594549813706834 | 2026-09-30T16:30:12.737Z to 2026-09-30T16:31:01.747Z | bun 1.4.2, bun 1.4.2 and node 24.14.0 |
| `transport` | `none` | `none` | none | none | 2026-09-30T16:31:03.464Z to 2026-09-30T16:31:03.607Z | bun 1.4.2, node 24.14.0 |
<!-- /generated:provenance -->

## How they were captured

```sh
docker cp libredb-etcd-auth:/certs <a directory outside the repository>
bun tests/live/etcd-evidence.ts --certs <that directory> --report <a report file outside the repository>
bun tests/live/etcd-evidence.ts --readme --report <the same report file>
```

The data rows run under Bun.
The error rows, every row of spec 5.6 and each step of spec 6.1's connect sequence (KE6), run under Bun and again in a Node child process of the same harness.
Every key the harness writes is under `/libredb-evidence/`, and it deletes that prefix and revokes its one lease before the first snapshot and after the last row.
The history that `etcd/range-history-rev` and `etcd/watch-history` read is the harness's own, three versions of `/libredb-evidence/history`, and not the seeded `/history/counter`, so a run does not need a server that was never compacted.
The rows that change a server for the rows after them run last on their server: `etcd/compact` and the two rows that read the compaction, `etcd-auth/compact-root`, the NOSPACE alarm the harness raises with `Alarm` ACTIVATE on `etcd-cluster` and disarms, and `etcd-auth-password/error-auth-revision-old`.
The quorum-loss rows stop members 2 and 3 of `etcd-cluster` and start them again, and two deadline rows pause one container for about a second.
A run compacts `etcd` and `etcd-auth` to their current revision, so `/history/counter` no longer answers at its first two revisions there: remove those two containers and seed them again, as `docker/etcd/README.md` says, before anything reads that history.
`etcd/range-prefix-registry-slashless` was taken again after that run, alone, with `--only etcd/range-prefix-registry-slashless --out tests/fixtures/etcd`, once the seed had renamed the slash-less Secret's data entry and that one key had been deleted and seeded again on every server, so its revisions are past the run's.

## Encoding

Each file is `{ "$captured": {...}, "outcome": "pass" | "fail", "payload": ... }`.
`$captured` holds `service`, `image`, `digest`, `clusterId`, `memberId`, `date`, `runtime`, `rpc` (`<service>/<method>` of `etcdserverpb`), `surface`, `request` (as sent), `match` (the request fields that select the capture) and `metadata` (`hasleader`, and a `token` written as `<token>`).
A `bytes` field is `{ "$bytes": "<base64>" }`, revived to a `Buffer`.
Bytes of 65,536 or more that are one repeated byte are `{ "$filled": { "byte": <0 to 255>, "length": <count> } }`, revived to a `Buffer` of that length filled with that byte: the 300,000 bytes of `/values/large`, and the 1,600,000 and 2,200,000 bytes the two size rows send.
A 64-bit integer field (`int64` or `uint64` in the descriptor) is `{ "$int64": "<decimal digits>" }`, revived to that decimal string, which is what `longs: String` hands over.
Every other field is as grpc-js decoded it with the adapter's loader options: the field names the `.proto` files spell, enums by name, every absent field at its default, and each oneof's name as a virtual field.
A failure's payload is `{ "class", "message", "code", "details" }` for a gRPC status, revived to an `Error` carrying those own properties, so `toEtcdError` classifies it as it classifies the live one.
A stream's payload is `{ "messages": [...], "end": ... }`, where `end` is `"open"` (the stream stayed open until the harness cancelled it), `"server-end"`, or `{ "error": <a failure> }`.
`runtime` names both runtimes when they answered alike; a row whose two answers differed, and every TLS, socket and deadline row, is two files, `<name>.bun.json` and `<name>.node.json`.
No password, token, private key or certificate is in any file: a field named `password` or `token` is written as `<password>` or `<token>`, and the harness refuses to write a file that holds a password it read or a token it received.
The seeded marker `libredb-fixture-secret` is there on purpose, inside the bytes of `/registry/secrets/default/db-creds` and `registry/secrets/default/legacy`, because E9's tests search every answer for it.
In `registry/secrets/default/legacy` it is the base64 value of the data entry `marker`, because the required Secret Scan's gitleaks decodes a capture's base64 and read the same entry named `password` as a leaked credential.

## The run: E15 and what it moved

Before and after the whole run the harness read each server's key space outside `/libredb-evidence/` (keys, values, create revisions and leases), and the protected subtree and `compact_rev_key` with their mod revisions and versions, and required the two readings to be identical (spec E15).
A server's revision before the run is past the seed's 37 where an earlier run of the harness had already written and deleted its scratch keys there.

<!-- generated:run -->
| Server | Keys before | Keys after | Leases | Revision before | Revision after | E15 |
|---|---|---|---|---|---|---|
| `etcd` | 34 | 34 | 2 | 67 | 80 | identical |
| `etcd-cluster` | 34 | 34 | 2 | 43 | 46 | identical |
| `etcd-auth` | 34 | 34 | 2 | 37 | 39 | identical |
| `etcd-auth-password` | 34 | 34 | 2 | 37 | 37 | identical |

- etcd: compacted to revision 80, so no read or watch before it answers.
- etcd-cluster: a NOSPACE alarm raised on member 14609290428206289688 with Alarm ACTIVATE, then disarmed.
- etcd-cluster: members 2 and 3 stopped for the quorum-loss rows, then started again.
- etcd-auth: compacted to revision 39 as root.
- etcd-auth-password: AuthRevision 217 to 233, by granting the reader role its own READ on /config/a again, once per attempt of the two auth revision rows; the role's grants are unchanged.
<!-- /generated:run -->

## What the captures show

- On `etcd-auth`, a `Range` over a certificate with no Common Name and no token answers "etcdserver: permission denied", not "etcdserver: user name is empty"; the empty user name is an admin check's answer, which `userGet` of another user meets (`etcd-auth/error-user-name-empty`), and so is a `Range` with no token on `etcd-auth-password` (`etcd-auth-password/error-range-no-token`), spec E4's answer when the token is missing.
- A `DEACTIVATE` with member id 0 answers without an error and clears nothing: the alarm is still listed for `etcd-cluster/alarm-disarm`, whose `DEACTIVATE` names the member.
- With `--auth-token=simple`, which both auth servers run, a token carries no auth revision: a token issued before an auth change still reads (`etcd-auth-password/range-token-before-auth-change`), and "etcdserver: revision of auth store is old" answers only a request that was in flight while the auth revision moved, so `etcd-auth-password/error-auth-revision-old` sends reads beside a grant until one meets it.
- Granting a user a role it already holds moves no auth revision; granting a role a permission it already holds moves it by one and leaves the role's grants as they were.
- Over a new channel to a paused member, whose kernel still completes the TCP handshake, Node never gets a ready channel and the deadline reads "Waiting for LB pick", while Bun 1.4.2 takes the channel as ready, sends the call, and the deadline carries `remote_addr=` (`etcd-cluster/error-deadline-before-pick.node` and `.bun`).
- A deadline of 1 ms against a name that does not resolve can lose to the resolver, and the call then fails as UNAVAILABLE "Name resolution failed for target ..."; `transport/error-deadline-name-resolution` sets a deadline that has already passed, which always reads "waiting for name resolution".

## Texts pinned from error.go, not provoked

The harness does not provoke the answers below, because each needs a cluster that is slow to commit, loses its leader in the middle of a request, or is overloaded.
Their texts are pinned from etcd v3.7.2's `api/v3rpc/rpctypes/error.go`, each with the gRPC code it carries:

| Text | Code |
|---|---|
| `etcdserver: request timed out` | Unavailable |
| `etcdserver: request timed out, possibly due to previous leader failure` | Unavailable |
| `etcdserver: request timed out, possibly due to connection lost` | Unavailable |
| `etcdserver: request timed out, waiting for the applied index took too long` | Unavailable |
| `etcdserver: leader changed` | Unavailable |
| `etcdserver: server stopped` | Unavailable |
| `etcdserver: too many requests` | ResourceExhausted |

## Rows told apart only by name

The recorded transport answers a call from the capture whose `match` the request carries, the one naming the most fields first, and then the first by name.
It never answers from a capture split per runtime, or from one that no member answered, because no request means one of those by its fields alone.
Some rows answer the same request differently because the server's state differed, so a test that means the second reads it by name through the transport's `answers`:

- `etcd/lease-keep-alive` and `etcd/lease-keep-alive-expired`: before and after the revoke.
- The five `Status` rows of `etcd-cluster`: the leader, a follower, member 2 around its defragmentation, and member 1 without a quorum.
- `etcd-auth-password/error-range-no-token`, `etcd-auth-password/error-invalid-auth-token`, `etcd-auth-password/error-auth-revision-old` and `etcd-auth-password/range-token-before-auth-change`: the same `Range` with no token, with an expired token, during an auth change, and after one.
- `etcd-auth-password/authenticate` and `etcd-auth-password/error-authenticate-wrong-password`: the same user, with its password and with another.

## Catalog

<!-- generated:catalog -->
| File | Outcome | RPC | Runtime | Surface |
|---|---|---|---|---|
| `etcd-auth-password/authenticate.json` | pass | `Auth/Authenticate` | bun 1.4.2 | authenticate as root with its password |
| `etcd-auth-password/error-auth-revision-old.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg with reader's token while root grants the reader role its READ on /config/a again, so the auth revision moves during the read |
| `etcd-auth-password/error-authenticate-no-password-user.json` | fail | `Auth/Authenticate` | bun 1.4.2 and node 24.14.0 | authenticate as cert-only, a user with no password, with a password |
| `etcd-auth-password/error-authenticate-wrong-password.json` | fail | `Auth/Authenticate` | bun 1.4.2 and node 24.14.0 | authenticate as root with a wrong password |
| `etcd-auth-password/error-invalid-auth-token.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg with reader's token 12 s after it was issued (--auth-token-ttl=10) |
| `etcd-auth-password/error-range-no-token.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg with no token: spec E4's answer when the token is missing |
| `etcd-auth-password/error-user-name-empty-certificate.json` | fail | `Auth/UserGet` | bun 1.4.2 and node 24.14.0 | userGet reader with reader.crt and no token, on the server without --client-cert-auth: the connect sequence's step 4 |
| `etcd-auth-password/range-token-before-auth-change.json` | pass | `KV/Range` | bun 1.4.2 | range: /app/cfg with reader's token issued before root granted the reader role its READ on /config/a again: a simple token still reads |
| `etcd-auth-password/status.json` | pass | `Maintenance/Status` | bun 1.4.2 | status with root's token, without hasleader |
| `etcd-auth-password/watch-invalid-auth-token.json` | pass | `Watch/Watch` | bun 1.4.2 and node 24.14.0 | watch: /app/ with reader's token 12 s after it was issued, cancelled in-band |
| `etcd-auth/alarm-disarm-root.json` | pass | `Maintenance/Alarm` | bun 1.4.2 | alarmDisarm as root: DEACTIVATE NOSPACE with no alarm raised |
| `etcd-auth/auth-status-on.json` | pass | `Auth/AuthStatus` | bun 1.4.2 | authStatus: RBAC on |
| `etcd-auth/compact-root.json` | pass | `KV/Compact` | bun 1.4.2 | compact to the current revision as root, physical |
| `etcd-auth/defragment-root.json` | pass | `Maintenance/Defragment` | bun 1.4.2 | defragment as root |
| `etcd-auth/error-permission-denied.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /config/b as reader, outside its grants |
| `etcd-auth/error-permission-denied-alarm-disarm.json` | fail | `Maintenance/Alarm` | bun 1.4.2 and node 24.14.0 | alarmDisarm as reader: a DEACTIVATE needs the root role |
| `etcd-auth/error-permission-denied-compact.json` | fail | `KV/Compact` | bun 1.4.2 and node 24.14.0 | compact as reader: compaction needs the root role |
| `etcd-auth/error-permission-denied-defragment.json` | fail | `Maintenance/Defragment` | bun 1.4.2 and node 24.14.0 | defragment as reader: defragmentation needs the root role |
| `etcd-auth/error-permission-denied-lease-leases.json` | fail | `Lease/LeaseLeases` | bun 1.4.2 and node 24.14.0 | leaseLeases as reader: the leases hold keys outside its grants |
| `etcd-auth/error-permission-denied-no-common-name.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg with a certificate that has no Common Name (gateway-client.crt) and no token |
| `etcd-auth/error-permission-denied-role-list.json` | fail | `Auth/RoleList` | bun 1.4.2 and node 24.14.0 | roleList as reader |
| `etcd-auth/error-permission-denied-user-list.json` | fail | `Auth/UserList` | bun 1.4.2 and node 24.14.0 | userList as reader |
| `etcd-auth/error-plaintext-to-tls.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status in plaintext to the TLS port 12379 |
| `etcd-auth/error-plaintext-to-tls.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status in plaintext to the TLS port 12379 |
| `etcd-auth/error-tls-chain.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status over TLS trusting another CA (other-ca.pem) |
| `etcd-auth/error-tls-chain.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status over TLS trusting another CA (other-ca.pem) |
| `etcd-auth/error-tls-client-certificate-refused.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status over TLS with a client certificate from another CA (other-ca-root.crt) |
| `etcd-auth/error-tls-client-certificate-refused.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status over TLS with a client certificate from another CA (other-ca-root.crt) |
| `etcd-auth/error-tls-client-certificate-required.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status over TLS with no client certificate |
| `etcd-auth/error-tls-client-certificate-required.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status over TLS with no client certificate |
| `etcd-auth/error-tls-name.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status over TLS checking the name etcd-wrong-name.test |
| `etcd-auth/error-tls-name.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status over TLS checking the name etcd-wrong-name.test |
| `etcd-auth/error-user-name-empty.json` | fail | `Auth/UserGet` | bun 1.4.2 and node 24.14.0 | userGet reader with a certificate that has no Common Name (gateway-client.crt) and no token |
| `etcd-auth/error-user-name-not-found.json` | fail | `Auth/UserGet` | bun 1.4.2 and node 24.14.0 | userGet unknown-user with the certificate whose Common Name is unknown-user: the connect sequence's step 4 |
| `etcd-auth/range-health-permission-denied.json` | fail | `KV/Range` | bun 1.4.2 | range: the key health as reader, outside its grants |
| `etcd-auth/range-reader-app.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /app/ as reader, which it may read |
| `etcd-auth/range-reader-config-a.json` | pass | `KV/Range` | bun 1.4.2 | range: the key /config/a as reader, its single-key grant |
| `etcd-auth/role-get-reader.json` | pass | `Auth/RoleGet` | bun 1.4.2 | roleGet reader as reader: a user reads its own role |
| `etcd-auth/role-list.json` | pass | `Auth/RoleList` | bun 1.4.2 | roleList as root |
| `etcd-auth/status.json` | pass | `Maintenance/Status` | bun 1.4.2 | status as root (certificate root.crt), without hasleader |
| `etcd-auth/user-get-cert-only.json` | pass | `Auth/UserGet` | bun 1.4.2 | userGet cert-only as root |
| `etcd-auth/user-get-reader.json` | pass | `Auth/UserGet` | bun 1.4.2 | userGet reader as reader (certificate reader.crt): a user reads itself |
| `etcd-auth/user-list.json` | pass | `Auth/UserList` | bun 1.4.2 | userList as root (certificate root.crt) |
| `etcd-auth/watch-permission-denied.json` | pass | `Watch/Watch` | bun 1.4.2 and node 24.14.0 | watch: /config/b as reader, cancelled in-band |
| `etcd-cluster/alarm-disarm.json` | pass | `Maintenance/Alarm` | bun 1.4.2 | alarmDisarm: DEACTIVATE NOSPACE with the member id Alarm GET named |
| `etcd-cluster/alarm-disarm-member-zero.json` | pass | `Maintenance/Alarm` | bun 1.4.2 | alarmDisarm: DEACTIVATE NOSPACE with member id 0, which clears nothing |
| `etcd-cluster/alarm-list-nospace.json` | pass | `Maintenance/Alarm` | bun 1.4.2 | alarmList: Alarm GET with a NOSPACE alarm raised |
| `etcd-cluster/defragment.json` | pass | `Maintenance/Defragment` | bun 1.4.2 | defragment member 2, through its own connection |
| `etcd-cluster/error-connection-dropped.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: a put through a forwarder that passes the request to member 1 and drops the connection before the answer |
| `etcd-cluster/error-deadline-before-pick.bun.json` | fail | `KV/Range` | bun 1.4.2 | range: /app/cfg with a 1.5 s deadline over a new channel to member 3, paused: Node never gets a ready channel, Bun sends the call |
| `etcd-cluster/error-deadline-before-pick.node.json` | fail | `KV/Range` | node 24.14.0 | range: /app/cfg with a 1.5 s deadline over a new channel to member 3, paused: Node never gets a ready channel, Bun sends the call |
| `etcd-cluster/error-no-leader.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg with hasleader, no leader |
| `etcd-cluster/error-no-leader-txn-put.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: E8's guarded put with hasleader, no leader |
| `etcd-cluster/error-no-space.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: a put while the NOSPACE alarm is raised |
| `etcd-cluster/member-list.json` | pass | `Cluster/MemberList` | bun 1.4.2 | memberList: linearizable, three members |
| `etcd-cluster/member-list-serializable-no-leader.json` | pass | `Cluster/MemberList` | bun 1.4.2 | memberList: serializable, without hasleader, no leader |
| `etcd-cluster/range-serializable-no-leader.json` | pass | `KV/Range` | bun 1.4.2 | range: /app/cfg, serializable, without hasleader, no leader |
| `etcd-cluster/status-after-defragment.json` | pass | `Maintenance/Status` | bun 1.4.2 | status of member 2 after its defragmentation |
| `etcd-cluster/status-before-defragment.json` | pass | `Maintenance/Status` | bun 1.4.2 | status of member 2 before its defragmentation |
| `etcd-cluster/status-follower.json` | pass | `Maintenance/Status` | bun 1.4.2 | status of a follower |
| `etcd-cluster/status-leader.json` | pass | `Maintenance/Status` | bun 1.4.2 | status of the leader |
| `etcd-cluster/status-no-leader.json` | pass | `Maintenance/Status` | bun 1.4.2 | status of member 1 with members 2 and 3 stopped, without hasleader |
| `etcd/alarm-list-none.json` | pass | `Maintenance/Alarm` | bun 1.4.2 | alarmList: Alarm GET, no alarm raised |
| `etcd/auth-status-off.json` | pass | `Auth/AuthStatus` | bun 1.4.2 | authStatus: RBAC off |
| `etcd/compact.json` | pass | `KV/Compact` | bun 1.4.2 | compact to the current revision, physical |
| `etcd/defragment.json` | pass | `Maintenance/Defragment` | bun 1.4.2 | defragment, without hasleader |
| `etcd/delete-range-prefix.json` | pass | `KV/DeleteRange` | bun 1.4.2 | deleteRange: the scratch prefix /libredb-evidence/, after two puts under it |
| `etcd/error-authenticate-not-enabled.json` | fail | `Auth/Authenticate` | bun 1.4.2 and node 24.14.0 | authenticate with RBAC off: the connect sequence's step 1 (spec 6.1) |
| `etcd/error-cancelled-on-client.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg, cancelled on the client right after it starts |
| `etcd/error-client-receive-cap.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /values/large (300,000 bytes) over a channel whose receive cap is 65,536 bytes |
| `etcd/error-deadline-after-send.bun.json` | fail | `KV/Range` | bun 1.4.2 | range: /app/cfg with a 1 s deadline, sent to the member paused after its channel was ready |
| `etcd/error-deadline-after-send.node.json` | fail | `KV/Range` | node 24.14.0 | range: /app/cfg with a 1 s deadline, sent to the member paused after its channel was ready |
| `etcd/error-lease-revoke-not-found.json` | fail | `Lease/LeaseRevoke` | bun 1.4.2 and node 24.14.0 | leaseRevoke: lease 7587863092875085199, never granted |
| `etcd/error-range-compacted.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /history/counter at its create revision, compacted |
| `etcd/error-range-future-revision.json` | fail | `KV/Range` | bun 1.4.2 and node 24.14.0 | range: /app/cfg at the current revision plus 1000 |
| `etcd/error-server-receive-cap.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: one put of 2,200,000 bytes, past the server's receive cap |
| `etcd/error-tls-to-plaintext.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status over TLS to the plaintext port 2379 |
| `etcd/error-tls-to-plaintext.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status over TLS to the plaintext port 2379 |
| `etcd/error-txn-duplicate-key.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: two puts of one key |
| `etcd/error-txn-request-too-large.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: one put of 1,600,000 bytes, past --max-request-bytes |
| `etcd/error-txn-too-many-ops.json` | fail | `KV/Txn` | bun 1.4.2 and node 24.14.0 | txn: 129 puts, past --max-txn-ops |
| `etcd/lease-grant.json` | pass | `Lease/LeaseGrant` | bun 1.4.2 | leaseGrant: TTL 60, id 7587863092875085100 |
| `etcd/lease-keep-alive.json` | pass | `Lease/LeaseKeepAlive` | bun 1.4.2 | leaseKeepAliveOnce: lease 7587863092875085100, one exchange |
| `etcd/lease-keep-alive-expired.json` | pass | `Lease/LeaseKeepAlive` | bun 1.4.2 | leaseKeepAliveOnce: lease 7587863092875085100 after its revoke, TTL 0 |
| `etcd/lease-leases.json` | pass | `Lease/LeaseLeases` | bun 1.4.2 | leaseLeases: the two seeded leases, without hasleader |
| `etcd/lease-revoke.json` | pass | `Lease/LeaseRevoke` | bun 1.4.2 | leaseRevoke: lease 7587863092875085100 |
| `etcd/lease-time-to-live-keys.json` | pass | `Lease/LeaseTimeToLive` | bun 1.4.2 | leaseTimeToLive with keys: lease 694d8147df1dc4c9, holding a protected key |
| `etcd/lease-time-to-live-unknown.json` | pass | `Lease/LeaseTimeToLive` | bun 1.4.2 | leaseTimeToLive with keys: lease 7587863092875085199, never granted |
| `etcd/member-list.json` | pass | `Cluster/MemberList` | bun 1.4.2 | memberList: linearizable |
| `etcd/member-list-serializable.json` | pass | `Cluster/MemberList` | bun 1.4.2 | memberList: serializable, without hasleader |
| `etcd/range-compact-rev-key.json` | pass | `KV/Range` | bun 1.4.2 | range: the key compact_rev_key |
| `etcd/range-count-only-all.json` | pass | `KV/Range` | bun 1.4.2 | range: the whole key space, count only |
| `etcd/range-count-only-prefix.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /registry/, count only |
| `etcd/range-health.json` | pass | `KV/Range` | bun 1.4.2 | range: the key health, as etcdctl endpoint health reads it |
| `etcd/range-history-rev.json` | pass | `KV/Range` | bun 1.4.2 | range: /libredb-evidence/history at its create revision, the first of its three versions |
| `etcd/range-key.json` | pass | `KV/Range` | bun 1.4.2 | range: the key /app/cfg |
| `etcd/range-keys-only-all.json` | pass | `KV/Range` | bun 1.4.2 | range: the whole key space, keys only, limit 500 |
| `etcd/range-keys-only-from.json` | pass | `KV/Range` | bun 1.4.2 | range: from /config/ to the end, keys only, limit 5: a page from a cursor |
| `etcd/range-missing.json` | pass | `KV/Range` | bun 1.4.2 | range: the key /no/such/key, which does not exist |
| `etcd/range-prefix-app.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /app/, limit 500 |
| `etcd/range-prefix-app-limit-2.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /app/, limit 2, cut by its limit |
| `etcd/range-prefix-registry.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /registry/: the Kubernetes-shaped subtree of spec 9 |
| `etcd/range-prefix-registry-slashless.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix registry/: the slash-less secrets root |
| `etcd/range-prefix-tenant-a.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /tenant-a/: the custom-prefix stand-in of spec 9 |
| `etcd/range-prefix-values.json` | pass | `KV/Range` | bun 1.4.2 | range: the prefix /values/: the values of spec 4.4 and a key that is not UTF-8 |
| `etcd/range-serializable.json` | pass | `KV/Range` | bun 1.4.2 | range: the key /app/cfg, serializable, without hasleader |
| `etcd/status.json` | pass | `Maintenance/Status` | bun 1.4.2 | status, without hasleader |
| `etcd/txn-guarded-create.json` | pass | `KV/Txn` | bun 1.4.2 | txn: E8's guarded put of the absent /libredb-evidence/edit, mod = 0, a range of it on failure |
| `etcd/txn-guarded-delete.json` | pass | `KV/Txn` | bun 1.4.2 | txn: E8's guarded delete of /libredb-evidence/edit at its current mod revision |
| `etcd/txn-guarded-put.json` | pass | `KV/Txn` | bun 1.4.2 | txn: E8's guarded put of /libredb-evidence/edit at the mod revision the create answered |
| `etcd/txn-guarded-put-conflict.json` | pass | `KV/Txn` | bun 1.4.2 | txn: E8's guarded put of /libredb-evidence/edit at a mod revision it has moved past |
| `etcd/txn-read-targets.json` | pass | `KV/Txn` | bun 1.4.2 | txn: E8's read of three single-key targets, read-only, the last one absent |
| `etcd/txn-typed.json` | pass | `KV/Txn` | bun 1.4.2 | txn: typed as mod("/libredb-evidence/typed") = "0", then put /libredb-evidence/typed "a\nb", a blank line, then get /libredb-evidence/typed |
| `etcd/watch-compacted.json` | pass | `Watch/Watch` | bun 1.4.2 | watch: /history/counter from its create revision, compacted |
| `etcd/watch-history.json` | pass | `Watch/Watch` | bun 1.4.2 | watch: /libredb-evidence/history from its create revision, its three versions |
| `etcd/watch-prefix.json` | pass | `Watch/Watch` | bun 1.4.2 | watch: the prefix /libredb-evidence/watch/ with prev_kv, over two puts and a delete |
| `etcd/watch-quiet.json` | pass | `Watch/Watch` | bun 1.4.2 | watch: the prefix /app/ for one second in which nothing changes |
| `transport/error-deadline-name-resolution.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status to a name that does not resolve, with a deadline that has already passed |
| `transport/error-deadline-name-resolution.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status to a name that does not resolve, with a deadline that has already passed |
| `transport/error-refused.bun.json` | fail | `Maintenance/Status` | bun 1.4.2 | status to a closed local port |
| `transport/error-refused.node.json` | fail | `Maintenance/Status` | node 24.14.0 | status to a closed local port |
<!-- /generated:catalog -->
