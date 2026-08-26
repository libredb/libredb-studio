# CLAUDE.md

Guidance for Claude Code in this repo — conventions, rules, and gotchas only. Read the code and `docs/` for anything derivable from them.

> **This repo is published as the npm package `@libredb/studio`** — both a CLI (`npx @libredb/studio`) and an embeddable library surface built by `build:lib`. It is **not** embedded in `libredb-platform`: the two are separate products as of 2026-08-14, so "platform consumes this" is not a reason to keep or avoid anything. The former `.claude/rules/platform-integration.md` was deleted with that decision; other files still reference it and have not been cleaned up yet.

## Project Overview

Web-based SQL IDE for cloud-native teams: PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino, Apache Cassandra (plus the embedded LibreDB) + AI query assistance. Runs **two ways** — a standalone Next.js app AND a published npm package (CLI plus an embeddable library surface); `build:lib` (tsup) produces the package dist. The two modes render different chrome, so a UI change verified in one is not verified in the other.

## Branching & PRs

> **Trunk-based: feature/work branches target `main` directly; releases are git tags.** Branch off `main` for new work and open every PR with base `main` (`gh pr create --base main`). `main` is the single protected integration trunk — PRs are required and the `Lint, Typecheck and Build`, `Unit & Integration Tests` and `Secret Scan` checks must pass before merge (SonarCloud still runs on push and same-repo PRs but is not a required check: fork PRs cannot produce it, which used to hard-block them). Cut a release by tagging `main` — tags carry **no `v` prefix** (`0.9.65`, not `v0.9.65`) — and always follow the `/cut-release` skill ([`.claude/skills/cut-release/SKILL.md`](.claude/skills/cut-release/SKILL.md)), which holds the full runbook: bump, pre-tag verification, draft-first publish, the ref-pinned dispatch chain and the recovery table. It is user-invoked only, so ask for it rather than improvising a release. There is no `dev` branch and no long-lived `release/*` branches. A PR that bumps the
> `package.json` version must also run `bun run chart:bump` **and `make -C operator bundle`** and
> commit both results — the required CI check enforces `Chart.yaml appVersion` == `package.json`
> version (#138), and a second gate fails when `operator/bundle` / `operator/config` still carry the
> previous version (the OLM CSV takes its version and controller image tag from `package.json`).
> Tag only after both are committed: the tag ref is what the operator image and bundle are built
> from, so a bundle refreshed later lives on `main` only. A PR that changes any packaged file under
> `charts/libredb-studio/` must ALSO bump `Chart.yaml version` whenever the current chart version is
> already released — the same required check enforces it (#167), and `chart:bump` will not do it for
> you while `appVersion` is already in sync, so bump `version:` and the README `--version` examples
> by hand.

## GitHub

* Repo: https://github.com/libredb/libredb-studio
* Image (canonical): `ghcr.io/libredb/libredb-studio:latest` — use GHCR in all copy-paste examples (Docker Hub `libredb/libredb-studio` is a discoverability mirror only)
* Helm: repo `https://libredb.org/libredb-studio/` · OCI `oci://ghcr.io/libredb/charts/libredb-studio` · [ArtifactHub](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio)

## Development Commands

```bash
bun install              # deps (Bun preferred)
bun dev                  # dev server (Turbopack)
bun run build            # production build
bun run format           # Biome formatter check (format:fix to write); CSS/JSON excluded
bun run lint             # oxlint (fast, syntactic) then ESLint 9 (eslint-config-next + narrow type-aware layer)
bun run lint:oxc         # oxlint only
bun run typecheck        # TypeScript strict
bun run test             # all layers: unit + api + integration + hooks + components
bun run test:e2e         # Playwright (requires build)
bun run test:coverage    # coverage report (merged lcov)
bun run coverage:check   # enforce 100% line coverage on the merged lcov (CI gate)
bun run build:lib        # tsup → @libredb/studio package dist (see rule below)
bun run attw             # validate published type-resolution against the packed tarball (needs build:lib first)
```

> **Toolchain rationale (Biome formatter, oxlint, type-aware ESLint layer, attw) lives in [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).** Biome is formatter-only (lineWidth 120); oxlint is the fast syntactic layer in front of ESLint; `eslint-config-next` still owns React/Next/hooks; a narrow `typescript-eslint` type-aware layer guards `src/app/api` + `src/lib/db` against floating promises; attw uses `--profile node16` (the package targets Node >=24 + modern bundlers, so node10 is ignored).

> **`build:lib` after changes to the published surface:** after changing anything reachable from `src/exports/` (workspace, providers, components, security, …), run `build:lib` — `bun run build` (Next.js) does NOT update the package dist.

> **Tests — always `bun run test`, never bare `bun test`.** Component tests need isolated execution groups (`tests/run-components.sh`) to avoid `mock.module()` cross-contamination.

> **Coverage isolation:** `bun`'s `mock.module()` is process-wide — a file mocking a shared module (`@/lib/db/factory`, `@/lib/oidc`, …) poisons others sharing the process → nondeterministic CI failures (`clearProviderCache is not a function`, `Export named 'removeProvider' not found`). So `test:coverage:core` runs each core test file in its own `bun` process via `tests/run-core.sh`; `test:coverage` merges per-file lcov. Do NOT collapse this into a single `bun test tests/unit tests/api tests/integration` invocation.

## Pre-Commit Verification (MANDATORY)

After every code change, run all six locally before claiming done — they match CI (`ci.yml`, `docker-build-push.yml`): `bun run format` · `bun run lint` · `bun run typecheck` · `bun run knip` · `bun run test` · `bun run build`. A local pass guarantees CI passes; do not skip any. (`bun run lint` runs oxlint then ESLint; `knip` fails on unused files/exports/dependencies; the CI `lint-and-build` job additionally runs `build:lib` + `attw`.)

> **100% line coverage is a hard CI gate — work TDD, always.** The merged lcov must stay at 100% (`scripts/check-coverage.mjs` fails the `Unit & Integration Tests` job otherwise), so every change that adds or alters executable lines MUST land with tests covering them **in the same PR**. The sustainable way to satisfy this is test-driven development as the default working style — write the failing test first, then the implementation — even when nobody asks for it; retrofitting tests after the code is how uncovered branches and coverage-gate fights accumulate. Verify locally with `bun run test:coverage && bun run coverage:check` — it prints the exact uncovered file:line ranges. Coverage-measurement rationale (per-function lcov granularity, phantom lines, the authority-universe merge rule, `run_group --nocov`) lives in [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Architecture

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript; Tailwind 4 + Shadcn/UI; Monaco editor; TanStack Table + react-virtual; `jose` JWT + `openid-client` OIDC.
- **DB drivers:** `pg`, `mysql2`, `cassandra-driver` (pure JS, external in both build configs), **`bun:sqlite`/`node:sqlite`** (the DB provider, runtime-selected; `LIBREDB_SQLITE_DRIVER` overrides) / `better-sqlite3` (the storage layer), `oracledb`, `mssql`, `mongodb`, `ioredis`.
- **Layout:** full tree + data flow in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Key dirs: `src/lib/db` (DB providers, Strategy Pattern), `src/lib/llm` (LLM providers), `src/lib/storage` (pluggable persistence), `src/workspace` + `src/exports` (the npm-package library surface), `src/proxy.ts` (RBAC middleware).
- **Path alias:** `@/*` → `./src/*`.

### Rules & patterns

> **⚠️ Providers are the lifeblood of this project — keep the triad in lockstep: code ↔ docs ↔ tests**, 1:1 per canonical type-id — the type-id set is the `DatabaseType` union in [`src/lib/types.ts`](src/lib/types.ts) (`postgres`, `mysql`, `sqlite`, `mongodb`, `redis`, `oracle`, `mssql`, `couchbase`, `clickhouse`, `druid`, `elasticsearch`, `opensearch`, `cassandra`, `trino`, plus the embedded `libredb`):
> - Code: `src/lib/db/providers/<family>/<type-id>.ts`, or `src/lib/db/providers/<family>/<type-id>/index.ts` when the provider is split across modules, as `couchbase`, `clickhouse`, `druid`, `trino` and `cassandra` are · Docs: `docs/providers/<type-id>.md` · Tests: `tests/integration/db/<type-id>-provider.test.ts`
> - **One directory may serve two type-ids** — `src/lib/db/providers/sql/search/` is both `elasticsearch` and `opensearch` (#424). Docs and tests stay 1:1 anyway: the invariant is per type-id, and each doc is the prime reference for its own product's measured behaviour.
> - Any change to one side MUST sync the others **in the same PR**. The doc mirrors the code and the code mirrors the doc — never let them drift.

- **DB abstraction:** Strategy Pattern. SQL providers extend `SQLBaseProvider`; MongoDB/Redis extend `BaseDatabaseProvider`. No `=== 'mongodb'` type-checks outside provider classes — drive behaviour through capabilities/labels.
- **Auth:** `NEXT_PUBLIC_AUTH_PROVIDER` = `local` (email/password) or `oidc` (PKCE → same JWT cookie as local). `src/proxy.ts` enforces RBAC (admin vs user). Details: [`docs/OIDC.md`](docs/OIDC.md).
- **Storage:** write-through cache — localStorage serves reads; `useStorageSync` pushes mutations to the server (debounced). `STORAGE_PROVIDER` (server-side only) = `local` | `sqlite` | `postgres`. Details: [`docs/STORAGE.md`](docs/STORAGE.md).
- **API routes:** all backend in `src/app/api/`; JWT-protected except `/login`, `/api/auth`, `/api/db/health`.

## Configuration

Env vars are documented with examples in [`.env.example`](.env.example). Non-obvious ones: `NEXT_PUBLIC_AUTH_PROVIDER` (`local` | `oidc`); `OIDC_*` required when `oidc`; `STORAGE_PROVIDER` / `STORAGE_SQLITE_PATH` / `STORAGE_POSTGRES_URL` are **server-side only** (not `NEXT_PUBLIC_`), discovered at runtime via `/api/storage/config`.

## Database Connections

Connections are typed by `type`; per-provider fields, query formats, and behaviours are in [`docs/providers/<type-id>.md`](docs/providers/) and [`docs/API_DOCS.md`](docs/API_DOCS.md).

Redis maps onto the SQL-oriented provider interface by convention: `getSchema()` uses a non-blocking `SCAN` (never `KEYS *`), grouping key prefixes as "tables"; health/metrics from `INFO`; slow queries / sessions from `SLOWLOG GET` / `CLIENT LIST`. See [`docs/providers/redis.md`](docs/providers/redis.md).

## Docker & Helm

- **Docker:** multi-stage Bun build, standalone Next.js output. Build args `JWT_SECRET_BUILD`, `ADMIN_PASSWORD_BUILD`, `USER_PASSWORD_BUILD`. Health check `GET /api/db/health`.
- **Helm:** lint with `helm lint charts/libredb-studio --strict`. Full values reference: `charts/libredb-studio/README.md`; chart architecture/rationale: [`docs/HELM_CHART.md`](docs/HELM_CHART.md).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
