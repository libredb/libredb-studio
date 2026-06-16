# LibreDB Studio Railway One-Click Template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Railway one-click template for LibreDB Studio — repo artifacts under `deploy/railway/` plus README wiring — ready for a human to create + publish in the Railway composer.

**Architecture:** A single Docker-image service (`ghcr.io/libredb/libredb-studio:0.9.19`) with SQLite persistence on a Railway volume, secrets auto-generated via Railway magic functions. No config-as-code (`railway.json`/`railway.toml`) — image templates carry their settings in the service definition, which we document in `deploy/railway/template.json`. Mirrors the existing `deploy/caprover/` pattern.

**Tech Stack:** Railway template composer + marketplace, GHCR Docker image, JSON/Markdown artifacts, `jq` for validation.

**Reference spec:** `docs/superpowers/specs/2026-06-16-railway-one-click-template-design.md`

---

## File Structure

- Create: `deploy/railway/template.json` — reviewable serialization of the composer service config
- Create: `deploy/railway/README.md` — install (deploy button + manual composer steps) + post-install OIDC/AI + "add a Railway database" note
- Create: `deploy/railway/PUBLISH.md` — exact composer → create → publish checklist
- Create: `deploy/railway/libredb-studio.png` — logo, copied from `deploy/caprover/libredb-studio.png`
- Modify: `README.md` — add Deploy-on-Railway button to `## ⚡ One-Click Deploy`; add a Railway subsection under `## Deployment (DevOps)`
- Pre-existing: `deploy/railway/.token` (gitignored, untouched)

---

### Task 1: Logo asset

**Files:**
- Create: `deploy/railway/libredb-studio.png` (copy of `deploy/caprover/libredb-studio.png`)

- [ ] **Step 1: Copy the logo**

```bash
cp deploy/caprover/libredb-studio.png deploy/railway/libredb-studio.png
```

- [ ] **Step 2: Verify the copy is identical and non-empty**

Run: `cmp deploy/caprover/libredb-studio.png deploy/railway/libredb-studio.png && ls -l deploy/railway/libredb-studio.png`
Expected: no output from `cmp` (identical), file size ~20672 bytes.

- [ ] **Step 3: Commit**

```bash
git add deploy/railway/libredb-studio.png
git commit -m "feat(railway): add logo for one-click template"
```

---

### Task 2: `template.json` — service definition

**Files:**
- Create: `deploy/railway/template.json`

- [ ] **Step 1: Write the file**

```json
{
  "$comment": "Reviewable serialization of the LibreDB Studio Railway template. Railway does not ingest this file directly — the marketplace template is built in the composer at https://railway.com/compose. This file is the single source of truth for what to enter there (see PUBLISH.md) and what a future API automation would consume. Mirrors deploy/caprover/libredb-studio.yml.",
  "name": "LibreDB Studio",
  "description": "Open-source web-based SQL IDE. Query PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB & Redis from your browser, with AI-powered query assistance.",
  "tags": ["database", "sql", "ide", "postgres", "mysql", "mongodb", "redis"],
  "services": [
    {
      "name": "libredb-studio",
      "icon": "https://raw.githubusercontent.com/libredb/libredb-studio/main/deploy/railway/libredb-studio.png",
      "source": {
        "image": "ghcr.io/libredb/libredb-studio:0.9.19"
      },
      "networking": {
        "public": true,
        "targetPort": 3000
      },
      "healthcheck": {
        "path": "/api/db/health",
        "timeoutSeconds": 120
      },
      "restartPolicy": {
        "type": "ON_FAILURE",
        "maxRetries": 3
      },
      "volumes": [
        {
          "name": "libredb-data",
          "mountPath": "/app/data"
        }
      ],
      "variables": {
        "JWT_SECRET": "${{ secret(48) }}",
        "ADMIN_EMAIL": "admin@libredb.org",
        "ADMIN_PASSWORD": "${{ secret(16) }}",
        "USER_EMAIL": "user@libredb.org",
        "USER_PASSWORD": "${{ secret(16) }}",
        "NEXT_PUBLIC_AUTH_PROVIDER": "local",
        "STORAGE_PROVIDER": "sqlite",
        "STORAGE_SQLITE_PATH": "/app/data/libredb-storage.db",
        "PORT": "3000",
        "LLM_PROVIDER": "",
        "LLM_API_KEY": "",
        "LLM_MODEL": "",
        "LLM_API_URL": ""
      }
    }
  ]
}
```

- [ ] **Step 2: Validate JSON and assert key fields**

Run:
```bash
jq -e '.services[0].source.image == "ghcr.io/libredb/libredb-studio:0.9.19" and .services[0].volumes[0].mountPath == "/app/data" and .services[0].variables.STORAGE_PROVIDER == "sqlite" and (.services[0].variables.JWT_SECRET | test("secret"))' deploy/railway/template.json
```
Expected: prints `true` (and exit 0). If `jq` is absent, install or use `python3 -m json.tool deploy/railway/template.json` to at least confirm valid JSON.

- [ ] **Step 3: Commit**

```bash
git add deploy/railway/template.json
git commit -m "feat(railway): add template.json service definition"
```

---

### Task 3: `deploy/railway/README.md` — install + post-install + database note

**Files:**
- Create: `deploy/railway/README.md`

- [ ] **Step 1: Write the file**

````markdown
# LibreDB Studio — Railway One-Click Template

This folder is the **source of truth** for deploying LibreDB Studio on
[Railway](https://railway.com) as a one-click marketplace template.

| File | Purpose |
|------|---------|
| `template.json` | Reviewable serialization of the composer service config (image, env vars, volume, healthcheck). Railway does not ingest it directly — see note below. |
| `README.md` | This file — install + post-install instructions. |
| `PUBLISH.md` | Step-by-step checklist to create and publish the template in the Railway composer. |
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

Railway dashboard → **New Project → Empty Project → + New → Docker Image** →
enter `ghcr.io/libredb/libredb-studio:0.9.19`, then configure the service to
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
````

- [ ] **Step 2: Verify required content is present**

Run:
```bash
grep -q "railway.com/new/template/CODE" deploy/railway/README.md \
  && grep -q "ghcr.io/libredb/libredb-studio:0.9.19" deploy/railway/README.md \
  && grep -q "/app/data" deploy/railway/README.md \
  && grep -q "Add a database" deploy/railway/README.md \
  && echo "OK"
```
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/railway/README.md
git commit -m "docs(railway): add install + post-install README"
```

---

### Task 4: `deploy/railway/PUBLISH.md` — composer + publish checklist

**Files:**
- Create: `deploy/railway/PUBLISH.md`

- [ ] **Step 1: Write the file**

````markdown
# Publishing the LibreDB Studio Railway Template

A Railway **marketplace template** is built in the visual composer, not from a
repo file. This is the exact checklist to create and publish it. The values to
enter are in [`template.json`](./template.json).

## 1. Open the composer

- Go to https://railway.com/compose (or Workspace → **Templates** → **New Template**).

## 2. Add the Studio service

- Click **Add New → Docker Image**.
- Image: `ghcr.io/libredb/libredb-studio:0.9.19` (pinned — never `:latest`).
- Rename the service to `libredb-studio`.

## 3. Configure the service (match `template.json`)

- **Variables** tab — add each variable from `template.json`. For the generated
  ones, type the function literally:
  - `JWT_SECRET` = `${{ secret(48) }}`
  - `ADMIN_PASSWORD` = `${{ secret(16) }}`
  - `USER_PASSWORD` = `${{ secret(16) }}`
  - `ADMIN_EMAIL` = `admin@libredb.org`, `USER_EMAIL` = `user@libredb.org`
  - `NEXT_PUBLIC_AUTH_PROVIDER` = `local`
  - `STORAGE_PROVIDER` = `sqlite`, `STORAGE_SQLITE_PATH` = `/app/data/libredb-storage.db`
  - `PORT` = `3000`
  - `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_API_URL` = leave blank
- **Settings** tab — enable **Public Networking**, target port `3000`; set
  **Healthcheck Path** to `/api/db/health`.
- **Volume** — right-click the service → **Attach Volume**, mount path `/app/data`.

## 4. Create the template

- Click **Create Template**. Railway gives it an unlisted URL and a unique code
  (e.g. `ZweBXA`).

## 5. Smoke-test before publishing

- Deploy the unlisted template into a throwaway project.
- Open the public domain; confirm `/api/db/health` is green and the login page loads.
- Log in as `admin@libredb.org` with the generated `ADMIN_PASSWORD` (Variables tab).
- Add a saved connection, then **Redeploy** the service and confirm the
  connection is still there (SQLite volume persistence).

## 6. Publish

- Click **Publish** (or Workspace → Templates → **Publish** next to it).
- Fill the form: display name **LibreDB Studio**, the description and tags from
  `template.json`, the logo (`libredb-studio.png`), category Database/Developer Tools.
- Submit. The template is now in the marketplace and eligible for kickbacks.

## 7. Wire up the Deploy button

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
2. In the composer / published template, update the image tag and re-publish
   (Docker-image templates are **not** auto-updated by Railway).
````

- [ ] **Step 2: Verify required content is present**

Run:
```bash
grep -q "railway.com/compose" deploy/railway/PUBLISH.md \
  && grep -q "Create Template" deploy/railway/PUBLISH.md \
  && grep -q "Publish" deploy/railway/PUBLISH.md \
  && grep -q "/app/data" deploy/railway/PUBLISH.md \
  && echo "OK"
```
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/railway/PUBLISH.md
git commit -m "docs(railway): add composer + publish checklist"
```

---

### Task 5: Wire the Deploy button + Railway section into root `README.md`

**Files:**
- Modify: `README.md` (the `## ⚡ One-Click Deploy` block near line 357, and the `## Deployment (DevOps)` block near line 392)

- [ ] **Step 1: Add the Railway button after the Render button**

Find this line (the Render button, currently the last button in the One-Click Deploy section):

```md
 [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/libredb/libredb-studio)  
```

Add immediately after it (keep the trailing two spaces for the markdown line break):

```md
 [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=libredb-studio)  
```

- [ ] **Step 2: Add a Railway subsection under Deployment (DevOps)**

Find the Render subsection under `## Deployment (DevOps)`:

```md
### Render (Recommended for cloud deployment)

LibreDB Studio includes a `render.yaml` Blueprint for one-click deployment:
```

Insert a new subsection immediately **before** the `### Render` heading:

```md
### Railway

LibreDB Studio is available as a one-click [Railway](https://railway.com) template.
See [`deploy/railway/`](deploy/railway/) for the template definition, install
instructions, and the publish checklist. The template runs the prebuilt
`ghcr.io/libredb/libredb-studio` image with SQLite persistence on a Railway
volume. Note: Docker-image templates require a manual version bump on each
release (same as CapRover).

```

- [ ] **Step 3: Verify both edits landed**

Run:
```bash
grep -q "railway.com/button.svg" README.md \
  && grep -q "### Railway" README.md \
  && echo "OK"
```
Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add Railway one-click deploy button and section"
```

---

### Task 6: Final verification

**Files:** none (read-only checks)

- [ ] **Step 1: Confirm the deploy/railway folder is complete**

Run: `ls deploy/railway/`
Expected: `.token  PUBLISH.md  README.md  libredb-studio.png  template.json`

- [ ] **Step 2: Re-validate template.json**

Run: `jq empty deploy/railway/template.json && echo "valid JSON"`
Expected: prints `valid JSON`.

- [ ] **Step 3: Confirm .token is still gitignored (not staged anywhere)**

Run: `git check-ignore deploy/railway/.token`
Expected: prints `deploy/railway/.token` (i.e. it is ignored). If it prints nothing, STOP — the token must not be committed.

- [ ] **Step 4: Confirm clean tree**

Run: `git status --porcelain`
Expected: empty output (all work committed).

---

## Manual follow-up (human, not an agent)

These require the Railway dashboard + the account that owns the `.token`:

1. Follow `deploy/railway/PUBLISH.md` to create, smoke-test, and publish the template.
2. Replace `CODE` with the published template code in both READMEs (PUBLISH.md step 7) and commit.
3. (Optional) Decide on merging `dev` → `main` / opening a PR.

---

## Self-Review

- **Spec coverage:** Task 2 ↔ service definition table + env vars; Task 3 ↔ install/post-install/database note + README role of template.json; Task 4 ↔ publish checklist + maintenance; Task 5 ↔ README button + Deployment subsection; Task 1 ↔ logo; "no railway.toml" rationale documented in Task 3 README and the design. Success criteria 1–4 covered by Tasks 1–5; criterion 5 (live deploy) is the Manual follow-up + PUBLISH.md smoke test (cannot be automated from the repo).
- **Placeholders:** the only literal `CODE` is the documented, intentional template-code placeholder filled after publishing — explicitly tracked in PUBLISH.md step 7 and the Manual follow-up.
- **Consistency:** image tag `ghcr.io/libredb/libredb-studio:0.9.19`, mount path `/app/data`, port `3000`, and healthcheck `/api/db/health` are identical across template.json, README, PUBLISH.md, and the root README edit.
```

