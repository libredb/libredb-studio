# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **CRITICAL: This project is published as an npm package (`@libredb/studio`) and consumed by `libredb-platform`.**
> Every CSS class, Tailwind utility, icon prop, and component choice MUST follow the Platform Integration Rules below.
> Violations cause silent style/layout breakage that only appears when embedded in platform — not in standalone studio.

## Project Overview

LibreDB Studio is a web-based SQL IDE for cloud-native teams. It supports PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis with AI-powered query assistance.

**Dual usage:** Studio runs both as a standalone Next.js app AND as an embedded npm package inside libredb-platform. The `build:lib` command (tsup) produces the package dist. Any UI change must be verified in both modes.

## Github
* Repository: https://github.com/libredb/libredb-studio
* Container Registry (primary): https://github.com/libredb/libredb-studio/pkgs/container/libredb-studio
* Docker Image (primary): ghcr.io/libredb/libredb-studio:latest — no pull rate limits, use in all copy-paste examples
* Docker Hub (mirror): https://hub.docker.com/r/libredb/libredb-studio — discoverability only; GHCR stays canonical
* Helm Chart: https://artifacthub.io/packages/helm/libredb-studio/libredb-studio
* Helm Repo: https://libredb.org/libredb-studio/
* Helm OCI: oci://ghcr.io/libredb/charts/libredb-studio

## Branching & PRs

> **Feature/work branches target `dev`, NOT `main`.** `dev` is the active integration branch — open every PR with base `dev` (`gh pr create --base dev`). `main` is the release branch and is only updated via a deliberate `dev` → `main` promotion. Targeting `main` directly causes divergence and forces re-targeting. Branch off `dev` for new work.

## Development Commands

```bash
bun install              # deps (Bun preferred)
bun dev                  # dev server (Turbopack)
bun run build            # production build
bun start                # serve production build
bun run lint             # ESLint 9
bun run typecheck        # TypeScript strict
bun run test             # all layers: unit + api + integration + hooks + components
bun run test:unit        # (also :api :integration :hooks :components)
bun run test:e2e         # Playwright (requires build)
bun run test:coverage    # coverage report

# IMPORTANT: after changing any component used by platform (workspace, providers, …),
# run build:lib — `bun run build` (Next.js) does NOT update the package dist.
bun run build:lib        # tsup → @libredb/studio package dist

docker-compose up -d     # Docker dev

# Helm
helm lint charts/libredb-studio --strict
helm template test charts/libredb-studio --set secrets.jwtSecret=test-secret-32-chars-minimum-here --set secrets.adminPassword=test123 --set secrets.userPassword=test123
helm dependency build charts/libredb-studio
```

The project uses ESLint 9 for linting and `bun:test` for testing with `@testing-library/react` + `happy-dom` for component tests and Playwright for E2E tests.

> **Important**: Always use `bun run test` instead of bare `bun test`. Component tests require isolated execution groups (handled by `tests/run-components.sh`) to prevent `mock.module()` cross-contamination between test files.
>
> **Coverage isolation**: `bun`'s `mock.module()` is process-wide — a file mocking a shared module (e.g. `@/lib/db/factory`, `@/lib/oidc`) poisons others sharing the process, causing nondeterministic CI failures (`clearProviderCache is not a function`, `Export named 'removeProvider' not found`). So `test:coverage:core` runs each core test file in its **own `bun` process** via `tests/run-core.sh`, and `test:coverage` merges the per-file lcov reports. Do NOT collapse this into a single `bun test tests/unit tests/api tests/integration`.

## Platform Integration Rules (npm package @libredb/studio)

Studio is consumed by libredb-platform as an npm package via `build:lib` (tsup). These rules prevent silent style/layout breakage that only appears when embedded in platform.

### Tailwind CSS Rules

| Do | Don't | Why |
|----|-------|-----|
| `text-xs`, `text-sm` (standard) | `text-body`, `text-data` (custom @theme) | `tailwind-merge` strips custom tokens silently |
| `text-[0.625rem]` (arbitrary value) | `text-label` (custom @theme) | Arbitrary values are twMerge-safe |
| `font-medium`, `font-normal` | `font-bold` everywhere | Studio is compact IDE, lighter weights |
| `w-3 h-3`, `w-3.5 h-3.5` (icons) | `w-4 h-4` or larger | Studio icons smaller than platform |

**Never define custom text tokens in `@theme` block.** `tailwind-merge` (used in `cn()`) interprets `text-body` as a color utility, not font-size. When combined with `text-muted-foreground`, twMerge silently removes `text-body` → no font-size applied → browser default 16px. This bug is invisible in standalone studio (Tailwind generates the CSS) but breaks embedded mode.

### Lucide Icon Rules

Always pass `strokeWidth={1.5}` to every Lucide icon:
```tsx
<Lock strokeWidth={1.5} className="w-3 h-3" />
```
Lucide defaults to `strokeWidth=2` and emits `width="24" height="24"` HTML attributes. Custom DB icons use `strokeWidth=1.5` without HTML size attributes. Without this prop, Lucide icons appear thicker and potentially larger than custom icons.

### Component Rules

- **Small icon buttons:** Use plain `<button className="p-1 rounded ...">` instead of shadcn `<Button size="icon">`. Platform's Button CSS can override studio's size classes due to specificity.
- **Responsive classes:** `md:hidden`, `hidden md:block` etc. must work. If a component is in a tsup chunk, verify platform's `@source` scans that chunk.

### Platform-Side Requirements

Platform's `globals.css` must scan ALL studio dist files (tsup creates chunks):
```css
@source "../../node_modules/@libredb/studio/dist/workspace.mjs";
@source "../../node_modules/@libredb/studio/dist/chunk-*.mjs";
```
Without chunk scanning, responsive/utility classes in chunked components won't generate CSS.

### Verification Workflow

After any UI change in studio:
1. `bun run build:lib` — rebuild tsup dist
2. `cp -r dist/* ../libredb-platform/node_modules/@libredb/studio/dist/` — copy to platform
3. `rm -rf ../libredb-platform/.next` — clear platform cache (for CSS changes)
4. Restart platform dev server and verify at `localhost:3000/workspace`

## Architecture

### Tech Stack
- **Framework:** Next.js 16 (App Router) with React 19 and TypeScript
- **Styling:** Tailwind CSS 4 with Shadcn/UI components
- **SQL Editor:** Monaco Editor
- **Data Grid:** TanStack React Table with react-virtual for virtualization
- **AI:** Multi-model support (Gemini, OpenAI, Ollama, Custom)
- **Databases:** PostgreSQL (`pg`), MySQL (`mysql2`), SQLite (`bun:sqlite`), Oracle (`oracledb`), SQL Server (`mssql`), MongoDB (`mongodb`), Redis (`ioredis`)
- **Auth:** JWT-based with `jose` library + OIDC SSO with `openid-client` (Auth0, Keycloak, Okta, Azure AD)
- **Storage:** Pluggable storage layer — localStorage (default), SQLite (`better-sqlite3`), or PostgreSQL (`pg`)

### Directory Structure

High-level only — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full tree and data flow.

```
src/
├── app/          # App Router: api/{auth(+oidc), ai, db, storage, admin}, admin/, login/, monitoring/
├── components/   # Studio.tsx (standalone shell), QueryEditor, ResultsGrid, sidebar/, studio/, admin/, schema-explorer/, ui/
├── workspace/    # Embeddable shell (StudioWorkspace) + host adapter hooks — the npm-package entry
├── exports/      # Public package barrel exports (tsup build:lib)
├── hooks/        # Custom React hooks
└── lib/
    ├── db/       # DB providers, Strategy Pattern: providers/{sql,document,keyvalue}, factory, types, errors
    ├── llm/      # LLM providers, Strategy Pattern
    ├── storage/  # Pluggable storage: storage-facade, local-storage, factory, providers/{sqlite,postgres}
    ├── editor/   # Monaco completions (SQL + MongoDB)
    ├── sql/      # Statement splitter, alias extractor
    ├── seed/     # Seed connections (config loader + credential resolver)
    └── auth.ts · oidc.ts   # JWT auth + OIDC utilities
```

`tests/` mirrors `src/` by layer (`unit`, `api`, `integration`, `hooks`, `components`); component tests run isolated via `tests/run-components.sh`. `e2e/` is Playwright. `charts/libredb-studio/` is the Helm chart (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`).

### Key Patterns

1. **Database Abstraction:** `src/lib/db/` module provides Strategy Pattern implementation for multiple database types:
   - **SQL:** PostgreSQL, MySQL, SQLite, Oracle, SQL Server (extend `SQLBaseProvider`)
   - **Document:** MongoDB (extends `BaseDatabaseProvider`)
   - **Key-Value:** Redis (extends `BaseDatabaseProvider`)

   > **⚠️ Providers are the lifeblood of this project. Keep the three artifacts in lockstep:**
   > **code ↔ docs ↔ tests.** For every provider there is a 1:1 triad, keyed by the canonical
   > **type-id** (`postgres`, `mysql`, `sqlite`, `oracle`, `mssql`, `mongodb`, `redis`):
   > - **Code:** `src/lib/db/providers/<family>/<type-id>.ts`
   > - **Docs:** `docs/providers/<type-id>.md` (filename = type-id; official name only in the title/prose)
   > - **Tests:** `tests/integration/db/<type-id>-provider.test.ts`
   >
   > **Any change to one side MUST sync the others in the same PR.** Change the code → update the
   > doc and tests to match. Touch the doc → verify it still reflects the code (every `file:line`
   > citation, every behaviour). The doc must mirror the code, and the code must mirror what the doc
   > promises — they are never allowed to drift.

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

Connections are typed by `type`; per-provider connection fields, query formats, and behaviours live in [`docs/providers/<type-id>.md`](docs/providers/) and [`docs/API_DOCS.md`](docs/API_DOCS.md).

```typescript
// SQL (postgres | mysql | sqlite | oracle | mssql)
const sql   = { type: 'postgres', host: 'localhost', port: 5432, database: 'mydb', user: 'admin', password: 'secret' };
// MongoDB — query is JSON: { collection, operation, filter, options }
const mongo = { type: 'mongodb', connectionString: 'mongodb://localhost:27017/mydb' };
// Redis — query is a plain command ('HGETALL user:1') or JSON { command, args }
const redis = { type: 'redis', host: 'localhost', port: 6379, password: 'secret', database: '0' };
```

Redis maps onto the SQL-oriented provider interface by convention: `getSchema()` runs a non-blocking `SCAN` (never `KEYS *`) and groups keys by prefix as "tables"; health/metrics come from `INFO`; slow queries / sessions from `SLOWLOG GET` / `CLIENT LIST`. See [`docs/providers/redis.md`](docs/providers/redis.md).
