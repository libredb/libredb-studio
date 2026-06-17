# Publishing the LibreDB Studio Railway Template

A Railway **marketplace template** is built in the visual template editor, not
from a repo file. This is the exact checklist to create and publish it. The
values to enter are in [`template.json`](./template.json).

## 1. Open the template editor

- Go to your **Workspace → Templates** page: <https://railway.com/workspace/templates>
- Click **New Template**. This opens the template editor (a canvas, like a project).

## 2. Add the Studio service

- In the editor, click **+ New** (top-right), or open the command palette
  (`⌘K` / `Ctrl+K`) → **+ New Service** → **Docker Image**.
- Image: `ghcr.io/libredb/libredb-studio:0.9.21` (pinned — never `:latest`).
- Rename the service to `libredb-studio`.

## 3. Variables

Fastest path: **Variables → Raw Editor → ENV**, paste the values below, **Update
Variables**, then add a **description** to each (the publish form asks for one).
The `${{ secret(...) }}` values are auto-generated per deploy.

### Pre-configured variables (defaults — entered for the deployer)

| Variable | Value | Description |
|----------|-------|-------------|
| `JWT_SECRET` | `${{ secret(48) }}` | Secret key used to sign login session tokens. Auto-generated — keep it. |
| `ADMIN_EMAIL` | `admin@libredb.org` | Login email for the ADMIN account (full access incl. maintenance tools). |
| `ADMIN_PASSWORD` | `${{ secret(16) }}` | Password for the admin account. Auto-generated; find it in Variables after deploy. |
| `USER_EMAIL` | `user@libredb.org` | Login email for the standard, query-only account. |
| `USER_PASSWORD` | `${{ secret(16) }}` | Password for the standard user. Auto-generated; find it in Variables after deploy. |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `local` | Auth mode: 'local' (email/password). Set 'oidc' for SSO (needs the OIDC_* optional vars). |
| `STORAGE_PROVIDER` | `sqlite` | Where saved connections & settings live: 'sqlite' (on the volume) or 'postgres' (multi-node). |
| `STORAGE_SQLITE_PATH` | `/app/data/libredb-storage.db` | SQLite file path on the mounted volume (/app/data). Keep the default. |
| `PORT` | `3000` | Port the app listens on. Must match the HTTP Proxy Port. Leave as 3000. |

### Optional variables (add via "+ New Variable" and mark **Optional**)

> ⚠️ Mark each of these **Optional** in the editor. A non-optional variable left
> empty becomes a **required** field the deployer must fill, which breaks the
> one-click flow. Optional vars let people enable AI / SSO / Postgres only if they want.

| Variable | Example | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `gemini` | Optional AI query assistance: gemini \| openai \| ollama \| custom. Omit to keep AI off. |
| `LLM_API_KEY` | `AIza… / sk-…` | API key for the chosen AI provider (Gemini/OpenAI). Not needed for a local Ollama. |
| `LLM_MODEL` | `gemini-2.5-flash` | AI model name; provider default used if empty (e.g. gpt-4o-mini, llama3.1). |
| `LLM_API_URL` | `http://host:11434/v1` | Base URL for ollama/custom AI providers only. Not needed for gemini/openai. |
| `OIDC_ISSUER` | `https://tenant.auth0.com` | OIDC issuer URL for SSO. Required when NEXT_PUBLIC_AUTH_PROVIDER=oidc. |
| `OIDC_CLIENT_ID` | | OIDC application client ID (SSO). |
| `OIDC_CLIENT_SECRET` | | OIDC application client secret (SSO). |
| `OIDC_SCOPE` | `openid profile email` | OIDC scopes. Defaults to 'openid profile email' if empty. |
| `OIDC_ROLE_CLAIM` | `realm_access.roles` | Claim path holding user roles, used for admin mapping. |
| `OIDC_ADMIN_ROLES` | `admin` | Comma-separated role values mapped to admin. Defaults to 'admin'. |
| `STORAGE_POSTGRES_URL` | `postgresql://user:pass@host:5432/db` | PostgreSQL URL for multi-node storage. Also set STORAGE_PROVIDER=postgres. |

## 4. Settings (service)

- **Networking** — set **HTTP Proxy Port** to `3000` (enables public HTTP access).
- **Deploy** — set **Healthcheck Path** to `/api/db/health` (Restart Policy
  `On Failure` is a sensible default).
- **Volume** — NOT in the Settings panel. Close the settings modal, then on the
  editor **canvas right-click the `libredb-studio` service → Attach Volume**, and
  set the mount path to `/app/data`.

## 5. Create the template

- Click **Create Template**. Railway gives it an unlisted URL and a unique code
  (e.g. `ZweBXA`).

## 6. Smoke-test before publishing

- Deploy the unlisted template into a throwaway project.
- Open the public domain; confirm `/api/db/health` is green and the login page loads.
- Log in as `admin@libredb.org` with the generated `ADMIN_PASSWORD` (Variables tab).
- Add a saved connection, then **Redeploy** the service and confirm the
  connection is still there (SQLite volume persistence).

## 7. Publish

- Click **Publish** (or Workspace → Templates → **Publish** next to it).
- Fill the form: display name **LibreDB Studio**, the description and tags from
  `template.json`, the logo (`libredb-studio.png`), category Database/Developer Tools.
- Submit. The template is now in the marketplace and eligible for Railway's template kickback (revenue-share) program.

## 8. Wire up the Deploy button

- Copy the template code from the published URL
  (`https://railway.com/new/template/<CODE>`).
- Replace `CODE` in:
  - root `README.md` (the `## ⚡ One-Click Deploy` section)
  - `deploy/railway/README.md`
- Commit the change.

## Maintaining the template

On a new Studio release:

1. Bump the image tag in `deploy/railway/template.json` and
   `deploy/railway/README.md`.
2. In the template editor / published template, update the image tag and
   re-publish (Docker-image templates are **not** auto-updated by Railway).
