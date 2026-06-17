# LibreDB Studio on Koyeb

[Koyeb](https://www.koyeb.com) is a serverless PaaS that can run the prebuilt
LibreDB Studio Docker image directly from GHCR — no rebuild, no Dockerfile.

There are two ways to get LibreDB Studio onto Koyeb:

1. **Deploy to Koyeb button** (self-service, already live in the repo
   [README](../../README.md#-one-click-deploy)).
2. **Koyeb One-Click Apps catalog** listing (curated by Koyeb — see
   [`CATALOG_SUBMISSION.md`](./CATALOG_SUBMISSION.md)).

## Deploy button

The button encodes the whole service definition in the `app.koyeb.com/deploy`
query string:

| Setting | Value |
|---------|-------|
| Source | Docker image `ghcr.io/libredb/libredb-studio:latest` |
| Port | `3000` (HTTP, path `/`) |
| Health check | TCP on `3000`, 5s grace / 30s interval |
| Instance | `free` (scale-to-zero after idle) |
| Region | `fra` |
| Storage | `STORAGE_PROVIDER=local` (browser-side, default) |

Because the deploy button URL is long, edit it in the repo README rather than
by hand. URL-encode every special character (`@` → `%40`, `:` → `%3A`,
`[` → `%5B`, `]` → `%5D`, `=` inside a value → `%3D`).

## Important Koyeb specifics

- **No secret generation.** Unlike Railway's `${{ secret(48) }}`, Koyeb cannot
  auto-generate values. The user **must** set a strong `JWT_SECRET` (32+ chars)
  and real `ADMIN_PASSWORD` / `USER_PASSWORD` in the deploy form before
  launching. The prefilled values in the button are placeholders only.
- **Ephemeral filesystem.** Koyeb instances do not have a persistent disk in the
  button flow, so SQLite-on-disk storage (`STORAGE_PROVIDER=sqlite`) will reset
  on every redeploy/sleep. The button therefore defaults to
  `STORAGE_PROVIDER=local` (connection metadata kept in the browser).
- **Persistence option.** For storage that survives redeploys, set
  `STORAGE_PROVIDER=postgres` and `STORAGE_POSTGRES_URL` to a Koyeb managed
  Postgres or [Neon](https://neon.tech) connection string.
- **Scale-to-zero.** The `free` instance sleeps when idle and wakes on the next
  request (a brief cold start). Fine for demos and personal use.

## Environment variables

See the [main README environment table](../../README.md#environment-variables)
for the full list. Minimum required for a working Koyeb deploy:

| Variable | Notes |
|----------|-------|
| `JWT_SECRET` | 32+ chars, set your own |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | admin login |
| `USER_EMAIL` / `USER_PASSWORD` | standard user login |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `local` (default) or `oidc` |
| `STORAGE_PROVIDER` | `local` (default); `postgres` for persistence |

## Version bumps

The button pins `:latest`, but a catalog listing pins a specific tag. On each
release, update the image tag in the catalog submission (same manual-bump
caveat as the Railway and CapRover Docker-image templates).
