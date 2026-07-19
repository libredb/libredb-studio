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

# Creates the app from the bundled fly.toml. --copy-config uses the file
# as-is without prompting, so pass your own app name and region explicitly.
# --no-deploy because secrets and the volume are not set up yet.
fly launch --copy-config --no-deploy --name my-libredb --region ams

# Persistent storage for saved connections and settings (1 GB is plenty).
# Use the SAME region you passed above - volumes are region-bound.
fly volumes create libredb_data --size 1 --region ams

# Required credentials. Everything is generated - note the two passwords
# printed below, you will log in with them.
ADMIN_PASSWORD=$(openssl rand -base64 15)
USER_PASSWORD=$(openssl rand -base64 15)
echo "admin: $ADMIN_PASSWORD  user: $USER_PASSWORD"
fly secrets set \
  JWT_SECRET=$(openssl rand -hex 32) \
  ADMIN_EMAIL=admin@libredb.org \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  USER_EMAIL=user@libredb.org \
  USER_PASSWORD="$USER_PASSWORD"

fly deploy
fly apps open
```

Log in with the admin credentials you set above.

## Notes

- The app state lives in SQLite on the mounted volume, so run a single
  machine. A Fly volume attaches to one machine at a time: `fly scale
  count 2` either fails for lack of a second volume or, with an extra
  volume, gives the second machine its own empty database (divergent
  state). For multi-instance setups switch to
  `STORAGE_PROVIDER=postgres` and set `STORAGE_POSTGRES_URL`.
- `auto_stop_machines` is enabled: the machine stops when idle and wakes
  on the next request. First request after idle takes a few seconds.
- To update, bump the image tag in `fly.toml` to the latest release and
  run `fly deploy` again.
- Optional features (AI assistance, OIDC login) are configured the same
  way as everywhere else — set the extra env vars with `fly secrets set`.
  See the [README](../README.md#configuration) for the list.
