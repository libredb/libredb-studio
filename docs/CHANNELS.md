# Distribution channels

This page is the coverage matrix for LibreDB Studio: every place the product can
be obtained from, which of them are live today, and which platforms they serve.
For install and operate instructions, use [DISTRIBUTION.md](DISTRIBUTION.md). The
machine-readable inventory behind this page is
[`distribution/channels.yaml`](../distribution/channels.yaml).

**Users** — find your platform in the Platform column, then follow the Guide link
for the install or deploy steps.

**Developers** — the Updates column says whether release CI publishes the channel
or a human updates it by hand, and how quickly it is expected to follow a release.
New channels are added in
[`distribution/channels.yaml`](../distribution/channels.yaml).

**Buyers, investors, supporters** — the snapshot below is the coverage claim.
`pending` and `deprecated` rows are listed on purpose, not hidden.

| Status | Meaning |
| --- | --- |
| `live` | Listed and installable (or deployable) through that channel |
| `pending` | Submission or first listing in progress |
| `deprecated` | Closed or declined — kept for honesty (for example Flathub) |

Platform counts cover live channels only, and a channel serving several
platforms is counted once for each — so they overlap, and their sum is not a
channel count.

<!-- BEGIN:CHANNEL-SCORECARD -->

## Coverage snapshot

**32 channels · 22 live · 9 pending · 1 deprecated**

Live channels by platform: **Linux 7 · macOS 3 · Windows 3 · Container 3 · Kubernetes 1 · Cloud 10**

| Category | Live | Pending | Deprecated |
| --- | ---: | ---: | ---: |
| Registries & releases | 2 | 0 | 0 |
| Containers | 2 | 0 | 0 |
| Kubernetes & operators | 1 | 2 | 0 |
| Package managers | 4 | 1 | 1 |
| OS / desktop packages | 2 | 0 | 0 |
| PaaS catalogs (listed) | 7 | 5 | 0 |
| Deploy recipes | 3 | 0 | 0 |
| Cloud marketplaces | 1 | 1 | 0 |

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
| [Chocolatey](https://community.chocolatey.org/packages/libredb-studio) | Package managers | Windows | pending | Automated (paused), every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| Flathub | Package managers | Linux | deprecated | — | [packaging/flatpak/README.md](../packaging/flatpak/README.md) |
| [Desktop app (AppImage, .deb)](https://github.com/libredb/libredb-studio/releases/latest) | OS / desktop packages | Linux | live | Automated, every release | [desktop/README.md](../desktop/README.md) |
| [Linux .deb / .rpm](https://github.com/libredb/libredb-studio/releases/latest) | OS / desktop packages | Linux | live | Automated, every release | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [CapRover official](https://github.com/caprover/one-click-apps) | PaaS catalogs (listed) | Cloud | live | Manual, on demand | [deploy/caprover/README.md](../deploy/caprover/README.md) |
| [Cosmos servapp marketplace](https://github.com/azukaar/cosmos-servapps-official) | PaaS catalogs (listed) | Cloud | live | Manual, on demand | [deploy/cosmos/README.md](../deploy/cosmos/README.md) |
| [Dokploy template catalog](https://templates.dokploy.com) | PaaS catalogs (listed) | Cloud | live | Manual, on demand | [deploy/dokploy/README.md](../deploy/dokploy/README.md) |
| [Kubero template catalog](https://www.kubero.dev/templates) | PaaS catalogs (listed) | Cloud | live | Manual, on demand | [deploy/kubero/README.md](../deploy/kubero/README.md) |
| [Railway one-click template](https://railway.com/deploy/libredb-studio) | PaaS catalogs (listed) | Cloud | live | Manual, on demand | [deploy/railway/PUBLISH.md](../deploy/railway/PUBLISH.md) |
| [Sealos App Store template](https://sealos.io/products/app-store/libredb-studio) | PaaS catalogs (listed) | Cloud | live | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Unraid Community Apps](https://ca.unraid.net/apps/libredb-studio-0a5x41a1cy1kay) | PaaS catalogs (listed) | Container | live | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [CasaOS App Store](https://github.com/IceWhaleTech/CasaOS-AppStore) | PaaS catalogs (listed) | Container | pending | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Easypanel template catalog](https://easypanel.io/templates) | PaaS catalogs (listed) | Cloud | pending | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Portainer app templates](https://github.com/portainer/templates) | PaaS catalogs (listed) | Container | pending | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [TrueNAS SCALE apps](https://github.com/truenas/apps) | PaaS catalogs (listed) | Container | pending | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Umbrel App Store](https://github.com/getumbrel/umbrel-apps) | PaaS catalogs (listed) | Container | pending | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [Fly.io launch config](https://github.com/libredb/libredb-studio/blob/main/fly.toml) | Deploy recipes | Cloud | live | Manual, on demand | [FLY.md](FLY.md) |
| [Koyeb deploy button](https://github.com/libredb/libredb-studio/tree/main/deploy/koyeb) | Deploy recipes | Cloud | live | Manual, on demand | [deploy/koyeb/README.md](../deploy/koyeb/README.md) |
| [Render Blueprint](https://github.com/libredb/libredb-studio/blob/main/render.yaml) | Deploy recipes | Cloud | live | Manual, on demand | [DISTRIBUTION.md](DISTRIBUTION.md) |
| [DigitalOcean Marketplace](https://marketplace.digitalocean.com/apps/libredb-studio) | Cloud marketplaces | Cloud | live | Manual, on demand | [deploy/digitalocean/README.md](../deploy/digitalocean/README.md) |
| [Koyeb One-Click Apps catalog](https://www.koyeb.com/deploy) | Cloud marketplaces | Cloud | pending | Manual, on demand | [deploy/koyeb/CATALOG_SUBMISSION.md](../deploy/koyeb/CATALOG_SUBMISSION.md) |

<!-- END:CHANNEL-TABLE -->

The scorecard and table above are generated from
[`distribution/channels.yaml`](../distribution/channels.yaml). Do not edit them by
hand. To propose a new channel, add an entry with a `category` and a `platforms`
list, then run `bun run distribution:matrix`. Freshness is enforced on pull
requests with `bun run distribution:matrix --check`.

Planned and deliberately not counted here until a listing exists: GCP, Azure, AWS
and Alibaba cloud marketplaces, and Coolify, Portainer and Dokku deploy support.
