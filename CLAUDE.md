# CLAUDE.md

Guidance for Claude Code in this repo — conventions, rules, and gotchas only. Read the code and `docs/` for anything derivable from them.

> **This repo is published as the npm package `@libredb/studio`** — a CLI (`npx @libredb/studio`) plus an embeddable library surface built by `build:lib`. It is **not** embedded in `libredb-platform`: separate products since 2026-08-14, so "platform consumes this" is never a reason to keep or avoid anything (`.claude/rules/platform-integration.md` was deleted with that decision).

## Project Overview

Web-based SQL IDE for cloud-native teams: forty-two external engines, plus the embedded LibreDB store (`EXTERNAL_DATABASE_TYPES` in [`src/lib/db/compatibility.ts`](src/lib/db/compatibility.ts) is the external-engine list, never a prose enumeration), plus AI query assistance.
It runs **two ways**, as a standalone Next.js app and as a published npm package, and the two render different chrome, so a UI change verified in one is not verified in the other.

## Branching & PRs

> **Trunk-based: feature branch → `main` → tag.** Open every PR with `gh pr create --base main`; there is no `dev` branch and no long-lived `release/*` branches. `main` is protected: PRs required, and `Lint, Typecheck and Build`, `Unit & Integration Tests`, `Secret Scan`, `Engine Smoke - Build Payload` and `Out-of-tree Provider Acceptance` must pass (SonarCloud runs but is not required — fork PRs cannot produce it).
>
> **Tag namespace.** Product releases are bare semver tags on `main` — **no `v` prefix**; the `v`-prefixed tags below 0.9.28 are frozen history, and chart releases use a separate `libredb-studio-<chart version>` namespace, and the VS Code extension `vscode-extension-<version>` ([`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md), "VS Code extension (Marketplace)"). So `git tag | tail` is not "the latest release". Cutting one is the user-invoked `/cut-release` skill ([`.claude/skills/cut-release/SKILL.md`](.claude/skills/cut-release/SKILL.md)) — ask for it, never improvise.
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
bun run test             # every test file under tests/ and packages/*/tests/ (except their live/), one bun process per file
bun run test:unit        # one layer; also test:api, test:integration, test:hooks, test:security, test:evals, test:components
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
# VS Code extension (vscode-extension/, npm; after the root bun install; docs/TOOLCHAIN.md "VS Code extension")
(cd vscode-extension && npm ci --ignore-scripts && npm run build)   # host and child bundles, metafile checks, notices
(cd vscode-extension && npm run test:unit && npm run coverage:check) # its own 100% gate, unit leg only
(cd vscode-extension && LIBREDB_BACKEND_RUNTIME=node npm run test:integration)  # or =vscode (P5)
(cd vscode-extension && xvfb-run -a npm run test:e2e && npm run package)        # e2e needs a display on Linux
```

> **Toolchain rationale (Biome formatter-only, oxlint in front of ESLint, the narrow type-aware layer, attw) lives in [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).** Read it before changing any lint, format or packaging config.

> **Run `build:lib` after changing anything reachable from `src/exports/`** (workspace, providers, components, security, …) — `bun run build` (Next.js) does NOT update the package dist.

> **Tests, always `bun run test`, never bare `bun test` over a directory.** The runner ([`tests/run-tests.ts`](tests/run-tests.ts)) discovers every test file and runs each one in its own bun process, several at a time (`--jobs=N`, `--list`). `bun test tests/api` puts all of them in one process instead, where one file's `mock.module()` becomes every file's, because bun's module mocks are process-wide with no undo. To run one file, name it: `bun tests/run-tests.ts tests/unit/x.test.ts`.

> **Coverage:** `bun run test:coverage` is the same runner with `--coverage --merge-into=coverage/lcov.info`: one lcov per test file, merged by `scripts/merge-lcov.mjs`. Two files run without coverage on purpose; they are `COVERAGE_EXEMPT_FILES` in [`tests/runner/discover.ts`](tests/runner/discover.ts), with the reason in its docblock. Rationale: [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Pre-Commit Verification (MANDATORY)

Run the required-check gate set locally before claiming done. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the authority — this list mirrors it and can fall behind it:

```bash
(cd vscode-extension && npm ci --ignore-scripts) \
  && bun run format && bun run lint && bun run typecheck && bun run knip \
  && bun run chart:check && bun run channels:showcase:check \
  && bun run readme:check && bun run security:check \
  && bun run test && bun run build
```

A clean local pass is still not a guarantee: the same job also runs `build:lib`, `attw`, `lib:closure`, `lib:load` and `gofmt`/`go vet`/`go test` over `packaging/windows/launcher`, and the coverage gate below lives in a separate required job.

> **100% line coverage is a hard CI gate — work TDD, always.** `scripts/check-coverage.mjs` fails the required `Unit & Integration Tests` job below 100%, so every change that adds or alters executable lines lands with its tests **in the same PR** — write the failing test first, even unasked. `bun run test:coverage && bun run coverage:check` prints the exact uncovered file:line ranges. Measurement rationale: [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md).

## Architecture

- **DB drivers:** the two build configs do NOT externalize the same set, so read [`next.config.ts`](next.config.ts) and [`tsup.config.ts`](tsup.config.ts) rather than any prose list. `pg`, `mysql2`, `cassandra-driver`, `mongodb` and `oracledb` are external in both; `mssql` and `ioredis` are external in the library build only and Turbopack bundles them into the server chunk. That is not always harmless: `oracledb` was in exactly that position until #538, and bundling rewrote its `__dirname` to `/ROOT/...`, so Thick mode could never load its native addon. Two traps: SQLite is **`bun:sqlite`/`node:sqlite`** for the DB provider (runtime-selected, `LIBREDB_SQLITE_DRIVER` overrides) but `better-sqlite3` for the storage layer; `@duckdb/node-api` is a native N-API addon (~68 MB of bindings per libc variant), external too.
- **Layout:** during the provider plugins program `docs/ARCHITECTURE.md` and `docs/API_DOCS.md` are parked outside the repository at `../parked-docs/` and return at its end. Key dirs: `src/lib/db` (providers), `src/lib/llm`, `src/lib/storage`, `src/workspace` + `src/exports` (the npm-package library surface), `src/proxy.ts` (RBAC middleware).

### Rules & patterns

> **⚠️ Providers are the lifeblood of this project — keep the triad: code ↔ tests in lockstep, the per-engine doc frozen until its engine moves into its package**, 1:1 per canonical type-id — the type-id set is the `DatabaseType` union in [`src/lib/types.ts`](src/lib/types.ts), which is the only list:
> - Code: `src/lib/db/providers/<family>/<type-id>.ts`, or `.../<type-id>/index.ts` when the provider is split across modules · Docs: `docs/providers/<type-id>.md` · Tests: `tests/integration/db/<type-id>-provider.test.ts`
> - **Or as a workspace package:** Code: `packages/provider-<type-id>/src/` · Docs: `packages/provider-<type-id>/docs/<type-id>.md` · Tests: `packages/provider-<type-id>/tests/integration/<type-id>-provider.test.ts`.
>   A type-id lives in exactly one layout, so the change that moves a provider deletes its legacy code, doc and integration test.
>   A package serves only the type-id its directory names, until the provider manifest can declare several.
>   `tests/unit/db/provider-triad.test.ts` holds this for every shipped type-id, and a test finds a provider's files through `tests/helpers/provider-layout.ts`.
> - **One directory may serve two type-ids** — `sql/search/` is both `elasticsearch` and `opensearch` (#424), and `timeseries/influxdb/` is both `influxdb` and `influxdb3`, two classes on two bases.
>   Docs and tests stay 1:1 anyway: the invariant is per type-id.
>   A type-id moved out of such a directory leaves `PROVIDER_DIRECTORY_MAP` (`tests/helpers/provider-directory-map.ts`) in the same change.
> - **Agent leg.** A type-id whose granted statement language is non-null also keeps, in the same PR: Code: `src/lib/agent/languages/<statement-language>/engines/<type-id>.ts` plus its client row in `languages/<statement-language>/engines/client.ts` · Tests: the engine's cases in `engine-overlays.test.ts` and `engine-pack-contract.test.ts`.
>   The agent leg has a place only in the legacy layout so far, so a type-id whose granted statement language is non-null stays there until the change that moves it gives its package one, and the triad test refuses it in a package until then.
>   A type-id whose declaration states its statement language as data (`statementLanguageData`) keeps no agent leg: its overlay is its declaration's `agent.overlay`, and the triad test refuses a leg file left for that language.
> - Code and tests stay 1:1 per type-id and change together **in the same PR**. The per-engine doc `docs/providers/<type-id>.md` exists and is frozen until its engine moves into its package, where it is rewritten from the manifest: no change edits it, and `tests/unit/provider-doc-freeze.test.ts` refuses any test or script outside its reviewed list that reads a provider doc's text.

- **DB abstraction:** Strategy Pattern. SQL-dialect providers extend `SQLBaseProvider`; the non-SQL ones (`mongodb`, `redis`, `couchbase`, `firestore`, `prometheus`, `influxdb`, `kafka`, `mqtt`, `etcd`, `oxia`, `milvus`, `qdrant`, `weaviate`, `s3`, `kubernetes`, `rabbitmq`, `libredb`) extend `BaseDatabaseProvider` directly, `neo4j` extends `GraphBaseProvider` (`src/lib/db/graph/`), and `SQLBaseProvider` and `GraphBaseProvider` themselves extend it. Inside `src/lib/db`, never branch on the type id; drive behaviour through capabilities/labels. Outside the provider layer, a per-engine fact is a row of a contract registry, never a type-id branch: the engine catalog, the connection group (`CONNECTION_FIELDS`, `SEED_ONLY_FIELDS`, the connection form and the connection string), the execution UI with its fence aliases, the query dialects, each tab type's editor language and each editor language's accent, the SQL grammar rows of `src/lib/db/sql-grammar/`, the SQL writing rows of `src/lib/db/sql-writing/`, the migration DDL rows of `src/lib/db/migration-ddl/` and the SQL engine generator rows of `src/lib/db/query-generators/` are projected from each engine's committed declaration in `src/lib/db/engine-declarations/` into `src/lib/db/engine-catalog/*.generated.ts` by `bun run engines:generate`, under a drift guard, with a declared function bound only through Studio's own function tables; the redaction a query event keeps a statement under is the engine record's grant from its register row (`src/lib/db/sql-grammar/statement-redaction.ts`); `tests/unit/lib/no-engine-branches.test.ts` fails on any other type-id branch, and its debt list is empty, so a new branch is moved into a contract rather than listed.
- **Core imports into provider directories:** `tests/unit/lib/db/provider-imports.test.ts` lists every import from core into `src/lib/db/providers/` by file and fails on a new one, a new engine's included (the allowlist only shrinks); [`docs/PROVIDER_IMPORTS.md`](docs/PROVIDER_IMPORTS.md) records where each shared module goes and the PR that removes each inward import. A statement language's confirmation row lives in its core family module (`src/lib/languages/<language>/`, `src/lib/sql/` or `src/lib/db/graph/cypher/`), not beside a provider.
- **Auth:** `NEXT_PUBLIC_AUTH_PROVIDER` = `local` (email/password), `oidc` (PKCE → the same JWT cookie) or `openshift` (the cluster's OAuth server, its token kept in server memory under a session handle); read only through `src/lib/config/auth-provider.ts`, and any other value stops the boot; `src/proxy.ts` enforces RBAC (admin vs user). [`docs/OIDC.md`](docs/OIDC.md), [`docs/OPENSHIFT.md`](docs/OPENSHIFT.md).
- **Storage:** write-through cache — localStorage serves reads, `useStorageSync` pushes mutations to the server (debounced). `STORAGE_PROVIDER` (server-side only) = `local` | `sqlite` | `postgres`. [`docs/STORAGE.md`](docs/STORAGE.md).
- **API routes:** all backend in `src/app/api/`, except `/health`, which is a route at the app root so the plainest liveness path exists; JWT-protected except the public set in [`src/proxy.ts`](src/proxy.ts) — `/login`, `/launch`, `/api/auth/*`, `/health`, `/api/health`, `/api/db/health`, `/api/ready`, `/api/storage/config`, `/_next`, `/favicon.ico` and static assets — plus two machine paths gated by bearer credentials of their own instead of the JWT: the agent drive callback and /api/mcp. `src/proxy.ts` is the authority; do not restate the list elsewhere.

## Configuration

Every env var is documented with an example in [`.env.example`](.env.example). The one thing that file cannot show you: `STORAGE_PROVIDER` / `STORAGE_SQLITE_PATH` / `STORAGE_POSTGRES_URL` are **server-side only** (not `NEXT_PUBLIC_`) and are discovered at runtime via `/api/storage/config`.

## Database Connections

Connections are typed by `type`; per-provider fields, query formats and measured behaviours live in [`docs/providers/<type-id>.md`](docs/providers/) (the API reference is parked, see Layout above). The non-SQL providers map onto the SQL-oriented interface by convention (Redis `getSchema()` uses a non-blocking `SCAN`, never `KEYS *`) — read the provider doc before assuming a surface exists.

## Docker & Helm

- **Docker:** multi-stage Bun build, standalone Next.js output; build args `JWT_SECRET_BUILD`, `ADMIN_PASSWORD_BUILD`, `USER_PASSWORD_BUILD`. The Dockerfile declares no `HEALTHCHECK` — `GET /api/db/health` is wired in `docker-compose.example.yml` and the chart probes.
- **Helm:** lint with `helm lint charts/libredb-studio --strict`. Values: `charts/libredb-studio/README.md`; rationale: [`docs/HELM_CHART.md`](docs/HELM_CHART.md).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
