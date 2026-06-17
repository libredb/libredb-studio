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

## 3. Configure the service (match `template.json`)

- **Variables** tab → **Raw Editor** → **ENV** — paste this block, then **Update Variables**:
  ```env
  JWT_SECRET=${{ secret(48) }}
  ADMIN_EMAIL=admin@libredb.org
  ADMIN_PASSWORD=${{ secret(16) }}
  USER_EMAIL=user@libredb.org
  USER_PASSWORD=${{ secret(16) }}
  NEXT_PUBLIC_AUTH_PROVIDER=local
  STORAGE_PROVIDER=sqlite
  STORAGE_SQLITE_PATH=/app/data/libredb-storage.db
  PORT=3000
  ```
  ⚠️ Do NOT add `LLM_*` (or `OIDC_*`) with empty values — Railway treats an empty
  template variable as a **required user input**, breaking the one-click flow. AI
  is optional and added post-deploy (see the README). The `${{ secret(...) }}`
  values are auto-generated per deploy.
- **Settings** tab → **Networking** — set **HTTP Proxy Port** to `3000` (this
  enables public HTTP access).
- **Settings** tab → **Deploy** — set **Healthcheck Path** to `/api/db/health`
  (Restart Policy `On Failure` is a sensible default).
- **Volume** — volumes are NOT in the Settings panel. Close the settings modal,
  then on the editor **canvas right-click the `libredb-studio` service → Attach
  Volume**, and set the mount path to `/app/data`.

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
- Submit. The template is now in the marketplace and eligible for Railway's template kickback (revenue-share) program.

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
2. In the template editor / published template, update the image tag and
   re-publish (Docker-image templates are **not** auto-updated by Railway).
