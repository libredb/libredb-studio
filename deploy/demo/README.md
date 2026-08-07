# The public demo instance

Everything about the showcase instance lives in
[`render.yaml`](render.yaml) next to this file, so it is changed by editing the
repo rather than by clicking through a dashboard.

## Why it is not the root Blueprint

The repository root `render.yaml` is what the README's "Deploy to Render" button
deploys, and services created from it redeploy on every commit here. A
`DEMO_MODE` value in that file would therefore switch on public demo access for
other people's deployments. The demo keeps its own Blueprint so nobody inherits
it.

## Why it is a separate service from app.libredb.org

Re-pointing an existing Blueprint reconciles that service's environment against
the new file, which would disturb whatever is currently set on the live
instance. A separate service leaves it alone, and gives the demo something the
live instance should not have: it can be wiped and rebuilt at any time.

## One-time setup

Render needs to be told, once, which repo and file to read. After that the
instance is repo-driven.

1. Render Dashboard → **New** → **Blueprint**
2. Repository: `libredb/libredb-studio`
3. Blueprint file path: **`deploy/demo/render.yaml`**
   (Render defaults to `render.yaml` at the root; custom paths are set here or
   later from the Blueprint's Settings page.)
4. When prompted, provide `JWT_SECRET` — 32+ characters, `openssl rand -base64 32`.
   It is the only value not in the file, because a committed session-signing
   secret is a committed session-signing secret.
5. Point `demo.libredb.org` at the new service and update the "Try Live Demo"
   button on libredb.org.

From then on, every change to the demo — sample data, the AI assistant, the
plan — is a commit to `deploy/demo/render.yaml`.

## What a visitor gets

`DEMO_MODE=true` puts an **Explore the live demo** button on the login screen
that opens a session in one click, with the `user` role: query execution, no
admin area (`src/proxy.ts` enforces it).

They land on the two built-in sample connections, **Sample (LibreDB)** and
**Sample (Employees)**, which the server seeds on first start. Storage is
browser-scoped, so each visitor gets their own workspace and cannot disturb the
next one's.

## Before a launch

- **Do not leave it on a free instance.** Free services spin down when idle and
  cold-start for roughly a minute. Launch traffic arrives in one burst, and the
  first visitors are the ones who decide whether the post gets upvoted.
- **Consider richer seed data.** The two embedded samples are small; the grid
  and the ER diagram are more convincing against realistic volume. See
  [`docs/SEED_CONNECTIONS.md`](../../docs/SEED_CONNECTIONS.md).
- **Never point this at real data.** Anyone who reaches the URL gets a session.
