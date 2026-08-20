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

Query **PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch and Apache Trino** from your browser — with AI-powered query assistance, interactive ER diagrams, schema diff, a virtualized data grid, RBAC, OIDC SSO, and a live monitoring dashboard. A lightweight, secure bridge between heavy desktop tools (DataGrip/DBeaver) and minimal CLIs.

---

## Quick start

```bash
docker run \
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

### Reaching your databases from inside the container

**`localhost` in the connection dialog means *this container*, not your machine.** A database on the host, or in another container, is not there — so a connection that works from a terminal fails here, and it fails as a timeout rather than as anything that mentions the host. This is the first thing to check when a container-run Studio cannot connect to a database you know is up.

Pick whichever fits how the database runs:

| Where the database runs | What to put in **Host** | How to start Studio |
| :--- | :--- | :--- |
| Another container, same Docker network | the **service or container name** (`postgres`, `my-mysql`) with the port **inside** the container | `docker run -p 3000:3000 --network <that-network> …` |
| On the host, or a container publishing a host port | `host.docker.internal` | `docker run -p 3000:3000 --add-host=host.docker.internal:host-gateway …` |
| Anywhere the host can reach (Linux only) | `localhost` works as written | `docker run --network host …` (no `-p`; the app binds the host's port 3000) |
| A managed service (RDS, Atlas, Neon, …) | its real hostname | nothing special — it is reachable from anywhere |

Two things worth knowing before you pick:

- **The port inside a network is the engine's own, not the one you published.** A compose file that publishes `9201:9200` to dodge a collision on the host is still `9200` between containers, and a Postgres published on `5433` is still `5432` there.
- **`host.docker.internal` resolves by itself only on Docker Desktop.** On Linux the `--add-host=host.docker.internal:host-gateway` flag above is what creates it.

The network route is the one to prefer for a real deployment: put Studio and its databases on one network, address them by name, and nothing depends on a published port existing. [`docker-compose.yml`](https://github.com/libredb/libredb-studio/blob/main/docker-compose.yml) in the repository is that shape.

---

## Image tags

| Tag | Pushed from | Use |
|-----|-------------|-----|
| `latest` | `main` | Latest stable build |
| `X.Y.Z` | `main` / release | Pin an exact version, e.g. `docker pull libredb/libredb-studio:0.12.0` (recommended for production) |
| `dev` | `feat/**`, `fix/**` branches | Bleeding-edge / preview (`linux/amd64` only) |
| `sha-<commit>` | every build | Exact immutable commit |

- **Architectures:** `linux/amd64` and `linux/arm64` as a multi-arch manifest for `latest`, `X.Y.Z`, `main` and their `sha-` tags. Preview builds from `feat/**` / `fix/**` branches (`dev` and their `sha-` tags) are `linux/amd64` only: CI has no native arm64 runner for this job, so arm64 is emulated, and paying for that on every branch commit is not worth it for an image no arm64 consumer pins.
- **Primary registry:** `ghcr.io/libredb/libredb-studio` (GitHub Container Registry — no pull rate limits, preferred for Kubernetes/CI). This Docker Hub repository is a convenience mirror for discoverability; both registries serve the identical multi-arch image.

---

## Supported databases

Fourteen external engines share one interface, and three of them are read-only because their own SQL is. The table below has fifteen rows: the fifteenth is the embedded LibreDB store, which ships inside the image rather than being a server you connect out to.

| Database | Driver | Highlights |
| :--- | :--- | :--- |
| **PostgreSQL** | `pg` | EXPLAIN plans, transactions, query cancellation, SSL/TLS, SSH tunnel |
| **MySQL** | `mysql2` | EXPLAIN plans, transactions, `KILL QUERY`, SSL/TLS, SSH tunnel |
| **Oracle** | `oracledb` (thin) | `FETCH FIRST` pagination, `V$` monitoring, `ANALYZE`, transactions |
| **SQL Server** | `mssql` | `OFFSET FETCH`, `sys.dm_*` DMVs, `DBCC CHECKDB`, Azure SQL auto-detect |
| **SQLite** | `bun:sqlite` / `node:sqlite` | File-based or in-memory databases; the driver follows the runtime, with a `LIBREDB_SQLITE_DRIVER` override |
| **MongoDB** | `mongodb` | JSON query editor, find/aggregate/insert/update/delete |
| **Redis** | `ioredis` | Command editor, non-blocking `SCAN` key browser, `INFO` monitoring, per-type command generation |
| **Couchbase** | none — HTTP | SQL++ query editor, bucket/scope/collection browser, cluster health |
| **ClickHouse** | none — HTTP | Full SQL IDE over the HTTP interface, part/compression sizes, `system.*` monitoring |
| **Apache Druid** | none — HTTP | Read-only SQL IDE over the SQL endpoint, datasource and segment browser |
| **Elasticsearch** | none — HTTP | Read-only SQL IDE over `_sql`, mapping-driven index/field explorer, cluster health with per-index document counts and store sizes |
| **OpenSearch** | none — HTTP | The same read-only IDE over `_plugins/_sql`, from the same provider module; `LIMIT … OFFSET` paging works here |
| **Apache Trino** | none — HTTP | Full SQL IDE over the client protocol, every configured catalog in one tree, `EXPLAIN (FORMAT JSON)` plans, `system.runtime` monitoring and query cancellation |
| **Apache Cassandra** | `cassandra-driver` (pure JS) | CQL editor over the native protocol, keyspace browser with partition and clustering keys marked, `system_views` monitoring. No row counts and no sizes: the only figures Cassandra publishes are partition estimates and whole mebibytes, so neither is shown rather than shown wrong |
| **LibreDB** | `@libredb/libredb` | The embedded key-value store, for a database with nothing to install |

**Read-only where the engine is.** Druid, Elasticsearch and OpenSearch have no `UPDATE` and no `CREATE TABLE` anywhere in their grammar, so inline editing and DDL are reported as unsupported instead of failing when used. Everything else — the query editor, the object browser, ER diagrams, schema diff and monitoring — works wherever the engine has something to answer with.

### Engines with no provider of their own

Eighteen further engines speak the wire protocol of one of the fourteen drivers above, so they connect through it unchanged: pick that driver in the connection dialog. The table has fifteen rows rather than eighteen because engines that behave identically share a row; all eighteen are named in it. Every one of them was measured against a real instance rather than assumed, and how much of the product worked is recorded per engine.

| Engine | Connect as | Support |
| :--- | :--- | :--- |
| MariaDB | `mysql` | Full |
| TiDB | `mysql` | Full — but a freshly loaded table reads 0 rows and 0 B until TiDB's background statistics catch up, the slow-query panel stays empty, and only a standalone `--store=unistore` server was probed |
| Vitess | `mysql` | Full. Row counts and sizes are exact, but a running query cannot be cancelled: vtgate refuses `KILL QUERY` and the statement runs to completion. Per-index sizes read 0 bytes, and only an unsharded single-shard keyspace was probed |
| Citus | `postgres` | Full — but statistics describe the coordinator, so a distributed table's row count and size are wrong rather than missing |
| TimescaleDB | `postgres` | Full — but the statistics describe the empty parent table, so a hypertable's row count and size are wrong rather than missing, and every chunk shows up in the object browser |
| YugabyteDB | `postgres` | Full — but row counts and sizes read 0 until you run `ANALYZE`, and index sizes always read 0 bytes |
| AlloyDB Omni | `postgres` | Full. Row counts and sizes are exact, but the version panel cannot be told apart from a stock PostgreSQL 17 because `version()` names AlloyDB nowhere, eight of AlloyDB's own `google_ml` tables appear in the object browser, and the slow-query panel stays empty until `pg_stat_statements` is installed |
| Valkey · DragonflyDB · KeyDB | `redis` | Full |
| FerretDB | `mongodb` | Full — sign in with the backend PostgreSQL credentials |
| StarRocks | `mysql` | Partial — editor, table list, column metadata, table and storage stats, metrics and slow queries work; the overview, health, session and monitoring panels do not, the version reads MySQL 5.1, and row counts, sizes and indexes are empty |
| CockroachDB | `postgres` | Partial — editor, metrics, slow queries and sessions work; the object browser and size panels are blank |
| Apache Cloudberry (incubating) | `postgres` | Partial. Row counts and sizes are correct after `ANALYZE`, but the monitoring dashboard and the table and index statistics all fail on one MPP planner restriction, and a foreign key is read back as though enforced when the engine does not enforce it |
| OceanBase | `mysql` | Partial - fourteen of the fifteen surfaces return without throwing but only twelve do their job; health fails outright because the tenant has no `performance_schema` database at all, every size reads 0 B, and row counts are correct only once `ANALYZE TABLE` has run |
| SingleStore | `mysql` | Partial - ten of the fifteen surfaces answer, and five of the failures are ours rather than SingleStore's: the provider's prepared-statement protocol takes down Test Connection, health, the overview, the monitoring dashboard and Explain. Row counts and sizes are missing rather than wrong, a 2000-row table reading 0 rows and 0 B, and foreign keys do not exist at all |
| Materialize · RisingWave | `postgres` | Query editor only |

Details, probed versions and each caveat: [`docs/providers/README.md`](https://github.com/libredb/libredb-studio/blob/main/docs/providers/README.md).

---

## Key features

- **Professional SQL IDE** — Monaco editor (VS Code engine), schema-aware autocomplete, multi-tab workspace, Visual EXPLAIN.
- **Interactive ER diagrams** — real FK edges, cardinality, auto-layout (ELK.js), PNG/SVG export.
- **Schema diff & migration** — compare snapshots/connections and auto-generate migration SQL.
- **Read-only database agent** — state an objective, and the run drafts SQL, reads the results and composes a report whose claims cite them. Three workflows (investigate / optimize / assess), a visible statement-and-time budget, and writes refused before the database is reached. **Agent mode reads PostgreSQL and SQLite only** — they are the only engines with a database-native read-only execution profile, and on any other engine an Agent-mode run ends `engine-unsupported`; Plan mode is toolless, runs no statement of yours, and is **grounded in your own schema on every engine** — it reads the inventory before the model's first turn and asks for one statement in that engine's own language, or refuses with `NO STATEMENT:` and the question that would unblock it. Standalone image only. [Guide](https://github.com/libredb/libredb-studio/blob/main/docs/AGENT_GUIDE.md) · [What leaves the machine](https://github.com/libredb/libredb-studio/blob/main/docs/AGENT_DATA_FLOW.md).
- **Model-backed helpers** — query safety analysis, EXPLAIN-in-plain-English, AI-generated schema docs, data-profile summaries. Gemini / OpenAI / Ollama / custom; with no model configured — no `LLM_*` variables at all — no AI call is made. A key is required for Gemini and OpenAI only: Ollama and a custom endpoint count as a configured model without one, which enables the AI features — and the agent too, once its ledger path is writable.
- **Pro data grid** — virtualized millions of rows, inline editing, per-column filters, pivot table, CSV/JSON export.
- **Data visualization** — 8 chart types with aggregation and saved-chart dashboards.
- **Data privacy & masking** — automatic sensitive-column detection, RBAC-enforced masking, export protection.
- **Auth & SSO** — local email/password or OIDC (Auth0, Keycloak, Okta, Azure AD, Zitadel) with PKCE and role mapping.
- **DBA toolkit (admin)** — live monitoring dashboard, threshold alerts, full audit trail, and one-click maintenance in each engine's own terms (VACUUM/ANALYZE/REINDEX on PostgreSQL, `OPTIMIZE TABLE` on MySQL, and nothing offered where an engine has no maintenance statement to run).

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
