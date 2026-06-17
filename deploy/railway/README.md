# LibreDB Studio — Railway One-Click Template

This folder is the **source of truth** for deploying LibreDB Studio on
[Railway](https://railway.com) as a one-click marketplace template.

| File | Purpose |
|------|---------|
| `template.json` | Reviewable serialization of the template service config (image, env vars, volume, healthcheck). Railway does not ingest it directly — see note below. |
| `README.md` | This file — install + post-install instructions. |
| `PUBLISH.md` | Step-by-step checklist to create and publish the template in Railway's template editor. |
| `libredb-studio.png` | 256×256 app logo. |

> **Why no `railway.json` in the repo?** Railway config-as-code only controls how
> a **GitHub repo** source is *built*. Our template uses the prebuilt
> **Docker image** `ghcr.io/libredb/libredb-studio`, so every runtime setting
> lives in the service definition (captured in `template.json`), not in a repo
> config file. A `railway.toml` would only cause a redundant rebuild of an image
> CI already publishes.

## Deploy (once published)

Click the button (replace `CODE` with the published template code):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=libredb-studio)

Or browse the Railway template marketplace and search **LibreDB Studio**.

## Deploy (manual — works today, before publishing)

Railway dashboard → **New Project**, then in the project view click **+ New → Docker Image** →
enter `ghcr.io/libredb/libredb-studio:0.9.21`, then configure the service to
match [`template.json`](./template.json):

- **Networking:** enable a public domain, target port `3000`.
- **Healthcheck path:** `/api/db/health`.
- **Volume:** attach one mounted at `/app/data`.
- **Variables:** set the entries from `template.json` (Railway's variable editor
  accepts `${{ secret(48) }}` / `${{ secret(16) }}` for the auto-generated ones).

## What the template does

- Runs `ghcr.io/libredb/libredb-studio` (pinned version, never `:latest`) on
  container HTTP port `3000`.
- Auto-generates a strong `JWT_SECRET` and admin/user passwords via Railway's
  `secret()` function.
- Persists saved connections & settings with **SQLite** on a Railway volume
  (`/app/data`), surviving restarts and redeploys.
- Exposes optional AI/LLM fields (Gemini, OpenAI, Ollama, custom) — leave blank
  to disable.

## First login

After deploy, open the service's public domain and log in:

- **Admin** (full access incl. maintenance tools): `admin@libredb.org` + the
  generated `ADMIN_PASSWORD`.
- **User** (query execution only): `user@libredb.org` + the generated
  `USER_PASSWORD`.

Find the generated passwords in the Railway service's **Variables** tab.

## Add a database to query (optional)

Studio is a client — connect it to any database. To spin one up right next to it
on Railway:

1. In your Railway project: **+ New → Database → PostgreSQL** (or MySQL).
2. Railway provisions it and exposes `DATABASE_URL`, `PGHOST`, `PGPORT`,
   `PGUSER`, `PGPASSWORD`, `PGDATABASE` (find them on the database service's
   **Variables** tab).
3. In LibreDB Studio, add a connection using those values
   (host / port / database / user / password). You can now query it.

## Post-install options

Add these variables on the Studio service to extend the deployment:

- **SSO / OIDC** — `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`.
- **PostgreSQL storage backend** (multi-node) — `STORAGE_PROVIDER=postgres`,
  `STORAGE_POSTGRES_URL=...`.
- **AI** — `LLM_PROVIDER` (`gemini` | `openai` | `ollama` | `custom`),
  `LLM_API_KEY`, `LLM_MODEL`, `LLM_API_URL`.

More details and docs: https://github.com/libredb/libredb-studio
