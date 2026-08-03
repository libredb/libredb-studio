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

Live channels by platform: **Linux 7 · macOS 3 · Windows 3 · Container 2 · Kubernetes 1 · Cloud 11**

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

<!-- END:CHANNEL-SCORECARD -->

## All channels

<!-- BEGIN:CHANNEL-TABLE -->

| Channel | Category | Platform | Status | Updates | Guide |
| --- | --- | --- | --- | --- | --- |
| [GitHub Releases](https://github.com/libredb/libredb-studio/releases) | Registries & releases | Linux, macOS, Windows | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [npm @libredb/studio](https://www.npmjs.com/package/@libredb/studio) | Registries & releases | Linux, macOS, Windows | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Docker image (GHCR)](https://github.com/libredb/libredb-studio/pkgs/container/libredb-studio) | Containers | Container | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Docker Hub mirror](https://hub.docker.com/r/libredb/libredb-studio) | Containers | Container | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Helm chart](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio) | Kubernetes & operators | Kubernetes | live | Automated, every release | [HELM_CHART.md](HELM_CHART.md) |
| [OperatorHub / OpenShift](https://github.com/redhat-openshift-ecosystem/community-operators-prod) | Kubernetes & operators | Kubernetes | pending | Manual, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Rancher Partner Charts](https://github.com/rancher/partner-charts) | Kubernetes & operators | Kubernetes | pending | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [FlatPark (Flatpak)](https://flatpark.org/) | Package managers | Linux | live | Manual, every release | [packaging/flatpark/README.md](../packaging/flatpark/README.md) |
| [Homebrew tap](https://github.com/libredb/homebrew-tap) | Package managers | Linux, macOS | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Snap Store](https://snapcraft.io/libredb-studio) | Package managers | Linux | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [winget](https://github.com/microsoft/winget-pkgs/tree/master/manifests/l/LibreDB/Studio) | Package managers | Windows | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Chocolatey](https://community.chocolatey.org/packages/libredb-studio) | Package managers | Windows | pending | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Desktop app (AppImage, .deb)](https://github.com/libredb/libredb-studio/releases/latest) | OS / desktop packages | Linux | live | Automated, every release | [desktop/README.md](../desktop/README.md) |
| [Linux .deb / .rpm](https://github.com/libredb/libredb-studio/releases/latest) | OS / desktop packages | Linux | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [CapRover template (in-repo)](https://github.com/libredb/libredb-studio/tree/main/deploy/caprover) | PaaS & one-click | Cloud | live | Manual, on demand | [deploy/caprover/README.md](../deploy/caprover/README.md) |
| [CapRover 3rd-party repo](https://libredb.org/caprover-one-click-apps) | PaaS & one-click | Cloud | live | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [CapRover official](https://github.com/caprover/one-click-apps) | PaaS & one-click | Cloud | live | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Cosmos servapp marketplace](https://github.com/azukaar/cosmos-servapps-official) | PaaS & one-click | Cloud | live | Manual, on demand | [deploy/cosmos/README.md](../deploy/cosmos/README.md) |
| [Dokploy template catalog](https://templates.dokploy.com) | PaaS & one-click | Cloud | live | Manual, on demand | [deploy/dokploy/README.md](../deploy/dokploy/README.md) |
| [Fly.io launch config](https://github.com/libredb/libredb-studio/blob/main/fly.toml) | PaaS & one-click | Cloud | live | Manual, on demand | [FLY.md](FLY.md) |
| [Koyeb deploy button](https://github.com/libredb/libredb-studio/tree/main/deploy/koyeb) | PaaS & one-click | Cloud | live | Manual, on demand | [deploy/koyeb/README.md](../deploy/koyeb/README.md) |
| [Kubero template catalog](https://www.kubero.dev/templates) | PaaS & one-click | Cloud | live | Manual, on demand | [deploy/kubero/README.md](../deploy/kubero/README.md) |
| [Railway one-click template](https://railway.com/deploy/libredb-studio) | PaaS & one-click | Cloud | live | Manual, on demand | [deploy/railway/PUBLISH.md](../deploy/railway/PUBLISH.md) |
| [Render Blueprint](https://render.com/deploy?repo=https://github.com/libredb/libredb-studio) | PaaS & one-click | Cloud | live | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [DigitalOcean Marketplace](https://marketplace.digitalocean.com/apps/libredb-studio) | Marketplaces & partners | Cloud | live | Manual, on demand | [deploy/digitalocean/README.md](../deploy/digitalocean/README.md) |
| [Koyeb One-Click Apps catalog](https://www.koyeb.com/deploy) | Marketplaces & partners | Cloud | pending | Manual, on demand | [deploy/koyeb/CATALOG_SUBMISSION.md](../deploy/koyeb/CATALOG_SUBMISSION.md) |
| Flathub | Closed / declined | Linux | deprecated | — | [packaging/flatpak/README.md](../packaging/flatpak/README.md) |

<!-- END:CHANNEL-TABLE -->

The scorecard and table above are generated from `distribution/channels.yaml`.
Do not edit them by hand — run `bun run distribution:matrix` after inventory
changes. Freshness is checked with `bun run distribution:matrix -- --check`.
