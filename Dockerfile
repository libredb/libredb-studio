# ==============================================================================
# LibreDB Studio - Production Dockerfile
# Optimized for Render, Railway, Fly.io, and Kubernetes
# ==============================================================================

# use the official Bun image (full version, not slim)
# see all versions at https://hub.docker.com/r/oven/bun/tags
# Reference: https://bun.com/docs/guides/ecosystem/docker
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install dependencies only when needed
FROM base AS deps
RUN apt-get update && apt-get install -y python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Rebuild the source code only when needed
FROM base AS builder
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# Next.js collects completely anonymous education data about general usage.
# Learn more here: https://nextjs.org/telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Enable standalone output for Docker builds
ENV DOCKER_BUILD=true

# Build-time environment variables (replaced at runtime)
ARG JWT_SECRET_BUILD="build-time-placeholder-secret-32ch"
ARG ADMIN_PASSWORD_BUILD="build"
ARG USER_PASSWORD_BUILD="build"
ENV JWT_SECRET=$JWT_SECRET_BUILD
ENV ADMIN_PASSWORD=$ADMIN_PASSWORD_BUILD
ENV USER_PASSWORD=$USER_PASSWORD_BUILD

RUN bun run build

# Production image - use Node.js slim for lower memory footprint
FROM node:20-slim AS runner
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

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app
USER nextjs

# Render uses PORT env variable, default to 3000
EXPOSE 3000/tcp
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
CMD ["node", "server.js"]
