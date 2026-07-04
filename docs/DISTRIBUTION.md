# Distribution & Install Guide

The canonical guide to every supported way of installing and operating LibreDB Studio, and to
how the release pipeline publishes each channel. For a one-line-per-channel overview, see the
[Install matrix in the README](../README.md#install).

| Channel | Best for | Section |
|---|---|---|
| Docker | Servers, PaaS, CI, quickest start | [Docker](#docker) |
| Helm | Kubernetes | [Helm (Kubernetes)](#helm-kubernetes) |
| npx | Trying it on a laptop with Node installed | [npx](#npx) |
| Homebrew | macOS / Linux workstations | [Homebrew](#homebrew) |
| .deb / .rpm | Debian/Ubuntu and RHEL/Fedora servers (systemd) | [Linux packages (.deb / .rpm)](#linux-packages-deb--rpm) |
| Snap | Ubuntu and other snapd systems | [Snap](#snap) |

All non-Docker channels ship or download the same **standalone server payload** (Next.js
standalone output, started with `node server.js`) built by
[`scripts/build-standalone-payload.sh`](../scripts/build-standalone-payload.sh) and attached to
GitHub releases by [`.github/workflows/release-artifacts.yml`](../.github/workflows/release-artifacts.yml).
Standalone artifacts (tarballs, .deb/.rpm, Homebrew formula, snap) are published **on release**,
starting with the first release that includes the release-artifacts workflow — older releases
have Docker images only.

> **Runtime note:** every channel here runs the production server under Node (`node server.js`),
> including the Docker image — its runner stage is `node:24.16.0-trixie-slim` and `CMD` execs
> `node server.js`; Bun is only used to install dependencies during the Docker build and for local
> development (`bun dev`). The SQLite DB provider adapts to whichever runtime it finds
> (`bun:sqlite` under Bun, `node:sqlite` under Node) — see
> [docs/providers/sqlite.md, Runtime & driver selection](providers/sqlite.md#runtime--driver-selection).

## Zero-config first run

Every channel works with no configuration. When `JWT_SECRET` / `ADMIN_PASSWORD` are not set
(and the auth provider is not OIDC), the server generates them on first start, persists them in
`<data dir>/auth-bootstrap.json` (file mode 0600), and prints the admin password **once** to the
server log:

```
============================================================
 LibreDB Studio first run: generated admin credentials
 Email:    admin@libredb.org
 Password: <generated>
 Stored in <data dir>/auth-bootstrap.json (delete the file to regenerate)
============================================================
```

- The data dir is the directory of `STORAGE_SQLITE_PATH` (default `./data` inside the payload /
  container). Each channel below documents where that is and how to read the log.
- Explicitly set environment variables always take precedence; only missing values are generated.
- If the data dir is not persisted (ephemeral container, no volume), new credentials are
  generated on every recreate.

**Strict mode:** set `AUTH_BOOTSTRAP=off` to disable generation and require explicit
`JWT_SECRET` and `ADMIN_PASSWORD` (recommended for production; missing values then surface as a
clear error on the login page instead of silently generated credentials in collected logs). The
Helm chart defaults to strict mode; all other channels default to zero-config. Unrecognized
`AUTH_BOOTSTRAP` values log a warning and keep bootstrap on.

## Network exposure (bind address)

Every native channel is **local-first**: the server binds to `127.0.0.1` by default, and
exposing it on the network is an explicit opt-in. (The Docker image and the Helm chart are the
exception - containers must bind `0.0.0.0` and are isolated by container networking instead.)

| Channel | Default bind | How to expose |
|---|---|---|
| npx | `127.0.0.1` | `npx @libredb/studio --host 0.0.0.0` (or set `HOSTNAME`) |
| .deb / .rpm (systemd) | `127.0.0.1` | `HOSTNAME=0.0.0.0` in `/etc/libredb-studio/env`, then restart |
| Homebrew service | `127.0.0.1` | run the binary manually with `HOSTNAME=0.0.0.0`, or front it with a reverse proxy |
| Snap | `127.0.0.1` | `sudo systemctl edit snap.libredb-studio.libredb-studio.service` with `[Service]` `Environment=HOSTNAME=0.0.0.0` |
| Docker / Helm | `0.0.0.0` (container-internal) | publish/route ports as usual (`-p`, Service/Ingress) |

For anything reachable from a network, prefer a reverse proxy with TLS in front and strict mode
(`AUTH_BOOTSTRAP=off`) with explicit credentials.

## Release artifact naming

Release tags carry **no `v` prefix** (tag `0.9.41` == package.json version). Each release ships:

| Artifact | Name | Targets |
|---|---|---|
| Standalone server tarball | `libredb-studio-standalone-<version>-<os>-<arch>.tar.gz` | `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` |
| Checksums | `SHA256SUMS` | covers all tarballs |
| Debian package | `libredb-studio_<version>_<arch>.deb` (+ `.sha256` sidecar) | `amd64`, `arm64` |
| RPM package | `libredb-studio-<version>.<arch>.rpm` (+ `.sha256` sidecar) | `x86_64`, `aarch64` |
| Snap | `libredb-studio_<version>_<arch>.snap` | `amd64`, `arm64` (also published to the Snap Store) |

`SHA256SUMS` covers the standalone tarballs; each `.deb`/`.rpm` ships its own per-file
`<artifact>.sha256` sidecar instead (the packages are built in a separate job).

Download URL pattern:
`https://github.com/libredb/libredb-studio/releases/download/<version>/<artifact>`.

There is no Windows standalone artifact yet — Windows users should run Docker; native Windows
packaging is tracked in [issue #114](https://github.com/libredb/libredb-studio/issues/114).

## Docker

`ghcr.io/libredb/libredb-studio` is the canonical image (no pull rate limits). Docker Hub
(`libredb/libredb-studio`) is a discoverability mirror only.

```bash
# Zero-config: the first run prints the generated admin password to the log
docker run -d --name libredb-studio -p 3000:3000 \
  -v libredb-data:/app/data \
  ghcr.io/libredb/libredb-studio:latest

docker logs libredb-studio   # shows the first-run credentials banner
```

The `/app/data` volume persists the generated credentials and the server-side SQLite storage;
without it, a recreated container generates new credentials.

Production (strict mode, explicit secrets):

```bash
docker run -d --name libredb-studio -p 3000:3000 \
  -e AUTH_BOOTSTRAP=off \
  -e JWT_SECRET=change-me-to-a-random-32-char-string \
  -e ADMIN_EMAIL=admin@libredb.org \
  -e ADMIN_PASSWORD=your_secure_admin_password \
  ghcr.io/libredb/libredb-studio:latest
```

All environment variables are documented in [`.env.example`](../.env.example); a ready-to-use
compose file is [`docker-compose.example.yml`](../docker-compose.example.yml).

### Image tag model

Published by [`.github/workflows/docker-build-push.yml`](../.github/workflows/docker-build-push.yml):

| Tag | Published from | Mutability |
|---|---|---|
| `<version>` (e.g. `0.9.41`) | GitHub release (or manual dispatch) only | pinned, never overwritten by branch pushes |
| `latest` | GitHub release only | moves on each release |
| `main` | every push to `main` (including PR merges) | moving pre-release tag |
| `dev` | every push to a `feat/**` / `fix/**` branch | moving development tag |
| `sha-<commit>` | every build | immutable |

Use `<version>` or `sha-<commit>` for reproducible deployments; `main` / `dev` are for testing
unreleased code.

## Helm (Kubernetes)

```bash
helm repo add libredb https://libredb.org/libredb-studio/
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

Or from the OCI registry:

```bash
helm install libredb oci://ghcr.io/libredb/charts/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

**The chart defaults to strict mode** (`config.authBootstrap: "off"`): Kubernetes deployments
inject real secrets anyway, and generated credentials in pod logs are undesirable when logs are
collected centrally, so `secrets.jwtSecret` and `secrets.adminPassword` (or
`secrets.existingSecret`) are required. To opt into zero-config instead, set
`--set config.authBootstrap=on` **and** `persistence.enabled=true` so generated credentials
survive pod restarts; `config.authBootstrap=""` omits the variable and uses the app default (on).

Full values reference: [`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md);
chart architecture: [`docs/HELM_CHART.md`](HELM_CHART.md).

## npx

Requires Node.js 24+ on Linux or macOS (x64 / arm64). The npm package stays a pure library for
libredb-platform; the launcher downloads the matching standalone tarball from the GitHub
release, verifies it against the `SHA256SUMS` release asset, caches it under
`~/.libredb-studio/<version>/`, and starts `node server.js`:

```bash
npx @libredb/studio                # first run downloads + verifies, then starts
npx @libredb/studio --port 8080    # or set PORT
npx @libredb/studio --help
```

`--archive` starts from a local tarball and **skips checksum verification** unless you pin a
digest with `--archive-sha256 <hex>` - only use archives you built yourself or obtained from a
trusted source. Downloads retry transient failures with
backoff and abort when the connection stalls. The cache in `~/.libredb-studio/<version>/` lives
in your home directory's trust domain; `--verify-cache` re-checks the cached tarball against the
cached `SHA256SUMS` and re-extracts the payload.

- Later runs start straight from the cache (per-version directory; delete it to force a
  re-download).
- All environment variables are forwarded to the server (`PORT`, `HOSTNAME`, `JWT_SECRET`,
  `ADMIN_PASSWORD`, `AUTH_BOOTSTRAP`, `STORAGE_PROVIDER`, `STORAGE_SQLITE_PATH`, `LLM_*`, ...).
  Missing auth secrets are handled by the zero-config first run, which prints the admin
  password to the terminal.
- `--archive <path>` (env: `LIBREDB_STUDIO_ARCHIVE`) starts from a local standalone tarball
  instead of downloading — useful for testing a tarball built with
  `scripts/build-standalone-payload.sh` (checksum verification is skipped and the archive is
  re-extracted on every run).
- On Windows the launcher exits with a pointer to Docker
  ([issue #114](https://github.com/libredb/libredb-studio/issues/114)).
- Versions released before the standalone tarballs existed have no artifacts; the launcher
  detects this (HTTP 404) and suggests `npx @libredb/studio@latest`.

## Homebrew

The formula tracks the latest release (it is rendered and pushed to
[`libredb/homebrew-tap`](https://github.com/libredb/homebrew-tap) by release CI):

```bash
# One-time: Homebrew's untrusted-tap policy requires trusting third-party taps
brew trust libredb/tap

brew install libredb/tap/libredb-studio

# Foreground (first run prints the generated admin password to the terminal)
libredb-studio

# Or as a background service
brew services start libredb-studio
```

- The formula depends on Homebrew's `node@24` — the payload's native SQLite storage binding
  (better-sqlite3) is built against the Node 24 ABI in release CI, so the floating `node`
  formula (a newer major) cannot load it — and installs the standalone payload into the keg's
  `libexec`; `libredb-studio` on your PATH runs it.
- `brew services start libredb-studio` runs the server on port 3000 with server-side SQLite
  storage (it sets `STORAGE_PROVIDER=sqlite`) under `$(brew --prefix)/var/libredb-studio/` —
  the data dir where generated credentials are persisted. The service does not capture stdout,
  so read the generated password from `$(brew --prefix)/var/libredb-studio/auth-bootstrap.json`.
- When running `libredb-studio` directly, set `STORAGE_SQLITE_PATH` to a path outside the keg
  if you use `STORAGE_PROVIDER=sqlite`, so state survives upgrades.

## Linux packages (.deb / .rpm)

Native packages for Debian/Ubuntu and RHEL/Fedora (amd64/x86_64 and arm64/aarch64) are attached
to every GitHub release. They bundle the standalone server together
with a private, checksum-verified Node.js runtime under `/usr/lib/libredb-studio` — nothing else
to install — and register a hardened systemd service:

```bash
VERSION=<version>   # e.g. 0.9.42 - release tags have no v prefix

# Debian / Ubuntu
curl -fsSLO "https://github.com/libredb/libredb-studio/releases/download/${VERSION}/libredb-studio_${VERSION}_amd64.deb"
curl -fsSLO "https://github.com/libredb/libredb-studio/releases/download/${VERSION}/libredb-studio_${VERSION}_amd64.deb.sha256"
sha256sum -c "libredb-studio_${VERSION}_amd64.deb.sha256"
sudo dpkg -i "libredb-studio_${VERSION}_amd64.deb"

# RHEL / Fedora / Rocky
curl -fsSLO "https://github.com/libredb/libredb-studio/releases/download/${VERSION}/libredb-studio-${VERSION}.x86_64.rpm"
curl -fsSLO "https://github.com/libredb/libredb-studio/releases/download/${VERSION}/libredb-studio-${VERSION}.x86_64.rpm.sha256"
sha256sum -c "libredb-studio-${VERSION}.x86_64.rpm.sha256"
sudo rpm -i "libredb-studio-${VERSION}.x86_64.rpm"
```

Operate it with systemd:

```bash
sudo systemctl enable --now libredb-studio   # start now and on boot
journalctl -u libredb-studio                 # first run prints the generated admin password here
sudo systemctl restart libredb-studio        # apply configuration changes
```

- **Configuration** lives in `/etc/libredb-studio/env` (`KEY=value` lines, loaded by the unit
  via `EnvironmentFile`). The installed file is a commented template covering `PORT`,
  `HOSTNAME`, `AUTH_BOOTSTRAP`, `JWT_SECRET`, `ADMIN_*` / `USER_*`, and `LLM_*`. It is mode
  0600 (read by systemd as root before privileges drop, so secrets stay away from other users)
  and marked as a config file — package upgrades never overwrite your edits.
- **State** (server-side SQLite storage and generated credentials) lives in
  `/var/lib/libredb-studio`, owned by the service's `DynamicUser` account.
- The unit runs with systemd hardening (`ProtectSystem=strict`, `NoNewPrivileges`, empty
  capability set, ...) and only writes its state directory.
- The `libredb-studio` command (`/usr/bin/libredb-studio`) can also be run directly without
  systemd; configuration then comes from your shell environment, and state defaults to
  `${XDG_STATE_HOME:-~/.local/state}/libredb-studio/` when `STORAGE_SQLITE_PATH` is unset (the
  payload directory under `/usr/lib` is read-only).
- Removal (`apt remove` / `rpm -e`) stops and disables the service; upgrades restart it if it
  is running (standard systemd maintainer scripts, `packaging/linux/scripts/`).

## Snap

Available once the snap is published to the Snap Store (publishing is wired in release CI but
gated on store credentials — see [Maintainer notes](#maintainer-notes)):

```bash
sudo snap install libredb-studio
sudo snap logs libredb-studio   # first run prints the generated admin password here
```

- Installing the snap starts a background daemon serving on port 3000.
- State (SQLite storage, generated credentials) lives in `$SNAP_DATA`
  (`/var/snap/libredb-studio/current`).
- The snap is **strictly confined** with only the `network` / `network-bind` interfaces: TCP
  database connections are the supported path; unix-socket connections to databases on the
  host (e.g. `/var/run/postgresql/`) are not supported.
- The `.snap` file is also attached to each GitHub release for offline installs
  (`sudo snap install --dangerous libredb-studio_<version>_amd64.snap`).

## Building a standalone payload locally

The single source of truth for the release tarballs also works locally (Linux and macOS):

```bash
bun install
bash scripts/build-standalone-payload.sh dist --smoke
# -> dist/libredb-studio-standalone-<version>-<os>-<arch>.tar.gz
```

`--smoke` boots the packed payload with `node server.js` and requires
`GET /api/db/health` to return 200. Run the result via the npx launcher:
`npx @libredb/studio --archive dist/libredb-studio-standalone-<version>-<os>-<arch>.tar.gz`.

## Maintainer notes

Release publishing is driven by two workflows, both triggered on `release: published` (plus
`workflow_dispatch`):

- [`docker-build-push.yml`](../.github/workflows/docker-build-push.yml) — GHCR image
  (version + `latest` tags) and the Docker Hub mirror.
- [`release-artifacts.yml`](../.github/workflows/release-artifacts.yml) — standalone tarballs +
  `SHA256SUMS`, `.deb`/`.rpm` (nfpm, [`packaging/linux/`](../packaging/linux)), the Homebrew
  formula ([`packaging/homebrew/`](../packaging/homebrew) rendered by
  [`scripts/render-homebrew-formula.mjs`](../scripts/render-homebrew-formula.mjs)), and the snap
  ([`snap/snapcraft.yaml`](../snap/snapcraft.yaml)).
- The npm package (`@libredb/studio`, which carries the npx launcher `bin/studio.js`) is
  published by the separate npm-publish workflow, also on `release: published`.

### First-release validation runbook

The macOS matrix legs, the Homebrew tap push, and the Snap publish first run live on the next
release. Right after publishing it:

1. Watch the `release-artifacts` run: all four tarball legs green (if the `macos-15-intel` or
   `macos-14` runner labels ever disappear, check the current labels in
   [actions/runner-images](https://github.com/actions/runner-images) - do not fall back to
   retired `macos-13` or paid `-large` labels blindly), `.deb`/`.rpm` uploaded with `.sha256`
   sidecars, `SHA256SUMS` complete, tap push and snap jobs behaving per their secrets.
2. `npx @libredb/studio@<version>` on a clean machine: download + checksum + first-run banner +
   login.
3. `brew tap libredb/tap && brew install libredb-studio && brew services start libredb-studio`.
4. Download the `.deb` on Debian/Ubuntu: `dpkg -i`, `systemctl start libredb-studio`, health 200
   on `127.0.0.1:3000`; verify the arm64 package on an arm64 machine (the CI smoke covers amd64
   only; the bundled node arch is statically asserted for both).

### Artifact provenance roadmap

Standalone tarballs and `.deb`/`.rpm` packages are checksum-verified against `SHA256SUMS` /
per-package `.sha256` sidecars (see [Release artifact naming](#release-artifact-naming)) — both
from the same GitHub release. The `.snap` release asset ships no sidecar (`--dangerous` installs
skip the Snap Store's own verification), and the npm package tarball is verified separately
through npm's own registry integrity metadata — a different trust domain than the GitHub release.
Signed provenance (Sigstore/cosign signatures or SLSA attestations) across every channel is
tracked as a follow-up issue.

### CI secrets that gate publishing

Optional-channel steps are skipped cleanly when their secret is absent, so forks and partial
setups still publish the rest:

| Secret | Gates | Without it |
|---|---|---|
| `TAP_GITHUB_TOKEN` | Rendering and pushing the Homebrew formula to `libredb/homebrew-tap` (needs write access to that repo) | Tap update skipped; tarballs still attach to the release |
| `SNAPCRAFT_STORE_CREDENTIALS` | The entire snap build/publish job (exported via `snapcraft export-login`) | Snap job skipped |
| `DOCKER_HUB_TOKEN` (+ `DOCKER_HUB_USERNAME` variable) | The Docker Hub mirror push | GHCR-only publish |

### Manual steps still open

- **Snap Store account**: the snap name `libredb-studio` must be registered in the Snap Store
  and `SNAPCRAFT_STORE_CREDENTIALS` configured before the snap channel goes live
  ([issue #113](https://github.com/libredb/libredb-studio/issues/113)).
- **Snap Store listing screenshots**: the description and icon ship with the snap
  (`snap/snapcraft.yaml`, `public/logo.svg`), but screenshots are a manual upload in the
  Snap Store web UI — part of the #113 store-listing acceptance criteria.
- **Website install docs**: the libredb-website documentation must be updated with the new
  channels (npx, Homebrew, .deb/.rpm, Snap) — a cross-repo step and part of issue #111's
  "README and website docs" acceptance criterion (and implicitly of #110/#112/#113).
- **Windows**: no standalone payload / installer yet; winget/Chocolatey and the `win32-x64`
  tarball are tracked in [issue #114](https://github.com/libredb/libredb-studio/issues/114).
- **Desktop app**: a native desktop wrapper (Tauri v2 sidecar; unlocks AppImage, Flathub, .dmg,
  Microsoft Store, brew cask) has a go recommendation —
  see [`docs/DESKTOP_WRAPPER_SPIKE.md`](DESKTOP_WRAPPER_SPIKE.md).

### Issue close-out notes

Deviations and partial deliveries to record on the tracking issues when closing them, so the
record matches the implementation:

- **#110 (npx)**: the "Works on Linux, macOS, and Windows" acceptance criterion is NOT delivered
  for Windows — the launcher exits on `win32` with a Docker pointer. Amend/re-scope that
  criterion to [#114](https://github.com/libredb/libredb-studio/issues/114) before closing.
- **#111 (Homebrew)**: the website half of "Install instructions added to README and website
  docs" is a cross-repo step (see Manual steps above).
- **#113 (Snap)**: store account/credentials and listing screenshots remain manual (see Manual
  steps above).
- **#115 (desktop wrapper spike)**: the written go/no-go recommendation is delivered
  ([`docs/DESKTOP_WRAPPER_SPIKE.md`](DESKTOP_WRAPPER_SPIKE.md)), but the hands-on spike scope
  (Tauri prototype, WebKitGTK/Monaco validation, unsigned PoC builds) was re-scoped into its
  Phase 1 — close as "recommendation delivered, hands-on spike open" and open the Phase 1
  follow-up issue.
- **#118 (Helm AUTH_BOOTSTRAP)**: the chart deliberately defaults to strict mode
  (`config.authBootstrap: "off"`), deviating from the issue's "default to the app default (on)"
  wording — generated credentials in centrally collected pod logs are undesirable. Note the
  deviation when closing.
