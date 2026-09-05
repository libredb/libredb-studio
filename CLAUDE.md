# CLAUDE.md

Guidance for Claude Code in this repo — conventions, rules, and gotchas only. Read the code and `docs/` for anything derivable from them.

> **This repo is published as the npm package `@libredb/studio`** — a CLI (`npx @libredb/studio`) plus an embeddable library surface built by `build:lib`. It is **not** embedded in `libredb-platform`: separate products since 2026-08-14, so "platform consumes this" is never a reason to keep or avoid anything (`.claude/rules/platform-integration.md` was deleted with that decision).

## Project Overview

Web-based SQL IDE for cloud-native teams: 17 engines — the `DatabaseType` union in [`src/lib/types.ts`](src/lib/types.ts) is the list, never a prose enumeration — plus AI query assistance. It runs **two ways** — standalone Next.js app and published npm package — and the two render different chrome, so a UI change verified in one is not verified in the other.

## Branching & PRs

> **Trunk-based: feature branch → `main` → tag.** Open every PR with `gh pr create --base main`; there is no `dev` branch and no long-lived `release/*` branches. `main` is protected: PRs required, and `Lint, Typecheck and Build`, `Unit & Integration Tests` and `Secret Scan` must pass (SonarCloud runs but is not required — fork PRs cannot produce it).
>
> **Tag namespace.** Product releases are bare semver tags on `main` — **no `v` prefix**; the `v`-prefixed tags below 0.9.28 are frozen history, and chart releases use a separate `libredb-studio-<chart version>` namespace. So `git tag | tail` is not "the latest release". Cutting one is the user-invoked `/cut-release` skill ([`.claude/skills/cut-release/SKILL.md`](.claude/skills/cut-release/SKILL.md)) — ask for it, never improvise.
>
> **Two version gates, both enforced by the required check.** A PR bumping the `package.json` version must also run `bun run chart:bump` **and `make -C operator bundle`** and commit both (#138; the OLM CSV takes its version and controller image tag from `package.json`) — tag only once both are on `main`, since the tag ref is what the operator image and bundle build from. A PR changing any packaged file under `charts/libredb-studio/` must ALSO bump `Chart.yaml version` **by hand** when the current chart version is already released (#167) — `chart:bump` skips it while `appVersion` is in sync — plus the README `--version` examples.

## GitHub

* Repo: https://github.com/libredb/libredb-studio
* Image (canonical): `ghcr.io/libredb/libredb-studio:latest` — use GHCR in every copy-paste example (Docker Hub `libredb/libredb-studio` is a mirror only)
* Helm: repo `https://libredb.org/libredb-studio/` · OCI `oci://ghcr.io/libredb/charts/libredb-studio` · [ArtifactHub](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio)

## Development Commands

```bash
bun install              # deps (Bun preferred)
bun dev                  # dev server (Turbopack)
bun run build            # production build
bun run format           # Biome formatter check (format:fix to write); CSS/JSON excluded
bun run lint             # oxlint (fast, syntactic) then ESLint 9
bun run lint:oxc         # oxlint only
bun run typecheck        # TypeScript strict
bun run test             # all layers: unit + api + integration + hooks + security + evals + components
bun run test:e2e         # Playwright (builds and starts its own servers; see playwright.config.ts)
bun run test:coverage    # coverage report (merged lcov)
bun run coverage:check   # enforce 100% line coverage on the merged lcov
bun run build:lib        # tsup → @libredb/studio package dist (see rule below)
bun run attw             # type-resolution check against the packed tarball (run build:lib first)
# drift guards — all four run inside the required "Lint, Typecheck and Build" check:
bun run chart:check              # chart version sync guard (#138; CI sets CHART_SYNC_STRICT=1 and fetches origin/main)
bun run channels:showcase:check  # login channel showcase drift guard (#425)
bun run readme:check             # localized README drift guard (#317)
bun run security:check           # security posture drift guard
```

> **Toolchain rationale (Biome formatter-only, oxlint in front of ESLint, the narrow type-aware layer, attw) lives in [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).** Read it before changing any lint, format or packaging config.

> **Run `build:lib` after changing anything reachable from `src/exports/`** (workspace, providers, components, security, …) — `bun run build` (Next.js) does NOT update the package dist.

> **Tests — always `bun run test`, never bare `bun test`.** Component tests need isolated execution groups (`tests/run-components.sh`) to avoid `mock.module()` cross-contamination.

> **Coverage isolation:** `bun`'s `mock.module()` is process-wide, so `test:coverage:core` runs each core test file in its own process (`tests/run-core.sh`) and `test:coverage` merges the per-file lcov. Do NOT collapse it into one `bun test` invocation. Rationale: [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Pre-Commit Verification (MANDATORY)

Run the required-check gate set locally before claiming done. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the authority — this list mirrors it and can fall behind it:

```bash
bun run format && bun run lint && bun run typecheck && bun run knip \
  && bun run chart:check && bun run channels:showcase:check \
  && bun run readme:check && bun run security:check \
  && bun run test && bun run build
```

A clean local pass is still not a guarantee: the same job also runs `build:lib` + `attw` and `gofmt`/`go vet`/`go test` over `packaging/windows/launcher`, and the coverage gate below lives in a separate required job.

> **100% line coverage is a hard CI gate — work TDD, always.** `scripts/check-coverage.mjs` fails the required `Unit & Integration Tests` job below 100%, so every change that adds or alters executable lines lands with its tests **in the same PR** — write the failing test first, even unasked. `bun run test:coverage && bun run coverage:check` prints the exact uncovered file:line ranges. Measurement rationale: [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Architecture

- **DB drivers:** the two build configs do NOT externalize the same set, so read [`next.config.ts`](next.config.ts) and [`tsup.config.ts`](tsup.config.ts) rather than any prose list. `pg`, `mysql2`, `cassandra-driver`, `mongodb` and `oracledb` are external in both; `mssql` and `ioredis` are external in the library build only and Turbopack bundles them into the server chunk. That is not always harmless: `oracledb` was in exactly that position until #538, and bundling rewrote its `__dirname` to `/ROOT/...`, so Thick mode could never load its native addon. Two traps: SQLite is **`bun:sqlite`/`node:sqlite`** for the DB provider (runtime-selected, `LIBREDB_SQLITE_DRIVER` overrides) but `better-sqlite3` for the storage layer; `@duckdb/node-api` is a native N-API addon (~68 MB of bindings per libc variant), external too.
- **Layout:** tree + data flow in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Key dirs: `src/lib/db` (providers), `src/lib/llm`, `src/lib/storage`, `src/workspace` + `src/exports` (the npm-package library surface), `src/proxy.ts` (RBAC middleware).

### Rules & patterns

> **⚠️ Providers are the lifeblood of this project — keep the triad in lockstep: code ↔ docs ↔ tests**, 1:1 per canonical type-id — the type-id set is the `DatabaseType` union in [`src/lib/types.ts`](src/lib/types.ts), which is the only list:
> - Code: `src/lib/db/providers/<family>/<type-id>.ts`, or `.../<type-id>/index.ts` when the provider is split across modules · Docs: `docs/providers/<type-id>.md` · Tests: `tests/integration/db/<type-id>-provider.test.ts`
> - **One directory may serve two type-ids** — `sql/search/` is both `elasticsearch` and `opensearch` (#424). Docs and tests stay 1:1 anyway: the invariant is per type-id.
> - Any change to one side MUST sync the others **in the same PR**. The doc mirrors the code and the code mirrors the doc — never let them drift.

- **DB abstraction:** Strategy Pattern. SQL-dialect providers extend `SQLBaseProvider`; the non-SQL ones (`mongodb`, `redis`, `couchbase`, `libredb`) extend `BaseDatabaseProvider` directly, and `SQLBaseProvider` itself extends it. Inside `src/lib/db`, never branch on the type id — drive behaviour through capabilities/labels. Three `=== "mongodb"` branches survive in the UI layer as known debt (`src/hooks/use-connection-form.ts`, `src/lib/editor/tab-language.ts`, `src/components/ConnectionModal.tsx`); do not add a fourth.
- **Auth:** `NEXT_PUBLIC_AUTH_PROVIDER` = `local` (email/password) or `oidc` (PKCE → the same JWT cookie); `src/proxy.ts` enforces RBAC (admin vs user). [`docs/OIDC.md`](docs/OIDC.md).
- **Storage:** write-through cache — localStorage serves reads, `useStorageSync` pushes mutations to the server (debounced). `STORAGE_PROVIDER` (server-side only) = `local` | `sqlite` | `postgres`. [`docs/STORAGE.md`](docs/STORAGE.md).
- **API routes:** all backend in `src/app/api/`; JWT-protected except the public set in [`src/proxy.ts`](src/proxy.ts) — `/login`, `/api/auth/*`, `/api/db/health`, `/api/storage/config`, `/_next`, `/favicon.ico` and static assets — plus an agent-drive path gated by a bearer token instead of the JWT. `src/proxy.ts` is the authority; do not restate the list elsewhere.

## Configuration

Every env var is documented with an example in [`.env.example`](.env.example). The one thing that file cannot show you: `STORAGE_PROVIDER` / `STORAGE_SQLITE_PATH` / `STORAGE_POSTGRES_URL` are **server-side only** (not `NEXT_PUBLIC_`) and are discovered at runtime via `/api/storage/config`.

## Database Connections

Connections are typed by `type`; per-provider fields, query formats and measured behaviours live in [`docs/providers/<type-id>.md`](docs/providers/) and [`docs/API_DOCS.md`](docs/API_DOCS.md). The non-SQL providers map onto the SQL-oriented interface by convention (Redis `getSchema()` uses a non-blocking `SCAN`, never `KEYS *`) — read the provider doc before assuming a surface exists.

## Docker & Helm

- **Docker:** multi-stage Bun build, standalone Next.js output; build args `JWT_SECRET_BUILD`, `ADMIN_PASSWORD_BUILD`, `USER_PASSWORD_BUILD`. The Dockerfile declares no `HEALTHCHECK` — `GET /api/db/health` is wired in `docker-compose.example.yml` and the chart probes.
- **Helm:** lint with `helm lint charts/libredb-studio --strict`. Values: `charts/libredb-studio/README.md`; rationale: [`docs/HELM_CHART.md`](docs/HELM_CHART.md).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
