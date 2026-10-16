# Netopeer2, built from source, because the published images are older than the release this
# fixture pins: on Docker Hub `sysrepo/netopeer2` has one tag, `latest`, last pushed 2025-05-16,
# and `sysrepo/sysrepo-netopeer2` was last pushed 2023-02-01 (read 2026-10-13).
# The four CESNET and sysrepo release tarballs are fetched by tag and checked against the sha256
# sums measured on 2026-10-13, the way docker/minio builds MinIO from a commit.
#
# Three build facts measured on 2026-10-13 while writing this file. Each one breaks the image in a
# different way if it is dropped, and two of them break it silently:
#   1. `cmake --install` runs netopeer2's merge_hostkey.sh, which looks for the openssl EXECUTABLE.
#      libssl-dev alone is not enough: the install step exits 1 with
#      "Unable to find mbedtls nor openssl executable".
#   2. netopeer2-server installs into /usr/local/sbin, not /usr/local/bin. A multi-stage image that
#      copies only bin builds and tags cleanly, then fails at `docker run` with
#      "executable file not found in $PATH".
#   3. libpam0g-dev is needed for the keyboard-interactive user of the fixture.
# The server image stays small by leaving the toolchain behind: measured 38.0 MB against the
# 552 MB a single-stage build of the same sources produces.
#
# BOTH BASES ARE PINNED BY DIGEST, which is what this fixture was missing. The sources are held by
# `SHA256SUMS`, so the tarballs cannot move; the base could, and `debian:trixie-slim` is a rolling
# tag that gains a new image on every point release. A fixture whose expected outcomes are read
# back by tests cannot rest on a tag that is a different image next week - the one measured
# weakness of pinning sources rather than an image is exactly this.
#
# The digest is the multi-platform INDEX digest, not one platform's manifest: checked with
# `docker manifest inspect`, it is an `image.index.v1+json` carrying amd64 and arm64 among seven
# architectures, so CI on amd64 and a developer's arm64 Mac both resolve it. Pinning a single
# manifest would have broken one of the two.

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config ca-certificates curl \
      libpcre2-dev libssl-dev libssh-dev libcurl4-openssl-dev zlib1g-dev \
      openssl libpam0g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Versions and sums read from the projects' GitHub releases on 2026-10-13. All four were the
# current release that day and all four were published on 2026-06-22.
ARG LIBYANG=5.8.6
ARG LIBNETCONF2=4.4.10
ARG SYSREPO=5.1.0
ARG NETOPEER2=2.8.7
COPY SHA256SUMS .
RUN curl -fsSL -o libyang-${LIBYANG}.tar.gz      https://github.com/CESNET/libyang/archive/refs/tags/v${LIBYANG}.tar.gz \
 && curl -fsSL -o libnetconf2-${LIBNETCONF2}.tar.gz https://github.com/CESNET/libnetconf2/archive/refs/tags/v${LIBNETCONF2}.tar.gz \
 && curl -fsSL -o sysrepo-${SYSREPO}.tar.gz      https://github.com/sysrepo/sysrepo/archive/refs/tags/v${SYSREPO}.tar.gz \
 && curl -fsSL -o netopeer2-${NETOPEER2}.tar.gz  https://github.com/CESNET/netopeer2/archive/refs/tags/v${NETOPEER2}.tar.gz \
 && sha256sum -c SHA256SUMS

RUN tar xzf libyang-${LIBYANG}.tar.gz \
 && cmake -S libyang-${LIBYANG} -B build-libyang -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build-libyang -j"$(nproc)" && cmake --install build-libyang && ldconfig
RUN tar xzf libnetconf2-${LIBNETCONF2}.tar.gz \
 && cmake -S libnetconf2-${LIBNETCONF2} -B build-libnetconf2 -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build-libnetconf2 -j"$(nproc)" && cmake --install build-libnetconf2 && ldconfig
RUN tar xzf sysrepo-${SYSREPO}.tar.gz \
 && cmake -S sysrepo-${SYSREPO} -B build-sysrepo -DCMAKE_BUILD_TYPE=Release -DREPO_PATH=/etc/sysrepo \
 && cmake --build build-sysrepo -j"$(nproc)" && cmake --install build-sysrepo && ldconfig
# This step also generates the SSH host key, so the fixture's fingerprint is fixed at build time
# and a live check reads it out of band with `docker exec`.
RUN tar xzf netopeer2-${NETOPEER2}.tar.gz \
 && cmake -S netopeer2-${NETOPEER2} -B build-netopeer2 -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build-netopeer2 -j"$(nproc)" && cmake --install build-netopeer2

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpcre2-8-0 libssl3 libssh-4 libcurl4 zlib1g openssl libpam0g openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/ /usr/local/lib/
COPY --from=build /usr/local/bin/ /usr/local/bin/
# Build fact 2: the server binary lives here.
COPY --from=build /usr/local/sbin/ /usr/local/sbin/
COPY --from=build /usr/local/share/ /usr/local/share/
COPY --from=build /etc/sysrepo/ /etc/sysrepo/
RUN ldconfig
COPY setup.sh /usr/local/bin/libredb-netconf-setup
RUN chmod +x /usr/local/bin/libredb-netconf-setup
# How many ietf-interfaces entries the fixture loads. 5000 is the size the provider's read sizes
# were measured at; a smaller number makes the container start faster for a focused test.
ENV LIBREDB_NETCONF_INTERFACES=5000
EXPOSE 830
CMD ["/usr/local/bin/libredb-netconf-setup"]
