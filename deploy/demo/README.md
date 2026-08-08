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

Render needs to be told, once, which repo and file to read, and the domain has
to be pointed at it. None of this happens automatically. After it, every change
to the demo — sample data, the AI assistant, the plan — is a commit to
`deploy/demo/render.yaml`.

- [ ] **1.** Create the Render service from `deploy/demo/render.yaml` — *not* the root `render.yaml`
- [ ] **2.** Supply a `JWT_SECRET` when prompted
- [ ] **3.** Add the custom domain `demo.libredb.org` in Render
- [ ] **4.** Add the Cloudflare CNAME **as DNS-only (grey cloud)** and set SSL/TLS to Full
- [ ] **5.** Wait for Render to report the certificate valid, then switch to Proxied
- [ ] **6.** Repoint the "Try Live Demo" CTA on libredb.org to `demo.libredb.org`
- [ ] **7.** Verify in a private window, and confirm `app.libredb.org` is unchanged

### 1–2. Create the service

1. Render Dashboard → **New** → **Blueprint**
2. Repository: `libredb/libredb-studio`, branch `main`
3. Blueprint file path: **`deploy/demo/render.yaml`**. Render defaults to
   `render.yaml` at the root, which is the wrong file — it is the public
   "Deploy to Render" recipe and carries no demo access. Custom paths are set
   here, or later from the Blueprint's Settings page.
4. When prompted, provide `JWT_SECRET` — 32+ characters,
   `openssl rand -base64 32`. It is the only value not in the file, because a
   committed session-signing secret is a committed session-signing secret.

### 3–5. Custom domain

The service works on its `onrender.com` URL, but this is the link that goes on
Hacker News, Reddit and Product Hunt, and a vendor subdomain reads as a weekend
deployment. Use the real one.

1. Render → the demo service → **Settings** → **Custom Domains** → add
   `demo.libredb.org`
2. Cloudflare → DNS → `CNAME demo → libredb-studio-demo.onrender.com`,
   **Proxy status: DNS only (grey cloud)**
3. Cloudflare → SSL/TLS → encryption mode **Full**
4. Wait for Render to report the certificate issued and valid. The grey cloud
   above is not a detail to skip: a proxied record can block issuance, and the
   failure surfaces later as an unrelated TLS error.
5. Once the certificate is valid, optionally switch the record to **Proxied
   (orange cloud)** for Cloudflare's caching and WAF.

Per [Render's Cloudflare guide](https://render.com/docs/configure-cloudflare-dns).

### 6. Point the site at it

Update the "Try Live Demo" CTA on libredb.org to `https://demo.libredb.org`.
It currently points at `app.libredb.org`, which redirects to `/login`: a button
promising a live demo that opens an SSO prompt. Whether a stranger can complete
that prompt depends on how the identity provider is configured, but a visitor
evaluating the product should not have to find out. Leaving the CTA where it is
ships the fix and keeps the symptom.

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
