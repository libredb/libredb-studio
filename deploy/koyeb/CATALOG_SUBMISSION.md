# Koyeb One-Click Apps Catalog — Submission

Getting LibreDB Studio listed in the public catalog at
[koyeb.com/deploy](https://www.koyeb.com/deploy).

## How the catalog works

Unlike a self-service marketplace, the Koyeb One-Click Apps catalog is
**curated by Koyeb**. There is:

- **no** "submit your app" form on the `/deploy` page,
- **no** public PR repository (the old `koyeb-community/catalog-builder` and
  `catalog-seed-action` repos are archived),

so the only path to a listing is to **reach out to Koyeb directly** and have
them add the app. A working "Deploy to Koyeb" button (which we already ship in
the repo README) is the prerequisite they build the catalog entry from.

## Contact channels

1. **Partner Hub form** — https://www.koyeb.com/partners → "Technology
   Providers" track. Submit the message below; their team schedules a call.
2. **Community** — https://community.koyeb.com (post in the appropriate
   category referencing the one-click catalog).
3. **Email / support** — via the contact link in the Koyeb dashboard.

Use the Partner Hub form as the primary channel; cross-post to the community as
a backup.

## Submission facts (have these ready)

| Field | Value |
|-------|-------|
| App name | LibreDB Studio |
| Category | Database / Developer Tools |
| Description | Open-source web-based SQL IDE for cloud-native teams |
| License | Open source (free) |
| Repository | https://github.com/libredb/libredb-studio |
| Website | https://libredb.org |
| Docker image | `ghcr.io/libredb/libredb-studio` (GHCR, multi-arch) |
| Pinned tag | `0.9.23` (bump on each release) |
| Port | `3000` (HTTP) |
| Health check | `GET /api/db/health` |
| Storage default | `local` (browser); `postgres` for persistence |
| Existing deploy button | see repo [README](../../README.md#-one-click-deploy) |

## Outreach message (paste into the Partner Hub form / email)

> **Subject:** One-Click App listing request — LibreDB Studio (open-source SQL IDE)
>
> Hi Koyeb team,
>
> We maintain **LibreDB Studio**, an open-source, web-based SQL IDE for
> cloud-native teams (PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB,
> Redis, with AI-assisted querying). It's free and Apache/MIT-style open source:
> https://github.com/libredb/libredb-studio
>
> We already ship a working **Deploy to Koyeb** button (prebuilt GHCR image
> `ghcr.io/libredb/libredb-studio`, port 3000, scale-to-zero on the free
> instance, `STORAGE_PROVIDER=local` so it fits Koyeb's ephemeral filesystem).
> The button URL with all env vars and health-check params is in our README.
>
> We'd love to be listed in the Koyeb One-Click Apps catalog
> (koyeb.com/deploy) so Koyeb users can launch a full database IDE in one
> click. We're happy to provide a logo, screenshots, a short description, and
> to keep the pinned image tag current on each release.
>
> What's the best way to proceed, and is there anything you need from us to
> create the catalog entry?
>
> Thanks!
> — The LibreDB team

## Assets to attach

- Logo (square, transparent PNG) — reuse `deploy/railway/libredb-studio.png` or
  the brand logo from the repo.
- 1–2 screenshots of the editor + results grid.
- One-line and short (≈75 char) descriptions (Railway template description can
  be reused).

## After acceptance

- Confirm the catalog entry pins a specific tag (not `:latest`) and add the
  manual version-bump step to the release checklist.
- Add the catalog URL (`https://www.koyeb.com/deploy/libredb-studio`) next to
  the existing button in the repo README once live.
