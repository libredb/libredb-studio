# Weaviate fixtures

The live Weaviate servers of `database-compose.yml`, the one-shots that seed them and generate their keys, and the scripts those one-shots run.
They were built for the Weaviate provider's design measurements (#1566), so each server and each seeded collection below exists for a measured rule and says which.

## The servers

| Service | Profile | From the host | Version | Transport and authentication |
|---|---|---|---|---|
| `weaviate` | none | `127.0.0.1:18280` | 1.40.2 | Plaintext, anonymous; every REST search route served |
| `weaviate-1-37` | `weaviate-matrix` | `127.0.0.1:18281` | 1.37.4 | Plaintext, anonymous; no REST search, GraphQL only |
| `weaviate-1-38` | `weaviate-matrix` | `127.0.0.1:18285` | 1.38.22 | Plaintext, anonymous; REST search behind its flag, left off; GraphQL |
| `weaviate-nographql` | `weaviate-matrix` | `127.0.0.1:18282` | 1.40.2 | Plaintext, anonymous, `DISABLE_GRAPHQL=true` |
| `weaviate-auth` | `weaviate-secure` | `127.0.0.1:18283` | 1.40.2 | Plaintext, API keys and RBAC, anonymous access off |
| `weaviate-tls` | `weaviate-secure` | `127.0.0.1:18284` | 1.40.2 | TLS on Weaviate's own listener, API keys and RBAC |

The three shapes a provider must read are one per row of the matrix:
1.40 serves REST search for every route, 1.37.4 is the version DigitalOcean Managed Weaviate runs and has no REST search at all, 1.38.22 carries REST search behind `EXPERIMENTAL_REST_SEARCH_ENABLED` (off, its default), and 1.40 with GraphQL disabled is how new Weaviate Cloud clusters are created.
1.37 left Weaviate's support window (the three most recent minors) when 1.40 shipped; it is here because a managed service still runs it.

The one-shots are `weaviate-seed` (seeds `weaviate`), `weaviate-matrix-seed` (seeds the three matrix servers), `weaviate-keys` (generates the root key and the certificate) and `weaviate-secure-seed` (seeds both keyed servers and creates their viewer user).

Every server runs `cr.weaviate.io/semitechnologies/weaviate`, pinned by tag and digest in the compose file.
The one-shots run `python:3.14-slim` and `alpine/openssl:3.5.8`, each pinned by digest.
Every server sets `DEFAULT_VECTORIZER_MODULE=none` and `API_BASED_MODULES_DISABLED=true`, so `/v1/meta` lists no module and no request can reach a model provider.
An empty `ENABLE_MODULES` is not enough: a server without `API_BASED_MODULES_DISABLED` loads every API-based module (45 on 1.40.2, from `generative-openai` to `text2vec-digitalocean`).
Every server sets `DISABLE_TELEMETRY`.
No server publishes gRPC 50051, which the provider never dials, and no server has a data volume: removing a container resets it, and the seed fills it again.
Every port is bound to a loopback address only, and each server is bounded to 2 CPUs and 1 GiB.

The keyed servers read their root key from the `weaviate-keys` volume: Weaviate takes keys from the environment alone, so the image's own `sh` exports the key and execs the server, and the key never appears in the compose file.
`weaviate-tls` keeps its plain listener inside the container for the health probe, because busybox `wget` verifies the certificate and has no option for the fixture's CA; only 8443 is published.

## Bringing them up

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait weaviate
docker compose -p libredb-studio -f database-compose.yml up -d weaviate-seed
docker wait libredb-weaviate-seed

docker compose -p libredb-studio -f database-compose.yml --profile weaviate-matrix up -d --wait \
  weaviate-1-37 weaviate-1-38 weaviate-nographql
docker compose -p libredb-studio -f database-compose.yml --profile weaviate-matrix up -d weaviate-matrix-seed
docker wait libredb-weaviate-matrix-seed

docker compose -p libredb-studio -f database-compose.yml --profile weaviate-secure up -d weaviate-keys
docker wait libredb-weaviate-keys
docker compose -p libredb-studio -f database-compose.yml --profile weaviate-secure up -d --wait \
  weaviate-auth weaviate-tls
docker compose -p libredb-studio -f database-compose.yml --profile weaviate-secure up -d weaviate-secure-seed
docker wait libredb-weaviate-secure-seed
```

Each `docker wait` must print `0`.
A second run of any seed writes nothing.

## The keys

```sh
docker cp libredb-weaviate-auth:/keys/root.key -        # root, the RBAC root user
docker cp libredb-weaviate-auth:/keys/auth/reader.key - # reader on weaviate-auth, built-in role viewer
docker cp libredb-weaviate-auth:/keys/tls/reader.key -  # reader on weaviate-tls
docker cp libredb-weaviate-auth:/keys/ca.pem -          # the CA weaviate-tls's certificate chains to
```

The certificate names `localhost`, `127.0.0.1` and `weaviate-tls`.
To start over, remove the keyed containers and the `weaviate-keys` volume together.

## The seeded collections

Every vector comes from `random.Random` with a fixed seed, every id is a `uuid5` of a fixed namespace and every date is fixed, so the same objects exist on every server.
The seed uses only schema fields the 1.37 line accepts, so one corpus seeds the whole matrix.

| Collection | Objects | Exists for |
|---|---|---|
| `Article` | 500 | one unnamed 16-dimension cosine vector, every common property type (text, text[], int, number, boolean, date, geoCoordinates, a nested object) and a cross-reference to `Author`; more than one cursor page |
| `Author` | 12 | objects with no vector at all |
| `Product` | 200 | two named vectors with different dimensions, distances and index types (`image` 8-d cosine HNSW, `text` 16-d dot flat) |
| `TenantNotes` | 20 per tenant | multi-tenancy with `autoTenantActivation` off: `acme` and `globex` HOT, `initech` COLD |
| `TenantNotesAuto` | 20 per tenant | `autoTenantActivation` on: `hooli` HOT, `umbrella` COLD |
| `EdgeValues` | 8 | int values at and past 2^53 and at the int64 bounds |
| `Empty` | 0 | a collection with no objects |

Alias `Articles` points at `Article`.
Each COLD tenant is written while HOT and set COLD last, so it holds objects a read could try to wake.

`EdgeValues` shows what the server keeps, not what the seed sent: Weaviate stores an `int` property as a float64 (`intVal` in `usecases/objects/validation/properties_validation.go`), so 2^53 + 1 reads back as 2^53 on every path, and 2^63 - 1 is refused when written through gRPC.
The seed writes through REST, where the JSON value is rounded the same way.

`seed.py --verify` reads every collection back, counts its objects with cursor pages, checks each tenant's activity status and the alias, and exits 1 on a difference.

## Reading a cold tenant wakes it

On a collection with `autoTenantActivation` on, any data read of a COLD tenant (an object list or read by id, GraphQL `Get` or `Aggregate`, a REST search or aggregate, `/v1/schema/{collection}/shards?tenant=`) sets it HOT, also for a user with only the built-in `viewer` role.
Reading a tenant's own record (`GET` or `HEAD /v1/schema/{collection}/tenants/{tenant}`), the tenant list and `/v1/nodes` does not.
Re-run the seed's last step by hand, or remove the container, to make a tenant COLD again.

On the 1.37 line (measured on 1.37.4 and 1.37.17), `/v1/schema/TenantNotesAuto/shards?tenant=umbrella` with `umbrella` COLD wakes the tenant and then does not answer (one wait was cut at 312 s), and from then on that collection's `/shards` answers for no tenant, HOT ones included, until the server restarts; other routes and collections keep working.
1.38.22 and later answer the same request in milliseconds.
Do not send it to `weaviate-1-37` unless that is the test.
