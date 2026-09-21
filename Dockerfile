# ==============================================================================
# LibreDB Studio - Production Dockerfile
# Optimized for Render, Railway, Fly.io, and Kubernetes
# ==============================================================================

# Bun for fast dependency installation, Node.js for build
# Bun's JIT compiler segfaults under QEMU emulation (ARM64 cross-build),
# so we use Node.js for the Next.js build step.
FROM oven/bun:1.4.2 AS deps
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build with Node.js to avoid Bun/QEMU segfaults on ARM64.
# trixie-slim keeps the toolchain consistent with the oven/bun deps stage, but
# it is no longer load-bearing for the better-sqlite3 native module: v13 ships
# every prebuild inside the package and picks one in the RUNNING process
# (lib/binding.js reads process.platform/arch and detects musl via
# process.report), so neither the ABI nor the libc of the installing stage
# constrains the stage that requires it.
#
# @duckdb/node-api works differently and the reasoning above does NOT transfer:
# its binaries live in separate per-libc, per-platform packages
# (@duckdb/node-bindings-<platform>-<arch>[-musl]), so the libc choice is made
# partly at INSTALL time - which optional package the deps stage fetches - and
# partly at runtime, where @duckdb/node-bindings uses detect-libc to pick
# between whichever ones are present. Every stage here is glibc, so the glibc
# package is the one installed and the one loaded; keeping the stages on the
# same base is what makes that hold.
FROM node:26.9.0-trixie-slim AS builder
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_BUILD=true

# Next.js bakes this prefix into routes and browser bundles. Rebuild to change it.
ARG BASE_PATH=""

ARG JWT_SECRET_BUILD="build-time-placeholder-secret-32ch"
ARG ADMIN_PASSWORD_BUILD="build"
ARG USER_PASSWORD_BUILD="build"
ENV JWT_SECRET=$JWT_SECRET_BUILD
ENV ADMIN_PASSWORD=$ADMIN_PASSWORD_BUILD
ENV USER_PASSWORD=$USER_PASSWORD_BUILD

# Stage Monaco from node_modules into public/ so the editor is served from our own
# origin (issue #247). Explicit here: this bypasses the package.json build script.
RUN node scripts/copy-monaco.mjs && npx next build

# Drop the repo-root extras Next's output file tracing swept into the payload
# (issue #124). Tracing walks the repository root, so `.next/standalone` carries
# `src/`, `scripts/`, the lockfile, the tooling configs and this file - and the
# runner below unpacks all of it onto /app. Shipping application source in a
# production image is a security property before it is a size one.
#
# The deny-list is not reimplemented here: `prune-standalone-payload.sh` is the
# one the release tarballs, .deb/.rpm, snap and the npx cache already use, so a
# new root file leaves every artifact family through one edit. The script refuses
# to run against anything that is not an assembled payload, and the asserts below
# are what turn an over-eager future entry into a failed build rather than a
# provider failing at runtime. `seed-assets/` is not on the list and is COPYed
# explicitly below in any case; nothing else under /app is read at runtime
# (src/lib/seed/sqlite-sample.ts is the only `process.cwd()` reader).
#
# HERE rather than in the runner: an `rm` after a COPY deletes the files in a
# later layer while leaving every byte of them in the layer the COPY created.
#
# `public/screenshots` goes with it: 4.4 MB of README and marketing artwork that
# no running container ever serves, because src/app/layout.tsx points social
# previews at raw.githubusercontent.com. It is not a payload-root entry, so the
# deny-list cannot reach it.
#
# The native payload is pruned in the same step, and it is the larger half.
# Neither `@duckdb/node-bindings-<platform>-<arch>[-musl]` package declares a
# libc field, so bun installs the glibc AND the musl one whatever the stage runs
# on; sharp ships the same way; and better-sqlite3 13 carries eight prebuilds
# (darwin, win32, linux, linuxmusl x two arches) plus the 9.9 MB SQLite
# amalgamation it would compile from if it ever had to. Measured in the image
# published on 2026-09-18: 71 MB of musl DuckDB bindings, 19 MB of musl libvips
# and six unloadable prebuilds, none of which any process in a glibc image can
# open. It lands twice, because `next build` writes a second traced copy of
# those packages into `.next/standalone/node_modules` and the runner unpacks it
# onto the same /app the explicit COPYs below land in - which is why the loop
# below walks both trees, and why this step took the image from 892 MB to 649 MB
# (292 MB to 203 MB compressed, amd64) rather than the ~115 MB one tree holds.
#
# GLOBS AND $(node -p process.arch), NEVER A LITERAL. The deps stage installs the
# bindings package for the BUILD arch, so naming linux-x64 would break the arm64
# leg of the same manifest (tests/unit/packaging-duckdb-native.test.ts asserts
# that literal is absent). `*-linux-*` does not match `*-linuxmusl-*`, because
# "linux-" is not a prefix of "linuxmusl-", so the two sharp patterns below are
# each other's complement rather than overlapping.
#
# The `test` lines are the point of the step: a glob that took the payload this
# image DOES load would otherwise surface as a provider failing at runtime, long
# after the build went green.
#
# oracledb keeps every platform's addon on purpose. This is the only variant
# where Thick mode can be turned on at all, the whole build/ directory is ~3 MB,
# and the package resolves the addon at runtime from its own __dirname.
RUN set -eux; \
    bash scripts/lib/prune-standalone-payload.sh .next/standalone; \
    rm -rf public/screenshots .next/standalone/public/screenshots; \
    ARCH="$(node -p 'process.arch')"; \
    for root in node_modules .next/standalone/node_modules; do \
      [ -d "$root/@duckdb" ] && find "$root/@duckdb" -maxdepth 1 -type d -name 'node-bindings-*-musl' -exec rm -rf {} + ; \
      [ -d "$root/@img" ] && find "$root/@img" -maxdepth 1 -type d -name '*-linuxmusl-*' -exec rm -rf {} + ; \
      [ -d "$root/better-sqlite3/prebuilds" ] && find "$root/better-sqlite3/prebuilds" -maxdepth 1 -type f -name '*.node' ! -name "linux-${ARCH}.node" -delete ; \
      rm -rf "$root/better-sqlite3/deps" "$root/better-sqlite3/src" "$root/better-sqlite3/binding.gyp"; \
      true; \
    done; \
    test -f "node_modules/@duckdb/node-bindings-linux-${ARCH}/libduckdb.so"; \
    test -d "node_modules/@img/sharp-libvips-linux-${ARCH}"; \
    test -f "node_modules/better-sqlite3/prebuilds/linux-${ARCH}.node"; \
    test -d node_modules/oracledb/build; \
    test -f .next/standalone/server.js; \
    test -d .next/standalone/node_modules; \
    test ! -e .next/standalone/src; \
    test ! -e .next/standalone/Dockerfile; \
    echo "--- native payload surviving the prune ---"; \
    find node_modules .next/standalone/node_modules \( -name '*.node' -o -name '*.so' -o -name '*.so.*' \) | sort | xargs -r ls -lh | awk '{print $5, $9}'

# Production image - use Node.js slim for lower memory footprint
# trixie-slim: glibc must match the stage where native modules were built (see builder).
FROM node:26.9.0-trixie-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Memory optimization for low-memory environments (Render free tier)
# V8 heap limit to prevent OOM on 512MB instances
ENV NODE_OPTIONS="--max-old-space-size=384"

# Where the agent's durable ledger lives, and half of what decides whether the
# agent is available at all (docs/AGENT.md). The workflow SDK's own default is
# ".workflow-data" resolved against the working directory — /app here, the
# container's writable layer: writable, so nothing fails loudly, and discarded on
# the next recreate or image upgrade. docker-compose.yml sets this; a plain
# `docker run` cannot be given a default from outside the image, so it is set
# here for every way this image is started. It sits under /app/data, the
# directory the entrypoint chowns to the app user and the one operators mount a
# volume on — without that volume the run history still dies with the container,
# which is the documented trade, not a silent one.
ENV WORKFLOW_LOCAL_DATA_DIR=/app/data/workflow

COPY --from=builder /usr/src/app/public ./public

# Set the correct permission for prerender cache and storage
RUN mkdir -p .next data

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder /usr/src/app/.next/standalone ./
COPY --from=builder /usr/src/app/.next/static ./.next/static

# Copy better-sqlite3 native binding for server storage support. Since v13 the
# package is N-API and self-contained: lib/binding.js resolves
# ../prebuilds/<platform>-<arch>.node relative to itself, so the former
# bindings + file-uri-to-path runtime dependencies are gone (they are no longer
# in the lockfile at all). Keep in sync with scripts/build-standalone-payload.sh.
COPY --from=builder /usr/src/app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# prebuild-install is only needed at build time, not runtime

# Copy the embedded LibreDB database package. The libredb provider lazy-imports
# it (await import('@libredb/libredb')) so it stays out of client bundles, but
# that also means Next.js output-file-tracing does not include it in the
# standalone server bundle — copy it explicitly so the provider works at runtime.
COPY --from=builder /usr/src/app/node_modules/@libredb/libredb ./node_modules/@libredb/libredb

# Copy the DuckDB driver. Same tracing blind spot as @libredb/libredb (the
# provider lazy-imports it), but a different shape: the driver is FOUR packages,
# not one. @duckdb/node-api -> @duckdb/node-bindings -> a per-platform
# @duckdb/node-bindings-<platform>-<arch> holding duckdb.node next to the
# ~70 MB libduckdb.so it links against (NEEDED libduckdb.so, RUNPATH $ORIGIN,
# so the two must stay in the same directory). Copying the whole @duckdb scope
# in one line is also what keeps the ARM64 cross-build working: the deps stage
# installs only the optional package matching the build arch, so naming a
# platform package here would break that leg. detect-libc is what
# @duckdb/node-bindings requires to choose between a glibc and a musl package;
# it is required inside a try/catch that silently falls back to glibc, so its
# absence would never announce itself - ship it rather than rely on tracing.
# Keep in sync with scripts/build-standalone-payload.sh.
COPY --from=builder /usr/src/app/node_modules/@duckdb ./node_modules/@duckdb
COPY --from=builder /usr/src/app/node_modules/detect-libc ./node_modules/detect-libc

# Copy the Oracle driver (#538). It is pure JavaScript in its default Thin mode,
# which is why it was never copied before, but Thick mode
# (ORACLE_CLIENT_LIB_DIR) makes node-oracledb load a native addon and that addon
# is missed by BOTH build stages, for two separate reasons.
# 1. Bundling: node-oracledb resolves the addon relative to its own __dirname,
#    and Turbopack rewrote that to the literal string /ROOT/node_modules/
#    oracledb/lib, so initOracleClient() died with NJS-045 before it ever looked
#    at the Instant Client. That is why the package is now in
#    serverExternalPackages (next.config.ts); this COPY is what makes "external"
#    resolvable at runtime.
# 2. Tracing: even externalized, Next's output file tracing copies index.js,
#    lib/ and package.json but not build/Release/*.node, because the addon is
#    reached through a computed require(path) rather than a literal specifier -
#    the same blind spot as @libredb/libredb and the @duckdb scope.
# The whole package directory, never one file: build/ holds a binary per
# platform and arch (~3 MB total), and naming one would break the ARM64 leg.
# This image stays Thin-only - no Instant Client, no libaio - so the addon sits
# unused until an operator layers a client on top; see docs/providers/oracle.md.
# Keep in sync with scripts/build-standalone-payload.sh.
COPY --from=builder /usr/src/app/node_modules/oracledb ./node_modules/oracledb

# Vendored sample database templates (the SQLite employees sample). Read at
# runtime via fs relative to process.cwd() (/app), so output file tracing
# never sees them — copy explicitly (keep scripts/build-standalone-payload.sh
# in sync).
COPY --from=builder /usr/src/app/seed-assets ./seed-assets

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app

# gosu lets the entrypoint drop from root to the app user after fixing the
# permissions of a mounted (often root-owned) data volume.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && \
    rm -rf /var/lib/apt/lists/*

# Entrypoint makes the SQLite data dir writable by `nextjs` then drops privileges.
# The container starts as root only long enough to chown the volume mount; the
# app process itself runs as the non-root `nextjs` user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The bind-address resolver the entrypoint runs (issue #432). It lives next to
# the entrypoint, OUTSIDE /app, so a volume mounted on /app cannot hide it, and
# outside the standalone payload so the native channels - which bind 127.0.0.1
# by design (#134) - can never inherit container bind policy.
COPY docker/bind-address.mjs /usr/local/lib/libredb-studio/bind-address.mjs

# Render uses PORT env variable, default to 3000
EXPOSE 3000/tcp
ENV PORT=3000
# Empty is the "nobody chose" sentinel: an image-level empty ENV suppresses
# Docker's HOSTNAME=<container-id> injection (which the resolver would otherwise
# be unable to tell apart from an operator's own value), while leaving a
# bypassed entrypoint on Next's own `process.env.HOSTNAME || '0.0.0.0'` default -
# i.e. exactly this image's pre-#432 behaviour. Anything non-empty an operator
# passes is honoured verbatim.
ENV HOSTNAME=""

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
