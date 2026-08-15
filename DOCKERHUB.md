<p align="center">
  <img src="https://raw.githubusercontent.com/libredb/libredb-studio/main/deploy/caprover/libredb-studio.png" width="160" alt="LibreDB Studio" />
</p>

<h1 align="center">LibreDB Studio</h1>

<p align="center">
  <strong>The modern, AI-powered, open-source web-based SQL IDE for cloud-native teams.</strong>
</p>

<p align="center">
  <a href="https://github.com/libredb/libredb-studio"><img src="https://img.shields.io/badge/GitHub-libredb%2Flibredb--studio-181717?logo=github" alt="GitHub"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/multi--arch-amd64%20%7C%20arm64-2496ED?logo=docker" alt="multi-arch">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/libredb/libredb-studio/main/public/screenshots/hero-editor.png" alt="LibreDB Studio - Professional SQL IDE" width="100%" />
</p>

> 📖 **Full documentation, source, and issues:** <https://github.com/libredb/libredb-studio>

Query **PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB and Redis** from your browser — with AI-powered query assistance, interactive ER diagrams, schema diff, a virtualized data grid, RBAC, OIDC SSO, and a live monitoring dashboard. A lightweight, secure bridge between heavy desktop tools (DataGrip/DBeaver) and minimal CLIs.

---

## Quick start

```bash
docker run -d \
  --name libredb-studio \
  -p 3000:3000 \
  -e ADMIN_EMAIL=admin@libredb.org \
  -e ADMIN_PASSWORD=change-me-admin \
  -e USER_EMAIL=user@libredb.org \
  -e USER_PASSWORD=change-me-user \
  -e JWT_SECRET=change-me-to-a-random-32-char-string \
  libredb/libredb-studio:latest
```

Open <http://localhost:3000> and log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set above. **Use your own strong passwords and a random `JWT_SECRET`** — the values here are placeholders.

> **None of these auth variables are mandatory.** With the local provider, `ADMIN_PASSWORD` and `JWT_SECRET` are required only when you opt into strict mode (`AUTH_BOOTSTRAP=off`); otherwise both are generated on first start and the admin password is printed once to the container log. `USER_EMAIL` / `USER_PASSWORD` are always optional — omit them to run admin-only, since no default user password is ever assumed. None of them are used when `NEXT_PUBLIC_AUTH_PROVIDER=oidc`.

> **Enable AI:** add `-e LLM_PROVIDER=gemini -e LLM_API_KEY=your_key -e LLM_MODEL=gemini-2.5-flash`. That also brings the read-only agent, whose availability is derived from having a model configured; add `-v libredb-data:/app/data` if its run history should survive a container recreate, or `-e LIBREDB_AGENT_ENABLED=false` to keep the AI features and decline the agent.

### Docker Compose

```yaml
services:
  libredb-studio:
    image: libredb/libredb-studio:latest
    ports:
      - "3000:3000"
    environment:
      ADMIN_EMAIL: admin@libredb.org
      ADMIN_PASSWORD: change-me
      USER_EMAIL: user@libredb.org
      USER_PASSWORD: change-me
      JWT_SECRET: change-me-to-a-random-32-char-string
      STORAGE_PROVIDER: sqlite                 # persist on the volume below
      STORAGE_SQLITE_PATH: /app/data/libredb-storage.db
    volumes:
      - libredb-data:/app/data
    restart: unless-stopped
volumes:
  libredb-data:
```

A ready-to-use, fully-commented compose file is in the repo: [`docker-compose.example.yml`](https://github.com/libredb/libredb-studio/blob/main/docker-compose.example.yml).

---

## Image tags

| Tag | Pushed from | Use |
|-----|-------------|-----|
| `latest` | `main` | Latest stable build |
| `X.Y.Z` | `main` / release | Pin an exact version, e.g. `docker pull libredb/libredb-studio:0.9.16` (recommended for production) |
| `dev` | `feat/**`, `fix/**` branches | Bleeding-edge / preview (`linux/amd64` only) |
| `sha-<commit>` | every build | Exact immutable commit |

- **Architectures:** `linux/amd64` and `linux/arm64` as a multi-arch manifest for `latest`, `X.Y.Z`, `main` and their `sha-` tags. Preview builds from `feat/**` / `fix/**` branches (`dev` and their `sha-` tags) are `linux/amd64` only: CI has no native arm64 runner for this job, so arm64 is emulated, and paying for that on every branch commit is not worth it for an image no arm64 consumer pins.
- **Primary registry:** `ghcr.io/libredb/libredb-studio` (GitHub Container Registry — no pull rate limits, preferred for Kubernetes/CI). This Docker Hub repository is a convenience mirror for discoverability; both registries serve the identical multi-arch image.

---

## Supported databases

| Database | Driver | Highlights |
| :--- | :--- | :--- |
| **PostgreSQL** | `pg` | EXPLAIN plans, transactions, query cancellation, SSL/TLS, SSH tunnel |
| **MySQL** | `mysql2` | EXPLAIN plans, transactions, `KILL QUERY`, SSL/TLS, SSH tunnel |
| **Oracle** | `oracledb` (thin) | `FETCH FIRST` pagination, `V$` monitoring, `ANALYZE`, transactions |
| **SQL Server** | `mssql` | `OFFSET FETCH`, `sys.dm_*` DMVs, `DBCC CHECKDB`, Azure SQL auto-detect |
| **SQLite** | `better-sqlite3` | File-based or in-memory databases |
| **MongoDB** | `mongodb` | JSON query editor, find/aggregate/insert/update/delete |
| **Redis** | `ioredis` | Command editor, key browser, INFO monitoring |

---

## Key features

- **Professional SQL IDE** — Monaco editor (VS Code engine), schema-aware autocomplete, multi-tab workspace, Visual EXPLAIN.
- **Interactive ER diagrams** — real FK edges, cardinality, auto-layout (ELK.js), PNG/SVG export.
- **Schema diff & migration** — compare snapshots/connections and auto-generate migration SQL.
- **Read-only database agent** — state an objective, and the run drafts SQL, reads the results and composes a report whose claims cite them. Three workflows (investigate / optimize / assess), a visible statement-and-time budget, and writes refused before the database is reached. **Agent mode reads PostgreSQL and SQLite only** — they are the only engines with a database-native read-only execution profile, and on any other engine an Agent-mode run ends `engine-unsupported`; Plan mode is toolless, runs no statement of yours and works on every connection — it is *grounded* in your schema on PostgreSQL and SQLite, and says so when it is not. Standalone image only. [Guide](https://github.com/libredb/libredb-studio/blob/main/docs/AGENT_GUIDE.md) · [What leaves the machine](https://github.com/libredb/libredb-studio/blob/main/docs/AGENT_DATA_FLOW.md).
- **Model-backed helpers** — query safety analysis, EXPLAIN-in-plain-English, AI-generated schema docs, data-profile summaries. Gemini / OpenAI / Ollama / custom; with no model configured — no `LLM_*` variables at all — no AI call is made. A key is required for Gemini and OpenAI only: Ollama and a custom endpoint count as a configured model without one, which enables the AI features — and the agent too, once its ledger path is writable.
- **Pro data grid** — virtualized millions of rows, inline editing, per-column filters, pivot table, CSV/JSON export.
- **Data visualization** — 8 chart types with aggregation and saved-chart dashboards.
- **Data privacy & masking** — automatic sensitive-column detection, RBAC-enforced masking, export protection.
- **Auth & SSO** — local email/password or OIDC (Auth0, Keycloak, Okta, Azure AD, Zitadel) with PKCE and role mapping.
- **DBA toolkit (admin)** — live monitoring dashboard, threshold alerts, one-click VACUUM/ANALYZE/REINDEX, full audit trail.

<p align="center">
  <img src="https://raw.githubusercontent.com/libredb/libredb-studio/main/public/screenshots/erd-diagram.png" alt="Interactive ER Diagram" width="100%" />
  <br/><em>Interactive ER diagrams with real foreign-key edges and auto-layout.</em>
</p>

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_EMAIL` | ❌ | Admin email (default `admin@libredb.org`) |
| `ADMIN_PASSWORD` | ❌ | Admin password. Required only in strict mode (`AUTH_BOOTSTRAP=off`) with the local provider; otherwise generated on first start |
| `USER_EMAIL` | ❌ | Email of the optional non-admin account (default `user@libredb.org`; only read when `USER_PASSWORD` is set) |
| `USER_PASSWORD` | ❌ | Password of the optional non-admin account. Never generated - the account exists only when you set it |
| `JWT_SECRET` | ❌ | JWT signing secret (min 32 chars). Required only in strict mode; otherwise generated on first start |
| `AUTH_BOOTSTRAP` | ❌ | `on` (default) generates missing auth secrets on first start and prints the admin password once to the container log; `off` requires them explicitly |
| `AUTH_COOKIE_SECURE` | ❌ | `false` drops the `Secure` flag from auth cookies (browser reaches the app over plain HTTP, e.g. LAN/home server) |
| `NEXT_PUBLIC_AUTH_PROVIDER` | ❌ | `local` (default) or `oidc` |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | ❌ | OIDC SSO (required when `oidc`) |
| `OIDC_ROLE_CLAIM` / `OIDC_ADMIN_ROLES` / `OIDC_SCOPE` | ❌ | OIDC role mapping & scope |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_API_URL` | ❌ | AI: `gemini`, `openai`, `ollama`, `custom` |
| `STORAGE_PROVIDER` | ❌ | `local` (default), `sqlite`, or `postgres` |
| `STORAGE_SQLITE_PATH` | ❌ | SQLite file path (e.g. `/app/data/libredb-storage.db`) |
| `STORAGE_POSTGRES_URL` | ❌ | PostgreSQL URL (when `STORAGE_PROVIDER=postgres`) |

Health check endpoint: `GET /api/db/health` · Container HTTP port: `3000`.

---

## Deploy

- **Docker / Compose** — see Quick start above.
- **Kubernetes (Helm)** — `oci://ghcr.io/libredb/charts/libredb-studio` · [Artifact Hub](https://artifacthub.io/packages/search?repo=libredb-studio)
- **CapRover** — built into the official One-Click Apps catalog: **Apps → One-Click Apps/Databases** → search **LibreDB Studio**. No third-party repo to add.
- **PaaS** — one-click buttons for Koyeb & Render in the [GitHub README](https://github.com/libredb/libredb-studio#one-click-deploy).

---

## Links

- **Source & docs:** <https://github.com/libredb/libredb-studio>
- **Live demo:** <https://app.libredb.org>
- **DeepWiki docs:** <https://deepwiki.com/libredb/libredb-studio>
- **License:** MIT

---

## Star the project

LibreDB Studio is open source under the MIT license and free to use, with no paid tier gating any feature on this page. If it is useful to you, a star on GitHub is the clearest signal that the work is worth continuing.

<a href="https://github.com/libredb/libredb-studio"><img src="https://img.shields.io/github/stars/libredb/libredb-studio?style=social" alt="GitHub stars"></a>

Repository: <https://github.com/libredb/libredb-studio>

<sub>This page mirrors <a href="https://github.com/libredb/libredb-studio/blob/main/DOCKERHUB.md">DOCKERHUB.md</a> in the GitHub repository.</sub>
