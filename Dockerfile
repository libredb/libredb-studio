# ==============================================================================
# LibreDB Studio - Production Dockerfile
# Optimized for Render, Railway, Fly.io, and Kubernetes
# ==============================================================================

# Bun for fast dependency installation, Node.js for build
# Bun's JIT compiler segfaults under QEMU emulation (ARM64 cross-build),
# so we use Node.js for the Next.js build step.
FROM oven/bun:1.3.14 AS deps
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build with Node.js to avoid Bun/QEMU segfaults on ARM64
# trixie-slim: must match the oven/bun deps stage glibc (Debian 13 / glibc 2.41),
# otherwise native modules (better-sqlite3) compiled in deps fail to load here.
FROM node:24.16.0-trixie-slim AS builder
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

RUN npx next build

# Production image - use Node.js slim for lower memory footprint
# trixie-slim: glibc must match the stage where native modules were built (see builder).
FROM node:24.16.0-trixie-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Memory optimization for low-memory environments (Render free tier)
# V8 heap limit to prevent OOM on 512MB instances
ENV NODE_OPTIONS="--max-old-space-size=384"

COPY --from=builder /usr/src/app/public ./public

# Set the correct permission for prerender cache and storage
RUN mkdir -p .next data

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder /usr/src/app/.next/standalone ./
COPY --from=builder /usr/src/app/.next/static ./.next/static

# Copy better-sqlite3 native binding for server storage support
COPY --from=builder /usr/src/app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /usr/src/app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /usr/src/app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
# prebuild-install is only needed at build time, not runtime

# Copy the embedded LibreDB database package. The libredb provider lazy-imports
# it (await import('@libredb/libredb')) so it stays out of client bundles, but
# that also means Next.js output-file-tracing does not include it in the
# standalone server bundle — copy it explicitly so the provider works at runtime.
COPY --from=builder /usr/src/app/node_modules/@libredb/libredb ./node_modules/@libredb/libredb

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

# Render uses PORT env variable, default to 3000
EXPOSE 3000/tcp
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
