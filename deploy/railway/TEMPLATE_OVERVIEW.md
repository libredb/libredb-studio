# Deploy and Host libredb-studio on Railway

LibreDB Studio is an open-source, web-based SQL IDE for cloud-native teams. Query PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, and Redis from your browser — with AI-powered query assistance (natural-language-to-SQL, explain, and fix), an ERD viewer, schema diff, and a data profiler. No desktop client required.

## About Hosting libredb-studio

Hosting LibreDB Studio means running a single stateless Next.js container that serves the web IDE and proxies queries to the databases you connect to. This template runs the prebuilt `ghcr.io/libredb/libredb-studio` image on port 3000 with a healthcheck at `/api/db/health` — no build step required. Saved connections and settings are persisted with SQLite on an attached Railway volume (`/app/data`), so they survive restarts and redeploys. Authentication is JWT-based; a strong `JWT_SECRET` and admin/user passwords are auto-generated per deploy. Optional add-ons — AI providers (Gemini, OpenAI, Ollama, custom), OIDC SSO, or a PostgreSQL storage backend — are enabled later via environment variables.

## Common Use Cases

- Give a team a browser-based SQL console for cloud databases, with no desktop client to install or update.
- Spin up an admin/query UI right next to a Railway PostgreSQL or MySQL database in the same project.
- Use AI assistance to write, explain, and fix SQL across multiple database engines from one interface.

## Dependencies for libredb-studio Hosting

- A database to connect to — PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, or Redis (bring your own, or add a Railway database to the project).
- A persistent volume mounted at `/app/data` for the SQLite-backed store of saved connections and settings (included in this template).

### Deployment Dependencies

- Source & docs: https://github.com/libredb/libredb-studio
- Container image (GHCR): https://github.com/libredb/libredb-studio/pkgs/container/libredb-studio
- README / configuration: https://github.com/libredb/libredb-studio#readme

### Implementation Details

After the service is healthy, open its public domain and log in with the **admin** account (`admin@libredb.org`) — the generated `ADMIN_PASSWORD` is shown in the service's **Variables** tab. A standard query-only user (`user@libredb.org`) is also created.

To query a database hosted on Railway, add one to the project (**+ New → Database → PostgreSQL/MySQL**) and create a connection in Studio using the database's provided variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`).

Optional environment variables enable extra features:

```bash
# AI query assistance
LLM_PROVIDER=gemini          # gemini | openai | ollama | custom
LLM_API_KEY=your_api_key
LLM_MODEL=gemini-2.5-flash

# SSO (OIDC) — Auth0, Keycloak, Okta, Azure AD
NEXT_PUBLIC_AUTH_PROVIDER=oidc
OIDC_ISSUER=https://your-tenant.example.com
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
```

## Why Deploy libredb-studio on Railway?

<!-- Recommended: Keep this section as shown below -->
Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying libredb-studio on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
<!-- End recommended section -->
