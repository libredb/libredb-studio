# LibreDB Studio — Railway One-Click Template

This folder is the **source of truth** for deploying LibreDB Studio on
[Railway](https://railway.com) as a one-click marketplace template.

> Tracking issue: [libredb-studio#174](https://github.com/libredb/libredb-studio/issues/174)

| File | Purpose |
|------|---------|
| `template.json` | Reviewable serialization of the template service config (image, env vars, volume, healthcheck). Railway does not ingest it directly — see note below. |
| `README.md` | This file — install + post-install instructions. |
| `PUBLISH.md` | Step-by-step checklist to create and publish the template in Railway's template editor. |
| `TEMPLATE_OVERVIEW.md` | Marketplace overview/README pasted into the publish form's "Template Overview" field. |
| `libredb-studio.png` | 256×256 app logo. |

> **Why no `railway.json` in the repo?** Railway config-as-code only controls how
> a **GitHub repo** source is *built*. Our template uses the prebuilt
> **Docker image** `ghcr.io/libredb/libredb-studio`, so every runtime setting
> lives in the service definition (captured in `template.json`), not in a repo
> config file. A `railway.toml` would only cause a redundant rebuild of an image
> CI already publishes.

## Deploy

Click the button to deploy from the Railway template marketplace:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/libredb-studio?referralCode=libredb&utm_medium=integration&utm_source=template&utm_campaign=generic)

Or browse the Railway template marketplace and search **LibreDB Studio**.

## Deploy (manual — works today, before publishing)

Railway dashboard → **New Project**, then in the project view click **+ New → Docker Image** →
enter `ghcr.io/libredb/libredb-studio:0.18.2`, then configure the service to
match [`template.json`](./template.json):

- **Networking:** enable a public domain, target port `3000`.
- **Healthcheck path:** `/api/db/health`.
- **Volume:** attach one mounted at `/app/data`.
- **Variables:** set the entries from `template.json` (Railway's variable editor
  accepts `${{ secret(48) }}` / `${{ secret(16) }}` for the auto-generated ones).

## What the template does

- Runs `ghcr.io/libredb/libredb-studio` (pinned version, never `:latest`) on
  container HTTP port `3000`.
- Generates a strong `JWT_SECRET` and the admin/user passwords once, when the
  template is deployed, via Railway's `secret()` function.
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

Find the generated passwords in the Railway service's **Variables** tab. Those
two variables seed the accounts once, so see **Changing the passwords later**
below before you edit either of them.

## Add a database to query (optional)

Studio is a client — connect it to any database. To spin one up right next to it
on Railway:

1. In your Railway project: **+ New → Database → PostgreSQL** (or MySQL).
2. Railway provisions it and exposes `DATABASE_URL`, `PGHOST`, `PGPORT`,
   `PGUSER`, `PGPASSWORD`, `PGDATABASE` (find them on the database service's
   **Variables** tab).
3. In LibreDB Studio, add a connection using those values
   (host / port / database / user / password). You can now query it.

## Changing the passwords later

`ADMIN_PASSWORD` and `USER_PASSWORD` seed the accounts once, while the server
store is still empty. Since 0.18.0 the accounts live in that store, on the
mounted volume, so changing either variable afterwards leaves the stored
password in place and the old one keeps working. Railway's `secret()` runs once,
when the template is deployed, so this only comes up if you edit the variable by
hand. The log reports the mismatch at the next sign-in attempt rather than at
start, so the deploy log right after the redeploy shows nothing, and it reports
it for the admin account only: a changed `USER_PASSWORD` produces no warning at
all.

To replace the admin password:

1. On the running service, open **Variables** and set `ADMIN_PASSWORD` to the new
   value.
2. Add `ADMIN_PASSWORD_RESET=true` with **+ New Variable**. The flag has to be
   set while `ADMIN_PASSWORD` already holds the new value; applying both in one
   redeploy does that, and so does a second redeploy after the first, which
   simply leaves the password alone.
3. Sign in with the new password to confirm it took.
4. Remove `ADMIN_PASSWORD_RESET`, because it applies again on every container
   lifetime while it is set, at that same first account-store read. It also
   clears that account's passkeys, ends its other sessions, and sets its second
   factor from `ADMIN_TOTP_SECRET`, or clears the factor when that variable is
   unset. If you do want a second factor, `ADMIN_TOTP_SECRET` is in the optional
   variables, and it has to be at least 128 bits (`openssl rand 20 | base32`):
   a shorter one does not degrade, it refuses every login with a 503.

`USER_PASSWORD` has no equivalent flag. Change that account under
**Admin → Accounts** in Studio. See [STORAGE.md](../../docs/STORAGE.md#accounts).

## Keeping the pin current

0.18.1 fixed [GHSA-jwvh-6phv-j9jh](https://github.com/libredb/libredb-studio/security/advisories/GHSA-jwvh-6phv-j9jh),
which covers 0.8.0 through 0.18.0 on a server store. This template runs
`STORAGE_PROVIDER=sqlite`, which is one of the two storage modes the advisory
covers, so a deployment still pinned below 0.18.1 is inside its range. The defect
needs two accounts using one browser profile one after the other: where the two
logins this template seeds go to different people who share a browser, the second
to sign in received the first one's browser copy of the workspace, with its saved
connection passwords and its query history.

## Post-install options

Add these variables on the Studio service to extend the deployment:

- **SSO / OIDC** — `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`.
- **PostgreSQL storage backend** (multi-node) — `STORAGE_PROVIDER=postgres`,
  `STORAGE_POSTGRES_URL=...`.
- **AI** — `LLM_PROVIDER` (`gemini` | `openai` | `ollama` | `custom`),
  `LLM_API_KEY`, `LLM_MODEL`, `LLM_API_URL`.

More details and docs: https://github.com/libredb/libredb-studio
