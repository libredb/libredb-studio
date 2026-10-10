# The last community MinIO server and client, built from their exact release commits, because MinIO
# publishes no community image any more (docker/minio/README.md). Frozen and unpatched on purpose.
FROM golang:1.24.13-alpine3.22@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5 AS build-minio
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
# RELEASE.2025-10-15T17-29-55Z, by commit so a moved tag cannot change the build.
RUN go install github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
 && go version -m /go/bin/minio > /go/bin/minio.buildinfo

FROM golang:1.24.13-alpine3.22@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5 AS build-mc
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
# RELEASE.2025-08-13T08-35-41Z, by commit.
RUN go install github.com/minio/mc@7394ce0dd2a80935aded936b09fa12cbb3cb8096 \
 && go version -m /go/bin/mc > /go/bin/mc.buildinfo

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS server
COPY --from=build-minio /go/bin/minio /go/bin/minio.buildinfo /usr/bin/
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data"]

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS mc
COPY --from=build-mc /go/bin/mc /go/bin/mc.buildinfo /usr/bin/
USER 10001:10001
ENV MC_CONFIG_DIR=/tmp/.mc
ENTRYPOINT ["/usr/bin/mc"]
