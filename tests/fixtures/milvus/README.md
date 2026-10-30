# Milvus captures

What Milvus 3.0.2 answered @grpc/grpc-js before any provider code ran, one surface per file, which the Milvus provider's unit and integration tests replay instead of a live server.
`tests/live/milvus-evidence.ts` writes every file here; none is edited by hand.
The vector family's REST captures are `tests/fixtures/vector/milvus/`, beside these.

## Where they come from

The harness runs against the services of `docker/milvus/README.md`: `milvus` (plaintext, authorization on), `milvus-tls` (one-way TLS) and `milvus-mtls` (mutual TLS), each `milvusdb/milvus:v3.0.2` pinned by digest.
It drives @grpc/grpc-js with the definition the descriptor generator builds and imports no provider code.
Every file records the image with its digest, the server version, the date, the runtime, the RPC, the Milvus user, the surface and the request.
The error rows of the provider's error table and the TLS rows run under Bun and again in a Node child; a row whose two answers differ is written twice, as `<name>.bun.json` and `<name>.node.json`.
No credential, token or key is written: the authorization metadata is never recorded, and every file is checked for every form of every credential the run sent before it is written.
The harness writes only what it owns, under the prefix `libredb_evidence_`: a collection and an alias on `milvus`, and on `milvus-tls`, which no seed writes, an empty loaded collection the TLS port's waiting queries wait on.
It creates them at the start and drops them at the end.

## The catalog

- `milvus/<rpc>-<user>.json`: every RPC the provider may call, as `root`, `reader` and `nobody`, so the privilege each one needs is on record.
- `milvus/describe-collection-<database>-<collection>.json`: every seeded collection's DescribeCollection.
- `milvus/query-edge-values.json` and `milvus/search-edge-values-<field>.json`: a query of every edge row and a self-search per vector field; `search-edge-values-sp.json` holds the score past the float32 range, which the provider's tests hold to `tests/fixtures/vector/expected-scores.json`.
- `milvus/error-*.json`, `milvus-tls/error-*.json`, `milvus-mtls/error-*.json`: one row per failure the provider's error table reads.
- `milvus-tls/get-version-*.json` and `milvus-mtls/get-version-mtls.json`: the TLS connections that succeed.

## Running it

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait milvus
docker compose -p libredb-studio -f database-compose.yml up -d milvus-seed
docker wait libredb-milvus-seed
docker compose -p libredb-studio -f database-compose.yml --profile milvus-tls up -d milvus-certs
docker wait libredb-milvus-certs
docker compose -p libredb-studio -f database-compose.yml --profile milvus-tls up -d --wait milvus-tls milvus-mtls
OUTSIDE=$(mktemp -d /tmp/milvus-evidence-XXXXXX)
docker cp libredb-milvus-seed:/credentials "$OUTSIDE/credentials"
docker cp libredb-milvus-certs:/certs "$OUTSIDE/certs"
bun tests/live/milvus-evidence.ts --secrets "$OUTSIDE/credentials" --certs "$OUTSIDE/certs"
```

The run takes several minutes: the deadline shapes, the dropped connection and the three query-node rejections each wait on the server.
`--only <name,...>` captures the named rows alone.

## The agent boundary

`3.0.2/agent-boundary/` holds what Milvus 3.0.2 answers each principal the agent read-only profile may meet, which the provider's agent tests replay.
`3.0.2/agent-boundary/run.sh` writes every file there: it starts two digest-pinned servers of its own, one with authorization on and one with it off, generates root's password for the run, and runs `agent-boundary-probe.ts`, which seeds both, generates every other user's password and refuses to write a capture holding any form of any credential it sent.
The containers are removed when the run ends; `MILVUS_PREFIX` names them and `MILVUS_PORT` picks the first of their two loopback ports.

- `select-user-self-*`, `select-grant-*`, `list-cred-users-*`, `select-role-all-*`, `list-privilege-groups-*`, `select-user-other-*`: the reads the read-only proof may send, for every principal.
- `list-databases-*` to `describe-alias-*`: the console's metadata reads; `query-values-*` and `search-text-*`: a read of stored values, and a text search the server runs the BM25 function for.
- `write-*`: every write and state change, refused to each read-only principal, then sent by a principal that may write; `state-*`: what root reads before and after them.
- `select-grant-own-role-after-grant-midrun` and `write-insert-after-grant-midrun`: a grant made during the run.
