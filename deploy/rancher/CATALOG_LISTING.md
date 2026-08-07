# SUSE Partner Certification & Solutions Catalog — Listing Content

Canonical listing content for LibreDB Studio in the SUSE Partner Certification &
Solutions Catalog (PCSC), requested by SUSE as part of the SUSE Ready for Rancher
certification (see rancher/partner-charts#1158 and tracking issue #166). This file is
the single source for the catalog text; the partner-charts `app-readme.md` overlay is
refreshed from it during the Phase-2 resubmission (see `E2E_VALIDATION_TASK.md` for the
validation side).

The listing is live at https://www.suse.com/pcsc/viewVersionPage?versionID=26969 (SUSE
published it on 2026-08-05 from an earlier revision of this file). Edits here do not
propagate automatically — SUSE owns the page, so any change has to be mailed to the
partner contact.

> **Accuracy gate — engine count.** The wording below says ten engines. That is true
> from the first release containing ClickHouse and Apache Druid onwards; both are merged
> on `main` but unreleased as of **0.9.66**, which ships eight (PostgreSQL, MySQL,
> Oracle, SQL Server, SQLite, MongoDB, Redis, Couchbase). The catalog entry is
> version-scoped, so do not publish the ten-engine wording against a version older than
> that — send the eight-engine variant instead, or cut the release first.

## Listing facts

| Field | Value |
|-------|-------|
| Product name | LibreDB Studio |
| Vendor (public listing) | LibreDB — as published, the page heads the partner as **Sekoya** with the product as LibreDB Studio |
| Partner of record (legal entity) | Sekoya Grup Bilisim ve Teknoloji Ltd. Sti., Istanbul, Turkiye |
| Category | Data Management & Analysis (assigned by SUSE; we had proposed Database / Developer Tools) |
| License | MIT (open source) |
| Specialization | SUSE One — INNOVATE |
| Certification | SUSE Ready, Platform: SUSE Rancher — granted, live since 2026-08-05 |
| Catalog listing | https://www.suse.com/pcsc/viewVersionPage?versionID=26969 |
| Website | https://libredb.org |
| Source | https://github.com/libredb/libredb-studio |
| Helm repository | https://libredb.org/libredb-studio/ (also OCI: `oci://ghcr.io/libredb/charts/libredb-studio`) |
| Container image | `ghcr.io/libredb/libredb-studio` (GHCR, linux/amd64 + linux/arm64) |
| Rancher support documentation | https://github.com/libredb/libredb-studio/blob/main/docs/RANCHER.md |
| Support | Commercial support by the vendor on the documented Rancher / RKE2 / K3s / Kubernetes versions |

## Short description (one sentence)

LibreDB Studio is an MIT-licensed, AI-assisted open source SQL IDE that connects to
PostgreSQL, MySQL, Oracle, SQL Server, SQLite, MongoDB, Redis, Couchbase, ClickHouse and
Apache Druid directly from the browser.

## Long description

LibreDB Studio brings a full SQL IDE to Rancher-managed Kubernetes clusters: browse
schemas, run queries, and manage data across PostgreSQL, MySQL, Oracle, SQL Server,
SQLite, MongoDB, Redis, Couchbase, ClickHouse and Apache Druid from a single web
interface, with no desktop client to install. An optional AI assistant (bring your own
key: Gemini, OpenAI, or a local model) writes and explains SQL from natural language and
stays off unless configured.

The Helm chart installs from the Rancher Apps catalog with default values: first-run
admin credentials are generated automatically and printed to the pod log, so a working
instance is one click away, while production installs can supply their own secrets, an
existing Kubernetes Secret, or strict fail-closed mode. LibreDB Studio runs entirely
on your own infrastructure, supports linux/amd64 and linux/arm64, and is developed and
commercially supported by the LibreDB team. Supported Rancher, RKE2/K3s and Kubernetes
versions are documented and validated for every release.

## Key features (bullet form, if the catalog template asks for them)

- Ten database engines in one browser-based IDE: PostgreSQL, MySQL, Oracle,
  SQL Server, SQLite, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid
- One-click install from the Rancher Apps catalog — deployable with default values,
  zero configuration required
- Optional AI query assistance (Gemini, OpenAI, or a self-hosted model; off by
  default)
- Hardened chart defaults: non-root, read-only root filesystem, NetworkPolicy, PDB,
  HPA, Ingress/TLS
- Self-hosted and air-gap friendly: no external services required to operate the IDE
- Multi-arch images (amd64/arm64), documented supported-version matrix, fully
  automated and self-verifying release pipeline

## Outstanding corrections to the published page

Checked against the live page on 2026-08-07. These are deltas between what SUSE
published and what is true today; batch them into one mail to the partner contact rather
than sending them one at a time.

| Field on the page | Published value | Should be |
|---|---|---|
| Version | LibreDB Studio 0.9.44 | the current release (0.9.66 or later), with the release link updated to match |
| Key features | "Seven database engines" | see the accuracy gate above — eight today, ten once ClickHouse and Druid ship |
| Hardware Architecture | x86-64 | x86-64 and Arm64 (`ghcr.io/libredb/libredb-studio` is linux/amd64 + linux/arm64) |

Two open questions for the same mail: whether the version field can track the latest
release or whether certification is bound to a specific version, and which exact
certification wording and imagery we may reuse in our own README, docs and website.
Until that is answered, our public copy states only what the listing itself states and
links to it — no badge, no logo.

## Delivery note

The content above was delivered to Troy Topnik (SUSE) and published on 2026-08-05; he
fitted as much of the long description as the page template allows. This file stays the
canonical wording: any future edit happens here first, then goes to SUSE by mail and to
the partner-charts `app-readme.md` overlay.

Vendor naming, as settled: the page heads the partner as **Sekoya** (the legal entity,
Sekoya Grup Bilisim ve Teknoloji Ltd. Sti.) with the product named **LibreDB Studio**.
We had asked for the vendor line to read LibreDB; the split SUSE applied achieves the
same thing — brand on the product, certification on the company — so it is accepted and
not worth re-litigating.
