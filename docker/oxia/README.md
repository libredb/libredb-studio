# Oxia fixtures

The live Oxia servers of `database-compose.yml`, and the scripts that seed them.
The Oxia provider's captures, its live check and every hand pass run against these servers, so each key below exists for a rule of the provider.

## The services

| Service | Image | What it is | From the host | Profile | Memory bound |
|---|---|---|---|---|---|
| `oxia` | `oxia/oxia:0.16.10` | Standalone server, three shards, hierarchical key order, the `full` set | `127.0.0.1:6648` | none | 1G |
| `oxia-seed` | `oxia/oxia:0.16.10` | One-shot: `seed.sh oxia:6648 full` | none | none | 256M |
| `oxia-natural` | `oxia/oxia:0.16.10` | Standalone server, two shards, natural key order, the `small` set | `127.0.0.1:6658` | `oxia-natural` | 512M |
| `oxia-natural-blind` | `oxia/oxia:0.16.10` | Standalone server, two shards, natural key order, the `blind` set | `127.0.0.1:6659` | `oxia-natural` | 256M |
| `oxia-natural-seed` | `oxia/oxia:0.16.10` | One-shot: `seed.sh oxia-natural:6648 small`, then `seed.sh oxia-natural-blind:6648 blind` | none | `oxia-natural` | 256M |
| `oxia-017` | `oxia/oxia:0.17.1` | The `oxia` server on the 0.17 line, the `full` set | `127.0.0.1:6668` | `oxia-017` | 1G |
| `oxia-017-seed` | `oxia/oxia:0.17.1` | One-shot: `seed.sh oxia-017:6648 full` | none | `oxia-017` | 256M |
| `oxia-auth-certs` | `alpine/openssl:3.5.8` | One-shot: `certs.sh /certs`, into the `oxia-auth-material` volume | none | `oxia-auth` | 64M |
| `oxia-auth` | `oxia/oxia:0.16.10` | A coordinator and a data server in one container, TLS and an OIDC token, not seeded | `127.0.0.1:6678` | `oxia-auth` | 1G |
| `oxia-cluster-coordinator` | `oxia/oxia:0.16.10` | The coordinator of `cluster.yaml`, memory metadata | none | `oxia-cluster` | 256M |
| `oxia-cluster-1` | `oxia/oxia:0.16.10` | Data server, advertised at `127.0.0.1:6671`, not seeded | `127.0.0.1:6671` | `oxia-cluster` | 512M |
| `oxia-cluster-2` | `oxia/oxia:0.16.10` | Data server, advertised at `127.0.0.1:6672`, not seeded | `127.0.0.1:6672` | `oxia-cluster` | 512M |
| `oxia-cluster-3` | `oxia/oxia:0.16.10` | Data server, advertised at `127.0.0.1:6673`, not seeded | `127.0.0.1:6673` | `oxia-cluster` | 512M |

A plain `up` starts `oxia` and `oxia-seed` only; every other service starts by its profile.
Every image is pinned by digest in the compose file, every port is bound to 127.0.0.1 only, and every container has a CPU and a memory bound with no swap past it.
No server has a data volume: removing its container resets it.
A cluster advertises the public address its YAML names (`cluster.yaml`, `cluster-auth.yaml`), so each of those servers listens on the same port in the container as on the host.
`oxia-auth` advertises `localhost:6678`, the name its server certificate is issued for, so a client that dials `localhost` with `verify-full` reaches the leader it dialled.
A client that dials `127.0.0.1:6678` lists `localhost:6678` under its data servers, as a user dialling a cluster by IP would.
The auth and cluster fixtures hold no seeded keys and no marker: the 0.16.10 CLI has no TLS or token flag, and the dial policy needs no keys.

## Bringing them up

Name every service, as every command in this repository does.
Start the servers with `up -d --wait`, which returns once they are healthy, and run each seed one-shot in the foreground with `up`, which prints its exit code; it must be `0`.

```sh
docker compose -f database-compose.yml up -d --wait oxia
docker compose -f database-compose.yml up oxia-seed

docker compose -f database-compose.yml --profile oxia-natural up -d --wait oxia-natural oxia-natural-blind
docker compose -f database-compose.yml --profile oxia-natural up oxia-natural-seed

docker compose -f database-compose.yml --profile oxia-017 up -d --wait oxia-017
docker compose -f database-compose.yml --profile oxia-017 up oxia-017-seed

docker compose -f database-compose.yml --profile oxia-auth up -d --wait oxia-auth

docker compose -f database-compose.yml --profile oxia-cluster up -d --wait \
  oxia-cluster-coordinator oxia-cluster-1 oxia-cluster-2 oxia-cluster-3
```

Then add the keys the CLI cannot write, from the repository:

```sh
bun tests/live/oxia-seed-raw.ts --target 127.0.0.1:6648
bun tests/live/oxia-seed-raw.ts --target 127.0.0.1:6658
```

The raw seeder adds the keys that hold U+0000, which no command-line argument can carry, and the 20,000 bulk keys, which would take about 27 minutes through the CLI.
It refuses any other target, and a server that does not hold the marker `/libredb-fixture/seeded` with the value `full` (6648) or `small` (6658).

To re-seed, run the seed one-shot again: `seed.sh` wipes the namespace first, so run the raw seeder again after it.
To start a fixture over, remove its containers by name with `docker compose -f database-compose.yml --profile <profile> rm -s -f <services>`; for the auth fixture also remove the `oxia-auth-material` volume, whose name carries the compose project's prefix (`docker volume ls`).

The image has a shell and the CLI, so a key is read back with `docker exec`, for example:

```sh
docker exec libredb-oxia oxia client -a localhost:6648 get /libredb-fixture/seeded
docker exec libredb-oxia oxia client -a localhost:6648 list -s /admin/ -e /admin//
```

## The scripts

- `seed.sh <host:port> <full|small|blind>` runs inside the Oxia image and writes one set through `oxia client`.
  Each set wipes the namespace first and writes the marker `/libredb-fixture/seeded`, with the set's name as its value, last.
  Every key is passed after `--`, because the CLI reads a key such as `-dash` as its flag `-d` (measured on 0.16.10); read such a key back the same way, `get -- -dash`.
  The `full` wipe's upper bound is 201 `/` and a `~`: under the hierarchical order a key with more `/` than any stored key sorts above every key, and an empty upper bound deletes nothing.
  The `small` and `blind` wipes' upper bound is U+10FFFF (the bytes `f4 8f bf bf`): under the natural order keys compare by their bytes, and it sorts above every key of those sets.
- `certs.sh <directory>` generates the auth fixture's certificates, JWT keys and tokens into the `oxia-auth-material` volume at first start.
- `cluster.yaml` and `cluster-auth.yaml` are the coordinator configurations of the `oxia-cluster` and `oxia-auth` profiles.

## The seeded keys

Every key is in the namespace `default`.
A key that is not printable is written as its text followed by its bytes in hex.
No key is written under `__oxia/`, the prefix the server owns.
No seeded value reaches the server's 64 MiB WAL segment: the largest is 17 MiB.

### full

On `oxia` and `oxia-017`.

`full` holds 20,077 keys: 74 from `seed.sh` and 20,003 from `tests/live/oxia-seed-raw.ts`.
That is the count on `oxia`; `oxia-017` holds the 74 keys from `seed.sh` only, because the raw seeder writes to `127.0.0.1:6648` and `127.0.0.1:6658` alone.

| Key | Value | Writer |
|---|---|---|
| `/admin` | empty (a parent) | `seed.sh` |
| `/admin/policies` | empty (a parent) | `seed.sh` |
| `/admin/policies/public` | JSON | `seed.sh` |
| `/admin/policies/public/default` | JSON | `seed.sh` |
| `/admin/clusters` | empty (a parent) | `seed.sh` |
| `/admin/clusters/standalone` | JSON | `seed.sh` |
| `/admin/partitioned-topics` | empty (a parent) | `seed.sh` |
| `/admin/partitioned-topics/public` | empty (a parent) | `seed.sh` |
| `/admin/partitioned-topics/public/default` | empty (a parent) | `seed.sh` |
| `/admin/partitioned-topics/public/default/persistent` | empty (a parent) | `seed.sh` |
| `/admin/partitioned-topics/public/default/persistent/orders` | JSON | `seed.sh` |
| `/managed-ledgers` | empty (a parent) | `seed.sh` |
| `/managed-ledgers/public` | empty (a parent) | `seed.sh` |
| `/managed-ledgers/public/default` | empty (a parent) | `seed.sh` |
| `/managed-ledgers/public/default/persistent` | empty (a parent) | `seed.sh` |
| `/managed-ledgers/public/default/persistent/orders-partition-0` | bytes, protobuf-like, 9 bytes | `seed.sh` |
| `/managed-ledgers/public/default/persistent/orders-partition-1` | bytes, protobuf-like, 9 bytes | `seed.sh` |
| `/managed-ledgers/public/default/persistent/orders-partition-2` | bytes, protobuf-like, 9 bytes | `seed.sh` |
| `/loadbalance` | empty (a parent) | `seed.sh` |
| `/loadbalance/brokers` | empty (a parent) | `seed.sh` |
| `/loadbalance/brokers/broker-1:8080` | JSON | `seed.sh` |
| `/ledgers` | empty (a parent) | `seed.sh` |
| `/ledgers/LAYOUT` | text with an LF | `seed.sh` |
| `/ledgers/available` | empty (a parent) | `seed.sh` |
| `/ledgers/available/bookie-1:3181` | empty | `seed.sh` |
| `/schemas` | empty (a parent) | `seed.sh` |
| `/schemas/public` | empty (a parent) | `seed.sh` |
| `/schemas/public/default` | empty (a parent) | `seed.sh` |
| `/schemas/public/default/orders` | JSON | `seed.sh` |
| `/orphan/a/b/c/leaf-1` | text; no parent key exists | `seed.sh` |
| `/orphan/a/b/c/leaf-2` | text; no parent key exists | `seed.sh` |
| `/orphan/x/y` | text; no parent key exists | `seed.sh` |
| `/a` | text, the key | `seed.sh` |
| `/a/b` | text, the key | `seed.sh` |
| `/a/b/c` | text, the key | `seed.sh` |
| `/a/bb` | text, the key | `seed.sh` |
| `/a/b/` | text, the key | `seed.sh` |
| `/a/c` | text, the key | `seed.sh` |
| `/ab` | text, the key | `seed.sh` |
| `/b` | text, the key | `seed.sh` |
| `/b/c` | text, the key | `seed.sh` |
| `/a/b/c/d` | text, the key | `seed.sh` |
| `/z` | text, the key | `seed.sh` |
| `/trail//` | text, the key | `seed.sh` |
| `/trail/x//` | text, the key | `seed.sh` |
| `/odd//` | text, the key | `seed.sh` |
| `config` | text | `seed.sh` |
| `feature-flag.dark-mode` | text | `seed.sh` |
| `user:42` | JSON | `seed.sh` |
| `zz-last-flat` | text | `seed.sh` |
| `/odd/with space` | text | `seed.sh` |
| `/odd/100%` | text | `seed.sh` |
| `/odd/tab` followed by the bytes `09` and `key` | text | `seed.sh` |
| `/odd/"quoted"` | text | `seed.sh` |
| `/odd/back\slash` | text | `seed.sh` |
| `/odd/emoji-` followed by the bytes `f0 9f 99 82` | text | `seed.sh` |
| `/odd/max-` followed by the bytes `f4 8f bf bf` | text | `seed.sh` |
| `/odd/long/` followed by 4,000 `k` | text; a 4,010-byte key | `seed.sh` |
| `/values/json` | JSON object | `seed.sh` |
| `/values/json-int64` | JSON with an integer past 2^53 | `seed.sh` |
| `/values/text-utf8` | UTF-8 text | `seed.sh` |
| `/values/text-c0` | text with a C0 control byte, the bytes `08 01` | `seed.sh` |
| `/values/binary-non-utf8` | bytes that are not UTF-8, `ff fe 00 80` | `seed.sh` |
| `/values/protobuf-like` | bytes, protobuf-like, 10 bytes | `seed.sh` |
| `/values/empty` | empty | `seed.sh` |
| `/values/text-100KiB` | text, 100 KiB | `seed.sh` |
| `/values/pattern-5MiB` | text, 5 MiB | `seed.sh` |
| `/values/pattern-5MiB-b` | text, 5 MiB | `seed.sh` |
| `/values/over-cap` | text, 17 MiB: above Studio's 16 MiB receive cap | `seed.sh` |
| `/versions/counter` | text, written five times, `v1` to `v5` | `seed.sh` |
| `/pk/tenant-a/1` | text, written with the partition key `tenant-a` | `seed.sh` |
| `/pk/tenant-a/2` | text, written with the partition key `tenant-a` | `seed.sh` |
| `/pk/tenant-a/3` | text, written with the partition key `tenant-a` | `seed.sh` |
| `/libredb-fixture/seeded` | text, `full`; written last | `seed.sh` |
| `/nul/a` followed by the bytes `00` and `b` | text | `tests/live/oxia-seed-raw.ts` |
| `/nul/` followed by the bytes `00` | text | `tests/live/oxia-seed-raw.ts` |
| `a` followed by the bytes `00` | text; a key with no `/` | `tests/live/oxia-seed-raw.ts` |
| `/bulk/key-00000` to `/bulk/key-19999`, 20,000 keys | text, `v` | `tests/live/oxia-seed-raw.ts` |

### small

On `oxia-natural`.

`small` holds 25 keys: 22 from `seed.sh` and 3 from `tests/live/oxia-seed-raw.ts`.

| Key | Value | Writer |
|---|---|---|
| `/a` | text, the key | `seed.sh` |
| `/a/b` | text, the key | `seed.sh` |
| `/a/b/c` | text, the key | `seed.sh` |
| `/a/bb` | text, the key | `seed.sh` |
| `/a/b/` | text, the key | `seed.sh` |
| `/a/c` | text, the key | `seed.sh` |
| `/ab` | text, the key | `seed.sh` |
| `/b` | text, the key | `seed.sh` |
| `/b/c` | text, the key | `seed.sh` |
| `/a/b/c/d` | text, the key | `seed.sh` |
| `/z` | text, the key | `seed.sh` |
| `/trail//` | text, the key | `seed.sh` |
| `/trail/x//` | text, the key | `seed.sh` |
| `/odd//` | text, the key | `seed.sh` |
| `config` | text | `seed.sh` |
| `feature-flag.dark-mode` | text | `seed.sh` |
| `user:42` | JSON | `seed.sh` |
| `zz-last-flat` | text | `seed.sh` |
| `-dash` | text; the first byte sorts below `/` | `seed.sh` |
| `.dot` | text; the first byte sorts below `/` | `seed.sh` |
| `!bang` | text; the first byte sorts below `/` | `seed.sh` |
| `/libredb-fixture/seeded` | text, `small`; written last | `seed.sh` |
| `/nul/a` followed by the bytes `00` and `b` | text | `tests/live/oxia-seed-raw.ts` |
| `/nul/` followed by the bytes `00` | text | `tests/live/oxia-seed-raw.ts` |
| `a` followed by the bytes `00` | text | `tests/live/oxia-seed-raw.ts` |

### blind

On `oxia-natural-blind`: the blind spot of the order probe, a natural namespace whose listed keys each begin with a byte below `/`.
The marker holds `/` and sorts above every other key, so the probe decides on its list; the path that reads on past the list is proven by the unit tests' fake only.

`blind` holds 605 keys: 605 from `seed.sh` and 0 from `tests/live/oxia-seed-raw.ts`.

| Key | Value | Writer |
|---|---|---|
| `-k0000` to `-k0599`, 600 keys | text, `v` | `seed.sh` |
| `-a/b` | text, `v` | `seed.sh` |
| `-a/bb` | text, `v` | `seed.sh` |
| `-a/c` | text, `v` | `seed.sh` |
| `.b/x` | text, `v` | `seed.sh` |
| `/libredb-fixture/seeded` | text, `blind`; written last | `seed.sh` |

## Healthchecks

Each server kind takes the check that was measured to pass on it.

- The standalone servers (`oxia`, `oxia-natural`, `oxia-natural-blind`, `oxia-017`) run `oxia client -a localhost:6648 --request-timeout 3s list -s / -e /0`, which exits 0 once the shard map is served, so it also catches a server whose assignments never arrive.
  A standalone server has no internal listener for `oxia health`: measured on 0.16.10, port 6649 refuses the connection.
- The cluster data servers (`oxia-cluster-1`, `oxia-cluster-2`, `oxia-cluster-3`) run `oxia health --host localhost --port 6649 --timeout 3s` on the internal listener, because `cluster.yaml` advertises each leader at a host port, and a list from inside one container is sent to leaders on the other servers.
  Measured on 0.16.10: the internal listener of a data server answers SERVING.
- `oxia-cluster-coordinator` runs `oxia health --host localhost --port 6652 --timeout 3s`.
  Measured on 0.16.10: the coordinator's internal listener answers SERVING.
- `oxia-auth` runs `oxia health --host localhost --port 6649 --timeout 3s`, because the 0.16.10 CLI has no TLS or token flag and `oxia health` dials without TLS.
  Measured on the shared TLS and OIDC probes: the internal listener answers SERVING without a token, while the public listener requires TLS or the token.

## Certificates and tokens

`certs.sh` writes these files into the `oxia-auth-material` volume, mounted at `/certs`, once; a second start finds `.complete` and leaves them as they are.
They protect nothing but a loopback-only fixture, and none of them is committed.

| File | What it is |
|---|---|
| `ca.crt` | The fixture's CA, Common Name `libredb-oxia-ca` |
| `server.crt`, `server.key` | The server certificate, `subjectAltName=DNS:localhost,IP:127.0.0.1` |
| `client.crt`, `client.key` | A client certificate from the fixture's CA |
| `other-ca.crt` | An unrelated CA, Common Name `libredb-oxia-other-ca`, for the handshake refusal |
| `jwt.key`, `jwt.pub` | The RS256 key pair of the OIDC static-key provider |
| `jwt-wrong.key` | An RS256 key the server does not know |
| `token.jwt` | A token valid for one year |
| `token-expired.jwt` | A token that expired an hour before it was minted |
| `token-bad-signature.jwt` | A token signed with `jwt-wrong.key` |
| `token-bad-audience.jwt` | A token for the audience `other` |
| `token-bad-issuer.jwt` | A token from the issuer `https://other.libredb-fixture.invalid` |
| `.complete` | The marker of a finished run |

The OIDC parameters of `oxia-auth`: issuer `https://issuer.libredb-fixture.invalid`, audience `oxia`, user name claim `sub`, static key file `/certs/jwt.pub`.
Every token's subject is `fixture-user`.
The token is valid for one year, so a fixture older than that is started over by removing the volume.

To read the files from the host:

```sh
docker cp libredb-oxia-auth:/certs <directory>
```

To mint another token, use the `mint` function of `certs.sh` over the copied `jwt.key`: the base64url of the header `{"alg":"RS256","typ":"JWT"}` and of the claims, joined by a dot, then signed with `openssl dgst -sha256 -sign jwt.key` and base64url-encoded.

## Server versions

The servers run `oxia/oxia:0.16.10` (`sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322`) and `oxia/oxia:0.17.1` (`sha256:165bf4f3803153f23be3ba699f6430ab1463cdeaa46e341ff32c3eaed0d1b7d6`), each pinned by its index digest.

An Oxia 0.16 standalone server (measured on 0.16.10) stops sending shard assignments to every client after one request whose authority is not `host:port`, which Studio never sends, until restarted (upstream #1450, about standalone mode only). 0.17.1 is not affected; fixed on main by #1450, in no 0.16 release as of 2026-10-04.
Recommended: 0.17.1.
