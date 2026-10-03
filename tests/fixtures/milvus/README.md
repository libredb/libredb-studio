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
The harness writes only a collection and an alias under the prefix `libredb_evidence_`, which it creates at the start and drops at the end.

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
