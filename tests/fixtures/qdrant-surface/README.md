# Qdrant surface captures

What the seeded `qdrant` service of `database-compose.yml` answers to the reads only the Qdrant provider's object surface and monitoring make, captured by `tests/live/qdrant-surface-evidence.ts`.
The description of each collection, `GET /` and `GET /aliases` are not here: they are `tests/fixtures/vector/qdrant/`'s, captured from the same service and seed by `tests/live/vector-evidence.ts`, and the harness stops when a description no longer reports the point count that directory records.

## The files

- `collections.json`: `GET /collections`.
- `aliases-<collection>.json`, `snapshots-<collection>.json`, `optimizations-<collection>.json` and `cluster-<collection>.json`: the four reads of a collection's Source besides its description, for every seeded collection.
- `sample-<collection>.json`: the payload sample of every seeded collection that reports points, one `points/scroll` of 1,000 points with payloads and without vectors, through slice 0 of ceil(points_count / 1,000).
  The request it records is the one the provider sends, which `tests/unit/db/qdrant/sample.test.ts` holds.

Each file is `{ "$captured": {...}, "outcome": "pass", "payload": {...} }` in the encoding `tests/fixtures/vector/README.md` describes, and `payload.body` is the exact text the server sent.
The service has no key, so no credential is sent and none is written; every request is a read.

## How they were captured

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait qdrant
docker compose -p libredb-studio -f database-compose.yml up -d qdrant-seed
docker wait libredb-qdrant-seed
docker compose -p libredb-studio -f database-compose.yml run --rm --no-deps -T qdrant-seed --url http://qdrant:6333 --verify
bun tests/live/qdrant-surface-evidence.ts
```

The harness runs by hand and never by `bun run test`, and replaces every `.json` file here whole.
