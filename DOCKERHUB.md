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

> **Enable AI:** add `-e LLM_PROVIDER=gemini -e LLM_API_KEY=your_key -e LLM_MODEL=gemini-2.5-flash`.

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
| `dev` | `feat/**`, `fix/**` branches | Bleeding-edge / preview |
| `sha-<commit>` | every build | Exact immutable commit |

- **Architectures:** `linux/amd64`, `linux/arm64` (multi-arch manifest).
- **Also on GHCR:** `ghcr.io/libredb/libredb-studio` (canonical mirror, no pull rate limits — preferred for Kubernetes).

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
- **Multi-model AI copilot** — NL2SQL, query safety analysis, EXPLAIN-in-plain-English, slow-query autopilot. Gemini / OpenAI / Ollama / custom.
- **Pro data grid** — virtualized millions of rows, inline editing, per-column filters, pivot table, CSV/JSON export.
- **Data visualization** — 8 chart types with aggregation and saved-chart dashboards.
- **Data privacy & masking** — automatic sensitive-column detection, RBAC-enforced masking, export protection.
- **Auth & SSO** — local email/password or OIDC (Auth0, Keycloak, Okta, Azure AD, Zitadel) with PKCE and role mapping.
- **DBA toolkit (admin)** — live monitoring dashboard, threshold alerts, one-click VACUUM/ANALYZE/REINDEX, full audit trail.

<p align="center">
  <img src="https://raw.githubusercontent.com/libredb/libredb-studio/main/public/screenshots/nl2sql.png" alt="NL2SQL - Natural Language to SQL" width="100%" />
  <br/><em>Ask in plain English, get executable SQL — schema-aware.</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/libredb/libredb-studio/main/public/screenshots/erd-diagram.png" alt="Interactive ER Diagram" width="100%" />
  <br/><em>Interactive ER diagrams with real foreign-key edges and auto-layout.</em>
</p>

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_EMAIL` | ✅ | Admin email (default `admin@libredb.org`) |
| `ADMIN_PASSWORD` | ✅ | Admin password |
| `USER_EMAIL` | ✅ | Standard user email (default `user@libredb.org`) |
| `USER_PASSWORD` | ✅ | Standard user password |
| `JWT_SECRET` | ✅ | JWT signing secret (min 32 chars) |
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
- **CapRover** — one-click app: add repo `https://libredb.org/caprover-one-click-apps`, then install **LibreDB Studio**.
- **PaaS** — one-click buttons for Koyeb & Render in the [GitHub README](https://github.com/libredb/libredb-studio#-one-click-deploy).

---

## Links

- **Source & docs:** <https://github.com/libredb/libredb-studio>
- **Live demo:** <https://app.libredb.org> (`admin@libredb.org` / `LibreDB.2026`)
- **DeepWiki docs:** <https://deepwiki.com/libredb/libredb-studio>
- **License:** MIT

<sub>This page is generated from <a href="https://github.com/libredb/libredb-studio/blob/main/DOCKERHUB.md">DOCKERHUB.md</a> and synced automatically on every <code>main</code> build.</sub>
