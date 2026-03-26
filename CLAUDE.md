# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LibreDB Studio is a web-based SQL IDE for cloud-native teams. It supports PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis with AI-powered query assistance.

## Github
* Repository: https://github.com/libredb/libredb-studio
* Container Registry: https://github.com/libredb/libredb-studio/pkgs/container/libredb-studio
* Docker Image: ghcr.io/libredb/libredb-studio:latest
* Helm Chart: https://artifacthub.io/packages/helm/libredb-studio/libredb-studio
* Helm Repo: https://libredb.org/libredb-studio/
* Helm OCI: oci://ghcr.io/libredb/charts/libredb-studio

## Development Commands

```bash
# Install dependencies (Bun preferred)
bun install

# Development server with Turbopack
bun dev

# Production build
bun run build

# Start production server
bun start

# Lint code
bun run lint

# Run all tests (unit + API + integration + hooks + components)
bun run test

# Run individual test layers
bun run test:unit
bun run test:api
bun run test:integration
bun run test:hooks
bun run test:components

# E2E tests (Playwright, requires build)
bun run test:e2e

# Coverage report
bun run test:coverage

# Library build (tsup) — exports @libredb/studio package for platform consumption
# IMPORTANT: After changing any component used by platform (workspace, providers, etc.),
# you MUST run this command. `bun run build` (Next.js) does NOT update the package dist.
bun run build:lib

# Docker development
docker-compose up -d

# Helm chart
helm lint charts/libredb-studio --strict
helm template test charts/libredb-studio --set secrets.jwtSecret=test-secret-32-chars-minimum-here --set secrets.adminPassword=test123 --set secrets.userPassword=test123
helm dependency build charts/libredb-studio
```

The project uses ESLint 9 for linting and `bun:test` for testing with `@testing-library/react` + `happy-dom` for component tests and Playwright for E2E tests.

> **Important**: Always use `bun run test` instead of bare `bun test`. Component tests require isolated execution groups (handled by `tests/run-components.sh`) to prevent `mock.module()` cross-contamination between test files.

## Architecture

### Tech Stack
- **Framework:** Next.js 16 (App Router) with React 19 and TypeScript
- **Styling:** Tailwind CSS 4 with Shadcn/UI components
- **SQL Editor:** Monaco Editor
- **Data Grid:** TanStack React Table with react-virtual for virtualization
- **AI:** Multi-model support (Gemini, OpenAI, Ollama, Custom)
- **Databases:** PostgreSQL (`pg`), MySQL (`mysql2`), SQLite (`better-sqlite3`), Oracle (`oracledb`), SQL Server (`mssql`), MongoDB (`mongodb`), Redis (`ioredis`)
- **Auth:** JWT-based with `jose` library + OIDC SSO with `openid-client` (Auth0, Keycloak, Okta, Azure AD)
- **Storage:** Pluggable storage layer — localStorage (default), SQLite (`better-sqlite3`), or PostgreSQL (`pg`)

### Directory Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── auth/           # Login/logout/me endpoints
│   │   │   └── oidc/       # OIDC login + callback routes (PKCE, code exchange)
│   │   ├── ai/             # AI endpoints (chat, nl2sql, explain, safety)
│   │   ├── db/             # Query, schema, health, maintenance, transactions
│   │   ├── storage/        # Storage sync API (config, CRUD, migrate)
│   │   └── admin/          # Fleet health, audit endpoints
│   ├── admin/              # Admin dashboard (RBAC protected)
│   └── login/              # Login page
├── components/             # React components
│   ├── Studio.tsx          # Main application shell
│   ├── QueryEditor.tsx     # Monaco SQL editor wrapper
│   ├── ResultsGrid.tsx     # Virtualized data grid
│   ├── sidebar/            # Sidebar, ConnectionsList, ConnectionItem
│   ├── studio/             # StudioTabBar, QueryToolbar, BottomPanel
│   ├── admin/              # AdminDashboard, tabs (Overview, Operations, etc.)
│   ├── schema-explorer/    # SchemaExplorer component
│   └── ui/                 # Shadcn/UI primitives
├── hooks/                  # Custom React hooks
└── lib/
    ├── storage/            # Storage abstraction layer
    │   ├── index.ts        # Barrel export
    │   ├── types.ts        # StorageData, ServerStorageProvider interfaces
    │   ├── storage-facade.ts # Public sync API + CustomEvent dispatch
    │   ├── local-storage.ts  # Pure localStorage CRUD
    │   ├── factory.ts      # Env-based provider factory (singleton)
    │   └── providers/
    │       ├── sqlite.ts   # better-sqlite3 backend
    │       └── postgres.ts # pg backend
    ├── db/                 # Database provider module (Strategy Pattern)
    │   ├── providers/
    │   │   ├── sql/        # SQL providers (postgres, mysql, sqlite, oracle, mssql)
    │   │   ├── document/   # Document providers (mongodb)
    │   │   ├── keyvalue/   # Key-value providers (redis)
    │   ├── factory.ts      # Provider factory
    │   ├── types.ts        # Database types
    │   └── errors.ts       # Custom error classes
    ├── llm/                # LLM provider module (Strategy Pattern)
    ├── schema-diff/        # Schema diff engine + migration SQL generator
    ├── sql/                # SQL statement splitter, alias extractor
    ├── types.ts            # TypeScript type definitions
    ├── auth.ts             # JWT auth utilities (login, logout, signJWT, verifyJWT)
    ├── oidc.ts             # OIDC utilities (discovery, PKCE, token exchange, role mapping, logout)
    └── storage.ts          # LocalStorage management

tests/
├── setup.ts               # Global test setup (env vars, localStorage mock)
├── setup-dom.ts            # DOM environment setup (happy-dom)
├── run-components.sh       # Component test isolation runner
├── fixtures/               # Mock data (connections, schemas, query results)
├── helpers/                # Test utilities (mock providers, mock Monaco, etc.)
├── unit/                   # Pure function tests
├── api/                    # API route handler tests
├── integration/            # Database provider tests (mocked drivers)
├── hooks/                  # React hook tests
└── components/             # Component tests (happy-dom)

e2e/                        # Playwright E2E tests (browser)

charts/
└── libredb-studio/         # Helm chart for Kubernetes deployment
    ├── Chart.yaml           # Chart metadata + ArtifactHub annotations
    ├── values.yaml          # Default configuration
    ├── values.schema.json   # JSON Schema validation
    └── templates/           # K8s manifests (deployment, service, ingress, etc.)
```

### Key Patterns

1. **Database Abstraction:** `src/lib/db/` module provides Strategy Pattern implementation for multiple database types:
   - **SQL:** PostgreSQL, MySQL, SQLite, Oracle, SQL Server (extend `SQLBaseProvider`)
   - **Document:** MongoDB (extends `BaseDatabaseProvider`)
   - **Key-Value:** Redis (extends `BaseDatabaseProvider`)

2. **LLM Abstraction:** `src/lib/llm/` module provides Strategy Pattern for AI providers (Gemini, OpenAI, Ollama, Custom)

3. **Authentication Flow:** Supports two modes controlled by `NEXT_PUBLIC_AUTH_PROVIDER`:
   - **Local** (default): Email/password login → JWT session cookie
   - **OIDC**: SSO redirect → PKCE code exchange → local JWT session cookie (same as local)

   JWT tokens stored in HTTP-only cookies. Proxy (`src/proxy.ts`) protects routes and enforces RBAC (admin vs user roles). OIDC module (`src/lib/oidc.ts`) handles discovery, PKCE, token exchange, role mapping, and provider logout.

4. **API Routes:** All backend logic in `src/app/api/`. Protected routes require valid JWT. Public routes: `/login`, `/api/auth`, `/api/db/health`

5. **Storage Abstraction:** `src/lib/storage/` module provides pluggable persistence:
   - **Local** (default): Browser localStorage, zero config
   - **SQLite**: `better-sqlite3` file DB for single-node persistent storage
   - **PostgreSQL**: `pg` for multi-node enterprise storage
   - Write-through cache: localStorage always serves reads; `useStorageSync` hook pushes mutations to server (debounced)
   - Controlled by `STORAGE_PROVIDER` env var (server-side only, discovered at runtime via `/api/storage/config`)

6. **Multi-Tab Workspace:** Each query tab has independent state (query, results, execution status)

### Environment Variables

Required in `.env.local`:
```
# Authentication (local mode)
ADMIN_EMAIL=admin@libredb.org   # Admin email
ADMIN_PASSWORD=<password>       # Admin password
USER_EMAIL=user@libredb.org     # User email
USER_PASSWORD=<password>        # User password
JWT_SECRET=<32+ chars>          # JWT signing secret

# Auth provider: "local" (default) or "oidc"
NEXT_PUBLIC_AUTH_PROVIDER=local

# OIDC config (required when provider=oidc)
OIDC_ISSUER=<issuer-url>        # e.g. https://dev-xxx.auth0.com
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<secret>
OIDC_SCOPE=openid profile email # Optional, defaults shown
OIDC_ROLE_CLAIM=                # Claim path for role (e.g. realm_access.roles)
OIDC_ADMIN_ROLES=admin          # Comma-separated admin role values

# Optional AI config
LLM_PROVIDER=gemini             # gemini, openai, ollama, custom
LLM_API_KEY=<key>
LLM_MODEL=gemini-2.5-flash
LLM_API_URL=<url>               # For ollama/custom providers

# Optional storage config (server-side only, not NEXT_PUBLIC_)
STORAGE_PROVIDER=local                  # local (default) | sqlite | postgres
STORAGE_SQLITE_PATH=./data/libredb-storage.db  # SQLite file path
STORAGE_POSTGRES_URL=postgresql://...           # PostgreSQL connection URL
```

### Path Aliases

TypeScript path alias `@/*` maps to `./src/*`. Use `@/components/...`, `@/lib/...`, etc.

## Pre-Commit Verification (MANDATORY)

**After every code change, you MUST run the CI pipeline checks locally before considering the task complete.** These match `.github/workflows/ci.yml` and `docker-build-push.yml`:

```bash
# 1. Lint (ESLint 9)
bun run lint

# 2. Type check (TypeScript strict)
bun run typecheck

# 3. Tests (unit + API + integration + hooks + components)
bun run test

# 4. Build (Next.js production build)
bun run build
```

**Do NOT skip any step.** If any step fails, fix the issue before proceeding. The GitHub Actions CI will run all four checks — a local pass on all four guarantees the CI will also pass.

## Docker Build

The Dockerfile uses multi-stage Bun build with standalone Next.js output. Build args: `JWT_SECRET_BUILD`, `ADMIN_PASSWORD_BUILD`, `USER_PASSWORD_BUILD`. Health check: `GET /api/db/health`.

## Database Connections

### SQL Databases (PostgreSQL, MySQL, SQLite)
```typescript
const connection = {
  type: 'postgres', // or 'mysql', 'sqlite'
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'admin',
  password: 'secret',
};
```

### MongoDB
```typescript
const connection = {
  type: 'mongodb',
  connectionString: 'mongodb://localhost:27017/mydb',
  // or host/port/database format
};

// Query format (JSON)
const query = JSON.stringify({
  collection: 'users',
  operation: 'find',
  filter: { status: 'active' },
  options: { limit: 50 }
});
```
