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
`garage` is started without `--wait`: its health probe exits 0 once the node answers, before a layout exists, so it says nothing about whether Garage can serve.
`garage-setup` applies the layout and polls `GetClusterHealth` itself until the status is `healthy`.

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
| `studio-bulk` | 2,500 objects under `many/`, 1,100 one-object folders under `folders/`, 600 objects interleaved with 600 folders under `mixed/`; after the raw seed, 10,050 one-byte objects under `held/` | A21 to A23, and the browser pass of the Keys panel's held limit |
| `studio-empty` | nothing | The empty-state rows of the browser pass |

Every object body comes from a fixed `printf` in `seed.sh`, from the committed preview fixtures under `tests/fixtures/s3/preview/` (mounted at `/preview`), or from `data/`, so every server holds byte-identical objects.
Every PUT sets its `Content-Type` explicitly; `data/rows.ndjson` is stored as `application/octet-stream` and `data/noext` with no type at all, on purpose.
`data/multipart.bin` is a two-part multipart upload of 6,291,456 bytes, whose digest is the derived line of `data/SHA256SUMS`.
The raw seed adds `parquet/large/narrow-zstd.parquet` (5 columns, 1,000,000 rows) and `parquet/large/wide-zstd.parquet` (60 columns, 200,000 rows) to `studio-demo`, which are too large to commit.

## Special keys

`seed.sh`'s `SPECIAL_KEYS` table holds each special key's wire form and the outcome each server gave on the first seed run, measured on 2026-10-10; the seed asserts it on every later run.
MinIO and the MinIO region variant gave the same outcome for every key.

| Key (as stored) | Sent on the wire as | MinIO, MinIO region | Silo | Garage | RustFS |
|---|---|---|---|---|---|
| `sp/with space.txt` | `sp/with%20space.txt` | stored | stored | stored | stored |
| `sp/plus+sign.txt` | `sp/plus%2Bsign.txt` | stored | stored | stored | stored |
| `sp/percent%sign.txt` | `sp/percent%25sign.txt` | stored | stored | stored | stored |
| `sp/ünïcødé-日本.txt` | `sp/%C3%BCn%C3%AFc%C3%B8d%C3%A9-%E6%97%A5%E6%9C%AC.txt` | stored | stored | stored | stored |
| `sp/lt<amp&.txt` | `sp/lt%3Camp%26.txt` | stored | stored | stored | stored |
| `sp/.hidden` | `sp/.hidden` | stored | stored | stored | stored |
| `sp/trail.` | `sp/trail.` | stored | stored | stored | stored |
| `sp/lit%2Fname.txt` | `sp/lit%252Fname.txt` | stored | stored | stored | stored |
| `sp/tab<TAB>char.txt` | `sp/tab%09char.txt` | stored | stored | stored | stored |
| `ctl/x<U+0001>y.txt` | `ctl/x%01y.txt` | stored | stored | stored | stored |
| `long/` and four segments of 250, 250, 250 and 245 characters of `abcdefghijklmnopqrstuvwxyz` repeated, 1,003 bytes | the same | stored | stored | stored | stored |
| `sp/double//slash.txt` | `sp/double//slash.txt` | 400:XMinioInvalidObjectName | 400:XMinioInvalidObjectName | stored | 400:InvalidArgument |
| `sp/./dot.txt` | `sp/./dot.txt` | 400:XMinioInvalidResourceName | 400:XMinioInvalidResourceName | stored | 400:InvalidArgument |
| `sp/x/../dotdot.txt` | `sp/x/../dotdot.txt` | 400:XMinioInvalidResourceName | 400:XMinioInvalidResourceName | stored | 400:InvalidArgument |

## Bounds, as measured

Measured on 2026-10-10 on containers started from empty data, after the seed, the raw seed and one live check run of every target.
`memory.peak` is the container's cgroup peak, read from the host because the Garage image carries no `cat`; it counts the page cache of the objects written as well as the process.

| Server | Resident after the seed and the live check | `memory.peak` | Bound |
|---|---|---|---|
| `minio` | 398 MiB | 712,400,896 bytes (679 MiB) | 2816M |
| `minio-region` | 405 MiB | 662,556,672 bytes (632 MiB) | 2560M |
| `silo` | 345 MiB | 658,399,232 bytes (628 MiB) | 2560M |
| `silo-tls` | 230 MiB | 489,177,088 bytes (467 MiB) | 2048M |
| `garage` | 22 MiB | 86,540,288 bytes (83 MiB) | 512M |
| `rustfs` | 195 MiB | 460,582,912 bytes (439 MiB) | 1792M |

Each bound is at least four times the server's peak, rounded up to a whole 256M, with `memswap_limit` equal to it.
The resident size was not read separately between the seed and the live check, so one column holds both.
The largest one-shot peak was `pgsty/mc` attaching a policy in `principals.sh`: 172,769,280 bytes (165 MiB), against 26,259,456 bytes for a full `seed.sh` run.
Under the first 128M bound the kernel killed that `mc` (exit 137, `OOMKilled` true) on the first attach, so every one-shot is bounded at 768M, at least four times that peak.

## Telemetry

Read from each server's source at its pinned release on 2026-10-10.

| Server | Default | Switch set here |
|---|---|---|
| MinIO `RELEASE.2025-10-15T17-29-55Z` | At startup the server asks dl.min.io for a newer release unless `MINIO_UPDATE` is `off` ([cmd/server-main.go](https://github.com/minio/minio/blob/RELEASE.2025-10-15T17-29-55Z/cmd/server-main.go), "Check for updates in non-blocking manner", and [cmd/common-main.go](https://github.com/minio/minio/blob/RELEASE.2025-10-15T17-29-55Z/cmd/common-main.go)); call home is off by default ([internal/config/callhome/callhome.go](https://github.com/minio/minio/blob/RELEASE.2025-10-15T17-29-55Z/internal/config/callhome/callhome.go), `DefaultKVS`) | `MINIO_UPDATE: "off"` on `minio` and `minio-region` |
| Silo `RELEASE.2026-09-16T00-00-00Z` | No update check at startup ([cmd/server-main.go](https://github.com/pgsty/silo/blob/RELEASE.2026-09-16T00-00-00Z/cmd/server-main.go)); call home is off by default ([internal/config/callhome/callhome.go](https://github.com/pgsty/silo/blob/RELEASE.2026-09-16T00-00-00Z/internal/config/callhome/callhome.go), `DefaultKVS`) | None needed; Silo shares MinIO's variables, so `MINIO_UPDATE: "off"` reaches it too and changes nothing |
| RustFS `1.0.1` | At startup the server asks version.rustfs.com for the latest release unless `RUSTFS_CHECK_UPDATE` is `false` ([rustfs/src/init.rs](https://github.com/rustfs/rustfs/blob/1.0.1/rustfs/src/init.rs), `init_update_check`, and [crates/config/src/constants/console.rs](https://github.com/rustfs/rustfs/blob/1.0.1/crates/config/src/constants/console.rs), `DEFAULT_UPDATE_CHECK`); the OpenTelemetry endpoint is empty by default ([crates/config/src/constants/app.rs](https://github.com/rustfs/rustfs/blob/1.0.1/crates/config/src/constants/app.rs), `DEFAULT_OBS_ENDPOINT`) | `RUSTFS_CHECK_UPDATE: "false"` on `rustfs` |
| Garage `v2.4.1` | Nothing is sent unless `admin.trace_sink` names an OpenTelemetry collector ([configuration reference](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.4.1/doc/book/reference-manual/configuration.md), `trace_sink`), and `garage.toml` sets none | None needed |

## First-run measurements

Measured on 2026-10-10, from no S3 container or volume.

- `minio` and `minio-region` served as uid 10001: `docker exec libredb-minio id -u` printed `10001`.
- `silo-tls` reached healthy with `command: ["server", "/data", "--certs-dir", "/certs"]`.
- Garage's health probe on a fresh volume, 5 s after start and before `garage-setup` applied the layout: the container was `healthy` and `GetClusterHealth` exited 0 answering `"status": "unavailable"` with no storage node, so the probe says only that the node answers.
- `garage-setup.sh` made its admin API calls and exited 0 twice in a row, and `GetKeyInfo` read back the grants of the table under "Principals and keys": `rw` read, write and owner on the five buckets, `browse` read on the five, `scoped` read on `studio-scoped` with the local alias `scoped-local`, `none` no bucket.
- `pgsty/mc` managed RustFS users and policies: `rustfs-principals` printed `principals.sh: 3 users, 2 policies`, and `mc admin user info` showed `studio-browse`, `studio-scoped` and `readonly` attached to their users.
- The two by-hand `silo-tls` one-shots exited 0 twice in a row with the CA given by `SSL_CERT_FILE` (for `mc`) and `S3_SEED_CA` (for the seed), the lines under "Bringing them up"; the second seed printed `0 objects written, 4 buckets skipped`.
  The seed counts the four buckets that have a last object; `studio-empty` has none to skip.
- Every one-shot ran a second time and exited 0, each seed printing `0 objects written, 4 buckets skipped`.
- The seed wrote 4,839 objects per server: 42 s on MinIO and 41 s on MinIO region, run side by side; 43 s on Silo; 42 s on Garage and 60 s on RustFS, run side by side; 68 s on `silo-tls`.
- The raw seed wrote 10,052 objects per target in 89 to 90 s on MinIO, MinIO region, Silo and Garage and 116 s on RustFS, DuckDB's generation included; a second run wrote nothing in about 2.4 s.
- Each server's outcome for each special key is under "Special keys"; the `café` value of `meta/tagged.txt` came back as `=?UTF-8?q?caf=C3=A9?=` from MinIO and Silo, as `café` from Garage and as `=?UTF-8?B?Y2Fmw6k=?=` from RustFS.

## The SSH bastion of the tunnel check

The repository defines no SSH bastion; this is the one the tunnel check used on 2026-10-10, the newest `lscr.io/linuxserver/openssh-server` tag at least 14 days old, pinned by digest:

```sh
export LIVE_SSH_PASSWORD="$(openssl rand -hex 16)"
docker run -d --rm --name libredb-s3-bastion --network libredb-studio_default -p 127.0.0.1:12222:2222 \
  -e PASSWORD_ACCESS=true -e USER_NAME=tunnel -e USER_PASSWORD="$LIVE_SSH_PASSWORD" \
  -e DOCKER_MODS=linuxserver/mods:openssh-server-ssh-tunnel lscr.io/linuxserver/openssh-server:10.3_p1-r1-ls237@sha256:946fa26105e0ec212fdf821b9ddc59aab65f2c2d07c02b25ff0f5001fc332ff0
bun tests/live/s3-tunnel-check.ts --ca "$dir/ca.pem"
docker stop libredb-s3-bastion
```
