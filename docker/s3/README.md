# S3 fixtures

The live S3-compatible servers of `database-compose.yml`, the one-shots that give each the same principals and objects, and the scripts those one-shots run.
The `s3` provider's captures (`tests/fixtures/s3/captures/`), its live check and every hand pass run against these servers, so every seeded bucket and object below exists for a row of the acceptance matrix in `docs/providers/s3.md`.

## The servers

| Service | Profile | From the host | Signing region | Image |
|---|---|---|---|---|
| `minio` | `s3-minio` | `http://127.0.0.1:9000` | any accepted; `us-east-1` used | `libredb-fixture/minio:RELEASE.2025-10-15T17-29-55Z`, built from source (`docker/minio/README.md`) |
| `minio-region` | `s3-region` | `http://127.0.0.1:9030` | `eu-central-1`, enforced | the same build, with `MINIO_SITE_REGION` |
| `silo` | none | `http://127.0.0.1:9010` | any accepted; `us-east-1` used | `pgsty/silo:RELEASE.2026-09-16T00-00-00Z`, pinned by digest |
| `silo-tls` | `s3-tls` | `https://127.0.0.1:9443` | `us-east-1` | the same image, with the certificates of `s3-certs` |
| `garage` | none | `http://127.0.0.1:3900` | `garage`, enforced on every call | `dxflrs/garage:v2.4.1`, pinned by digest |
| `rustfs` | none | `http://127.0.0.1:9020` | never enforced; `us-east-1` used | `rustfs/rustfs:1.0.1`, pinned by digest |

The one-shots are `minio-principals`, `minio-seed`, `minio-region-principals`, `minio-region-seed`, `silo-principals`, `silo-seed`, `s3-certs`, `garage-keys`, `garage-setup`, `garage-seed`, `rustfs-principals` and `rustfs-seed`.
MinIO publishes no community image any more, so `minio` and `minio-region` run a frozen, unpatched build behind their own profiles, with `restart: "no"`; never expose them or reuse them outside acceptance.
`rustfs-principals` uses `pgsty/mc`, not the source-built client, because RustFS starts on a plain `up`, which must never build anything from source.
No console, admin or RPC port is published: the explorer never uses one.
No server has a data volume: removing a container resets it, and its one-shots fill it again.
Every port is bound to 127.0.0.1 only.

## Bringing them up

Name the compose project and every service, as every command here does.
Start a server with `up -d --wait`, which returns once it is healthy, and a one-shot with `up -d`, then read its exit code with `docker wait`, which must print `0`.
`garage` is started without `--wait`: its health probe answers only after `garage-setup` has applied the layout, and `garage-setup` waits for the node itself.

```sh
P="docker compose -p libredb-studio -f database-compose.yml"
$P up -d --wait silo rustfs
$P up -d garage
$P up -d silo-principals silo-seed rustfs-principals rustfs-seed garage-setup garage-seed
for c in silo-principals silo-seed rustfs-principals rustfs-seed garage-setup garage-seed; do docker wait libredb-$c; done
$P --profile s3-minio up -d --wait minio
$P --profile s3-minio up -d minio-principals minio-seed
$P --profile s3-region up -d --wait minio-region
$P --profile s3-region up -d minio-region-principals minio-region-seed
$P --profile s3-tls up -d --wait silo-tls
```

`silo-tls` is seeded by hand with the same two one-shots pointed at it; both speak HTTPS to it, so each mounts the `s3-certs` volume read-only and is given its CA:

```sh
$P run --rm --no-deps -T -v libredb-studio_s3-certs:/certs:ro -e SSL_CERT_FILE=/certs/CAs/ca.crt --entrypoint sh silo-principals /s3/principals.sh https://silo-tls:9000
$P run --rm --no-deps -T -v libredb-studio_s3-certs:/certs:ro -e S3_SEED_CA=/certs/CAs/ca.crt --entrypoint sh silo-seed /s3/seed.sh https://silo-tls:9000 us-east-1 silo
```

Then the run-time objects, once per target (`minio`, `minio-region`, `silo`, `garage`, `rustfs`):

```sh
bun tests/live/s3-seed-raw.ts --target silo
```

The live check and the seed-connections file need Garage's generated secrets and the TLS fixture's CA, copied out of their volumes:

```sh
dir=$(mktemp -d)
docker cp libredb-garage-keys:/keys "$dir/keys"
eval "$(sh docker/s3/garage-env.sh "$dir/keys")"
docker run --rm -v libredb-studio_s3-certs:/certs:ro alpine:3.22 cat /certs/ca.pem > "$dir/ca.pem"
export LIBREDB_S3_TLS_CA="$(cat "$dir/ca.pem")"
```

To start a server over: `$P rm -s -f -v <server> <its one-shots>`.
Garage's keys volume is removed only with `docker volume rm libredb-studio_s3-garage-keys`, and the TLS material only with `docker volume rm libredb-studio_s3-certs`.

## The scripts

| Script | Run by | What it does |
|---|---|---|
| `principals.sh <endpoint>` | `*-principals` | Creates the three users and two custom policies through `mc admin`, and attaches each user's policy only when it is missing |
| `seed.sh <endpoint> <region> <server>` | `*-seed` | Creates the buckets and writes every object below, signing with `curl --aws-sigv4`; a bucket whose last object exists is skipped |
| `seed.sh --raw <dir> ...` | `tests/live/s3-seed-raw.ts` | Writes only the run-time objects that script generated |
| `garage-keys.sh <dir>` | `garage-keys` | Generates Garage's RPC secret, admin and metrics tokens and four key secrets, each only when missing |
| `garage-setup.sh <admin url>` | `garage-setup` | Applies the layout and creates the buckets, keys, grants and the local alias through the admin API v2 |
| `garage-env.sh <dir>` | by hand | Prints `export` lines for the four Garage key secrets from a copy of the keys volume |
| `certs.sh <dir> <owner uid>` | `s3-certs` | Generates the TLS fixture's CA and certificate, naming `localhost`, `127.0.0.1` and `silo-tls`, only when missing |
| `make-data.ts` | by hand, `bun docker/s3/make-data.ts` | Writes `data/` and `data/SHA256SUMS`; the only writer of `data/` |

## Principals and keys

| Role | Access key | Password | Garage key | Why it exists |
|---|---|---|---|---|
| root | `libredb` | `Probe123pass!` | `GK000000000000000000000001` (`rw`): read, write and owner on every bucket | Seeding, and the everything column of the browser pass |
| browse | `studio-browse` | `Browse123pass!` | `GK000000000000000000000002` (`browse`): read on every bucket | The least privilege Studio needs; plan mode and the browser pass run as it |
| scoped | `studio-scoped` | `Scoped123pass!` | `GK000000000000000000000003` (`scoped`): read on `studio-scoped`, local alias `scoped-local` | A key that sees one bucket and cannot list all |
| getonly | `studio-getonly` | `Getonly123pass!` | `GK000000000000000000000004` (`none`): no grant | Reads a known key but cannot list; on Garage it sees nothing |

The access keys and passwords are the MinIO, MinIO region, Silo and RustFS principals; they are fixed throwaway values committed in plain text.
`studio-browse` holds `policies/studio-browse.json` (list buckets, bucket location, list and list versions, get object and get object version, nothing else), `studio-scoped` holds `policies/studio-scoped.json` (one bucket), and `studio-getonly` holds the built-in `readonly`.
Garage has no users or policies, only per-key, per-bucket grants, so it gets four keys with the same intent; their secrets are generated into the `s3-garage-keys` volume and never committed.

## Seeded data

| Bucket | Holds | Rows |
|---|---|---|
| `studio-demo` | Depth, folder markers, special keys, every preview format | A13 to A20, A28 to A42, A47 to A49, A58 to A61 |
| `studio-scoped` | `b-only/x.txt`, `b-only/table.csv` | A10, A12 |
| `studio-versions` | Versioning enabled (not on Garage): two versions of `ver/doc.txt`, a delete marker on `ver/deleted.txt`, then `ver/zz-last.txt` | A23b, A43, A62 |
| `studio-bulk` | 2,500 objects under `many/`, 1,100 one-object folders under `folders/`, 600 objects interleaved with 600 folders under `mixed/`; after the raw seed, 10,050 one-byte objects under `held/` | A21 to A23, B6 |
| `studio-empty` | nothing | The empty-state rows of the browser pass |

Every object body comes from a fixed `printf` in `seed.sh`, from the committed preview fixtures under `tests/fixtures/s3/preview/` (mounted at `/preview`), or from `data/`, so every server holds byte-identical objects.
Every PUT sets its `Content-Type` explicitly; `data/rows.ndjson` is stored as `application/octet-stream` and `data/noext` with no type at all, on purpose.
`data/multipart.bin` is a two-part multipart upload of 6,291,456 bytes, whose digest is the derived line of `data/SHA256SUMS`.
The raw seed adds `parquet/large/narrow-zstd.parquet` (5 columns, 1,000,000 rows) and `parquet/large/wide-zstd.parquet` (60 columns, 200,000 rows) to `studio-demo`, which are too large to commit.

## Special keys

`seed.sh`'s `SPECIAL_KEYS` table gives each special key's wire form and the outcome every server must give; the first seed run measures every `measure` cell, and this section then records each measured outcome.

## Bounds, as measured

Written by the first run.

## Telemetry

Written by the first run.

## First-run measurements

Written by the first run.

## The SSH bastion of the tunnel check

Written by the first run.
