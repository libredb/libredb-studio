# LibreDB Studio — CapRover One-Click App

This folder is the **source of truth** for deploying LibreDB Studio on
[CapRover](https://caprover.com) as a one-click app.

> Tracking issue: [libredb-studio#56](https://github.com/libredb/libredb-studio/issues/56)

| File | Purpose |
|------|---------|
| `libredb-studio.yml` | CapRover `captainVersion: 4` template (Docker-Compose + `caproverOneClickApp` block). |
| `libredb-studio.png` | 256×256 app logo used by the CapRover one-click UI. |

Both files are submitted as a PR to
[`caprover/one-click-apps`](https://github.com/caprover/one-click-apps)
(`public/v4/apps/libredb-studio.yml` + `public/v4/logos/libredb-studio.png`) —
the official listing, merged and live.

## Install (official one-click apps catalog)

CapRover dashboard → **Apps → One-Click Apps/Databases** → search **LibreDB Studio**.
No third-party repo to add.

The LibreDB 3rd-party repo that served this app while the official submission was
in review is now retired. Source for that repo:
<https://github.com/libredb/caprover-one-click-apps>.

## Install (manual template, for a version the catalog has not caught up to)

CapRover dashboard → **Apps → One-Click Apps/Databases** → select
**`>> TEMPLATE <<`** at the bottom of the dropdown → paste the contents of
`libredb-studio.yml` → **Next**.

## What the template does

- Runs `ghcr.io/libredb/libredb-studio` on container HTTP port `3000`, defaulting
  to a pinned version. The template advises against `:latest` but does not stop
  it: `validRegex` accepts any tag.
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

When a new Studio version is released, bump the version in `libredb-studio.yml`
and submit an update PR to the official repo. The version appears **twice** in
that file — the `defaultValue` of `$$cap_version` and the example inside its
`description` — and both must move together. Validate locally with the CapRover
repo's tooling:

```bash
npm ci && npm run validate_apps && npm run formatter
```

Two things to know before you bump:

- **`bun run distribution:check` does not verify this file.** It pins
  `caprover-official` with `remote_file` against the catalog, which is
  deliberate: that pin must measure what upstream actually serves, so it can
  never tell you whether this copy kept up. Nothing measures that, which is the
  gap [#268](https://github.com/libredb/libredb-studio/issues/268) describes and
  the reason to read the next bullet before every bump.
  `tests/unit/caprover-template.test.ts` covers what can be checked without
  leaving the file: it fails when the two places the version appears disagree,
  when the plain-HTTP cookie override is missing or stops saying what it costs,
  and when an em dash or a pictograph creeps back in.
- **Check upstream first.** This folder leads and the catalog follows, but that
  order has been broken twice, and the second time by us.
  [caprover/one-click-apps#1315](https://github.com/caprover/one-click-apps/pull/1315)
  bumped the catalog to 0.9.59 directly, leaving this file on 0.9.14 until it
  was resynced. Then
  [#1335](https://github.com/caprover/one-click-apps/pull/1335) ("fix login over
  plain HTTP", merged 2026-09-22) put the `AUTH_COOKIE_SECURE` override, the
  em dash and icon cleanup and the comment rewording straight into the catalog,
  and none of it came back here until 0.17.0. Compare against the live template
  before assuming this copy is ahead:

  ```bash
  curl -s https://raw.githubusercontent.com/caprover/one-click-apps/master/public/v4/apps/libredb-studio.yml \
    | diff -u libredb-studio.yml -
  ```
