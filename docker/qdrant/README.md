# Qdrant fixtures

The live Qdrant servers of `database-compose.yml`, the one-shots that seed them and generate their keys, and the scripts those one-shots run.
The vector family's captures (`tests/fixtures/vector/`), the Qdrant provider's captures and live check, and every hand pass run against these servers, so each seeded collection below exists for a rule and says which.

## The servers

| Service | Profile | From the host | Transport and authentication |
|---|---|---|---|
| `qdrant` | none | `127.0.0.1:6333` | Plaintext, no key |
| `qdrant-auth` | `qdrant-auth` | `127.0.0.1:6343` | Plaintext, an admin key, a read-only key and JWT RBAC |
| `qdrant-tls` | `qdrant-tls` | `127.0.0.1:6353` | TLS on REST, an admin key and a read-only key |
| `qdrant-mtls` | `qdrant-tls` | `127.0.0.1:6363` | TLS that verifies the client's certificate, an admin key and a read-only key |

The one-shots are `qdrant-seed`, which seeds `qdrant` and, run by hand, `qdrant-auth`, and `qdrant-keys`, which generates the keyed servers' keys, configuration and certificates.

Every server runs `ghcr.io/qdrant/qdrant/qdrant:v1.19.1`, the GHCR mirror, pinned by the digest `sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822`; it reports commit 6ab21cac.
The one-shots run `python:3.14-slim` and `alpine/openssl:3.5.8`, each pinned by digest in the compose file.
Each keyed server reads its keys and TLS settings from the `local.yaml` that `qdrant-keys` generated, copied into place when the container starts, never from an environment variable in the compose file.
Every server sets `QDRANT__TELEMETRY_DISABLED`, because a server otherwise reports to telemetry.qdrant.io every hour.
No server publishes gRPC 6334 or the internal port 6335, which the provider never dials.
No server has a data volume: removing a container resets it, and the seed fills it again.
Every port is bound to a loopback address only, and each server is bounded to 2 CPUs and 2 GiB, against 44 to 80 MiB measured after seeding.

`qdrant-auth` names `http://host.docker.internal:18904/infer` as its inference address, `host.docker.internal` mapped to the host's gateway.
A live check runs a listener there, bound to the bridge gateway address alone, and the listener must receive nothing.

## Bringing them up

Name the compose project and every service, as every command here does.
`up` with no service names starts every server in `database-compose.yml`, and the project name keeps one set of volumes when a command runs from a git worktree.
Start a server with `up --wait`, which returns once it is healthy, and a one-shot with a plain `up -d`, then read its exit code with `docker wait`, which must print `0`.

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait qdrant
docker compose -p libredb-studio -f database-compose.yml up -d qdrant-seed
docker wait libredb-qdrant-seed

docker compose -p libredb-studio -f database-compose.yml --profile qdrant-auth --profile qdrant-tls up -d qdrant-keys
docker wait libredb-qdrant-keys
docker compose -p libredb-studio -f database-compose.yml --profile qdrant-auth --profile qdrant-tls up -d --wait \
  qdrant-auth qdrant-tls qdrant-mtls
docker compose -p libredb-studio -f database-compose.yml run --rm --no-deps -T qdrant-seed \
  --url http://qdrant-auth:6333 --api-key-file /keys/auth/admin.key
```

The first seed installs its pinned packages and takes about a minute; a second run on a seeded server creates nothing.
To read a seeded server back without writing to it, and to print the manifest the vector fixtures record:

```sh
docker compose -p libredb-studio -f database-compose.yml run --rm --no-deps -T qdrant-seed \
  --url http://qdrant:6333 --verify
docker compose -p libredb-studio -f database-compose.yml run --rm --no-deps -T qdrant-seed \
  --url http://qdrant:6333 --manifest
```

To start the keyed fixtures over, remove their containers by name, then the keys volume, whose name carries the project's prefix:

```sh
docker compose -p libredb-studio -f database-compose.yml --profile qdrant-auth --profile qdrant-tls rm -s -f \
  qdrant-keys qdrant-auth qdrant-tls qdrant-mtls
docker volume rm libredb-studio_qdrant-keys
```

## The scripts

- `seed.py` creates every collection below that is missing and leaves what exists, so a second run does no work; `--verify` reads every collection back and exits 1 on a difference, and `--manifest` prints, as JSON, each collection's vectors, its point count and its first five points with every vector the server returns as the seed sent it.
  The data is deterministic, from the fixed numpy seeds 20261002, 7, 11 and 20261003, uuid5 ids of a fixed namespace and fixed timestamps, so every point is byte-identical across servers and resets.
- `keys.sh <directory>` generates every key, `local.yaml` and certificate into the `qdrant-keys` volume at first start, so no key and no private key is ever committed.
- `requirements.in` pins every package the seed installs, the versions the research seed's environment held: qdrant-client 1.19.1, numpy 2.5.3 and their dependencies.
  `requirements.txt` adds the sha256 of each one's `linux/amd64` wheel; it is generated by `sh docker/lock-requirements.sh docker/qdrant <the seed's image>` and never edited by hand.
  So `qdrant-seed` declares `platform: linux/amd64`, and an arm64 host runs it under emulation instead of failing on the hashes.

## Keys and certificates

| Files in the `qdrant-keys` volume | What they are |
|---|---|
| `auth/admin.key`, `auth/read-only.key`, `auth/local.yaml` | `qdrant-auth`'s keys, and its configuration with `jwt_rbac: true` |
| `tls/admin.key`, `tls/read-only.key`, `tls/local.yaml` | `qdrant-tls`'s keys, and its configuration with `enable_tls: true` |
| `mtls/admin.key`, `mtls/read-only.key`, `mtls/local.yaml` | `qdrant-mtls`'s keys, and its configuration with `verify_https_client_certificate: true` |
| `ca.pem`, `server.pem`, `server.key` | the CA and the certificate both TLS servers present, naming `localhost`, `127.0.0.1`, `qdrant-tls` and `qdrant-mtls` |
| `client.pem`, `client.key` | the client certificate `qdrant-mtls` accepts |

Each key is 32 random bytes written as 64 hexadecimal characters, above the 32 bytes the server asks of the key it signs JWTs with.
A live check mints every JWT it needs at test time, HS256 with `auth/admin.key`, and never writes one into the repository.
Send a key or a JWT in the `api-key` header or as `Authorization: Bearer`.
Copy the volume out of the one-shot's container, outside the repository:

```sh
docker cp libredb-qdrant-keys:/keys /tmp/qdrant-keys
```

## The seeded collections

| Collection | What it holds | The rule it serves |
|---|---|---|
| `docs` | 2,000 points: the edge ids 0, 42, 2^53 + 1, 2^63 and 2^64 - 1, 995 ids at 2^60 + n and 1,000 UUIDs; named vectors `text` (384, `Cosine`), `image` (64, `Euclid`, absent on one point in ten) and `colbert` (16, `Dot`, a multivector of one to three rows), a sparse `keywords` with idf; eleven payload indexes; heterogeneous payload fields | ids above 2^53 and UUIDs side by side, every named vector kind, payload indexes |
| `small_dtypes` | 200 points: `float16`, `uint8` and `turbo4` vectors, a `Manhattan` vector and a sparse vector with a `uint8` index | every datatype and distance the v1 cells render |
| `plain` | 300 points with one unnamed 4-dimension `Dot` vector and a `city` payload | the shape of the documentation's own examples |
| `scratch` | nothing at seed time; an unnamed 8-dimension vector and a sparse `sp` | the shared writable collection |
| `empty_novec` | a collection with no vector at all | a collection that declares no vector |
| `edge_values` | three points: `float16` at 65504 and 2^-24 and one element of 70000 that overflows to `null`, `uint8` at 0 and 255, float32 at its range ends, a two-row integral multivector, a sparse index 4294967295, a sparse value of 3.4e38, and (3,4) | the copy loop's edge rows; the score `null` Qdrant prints for the 3.4e38 point's self-search; (3,4) against the origin answering 5.0 with `Euclid` |
| `payload_spread` | 20,000 points with a 4-dimension vector: `variant` an integer on the first 10,000 ids and a string after them, a `price` whose every fourth value is integral and written as JavaScript writes one, and keys present on 2, 1 and 0.1 percent of the points | the payload sample's rules |

The aliases `docs_alias` and `plain_alias` name `docs` and `plain`.
