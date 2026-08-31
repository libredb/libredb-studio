# ==============================================================================
# LibreDB Studio - Production Dockerfile
# Optimized for Render, Railway, Fly.io, and Kubernetes
# ==============================================================================

# Bun for fast dependency installation, Node.js for build
# Bun's JIT compiler segfaults under QEMU emulation (ARM64 cross-build),
# so we use Node.js for the Next.js build step.
FROM oven/bun:1.4.0 AS deps
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
FROM node:26.8.1-trixie-slim AS builder
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV DOCKER_BUILD=true

ARG JWT_SECRET_BUILD="build-time-placeholder-secret-32ch"
ARG ADMIN_PASSWORD_BUILD="build"
ARG USER_PASSWORD_BUILD="build"
ENV JWT_SECRET=$JWT_SECRET_BUILD
ENV ADMIN_PASSWORD=$ADMIN_PASSWORD_BUILD
ENV USER_PASSWORD=$USER_PASSWORD_BUILD

# Stage Monaco from node_modules into public/ so the editor is served from our own
# origin (issue #247). Explicit here: this bypasses the package.json build script.
RUN node scripts/copy-monaco.mjs && npx next build

# Production image - use Node.js slim for lower memory footprint
# trixie-slim: glibc must match the stage where native modules were built (see builder).
FROM node:26.8.1-trixie-slim AS runner
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
