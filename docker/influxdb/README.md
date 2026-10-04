# InfluxDB fixtures

The live InfluxDB servers of `database-compose.yml`, the one-shot that seeds them, and the data and scripts it writes.
The `influxdb` type reads 1.13.1 and 2.9.1 over the v1 `/query` API, and both the `influxdb` and the `influxdb3` types read 3.12.0 Core.
The evidence harness (`tests/live/influxdb-evidence.ts`, with its statement plan in `tests/live/influxdb-evidence-plan.ts`) and every hand pass run against these servers.

## The servers

| Service | Profile | From the host | Image | Authentication |
|---|---|---|---|---|
| `influxdb1` | none | `127.0.0.1:8087` | `influxdb:1.13.1` | users: `admin` and `reader` |
| `influxdb2` | none | `127.0.0.1:8086` | `influxdb:2.9.1` | tokens: the operator token and a read-only token for bucket `home` |
| `influxdb3` | none | `127.0.0.1:8181` | `influxdb:3.12.0-core` | the admin token |
| `influxdb3-filelimit` | `influxdb-filelimit` | `127.0.0.1:8182` | `influxdb:3.12.0-core` | the admin token |

Each image is pinned by tag and by digest in the compose file:

| Image | Digest |
|---|---|
| `influxdb:1.13.1` | `sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0` |
| `influxdb:2.9.1` | `sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e` |
| `influxdb:3.12.0-core` | `sha256:624d69bca6bf6fb174aca5a974e1d96e5c5486994e6ae35bc9b4fe02b9520076` |

The one-shot `influxdb-seed` runs `seed.sh` in the 2.9.1 image, which carries bash, curl and GNU date, so the seed pulls no image of its own.
Every port is bound to a loopback address only, and each server is bounded to 2 CPUs and 2 GiB with no swap past it.
No server has a named data volume.
The 1.x and 2.x images declare anonymous volumes for their data, which `up --force-recreate` keeps, so a reset removes them with the container (`rm -v`, below); the 3.x image declares none.
Each server reports nothing to InfluxData (`INFLUXDB_REPORTING_DISABLED`, `INFLUXD_REPORTING_DISABLED`, `--disable-telemetry-upload`).

The healthchecks probe `/ping` with the curl each image carries.
On 1.x and 2.x `/ping` needs no credential and answers 204; on 3.x it needs a token, so its probe sends the admin token.

`influxdb3-filelimit` is the same server started with `--query-file-limit 1`, so a query over more than one Parquet file meets the Core file-limit error.
It also takes `--wal-files-per-snapshot 1` and `--force-snapshot-max-age 10s`, so the seed is persisted to Parquet within seconds of the write instead of after the default 600 WAL files or one hour.

## The principals

These are fixed test credentials in the compose file's convention, never real ones.

| Server | Principal | Rights | How to send it |
|---|---|---|---|
| `influxdb1` | `admin` / `password123` | admin, created by the image from `INFLUXDB_ADMIN_USER` | Basic |
| `influxdb1` | `reader` / `readonly123` | `GRANT READ ON home` only, created by the seed | Basic |
| `influxdb2` | user `admin` / `password123`, org `libredb` | owner; the UI login | the UI |
| `influxdb2` | `libredb-influxdb2-operator-token` | all access, from `DOCKER_INFLUXDB_INIT_ADMIN_TOKEN` | `Authorization: Token` |
| `influxdb2` | the token described `libredb read-only home` | read on bucket `home` only, created by the seed | `Authorization: Token` |
| `influxdb3`, `influxdb3-filelimit` | `apiv3_libredb-influxdb3-admin-token` | the admin token | `Authorization: Bearer` |

The 3.x admin token reaches the server as the file `serve --admin-token-file` reads.
`influxdb3 create token --admin --offline --output-file <file>` writes that file as `{"token": "apiv3_...", "name": "_admin"}` with a random token; the service's entrypoint writes the same shape with the fixed test token instead, so every principal here is readable from the compose file.

2.9.1 shows a token's value only in the answer that creates it: a listing returns `"token": ""` for every token, the operator's included, and a `token` field sent to `POST /api/v2/authorizations` is ignored.
So the seed keeps the read-only token in the `influxdb2-read-token` volume, and replaces it when it no longer opens the server.
Read it out of the one-shot's container:

```sh
docker cp libredb-influxdb-seed:/tokens/influxdb2-read-token - | tar -xO
```

## Bringing them up

Name the compose project and every service, as every command here does.
`up` with no service names starts every server in `database-compose.yml`, and the project name keeps one set of volumes when a command runs from a git worktree.

```sh
docker compose -p libredb-studio -f database-compose.yml up -d --wait influxdb1 influxdb2 influxdb3
docker compose -p libredb-studio -f database-compose.yml up -d influxdb-seed
docker wait libredb-influxdb-seed
```

`docker wait` must print `0`.
The servers answer in a few seconds.
To read the seed back with the read principals, each line answering 26:

```sh
q='q=SELECT count(temp) FROM "home".."home"'
reader=reader:readonly123
read_token=$(docker cp libredb-influxdb-seed:/tokens/influxdb2-read-token - | tar -xO)
admin_token=apiv3_libredb-influxdb3-admin-token
curl -s -X POST http://127.0.0.1:8087/query -u "$reader" --data-urlencode "$q"
curl -s -X POST http://127.0.0.1:8086/query -H "Authorization: Token $read_token" --data-urlencode db=home --data-urlencode "$q"
curl -s -X POST http://127.0.0.1:8181/query -H "Authorization: Bearer $admin_token" --data-urlencode db=home --data-urlencode "$q"
```

The file-limit fixture is started, seeded from the host (`bulk.py` needs `python3`) and stopped by hand:

```sh
docker compose -p libredb-studio -f database-compose.yml --profile influxdb-filelimit up -d --wait influxdb3-filelimit
docker/influxdb/seed.sh filelimit
docker compose -p libredb-studio -f database-compose.yml stop influxdb3-filelimit
```

## Reseeding

The `home` sample's timestamps are the seed time minus 0 to 25 hours, so a one-hour preview of `home` has a row only within the hour after the seed.
The seed writes `home.lp` only to a server whose `home` measurement is empty, because a second copy at later timestamps would double the sample; `edge.lp` has fixed timestamps, so writing it again changes nothing.
To reseed with fresh timestamps, remove the servers with their anonymous volumes, start them again, then run the one-shot again:

```sh
docker compose -p libredb-studio -f database-compose.yml rm -s -f -v influxdb1 influxdb2 influxdb3
docker compose -p libredb-studio -f database-compose.yml up -d --wait influxdb1 influxdb2 influxdb3
docker compose -p libredb-studio -f database-compose.yml up -d influxdb-seed
docker wait libredb-influxdb-seed
```

The seed then finds that the read-only token it kept no longer opens the new 2.x server, and creates and keeps a new one.

## The scripts and the data

- `seed.sh` is the only writer of these fixtures; Studio never runs it, and the evidence harness never imports or runs it.
  With no argument it creates the 1.x database `edge`, the 1.x reader, the 2.x bucket `edge` and the 2.x read-only token, then writes `home.lp` and `edge.lp` through each server's own write endpoint (`/write`, `/api/v2/write`, `/api/v3/write_lp`); this is what the one-shot runs.
  `seed.sh filelimit` writes `bulk.py filelimit` to `influxdb3-filelimit`.
  `seed.sh bench` writes `bulk.py bench` to database `bench` on all three servers; it is run by hand for the bounds measurement only, never by the one-shot.
  Run on the host it talks to the published ports; in the one-shot the compose file points it at the service names.
- `home.lp` is measurement `home` in database `home`: tag `room` (`Kitchen`, `Living Room`), float fields `temp` and `hum`, and the integer field `co`, missing on the two oldest points; 26 points, one an hour, the rooms alternating.
  Each timestamp is a placeholder `NOW-<k>H` that the seed replaces with the seed time minus k hours.
- `edge.lp` is written to databases `home` and `edge` on every server, with fixed timestamps on 2022-01-01:
  - measurement `edge`: int64 max and min, 2^53 + 1, uint64 max (not on 1.x, whose OSS line protocol refuses the `u` suffix), two points a nanosecond apart in one series, a string with double quotes, a comma, an apostrophe and a backslash, and a boolean;
  - measurement `numbers`: two points with an integer and a float field, the target of the two-database read and the cross-database table reference;
  - measurement `sparse`: three points that each carry a different subset of the fields;
  - measurement `edge cases,m`: a measurement and tag and field keys holding spaces, `=`, a comma, unicode and a double quote;
  - measurement `we"ird name;x`: the hostile name.
- `bulk.py` prints line protocol on stdout and writes nothing itself:
  - `filelimit`: measurement `home` with the `home.lp` fields, two rooms, one point per room every 4 hours over the last 80 hours; the 21 timestamps fall in 21 gen1 windows of the default 10 minutes, so the fixture persists 21 Parquet files (`SELECT table_name, count(*) FROM system.parquet_files GROUP BY table_name` answered `home`, 21 on 2026-10-04), and `SELECT count(*) FROM "home"` answers the file-limit 500;
  - `bench`: measurement `bulk` (100 hosts by 20,000 seconds, 2,000,000 points; tag `host`, float fields `f1` to `f3`, integer fields `i1` and `i2`, `i2` being the second's index) and measurement `wide200` (tag `host` and 200 float fields, 2,000 points), both ending at the current time.

The data is original, written for this repository; InfluxData's sample data is not vendored.
