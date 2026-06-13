# LibreDB Studio — CapRover One-Click App

This folder is the **source of truth** for deploying LibreDB Studio on
[CapRover](https://caprover.com) as a one-click app.

| File | Purpose |
|------|---------|
| `libredb-studio.yml` | CapRover `captainVersion: 4` template (Docker-Compose + `caproverOneClickApp` block). |
| `libredb-studio.png` | 256×256 app logo used by the CapRover one-click UI. |

The same two files are published to two places:

1. **Official repo** — submitted as a PR to
   [`caprover/one-click-apps`](https://github.com/caprover/one-click-apps)
   (`public/v4/apps/libredb-studio.yml` + `public/v4/logos/libredb-studio.png`).
2. **LibreDB 3rd-party repo** — hosted by LibreDB so users can install
   immediately, independent of the official repo's review queue.

## Install (official repo, once merged)

CapRover dashboard → **Apps → One-Click Apps/Databases** → search **LibreDB Studio**.

## Install (LibreDB 3rd-party repo, available now)

CapRover dashboard → **Apps → One-Click Apps/Databases** → scroll to
**3rd party repositories** → paste the URL below → **Connect New Repository** →
search **LibreDB Studio**:

```
https://libredb.org/caprover-one-click-apps
```

Source for that repo: <https://github.com/libredb/caprover-one-click-apps>.

## Install (manual template — works today, no repo needed)

CapRover dashboard → **Apps → One-Click Apps/Databases** → select
**`>> TEMPLATE <<`** at the bottom of the dropdown → paste the contents of
`libredb-studio.yml` → **Next**.

## What the template does

- Runs `ghcr.io/libredb/libredb-studio` (pinned version, never `:latest`) on
  container HTTP port `3000`.
- Generates a strong `JWT_SECRET` and admin/user passwords automatically and
  echoes the login credentials on the final install screen.
- Persists saved connections & settings with **SQLite** on a CapRover
  persistent volume (`$$cap_appname-data` → `/app/data`), surviving restarts
  and redeploys.
- Exposes optional AI/LLM fields (Gemini, OpenAI, Ollama, custom) — leave blank
  to disable.

## Post-install options

Set these under the app's **App Configs** tab to extend the deployment:

- **SSO / OIDC** — `NEXT_PUBLIC_AUTH_PROVIDER=oidc`, `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`.
- **PostgreSQL storage backend** (multi-node) — `STORAGE_PROVIDER=postgres`,
  `STORAGE_POSTGRES_URL=...`.

## Maintaining this template

When a new Studio version is released, bump the `defaultValue` of
`$$cap_version` in `libredb-studio.yml` and re-publish to both repos. Validate
locally with the CapRover repo's tooling:

```bash
npm ci && npm run validate_apps && npm run formatter
```
