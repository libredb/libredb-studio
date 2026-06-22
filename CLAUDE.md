# CLAUDE.md

Guidance for Claude Code in this repo — conventions, rules, and gotchas only. Read the code and `docs/` for anything derivable from them.

> **CRITICAL: published as the npm package `@libredb/studio` and consumed by `libredb-platform`.** UI/styling work MUST follow the platform-integration rules in [`.claude/rules/platform-integration.md`](.claude/rules/platform-integration.md) — auto-loaded when you touch components / `.tsx` / `globals.css`. Violations cause silent style/layout breakage that appears only when embedded in platform.

## Project Overview

Web-based SQL IDE for cloud-native teams: PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis + AI query assistance. Runs **two ways** — a standalone Next.js app AND an embedded npm package inside libredb-platform; `build:lib` (tsup) produces the package dist. Verify any UI change in both modes.

## Branching & PRs

> **Trunk-based: feature/work branches target `main` directly; releases are git tags.** Branch off `main` for new work and open every PR with base `main` (`gh pr create --base main`). `main` is the single protected integration trunk — PRs are required and the `Lint, Typecheck and Build` check must pass before merge. Cut a release by tagging `main` (`vX.Y.Z`), which triggers the npm publish workflow. There is no `dev` branch and no long-lived `release/*` branches.

## GitHub

* Repo: https://github.com/libredb/libredb-studio
* Image (canonical): `ghcr.io/libredb/libredb-studio:latest` — use GHCR in all copy-paste examples (Docker Hub `libredb/libredb-studio` is a discoverability mirror only)
* Helm: repo `https://libredb.org/libredb-studio/` · OCI `oci://ghcr.io/libredb/charts/libredb-studio` · [ArtifactHub](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio)

## Development Commands

```bash
bun install              # deps (Bun preferred)
bun dev                  # dev server (Turbopack)
bun run build            # production build
bun run lint             # ESLint 9
bun run typecheck        # TypeScript strict
bun run test             # all layers: unit + api + integration + hooks + components
bun run test:e2e         # Playwright (requires build)
bun run test:coverage    # coverage report
bun run build:lib        # tsup → @libredb/studio package dist (see rule below)
```

> **`build:lib` after platform-facing changes:** after changing any component used by platform (workspace, providers, …), run `build:lib` — `bun run build` (Next.js) does NOT update the package dist.

> **Tests — always `bun run test`, never bare `bun test`.** Component tests need isolated execution groups (`tests/run-components.sh`) to avoid `mock.module()` cross-contamination.

> **Coverage isolation:** `bun`'s `mock.module()` is process-wide — a file mocking a shared module (`@/lib/db/factory`, `@/lib/oidc`, …) poisons others sharing the process → nondeterministic CI failures (`clearProviderCache is not a function`, `Export named 'removeProvider' not found`). So `test:coverage:core` runs each core test file in its own `bun` process via `tests/run-core.sh`; `test:coverage` merges per-file lcov. Do NOT collapse this into a single `bun test tests/unit tests/api tests/integration` invocation.

## Pre-Commit Verification (MANDATORY)

After every code change, run all four locally before claiming done — they match CI (`ci.yml`, `docker-build-push.yml`): `bun run lint` · `bun run typecheck` · `bun run test` · `bun run build`. A local pass on all four guarantees CI passes; do not skip any.

## Architecture

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript; Tailwind 4 + Shadcn/UI; Monaco editor; TanStack Table + react-virtual; `jose` JWT + `openid-client` OIDC.
- **DB drivers:** `pg`, `mysql2`, **`bun:sqlite`** (the DB provider) / `better-sqlite3` (the storage layer), `oracledb`, `mssql`, `mongodb`, `ioredis`.
- **Layout:** full tree + data flow in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Key dirs: `src/lib/db` (DB providers, Strategy Pattern), `src/lib/llm` (LLM providers), `src/lib/storage` (pluggable persistence), `src/workspace` + `src/exports` (the npm-package embedding layer), `src/proxy.ts` (RBAC middleware).
- **Path alias:** `@/*` → `./src/*`.

### Rules & patterns

> **⚠️ Providers are the lifeblood of this project — keep the triad in lockstep: code ↔ docs ↔ tests**, 1:1 per canonical type-id (`postgres`, `mysql`, `sqlite`, `oracle`, `mssql`, `mongodb`, `redis`):
> - Code: `src/lib/db/providers/<family>/<type-id>.ts` · Docs: `docs/providers/<type-id>.md` · Tests: `tests/integration/db/<type-id>-provider.test.ts`
> - Any change to one side MUST sync the others **in the same PR**. The doc mirrors the code and the code mirrors the doc — never let them drift.

- **DB abstraction:** Strategy Pattern. SQL providers extend `SQLBaseProvider`; MongoDB/Redis extend `BaseDatabaseProvider`. No `=== 'mongodb'` type-checks outside provider classes — drive behaviour through capabilities/labels.
- **Auth:** `NEXT_PUBLIC_AUTH_PROVIDER` = `local` (email/password) or `oidc` (PKCE → same JWT cookie as local). `src/proxy.ts` enforces RBAC (admin vs user). Details: [`docs/OIDC.md`](docs/OIDC.md).
- **Storage:** write-through cache — localStorage serves reads; `useStorageSync` pushes mutations to the server (debounced). `STORAGE_PROVIDER` (server-side only) = `local` | `sqlite` | `postgres`. Details: [`docs/STORAGE.md`](docs/STORAGE.md).
- **API routes:** all backend in `src/app/api/`; JWT-protected except `/login`, `/api/auth`, `/api/db/health`.

## Configuration

Env vars are documented with examples in [`.env.example`](.env.example). Non-obvious ones: `NEXT_PUBLIC_AUTH_PROVIDER` (`local` | `oidc`); `OIDC_*` required when `oidc`; `STORAGE_PROVIDER` / `STORAGE_SQLITE_PATH` / `STORAGE_POSTGRES_URL` are **server-side only** (not `NEXT_PUBLIC_`), discovered at runtime via `/api/storage/config`.

## Database Connections

Connections are typed by `type`; per-provider fields, query formats, and behaviours are in [`docs/providers/<type-id>.md`](docs/providers/) and [`docs/API_DOCS.md`](docs/API_DOCS.md).

```typescript
const sql   = { type: 'postgres', host: 'localhost', port: 5432, database: 'mydb', user: 'admin', password: 'secret' }; // also mysql | sqlite | oracle | mssql
const mongo = { type: 'mongodb', connectionString: 'mongodb://localhost:27017/mydb' }; // query is JSON: { collection, operation, filter, options }
const redis = { type: 'redis', host: 'localhost', port: 6379, database: '0' };         // query: 'HGETALL user:1' or { command, args }
```

Redis maps onto the SQL-oriented provider interface by convention: `getSchema()` uses a non-blocking `SCAN` (never `KEYS *`), grouping key prefixes as "tables"; health/metrics from `INFO`; slow queries / sessions from `SLOWLOG GET` / `CLIENT LIST`. See [`docs/providers/redis.md`](docs/providers/redis.md).

## Docker & Helm

- **Docker:** multi-stage Bun build, standalone Next.js output. Build args `JWT_SECRET_BUILD`, `ADMIN_PASSWORD_BUILD`, `USER_PASSWORD_BUILD`. Health check `GET /api/db/health`.
- **Helm:** lint with `helm lint charts/libredb-studio --strict`. Full values reference: `charts/libredb-studio/README.md`; chart architecture/rationale: [`docs/HELM_CHART.md`](docs/HELM_CHART.md).
