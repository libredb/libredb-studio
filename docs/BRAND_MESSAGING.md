# LibreDB Brand Messaging

The messaging architecture marketing teams work from: what LibreDB claims, who it says it to, what backs each claim, and what it will not say.

## Proof library

Every promise in this brief resolves to a row below. A claim with no row here does not enter the brief — it is dropped rather than softened.

Facts drift. Provider counts, channel counts and competitor editions all change, so each row carries the date it was checked. A row whose date has gone stale is unverified, not true.

### LibreDB Studio

| Claim | Evidence | Source | Verified |
| :--- | :--- | :--- | :--- |
| Ten database engines | One reference document per engine: PostgreSQL, MySQL, Oracle, SQL Server, SQLite, MongoDB, Redis, Couchbase, ClickHouse, Druid. An eleventh, `libredb.md`, is the embedded provider and is not an external engine | `docs/providers/` | 2026-08-07 |
| Published as an embeddable npm package | `"name": "@libredb/studio"`, version 0.9.66 | `package.json` | 2026-08-07 |
| MIT licensed | "MIT License / Copyright (c) 2025 LibreDB" | `LICENSE` | 2026-08-07 |
| 27 distribution channels, 22 live | "27 channels · 22 live · 4 pending · 1 deprecated" | `docs/CHANNELS.md` | 2026-08-07 |
| 100% line coverage enforced as a CI gate | `coverage:check` runs `scripts/check-coverage.mjs` against the merged lcov | `package.json` | 2026-08-07 |
| Deployable to Kubernetes and OpenShift | Helm chart and OLM operator bundle both present | `charts/libredb-studio/Chart.yaml`, `operator/bundle/` | 2026-08-07 |
| OIDC single sign-on | Vendor-agnostic OIDC client with PKCE | `src/lib/oidc.ts` | 2026-08-07 |
| Audit trail of executed queries | Admin-only audit view backed by the storage layer | `src/components/admin/tabs/AuditTab.tsx` | 2026-08-07 |
| Display masking is a presentation-layer feature | Masking is implemented in `src/lib/data-masking.ts` and applied by UI components only. The string `mask` does not occur anywhere under `src/app/api`, so the API returns full values to an authorized user | `src/lib/data-masking.ts`; absence verified across `src/app/api/` | 2026-08-07 |

### CloudBeaver

Comparison runs on license and feature scope only, always against a primary source. Competitor defects, performance complaints and community friction are never used.

| Claim | Evidence | Source | Verified |
| :--- | :--- | :--- | :--- |
| Community Edition is Apache-2.0 | "It is free to use and open-source (licensed under Apache 2 license)" | `github.com/dbeaver/cloudbeaver` README | 2026-08-07 |
| Community Edition bundles 18 driver modules covering 15 distinct engines, all SQL | `clickhouse_com, databend, db2, db2-jt400, duckdb, h2, h2_v2, h2_v3, jaybird, kyuubi, libsql, mariadb, mysql, oracle, postgresql, sqlite, sqlserver, trino` | `dbeaver/cloudbeaver` `server/drivers/` | 2026-08-07 |
| No MongoDB and no Redis in the Community Edition | Neither appears in the bundled driver set above. The vendor's own editions page states Community works with SQL databases while Enterprise works with SQL, NoSQL and Cloud | `dbeaver/cloudbeaver` `server/drivers/`; dbeaver.com editions page | 2026-08-07 |
| Single sign-on is not in the Community Edition | Community supports anonymous, local and reverse-proxy authentication. SSO and OpenID Connect are listed under Enterprise and AWS editions | dbeaver.com, Authentication methods | 2026-08-07 |
| ER diagrams are not in the Community Edition | "Available only in PRO" | `dbeaver/cloudbeaver` wiki, Entity Diagrams | 2026-08-07 |
| The AI assistant is not in the Community Edition | The AI-powered assistant is listed as a CloudBeaver Enterprise capability | dbeaver.com, CloudBeaver Enterprise | 2026-08-07 |
| No npm package | `registry.npmjs.org/cloudbeaver` returns HTTP 404 | npm registry | 2026-08-07 |
| The only official Helm chart targets the Enterprise image | "# Default values for cloudbeaver-ee." and `image: dbeaver/cloudbeaver-ee` | `dbeaver/cloudbeaver-deploy` `k8s/values.yaml.example` | 2026-08-07 |
| LDAP is not listed under the Community Edition | LDAP appears only in the Enterprise Edition authentication documentation | dbeaver.com, Authentication methods | 2026-08-07 |

### Claims that were checked and dropped

Recorded so they are not reintroduced later from memory.

| Dropped claim | Why |
| :--- | :--- |
| "CloudBeaver Community has LDAP, LibreDB does not" | Current documentation lists LDAP under the Enterprise Edition only. The half about LibreDB stands and appears in the honesty limits; the half about CloudBeaver is no longer verifiable and is not used |
| "Issue #3961 proves NoSQL is unavailable in the Community Edition" | The issue is a driver-configuration question, not an availability statement. The bundled driver set is the evidence instead |
