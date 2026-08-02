# Distribution channels

This page is the **business / investment visibility matrix** for LibreDB Studio:
how many places the product can be obtained from, which are live today, and how
they group by audience-facing category.

It is aimed at buyers evaluating coverage, investors and supporters assessing
distribution footprint, and curious users who want a single overview. For
install and operate instructions, use [DISTRIBUTION.md](DISTRIBUTION.md). The
machine-readable inventory (and drift checker) lives in
[`distribution/channels.yaml`](../distribution/channels.yaml).

| Status | Meaning |
| --- | --- |
| `live` | Listed and installable (or deployable) through that channel |
| `pending` | Submission or first listing in progress |
| `deprecated` | Closed / declined — kept for honesty (e.g. Flathub) |

To propose a new channel, add an entry to `distribution/channels.yaml` (with a
`category`) and regenerate this page with `bun run distribution:matrix`.

<!-- BEGIN:CHANNEL-SCORECARD -->

### Coverage snapshot

**27 channels · 22 live · 4 pending · 1 deprecated**

| Category | Live | Pending | Deprecated |
| --- | ---: | ---: | ---: |
| Registries & releases | 2 | 0 | 0 |
| Containers | 2 | 0 | 0 |
| Kubernetes & operators | 1 | 2 | 0 |
| Package managers | 4 | 1 | 0 |
| OS / desktop packages | 2 | 0 | 0 |
| PaaS & one-click | 10 | 0 | 0 |
| Marketplaces & partners | 1 | 1 | 0 |
| Closed / declined | 0 | 0 | 1 |

Coverage: Registries & releases; Containers; Kubernetes & operators; Package managers; OS / desktop packages; PaaS & one-click; Marketplaces & partners; Closed / declined.

<!-- END:CHANNEL-SCORECARD -->

## All channels

<!-- BEGIN:CHANNEL-TABLE -->

| Channel | Category | Status | Update | Catalog | Docs |
| --- | --- | --- | --- | --- | --- |
| GitHub Releases (standalone tarballs, deb/rpm, snap assets) | Registries & releases | live | Every release | [link](https://github.com/libredb/libredb-studio/releases) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| npm package @libredb/studio (library + npx launcher) | Registries & releases | live | Every release | [link](https://www.npmjs.com/package/@libredb/studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Docker image (GHCR, canonical) | Containers | live | Every release | [link](https://github.com/libredb/libredb-studio/pkgs/container/libredb-studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Docker Hub mirror (discoverability only) | Containers | live | Every release | [link](https://hub.docker.com/r/libredb/libredb-studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Helm chart (libredb.org repo + GHCR OCI + ArtifactHub) | Kubernetes & operators | live | Every release | [link](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio) | [HELM_CHART.md](HELM_CHART.md) |
| OperatorHub / OpenShift community operator catalogs | Kubernetes & operators | pending | Every release | — | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Rancher Partner Charts | Kubernetes & operators | pending | On demand | — | [DISTRIBUTION.md](DISTRIBUTION.md) |
| FlatPark signed Flatpak remote (org.libredb.Studio) | Package managers | live | Every release | [link](https://flatpark.org/) | [../packaging/flatpark/README.md](../packaging/flatpark/README.md) |
| Homebrew tap (libredb/tap/libredb-studio) | Package managers | live | Every release | — | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Snap Store (stable channel, amd64+arm64) | Package managers | live | Every release | [link](https://snapcraft.io/libredb-studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| winget community repository (LibreDB.Studio) | Package managers | live | Every release | [link](https://github.com/microsoft/winget-pkgs/tree/master/manifests/l/LibreDB/Studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Chocolatey community repository (libredb-studio) | Package managers | pending | Every release | [link](https://community.chocolatey.org/packages/libredb-studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Desktop app (release assets: AppImage and GUI .deb, x64 + arm64) | OS / desktop packages | live | Every release | — | [../desktop/README.md](../desktop/README.md) |
| Linux .deb / .rpm packages (release assets) | OS / desktop packages | live | Every release | — | [DISTRIBUTION.md](DISTRIBUTION.md) |
| CapRover one-click template (in-repo source of truth) | PaaS & one-click | live | On demand | — | [../deploy/caprover/README.md](../deploy/caprover/README.md) |
| CapRover 3rd-party repo (libredb.org/caprover-one-click-apps) | PaaS & one-click | live | On demand | [link](https://libredb.org/caprover-one-click-apps) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| CapRover official one-click apps | PaaS & one-click | live | On demand | — | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Cosmos servapp marketplace | PaaS & one-click | live | On demand | — | [../deploy/cosmos/README.md](../deploy/cosmos/README.md) |
| Dokploy template catalog | PaaS & one-click | live | On demand | [link](https://templates.dokploy.com) | [../deploy/dokploy/README.md](../deploy/dokploy/README.md) |
| Fly.io launch config (repo fly.toml) | PaaS & one-click | live | On demand | — | [FLY.md](FLY.md) |
| Koyeb deploy button (repo README) | PaaS & one-click | live | On demand | — | [../deploy/koyeb/README.md](../deploy/koyeb/README.md) |
| Kubero template catalog | PaaS & one-click | live | On demand | [link](https://www.kubero.dev/templates) | [../deploy/kubero/README.md](../deploy/kubero/README.md) |
| Railway one-click template | PaaS & one-click | live | On demand | [link](https://railway.com/deploy/libredb-studio) | [../deploy/railway/PUBLISH.md](../deploy/railway/PUBLISH.md) |
| Render Blueprint (repo render.yaml) | PaaS & one-click | live | On demand | [link](https://render.com/deploy?repo=https://github.com/libredb/libredb-studio) | [DISTRIBUTION.md](DISTRIBUTION.md) |
| DigitalOcean Marketplace | Marketplaces & partners | live | On demand | [link](https://marketplace.digitalocean.com/apps/libredb-studio) | [../deploy/digitalocean/README.md](../deploy/digitalocean/README.md) |
| Koyeb One-Click Apps catalog (curated by Koyeb) | Marketplaces & partners | pending | On demand | [link](https://www.koyeb.com/deploy) | [../deploy/koyeb/CATALOG_SUBMISSION.md](../deploy/koyeb/CATALOG_SUBMISSION.md) |
| Flathub community catalog (org.libredb.Studio) | Closed / declined | deprecated | On demand | — | [../packaging/flatpak/README.md](../packaging/flatpak/README.md) |

<!-- END:CHANNEL-TABLE -->

The scorecard and table above are generated from `distribution/channels.yaml`.
Do not edit them by hand — run `bun run distribution:matrix` after inventory
changes. Freshness is checked with `bun run distribution:matrix -- --check`.
