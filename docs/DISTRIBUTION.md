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
| Windows (winget / Chocolatey / portable zip) | Windows workstations | [Windows](#windows-winget--chocolatey--portable-zip) |

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
| .deb / .rpm (direct run) | `127.0.0.1` | `LIBREDB_BIND=0.0.0.0 libredb-studio` |
| Homebrew service | `127.0.0.1` | run the binary manually with `LIBREDB_BIND=0.0.0.0`, or front it with a reverse proxy |
| Snap | `127.0.0.1` | `sudo systemctl edit snap.libredb-studio.libredb-studio.service` with `[Service]` `Environment=HOSTNAME=0.0.0.0` |
| Docker / Helm | `0.0.0.0` (container-internal) | publish/route ports as usual (`-p`, Service/Ingress) |

For anything reachable from a network, prefer a reverse proxy with TLS in front and strict mode
(`AUTH_BOOTSTRAP=off`) with explicit credentials.

A direct run of the `.deb`/`.rpm` wrapper or the Homebrew binary ignores any inherited `HOSTNAME`
(empty, or - under Docker - the container ID Next.js would otherwise bind to) and defaults to
loopback; `LIBREDB_BIND` is the explicit opt-in for that case. Under systemd, `HOSTNAME` in
`/etc/libredb-studio/env` is still the override, since the unit resolves it before the wrapper
runs (detected via the systemd-set `INVOCATION_ID`, so the wrapper leaves it untouched there).

## Release artifact naming

Release tags carry **no `v` prefix** (tag `0.9.41` == package.json version). Each release ships:

| Artifact | Name | Targets |
|---|---|---|
| Standalone server tarball | `libredb-studio-standalone-<version>-<os>-<arch>.tar.gz` | `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` |
| Standalone server zip (Windows) | `libredb-studio-standalone-<version>-win32-x64.zip` | `win32-x64` (bundled Node runtime + `libredb-studio.exe` launcher) |
| Checksums | `SHA256SUMS` | covers all standalone tarballs and the win32 zip |
| Debian package | `libredb-studio_<version>_<arch>.deb` (+ `.sha256` sidecar) | `amd64`, `arm64` |
| RPM package | `libredb-studio-<version>.<arch>.rpm` (+ `.sha256` sidecar) | `x86_64`, `aarch64` |
| Snap | `libredb-studio_<version>_<arch>.snap` | `amd64`, `arm64` (also published to the Snap Store) |

`SHA256SUMS` covers the standalone tarballs and the win32 zip; each `.deb`/`.rpm` ships its own
per-file `<artifact>.sha256` sidecar instead (the packages are built in a separate job).

Standalone tarball entries are rooted under a top-level `libredb-studio-<version>/` directory
(not a tarbomb) - extract with `tar --strip-components=1` (`tar xzf <artifact>
--strip-components=1`), which is what the npx launcher, the deb/rpm/snap packaging jobs, and
`scripts/build-standalone-payload.sh`'s own `--smoke` self-test all do; Homebrew strips the single
top-level directory automatically for its main `url`/`sha256` download, so the formula needs no
extra flag.

The **win32 zip is deliberately FLAT** (entries at the archive root, no versioned wrapper
directory - `scripts/lib/pack-standalone-zip.sh`): winget resolves the manifest's
`NestedInstallerFiles.RelativeFilePath` against the zip root and `wingetcreate update` never
rewrites that path, so it must stay `libredb-studio.exe` across releases; Chocolatey likewise
unzips straight into its package tools directory. Windows Explorer's "Extract All" already
defaults to a folder named after the zip, so manual extraction stays tidy.

The payload contains only the runtime (`server.js`, `package.json`, `.next`, `node_modules`,
`public`, an empty `data/`, plus `LICENSE`/`README.md`): Next.js output file tracing sweeps the
repo root into `.next/standalone`, so payload assembly prunes the non-runtime extras (docs,
source, tooling configs, deploy manifests, local build leftovers) via a deny-list
([`scripts/lib/prune-standalone-payload.sh`](../scripts/lib/prune-standalone-payload.sh)).
The deny-list covers project-conventional paths only - on a local (non-CI) build, arbitrary
personal files sitting at the repo root can still be traced in, so keep secrets out of the
repo root (CI release checkouts are clean; published artifacts are unaffected).

Download URL pattern:
`https://github.com/libredb/libredb-studio/releases/download/<version>/<artifact>`.

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

**The chart defaults to zero-config bootstrap** (`config.authBootstrap: ""` — the variable is
omitted and the app default, on, applies): `helm install` works with no values; missing
`JWT_SECRET`/`ADMIN_PASSWORD` are generated on first start, printed once to the pod log, and
stored in `/app/data/auth-bootstrap.json` (an emptyDir when persistence is off, so pod
recreation regenerates them — set `persistence.enabled=true` or explicit secrets for stable
credentials). This keeps the chart deployable with default values, as certified catalogs such
as the Rancher partner-charts repository require. For production, inject real secrets as above,
or enforce them with strict mode (`--set config.authBootstrap=off`), which makes
`secrets.jwtSecret` and `secrets.adminPassword` required and fails the install fast when
either is missing — preferable when pod logs are collected centrally. `secrets.userPassword`
is optional in every mode (the non-admin account exists only when it is set).

Full values reference: [`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md);
chart architecture: [`docs/HELM_CHART.md`](HELM_CHART.md).

## npx

Requires Node.js 20.9+ on Linux, macOS (x64 / arm64), or Windows (x64); **Node 24 LTS is the
recommended, fully supported runtime**. The launcher checks the runtime up front and spells out what an
older Node cannot do (`scripts/engine-smoke.sh` tests every tier in CI):

| Node | Support |
|---|---|
| 24+ (recommended) | Everything works |
| 22.13 - 23.x | Works; server-side SQLite storage (`STORAGE_PROVIDER=sqlite`) needs Node 24 (the bundled better-sqlite3 binding targets the Node 24 ABI) and fails with a clear error. `node:sqlite` may print a one-time ExperimentalWarning. |
| 20.9 - 22.12 | Works, minus all SQLite features: SQLite database connections need the built-in `node:sqlite` (unflagged from Node 22.13). |
| < 20.9 | Refused with a clear error (Next.js 16 floor) - bare `npx` may also fall back to an ancient, bin-less package version here; those versions are npm-deprecated with pointers. |

The npm package stays a pure library for
libredb-platform; the launcher downloads the matching standalone archive (tar.gz; the flat zip
on Windows) from the GitHub release, verifies it against the `SHA256SUMS` release asset, caches
it under `~/.libredb-studio/<version>/`, and starts `node server.js`:

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
cached `SHA256SUMS` and re-extracts the payload. Re-extraction (`--verify-cache` and every
`--archive` run) preserves the payload's `data/` directory - generated `auth-bootstrap.json`
credentials and any `STORAGE_PROVIDER=sqlite` state survive across it, so a re-verify or a
rebuilt archive never invalidates a previously printed admin password.

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
- On Windows the launcher downloads the win32 zip and extracts it with the built-in
  `System32\tar.exe` (bsdtar); see [Windows](#windows-winget--chocolatey--portable-zip)
  ([issue #114](https://github.com/libredb/libredb-studio/issues/114)).
- Versions released before the standalone tarballs existed have no artifacts; the launcher
  detects this (HTTP 404) and suggests `npx @libredb/studio@latest`.

## Homebrew

The formula tracks the latest release (it is rendered and pushed to
[`libredb/homebrew-tap`](https://github.com/libredb/homebrew-tap) by release CI):

```bash
# One-time: Homebrew's untrusted-tap policy requires trusting third-party
# taps. `brew trust` needs Homebrew 6+ - if it prints "Unknown command",
# run `brew update` first (pre-6 Homebrew installs the tap without a trust
# step, but the command below would stop the chain).
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
  On Linux, `brew services` registers a per-user systemd unit (`~/.config/systemd/user`): it
  starts at login — not at boot — and stops when your last session ends unless lingering is
  enabled (`loginctl enable-linger $USER`).
- Running `libredb-studio` directly also defaults `STORAGE_SQLITE_PATH` to
  `$(brew --prefix)/var/libredb-studio/libredb-storage.db` — the same location `brew services`
  uses — unless you set it explicitly. This keeps the zero-config `auth-bootstrap.json` (and any
  `STORAGE_PROVIDER=sqlite` data) outside the versioned keg so it survives `brew upgrade`, and
  lets both run modes share one data dir.

### Configuration

All configuration is environment-driven. The formula does not ship an env file (unlike
`.deb`/`.rpm`).

**Foreground** (`libredb-studio`): export variables in your shell, or prefix the command.
Explicit values override [zero-config first run](#zero-config-first-run). Bind with
`LIBREDB_BIND` (the wrapper maps it to `HOSTNAME` — see [Network exposure](#network-exposure-bind-address)):

```bash
# AI, auth, OIDC, or Postgres storage — same variables as .env.example
export LLM_PROVIDER=openai LLM_API_KEY=sk-... LLM_MODEL=gpt-4o
# export NEXT_PUBLIC_AUTH_PROVIDER=oidc OIDC_ISSUER=... OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=...
# export STORAGE_PROVIDER=postgres STORAGE_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432/libredb
# LIBREDB_BIND=0.0.0.0 libredb-studio   # expose beyond loopback
libredb-studio
```

**`brew services`:** the service block only sets `STORAGE_PROVIDER=sqlite`,
`STORAGE_SQLITE_PATH`, and `HOSTNAME=127.0.0.1`. Homebrew has no supported way to inject
extra env into that plist (upgrades regenerate it). For LLM, OIDC, Postgres storage, strict
auth, or a non-loopback bind, run the binary in the foreground with the env above (or put a
reverse proxy in front of the loopback service).

Full variable reference: [`.env.example`](../.env.example). OIDC: [`docs/OIDC.md`](OIDC.md).
Storage: [`docs/STORAGE.md`](STORAGE.md).

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

Published on the [Snap Store](https://snapcraft.io/libredb-studio) for amd64 and arm64 (live
since 0.9.52; release CI publishes every release to the `stable` channel):

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

### Configuration

Unlike the `.deb`/`.rpm` packages (which ship `/etc/libredb-studio/env`), the snap has no
dedicated config file. Override environment variables with a systemd drop-in on the unit snapd
generates:

```bash
sudo systemctl edit snap.libredb-studio.libredb-studio.service
```

Add `[Service]` `Environment=` lines, then restart:

```bash
sudo systemctl restart snap.libredb-studio.libredb-studio.service
```

The drop-in is written to
`/etc/systemd/system/snap.libredb-studio.libredb-studio.service.d/override.conf`
(root-owned). Explicit values override the defaults baked into
[`snap/snapcraft.yaml`](../snap/snapcraft.yaml) and take precedence over
[zero-config first run](#zero-config-first-run) generation. Note that `systemctl edit`
creates the drop-in world-readable (mode 0644, like any systemd override), so after adding
secrets tighten it — systemd reads drop-ins as root, so this does not affect the service:

```bash
sudo chmod 600 /etc/systemd/system/snap.libredb-studio.libredb-studio.service.d/override.conf
```

Example drop-in (uncomment and fill what you need):

```ini
[Service]
# Bind (default is loopback — see Network exposure above)
#Environment=HOSTNAME=0.0.0.0

# Auth (optional; omit to keep zero-config bootstrap)
#Environment=AUTH_BOOTSTRAP=off
#Environment=JWT_SECRET=change-me-to-a-random-32-char-string
#Environment=ADMIN_EMAIL=admin@libredb.org
#Environment=ADMIN_PASSWORD=

# AI query assistance
#Environment=LLM_PROVIDER=gemini
#Environment=LLM_API_KEY=
#Environment=LLM_MODEL=gemini-2.5-flash
#Environment=LLM_API_URL=http://127.0.0.1:11434/v1

# OIDC (login page reads NEXT_PUBLIC_AUTH_PROVIDER at runtime)
#Environment=NEXT_PUBLIC_AUTH_PROVIDER=oidc
#Environment=OIDC_ISSUER=https://example.auth0.com
#Environment=OIDC_CLIENT_ID=
#Environment=OIDC_CLIENT_SECRET=

# Persisted storage (default: sqlite under $SNAP_DATA — leave unset to keep it)
#Environment=STORAGE_PROVIDER=postgres
#Environment=STORAGE_POSTGRES_URL=postgresql://user:pass@127.0.0.1:5432/libredb?sslmode=disable
```

**Storage:** by default the snap sets `STORAGE_PROVIDER=sqlite` and
`STORAGE_SQLITE_PATH=$SNAP_DATA/libredb-storage.db` — no further config is required. To switch
to server-side Postgres, uncomment the `STORAGE_PROVIDER` / `STORAGE_POSTGRES_URL` lines above
(TCP only; unix-socket Postgres on the host is not reachable under strict confinement).

Full variable reference: [`.env.example`](../.env.example). OIDC setup details:
[`docs/OIDC.md`](OIDC.md). Storage providers: [`docs/STORAGE.md`](STORAGE.md).

## Windows (winget / Chocolatey / portable zip)

The win32-x64 standalone zip is built and attached to every
[GitHub release](https://github.com/libredb/libredb-studio/releases) since 0.9.59. The
winget/Chocolatey CI automation is in place and secret-gated; the first winget listing
([microsoft/winget-pkgs#402985](https://github.com/microsoft/winget-pkgs/pull/402985)) and the
first Chocolatey push are in community review (see the
[first-listing checklist](#windows-first-listing-checklist) — track
[issue #114](https://github.com/libredb/libredb-studio/issues/114)).

```powershell
# winget (after the first listing merges in microsoft/winget-pkgs)
winget install LibreDB.Studio

# Chocolatey (after the first push clears community moderation)
choco install libredb-studio

# Then, from any terminal - first run prints the generated admin credentials
libredb-studio
```

Open http://127.0.0.1:3000 and log in with the printed credentials. Both packages install the
same standalone zip: the server payload, a bundled private Node.js runtime (`node\node.exe`),
and the `libredb-studio.exe` launcher — nothing else to install.

The launcher mirrors the Linux packages' contract:

- **Local-first bind (issue #134):** the server binds `127.0.0.1` regardless of any inherited
  `HOSTNAME`; set `LIBREDB_BIND=0.0.0.0` to expose it on the network.
- **State:** server-side SQLite storage and generated first-run credentials live under
  `%LOCALAPPDATA%\LibreDB\Studio\` (created on first run) unless `STORAGE_SQLITE_PATH` is set,
  so upgrades and reinstalls never wipe state.
- **Configuration:** environment variables only — the same set as Docker and the Linux packages
  (`PORT`, `LIBREDB_BIND`, `JWT_SECRET`, `ADMIN_PASSWORD`, `LLM_*`, `OIDC_*`, `STORAGE_*`, ...).
  See [Configuration](#configuration) above and [`.env.example`](../.env.example).

### Portable zip (no package manager)

Download `libredb-studio-standalone-<version>-win32-x64.zip` and `SHA256SUMS` from the
[release](https://github.com/libredb/libredb-studio/releases), verify, extract, run:

```powershell
# Verify (compare against the SHA256SUMS line for the zip)
Get-FileHash .\libredb-studio-standalone-<version>-win32-x64.zip -Algorithm SHA256

# Extract (Explorer "Extract All...", or - tar -C needs the directory to exist:)
mkdir libredb-studio
tar -xf .\libredb-studio-standalone-<version>-win32-x64.zip -C libredb-studio

# Run from the extracted directory
cd libredb-studio
.\libredb-studio.exe
```

The zip is flat by design (see [Release artifact naming](#release-artifact-naming)). `npx
@libredb/studio` also works on Windows (Node 20.9+): it downloads this zip, verifies it against
`SHA256SUMS`, and runs the payload with your own Node runtime.

## Building a standalone payload locally

The single source of truth for the release archives also works locally (Linux and macOS; on
Windows it runs under Git Bash and produces the flat zip — the release job then adds the
bundled Node runtime and launcher, see [`packaging/windows/README.md`](../packaging/windows/README.md)):

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
  the win32 zip + `SHA256SUMS`, `.deb`/`.rpm` (nfpm, [`packaging/linux/`](../packaging/linux)),
  the Homebrew formula ([`packaging/homebrew/`](../packaging/homebrew) rendered by
  [`scripts/render-homebrew-formula.mjs`](../scripts/render-homebrew-formula.mjs)), the snap
  ([`snap/snapcraft.yaml`](../snap/snapcraft.yaml)), and — after the release publishes — the
  Chocolatey push and winget update PR ([`packaging/chocolatey/`](../packaging/chocolatey) and
  [`packaging/winget/`](../packaging/winget) rendered by
  [`scripts/render-windows-packaging.mjs`](../scripts/render-windows-packaging.mjs)).
- The npm package (`@libredb/studio`, which carries the npx launcher `bin/studio.js`) is
  published by the separate npm-publish workflow, also on `release: published`.

### Embedded-sample channel E2E

Every zero-config channel must prove — in a real browser — that a fresh install
serves the embedded sample connections ("Sample (LibreDB)", "Sample
(Employees)"). One `bun run test:e2e` is not enough: each channel boots the
payload through a different launcher, cwd, and `STORAGE_SQLITE_PATH`, so a
packaging bug (a payload missing `seed-assets/`, a dropped fileset entry)
surfaces only in the affected channel.

The shared spec is [`e2e/embedded-samples.spec.ts`](../e2e/embedded-samples.spec.ts);
[`playwright.channel.config.ts`](../playwright.channel.config.ts) runs it against an
externally booted server (`CHANNEL_E2E_BASE_URL`, no `webServer`). The orchestrator
boots one channel, waits for health (and best-effort for the async seed), runs
Playwright, and tears down:

```bash
scripts/channel-embedded-sample-e2e.sh <channel> [artifact]
scripts/channel-embedded-sample-e2e.sh all            # every channel feasible here

# channels: tarball | npx | docker | deb | rpm | snap | homebrew
scripts/channel-embedded-sample-e2e.sh tarball dist/libredb-studio-standalone-*.tar.gz
scripts/channel-embedded-sample-e2e.sh docker ghcr.io/libredb/libredb-studio:main
```

`all` skips infeasible channels (no docker daemon, no passwordless sudo, not
macOS, missing artifact) and prints a summary. Where each channel runs in CI:

| Channel | CI gate |
|---------|---------|
| next-dev | `ci.yml` e2e job (regular Playwright run includes the spec) |
| tarball, npx | `ci.yml` channel-e2e job (payload artifact) |
| docker | `docker-build-push.yml` channel-e2e job (pushed image; gates the Helm release dispatch) |
| deb, rpm | `release-artifacts.yml` linux-packages job (amd64; alongside the zero-config smoke) |
| snap | `release-artifacts.yml` snap job (amd64; runs before the store publish) |
| homebrew | not in CI (linux runners) — run locally on macOS |

### First-release validation runbook

All channels have now had their first live run (the Snap publish completed its first with
0.9.52, validated per this runbook). Right after publishing a release:

1. Watch the `release-artifacts` run: all four tarball legs green (if the `macos-15-intel` or
   `macos-14` runner labels ever disappear, check the current labels in
   [actions/runner-images](https://github.com/actions/runner-images) - do not fall back to
   retired `macos-13` or paid `-large` labels blindly), `.deb`/`.rpm` uploaded with `.sha256`
   sidecars, `SHA256SUMS` complete, tap push and snap jobs behaving per their secrets.
2. `npx @libredb/studio@<version>` on a clean machine: download + checksum + first-run banner +
   login. The `npx Engine Smoke` workflow (`npx-engine-smoke.yml`) runs automatically after a
   successful NPM Publish: it waits for the registry to serve the released version, then runs
   **bare** `npx @libredb/studio` on Node 20.9/22/24 and asserts each tier resolves exactly that
   release (the #130 regression class - npm's picker avoids engine-incompatible versions for
   bare specs). Check that it went green; dispatch it manually to re-run.
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
| `CHOCO_API_KEY` | The chocolatey job: `choco pack` + `choco push` to `https://push.chocolatey.org/` (API key of the `libredb` community account) | Chocolatey publish skipped; the win32 zip still attaches to the release |
| `WINGETCREATE_GITHUB_TOKEN` | The winget job: `wingetcreate update --submit` PRs to `microsoft/winget-pkgs`. Classic PAT with `public_repo` scope — wingetcreate does not support fine-grained PATs | winget submission skipped |

The chocolatey and winget jobs run strictly **after** `publish-release`: both channels download
the zip from the release URL, which is public only once the release is published. A failure
there never blocks the release itself (same trust model as the npm/Docker dispatch chain).

By contrast, the `windows-package` job (which builds the win32 zip) **is a hard release gate**,
exactly like the POSIX build matrix: the zip is on the publish-release required-assets list, so
a Windows build failure blocks the whole release train by design — a release without its
Windows artifact would strand winget/Chocolatey (their manifests point at that exact asset) and
npx on win32.

### Windows first-listing checklist

The win32 zip has shipped in every release since **0.9.59**. The release automation for winget
and Chocolatey is secret-gated and ready — both `CHOCO_API_KEY` (API key of the `libredb`
account on community.chocolatey.org) and `WINGETCREATE_GITHUB_TOKEN` are configured in the
repo's Actions secrets. The FIRST listing in each community catalog is a one-time human step
(same pattern as the Snap Store name registration). Both first submissions were made with
0.9.59 — the Chocolatey push is in moderation and the winget listing is
[microsoft/winget-pkgs#402985](https://github.com/microsoft/winget-pkgs/pull/402985); step 3
below remains once each goes live:

1. **Chocolatey** — the release's chocolatey job packs and pushes automatically. The first push
   enters [human moderation](https://docs.chocolatey.org/en-us/community-repository/moderation/);
   while a version sits in the moderation queue, pushing further versions can be rejected —
   if a release-time push fails during that window, re-run the job after approval.
2. **winget** — the first manifest cannot be submitted by `wingetcreate update` (the package id
   does not exist yet; the release job detects this and skips with a notice). Render the
   manifests locally from the release's `SHA256SUMS` and submit once by hand:

   ```bash
   gh release download <version> --pattern SHA256SUMS --dir dist
   for t in packaging/winget/*.tmpl; do
     out="manifests/l/LibreDB/Studio/<version>/$(basename "${t%.tmpl}")"
     node scripts/render-windows-packaging.mjs "$t" dist/SHA256SUMS <version> "$out"
   done
   wingetcreate submit --token <classic-PAT> manifests/l/LibreDB/Studio/<version>
   ```

   (or open the PR against [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
   manually; sign the Microsoft CLA on that first PR). Once it merges, later releases submit
   update PRs automatically.
3. After each catalog goes live: flip its `distribution/channels.yaml` entry to `status: live`,
   set `links.first_pr`, and add a measurable pin (winget-pkgs raw manifest / Chocolatey
   community API).

### Channel inventory and drift check

[`distribution/channels.yaml`](../distribution/channels.yaml) is the machine-readable inventory
of every distribution channel: identity, update policy, provenance links, and (where measurable)
where its pinned version lives. `bun run distribution:check`
([`scripts/distribution-check.mjs`](../scripts/distribution-check.mjs)) compares every live
channel's pin against `package.json` and prints a markdown drift table; the weekly
[`distribution-check.yml`](../.github/workflows/distribution-check.yml) workflow writes the same
table to its Job Summary (cron + manual dispatch — deliberately not `release: published`, which
GITHUB_TOKEN-published releases never fire). The checker only **reads** the inventory; bumping a
pin or editing a channel entry is always a human commit.

**Tiers** describe who controls publication:

| Tier | Meaning | Examples |
|---|---|---|
| 0 | Core registries, published directly by release CI | GitHub Releases, GHCR, Docker Hub, npm |
| 1 | Packaged formats owned by this repo, CI-published | Helm, Homebrew tap, Snap, .deb/.rpm |
| 2 | LibreDB-owned copies and listings, bumped by hand | CapRover source/mirror, Railway, Koyeb button, Fly.io config |
| 3 | Upstream community catalogs, bumped via PR | CapRover official, Dokploy, Cosmos, Kubero |
| 4 | Partner or curated catalogs (not self-serve) | Rancher partner charts, Koyeb catalog, DO, winget |

**SLAs** (`update.sla`) state how quickly a channel is expected to follow a release:
`every_release` (bumped as part of releasing), `minor_plus` (bumped for minor releases and
above), `major_only`, `on_demand` (bumped when someone gets to it — the honest default for PaaS
catalog templates).

**Pin strategies:** `local_file` (version lives in files in this repo), `remote_file` (fetched
from an upstream raw URL, best-effort — fetch failures degrade to UNKNOWN and never fail the
run), `none` (nothing to measure, stated explicitly with a `note`). Measurable pins carry an
`extract` regex with exactly one capture group; when a source yields multiple *different*
matches the channel is reported instead of silently using the first hit.

**Strict mode:** `bun run distribution:check --strict` exits non-zero only for `local_file`
channels with `sla: every_release` that are drifted or unmeasurable. Remote catalogs and
`on_demand` templates never gate, so strict is enableable today without first paying off
historical PaaS drift. For the Helm chart the enforcement remains the required `chart:check` CI
gate (#138) — the matrix row is visibility, not a second gate. `--json` emits the rows for
scripting.

**Adding a channel** = one new entry in `channels.yaml` (copy a neighbour of the same tier; the
schema is validated on every run). Set `links.first_pr` to the PR that landed the listing, and
update `links.last_bump_pr` whenever a version-bump PR for that channel merges — it is `null`
until the first post-listing bump and is displayed, not auto-discovered.

### Manual steps still open

- **Snap Store listing screenshots**: the description and icon ship with the snap
  (`snap/snapcraft.yaml`, `public/logo.svg`), but screenshots are a manual upload in the
  Snap Store web UI (https://snapcraft.io/libredb-studio/listing). The snap name is registered
  and `SNAPCRAFT_STORE_CREDENTIALS` is configured — the channel went live with 0.9.52.
- **Website install docs**: the libredb-website documentation must be updated with the new
  channels (npx, Homebrew, .deb/.rpm, Snap) — a cross-repo step and part of issue #111's
  "README and website docs" acceptance criterion (and implicitly of #110/#112/#113).
- **Windows first listings**: the `win32-x64` zip, launcher, winget/Chocolatey release
  automation, and both gating secrets are in place; the one-time first submissions to both
  community catalogs follow the
  [Windows first-listing checklist](#windows-first-listing-checklist) —
  tracked in [issue #114](https://github.com/libredb/libredb-studio/issues/114).
- **Desktop app**: a native desktop wrapper (Tauri v2 sidecar; unlocks AppImage, Flathub, .dmg,
  Microsoft Store, brew cask) has a go recommendation —
  see [`docs/DESKTOP_WRAPPER_SPIKE.md`](DESKTOP_WRAPPER_SPIKE.md).

### Issue close-out notes

Deviations and partial deliveries to record on the tracking issues when closing them, so the
record matches the implementation:

- **#110 (npx)**: the "Works on Linux, macOS, and Windows" acceptance criterion was initially
  NOT delivered for Windows (the launcher exited on `win32` with a Docker pointer); the win32
  path shipped with [#114](https://github.com/libredb/libredb-studio/issues/114) — the npx
  launcher now downloads the win32 zip and runs it with the user's Node runtime.
- **#111 (Homebrew)**: the website half of "Install instructions added to README and website
  docs" is a cross-repo step (see Manual steps above).
- **#113 (Snap)**: closed after the 0.9.52 live validation (store publish from release CI,
  amd64+arm64 on `stable`). Listing screenshots remain a store-side manual upload (see Manual
  steps above); version-bump auto-refresh is observable at the next release.
- **#115 (desktop wrapper spike)**: the written go/no-go recommendation is delivered
  ([`docs/DESKTOP_WRAPPER_SPIKE.md`](DESKTOP_WRAPPER_SPIKE.md)), but the hands-on spike scope
  (Tauri prototype, WebKitGTK/Monaco validation, unsigned PoC builds) was re-scoped into its
  Phase 1 — close as "recommendation delivered, hands-on spike open" and open the Phase 1
  follow-up issue.
- **#118 (Helm AUTH_BOOTSTRAP)**: the chart originally defaulted to strict mode
  (`config.authBootstrap: "off"`), deviating from the issue's "default to the app default (on)"
  wording — generated credentials in centrally collected pod logs are undesirable. This was
  later reversed for the Rancher partner-charts certification, whose repository requires charts
  to be deployable with default values: the chart now defaults to `""` (zero-config bootstrap),
  and strict mode remains available via `config.authBootstrap=off`.
