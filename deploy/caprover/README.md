# LibreDB Studio — CapRover One-Click App

This folder is the **source of truth** for deploying LibreDB Studio on
[CapRover](https://caprover.com) as a one-click app.

> Tracking issue: [libredb-studio#56](https://github.com/libredb/libredb-studio/issues/56)

| File | Purpose |
|------|---------|
| `libredb-studio.yml` | CapRover `captainVersion: 4` template (Docker-Compose + `caproverOneClickApp` block). |
| `libredb-studio.png` | 256×256 app logo used by the CapRover one-click UI. |
| `libredb-studio-autoconnect.yml` | The auto-connect variant: the same Studio app plus a `-discovery` app that reads the Docker socket so Studio connects itself to the databases on the server. |
| `libredb-studio-autoconnect.png` | The same logo, under the file name upstream requires for the second app. |

The first two files are submitted as a PR to
[`caprover/one-click-apps`](https://github.com/caprover/one-click-apps)
(`public/v4/apps/libredb-studio.yml` + `public/v4/logos/libredb-studio.png`) —
the official listing, merged and live.

The auto-connect variant goes upstream the same way, as `public/v4/apps/libredb-studio-autoconnect.yml` and `public/v4/logos/libredb-studio-autoconnect.png`, and only once the Studio release it needs exists (see [Auto-connect variant](#auto-connect-variant)).
Once Studio 0.18.0 is published, and until the variant is listed there, install it through the manual template path below, pasting `libredb-studio-autoconnect.yml`.

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
- Sets `TRUSTED_PROXY_HOPS=1`, because CapRover's nginx is one proxy hop in front of the app.
  With the default of 0 the login rate limiter keys on the leftmost `X-Forwarded-For` entry, which the client writes.
- Exposes optional AI/LLM fields (Gemini, OpenAI, Ollama, custom) — leave blank
  to disable.

## Auto-connect variant

`libredb-studio-autoconnect.yml` deploys the same Studio app plus a second app, `<app>-discovery`, so that Studio connects itself to the databases this CapRover runs.
It needs LibreDB Studio 0.18.0 or later, the first release that ships the exporter (`docker/discover.mjs`) and reads `SEED_DISCOVERY_PATH`.
With an older tag the `-discovery` app cannot start, because its command names a file that image does not have.

What it adds to the plain template:

- **The `-discovery` companion.**
  It runs the same image with `command: ['node', '/usr/local/lib/libredb-studio/discover.mjs']`.
  A one-click `command` replaces the image entrypoint, so the exporter runs as root, which the Docker socket needs.
  Every 10 seconds it lists the services on `captain-overlay-network` and writes their names, hosts, images and the values of ten allow-listed database environment keys to `/app/discovery/services.json`, mode 0600, owned by uid 1001.
  It has no port and is not exposed as a web app.
- **The Docker socket.**
  `/var/run/docker.sock` is mounted into the companion only.
  Access to it is equivalent to root access on the host, which is why this is a separate catalog entry and `libredb-studio.yml` never mounts it.
  The exporter sends GET requests to two Docker Engine API paths only, but that is a property of its code, not of the socket.
- **The shared volume.**
  `$$cap_appname-discovered` is mounted at `/app/discovery` in both apps, never under `/app/data`, because `docker-entrypoint.sh` chowns the directory of `STORAGE_SQLITE_PATH` to uid 1001 when it starts as root.
  The exporter refuses to start when that directory is not owned by its own uid or is writable by group or others.
- **Studio settings.**
  `SEED_DISCOVERY_PATH` turns the discovery source on, `SEED_CACHE_TTL_MS=5000` re-reads the export at most every 5 seconds, and both built-in samples are off, so only the CapRover databases are listed.
  Discovered connections are visible to the admin login only.
- **Apps to skip.**
  The optional "Apps to skip" field becomes `DISCOVERY_EXCLUDE` of the companion: comma-separated CapRover app names whose databases Studio must not connect to.
  The exporter writes only the names of those apps to the export, and Studio's discovery status lists each one as skipped with the reason "listed in Apps to skip".

Both apps must run on one node, and that node must be a swarm manager.
Named volumes are local to a node, and only a manager answers the Docker service listing.
On a single-server CapRover this always holds.
On a cluster, pin both apps to the manager node under **App Configs**.
Otherwise the discovery status on Studio's admin Overview page reports `swarm_unavailable` (the companion runs on a worker) or keeps waiting for an export file it cannot see (the two apps run on different nodes).

Which engines are recognised, how their credentials are mapped and what the admin status shows is described in [Platform discovery (CapRover)](../../docs/SEED_CONNECTIONS.md#platform-discovery-caprover).

### Adding discovery to an existing install

An existing `libredb-studio` app is not adopted automatically.
To add discovery by hand, the app must already run 0.18.0 or later.
Below, `studio` stands for its app name.

1. In the `studio` app, under **App Configs**, add a persistent directory with **Path in App** `/app/discovery` and **Label** `studio-discovered`.
   Add the environment variables `SEED_DISCOVERY_PATH=/app/discovery/services.json` and `SEED_CACHE_TTL_MS=5000`, and `TRUSTED_PROXY_HOPS=1` if it is not set yet.
   Click **Save & Restart**.
2. Create an app named `studio-discovery` with **Has Persistent Data** checked.
3. In `studio-discovery`, under **HTTP Settings**, check **Do not expose as web-app externally** and save.
4. In `studio-discovery`, under **App Configs**:
   - add a persistent directory with **Path in App** `/app/discovery` and **Label** `studio-discovered`, the same label as in step 1;
   - add a persistent directory with **Path in App** `/var/run/docker.sock`, choose **Set specific host path**, and enter `/var/run/docker.sock` as **Path on Host**;
   - add the environment variables `DISCOVERY_OUTPUT=/app/discovery/services.json` and `DISCOVERY_NETWORK=captain-overlay-network`, plus `DISCOVERY_EXCLUDE` with any app names to skip;
   - set **Service Update Override** to the YAML below, which is what the template's `command` turns into;
   - click **Save & Restart**.

   ```yaml
   TaskTemplate:
     ContainerSpec:
       Command: ['node', '/usr/local/lib/libredb-studio/discover.mjs']
   ```

5. In `studio-discovery`, under **Deployment**, deploy the image `ghcr.io/libredb/libredb-studio:<version>` with the same `<version>` the `studio` app runs.
6. Sign in to Studio as the admin and open the Overview page under Admin.
   The discovery status should list your databases within about 30 seconds.
   If it keeps waiting for an export file, the two apps do not share the volume: run `docker volume ls` on the node, check that exactly one volume ends in `studio-discovered`, and check that both apps run on that node.

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

A release bumps both templates, `libredb-studio.yml` and `libredb-studio-autoconnect.yml`, in the same post-release pull request, and each carries the version in the same two places.
`libredb-studio-autoconnect.yml` never goes below 0.18.0, the first release with the exporter.
`tests/unit/caprover-template.test.ts` runs the same checks over both files, plus the auto-connect variant's own: the socket only in the companion, the shared volume, the disclosure that opens the install text.

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
