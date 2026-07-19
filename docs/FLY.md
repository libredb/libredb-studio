# LibreDB Studio on Fly.io

Fly.io does not have a template gallery, so this repo ships a ready
[`fly.toml`](../fly.toml) instead. It runs the prebuilt
`ghcr.io/libredb/libredb-studio` image with a persistent volume at
`/app/data` and a health check on `/api/db/health`.

## Deploy

You need [flyctl](https://fly.io/docs/flyctl/install/) and a Fly.io account.

```bash
git clone https://github.com/libredb/libredb-studio
cd libredb-studio

# Creates the app from the bundled fly.toml. Pick your own app name and
# region when prompted. --no-deploy because secrets are not set yet.
fly launch --copy-config --no-deploy

# Persistent storage for saved connections and settings (1 GB is plenty).
# Use the same region you picked above.
fly volumes create libredb_data --size 1

# Required credentials. Generate a strong JWT secret, choose your own
# passwords.
fly secrets set \
  JWT_SECRET=$(openssl rand -hex 32) \
  ADMIN_EMAIL=admin@libredb.org \
  ADMIN_PASSWORD=change-me \
  USER_EMAIL=user@libredb.org \
  USER_PASSWORD=change-me-too

fly deploy
fly apps open
```

Log in with the admin credentials you set above.

## Notes

- The app state lives in SQLite on the mounted volume, so run a single
  machine. Do not `fly scale count 2` — two writers on one SQLite file
  will corrupt it. For multi-instance setups switch to
  `STORAGE_PROVIDER=postgres` and set `STORAGE_POSTGRES_URL`.
- `auto_stop_machines` is enabled: the machine stops when idle and wakes
  on the next request. First request after idle takes a few seconds.
- To update, bump the image tag in `fly.toml` to the latest release and
  run `fly deploy` again.
- Optional features (AI assistance, OIDC login) are configured the same
  way as everywhere else — set the extra env vars with `fly secrets set`.
  See the [README](../README.md#configuration) for the list.
