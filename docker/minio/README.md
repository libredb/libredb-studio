# MinIO, built from source

MinIO's community edition is archived and no longer distributed as images or binaries; this directory builds the last release, `RELEASE.2025-10-15T17-29-55Z`, and the matching client, `RELEASE.2025-08-13T08-35-41Z`, from their commits.
It is frozen: nothing upstream will patch it.
It is unpatched: GHSA-hv4r-mvr4-25vw (CVSS 8.8, PutObject and PutObjectPart upload paths) and the other advisories of March to April 2026 are fixed only in AIStor.
So it runs behind the `s3-minio` and `s3-region` profiles, never on a plain `up`, with `restart: "no"` so the Docker daemon never restarts it after a reboot, its port is bound to 127.0.0.1 only, its credentials are throwaway, and it must never be exposed or reused outside acceptance.
It exists because v1 of the `s3` provider must prove compatibility with MinIO, which is still widely deployed; a later version may drop it for Garage plus RustFS.
The build needs network access to `proxy.golang.org` and `sum.golang.org`, takes minutes the first time, and leaves BuildKit cache entries that are not pruned by name.

## The two targets

`server` builds `/usr/bin/minio` and `mc` builds `/usr/bin/mc`, each from its own build stage, so building the `mc` target never compiles the server.
Both run as uid 10001.
The compose services set `pull_policy: build`, so the image names `libredb-fixture/minio` and `libredb-fixture/mc` are never pulled from any registry.

## The Go image

`golang:1.24.13-alpine3.22`, pinned by its index digest `sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5`, read on 2026-10-09 (empty `DOCKER_CONFIG`) with:

```sh
docker buildx imagetools inspect golang:1.24.13-alpine3.22
```

```text
Name:      docker.io/library/golang:1.24.13-alpine3.22
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5
```

`GOTOOLCHAIN=local` stops Go from downloading another toolchain, and `GOSUMDB` keeps module checksum verification on.
The alpine runtime image is pinned by the digest in the Dockerfile.

## Build, as measured

First build on 2026-10-10 (empty `DOCKER_CONFIG`, cold Go module cache): the `server` target took 2 min 34 s and the `mc` target 1 min 11 s.

```sh
docker build --target server -t libredb-fixture/minio:RELEASE.2025-10-15T17-29-55Z docker/minio
docker build --target mc -t libredb-fixture/mc:RELEASE.2025-08-13T08-35-41Z docker/minio
docker run --rm --entrypoint cat libredb-fixture/minio:RELEASE.2025-10-15T17-29-55Z /usr/bin/minio.buildinfo | sed -n '1,3p'
docker run --rm --entrypoint cat libredb-fixture/mc:RELEASE.2025-08-13T08-35-41Z /usr/bin/mc.buildinfo | sed -n '1,3p'
```

```text
/go/bin/minio: go1.24.13
	path	github.com/minio/minio
	mod	github.com/minio/minio	v0.0.0-20251015172955-9e49d5e7a648	h1:6TdolSCLSs2nwm8i0PpWDqf9iX2Ty9WQK8wmr7dCnUM=
```

```text
/go/bin/mc: go1.24.13
	path	github.com/minio/mc
	mod	github.com/minio/mc	v0.0.0-20250813083541-7394ce0dd2a8	h1:9tuRE4iEaDkuxatxe7pddYYh1SX5mT0/D0haofZFeTY=
```

The images are `libredb-fixture/minio:RELEASE.2025-10-15T17-29-55Z` (159 MB) and `libredb-fixture/mc:RELEASE.2025-08-13T08-35-41Z` (52.3 MB).
A capture's manifest names the local image id beside these build lines, and a rebuild gives a new id even from the same commits, so a set recorded after a rebuild carries a different id.
The server ran as uid 10001 on the first `up` of 2026-10-10: `docker exec libredb-minio id -u` printed `10001`, and so did `libredb-minio-region`.
