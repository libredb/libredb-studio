# Vector fixtures

The vector family's test data, which the shared vector suites read instead of a live server: the vector types and functions of `src/lib/db/vector/`, the console grammar's corpus test, and the results grid's renderer and copy-loop tests.
Each section below names its files, the source they come from and the command that writes them; no file is edited by hand.

## `milvus/`, `qdrant/` and `expected-scores.json`

What Milvus 3.0.2 and Qdrant 1.19.1 answered over their REST APIs before any vector provider client existed, and what their seeds say they inserted.
`tests/fixtures/milvus/` and `tests/fixtures/qdrant/` are other directories: each provider's own captures, over gRPC and over `node:http(s)`, taken by that provider's harness.
Captured from the `milvus` and `qdrant` services of `database-compose.yml`, seeded as `docker/milvus/README.md` and `docker/qdrant/README.md` say, by `tests/live/vector-evidence.ts`, which runs by hand and never by `bun run test`.
It calls one surface per file, records a pass or the verbatim failure, and renders the generated blocks below from the files and its run report, so no value in them was typed by hand.

### Provenance

<!-- generated:provenance -->
| Engine | Image | Digest | Server version | Captured | Runtime |
|---|---|---|---|---|---|
| milvus | `milvusdb/milvus:v3.0.2` | `sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0` | 3.0.2 | 2026-10-03T12:30:30.704Z to 2026-10-03T12:30:30.810Z | bun 1.4.2 |
| qdrant | `ghcr.io/qdrant/qdrant/qdrant:v1.19.1` | `sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822` | 1.19.1 | 2026-10-03T12:30:30.811Z to 2026-10-03T12:30:30.840Z | bun 1.4.2 |
<!-- /generated:provenance -->

### How they were captured

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait milvus qdrant
docker compose -p libredb-studio -f database-compose.yml up -d milvus-seed qdrant-seed
docker wait libredb-milvus-seed libredb-qdrant-seed
bun tests/live/vector-evidence.ts --report <a report file outside the repository>
bun tests/live/vector-evidence.ts --readme --report <the same report file>
```

The harness first requires both servers to be running and healthy, and stops with no retry when one is not.
It reads each seed's manifest by running the seed's one-shot with `--manifest` and the server's pinned image, stops when the manifest records another build, then sends every request one at a time.
Every answer must have the outcome its capture declares and hold the claim its capture states, and every derived cell must equal its REST cell as float32 where the two have the same shape; otherwise nothing is written.
A run replaces `milvus/`, `qdrant/` and `expected-scores.json` whole.

### The files

- `manifest.json`: the seed's manifest as the seed printed it: the server's pinned image, its digest, its version and the date the seed printed it, then each collection's declaration, its row or point count, and its first rows (every row of `edge_values`) with every vector as the server stores it.
- `describe-*.json`: the describe answer of every seeded collection.
- `query-*.json` (Milvus), `scroll-docs.json` and `retrieve-*.json` (Qdrant): cells of every vector type as each engine returns them.
  Milvus REST returns `Float16Vector`, `BFloat16Vector`, `BinaryVector` and `Int8Vector` cells as base64, which is why no expected cell is derived from REST.
- `search-*.json`: one search per metric.
  `milvus/search-l2-origin.json` answers 25.0 and `qdrant/search-euclid-origin.json` 5.0 for (3,4) against the origin, because Milvus `L2` is the squared distance and Qdrant `Euclid` is not.
- `search-non-finite.json`: the self-search of the `edge_values` sparse row whose value 3.4e38 gives an inner product above the float32 maximum.
  Qdrant prints the score as `null`.
  Milvus REST answers HTTP 200 with a 0-byte body, because REST cannot encode the score, and the capture records that answer as it is, with the outcome `empty-body`.
- `expected-fields.json`: the `VectorFieldInfo[]` expected from every seeded collection, derived from the manifest by `tests/live/vector-evidence-derive.ts`; the Milvus and Qdrant providers' schema tests reproduce it from their own captures.
- `expected-cells.json`: the expected cells in Studio's cell form, derived from the manifest and never from REST base64: dense vectors as numbers, binary vectors as byte arrays, a Milvus sparse vector as an index map in ascending index order, a Qdrant sparse vector as `{indices, values}`, and a float16 element that overflowed as `null`.
  `excluded` names each vector field with no expected cell and why: a BM25 function's output, which the seed never writes, a Qdrant `Cosine` vector, which the server normalises when it is written, and `turbo4`, which stores a reconstruction.
- `expected-scores.json`: the score of each engine's non-finite self-search.
  The Milvus score `Infinity` is derived from the manifest, because REST cannot carry it: the row's value squared, summed in float32, passes the float32 maximum.
  The Qdrant score is the `null` the server printed.

### Encoding

Each capture is `{ "$captured": {...}, "outcome": "pass" | "fail" | "empty-body", "payload": {...} }`.
`$captured` holds `engine`, `image`, `digest`, `version` (the server's own), `date`, `runtime`, `surface`, and `request` (`method`, `path`, `headers` and `body` as sent).
`payload` holds `status`, `bodyBytes` and `body`, the exact text the server sent, because a JSON parser rounds an integer above 2^53: read it with `quoteUnsafeIntegers` (`src/lib/db/utils/json-integers.ts`).
A negative zero is written as `-0.0`, which `JSON.parse` reads back as `-0`: the Milvus seed stores one in `edge_values`, and `JSON.stringify` alone would write it as `0`.
No password, key or token is in any file: the Milvus `authorization` header is written as `<token>`, and the harness refuses to write a file that holds any form of the credential it sent.

### The cross-check

<!-- generated:cross-check -->
| Engine | Cells equal to REST as float32 | Cells REST answers in another shape | Cells no capture holds |
|---|---|---|---|
| milvus | 20 | 40 | 31 |
| qdrant | 50 | 0 | 0 |

- milvus: default/docs_varchar pk vc-0000 f16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0001 f16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0002 f16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0003 f16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0004 f16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0000 bf16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0001 bf16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0002 bf16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0003 bf16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0004 bf16: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0000 bin: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0001 bin: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0002 bin: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0003 bin: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0004 bin: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0000 i8: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0001 i8: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0002 i8: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0003 i8: cell: REST holds string.
- milvus: default/docs_varchar pk vc-0004 i8: cell: REST holds string.
- milvus: default/edge_values id 1 f16: cell: REST holds string.
- milvus: default/edge_values id 2 f16: cell: REST holds string.
- milvus: default/edge_values id 3 f16: cell: REST holds string.
- milvus: default/edge_values id 4 f16: cell: REST holds string.
- milvus: default/edge_values id 5 f16: cell: REST holds string.
- milvus: default/edge_values id 1 bf16: cell: REST holds string.
- milvus: default/edge_values id 2 bf16: cell: REST holds string.
- milvus: default/edge_values id 3 bf16: cell: REST holds string.
- milvus: default/edge_values id 4 bf16: cell: REST holds string.
- milvus: default/edge_values id 5 bf16: cell: REST holds string.
- milvus: default/edge_values id 1 bin: cell: REST holds string.
- milvus: default/edge_values id 2 bin: cell: REST holds string.
- milvus: default/edge_values id 3 bin: cell: REST holds string.
- milvus: default/edge_values id 4 bin: cell: REST holds string.
- milvus: default/edge_values id 5 bin: cell: REST holds string.
- milvus: default/edge_values id 1 i8: cell: REST holds string.
- milvus: default/edge_values id 2 i8: cell: REST holds string.
- milvus: default/edge_values id 3 i8: cell: REST holds string.
- milvus: default/edge_values id 4 i8: cell: REST holds string.
- milvus: default/edge_values id 5 i8: cell: REST holds string.
<!-- /generated:cross-check -->

### Catalog

<!-- generated:catalog -->
| File | Outcome | Request | Surface |
|---|---|---|---|
| `milvus/describe-default-docs_int64.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.docs_int64 |
| `milvus/describe-default-docs_varchar.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.docs_varchar |
| `milvus/describe-default-edge_values.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.edge_values |
| `milvus/describe-default-fts.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.fts |
| `milvus/describe-default-large_topk.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.large_topk |
| `milvus/describe-default-pk_partitioned.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.pk_partitioned |
| `milvus/describe-default-scratch.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.scratch |
| `milvus/describe-default-shadowed.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.shadowed |
| `milvus/describe-default-unloaded_big.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.unloaded_big |
| `milvus/describe-default-wide_768.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of default.wide_768 |
| `milvus/describe-probe_db-notes.json` | pass | `POST /v2/vectordb/collections/describe` | collections/describe of probe_db.notes |
| `milvus/query-docs_int64.json` | pass | `POST /v2/vectordb/entities/query` | entities/query of docs_int64 seq 0 to 4 with vec |
| `milvus/query-docs_varchar.json` | pass | `POST /v2/vectordb/entities/query` | entities/query of docs_varchar vc-0000 to vc-0004 with every vector field |
| `milvus/query-edge_values.json` | pass | `POST /v2/vectordb/entities/query` | entities/query of every edge_values row with every vector field |
| `milvus/search-bm25.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, BM25, fts.text_sparse, the text vector index |
| `milvus/search-cosine.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, COSINE, docs_int64.vec, the vector of seq 0 |
| `milvus/search-hamming-binary.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, HAMMING, docs_varchar.bin, the bytes of vc-0000 |
| `milvus/search-ip-bfloat16.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, IP, docs_varchar.bf16, the vector of vc-0000 |
| `milvus/search-ip-sparse.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, IP, docs_varchar.sparse, the vector of vc-0000 |
| `milvus/search-l2-float16.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, L2, docs_varchar.f16, the vector of vc-0000 |
| `milvus/search-l2-int8.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, L2, docs_varchar.i8, the vector of vc-0000 |
| `milvus/search-l2-origin.json` | pass | `POST /v2/vectordb/entities/search` | entities/search, L2, edge_values.f32, (3,4) of the metric-probe row against the origin |
| `milvus/search-non-finite.json` | empty-body | `POST /v2/vectordb/entities/search` | entities/search, IP, edge_values.sp, the self-search of the 3.4e38 row |
| `qdrant/aliases.json` | pass | `GET /aliases` | GET /aliases |
| `qdrant/describe-docs.json` | pass | `GET /collections/docs` | GET /collections/docs |
| `qdrant/describe-edge_values.json` | pass | `GET /collections/edge_values` | GET /collections/edge_values |
| `qdrant/describe-empty_novec.json` | pass | `GET /collections/empty_novec` | GET /collections/empty_novec |
| `qdrant/describe-payload_spread.json` | pass | `GET /collections/payload_spread` | GET /collections/payload_spread |
| `qdrant/describe-plain.json` | pass | `GET /collections/plain` | GET /collections/plain |
| `qdrant/describe-scratch.json` | pass | `GET /collections/scratch` | GET /collections/scratch |
| `qdrant/describe-small_dtypes.json` | pass | `GET /collections/small_dtypes` | GET /collections/small_dtypes |
| `qdrant/retrieve-edge_values.json` | pass | `POST /collections/edge_values/points` | POST /collections/edge_values/points, ids 1, 2, 3, with every vector |
| `qdrant/retrieve-plain.json` | pass | `POST /collections/plain/points` | POST /collections/plain/points, ids 1, 2, 3, 4, 5, with every vector |
| `qdrant/retrieve-small_dtypes.json` | pass | `POST /collections/small_dtypes/points` | POST /collections/small_dtypes/points, ids 0, 1, 2, 3, 4, with every vector |
| `qdrant/root.json` | pass | `GET /` | GET /, the server's version |
| `qdrant/scroll-docs.json` | pass | `POST /collections/docs/points/scroll` | points/scroll of docs seq 0 to 4 with every vector |
| `qdrant/search-cosine.json` | pass | `POST /collections/docs/points/query` | points/query, Cosine, docs.text, the dense probe vector |
| `qdrant/search-dot.json` | pass | `POST /collections/plain/points/query` | points/query, Dot, plain, the vector of id 1 |
| `qdrant/search-euclid-origin.json` | pass | `POST /collections/edge_values/points/query` | points/query, Euclid, edge_values.f32, (3,4) of the metric-probe point against the origin |
| `qdrant/search-euclid.json` | pass | `POST /collections/docs/points/query` | points/query, Euclid, docs.image, the vector of id 0 |
| `qdrant/search-manhattan.json` | pass | `POST /collections/small_dtypes/points/query` | points/query, Manhattan, small_dtypes.manhattan, the vector of id 0 |
| `qdrant/search-multivector.json` | pass | `POST /collections/docs/points/query` | points/query, Dot max_sim, docs.colbert, the multivector of id 0 |
| `qdrant/search-non-finite.json` | pass | `POST /collections/edge_values/points/query` | points/query, sparse, edge_values.sp, the self-search of the 3.4e38 point |
| `qdrant/search-sparse.json` | pass | `POST /collections/docs/points/query` | points/query, sparse, docs.keywords, the sparse vector of id 0 |
<!-- /generated:catalog -->

## `routes/`

The two consoles' route tables as test data, generated by `tests/live/vector-routes.ts` from two pinned sources, which it refuses when a source's sha256 differs, and never edited by hand.

- `milvus-v1.json`: the 15 routes of the Milvus console's v1 table, every one a `POST` under `/v2/vectordb/`, each with every body key Milvus's REST reference names, its type and whether it is required.
  The source is `rest-summary-v3.0.x.tsv`, a one-row-per-endpoint summary of that reference at milvus-io/web-content v3.0.x, commit 78d9def7, kept with the design research; its sha256 is `e85963fdb0aaf506f89ba0cc3825fbd480d61c671fa08b7ef7f6245acdabb723`.
- `qdrant-v1.json`: the 17 operations of the Qdrant console's v1 table, with the query keys v1 accepts: `consistency` and `timeout` on the eight point reads, and `with` and `completed_limit` on optimizations.
- `qdrant-full.json`: all 69 operations of Qdrant v1.19.1, with every query key.
  Both Qdrant files come from `docs/redoc/master/openapi.json` of github.com/qdrant/qdrant at tag v1.19.1, whose sha256 is `eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a` and whose `info.version` reads `master`.

```sh
bun tests/live/vector-routes.ts --tsv <rest-summary-v3.0.x.tsv> --openapi <openapi.json at v1.19.1>
```

The Milvus and Qdrant providers each add a test that their `routes.ts` equals the matching v1 file route for route.

## `corpus/`

The console grammar's corpus, generated by `tests/live/vector-corpus.ts` and never edited by hand.

- `qdrant-docs.json`: derived data, not the documentation itself: one block for each of the 257 `http.md` snippets under `qdrant-landing/content/documentation/headless/snippets/` of github.com/qdrant/landing_page at commit bb7f15b97237c97748fdbeea45499e2fcaba2377.
  Each block is its snippet's http block with `{collection_name}` and `<your-collection>` filled as `docs`, `{vector_name}` as `text`, `{point_id}` as `42` and `{snapshot_name}` as `snap.snapshot`, and with the prose of every comment replaced by `note`, its marker kept where it stood.
  `file` names the snippet by its path, flattened, and `sourceSha256` is the sha256 of the snippet the block came from.
- `milvus-requests.json`: the nine Milvus console requests of the design's examples, written for this repository.

```sh
git clone https://github.com/qdrant/landing_page.git <a directory outside the repository>
git -C <that directory> checkout bb7f15b97237c97748fdbeea45499e2fcaba2377
bun tests/live/vector-corpus.ts --snippets <that directory>/qdrant-landing/content/documentation/headless/snippets
```
