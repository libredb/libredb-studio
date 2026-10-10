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
# printed below, you will log in with them. They seed the accounts on the
# first start only; see the credentials note under Notes before you
# change them.
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
- `ADMIN_PASSWORD` and `USER_PASSWORD` seed the accounts once, while the
  account table is still empty. Since 0.18.0 the accounts live in the
  server store, which here is that SQLite file on the volume, so setting
  the secret again on an app whose accounts exist does not change the
  stored password: sign-in still wants the old one, and the log reports
  the mismatch on the first sign-in attempt rather than at start, so
  `fly logs` right after the deploy shows nothing. To apply the
  environment anyway, set the new `ADMIN_PASSWORD` first, then
  `fly secrets set ADMIN_PASSWORD_RESET=true` (a `fly secrets` call
  deploys the change itself unless you pass `--stage`). Sign in with
  the new password, then `fly secrets unset ADMIN_PASSWORD_RESET`,
  because it applies on every start while it is set. The reset also ends
  that account's other sessions, removes its passkeys, and replaces its
  TOTP factor with `ADMIN_TOTP_SECRET` or with none. `USER_PASSWORD`
  has no equivalent and no warning: change that account under
  Admin → Accounts. See [STORAGE.md](STORAGE.md#accounts).
- To update, bump the image tag in `fly.toml` to the latest release and
  run `fly deploy` again. The volume keeps saved connections and query
  history. An app coming from a tag below 0.18.0 has no accounts table
  yet, so the first sign-in after the update creates the accounts from
  `ADMIN_PASSWORD` and `USER_PASSWORD` as they stand then; from that
  point on those secrets stop taking effect. The secrets you deployed
  with therefore keep working across the update. The update also
  signs every local user out once, and the first sign-in starts from the
  account's server data, so editor tabs open before it are not kept:
  they were never on the server.
- An app still running a tag below 0.18.1 has a security reason to
  update.
  [GHSA-jwvh-6phv-j9jh](https://github.com/libredb/libredb-studio/security/advisories/GHSA-jwvh-6phv-j9jh)
  covers 0.8.0 through 0.18.0 on a server store, which the
  `STORAGE_PROVIDER = 'sqlite'` line in this file selects: an account
  that signed in on a browser profile another account had signed out of
  received that account's copy of the workspace, saved connection
  passwords and query history included. Until the update, give each
  person a browser profile of their own.
- Optional features (AI assistance, OIDC login) are configured the same
  way as everywhere else — set the extra env vars with `fly secrets set`.
  See the [README](../README.md#environment-variables) for the list.
