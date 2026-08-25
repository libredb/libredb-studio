# Partner Center listing fields — LibreDB Studio (Azure Application)

Single source of truth for every text field in the offer listing. Copy these
into Partner Center verbatim. Character limits are enforced by tests/unit/build-azure-package.test.ts
via the `<!-- limit:N -->` markers — the line directly below each marker is the
field value, measured in characters (Partner Center counts HTML markup and
spaces too).

## Offer setup (§7.1)

| Field | Value |
|---|---|
| Offer ID | `libredb-studio` (immutable — double-check before saving) |
| Offer alias | `LibreDB Studio (Azure Application)` |

## Properties (§7.2)

| Field | Value |
|---|---|
| Primary category | Developer Tools → Tools |
| Secondary category | Databases → Relational Databases, NoSQL Databases |
| Legal | Standard Contract for Microsoft Marketplace |

## Offer listing

**Name** (limit 200):

<!-- limit:200 -->
LibreDB Studio

**Search results summary** (limit 100):

<!-- limit:100 -->
Open-source SQL IDE for 14 engines: PostgreSQL, MySQL, SQL Server, Oracle, MongoDB, Redis and more

**Short description** (limit 256):

<!-- limit:256 -->
Open-source, self-hosted SQL IDE for cloud-native teams. Fourteen engines - PostgreSQL, MySQL, SQL Server, Oracle, SQLite, MongoDB, Redis, Couchbase, ClickHouse, Druid, Elasticsearch, OpenSearch, Trino, Cassandra - explore and query, with read-only AI.

**Description** (limit 5000, HTML): see [description.html](description.html) —
the limit is asserted by the unit test.

**Search keywords** (max 3):

1. `SQL IDE`
2. `database client`
3. `PostgreSQL`

**Privacy policy link:** `https://libredb.org/privacy-policy`

**Useful links:**

| Name | URL |
|---|---|
| Documentation | `https://github.com/libredb/libredb-studio#readme` |
| Deployment & configuration guide | `https://github.com/libredb/libredb-studio/blob/main/docs/DISTRIBUTION.md` |
| Release notes | `https://github.com/libredb/libredb-studio/releases` |
| Report an issue | `https://github.com/libredb/libredb-studio/issues` |
| Security policy | `https://github.com/libredb/libredb-studio/blob/main/SECURITY.md` |

**Contact information** (portal-only, not stored here): support contact
(name + phone + email, support website `https://github.com/libredb/libredb-studio/issues`)
and engineering contact (name + phone + email; never shown publicly).

## Media (assets/ — to be produced)

| Asset | Requirement | Status |
|---|---|---|
| Large logo | 216×216–350×350 PNG, flat background, no gradient/glow/text | TODO produce `assets/logo-300.png` (brand decision: human) |
| Screenshots ×5 | exactly 1280×720 PNG + caption each | TODO recapture — current `public/screenshots/*.png` are 1440×900 |

Planned captions:

1. `hero-editor` — "Write and run SQL with schema-aware autocomplete and a virtualized result grid."
2. `agent-rail` — "Ask the read-only agent a question; every claim in its answer cites the result it came from."
3. `erd-diagram` — "Explore relationships with an automatically generated ERD."
4. `connection-modal` — "Connect to fourteen engines, from PostgreSQL and SQL Server to Apache Cassandra."
5. `data-profiler` — "Profile table data: distributions, null ratios and outliers at a glance."

## Plan (§7.6)

| Field | Value |
|---|---|
| Plan ID | `single-vm` |
| Plan name | `Single virtual machine` |
| Plan type | Solution template |
| Plan summary | Deploys LibreDB Studio on one Ubuntu 24.04 LTS virtual machine with automatic HTTPS. You pay only for the Azure resources. |
| Version | from `deploy/azure/package-version.txt` |
| Package file | `dist/azure/libredb-studio-azure-<version>.zip` |

## Notes for certification (§7.8)

The full text lives in the plan document, §7.8 — keep it in sync with any
change to the template's network rules, TLS fallback, or outbound endpoints.
