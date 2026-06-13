# LibreDB Studio → CapRover One-Click App — Design

**Date:** 2026-06-14
**Status:** Approved
**Branch:** `feat/caprover-one-click-app`

## Goal

Make LibreDB Studio installable on [CapRover](https://caprover.com) in one click,
as the first step of a broader strategy to integrate Studio into cloud
providers / PaaS platforms. CapRover is the beachhead because it has a simple,
well-documented one-click-app format and a self-serve 3rd-party repository
mechanism.

## Strategy (decided)

**Official PR + LibreDB-owned 3rd-party repo.** CapRover's official repo
(`caprover/one-click-apps`) gatekeeps on popularity ("apps with thousands of
stars"), so the official PR may stall regardless of quality. To guarantee
availability we ship two channels:

1. **Official PR** to `caprover/one-click-apps` — maximum discoverability.
2. **LibreDB 3rd-party repo** (GitHub Pages) — instant availability, no
   dependency on the upstream merge decision.

Both channels are fed from a single **source of truth** committed to the Studio
repo at `deploy/caprover/`.

## Deliverables

### A. `libredb-studio` repo
- **GitHub Issue** (English) tracking the integration with rationale and
  acceptance criteria.
- **Feature branch** `feat/caprover-one-click-app`.
- **`deploy/caprover/`** folder — source of truth:
  - `libredb-studio.yml` — the CapRover template.
  - `libredb-studio.png` — 256×256 logo (rendered from `public/logo.svg`).
  - `README.md` — install + maintenance docs.
- **Spec doc** (this file).

### B. `caprover/one-click-apps` (upstream) — the PR
- Fork → branch → add `public/v4/apps/libredb-studio.yml` and
  `public/v4/logos/libredb-studio.png` → run `validate_apps` + `formatter` →
  open PR using their template (self-check boxes ticked).

### C. LibreDB 3rd-party CapRover repo
- A repo structured like `caprover/one-click-apps`, published via GitHub Pages,
  so users can add it under **3rd party repositories** in CapRover.
- *Note:* creating a brand-new repo + enabling GitHub Pages may require manual
  steps / org permissions; the spec documents the structure and the publish
  flow, and flags what needs a human hand.

## The template (`libredb-studio.yml`)

`captainVersion: 4`, a single service named `$$cap_appname`:

- **Image:** `ghcr.io/libredb/libredb-studio:$$cap_version` — pinned, default
  `0.9.14`. Never `:latest` (CapRover forbids it; tag is enforced by their
  validator/PR checklist).
- **Port:** `caproverExtra.containerHttpPort: '3000'`.
- **Persistence:** named volume `$$cap_appname-data` → `/app/data`, with
  `STORAGE_PROVIDER=sqlite` and `STORAGE_SQLITE_PATH=/app/data/libredb-storage.db`.
- **Auth (auto-generated):**
  - `JWT_SECRET: $$cap_gen_random_hex(48)` (≥32 chars guaranteed).
  - `ADMIN_PASSWORD` / `USER_PASSWORD` are **variables** defaulting to
    `$$cap_gen_random_hex(16)` so the generated values can be echoed back in
    `instructions.end`. (Inlining the generator in `environment` would produce a
    different value than any shown to the user — hence variables.)
  - `ADMIN_EMAIL` / `USER_EMAIL` are variables with sensible defaults so the
    end screen shows the exact login email.
- **AI/LLM (optional):** `$$cap_llm_provider/api_key/model/api_url` variables,
  empty by default — power users fill them, everyone else ignores.
- **`instructions.end`** echoes the login email + generated passwords and warns
  the user to save them, then explains where data lives and how to enable
  OIDC/Postgres later.

### Decisions & rationale

| Decision | Why |
|----------|-----|
| SQLite + persistent volume as default | Single container, survives restarts, no extra DB password/service. Simplest reliable persistence for a one-click DB tool. (localStorage loses data; bundled Postgres is heavier and more failure-prone on first install.) |
| Auto-generate + echo credentials | Zero-effort install while still secure; user can log in immediately from the final screen. |
| AI optional & blank | Studio works fully without AI; avoids forcing API keys at install. |
| OIDC/Postgres documented post-install, not in wizard | Keeps the install wizard short; advanced setups are env-var additions in App Configs. |
| `isOfficial: false` | Images are LibreDB's own (not a universally-recognized official source); honest per the repo's guidance. |
| Source of truth in `deploy/caprover/` | One place to maintain; both the upstream PR and the 3rd-party repo copy from it. |

## Validation

The template passes CapRover's own tooling with no changes:

```bash
npm ci && npm run validate_apps   # "Validated libredb-studio"
npm run formatter                 # "All matched files use Prettier code style!"
```

## Acceptance criteria

- [x] `deploy/caprover/` committed on the feature branch (yml + png + README).
- [x] Spec committed.
- [x] GitHub Issue opened on `libredb/libredb-studio` (English) — [#56](https://github.com/libredb/libredb-studio/issues/56).
- [x] PR opened on `caprover/one-click-apps` with passing validator + formatter — [#1303](https://github.com/caprover/one-click-apps/pull/1303).
- [x] LibreDB 3rd-party repo live — [libredb/caprover-one-click-apps](https://github.com/libredb/caprover-one-click-apps), published at <https://libredb.org/caprover-one-click-apps> (verified serving `/v4/list`).

## Maintenance

On each Studio release, bump `$$cap_version` `defaultValue` and re-publish to
both channels. CI in the 3rd-party repo can mirror the official repo's
`validate_apps` + `formatter` + GitHub Pages build.
