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

> **Accuracy gate — engine count.** The wording below says fourteen engines. That is true
> from **0.13.0** onwards, the release that carried Elasticsearch, OpenSearch, Apache Trino
> and Apache Cassandra ([#424](https://github.com/libredb/libredb-studio/issues/424) Phases
> 1, 2 and 4) alongside the ten of 0.11.0. The number is the `SHIPPED` record in
> `src/lib/db/compatibility.ts` minus the embedded `libredb`, which `EXTERNAL` in the same
> file already splits out; read it from there rather than from this file. The catalog entry
> is version-scoped, so do not publish the fourteen-engine wording against a version older
> than 0.13.0 — send the ten-engine variant (0.11.0 onwards) or the eight-engine one instead.
>
> **The scope goes with the count.** Browsing and querying reach all fourteen; editing data does
> not, so "manage data across …" must never be written over the whole list. Read the split from
> the providers: `supportsInlineRowEdit` and `supportsCreateTable` default to `true` in
> `src/lib/db/base-provider.ts` and each provider that cannot turns them off, which leaves inline
> row editing on PostgreSQL, MySQL, Oracle, SQL Server and SQLite, and table creation on those
> five plus Apache Trino. Every other engine — Cassandra, ClickHouse, Couchbase, Druid,
> Elasticsearch, MongoDB, OpenSearch and Redis — reports those controls as unsupported. The
> reason differs per engine and the copy must not flatten it: on Elasticsearch no mutation is in
> the SQL grammar at all, while OpenSearch's grammar carries exactly one — `DELETE`, off by
> default on the cluster (`docs/providers/opensearch.md` §5.6, and `SEARCH_SCHEMA_REFRESH_PATTERN`
> in the provider exists for it) — so "the two search engines accept no mutation at all" is false
> of the fork and must never be written over the pair. Both refuse `CREATE TABLE` and `UPDATE`
> with HTTP 400, and the error names the PRODUCT rather than the statement: Elasticsearch answers
> `parsing_exception` to both, OpenSearch `SQLFeatureNotSupportedException` to both — see the
> header of `src/lib/db/providers/sql/search/index.ts`, points 2 and the `DELETE` note at
> line 183. On Druid the true sentence is the one `docs/providers/druid.md` and the README both
> carry: Druid SQL has no `UPDATE`, no `DELETE` and no `CREATE TABLE`. "Druid has no `INSERT`" is
> false — `INSERT` and `REPLACE` exist there through the MSQ task engine, on an endpoint this
> provider does not use (`docs/providers/druid.md` §5.5).
>
> **Accuracy gate — AI wording.** Natural-language-to-SQL was removed from the product, so
> no listing may say the assistant writes SQL from a plain-English question. What ships is
> AI query *explanation*, and it is **not** available on any connection: the write-up is
> derived from the engine's own `EXPLAIN` plan, and `src/components/studio/BottomPanel.tsx`
> drops the Explain tab unless the provider declares `explainFormat`. Seven do — PostgreSQL,
> MySQL, SQLite, Couchbase, ClickHouse, Apache Druid and Apache Trino — so name that set rather
> than a count, and check it by grepping `explainFormat:` under `src/lib/db/providers/` rather
> than by trusting this line. Alongside it is the read-only agent rail
> ([`docs/AGENT.md`](https://github.com/libredb/libredb-studio/blob/main/docs/AGENT.md)),
> which executes statements on PostgreSQL and SQLite only (`queryReadOnly` exists on those
> two providers alone) in a session the database enforces as read-only. "Executes nothing it
> recommends" is an overclaim this product already rejected: the consented editor hand-over
> runs exactly the recommended statement
> (`src/app/api/agent/runs/[runId]/handover/route.ts` calls `queryReadOnly(answer.sql, …)`).
> `src/lib/agent/posture.ts` carries the wording settled in #449 and a listing may reuse it as
> written: plan mode "executes nothing it **drafts**", and the consented hand-over is "reads
> only, and one statement in your editor". "Never writes" and "read-only" stay accurate and
> are enough on their own.
>
> **The chart's own `description` is not release-coupled and does name Cassandra.** An
> earlier revision of this note said it deliberately did not, on the reasoning that
> `charts/libredb-studio/` is a packaged path and editing it drags in a `Chart.yaml` version
> bump (#167's required check), the README `--version` examples and the `operator/helm-charts`
> mirror. Those four edits are the cost, not a reason to defer: the chart has been carried
> with the engine since [#438](https://github.com/libredb/libredb-studio/pull/438), which
> moved the description to thirteen and 0.1.39 to 0.1.40 in the PR that added Trino. Cassandra
> followed the same path at chart 0.1.43. So a PR that adds an engine updates all four files;
> it does not hand them to whoever cuts the next chart. Note the mirror must stay
> byte-identical — run `bun run chart:bump` rather than editing
> `operator/helm-charts/libredb-studio/` by hand, or the sync guard fails the required check.
>
> What *is* release-coupled is every marketplace description that spells the count:
> `deploy/azure`, `deploy/railway` and `deploy/caprover` all say fourteen as of 2026-08-25 -
> `deploy/railway/template.json` and `deploy/caprover/libredb-studio.yml` were still on
> thirteen after the prose files had moved, because each channel spells the count in a second
> file nobody reads while editing the first. Each of these describes an artifact a user can
> already download, so the number has to be true at the tag it names.
> Read the number from `SHIPPED` when a tag carries it. Two groups are no longer in that set.
> `packaging/winget`, `packaging/chocolatey`, `packaging/homebrew` and
> `desktop/src-tauri/tauri.conf.json` now carry **no number at all** - nothing regenerates them
> from the registry, so any digit in them is stale the day the next engine lands (issue #445).
> And `packaging/linux/nfpm.yaml` and the operator CSVs are consumed at release time from
> `main`, so they name fourteen now and the next tag publishes it.

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
PostgreSQL, MySQL, Oracle, SQL Server, SQLite, MongoDB, Redis, Couchbase, ClickHouse,
Apache Druid, Elasticsearch, OpenSearch, Apache Trino and Apache Cassandra directly from
the browser.

## Long description

LibreDB Studio brings a full SQL IDE to Rancher-managed Kubernetes clusters: browse
schemas and run queries across PostgreSQL, MySQL, Oracle, SQL Server, SQLite, MongoDB,
Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino and
Apache Cassandra from a single web interface, with no desktop client to install. Editing
data follows the engine rather than the IDE: inline row editing on PostgreSQL, MySQL,
Oracle, SQL Server and SQLite, table creation on those five and Apache Trino, and
everywhere else the controls are reported as unsupported rather than offered and then
failed — Elasticsearch SQL has no mutation in its grammar at all, OpenSearch's one
mutation (`DELETE`) is off by default, and Druid SQL has no `UPDATE`, no `DELETE` and no
`CREATE TABLE`. An optional AI assistant (bring your own key: Gemini, OpenAI, or a local
model) writes up a query in plain English from the engine's own EXPLAIN plan, on
PostgreSQL, MySQL, SQLite, Couchbase, ClickHouse, Apache Druid and Apache Trino — the
engines that return one — and runs a read-only investigation agent on PostgreSQL and
SQLite whose every claim cites the result it came from, and that never writes: the session
is read-only and the database, not the IDE, refuses writes and DDL. It stays off unless
configured.

The Helm chart installs from the Rancher Apps catalog with default values: first-run
admin credentials are generated automatically and printed to the pod log, so a working
instance is one click away, while production installs can supply their own secrets, an
existing Kubernetes Secret, or strict fail-closed mode. LibreDB Studio runs entirely
on your own infrastructure, supports linux/amd64 and linux/arm64, and is developed and
commercially supported by the LibreDB team. Supported Rancher, RKE2/K3s and Kubernetes
versions are documented and validated for every release.

## Key features (bullet form, if the catalog template asks for them)

- Fourteen database engines in one browser-based IDE: PostgreSQL, MySQL, Oracle,
  SQL Server, SQLite, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid,
  Elasticsearch, OpenSearch, Apache Trino, Apache Cassandra
- One-click install from the Rancher Apps catalog — deployable with default values,
  zero configuration required
- Optional AI assistance (Gemini, OpenAI, or a self-hosted model; off by default):
  plain-English query explanation on the engines that return an EXPLAIN plan (PostgreSQL,
  MySQL, SQLite, Couchbase, ClickHouse, Apache Druid, Apache Trino), and a read-only
  investigation agent on PostgreSQL and SQLite that never writes — the database enforces
  the read-only session, not the IDE
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
| Version | LibreDB Studio 0.9.44 | 0.13.4, with the release link pointing at <https://github.com/libredb/libredb-studio/releases/tag/0.13.4> — the fourteen-engine wording in this file needs 0.13.0 or later |
| Key features | "Seven database engines" | fourteen — the accuracy gate above is satisfied as of 0.13.0 |
| Short and long description | the pre-0.11.0 revision, which names seven engines and an AI that writes SQL from natural language | the text in this file — fourteen engines, and no natural-language-to-SQL claim: that feature was removed from the product |
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
