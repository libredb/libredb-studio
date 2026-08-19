# High-Level Architecture - LibreDB Studio

This document outlines the architectural patterns, tech stack, and system design for LibreDB Studio, a web-based SQL IDE for cloud-native teams.

## System Overview

LibreDB Studio is a hybrid, cloud-native database management tool that provides an IDE-like experience in the browser. It supports **13 database backends** via a Strategy Pattern abstraction: PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Redis, LibreDB. The count is the `SHIPPED` record in [`src/lib/db/compatibility.ts`](../src/lib/db/compatibility.ts), which is exhaustive over `DatabaseType`; `elasticsearch` and `opensearch` are two ids served by one provider module.

It runs in two modes: as a **standalone Next.js app** and as an **embedded npm package** (`@libredb/studio`) consumed by libredb-platform. See [§4.6](#46-workspace-abstraction-npm-package-embedding).

## 1. Core Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) with React 19 |
| Runtime | Bun / Node.js |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS 4 + Shadcn/UI |
| Animations | Framer Motion v12 |
| SQL Editor | Monaco Editor |
| Data Grid | TanStack React Table + react-virtual |
| AI | Multi-model (Gemini, OpenAI, Ollama, Custom) |
| Auth | JWT (`jose`) + OIDC SSO (`openid-client`) |
| Charts | Recharts |
| Containerization | Docker (multi-stage Bun build) |

## 2. High-Level Architecture Diagram

```mermaid
graph TD
    User((User)) -->|HTTPS| Frontend[Next.js Frontend<br/>App Router + React 19]
    Frontend -->|API Calls| API[Next.js API Routes<br/>src/app/api]

    subgraph "Application Core"
        API -->|Auth| AuthLib[src/lib/auth.ts<br/>JWT + OIDC]
        API -->|Query| DBFactory[Provider Factory<br/>src/lib/db/factory.ts]
        API -->|AI| LLMFactory[LLM Factory<br/>src/lib/llm/]
    end

    subgraph "Database Providers (Strategy Pattern)"
        DBFactory --> SQL[SQL Providers]
        DBFactory --> Document[Document Providers]
        DBFactory --> KeyValue[Key-Value Providers]

        SQL --> PG[(PostgreSQL)]
        SQL --> MySQL[(MySQL)]
        SQL --> SQLite[(SQLite)]
        SQL --> Oracle[(Oracle)]
        SQL --> MSSQL[(SQL Server)]
        SQL --> ClickHouse[(ClickHouse)]
        SQL --> Druid[(Apache Druid)]
        Document --> MongoDB[(MongoDB)]
        Document --> Couchbase[(Couchbase)]
        KeyValue --> Redis[(Redis)]
    end

    subgraph "AI Providers (Strategy Pattern)"
        LLMFactory --> Gemini[[Gemini]]
        LLMFactory --> OpenAI[[OpenAI]]
        LLMFactory --> Ollama[[Ollama]]
        LLMFactory --> CustomLLM[[Custom]]
    end

    subgraph "Security"
        AuthLib -->|Session| JWT[HTTP-Only JWT Cookies]
        AuthLib -->|SSO| OIDC[OIDC Provider<br/>Auth0 / Keycloak / Okta / Azure AD]
    end
```

## 3. Database Provider Architecture

```mermaid
classDiagram
    class BaseDatabaseProvider {
        <<abstract>>
        +connect()
        +disconnect()
        +executeQuery()
        +getSchema()
        +getHealth()
        +getCapabilities() ProviderCapabilities
        +getLabels() ProviderLabels
        +prepareQuery() PreparedQuery
    }

    class SQLBaseProvider {
        <<abstract>>
        +beginTransaction()
        +commitTransaction()
        +rollbackTransaction()
        +cancelQuery()
    }

    BaseDatabaseProvider <|-- SQLBaseProvider
    BaseDatabaseProvider <|-- MongoDBProvider
    BaseDatabaseProvider <|-- CouchbaseProvider
    BaseDatabaseProvider <|-- RedisProvider

    SQLBaseProvider <|-- PostgresProvider
    SQLBaseProvider <|-- MySQLProvider
    SQLBaseProvider <|-- SQLiteProvider
    SQLBaseProvider <|-- OracleProvider
    SQLBaseProvider <|-- MSSQLProvider
    SQLBaseProvider <|-- ClickHouseProvider
    SQLBaseProvider <|-- DruidProvider
```

Each provider implements:
- **`getCapabilities()`** - queryLanguage, supportsExplain, supportsCreateTable, maintenanceOperations, etc.
- **`getLabels()`** - entityName, selectAction, searchPlaceholder, etc. (drives all UI text)
- **`prepareQuery()`** - handles query limiting per-provider (SQL LIMIT injection vs MongoDB native)

Adding a new database type requires: **1 provider class** + **1 entry in `db-ui-config.ts`**.

`CouchbaseProvider` extends `BaseDatabaseProvider` even though SQL++ is a SQL dialect: SQL++ quotes identifiers with doubled backticks, which `escapeIdentifier()` produces for no existing type, so it owns its quoting and declares its SQL-ness through `queryLanguage: 'sql'` instead. Being reached over HTTP is **not** the reason — `ClickHouseProvider` and `DruidProvider` add no driver either, and both extend `SQLBaseProvider`, because double-quoted identifiers and `LIMIT n OFFSET m` are correct in both dialects. Each of the three is a directory rather than a single file, with its wire format behind a transport seam that provider logic never bypasses. See [`docs/providers/couchbase.md`](providers/couchbase.md), [`clickhouse.md`](providers/clickhouse.md) and [`druid.md`](providers/druid.md).

## 4. Key Architectural Patterns

### 4.1. Strategy Pattern (Database & LLM)

Both database and LLM layers use the Strategy Pattern with a factory:
- `src/lib/db/factory.ts` - Creates the correct database provider based on connection type
- `src/lib/llm/factory.ts` - Creates the correct LLM provider based on configuration

No `isMongoDB` / `=== 'mongodb'` checks outside provider classes. All behavior differences are driven through capabilities and labels.

### 4.2. Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant A as API (/api/auth)
    participant O as OIDC Provider

    alt Local Auth
        U->>F: Email + Password
        F->>A: POST /api/auth/login
        A->>F: Set HTTP-Only JWT Cookie
    else OIDC SSO
        U->>F: Click SSO Login
        F->>O: Redirect (PKCE)
        O->>F: Authorization Code
        F->>A: GET /api/auth/oidc/callback
        A->>O: Token Exchange
        A->>F: Set HTTP-Only JWT Cookie
    end
```

Controlled by `NEXT_PUBLIC_AUTH_PROVIDER` (`local` | `oidc`). Both flows result in the same JWT session cookie. Proxy (`src/proxy.ts`) enforces RBAC (admin vs user roles).

### 4.3. Multi-Statement Execution

`src/lib/sql/statement-splitter.ts` splits SQL input into individual statements, handling:
- String literals (single/double quotes)
- Block and line comments
- Dollar-quoting (PostgreSQL)

Multi-statement queries execute sequentially via `POST /api/db/multi-query`.

### 4.4. Storage Abstraction Layer

- **Write-through cache architecture**: localStorage (L1 cache) + optional server storage (L2 persistent)
- **Three storage modes** controlled by `STORAGE_PROVIDER` env var:
  - `local` (default): Browser localStorage only, zero configuration
  - `sqlite`: Server-side SQLite file via `better-sqlite3`
  - `postgres`: Server-side PostgreSQL via `pg`
- **`useStorageSync` hook** in Studio.tsx: discovers mode at runtime via `/api/storage/config`, pulls on mount, pushes mutations (debounced 500ms)
- **Migration**: First login auto-migrates localStorage to server; `libredb_server_migrated` flag prevents re-migration
- **Graceful degradation**: If server unreachable, localStorage continues working

### 4.5. Client State Management

- **Storage module** (`src/lib/storage/`) for persistent data: connections, query history, saved queries, schema snapshots, chart configs, audit log, masking config, threshold config
- **React hooks** for UI state: tabs, active connection, execution status
- **Custom hooks** extracted from Studio.tsx: `useAuth`, `useConnectionManager`, `useTabManager`, `useTransactionControl`, `useQueryExecution`, `useInlineEditing`

### 4.6. Workspace Abstraction (npm package embedding)

Studio ships both as a standalone app and as the `@libredb/studio` npm package consumed by libredb-platform (built with `tsup` via `build:lib`).

- **`src/workspace/`** — `StudioWorkspace.tsx` is the embeddable shell. Its adapter hooks (`hooks/use-connection-adapter`, `hooks/use-query-adapter`) let the host (standalone or platform) supply connections and query execution, so the same UI runs in both contexts.
- **`src/exports/`** — barrel modules (`components.ts`, `providers.ts`, `workspace.ts`, `types.ts`) that define the package's public surface; `package.json` `exports`/`main`/`module` point at the tsup `dist/` output.
- **`src/styles/theme.css`** — the semantic colour tokens every exported component resolves through, shipped as `dist/styles.css` (`exports["./styles.css"]`) because `globals.css` is not packaged. A host imports it once: `import "@libredb/studio/styles.css"`. `build:lib` is `tsup && node scripts/copy-theme.mjs` in that order — tsup cleans `dist/`, so the copy has to follow it. See [`docs/ui/theming.md`](ui/theming.md).
- Platform integration rules (Tailwind tokens, Lucide stroke widths, chunk scanning) live in `CLAUDE.md`.

### 4.7. Standalone Boot Flow (`src/instrumentation.ts`)

Next.js runs `register()` once per server worker, **only** when Studio boots its own server (never when `@libredb/studio` is imported by libredb-platform) and only on the Node.js runtime. On standalone boot it:

1. **Bootstraps missing auth env** (`src/lib/auth-bootstrap.ts`, #109). When `JWT_SECRET` / `ADMIN_PASSWORD` are absent they are generated once, persisted to `<data dir>/auth-bootstrap.json` (mode `0600`), and injected into `process.env` before any secret reader runs; the admin password is printed once. Explicitly set env vars always win. Disable with `AUTH_BOOTSTRAP=off|false|0` (case-insensitive); an unrecognized value warns and stays on. In OIDC mode only the JWT secret is generated.
2. **Runs the auth-config preflight** (`src/lib/config/auth-preflight.ts`, #227). A `JWT_SECRET` that is set but shorter than 32 characters prints an operator-facing banner (length only, never the value) and exits with code 1. It runs *after* bootstrap so a generated secret is validated too. This is the one step that intentionally stops boot: `GET /api/db/health` is the Kubernetes livenessProbe and the Docker/PaaS health check, so signalling the failure there would restart the pod forever and hide the login screen's actionable 503; refusing to start costs nothing because a too-short secret can sign no session at all.
3. **Seeds the embedded LibreDB sample** (`src/lib/seed/libredb-sample.ts`). Unless `LIBREDB_EMBEDDED_SAMPLE=false`, it creates `<data dir>/sample.libredb` (idempotently, atomic rename) and `GET /api/connections/managed` then advertises an editable, dismissable "Sample (LibreDB)" connection pointing at it.
4. **Seeds the embedded SQLite sample, asynchronously** (`src/lib/seed/sqlite-sample.ts`). Unless `SQLITE_EMBEDDED_SAMPLE=false`, it fires-and-forgets a copy of the vendored `seed-assets/sqlite/employee.db` template to `<data dir>/sample-employees.db` (idempotent, atomic rename) — boot never waits. While the copy is in flight the managed-connections API advertises the seed id in `pendingSeeds`; `useConnectionManager` polls (1s, max 30) so "Sample (Employees)" appears without a page refresh.

Failures in the bootstrap and seeding steps are logged and swallowed — boot never breaks. The preflight in step 2 is the deliberate exception.

### 4.8. SQLite Driver Selection (`src/lib/db/providers/sql/sqlite-driver.ts`)

The SQLite **DB provider** is runtime-adaptive: it loads `bun:sqlite` under Bun and `node:sqlite` under plain Node (npx / brew / deb installs run `node server.js`). `LIBREDB_SQLITE_DRIVER=bun|node` forces a driver (used by tests). This is distinct from the **storage layer**, whose SQLite backend uses `better-sqlite3`.

### 4.9. Agent Runtime (`src/lib/agent/`, available when AI is configured)

A read-only investigation agent: a model drafts SQL against a connected database, repairs statements that fail, and composes a report whose claims cite the results they came from. Three boundaries define it. Its availability is **derived, not flagged** (#331 T5): the agent exists when a model is configured through the existing `src/lib/llm` settings *and* the durable ledger has a writable path, so no rail renders where the first Start would fail, and the discovery probe answers `{"enabled": false, "reason": …}` naming the condition that is missing — that is how the rail learns to stay absent and how the operator learns why. `LIBREDB_AGENT_ENABLED=false` remains the explicit off-switch. `isAgentRuntimeEnabled()` stays synchronous, answering the off-switch and the model configuration for its five in-request callers; the ledger's writable path is I/O and is composed into the answer by `GET /api/agent/config` alone. It is **standalone-only**, so the `@libredb/studio` package gains no agent module, agent type or runtime dependency (asserted by a package-boundary test); and every database reach goes through the same `src/lib/db/operations/` pipeline as the rest of the app, under a read-only execution profile with the agent's own frozen policy — there is no second path to a driver. A run is an append-only ledger on a durable backend (`WORKFLOW_TARGET_WORLD`: zero-config single-instance `local`, or the opt-in Postgres world for multiple replicas), and it re-derives its state from that ledger, so a resumed run never repeats a tool execution. Model configuration is the existing `src/lib/llm` settings surface — there is no second place to enter a key, and therefore no second reader of one.

Full behaviour, the tool set, what bounds a run, the HTTP surface and the honest limitations: [`docs/AGENT.md`](AGENT.md).

## 5. Directory Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── auth/           # Login/logout/me + OIDC (PKCE, callback)
│   │   ├── ai/             # explain, query-safety, describe-schema
│   │   ├── db/             # Query, schema, health, maintenance, transactions
│   │   ├── storage/        # Storage sync API (config, CRUD, migrate)
│   │   ├── connections/    # managed/ — built-in (seeded) connections listing
│   │   ├── agent/          # Agent runs, stream, artifacts, drive (404 unless enabled — §4.9)
│   │   └── admin/          # Fleet health, audit
│   ├── admin/              # Admin dashboard (RBAC protected) — layout.tsx renders the
│   │   │                   #   shell; one route per section, each independently
│   │   │                   #   linkable/refreshable. `/admin` redirects to the default
│   │   │                   #   section and maps legacy `?tab=` links (src/lib/admin-sections.ts)
│   │   ├── overview/       # Fleet health, quick actions
│   │   ├── operations/     # Maintenance operations
│   │   ├── monitoring/     # Embedded monitoring dashboard
│   │   ├── security/       # Data masking, access control
│   │   └── audit/          # Audit log
│   ├── monitoring/         # Monitoring dashboard page
│   └── login/              # Login page
├── components/
│   ├── Studio.tsx           # Main application shell (standalone)
│   ├── QueryEditor.tsx      # Monaco SQL editor wrapper
│   ├── ResultsGrid.tsx      # Virtualized data grid
│   ├── SchemaDiagram.tsx    # React Flow ERD viewer
│   ├── agent/               # AgentRail + timeline/hydration folds (standalone only — §4.9)
│   ├── sidebar/             # ConnectionsList, ConnectionItem
│   ├── studio/              # StudioTabBar, QueryToolbar, BottomPanel
│   ├── results-grid/        # ResultCard, RowDetailSheet, StatsBar
│   ├── admin/               # AdminDashboard shell (5 section routes) + tabs/ panels
│   ├── monitoring/          # MonitoringDashboard + tabs
│   ├── schema-explorer/     # SchemaExplorer
│   └── ui/                  # Shadcn/UI primitives
├── workspace/               # Embeddable shell (StudioWorkspace) + host adapter hooks
├── exports/                 # Public npm-package barrel exports (tsup build:lib)
├── hooks/                   # Custom React hooks
└── lib/
    ├── db/                  # Database provider module
    │   ├── providers/
    │   │   ├── sql/         # postgres, mysql, sqlite (+ sqlite-driver runtime adapter), oracle, mssql, clickhouse/ (transport seam + SQL over HTTP), druid/ (transport seam + SQL over POST /druid/v2/sql), search/ (transport seam + SQL over HTTP; elasticsearch and opensearch, two ids one module)
    │   │   ├── document/    # mongodb, couchbase/ (transport seam + SQL++ over REST)
    │   │   ├── keyvalue/    # redis
    │   │   └── embedded/    # libredb (built-in embedded provider for the sample connection)
    │   ├── factory.ts       # Provider factory
    │   └── types.ts         # Database types
    ├── agent/               # Agent runtime: run ledger, workflow, tools, policy (docs/AGENT.md)
    ├── llm/                 # LLM provider module
    ├── editor/              # Monaco completions (SQL + MongoDB), the tab-type/language ladder,
    │                       # and the LibreDB + Redis command languages
    ├── schema-diff/         # Diff engine + migration SQL generator
    ├── export/              # The writers behind every "save this to disk": RFC 4180 CSV,
    │                        #   the SQL INSERT/DDL forms, and the one blob-download path
    ├── sql/                 # Statement splitter, alias extractor
    ├── seed/                # Seed connections (config, filter, credential resolver) + libredb-sample seeding
    ├── config/              # auth-env.ts — single JWT_SECRET reader (auth.ts, proxy.ts, oidc.ts)
    ├── api/                 # API error codes + schema-route helpers
    ├── ssh/                 # SSH tunnel support
    ├── auth.ts              # JWT utilities
    ├── auth-bootstrap.ts    # Zero-config first-run auth bootstrap (runs in instrumentation)
    ├── oidc.ts              # OIDC utilities
    └── storage/             # Storage abstraction layer
        ├── index.ts         # Barrel export
        ├── storage-facade.ts # Public sync API + CustomEvent dispatch
        ├── local-storage.ts  # Pure localStorage CRUD
        ├── factory.ts       # Env-based provider factory
        └── providers/       # SQLite + PostgreSQL backends
```

## 6. Deployment

- **Docker / Helm**: Multi-stage Bun build with standalone Next.js output; these channels bind `0.0.0.0`. Canonical image `ghcr.io/libredb/libredb-studio`.
- **Native channels** (`bin/studio.js` npx launcher, Homebrew tap, `.deb`/`.rpm`, Snap, standalone tarballs; sources under `bin/` and `packaging/`): local-first, bind `127.0.0.1` by default unless `--host`/`HOSTNAME` opts in. The npx launcher ships as a pure library and downloads the SHA256-verified standalone server tarball from GitHub Releases. Full matrix and per-channel details in [`docs/DISTRIBUTION.md`](DISTRIBUTION.md).
- **Health Check**: `GET /api/db/health`
- **Stateless API**: API routes are stateless, suitable for horizontal scaling
- **Environment**: Configured via `.env.local` (see CLAUDE.md for full variable list). Missing auth secrets are generated on first standalone boot — see [§4.7](#47-standalone-boot-flow-srcinstrumentationts).
