# SUSE Partner Certification & Solutions Catalog — Listing Content

Canonical listing content for LibreDB Studio in the SUSE Partner Certification &
Solutions Catalog (PCSC), requested by SUSE as part of the SUSE Ready for Rancher
certification (see rancher/partner-charts#1158 and tracking issue #166). This file is
the single source for the catalog text; the partner-charts `app-readme.md` overlay is
refreshed from it, most recently on 2026-08-18 (see the delivery note at the end).
`E2E_VALIDATION_TASK.md` covers the validation side.

The listing is live at https://www.suse.com/pcsc/viewVersionPage?versionID=26969 (SUSE
published it on 2026-08-05 from an earlier revision of this file). Edits here do not
propagate automatically — SUSE owns the page, so any change has to be mailed to the
partner contact.

> **Accuracy gate — engine count.** The wording below says ten engines. That is true
> from **0.11.0** onwards, the first release shipping ClickHouse and Apache Druid
> alongside the other eight (PostgreSQL, MySQL, Oracle, SQL Server, SQLite, MongoDB,
> Redis, Couchbase); the provider registry in `src/lib/db/factory.ts` at that tag
> resolves all ten. The catalog entry is version-scoped, so do not publish the
> ten-engine wording against a version older than 0.11.0 — send the eight-engine
> variant instead.
>
> **The count is now fourteen on `main`, and that wording waits for a release.**
> Elasticsearch, OpenSearch and Apache Trino shipped on `main` with
> [#424](https://github.com/libredb/libredb-studio/issues/424) Phases 1 and 2, and Apache
> Cassandra with Phase 4; all four are in the `SHIPPED` record in
> `src/lib/db/compatibility.ts`, but the catalog page describes a released version. So the
> prose below stays at ten until a tag carries them, and then both the short and long
> descriptions gain "Elasticsearch, OpenSearch, Apache Trino and Apache Cassandra" and the
> feature bullet becomes fourteen. Read the number from `SHIPPED` (minus
> the embedded `libredb`) rather than from this file, and state the scope with it: on the
> two search engines LibreDB Studio queries and browses — their SQL has no `INSERT`,
> `UPDATE` or `CREATE TABLE` — so "manage data across …" must not be extended to include
> them.
>
> The chart's own `description` in `Chart.yaml` names thirteen and **has not been updated
> for Cassandra**, deliberately: `charts/libredb-studio/` is a packaged path, so editing it
> requires a `Chart.yaml` version bump in the same PR (#167's required check) plus the
> README `--version` examples and the `operator/helm-charts` mirror. That is a
> release-coupled change and it belongs to whoever cuts the next chart, not to the PR that
> added the engine. The same applies to every marketplace and packaging description that
> spells the count (`deploy/azure`, `deploy/railway`, `deploy/caprover`, `packaging/*`,
> `desktop/src-tauri/tauri.conf.json`, the operator CSVs): all of them describe a released
> artifact. Read the number from `SHIPPED` when you update them.

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

Re-checked against the live page on 2026-08-18. Nothing has been applied since the page
went live on 2026-08-05, so all of these are still open; batch them into one mail to the
partner contact rather than sending them one at a time.

| Field on the page | Published value | Should be |
|---|---|---|
| Version | LibreDB Studio 0.9.44 | 0.11.0, with the release link pointing at <https://github.com/libredb/libredb-studio/releases/tag/0.11.0> |
| Key features | "Seven database engines" | ten — the accuracy gate above is satisfied as of 0.11.0 |
| Short and long description | the pre-0.11.0 revision, which names seven engines | the text in this file |
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

**2026-08-18.** rancher/partner-charts#1158 was rebased onto the current `main-source`
and regenerated against chart 0.1.36 / appVersion 0.11.0. The original 0.1.3 submission
was dropped rather than carried alongside: it pinned appVersion 0.9.44 and the
pre-Couchbase app-readme, so merging it would have offered a months-old version in the
Rancher catalog. The overlay in that PR now carries the ten-engine wording from this
file. The corrections above have **not** been mailed to SUSE yet.

Vendor naming, as settled: the page heads the partner as **Sekoya** (the legal entity,
Sekoya Grup Bilisim ve Teknoloji Ltd. Sti.) with the product named **LibreDB Studio**.
We had asked for the vendor line to read LibreDB; the split SUSE applied achieves the
same thing — brand on the product, certification on the company — so it is accepted and
not worth re-litigating.
