# SUSE Partner Certification & Solutions Catalog — Listing Content

Canonical listing content for LibreDB Studio in the SUSE Partner Certification &
Solutions Catalog (PCSC), requested by SUSE as part of the SUSE Ready for Rancher
certification (see rancher/partner-charts#1158 and tracking issue #166). This file is
the single source for the catalog text; the partner-charts `app-readme.md` overlay is
refreshed from it during the Phase-2 resubmission (see `E2E_VALIDATION_TASK.md` for the
validation side).

## Listing facts

| Field | Value |
|-------|-------|
| Product name | LibreDB Studio |
| Vendor (public listing) | LibreDB |
| Partner of record (legal entity) | Sekoya Grup Bilisim ve Teknoloji Ltd. Sti., Istanbul, Turkiye |
| Category | Database / Developer Tools |
| License | MIT (open source) |
| Specialization | SUSE One — INNOVATE |
| Certification | SUSE Ready for Rancher (in progress) |
| Website | https://libredb.org |
| Source | https://github.com/libredb/libredb-studio |
| Helm repository | https://libredb.org/libredb-studio/ (also OCI: `oci://ghcr.io/libredb/charts/libredb-studio`) |
| Container image | `ghcr.io/libredb/libredb-studio` (GHCR, linux/amd64 + linux/arm64) |
| Rancher support documentation | https://github.com/libredb/libredb-studio/blob/main/docs/RANCHER.md |
| Support | Commercial support by the vendor on the documented Rancher / RKE2 / K3s / Kubernetes versions |

## Short description (one sentence)

LibreDB Studio is an MIT-licensed, AI-assisted open source SQL IDE that connects to
PostgreSQL, MySQL, Oracle, SQL Server, SQLite, MongoDB and Redis directly from the
browser.

## Long description

LibreDB Studio brings a full SQL IDE to Rancher-managed Kubernetes clusters: browse
schemas, run queries, and manage data across PostgreSQL, MySQL, Oracle, SQL Server,
SQLite, MongoDB and Redis from a single web interface, with no desktop client to
install. An optional AI assistant (bring your own key: Gemini, OpenAI, or a local
model) writes and explains SQL from natural language and stays off unless configured.

The Helm chart installs from the Rancher Apps catalog with default values: first-run
admin credentials are generated automatically and printed to the pod log, so a working
instance is one click away, while production installs can supply their own secrets, an
existing Kubernetes Secret, or strict fail-closed mode. LibreDB Studio runs entirely
on your own infrastructure, supports linux/amd64 and linux/arm64, and is developed and
commercially supported by the LibreDB team. Supported Rancher, RKE2/K3s and Kubernetes
versions are documented and validated for every release.

## Key features (bullet form, if the catalog template asks for them)

- Seven database engines in one browser-based IDE: PostgreSQL, MySQL, Oracle,
  SQL Server, SQLite, MongoDB, Redis
- One-click install from the Rancher Apps catalog — deployable with default values,
  zero configuration required
- Optional AI query assistance (Gemini, OpenAI, or a self-hosted model; off by
  default)
- Hardened chart defaults: non-root, read-only root filesystem, NetworkPolicy, PDB,
  HPA, Ingress/TLS
- Self-hosted and air-gap friendly: no external services required to operate the IDE
- Multi-arch images (amd64/arm64), documented supported-version matrix, fully
  automated and self-verifying release pipeline

## Delivery note

Troy Topnik (SUSE) offered to lift the listing content from the website, the GitHub
README, or the PR's `app-readme.md`. Hand him this file's Short description, Long
description, and Listing facts instead — it is the reviewed, canonical wording. Any
future edit happens here first, then propagates to the partner-charts overlay.

Vendor naming: our preference is that the public listing shows the vendor as
**LibreDB** (the brand users see on the chart, the Helm repo, and GitHub), while the
certification and partner record are attached to the legal entity, Sekoya Grup Bilisim
ve Teknoloji Ltd. Sti. This mirrors the accepted pattern in rancher/partner-charts
(e.g. OpenBao listed under the brand while the certification is held by the backing
company).
