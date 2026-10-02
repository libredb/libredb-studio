# etcd fixtures

The live etcd servers of `database-compose.yml`, and the scripts that seed them.
The etcd provider's captures, its live check and every hand pass run against these servers, so each key below exists for a rule of the provider and says which.

## The servers

| Service | Profile | From the host | Transport and authentication |
|---|---|---|---|
| `etcd` | none | `127.0.0.1:2379` | Plaintext, RBAC off |
| `etcd-cluster-1`, `-2`, `-3` | `etcd-cluster` | `127.0.0.2:2379`, `127.0.0.3:2379`, `127.0.0.4:2379` | Plaintext, RBAC off, one cluster of three members |
| `etcd-auth` | `etcd-auth` | `127.0.0.1:12379` | TLS with `--client-cert-auth`, RBAC on |
| `etcd-auth-password` | `etcd-auth` | `127.0.0.1:12479` | TLS without client certificates, RBAC on |

Every server runs `gcr.io/etcd-development/etcd:v3.7.2`, pinned by the digest `sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3` (pulled on 2026-09-30).
The one-shots run `alpine/curl:8.21.0` and `alpine/openssl:3.5.8`, each pinned by digest in the compose file.
Every port is bound to a loopback address only, and every container has a CPU and a memory bound.
Each server has its own member name and cluster token, so no two answer with the same cluster and member ids.
The cluster members advertise their host addresses, which `member list` shows, and share the network alias `etcd-cluster` inside the compose network.
Both auth servers expire a token after 10 seconds of disuse (`--auth-token-ttl=10`).
No server has a data volume: removing its container resets it.

## Bringing them up

Name every service, as every command in this repository does.
Start the servers with `up --wait`, which returns once they are healthy, and the one-shots with a plain `up -d`: `up --wait` answers exit code 1 when a one-shot it waits for has already exited, even with code 0 (measured with Docker Compose 5.5.1).
`docker wait` then prints each one-shot's exit code, and each must be `0`.

```sh
docker compose -f database-compose.yml up -d --wait etcd
docker compose -f database-compose.yml up -d etcd-seed
docker wait libredb-etcd-seed

docker compose -f database-compose.yml --profile etcd-cluster up -d --wait \
  etcd-cluster-1 etcd-cluster-2 etcd-cluster-3
docker compose -f database-compose.yml --profile etcd-cluster up -d etcd-cluster-seed
docker wait libredb-etcd-cluster-seed

docker compose -f database-compose.yml --profile etcd-auth up -d --wait \
  etcd-auth etcd-auth-password
docker compose -f database-compose.yml --profile etcd-auth up -d \
  etcd-auth-init etcd-auth-password-init
docker wait libredb-etcd-auth-certs libredb-etcd-auth-init libredb-etcd-auth-password-init
```

Every script may run again on a seeded server and changes nothing, not even the revision.
To start one fixture over, remove its containers by name with `docker compose -f database-compose.yml --profile <profile> rm -s -f <services>`; for the auth fixtures also remove the `etcd-auth-certs` volume, whose name carries the compose project's prefix (`docker volume ls`).

The image is distroless, with no shell, so `etcdctl` runs by `docker exec` with its flags in full, for example:

```sh
docker exec libredb-etcd etcdctl get /app/ --prefix
docker exec libredb-etcd-auth etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/certs/ca.pem \
  --cert=/certs/reader.crt --key=/certs/reader.key get /config/a
```

## The scripts

- `seed.sh <client URL>` writes the key space below through etcd's own gRPC gateway, from the curl image, because the gateway carries a key and a value as base64 of their exact bytes, and a NUL or an invalid UTF-8 byte cannot pass through a command-line argument.
  Every key is written only if absent, in one `Txn` guarded by `create_revision = 0`, and every lease has a fixed id.
- `certs.sh <directory>` generates the auth fixtures' certificates and passwords into the `etcd-auth-certs` volume at first start, so no private key and no password is ever committed.
- `rbac.sh <client URL>` creates the users and the role below and then turns auth on.
  Auth is turned on last, so on a server with auth on the script stops at once: granting again would move the auth revision, which invalidates every token issued before it.
- `lib.sh` holds the gateway calls both scripts share.

## The seeded keys

The same 34 keys, at revision 37, on `etcd`, on the cluster and on both auth servers.

| Keys | What they exist for |
|---|---|
| `/apisix/routes/1`, `/apisix/consumers/jack` (JSON), `/apisix/plugins` | APISIX's layout: `/apisix/` holds deeper keys, so `/apisix/plugins` is in no prefix group |
| `/service/batman/leader` (text), `/service/batman/config` | Patroni's leader key |
| `/skydns/local/example/www` | A CoreDNS record as JSON |
| `/feature-flag`, `plain` | One-segment keys, with and without the leading `/`, in no group |
| `/config/a`, `/config/b` | A first segment holding only two-segment keys: the group `/config/*` |
| `/app/cfg`, `/app/a/b`, `/app/x/y` | A first segment mixing both shapes: the groups `/app/a/*` and `/app/x/*`, with `/app/cfg` in no group |
| `/bin/ok/x`, `/bin/` followed by the bytes `ff fe` and `/x` | A deep first segment whose second segment is not UTF-8: the group `/bin/ok/*`, and the other key in no group, though it still makes `/bin/` deep (rule 7 of the prefix-group rule) |
| `/` followed by the bytes `ff fe` and `/x` | A first segment that is not UTF-8: in no group (rule 7 of the prefix-group rule) |
| `/values/not-utf8` | A value that is not UTF-8 (`ff fe 00 01 c3 28`) |
| `/values/large` | A value of 300,000 bytes, past the cell bound |
| `/values/empty`, `/values/whitespace` | A value of zero bytes, and one of whitespace only |
| `/values/key-` followed by the bytes `ff fe` | A key that is not UTF-8, under the flat `/values/`: it belongs to `/values/*` (rule 7 of the prefix-group rule) |
| `/history/counter` | Three revisions, `1`, `2` and `3`, for `get --rev` and `watch --rev` |
| `/leases/session-1` | Attached to lease `694d8147df1dc4c8` (7587863092875085000, past 2^53) |
| `/leases/session-2`, `/registry/events/default/nginx.1` | Attached to lease `694d8147df1dc4c9`, which holds a protected key beside an ordinary one |
| `/registry/pods/default/nginx` | A Kubernetes protobuf envelope (`k8s\0`, then `runtime.Unknown` naming `v1` `Pod`) |
| `/registry/secrets/default/db-creds` | A Secret in the envelope; its data holds the marker `libredb-fixture-secret`, which no answer may carry |
| `/registry/configmaps/default/encrypted` | An encryption-at-rest value, `k8s:enc:aescbc:v1:key1:` and 32 bytes |
| `/registry/cbor.example.com/gadgets/default/g1` | A CBOR value, self-described (`d9 d9 f7`) |
| `/registry/example.com/widgets/default/w1` | A custom resource stored as JSON |
| `registry/secrets/default/legacy` | A JSON Secret under the slash-less secrets root, holding the same marker in base64 as its data entry `marker`, since the required Secret Scan read an entry named `password` as a leaked credential |
| `compact_rev_key` | kube-apiserver's compaction clock, at the root, with a decimal value |
| `/tenant-a/configmaps/default/cm`, `/tenant-a/configmaps/default/cm-encrypted` | A protobuf envelope and an encrypted value under an unprotected prefix, a stand-in for a custom `--etcd-prefix`, which only the content rule recognises |

## Users, roles and certificates

The same users and role on both auth servers:

| User | Role | Signs in with |
|---|---|---|
| `root` | `root` | the password in `root.password`, or the certificate `root.crt` on `etcd-auth` |
| `reader` | `reader` | the password in `reader.password`, or the certificate `reader.crt` on `etcd-auth` |
| `cert-only` | `reader` | the certificate `cert-only.crt` only: it has no password |

The role `reader` may READ the prefix `/app/` and the single key `/config/a`, and nothing else.
So a user who is not root meets a group it reads whole (`/app/a/*`), a group it reads one key of (`/config/*`), and a refusal everywhere else, `lease list`, `user list` and `role list` included.

`certs.sh` also generates `unknown-user.crt`, whose Common Name is no etcd user (the healthcheck's certificate), `other-ca-root.crt`, issued for `root` by a CA the servers do not trust, and `gateway-client.crt`, which has no Common Name at all.
The servers' certificate names `localhost`, `etcd-auth`, `etcd-auth-password`, `127.0.0.1` and `::1`, and its own Common Name, `etcd-auth-server`, is no etcd user, because the gateway presents it as its own client certificate.
The passwords are random, 32 hexadecimal characters each, generated on the first start.
Copy the directory out of a running server, into a directory outside the repository, and never commit it:

```sh
docker cp libredb-etcd-auth:/certs /tmp/etcd-auth-certs
```

## Measured on 3.7.2

- With RBAC on, `etcdctl endpoint health` and `endpoint status` without a credential fail with "etcdserver: user name is empty", while `auth status` answers, so `auth status` is the auth servers' healthcheck.
- With RBAC on, the gateway answers HTTP 400 "CommonName of client sending a request against gateway will be ignored and not used as expected" to a client certificate that carries a Common Name, whatever token the request carries; the init one-shots therefore use `gateway-client.crt`.
- Granting a permission or a role a user already holds answers without an error and moves the auth revision.
- A read over a certificate whose Common Name is no etcd user answers "etcdserver: permission denied", and `user get` of that name "etcdserver: user name not found".
- A password sent for `cert-only` answers "auth: authentication failed, password was given for no password user", with the gRPC code Unknown.
- A client certificate from another CA, or none, on `etcd-auth` fails the handshake, which etcdctl reports only as "context deadline exceeded".
