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
| Desktop app (AppImage, .deb, FlatPark) | Linux desktops - an application window, no browser tab | [Desktop app](#desktop-app-appimage-debian-package-flatpark) |
| Unraid | An Unraid server - one click from the Apps tab | [Unraid](#unraid-community-applications) |
| Sealos | One-click managed Kubernetes, nothing to install locally | [Sealos](#sealos-app-store) |

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

Every channel works with no configuration, except the two catalog templates that collect
credentials in their own install form (see the last bullet). When `JWT_SECRET` / `ADMIN_PASSWORD` are not set
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
- **The two catalog templates are the exception**, because their install form asks for the
  credentials up front: the [Unraid](#unraid-community-applications) template requires
  `ADMIN_PASSWORD` and `JWT_SECRET`, and the [Sealos](#sealos-app-store) template collects an admin
  password and sets `AUTH_BOOTSTRAP=off`. Both therefore start with credentials you chose, print no
  generated-password banner, and write no `auth-bootstrap.json`. Zero-config describes what the
  server does when a channel leaves those variables unset.

**Strict mode:** set `AUTH_BOOTSTRAP=off` to disable generation and require explicit
`JWT_SECRET` and `ADMIN_PASSWORD` (recommended for production; missing values then surface as a
clear error on the login page instead of silently generated credentials in collected logs). Every
channel that starts the server itself, the Helm chart included, defaults to zero-config and takes
strict mode as an opt-in; the [Sealos](#sealos-app-store) template is the one channel that ships
with it already on. Unrecognized `AUTH_BOOTSTRAP` values log a warning and keep bootstrap on.

## Network exposure (bind address)

Every native channel is **local-first**: the server binds to `127.0.0.1` by default, and
exposing it on the network is an explicit opt-in. (The Docker image and the Helm chart are the
exception - a container binds all of its own addresses, `0.0.0.0` by default, and is isolated by
container networking instead.) `HOSTNAME` is the bind address wherever the server is started
directly - Docker, Helm, npx, the systemd units and Snap; the `.deb`/`.rpm` and Homebrew wrappers
and the Windows launcher take `LIBREDB_BIND` instead and discard an inherited `HOSTNAME`. The note
below the table covers the address family either one selects.

| Channel | Default bind | How to expose |
|---|---|---|
| npx | `127.0.0.1` | `npx @libredb/studio --host 0.0.0.0` (or set `HOSTNAME`) |
| .deb / .rpm (systemd) | `127.0.0.1` | `HOSTNAME=0.0.0.0` in `/etc/libredb-studio/env`, then restart |
| .deb / .rpm (direct run) | `127.0.0.1` | `LIBREDB_BIND=0.0.0.0 libredb-studio` |
| Homebrew service | `127.0.0.1` | run the binary manually with `LIBREDB_BIND=0.0.0.0`, or front it with a reverse proxy |
| Snap | `127.0.0.1` | `sudo systemctl edit snap.libredb-studio.libredb-studio.service` with `[Service]` `Environment=HOSTNAME=0.0.0.0` |
| Docker / Helm | `0.0.0.0` (container-internal, IPv4 only) | publish/route ports as usual (`-p`, Service/Ingress); `HOSTNAME=::` to also listen on IPv6 |

For anything reachable from a network, prefer a reverse proxy with TLS in front and strict mode
(`AUTH_BOOTSTRAP=off`) with explicit credentials.

A direct run of the `.deb`/`.rpm` wrapper or the Homebrew binary ignores any inherited `HOSTNAME`
(empty, or - under Docker - the container ID Next.js would otherwise bind to) and defaults to
loopback; `LIBREDB_BIND` is the explicit opt-in for that case. Under systemd, `HOSTNAME` in
`/etc/libredb-studio/env` is still the override, since the unit resolves it before the wrapper
runs (detected via the systemd-set `INVOCATION_ID`, so the wrapper leaves it untouched there). The
Windows launcher rebuilds `HOSTNAME` from `LIBREDB_BIND` on every run, with no systemd exception.

**Address family (IPv4, IPv6, dual-stack).** The bind address accepts an IPv6 literal in every
channel, because whichever variable that channel reads ends up as the host argument of a plain
`server.listen(port, hostname)` in the standalone Next.js server
(`next/dist/server/lib/start-server.js`) - so it is Node, not Next, that gives `::` its meaning.
(Next touches `[::]` only to format the URL it prints at startup.) Use `HOSTNAME` where the server is started directly
(Docker, Helm, npx, the systemd units, Snap) and `LIBREDB_BIND` in the wrapper channels (a direct
`.deb`/`.rpm` run, Homebrew, the Windows launcher), per the paragraph above. The values that
matter:

| `HOSTNAME` | `LIBREDB_BIND` | Listens on |
|---|---|---|
| `0.0.0.0` | `0.0.0.0` | all IPv4 addresses (the Docker image and chart ConfigMap default) |
| `::` | `::` | all IPv6 addresses - and, on Linux with the default `net.ipv6.bindv6only=0`, all IPv4 addresses through the same socket, so one listener serves both families |
| `127.0.0.1` | `127.0.0.1` | IPv4 loopback (the native-channel default) |
| `::1` | `::1` | IPv6 loopback - the IPv6 equivalent of that local-first default |

The dual-stack behaviour of `::` is conditional: where `net.ipv6.bindv6only=1` is in force, `::`
is **IPv6 only** and IPv4 clients are dropped. Read that sysctl in the right namespace - it is
network-namespace scoped, not a host-wide property, and a fresh namespace initializes to `0`. A
Docker container or a Kubernetes pod therefore gets `0` whatever the node reads, unless the
namespace is overridden explicitly (`docker run --sysctl net.ipv6.bindv6only=1`, a pod
`securityContext.sysctls` entry) or it shares the host's namespace (`docker run --network host`,
`hostNetwork: true`). Checking the node and finding `1` does not mean `-e HOSTNAME=::` will drop
IPv4 in your container.

That residual case is why the container image default stays `0.0.0.0` rather than `::`: a default
has to hold for host-network and sysctl-overridden deployments too, where flipping it would
silently remove IPv4 for existing users. Opting in per deployment is safe because you know your own
namespace.

```bash
docker run -p 3000:3000 -e HOSTNAME=:: ghcr.io/libredb/libredb-studio:latest
```

For Helm, `extraEnv` renders into the container's `env:` list, which overrides the same key
delivered by the chart ConfigMap through `envFrom`:

```yaml
extraEnv:
  - name: HOSTNAME
    value: "::"
```

> **A dual-stack Service is not enough on its own.** The chart's `service.ipFamilyPolicy` /
> `service.ipFamilies` values give the Service an IPv6 address, but Kubernetes never checks what
> address the container actually bound: the IPv6 EndpointSlice is populated from the pod's IPv6
> address regardless, and traffic to it hits a pod with no IPv6 listener, which answers `connection
> refused`. The kubelet probes the pod's *primary* IP (IPv4 on a typical cluster), so the pod still
> reports Ready and nothing self-heals. **Set both**: the dual-stack Service values *and*
> `extraEnv` `HOSTNAME: "::"`. See the chart
> [README](../charts/libredb-studio/README.md#ipv6-and-dual-stack).

The native channels are unaffected by all of this: they stay on `127.0.0.1` by default and treat
any exposure, IPv4 or IPv6, as an explicit opt-in - `LIBREDB_BIND=::` (or `LIBREDB_BIND=::1` for
IPv6 loopback) is that opt-in for the wrapper channels, `HOSTNAME` for the rest.

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
| Desktop AppImage | `libredb-studio-desktop-<version>-linux-<arch>.AppImage` (+ `.sha256` sidecar) | `x64`, `arm64` (also the artifact the in-repo Flatpak manifest repacks) |
| Desktop Debian package | `libredb-studio-desktop_<version>_<arch>.deb` (+ `.sha256` sidecar) | `amd64`, `arm64` (from 0.9.62; the artifact FlatPark pins as extra-data) |

`SHA256SUMS` covers the standalone tarballs and the win32 zip; each `.deb`/`.rpm`/`.AppImage`
ships its own per-file `<artifact>.sha256` sidecar instead (those are built in separate jobs).

**Two different `.deb`s ship per release and they are not interchangeable.**
`libredb-studio_<version>_<arch>.deb` is the headless server: it installs a systemd unit and is
built by nfpm from `packaging/linux/nfpm.yaml`. `libredb-studio-desktop_<version>_<arch>.deb` is the
GUI app: a desktop entry, the Tauri shell, the pinned Node sidecar and the server payload, built by
the Tauri bundler in the same job as the AppImage. Different file names and different dpkg package
names (`libredb-studio` vs `libredb-studio-desktop`), so both can be installed on one machine.

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
docker run --name libredb-studio -p 3000:3000 \
  -v libredb-data:/app/data \
  ghcr.io/libredb/libredb-studio:latest

docker logs libredb-studio   # shows the first-run credentials banner
```

The `/app/data` volume persists the generated credentials and the server-side SQLite storage;
without it, a recreated container generates new credentials.

Production (strict mode, explicit secrets):

```bash
docker run --name libredb-studio -p 3000:3000 \
  -e AUTH_BOOTSTRAP=off \
  -e JWT_SECRET=change-me-to-a-random-32-char-string \
  -e ADMIN_EMAIL=admin@libredb.org \
  -e ADMIN_PASSWORD=your_secure_admin_password \
  ghcr.io/libredb/libredb-studio:latest
```

All environment variables are documented in [`.env.example`](../.env.example); a ready-to-use
compose file is [`docker-compose.example.yml`](../docker-compose.example.yml). The container
listens on IPv4 only unless you add `-e HOSTNAME=::` - see
[Network exposure](#network-exposure-bind-address).

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

**Architectures:** every tag published from `main`, a release or a manual dispatch is a
`linux/amd64` + `linux/arm64` manifest. Branch previews (`dev` and the `sha-` tag of a
`feat/**` / `fix/**` push) are `linux/amd64` only — the build job has no native arm64 runner, so
arm64 goes through QEMU and dominates the job's runtime; spending that on every commit of an open
PR buys nothing, since the only consumer of `dev` is the amd64 Channel E2E gate. Pull `main` (or a
released version) when you need arm64 from an unreleased line.

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

**The chart defaults to zero-config bootstrap** like every other channel (`config.authBootstrap: ""`
omits the variable, so the app default applies): `helm install` works with no values at all. For
production, inject real secrets as above, or enforce them with strict mode
(`--set config.authBootstrap=off`).

The chart's own [`README.md`](../charts/libredb-studio/README.md#auth-bootstrap-zero-config-vs-strict)
is the canonical description of that behaviour — credential retrieval, what strict mode requires per
auth provider, persistence and the single-replica constraint. Full values reference:
[`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md); chart architecture:
[`docs/HELM_CHART.md`](HELM_CHART.md).

On a dual-stack cluster, set `service.ipFamilyPolicy` (and optionally `service.ipFamilies`) **and**
`extraEnv` `HOSTNAME: "::"` together - a dual-stack Service in front of an IPv4-only listener
advertises an IPv6 address that refuses every connection. See
[Network exposure](#network-exposure-bind-address).

## OpenShift operator (OperatorHub)

`operator/` packages the published Helm chart as a codeless helm-operator
(operator-sdk helm plugin): a `LibreDBStudio` custom resource whose spec mirrors
the chart values. Publishing works in two stages:

- **Controller image** — `.github/workflows/operator-release.yml` builds and
  pushes `ghcr.io/libredb/libredb-studio-operator:<version>` (amd64+arm64) on
  every app release. Chart releases (`libredb-studio-x.y.z` tags) are skipped
  quietly. The embedded chart's declared dependencies are vendored with
  `helm dependency build` right before the image build; `charts/*.tgz` is
  never committed.
- **Catalog bundle** — `operator/bundle/` (generated by `make -C operator
  bundle`, which stamps the versioned `containerImage` CSV annotation and
  validates with `--select-optional suite=operatorframework` — the same suite
  the community pipelines run; no validator flags a missing `containerImage`,
  so the stamp is enforced by the Makefile, not by validation) is the
  submission source for both community catalogs:
  k8s-operatorhub/community-operators (operatorhub.io, plain bundle-directory
  PR) and redhat-openshift-ecosystem/community-operators-prod (OpenShift
  console). The community-operators-prod submission uses the FBC contribution
  mode (`fbc.enabled: true` plus a per-OCP-version `catalog_mapping` in the
  submission's `ci.yaml`): bundle-directory PRs without FBC are still
  accepted, but FBC is the pipeline's recommended mode and automates
  promotion into each new OpenShift version's catalog
  (`version_promotion_strategy`, default `review-needed`). Channel
  `operatorhub-community` in `distribution/channels.yaml` tracks it
  (`status: pending` until the first listing merges; tracking issue #152).

Two copies are kept honest by CI: the embedded chart copy
(`operator/helm-charts/`) is enforced by the required `chart:check` gate
(`chart:bump` refreshes it), and bundle freshness (`operator/config` vs the
generated `operator/bundle`) is checked in the Helm Chart Lint job whenever a
PR touches `operator/`. The operator Makefile derives `VERSION` from
`package.json`, so there is no fourth hand-maintained version string.

### An FBC release is two upstream PRs

A community-operators-prod release in FBC mode always takes two merges, and
only the first one is triggered by the bundle:

1. **Bundle PR** — `operators/libredb-studio-operator/<version>/` (a copy of
   `operator/bundle`) plus `ci.yaml`, `Makefile` and `catalog-templates/`.
   Merging it runs the release pipeline, which publishes
   `quay.io/community-operator-pipeline-prod/libredb-studio-operator:<version>`.
   The operator is released at this point but is in **no** catalog yet, so
   nothing is installable from the OpenShift console.
2. **Catalog PR** — the rendered
   `catalogs/v4.15..v4.22/libredb-studio-operator/catalog.yaml` files, one per
   OCP version in the `catalog_mapping`. Render them from a fork's checkout:

   ```bash
   cd operators/libredb-studio-operator
   make catalogs           # opm alpha render-template, driven by ci.yaml
   make validate-catalogs  # opm validate; must pass for every mapped version
   ```

   The renderer applies `--migrate-level bundle-object-to-csv-metadata` only
   for v4.17+, which is why the pre-4.17 catalogs keep the base64
   `olm.bundle.object` form and the newer ones do not.

`rh-operator-bundle-bot` opens that second PR by itself (updating both the
template and the rendered catalogs) **only when the bundle version directory
carries a `release-config.yaml`**; otherwise the release pipeline just prints
the manual instructions in its summary comment. 0.9.59 shipped without one, so
its catalog PR
([community-operators-prod#10581](https://github.com/redhat-openshift-ecosystem/community-operators-prod/pull/10581))
was rendered and opened by hand. From 0.9.60 on, include this file in the
bundle PR as `operators/libredb-studio-operator/<version>/release-config.yaml`:

```yaml
---
catalog_templates:
  - template_name: basic.yaml
    channels: [alpha]
    replaces: libredb-studio-operator.v<previous version>
```

`replaces` wires the new bundle into the update graph and is omitted only for
a first submission. `version_promotion_strategy` in `ci.yaml` is a separate
knob (promotion into each *newly added* OpenShift version's catalog) and does
not substitute for `release-config.yaml`. The operatorhub.io submission
(k8s-operatorhub/community-operators) has no such second step: its
bundle-directory PR is the whole listing.

## npx

Requires Node.js 24+ on Linux, macOS (x64 / arm64), or Windows (x64); **Node 24 LTS is the
reference runtime** - it is what the release payload is built on. The launcher checks the runtime up
front and spells out what another Node cannot do (`scripts/engine-smoke.sh` tests every supported
tier in CI):

| Node | Support |
|---|---|
| 24 LTS (recommended) | Everything works |
| 25, 26+ | Everything works. The payload is built on Node 24, but its only native module (better-sqlite3) has shipped N-API prebuilds since v13, so one binary is valid across Node majors - `STORAGE_PROVIDER=sqlite` included. The `node26` leg of `scripts/engine-smoke.sh` asserts exactly this by running a Node-24-built payload on Node 26. |
| < 24 | Below the `engines.node` floor. See the note below - these users are not refused, they are pinned. |

> **Below the floor, npm pins rather than refuses.** `engines.node` does not produce an error for a
> bare spec: npm's version picker silently resolves the newest *engine-compatible* release instead,
> so a Node 20/22 user running `npx @libredb/studio` lands on the last release that still allowed
> their runtime - with no notice that a newer Studio exists. That pin is only acceptable while it
> lands on a runnable release, which the `pinned` legs of `npx-engine-smoke.yml` assert against the
> live registry (issue #130 was this mechanism dropping users onto an ancient, bin-less version).
> To make the pin visible, the release runbook `npm deprecate`s the last pre-floor version with a
> pointer to the Node 24 requirement - a deprecation notice is the one message npm *does* print on
> install. A user who pins the new version explicitly (`npx @libredb/studio@<version>`) gets the
> launcher's own preflight refusal naming the required runtime.

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
- The npm package is published with **npm provenance** (`npm publish --provenance` in
  `npm-publish.yml`, from 0.9.63). npmjs stores a Sigstore attestation naming the repo, workflow
  and commit that built the tarball, so `npm audit signatures` verifies the package against a
  trust root outside the release:

  ```bash
  npm i @libredb/studio && npm audit signatures   # "verified registry signatures / attestations"
  ```

  This covers the package you install from npm. The standalone archive the launcher downloads
  from the GitHub release carries its own SLSA attestation, and from 0.9.63 the launcher checks
  it - see below.

### Launcher provenance check

After the checksum passes, the launcher runs `gh attestation verify` on the archive, pinned to the
workflow that signs releases (`--signer-workflow …/release-artifacts.yml`, so an attestation from
any other workflow or a branch build fails the policy). It runs where checksum verification runs:
on a fresh download and on `--verify-cache`, never on a plain cache hit, and never for `--archive`
(a local build was never claimed to come from a release).

The policy is tri-state, and the distinction is deliberate:

| Outcome | Launcher |
|---|---|
| Verified | prints `Provenance verified …` and starts |
| Cannot verify - no `gh`, not authenticated (`gh auth login`), no network, API rate limit, or a release older than 0.9.63 | prints a warning naming the reason and starts on checksum alone |
| Rejected - the attestation fails the signer policy, or a release from 0.9.63 on has **no** attestation for the archive's digest | refuses to start (exit 1) |

The last row is the case the whole feature exists for. An attacker who can replace a release asset
can replace its `SHA256SUMS` line too, so the checksum still matches - but they cannot forge an
attestation. For a release that must have one, "GitHub holds no attestation for this digest" is the
tampering signal itself, not missing information.

`gh` stays optional: the package's contract is zero runtime dependencies, so everything that merely
*prevents* verification warns and continues. To start anyway after a rejection (accepting the risk,
e.g. during a GitHub attestation outage): `LIBREDB_STUDIO_SKIP_PROVENANCE=1`.

Verify by hand at any time:

```bash
gh attestation verify ~/.libredb-studio/<version>/libredb-studio-standalone-<version>-<os>-<arch>.tar.gz \
  --repo libredb/libredb-studio \
  --signer-workflow libredb/libredb-studio/.github/workflows/release-artifacts.yml
```

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

- The formula depends on Homebrew's `node@24` — the reference runtime the payload is built and
  smoke-tested on — and installs the standalone payload into the keg's `libexec`;
  `libredb-studio` on your PATH runs it. The pin used to be a hard requirement, because the
  bundled better-sqlite3 binding was compiled per Node ABI and a newer major could not load it.
  Since better-sqlite3 13 that is no longer true (N-API prebuilds, see the [npx](#npx) support
  table), so the pin is now conservatism rather than necessity: it keeps Homebrew users on the
  major CI actually exercises instead of whichever one the floating `node` formula points at.
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
[GitHub release](https://github.com/libredb/libredb-studio/releases) since 0.9.59.
**winget is live**: the first listing
([microsoft/winget-pkgs#402985](https://github.com/microsoft/winget-pkgs/pull/402985)) merged on
2026-07-31, so `winget install LibreDB.Studio` resolves from the community repository and every
release now submits its update PR automatically. The first Chocolatey push is still in community
moderation (see the [first-listing checklist](#windows-first-listing-checklist) — track
[issue #114](https://github.com/libredb/libredb-studio/issues/114)).

> **Chocolatey stays switched off in the inventory until its moderation clears**
> (`update.ci_enabled: false` in [`distribution/channels.yaml`](../distribution/channels.yaml) —
> see [Turning a channel's automation off](#turning-a-channels-automation-off)). Chocolatey is the
> reason the switch exists: `push.chocolatey.org` answers `403 Forbidden` for *every* version
> while an account's first submission is unapproved, which failed the 0.9.60 and 0.9.61 release
> runs even though both releases published correctly. **To re-enable:** set `ci_enabled: true` and
> flip `status` to `live` in the same edit — exactly what winget got once its listing merged. The
> next release publishes the channel; do not re-dispatch `release-artifacts` for an
> already-published version to backfill the feed, because its asset steps would fight the
> immutable release — push a back version by hand (the same choco container the job uses for
> Chocolatey; the [manual manifest recipe](#windows-first-listing-checklist) for winget).

```powershell
# winget
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
@libredb/studio` also works on Windows (Node 24+): it downloads this zip, verifies it against
`SHA256SUMS`, and runs the payload with your own Node runtime.

## Desktop app (AppImage, Debian package, FlatPark)

Every other channel on this page ships LibreDB Studio as a server you open in a browser. The
desktop build ships it as an application window: a Tauri v2 shell starts the same standalone
server as a local sidecar on a random loopback port, waits for it to become healthy, signs you in
and shows the workspace. There is no browser tab, no port to remember and no password prompt for
your own machine. Details of the shell itself are in
[`desktop/README.md`](../desktop/README.md) (issue
[#232](https://github.com/libredb/libredb-studio/issues/232)).

State lives in the per-user data directory - `~/.local/share/org.libredb.Studio` for the
AppImage, `~/.var/app/org.libredb.Studio/data/org.libredb.Studio` under Flatpak - and holds the
SQLite storage database plus the generated admin credentials (`auth-bootstrap.json`, mode 0600).
Deleting that directory resets the app.

The session cookie is not marked `Secure` when a request arrives on a loopback host over plain
http, which is what makes the desktop session work: the cookie store behind WebKitGTK discards
a `Secure` cookie delivered over http instead of ignoring the flag the way Chromium does on
localhost. Nothing changes for any other deployment - a request on a public host, or one a
proxy forwarded with `x-forwarded-proto: https`, still gets `Secure`.

### AppImage

```bash
# Download the AppImage and its checksum sidecar from the release, verify, run
curl -fLO https://github.com/libredb/libredb-studio/releases/download/<version>/libredb-studio-desktop-<version>-linux-x64.AppImage
curl -fLO https://github.com/libredb/libredb-studio/releases/download/<version>/libredb-studio-desktop-<version>-linux-x64.AppImage.sha256
sha256sum -c libredb-studio-desktop-<version>-linux-x64.AppImage.sha256
chmod +x libredb-studio-desktop-<version>-linux-x64.AppImage
./libredb-studio-desktop-<version>-linux-x64.AppImage
```

The AppImage needs FUSE to mount itself; on a system without it (or in a container), run it with
`--appimage-extract-and-run`. Built for `x64` and `arm64` against current desktop distributions -
the server packages (.deb/.rpm, Snap, Docker) remain the path for headless or older systems.

### Debian package (GUI)

```bash
curl -fLO https://github.com/libredb/libredb-studio/releases/download/<version>/libredb-studio-desktop_<version>_amd64.deb
curl -fLO https://github.com/libredb/libredb-studio/releases/download/<version>/libredb-studio-desktop_<version>_amd64.deb.sha256
sha256sum -c libredb-studio-desktop_<version>_amd64.deb.sha256
sudo apt install ./libredb-studio-desktop_<version>_amd64.deb
```

Ships from 0.9.62 for `amd64` and `arm64`. Unlike the AppImage it needs no FUSE, integrates with
the desktop menu on install, and takes `libwebkit2gtk-4.1-0` and `libgtk-3-0` from the distribution
rather than bundling them - so it is the smaller, better-behaved choice on a Debian or Ubuntu
desktop, and the older-distro caveat that applies to the AppImage applies here too.

This is **not** the server package. `libredb-studio_<version>_<arch>.deb` installs a systemd
service; this one installs an application. They have different dpkg package names and can be
installed side by side.

The bundled Node sidecar is installed as `/usr/bin/libredb-studio-node`, not `/usr/bin/node`:
that path belongs to the distribution's `nodejs` package and dpkg refuses to let a second package
claim it.

### FlatPark (Flatpak)

[FlatPark](https://flatpark.org/) is a signed Flatpak remote and **the** Flatpak channel for
LibreDB Studio, live since 0.9.62 ([#241](https://github.com/libredb/libredb-studio/issues/241)):

```bash
flatpak --user remote-add --if-not-exists flatpark https://dl.flatpark.org/flatpark.flatpakrepo
# Flathub is added for the org.gnome.Platform runtime only - the app itself is not published there
flatpak --user remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak --user install flatpark org.libredb.Studio
flatpak run org.libredb.Studio
```

FlatPark pins the **GUI `.deb` as `extra-data`**: it builds nothing itself, so your own machine
downloads that exact release asset at install time and unpacks it inside the sandbox. It does not
accept AppImages at all - its runtime has no libfuse.

The Flatpak sandbox has network access and no filesystem access. Databases reachable over TCP -
including a database on the host at `127.0.0.1` - work out of the box; opening local SQLite files
or connecting through a Unix socket needs an explicit grant, the same trade-off the strictly
confined Snap makes:

```bash
# Local Postgres over its unix socket
flatpak override --user --filesystem=/run/postgresql:ro org.libredb.Studio
# Local MySQL/MariaDB over its unix socket
flatpak override --user --filesystem=/var/run/mysqld:ro org.libredb.Studio
# A directory of SQLite database files
flatpak override --user --filesystem=~/databases org.libredb.Studio
# Revert every override
flatpak override --user --reset org.libredb.Studio
```

The descriptor set, the local build flow and the submission checklist live in
[`packaging/flatpark/README.md`](../packaging/flatpark/README.md).

### Flathub (submission declined)

**LibreDB Studio is not on Flathub, and `flatpak install flathub org.libredb.Studio` will not
work.** Install from the FlatPark remote above - same app id, same sandbox policy, same
`flatpak override` commands.

The submission ([flathub/flathub#9538](https://github.com/flathub/flathub/pull/9538)) was declined
on 2026-07-30 under Flathub's [generative AI
policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy). The
reviewer's position was that developing with an AI assistant disqualifies the app, irrespective of
who designed, reviewed and released it. We closed the PR ourselves rather than argue the point; the
[closing comment](https://github.com/flathub/flathub/pull/9538#issuecomment-5136879185) leaves the
verifiable maintenance record on the thread.

[`packaging/flatpak/`](../packaging/flatpak/) stays in the tree and stays honest: the manifest
still renders, and [`flatpak-smoke.yml`](../.github/workflows/flatpak-smoke.yml) still builds the
AppImage and repacks it whenever those paths change. But a resubmission would also have to be built
from source - repacking a released AppImage is a second, independent blocker under Flathub's
requirements - so treat that directory as dormant rather than as pending work
([#232](https://github.com/libredb/libredb-studio/issues/232)).

### Building and running either Flatpak locally

Neither channel needs a published release to test. Both take a locally built artifact:

```bash
# FlatPark: build the GUI .deb, then the Flatpak that pins it.
# --deb-only skips the AppImage, so the linuxdeploy GTK toolchain (librsvg2-dev
# and friends) is not needed.
gh release download <version> --repo libredb/libredb-studio \
  --pattern "libredb-studio-standalone-<version>-linux-x64.tar.gz"
bash scripts/build-desktop-appimage.sh dist-desktop \
  --payload libredb-studio-standalone-<version>-linux-x64.tar.gz --deb-only --smoke
bash scripts/build-flatpark-local.sh \
  dist-desktop/libredb-studio-desktop_<version>_amd64.deb --install
flatpak run org.libredb.Studio//stable

# packaging/flatpak (dormant, see above): build the AppImage, then the Flatpak that repacks it.
bash scripts/build-desktop-appimage.sh dist-desktop --payload <tarball> --smoke
bash scripts/build-flatpak-local.sh \
  dist-desktop/libredb-studio-desktop-<version>-linux-x64.AppImage --install
flatpak run org.libredb.Studio
```

Drop `--payload` to build the payload from the working tree instead of a released tarball - slower,
but it tests the code you actually have.

Both need the builder and the runtime the manifests declare:

```bash
flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50
```

The FlatPark script builds on branch `stable`, so its ref does not collide with a Flathub-style
local build of the same app id. Note that **both share `~/.var/app/org.libredb.Studio/`** - the app
id is the same - so deleting that directory resets connections and query history for whichever
builds you have installed. To remove a local FlatPark build:

```bash
flatpak --user uninstall -y org.libredb.Studio//stable
flatpak --user remote-delete libredb-flatpark-local
```

## App catalogs (Unraid, Sealos)

Both channels install the same published container image through a catalog the platform itself
publishes, so a user browsing that platform finds LibreDB Studio without ever visiting this repo.
They are documented here rather than under `deploy/<provider>/` because neither descriptor lives in
this repo: the Sealos template lives upstream in
[`labring-actions/templates`](https://github.com/labring-actions/templates) and the Unraid template
in [`libredb/unraid-templates`](https://github.com/libredb/unraid-templates), and neither has a
`deploy/<provider>/` folder here at all. Every other catalog channel does have one and keeps its
notes in `deploy/<provider>/README.md` instead - CapRover and Railway alongside the source
descriptor itself, Dokploy, Kubero and Cosmos as notes only, since those three descriptors are also
authored upstream. The full channel list is [`docs/CHANNELS.md`](CHANNELS.md).

Both templates pin an explicit **version tag**, not `latest`, so a new release reaches these users
only when the template is bumped - `on_demand` for both in
[`distribution/channels.yaml`](../distribution/channels.yaml).

### Unraid (Community Applications)

Listed in [Community Applications](https://ca.unraid.net/apps/libredb-studio-0a5x41a1cy1kay) (CA)
since 2026-08-04 ([issue #283](https://github.com/libredb/libredb-studio/issues/283)). In the Unraid
web UI: **Apps** tab, search for **LibreDB Studio**, then **Install**.

- **The web UI host port defaults to 3006**, mapped to container port 3000. Any free host port
  works; the template steers away from 3000 because it commonly collides with other apps.
- **App Data** is `/mnt/user/appdata/libredb-studio` mapped to `/app/data`, holding the server-side
  SQLite storage (`STORAGE_SQLITE_PATH=/app/data/libredb-storage.db`) - that database is what
  survives container updates and recreation. **No `auth-bootstrap.json` is written here**, because
  the template always supplies `ADMIN_PASSWORD` and `JWT_SECRET` and generation short-circuits when
  both are set: back up the database, and keep the credentials you typed into the template.
- **Credentials are entered in the Add Container form**, not read back from a log: the template
  marks `ADMIN_EMAIL`, `ADMIN_PASSWORD` (minimum 8 characters) and `JWT_SECRET` (minimum 32
  characters) as required fields. That is a template choice for a NAS audience, not an app
  requirement - see the exception noted under
  [Zero-config first run](#zero-config-first-run).
- `AUTH_COOKIE_SECURE=false` ships as the default because a LAN install is served over plain HTTP.
  Set it to `true` once the app sits behind HTTPS (a reverse proxy); leaving it `false` on a
  public host sends the session cookie in cleartext.
- The container is unprivileged, on `bridge` networking, and needs no other service - databases are
  reached over TCP from the Unraid host's network.

Because the template repo is LibreDB-owned, a version bump is a commit in
`libredb/unraid-templates` rather than a PR here or upstream; CA then serves it after its next
catalog build, which is when Unraid offers the update.

### Sealos (App Store)

Listed in the [Sealos App Store](https://sealos.io/products/app-store/libredb-studio) since
2026-08-04 ([issue #276](https://github.com/libredb/libredb-studio/issues/276),
[labring-actions/templates#739](https://github.com/labring-actions/templates/pull/739)). Click
**Deploy Now** and supply an administrator email and password (minimum 8 characters); the template
provisions compute, networking, storage and ingress, so there is nothing to install locally.

- **Storage** defaults to SQLite on a 1 GiB PVC. The template also offers **Use PostgreSQL
  storage**, which provisions a KubeBlocks-managed PostgreSQL instance and points
  `STORAGE_PROVIDER` / `STORAGE_POSTGRES_URL` at it - see [`docs/STORAGE.md`](STORAGE.md).
- The template sets **`AUTH_BOOTSTRAP=off`** and generates `JWT_SECRET` itself, so the deployment
  starts in [strict mode](#zero-config-first-run) with the password you entered - there is no
  generated-credentials banner to read from the pod log.
- Bumps go in as a template PR to `labring-actions/templates`. That repo's default branch is
  **`kb-0.9`**, not `main` or `master`, which is what both the drift-check pin URL and any bump PR
  must target.

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
   **bare** `npx @libredb/studio` on Node 24/26 and asserts each resolves exactly that release,
   and on Node 22 asserts the engines floor pins it to an older but still *runnable*
   release (the #130 regression class - npm's picker avoids engine-incompatible versions for bare
   specs and never says so). Check that it went green; dispatch it manually to re-run. Then run
   the `npm deprecate` step below so the pin stops being silent.
3. `brew tap libredb/tap && brew install libredb-studio && brew services start libredb-studio`.
4. Download the `.deb` on Debian/Ubuntu: `dpkg -i`, `systemctl start libredb-studio`, health 200
   on `127.0.0.1:3000`; verify the arm64 package on an arm64 machine (the CI smoke covers amd64
   only; the bundled node arch is statically asserted for both).
5. Spot-check provenance on one downloaded asset and the image - a green release job proves the
   attestation step ran, not that the published asset is the one it covers:
   `gh attestation verify <asset> --repo libredb/libredb-studio` and
   `gh attestation verify oci://ghcr.io/libredb/libredb-studio:<version> --repo libredb/libredb-studio`,
   plus `npm audit signatures` after installing the package (see
   [Verifying a release artifact](#verifying-a-release-artifact)).
6. **Only when a release raises `engines.node`**: deprecate the last version below the new floor,
   so the users npm silently pins there are told why. `npm deprecate` is the only npm mechanism
   that prints a message on install, and it targets exactly the pinned population - callers who
   resolve a supported version never see it.

   ```bash
   npm deprecate '@libredb/studio@<=0.10.0' \
     'LibreDB Studio 0.11.0+ requires Node.js 24 LTS; npm pinned you to this release because your Node is older. Upgrade Node, or run: docker run -p 3000:3000 ghcr.io/libredb/libredb-studio:latest'
   ```

   Deprecating a version does not unpublish or hide it: it keeps installing and running exactly as
   before. Undo with `npm deprecate '@libredb/studio@<=0.10.0' ''`.

### Artifact provenance roadmap

Standalone tarballs and `.deb`/`.rpm` packages are checksum-verified against `SHA256SUMS` /
per-package `.sha256` sidecars (see [Release artifact naming](#release-artifact-naming)) — both
from the same GitHub release. That pairing detects corruption, not substitution: whoever can
replace an asset can replace its checksum line too. The `.snap` release asset ships no sidecar
(`--dangerous` installs skip the Snap Store's own verification).

Signed provenance moves the trust root out of the release — the signer is the workflow's GitHub
OIDC identity (repo + workflow + commit), recorded in a public transparency log. All three steps of
[issue #123](https://github.com/libredb/libredb-studio/issues/123) landed for 0.9.63:

| Step | Scope | State |
|---|---|---|
| npm provenance | npm tarball (`npm publish --provenance`, Sigstore bundle held by npmjs) | **done** (0.9.63) — verify with `npm audit signatures` |
| SLSA build provenance | standalone tarballs, win32 zip, `.deb`/`.rpm`, desktop AppImage + GUI `.deb`, `.snap`, GHCR image (`actions/attest-build-provenance`) | **done** (0.9.63) — verify with `gh attestation verify` |
| Launcher-side verification | `bin/studio.js` checks the downloaded archive's attestation when `gh` is present | **done** (0.9.63) — see [Launcher provenance check](#launcher-provenance-check) |

No step needed a new secret: the attestations live in GitHub's attestation store, not in the
release, so nothing an attacker can reach by replacing a release asset also lets them forge a
signature.

#### Verifying a release artifact

```bash
# Any release asset (tarball, zip, .deb, .rpm, .AppImage, .snap)
gh attestation verify libredb-studio-standalone-0.9.63-linux-x64.tar.gz \
  --repo libredb/libredb-studio

# The container image, by digest or by tag
gh attestation verify oci://ghcr.io/libredb/libredb-studio:0.9.63 \
  --repo libredb/libredb-studio
```

A pass prints the workflow and commit that produced the artifact. `gh attestation verify` reaches
GitHub for the bundle, so it needs network access; `--bundle` verifies a previously downloaded
one offline.

Notes on what is and is not covered:

- The `.snap` attestation only exists when the release actually built one (the job is gated on
  `SNAPCRAFT_STORE_CREDENTIALS`); Snap Store installs are verified by the store instead.
- `SHA256SUMS` and the `.sha256` sidecars are deliberately **not** attested — a signature over a
  checksum file proves nothing about the artifact it describes. The artifacts are the subjects.
- Images built from branch pushes (the mutable `main` / `dev` tags) are not attested; only
  release-context builds are.
- The image attestation is not pushed to GHCR as an OCI referrer, so `cosign`-style registry-only
  verification will not find it — fetch it from GitHub with `gh attestation verify oci://…`.
- Buildx's own inline provenance on the manifest is unrelated and unsigned; it is left at the
  action's defaults on purpose (changing it rewrites the manifest structure, which the Docker Hub
  mirror's immutable-tag rules are sensitive to).

**Failure modes to expect on release day:** `npm publish --provenance` hard-fails if the job lacks
`id-token: write` or if Sigstore is unreachable, and `actions/attest-build-provenance` fails the
same way — with a job-level `attestations: write` missing, or if the GitHub attestation API is
down. A failed npm publish cannot be retried on the same tag (follow the usual rule and cut the
next patch version); a failed attestation happens before `gh release upload` in the same job, so
re-running that job is safe — the release is still a draft at that point.

### CI secrets that gate publishing

Optional-channel steps are skipped cleanly when their secret is absent, so forks and partial
setups still publish the rest:

| Secret | Gates | Without it |
|---|---|---|
| `TAP_GITHUB_TOKEN` | Rendering and pushing the Homebrew formula to `libredb/homebrew-tap` (needs write access to that repo) | Tap update skipped; tarballs still attach to the release |
| `SNAPCRAFT_STORE_CREDENTIALS` | The entire snap build/publish job (exported via `snapcraft export-login`) | Snap job skipped |
| `DOCKER_HUB_TOKEN` (+ `DOCKER_HUB_USERNAME` variable) | The Docker Hub mirror push | GHCR-only publish |
| `CHOCO_API_KEY` | The chocolatey job: `choco pack` + `choco push` to `https://push.chocolatey.org/` (API key of the `libredb` community account) | Chocolatey publish skipped; the win32 zip still attaches to the release |
| — | Every row above whose channel is switchable also needs `update.ci_enabled: true` in [`distribution/channels.yaml`](../distribution/channels.yaml): the secret says CI *can* publish, the flag says it *should*. See [Turning a channel's automation off](#turning-a-channels-automation-off) | Channel skipped with a notice; the release publishes normally |
| `WINGETCREATE_GITHUB_TOKEN` | The winget job: `wingetcreate update --submit` PRs to `microsoft/winget-pkgs`. Classic PAT with `public_repo` scope — wingetcreate does not support fine-grained PATs | winget submission skipped |

The chocolatey and winget jobs run strictly **after** `publish-release`: both channels download
the zip from the release URL, which is public only once the release is published. A failure there
never *unpublishes* or blocks the release (same trust model as the npm/Docker dispatch chain) —
but it does make the workflow run report `failure` overall, which reads as a failed release when
it was not. That is why a channel known to be unable to publish is switched off in the inventory
rather than left to fail: the run's colour has to mean something.

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
0.9.59: **winget merged on 2026-07-31** and is `live` with `ci_enabled: true`, while the
Chocolatey push is still in moderation.

1. **Chocolatey** — the release's chocolatey job packs and pushes automatically. The first push
   enters [human moderation](https://docs.chocolatey.org/en-us/community-repository/moderation/);
   while a version sits in the moderation queue, pushing further versions can be rejected —
   if a release-time push fails during that window, re-run the job after approval.
2. **winget** — DONE:
   [microsoft/winget-pkgs#402985](https://github.com/microsoft/winget-pkgs/pull/402985) (the
   Microsoft CLA is signed on that first PR). The first manifest could not be submitted by
   `wingetcreate update` — the package id did not exist yet, and the release job detects that and
   skips with a notice — so it was rendered from the in-repo templates and opened by hand. Later
   releases submit update PRs automatically; the same manual recipe still covers a **back
   version** (a release published while the channel was switched off, since re-dispatching
   `release-artifacts` for a published version is not an option):

   ```bash
   VERSION=<version>
   gh release download "$VERSION" --pattern SHA256SUMS --dir dist
   for t in packaging/winget/*.tmpl; do
     out="manifests/l/LibreDB/Studio/$VERSION/$(basename "${t%.tmpl}")"
     node scripts/render-windows-packaging.mjs "$t" dist/SHA256SUMS "$VERSION" "$out"
   done
   ```

   Then either `wingetcreate submit --token <classic-PAT> manifests/l/LibreDB/Studio/$VERSION`
   (Windows only — wingetcreate ships a win-x64 binary), or, from any OS, commit the three files
   to a branch on a `microsoft/winget-pkgs` fork and open the PR with `gh` — the whole submission
   is "add `manifests/l/LibreDB/Studio/<version>/`", nothing else changes. Title convention:
   `New package: <id> version <version>` for a first listing, `New version: <id> version
   <version>` for an update. Upstream's validation pipeline downloads the `InstallerUrl` and
   verifies `InstallerSha256`, so the release must already be published.
3. After each catalog goes live: flip its `distribution/channels.yaml` entry to `status: live`,
   set `links.first_pr`, and add a measurable pin where one exists (Chocolatey community API).
   **winget is measured by a probe, not a regex pin** (`pin.strategy: probe`, `winget-max-version`):
   it publishes no floating "latest" document — the winget-pkgs contents listing enumerates every
   published version — so the checker takes the highest version enumerated there. A regex pin
   cannot express that, because it requires all matches in a source to agree.

### Channel inventory and drift check

For the **coverage matrix** (live counts by category and platform, full channel
table), see [`docs/CHANNELS.md`](CHANNELS.md). Regenerate it with
`bun run distribution:matrix` after editing the inventory; `bun run distribution:matrix --check`
fails when the generated regions are stale.

[`distribution/channels.yaml`](../distribution/channels.yaml) is the machine-readable inventory
of every distribution channel: identity, business `category`, update policy, provenance links, and (where measurable)
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
| 1 | Packaged formats owned by this repo, CI-published | Helm, Homebrew tap, Snap, .deb/.rpm, desktop AppImage |
| 2 | LibreDB-owned copies and listings, bumped by hand | Railway, Koyeb button, Fly.io config, Render Blueprint, Unraid CA template |
| 3 | Upstream community catalogs, bumped via PR | CapRover official, Dokploy, Cosmos, Kubero, Sealos, TrueNAS SCALE |
| 4 | Partner or curated catalogs (not self-serve) | Rancher partner charts, Koyeb catalog, DO, winget, Chocolatey, Flathub |

**Categories** (`category` on every channel) are the business-facing buckets rendered in
[`docs/CHANNELS.md`](CHANNELS.md): `registries-releases`, `containers`,
`kubernetes-operators`, `package-managers`, `os-desktop`, `paas-catalogs`,
`deploy-recipes`, `cloud-marketplaces`. They are independent of tier (who
publishes). `paas-catalogs` and `deploy-recipes` look similar but answer different
questions: `paas-catalogs` means the platform itself lists LibreDB Studio in its own
catalog, so a user browsing that platform discovers it without visiting this repo;
`deploy-recipes` means we publish a config file or instructions and the platform does
not list us anywhere, so discovery only happens through our repo. There is no `closed`
category: a declined or retired channel is `status: deprecated` with its `category`
unchanged (Flathub is `category: package-managers`, `status: deprecated`) — `category`
describes what the channel technically is, `status` describes its lifecycle, and an
earlier revision that conflated the two (Flathub filed under a `closed` category) is
what produced a false coverage claim in the scorecard.

**Kind** (`kind` on every channel) is the technical shape of the artefact — a Helm
chart, a container image, a curated marketplace listing — and is validated against a
fixed enum in `scripts/distribution-check.mjs` (`CHANNEL_KINDS`). It is independent of
`category`: `kubernetes-operators` (category) spans `helm-chart`, `operator-catalog`
and `partner-catalog` (kind), and `paas-template` (kind) spans both `paas-catalogs` and
`deploy-recipes` (category). Neither axis determines the other, so both are kept and
validated separately rather than collapsed into one.

**Platforms** (`platforms` on every channel, at least one) are the user-facing axis rendered
in [`docs/CHANNELS.md`](CHANNELS.md): `linux`, `macos`, `windows`, `container`, `kubernetes`,
`cloud`. They are independent of both tier (who publishes) and category (which business
bucket). A channel may list several; the matrix always renders them in that canonical order.

**Runtime ownership** (`runtime` on every channel) records who provides the Node.js the server
runs on, which is the axis that decides whether raising `engines.node` is a breaking change for a
channel's users or an invisible build detail (issue #326):

| Value | Meaning | Channels |
|---|---|---|
| `user_supplied` | The user's own `node` executes the payload, so the floor is theirs to meet. A release that raises it is user-visible here and nowhere else. | `npm`, `github-release` |
| `channel_supplied` | The channel provides the runtime — bundled inside the artefact (container image, snap, deb/rpm, Windows zip, Flatpak, the Tauri sidecar), inherited from an image a template deploys, or installed as a declared package dependency (Homebrew's `node@24`). Raising the floor is transparent. | the other 25 |

It is deliberately not derived from `kind`: `os-package` covers deb/rpm, which ship a private Node
(`packaging/linux/fetch-node.sh` installs `bin/node` into the payload), while `package-registry`
covers npm, which does not. Issue #326 assumed deb/rpm were user-supplied; the packaging scripts
say otherwise, which is exactly why this is a stated field rather than an inference.

**SLAs** (`update.sla`) state how quickly a channel is expected to follow a release:
`every_release` (bumped as part of releasing), `minor_plus` (bumped for minor releases and
above), `major_only`, `on_demand` (bumped when someone gets to it — the honest default for PaaS
catalog templates).

**Pin strategies:** `local_file` (version lives in files in this repo), `remote_file` (fetched
from an upstream raw URL, best-effort — fetch failures degrade to UNKNOWN and never fail the
run), `probe` (see below), `none` (nothing to measure, stated explicitly with a `note`). The two
regex strategies carry an `extract` pattern with exactly one capture group; when a source yields
multiple *different* matches the channel is reported instead of silently using the first hit.

**Probes** (#182) measure the channels whose served state is not one document a single regex can
read. Each names a `probe` and the `urls` it needs; the URLs live in the inventory rather than in
the script so the unit tests can point them at a local server and the suite never touches the
real network. Probe failures degrade to UNKNOWN exactly like a failed `remote_file` fetch — but a
tag that is *genuinely absent* is DRIFT, not UNKNOWN, which is the whole point: a publish step
that skipped silently must not read as "could not measure".

| Probe | Channel | What it measures |
|---|---|---|
| `ghcr-tag-digest` | `docker-ghcr` | that the digest `:latest` resolves to equals the released version tag's (anonymous pull token — no secret, works from a fork) |
| `dockerhub-tag-digest` | `docker-hub-mirror` | the same digest equality on the mirror; an absent version tag is how an expired `DOCKER_HUB_TOKEN` (whose push step skips silently) becomes visible |
| `snap-store-channel` | `snap` | the `stable` version of every listed architecture, each as its own source, so one lagging build is drift rather than a pass; `edge` may legitimately differ and is ignored |
| `winget-max-version` | `winget` | the highest version the catalog enumerates, because winget publishes no floating "latest" document |

Because a probe resolves versions in code, a channel measured this way needs no `extract`. A
probe that reports several sources (Snap's architectures) reuses the same rule as a multi-file
`local_file` pin: disagreeing sources are drift, with every source shown.

**Strict mode:** `bun run distribution:check --strict` exits non-zero only for `local_file`
channels with `sla: every_release` that are drifted or unmeasurable. Remote catalogs and
`on_demand` templates never gate, so strict is enableable today without first paying off
historical PaaS drift. For the Helm chart the enforcement remains the required `chart:check` CI
gate (#138) — the matrix row is visibility, not a second gate. `--json` emits the rows for
scripting.

#### The inventory also drives the login page

Since [#425](https://github.com/libredb/libredb-studio/issues/425) `channels.yaml` is read by the
product itself, not only by the docs and the drift table. `bun run channels:showcase`
([`scripts/generate-channel-showcase.mjs`](../scripts/generate-channel-showcase.mjs)) emits
[`src/lib/distribution/channels.generated.ts`](../src/lib/distribution/channels.generated.ts) — the
**live** channels, each mapped to one of the login hero's four rows (containers, Kubernetes, PaaS,
packages) by its `category`, plus the platforms those channels cover — and the login page renders
that module. `bun run channels:showcase:check` regenerates it in memory and fails on drift; it runs
in the required `lint-and-build` job next to `chart:check`, so the committed module is always the
inventory.

The consequence worth stating: **flipping a channel's `status` to `live` publishes it on the login
page, with no component edit** — the same one-line edit that already moves it in
[`docs/CHANNELS.md`](CHANNELS.md) and in the drift table. Only `live` reaches the UI, so a `pending`
submission or a `deprecated` listing renders nothing at all, and the count the page states is a
`.length` over that array rather than a written number. The generator refuses to guess: a `category`
with no row mapping throws instead of defaulting, so adding a business bucket to the inventory fails
the gate loudly rather than quietly dropping a channel out of the product's front door.

The channel's **label** on that page is its `short_name` when it has one and its `name` otherwise, so
a channel whose full name is too long for the hero is shortened in `channels.yaml` — never in the
component. The whole point of the generated module is that no channel name is typed into JSX.

#### Turning a channel's automation off

Some channels can be temporarily unable to publish for reasons outside this repository — a package
waiting in community moderation, a listing still under review. Left to fail they make a *published*
release report `failure`, which is worse than not publishing: the run's colour stops meaning
anything. `update.ci_enabled` in `channels.yaml` is the switch:

```yaml
  - id: chocolatey
    update:
      method: ci_publish
      sla: every_release
      ci_enabled: false   # 403 for every version while the first push is in moderation
```

The release workflow reads it (`distribution-check.mjs --ci-outputs` in the `channels` job, whose
outputs each channel's availability step consults), so **the edit is the whole switch** — no
secret to delete, no workflow change, and the decision is reviewable in a diff next to the
channel's `status` and note. A channel is published only when its flag says `true` *and* its
secret is present.

Three deliberate constraints:

- **Only optional channels may carry the flag:** `docker-hub-mirror`, `homebrew`, `snap`,
  `winget`, `chocolatey`. The core release path (`github-release`, `docker-ghcr`, `npm`, `helm`)
  and the assets `publish-release` requires (`.deb`/`.rpm`, AppImage, the win32 zip) have no
  switch, because one mistyped `false` there would silently ship a release with no npm package or
  no image. `parseChannels` **rejects** the flag anywhere else, so this is enforced, not just
  documented.
- **It is required, never defaulted,** on those five: CI behaviour for a channel has to be a
  stated decision in this file, not an omission.
- **Failure leaves channels off, never the release blocked.** The `channels` job is
  `continue-on-error`; if it cannot run, its outputs are empty, every gate reads "not true", and
  the optional channels skip while the release publishes normally. A forgotten re-enable surfaces
  in the weekly drift table rather than in a broken release.

Do not confuse it with `status`: `status` describes the channel's listing (`chocolatey` is
`pending` because its first push has not cleared moderation, while the zip it points at is built
and required on every release), whereas `ci_enabled` describes only whether release CI may
publish it. The two move together when a listing lands — `winget` went `pending`/`false` to
`live`/`true` in a single edit once #402985 merged. A channel whose listing will never happen is
`deprecated`, not `pending` — `flathub` is the worked example.

**Adding a channel** = one new entry in `channels.yaml` (copy a neighbour of the same tier; the
schema is validated on every run). Set `links.first_pr` to the PR that landed the listing, and
update `links.last_bump_pr` whenever a version-bump PR for that channel merges — it is `null`
until the first post-listing bump and is displayed, not auto-discovered.

**Root-level PaaS configs.** Two tier-2 channels ship their descriptor at the repo root rather
than under `deploy/<provider>/`: [`fly.toml`](../fly.toml) (Fly.io) and
[`render.yaml`](../render.yaml) (Render). This is deliberate, not a stray file — their tooling
auto-detects the config at the working-directory root: `fly launch`/`fly deploy` read
`./fly.toml` (see [docs/FLY.md](FLY.md)) and Render's Blueprint auto-detects `render.yaml`, so
the documented "clone and deploy" flow only works from that location. Catalog-based channels
instead keep whatever they own under `deploy/<provider>/`, because the consumable artifact lives in
an external catalog. Only **CapRover** and **Railway** own a source descriptor there
(`deploy/caprover/libredb-studio.yml`, `deploy/railway/template.json`): the in-repo file is the
source that gets pushed or PR'd upstream, which is why Railway is pinned `local_file`. CapRover is
pinned `remote_file` even so - that pin must measure what the catalog actually serves, which leaves
its in-repo descriptor unmeasured by any gate
([#268](https://github.com/libredb/libredb-studio/issues/268)); it fell 45 patch versions behind the
catalog before anyone noticed. **Dokploy**, **Kubero** and **Cosmos** keep only a README there -
their descriptors are authored in the upstream catalog repo, so all three are pinned `remote_file`
and a bump is an upstream PR with nothing to change here. Two catalog channels keep **no**
descriptor here at all — the Sealos template is authored in `labring-actions/templates` and the
Unraid CA template in `libredb/unraid-templates` — so both are pinned with `remote_file` against
those repos and documented under [App catalogs](#app-catalogs-unraid-sealos). Neither Fly.io nor
Render has a marketplace or template gallery to publish into, which is why the repo file itself is the
deliverable (`pin.strategy: local_file` for the version-pinned `fly.toml`; `none` for
`render.yaml`, which builds from the repo Dockerfile and tracks whatever `main` builds).

### Manual steps still open

- **Operator first listings**: the controller image is done —
  `ghcr.io/libredb/libredb-studio-operator:0.9.59` was built once by manual
  `workflow_dispatch` from the post-merge `main` commit (the `0.9.59` tag
  carries neither `operator/` nor the workflow file, and GitHub only dispatches
  workflows that exist on the chosen ref) and the GHCR package is public, which
  community catalog CI requires. From 0.9.60 on the tag ref carries the
  operator and the normal tag-pinned dispatch chain applies. What is still open
  is upstream: the operatorhub.io bundle PR
  ([k8s-operatorhub/community-operators#8794](https://github.com/k8s-operatorhub/community-operators/pull/8794))
  and the OpenShift catalog PR
  ([community-operators-prod#10581](https://github.com/redhat-openshift-ecosystem/community-operators-prod/pull/10581),
  the second half of the FBC release whose bundle merged as #10497) both wait
  on maintainer review. Flip `operatorhub-community` in
  `distribution/channels.yaml` from `pending` to `live` once the listings are
  visible, and remember `release-config.yaml` for every later release (see
  [An FBC release is two upstream PRs](#an-fbc-release-is-two-upstream-prs)).
- **Snap Store listing screenshots**: the description and icon ship with the snap
  (`snap/snapcraft.yaml`, `public/logo.svg`), but screenshots are a manual upload in the
  Snap Store web UI (https://snapcraft.io/libredb-studio/listing). The snap name is registered
  and `SNAPCRAFT_STORE_CREDENTIALS` is configured — the channel went live with 0.9.52.
- **Website install docs**: the libredb-website documentation must be updated with the new
  channels (npx, Homebrew, .deb/.rpm, Snap) — a cross-repo step and part of issue #111's
  "README and website docs" acceptance criterion (and implicitly of #110/#112/#113).
- **Windows first listings**: winget is done —
  [microsoft/winget-pkgs#402985](https://github.com/microsoft/winget-pkgs/pull/402985) merged on
  2026-07-31 and the channel is `live` with release-CI updates enabled. Only the Chocolatey first
  push is still outstanding (human moderation), per the
  [Windows first-listing checklist](#windows-first-listing-checklist) —
  tracked in [issue #114](https://github.com/libredb/libredb-studio/issues/114).
- **Flathub submission — closed, not shipping.**
  [flathub/flathub#9538](https://github.com/flathub/flathub/pull/9538) was declined on 2026-07-30
  under Flathub's generative AI policy and closed from our side; see
  [Flathub (submission declined)](#flathub-submission-declined). The Flatpak channel is
  [FlatPark](#flatpark-flatpak), live since 0.9.62. The domain-verification file at
  `https://libredb.org/.well-known/org.flathub.VerifiedApps.txt` is served but carries no token,
  since Flathub only issues one after publication. Tracked in
  [issue #232](https://github.com/libredb/libredb-studio/issues/232).
- **Desktop app, remaining channels**: the Tauri v2 wrapper now ships as an AppImage on Linux
  (see [Desktop app](#desktop-app-appimage-debian-package-flatpark)). The macOS `.dmg` plus brew cask, the
  Microsoft Store MSIX and the Tauri updater are still open and need paid signing identities —
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
