# Milvus fixtures

The live Milvus servers of `database-compose.yml`, the one-shots that seed them and generate their certificates, and the scripts those one-shots run.
The vector family's captures (`tests/fixtures/vector/`), the Milvus provider's captures and live check, and every hand pass run against these servers, so each seeded object below exists for a rule and says which.

## The servers

| Service | Profile | From the host | Transport and authentication |
|---|---|---|---|
| `milvus` | none | `127.0.0.1:19530` (gRPC and REST), `127.0.0.1:19091` (the management port 9091) | Plaintext, authorization on |
| `milvus-tls` | `milvus-tls` | `127.0.0.1:19531` (gRPC over TLS), `127.0.0.1:19541` (REST over TLS) | One-way TLS (`tlsMode` 1), authorization on |
| `milvus-mtls` | `milvus-tls` | `127.0.0.1:19532` (gRPC over mutual TLS) | Mutual TLS (`tlsMode` 2), authorization on |

The one-shots are `milvus-seed`, which seeds `milvus`, and `milvus-certs`, which generates the TLS servers' certificates.

Every server runs `milvusdb/milvus:v3.0.2`, pinned by the digest `sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0`.
The one-shots run `python:3.12-slim` and `alpine/openssl:3.5.8`, each pinned by digest in the compose file.
Each server follows Milvus's `standalone_embed.sh` at tag v3.0.2: seccomp unconfined, the embedded etcd, local storage, `DEPLOY_MODE=STANDALONE`, the `embedEtcd.yaml` and `user.yaml` beside this file, the `/healthz` probe and `milvus run standalone`.
Three changes were measured before they were made.
Each server keeps its data in a named volume of its own, because the image runs as uid 999 and the script's bind mount crashed it with exit code 134.
The image is v3.0.2, where the script at that tag pins v3.0.1.
The TLS servers serve REST on a listener of their own (`PROXY_HTTP_PORT` 8080), because TLS forces separate ports.
The embedded etcd's 2379 is never published, and the write-ahead log is RocksMQ.
Every port is bound to a loopback address only, and each server is bounded to 2 CPUs and 4 GiB, against 156 to 292 MiB measured after seeding.
The restart policy is `unless-stopped`: during the research the embedded etcd of one server stalled on fdatasync for 7.8 seconds, lost its lease and exited with code 80.
A harness checks every service's health first and fails loudly on an exited or unhealthy server, with no retry.
No 2.6 server is here, because the provider claims Milvus 3.0 alone.

### The management port

On 3.0.2 the management port 9091 answers without authentication, its state-changing paths included.
It is published on loopback as 19091 for the live check's telemetry read alone, and the provider never dials it.
Keep it off every network: never publish it on another address, and never forward it.
Host port 9091 is `prometheus-auth`'s.

## Bringing them up

Name the compose project and every service, as every command here does.
`up` with no service names starts every server in `database-compose.yml`, and the project name keeps one set of volumes when a command runs from a git worktree.
Start a server with `up --wait`, which returns once it is healthy, and a one-shot with a plain `up -d`, then read its exit code with `docker wait`, which must print `0`.

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait milvus
docker compose -p libredb-studio -f database-compose.yml up -d milvus-seed
docker wait libredb-milvus-seed

docker compose -p libredb-studio -f database-compose.yml --profile milvus-tls up -d milvus-certs
docker wait libredb-milvus-certs
docker compose -p libredb-studio -f database-compose.yml --profile milvus-tls up -d --wait \
  milvus-tls milvus-mtls
```

The first seed installs its pinned packages and takes about two minutes; a second run on a seeded server creates nothing.
To read a seeded server back without writing to it, and to print the manifest the vector fixtures record:

```sh
docker compose -p libredb-studio -f database-compose.yml run --rm --no-deps -T milvus-seed \
  --uri http://milvus:19530 --verify
docker compose -p libredb-studio -f database-compose.yml run --rm --no-deps -T milvus-seed \
  --uri http://milvus:19530 --manifest
```

To start one fixture over, remove its containers by name, then its volumes, whose names carry the project's prefix:

```sh
docker compose -p libredb-studio -f database-compose.yml --profile milvus-tls rm -s -f \
  milvus milvus-seed milvus-certs milvus-tls milvus-mtls
docker volume rm libredb-studio_milvus-data libredb-studio_milvus-tls-data libredb-studio_milvus-mtls-data \
  libredb-studio_milvus-certs libredb-studio_milvus-credentials
```

## The scripts

- `seed.py` creates every object below that is missing and leaves what exists, so a second run does no work; `--verify` reads every object back and exits 1 on a difference, and `--manifest` prints, as JSON, each collection's declaration, its row count and its first five rows by `seq` with every vector as the server stores it.
  The data is deterministic, from fixed numpy seeds, apart from the keys the server assigns to `docs_int64`, so every fixture addresses rows by `seq`.
- `certs.sh <directory>` generates the TLS servers' certificates into the `milvus-certs` volume at first start, so no private key is ever committed.
- `requirements.in` pins every package the seed installs, the versions the research seed's environment held: pymilvus 3.0.2, numpy 2.5.3, ml_dtypes 0.6.0 and their dependencies.
  `requirements.txt` adds the sha256 of each one's `linux/amd64` wheel; it is generated by `sh docker/lock-requirements.sh docker/milvus <the seed's image>` and never edited by hand.
  So `milvus-seed` declares `platform: linux/amd64`, and an arm64 host runs it under emulation instead of failing on the hashes.
- `embedEtcd.yaml` and `user.yaml` are the two files `standalone_embed.sh` writes, unchanged.

## Users and credentials

| User | Role | Password |
|---|---|---|
| `root` | the built-in admin | Milvus's documented default, `Milvus`: the server's own default, which nothing here sets, and which the provider warns about |
| `reader` | `reader_role`: `CollectionReadOnly` and `DatabaseReadOnly` on `default/*` | `reader.password` in the `milvus-credentials` volume |
| `nobody` | none | `nobody.password` in the `milvus-credentials` volume |

The passwords are random, 32 hexadecimal characters each, generated by the first seed.
A token is `user:password`, sent as `authorization` metadata over gRPC and as `Authorization: Bearer` over REST.
Copy the passwords out of the seed's container into a directory outside the repository, and never commit them:

```sh
docker cp libredb-milvus-seed:/credentials /tmp/milvus-credentials
```

## The seeded objects

| Collection | What it holds | The rule it serves |
|---|---|---|
| `docs_int64` | 2,000 rows: an `Int64` key the server assigns (above 2^53), `seq`, an 8-dimension `FloatVector` (HNSW, `COSINE`), `VarChar`, `JSON`, an `Int64` array, a nullable `Int32`, a dynamic field holding an integer above 2^53 on every tenth row; partitions `part_a` and `part_b` | keys above 2^53 assigned by the server, rows addressed by `seq`; partitions; JSON, array and null cells |
| `docs_varchar` | 500 rows: a `VarChar` key and every vector type: `Float16Vector` (`L2`), `BFloat16Vector` (`IP`), a 16-bit `BinaryVector` (`HAMMING`), `SparseFloatVector` (`IP`), `Int8Vector` (`L2`) | a cell and a search of every vector type and of four metrics |
| `fts` | 200 short English sentences and their BM25 function's sparse output | a function's output field, searched with text |
| `unloaded_big` | 50,000 rows of 128 dimensions (IVF_FLAT, `L2`), released | a search refused as not loaded; Load with its preview on a copy the live check owns |
| `scratch` | nothing at seed time; a dynamic field | the one writable collection, compared on schema, configuration, aliases and load state only |
| `edge_values` | five rows: every vector type at its range ends (float32 3.4028235e38, -1e-45 and 1.1754944e-38, float16 65504 and 2^-24, the bfloat16 maximum, int8 -128 and 127, binary all 0x00 and all 0xff, a sparse index 4294967294), a sparse value of 3.4e38, and (3,4) | the copy loop's edge rows; the non-finite score of the 3.4e38 row's self-search; (3,4) against the origin answering 25.0, because `L2` is squared |
| `pk_partitioned` | 2,000 rows with a partition key over 1,024 partitions | `partitions/list` past the row cap; `partitionNames` refused on a partition-key collection |
| `large_topk` | 100 rows; the property `query_mode` is `large_topk` | `large_topk` detected by its exact property |
| `shadowed` | six rows: four written while `zeta` was a dynamic key, then `AddCollectionField` added a static `zeta`, then two more | the merge rule's live collision of a static and a dynamic key |
| `wide_768` | 1,000 normalised embeddings of 768 dimensions | the result byte budget |
| `probe_db.notes` | 100 rows in a second database | a database other than `default`, which `reader` may not read |

Every collection but `unloaded_big` is loaded.
`reader` lists only the database `default` and reads every collection in it; `nobody` lists nothing.

## Certificates

`certs.sh` generates a CA (`ca.pem`), one server certificate for both TLS servers (`server.pem`, `server.key`), naming `localhost`, `127.0.0.1`, `milvus-tls` and `milvus-mtls`, with the extended key usage serverAuth, and the client certificates mutual TLS is measured with:

| Files | What `milvus-mtls` does with it |
|---|---|
| `client.pem`, `client.key` | accepts it: clientAuth, issued by the fixture's CA |
| `client-serverauth.pem`, `client-serverauth.key` | refuses it: issued for serverAuth only |
| `client-expired.pem`, `client-expired.key` | refuses it: expired on 2025-01-02 |
| `client.pem`, `client-mismatched.key` | a key that does not match the certificate, which a client refuses before it dials |

Every file is mode 644, because the server runs as uid 999.
Copy them out of the one-shot's container, outside the repository:

```sh
docker cp libredb-milvus-certs:/certs /tmp/milvus-certs
```
