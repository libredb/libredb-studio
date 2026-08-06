# LibreDB Brand Messaging

The messaging architecture marketing teams work from: what LibreDB claims, who it says it to, what backs each claim, and what it will not say.

## Positioning statement

> For engineering teams whose databases live in the cloud, LibreDB Studio is the database editor that deploys next to the data instead of onto your laptop: one browser tab for PostgreSQL, MySQL, Oracle, SQL Server, MongoDB, Redis, SQLite, Couchbase, ClickHouse and Druid, with SSO and audit built in, under MIT with nothing held back.

One sentence, one reference point. Everything else in this brief either supports it or is cut.

## Brand story

### The spark

You create a Postgres on Railway. It is ready in forty seconds.

Then you want to look inside it. So you open the port to the internet, or you install a desktop client and dig an SSH tunnel to reach it, or you give up and drive it from a shell. The database took forty seconds. Opening a window into it takes the rest of the afternoon.

Somewhere in that afternoon the question arrives: why doesn't the database simply come with an editor beside it?

### And it compounds

Now multiply. The team runs Postgres for the application, Mongo for documents, Redis for the cache, ClickHouse for the events. Four databases, four clients, four sets of credentials.

A new engineer joins on Monday. Before writing a line of code they spend their first days working out which data lives where, hunting connection strings across a wiki and three private messages, waiting on VPN access, and installing a different tool per engine. The forty-second problem, times four databases, times everyone on the team.

### What moved, and what stayed

Databases moved. They live in Kubernetes now, in Railway and Dokploy and a managed cloud, in a customer's VPC reached through a jump host.

The tools that read them did not move. They are still desktop applications: heavy, licensed per seat, install-first, built on the assumption of one database, one laptop, and one person who never changes machines.

### The belief

The tool goes to the data. Not the data to the tool.

### What the belief forces

Take it seriously and it stops being a preference. It becomes a specification.

If the editor lives beside the data, it has to run in a browser, because the data is not on your machine and neither are your teammates. It has to reach a phone, because the incident that needs a query does not wait for you to open a laptop. It has to deploy like infrastructure — a container, a Helm chart, an operator, a one-click template — because that is how everything else next to a database gets installed. It has to be embeddable, because the most useful place for an editor is inside the product that created the database.

And it has to be unrestricted. You cannot place a per-seat licensed, feature-gated tool into every environment you own. The moment single sign-on costs extra, the tool stops being deployable by default.

> MIT is not generosity. It is a requirement of the architecture.

### Why the paid Platform is consistent with this

LibreDB Studio is MIT because it has to go everywhere. libredb-platform is paid because it is a service rather than an environment: hosting, tenancy, billing and support for teams that would rather not run Studio themselves.

The line holds under pressure, which is the point. The editor you deploy is free and stays free; what costs money is someone else running it for you. No capability is moved across that line to create a reason to upgrade.

## Messaging house

One umbrella claim, three entry doors into it, three assurance layers underneath.

**Umbrella claim.** The tool deploys next to the data.

**The three doors** are three ways into that one claim. A campaign picks a door. It does not argue all three at once, because a piece that opens on three arguments has opened on none.

1. You created the database. The editor is already beside it.
2. One tab, ten databases.
3. Nothing sits behind an Enterprise wall.

**Door 3 is deliberately third, and stays third.** Leading with it would define LibreDB as another company's opponent rather than as a position of its own, and it would put our credibility at the mercy of their pricing page. Third, the same fact reads as reassurance rather than accusation.

**The three assurances are not entry points.** Nobody arrives because of a test-coverage number. People stay because of one. Assurances belong in the second half of a piece, after a door has already done its work.

## Value propositions

Each door carries five parts. A promise whose proof does not resolve to a row in the proof library is dropped, not softened.

### Door 1 — You created the database. The editor is already beside it.

- **Audience:** a developer running databases on a PaaS or on Kubernetes.
- **Pain:** the database is ready in seconds; reaching it means exposing a port, digging a tunnel, or installing a client on every machine that needs one.
- **Promise:** the editor deploys next to the data, inside the same network, with nothing opened to the outside.
- **Proof:** a one-line container run; a Helm chart and an OLM operator bundle; one-click templates on Railway, Dokploy, CapRover, DigitalOcean and Sealos; `npm i @libredb/studio` to embed it inside your own product.
- **Difference:** the only Helm chart the dbeaver organization publishes defaults to the Enterprise image, and no `cloudbeaver` npm package exists.

This is the sharpest of the three. It is the one claim no competitor can currently make.

### Door 2 — One tab, ten databases.

- **Audience:** teams running more than one kind of database, and the engineers who join them.
- **Pain:** four databases, four clients, four sets of credentials, and a connection-string hunt for anyone new.
- **Promise:** ten engines in one interface, with the same exploration, ER diagrams, schema diff and monitoring across all of them.
- **Proof:** ten providers, each with its own reference document under `docs/providers/`.
- **Difference:** CloudBeaver Community bundles 18 driver modules and every one of them is SQL. MongoDB and Redis are not among them.

The claim here is the span, never the count. See the honesty limits.

### Door 3 — Nothing sits behind an Enterprise wall.

- **Audience:** developers looking for an alternative on GitHub.
- **Pain:** downloading something called open source and finding single sign-on, ER diagrams and the AI assistant behind a licence.
- **Promise:** all of it under MIT, with no capability held back.
- **Proof:** OIDC single sign-on, ER diagrams, AI-assisted SQL and the NoSQL engines all ship in the MIT build.
- **Difference:** in CloudBeaver, single sign-on is Enterprise and AWS only, ER diagrams are "Available only in PRO", the AI assistant is Enterprise, and NoSQL is absent from the Community driver set.

State the four gated capabilities as facts with their sources attached. Never as an accusation.

### Assurance 1 — Governance

For the lead deciding whether a team is allowed to use this. OIDC single sign-on against any compliant provider. Role-based access control separating admin from user. An audit trail of executed queries. Risk analysis before a destructive statement runs. Display masking for screen sharing, within the limits stated below. And deployment inside the network, so no database port has to face outward.

### Assurance 2 — Maturity

For anyone asking whether this is a weekend project. 100% line coverage enforced as a CI gate. MIT. Four releases tagged between 31 July and 3 August 2026. A Helm chart and an OpenShift operator bundle. 27 distribution channels, 22 of them live. Build provenance attestations on published artifacts.

### Assurance 3 — Founder-market fit

Three engineers built this: a data engineer, a backend architect, and a frontend and mobile engineer. Between them they had spent years installing, configuring and working around database tooling before deciding to build the one they actually wanted.

This belongs to the evidence, not the opening. A reader wants to recognise themselves first and trust the author second — put the founders in the first paragraph and the order inverts.

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
| One-click deployment on managed platforms | Railway, Dokploy, CapRover, DigitalOcean and Sealos are listed channels | `docs/CHANNELS.md` | 2026-08-07 |
| Usable from a phone | Dedicated mobile navigation and mobile card and table result views | `src/components/MobileNav.tsx`, `src/components/results-grid/ResultCard.tsx` | 2026-08-07 |
| 100% line coverage enforced as a CI gate | `coverage:check` runs `scripts/check-coverage.mjs` against the merged lcov | `package.json` | 2026-08-07 |
| Deployable to Kubernetes and OpenShift | Helm chart and OLM operator bundle both present | `charts/libredb-studio/Chart.yaml`, `operator/bundle/` | 2026-08-07 |
| Build provenance attestations on published artifacts | Attestation steps in the npm, container and release-artifact workflows | `.github/workflows/npm-publish.yml`, `docker-build-push.yml`, `release-artifacts.yml` | 2026-08-07 |
| Frequent releases | 0.9.63, 0.9.64, 0.9.65 and 0.9.66 were tagged between 2026-07-31 and 2026-08-03. State the dates rather than promising a cadence | git tags | 2026-08-07 |
| OIDC single sign-on | Vendor-agnostic OIDC client with PKCE | `src/lib/oidc.ts` | 2026-08-07 |
| ER diagrams ship in the MIT build | Interactive schema diagram with foreign-key edges and auto-layout | `src/components/SchemaDiagram.tsx`, `src/components/schema-diagram/` | 2026-08-07 |
| AI-assisted SQL ships in the MIT build | Multi-provider LLM layer behind a factory, so any model can be configured | `src/lib/llm/` | 2026-08-07 |
| Role-based access control | Middleware separating admin from user routes | `src/proxy.ts` | 2026-08-07 |
| Risk analysis before destructive statements run | Per-dialect SQL parsing that identifies statement boundaries and destructive keywords | `src/lib/sql/words.ts`, `src/lib/sql/spans.ts`, `src/lib/sql/statement-end.ts` | 2026-08-07 |
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
