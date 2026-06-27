# LibreDB Studio on Kubero

[Kubero](https://www.kubero.dev) is a self-hosted, open-source PaaS — a
"Heroku alternative for Kubernetes" — that deploys 12-factor apps onto a cluster
from a built-in template catalog.

LibreDB Studio is listed in the official
[Kubero template catalog](https://www.kubero.dev/templates)
(merged in [kubero-dev/kubero#754](https://github.com/kubero-dev/kubero/pull/754)).
The canonical template lives in the Kubero repo at
[`services/libredb-studio/app.yaml`](https://github.com/kubero-dev/kubero/blob/main/services/libredb-studio/app.yaml)
as a `KuberoApp` custom resource; this folder is a documentation mirror, not the
source of truth.

## Install

From a running Kubero instance (see the
[Kubero install docs](https://docs.kubero.dev/docs/Getting-Started/Installation/)
to set one up):

1. **Open your Kubero dashboard** → create or pick a pipeline/app, then browse
   **Templates**.
2. **Search** for **LibreDB Studio**.
3. **Fill in the variables** — admin/user credentials, a strong `JWT_SECRET`
   (32+ chars), and any optional AI/storage settings.
4. **Deploy.**

## What the template does

- Runs the prebuilt `ghcr.io/libredb/libredb-studio` image (pinned tag, never
  `:latest`) with the `docker` deployment strategy on container HTTP port `3000`.
- Persists saved connections & settings with **SQLite** (`STORAGE_PROVIDER=sqlite`)
  on a `5Gi` ReadWriteOnce volume mounted at `/app/data`, surviving restarts and
  redeploys — no external database required.
- Ships configurable `ADMIN_EMAIL` / `ADMIN_PASSWORD`, `USER_EMAIL` /
  `USER_PASSWORD`, and `JWT_SECRET` env vars. The catalog defaults are
  placeholders — set real values before deploying.

## First login

After deploy, open the app's public URL and log in:

- **Admin** (full access incl. maintenance tools): `admin@libredb.org` + your
  `ADMIN_PASSWORD`.
- **User** (query execution only): `user@libredb.org` + your `USER_PASSWORD`.

## Environment variables

See the [main README environment table](../../README.md#environment-variables)
for the full list. Minimum required for a working Kubero deploy:

| Variable | Notes |
|----------|-------|
| `JWT_SECRET` | 32+ chars, set your own |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | admin login |
| `USER_EMAIL` / `USER_PASSWORD` | standard user login |
| `STORAGE_PROVIDER` | `sqlite` (default here); `postgres` for an external backend |

## Post-install options

Add these variables on the app to extend the deployment:

- **SSO / OIDC** — `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`.
- **PostgreSQL storage backend** (multi-node) — `STORAGE_PROVIDER=postgres`,
  `STORAGE_POSTGRES_URL=...`.
- **AI** — `LLM_PROVIDER` (`gemini` | `openai` | `ollama` | `custom`),
  `LLM_API_KEY`, `LLM_MODEL`, `LLM_API_URL`.

## Version bumps

The catalog template pins a specific image tag. On each release, bump the tag in
the Kubero repo's `services/libredb-studio/app.yaml` (same manual-bump caveat as
the Railway and CapRover Docker-image templates).

More details and docs: https://github.com/libredb/libredb-studio
