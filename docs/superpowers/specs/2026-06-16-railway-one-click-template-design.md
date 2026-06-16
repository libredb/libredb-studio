# LibreDB Studio — Railway One-Click Template

**Date:** 2026-06-16
**Status:** Approved (brainstorming complete)
**Author:** cevheri + Claude

## Goal

Make LibreDB Studio installable on [Railway](https://railway.com) as a one-click
template, published to the Railway template marketplace and promoted with a
"Deploy on Railway" button. This opens a new distribution channel alongside the
existing CapRover / Render / Fly.io / Koyeb / Helm options.

## Background

Studio already ships a prebuilt multi-arch Docker image to GHCR
(`ghcr.io/libredb/libredb-studio`) on every `main` push. The deployment story is
mature: `deploy/caprover/` is the canonical pattern (template YAML + logo +
README), and `render.yaml` / `fly.toml` sit at repo root.

Railway differs from those tools in one key way: a **marketplace template is
created in a visual composer** (`railway.com/compose`), not from a config file
in the repo. The composer produces a template with a unique code (e.g.
`ZweBXA`); it stays unlisted until explicitly published. Docker-image templates
are fully supported but are **not** auto-updatable (no registry update
detection) — the pinned version is bumped manually, exactly like CapRover.

### Why no `railway.json` / `railway.toml`

Railway config-as-code only governs **build behavior when a GitHub repo is the
service source** (`builder = DOCKERFILE` rebuilds from source). It has no field
to say "use this prebuilt image." Since our template uses the **Docker image
source** (`ghcr.io/libredb/libredb-studio`), all runtime settings live in the
service definition itself. A `railway.toml` would only matter to someone who
connects the *repo* to Railway — and it would wastefully rebuild the image that
CI already publishes. Therefore config-as-code is intentionally **omitted**.

## Decisions (from brainstorming)

1. **Template shape:** single Studio service (Docker image + SQLite on a Railway
   volume), mirroring the CapRover template. Documented so users can add a
   Railway PostgreSQL/MySQL plugin afterward. No database baked into the template.
2. **Publish scope:** prepare all repo artifacts + an exact guided
   composer/publish checklist. The human performs the composer + publish steps
   (the supported path). No GraphQL API automation.

## Architecture

### Template service definition (entered in the Railway composer)

| Setting | Value |
|---------|-------|
| Source | Docker image `ghcr.io/libredb/libredb-studio:0.9.19` (pinned, never `:latest`) |
| Public networking | Enabled, target port `3000` |
| Healthcheck | `/api/db/health` |
| Volume | mount path `/app/data` (SQLite persistence across redeploys) |
| Restart policy | `ON_FAILURE`, max 3 retries |

**Environment variables** (Railway magic functions generate secrets, the
equivalent of CapRover's `$$cap_gen_random_hex`):

| Variable | Value | Notes |
|----------|-------|-------|
| `JWT_SECRET` | `${{ secret(48) }}` | auto-generated |
| `ADMIN_EMAIL` | `admin@libredb.org` | user-editable default |
| `ADMIN_PASSWORD` | `${{ secret(16) }}` | auto-generated |
| `USER_EMAIL` | `user@libredb.org` | user-editable default |
| `USER_PASSWORD` | `${{ secret(16) }}` | auto-generated |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `local` | |
| `STORAGE_PROVIDER` | `sqlite` | |
| `STORAGE_SQLITE_PATH` | `/app/data/libredb-storage.db` | on the volume |
| `PORT` | `3000` | matches Dockerfile + target port |
| `LLM_PROVIDER` | *(blank)* | optional AI |
| `LLM_API_KEY` | *(blank)* | optional AI |
| `LLM_MODEL` | *(blank)* | optional AI |
| `LLM_API_URL` | *(blank)* | optional AI |

### Components (repo artifacts)

```
deploy/railway/                      # source of truth, mirrors deploy/caprover/
├── template.json   # reviewable serialization of the composer config (spec of what to enter)
├── README.md       # install (deploy button + manual composer steps), post-install OIDC/AI, + "add a Railway database" note
├── PUBLISH.md       # exact step-by-step composer -> create -> publish checklist
├── libredb-studio.png  # logo (copied from deploy/caprover/)
└── .token          # RAILWAY_API_TOKEN (already present, gitignored)
```

**`template.json`** is a human/CI-reviewable description of the composer
configuration. Railway does not ingest it directly (the composer is the source),
but it (a) makes the template reviewable in PRs, (b) is the single place that
documents the exact image tag + env vars + volume, and (c) is what a future API
automation would consume. It mirrors the role of `deploy/caprover/libredb-studio.yml`.

### "Add a database" note (the optional-DB decision)

`deploy/railway/README.md` documents the post-install flow:
1. In the deployed Railway project: **+ New → Database → PostgreSQL** (or MySQL).
2. Railway provisions it and exposes `DATABASE_URL` / `PGHOST` / `PGPORT` /
   `PGUSER` / `PGPASSWORD` / `PGDATABASE`.
3. In Studio, create a connection using those values (host/port/db/user/password).

This gives a one-click adjacent database without coupling it into the template.

### README / docs wiring

- Add a **"Deploy on Railway"** button to the existing `## ⚡ One-Click Deploy`
  section of the repo `README.md`, beside the Koyeb and Render buttons:
  ```md
  [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=libredb-studio)
  ```
  `CODE` is a documented placeholder, filled in after publishing.
- Add a short **Railway** subsection under `## Deployment (DevOps)` pointing to
  `deploy/railway/README.md` and noting that image templates need manual version
  bumps (same caveat as CapRover).

## Maintenance

When a new Studio version ships: bump the image tag in `deploy/railway/template.json`
and `deploy/railway/README.md`, re-enter it in the composer (or update the
published template), and re-publish. Documented in `deploy/railway/PUBLISH.md`.

## Out of scope (YAGNI)

- GraphQL API automation for create/publish (human uses the composer).
- Multi-service template with a bundled Postgres.
- Auto-update wiring (unsupported for Docker-image templates).
- `railway.json` / `railway.toml` (see rationale above).

## Success criteria

1. `deploy/railway/` exists with `template.json`, `README.md`, `PUBLISH.md`, logo.
2. `template.json` faithfully encodes the service definition table above.
3. Repo `README.md` shows a Deploy-on-Railway button (with `CODE` placeholder)
   and a Railway deployment subsection.
4. `PUBLISH.md` is a checklist precise enough to create + publish without
   re-reading the Railway docs.
5. Following the checklist produces a working deployment: Studio reachable on its
   Railway domain, `/api/db/health` green, admin login works, data persists
   across a redeploy.
```

