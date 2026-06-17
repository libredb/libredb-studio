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
- **Volume** — select the service, open its **Volumes** section, and add a volume with mount path `/app/data`.

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
2. In the composer / published template, update the image tag and re-publish
   (Docker-image templates are **not** auto-updated by Railway).
