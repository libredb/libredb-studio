# Contributors

Every change in this repository lands with its tests in the same pull request, under a hard 100% line-coverage gate and every check `main` requires. That is an unusual bar for a project this size, and it means a merged pull request here is evidence about the person who wrote it, not only about the project.

So this is not a thank-you wall. Each entry links to the change itself, so a reader who does not know us can check the claim. If your name is here, the link is yours to use — a CV, a profile README, anywhere the question "what have you actually shipped" comes up.

Nothing here is counted. Not merged pull requests, not changed lines, not closed issues. A count sees how often somebody showed up and misses everything that matters about it: the care taken, the bug nobody else found, the answer written out for a stranger. So the rungs below are judgements rather than totals, and where one is not obvious the reason is written beside the name — [CONTRIBUTING.md](CONTRIBUTING.md#the-contributor-ladder) says what each rung means.

Everyone whose work is in `main` is here, maintainers included. Bots and coding agents are not — `dependabot`, `Copilot` and `claude` all appear in the repository's commit history and none of them is a person, so listing them beside people would blur the only thing this page is for. `git shortlog -sn` shows the whole history including theirs.

Within each rung, people are in the order they first landed a change.

## Maintainer

The people who carry the project: the releases, the review, and the decisions nobody else can make. Their work is most of the history and is not itemised here; the links are a sample.

### @cevheri

Organisation member. Wrote most of what is here.

- [Brought libSQL in over the Hrana protocol](https://github.com/libredb/libredb-studio/pull/511)
- [Added DuckDB as an embedded file engine](https://github.com/libredb/libredb-studio/pull/516)

### @yusuf-gundogdu

Organisation member. The agent model record, and the distribution inventory.

- [Ran ten models across every agent surface, 300 for 300](https://github.com/libredb/libredb-studio/pull/465)
- [Found two cloud marketplaces the inventory did not know about](https://github.com/libredb/libredb-studio/pull/577)

### @kaya-abdullah

Organisation member. The wire-compatible engines, and the first localized READMEs.

- [Caught Trino handing back every bigint past 2^53 rounded](https://github.com/libredb/libredb-studio/pull/460)
- [Added the Simplified Chinese and Japanese READMEs](https://github.com/libredb/libredb-studio/pull/317)

## Trusted contributor

### @harish18092002

The first person outside the core team to send anything at all, on 2025-12-25, when there was no contributing guide, no labeled issue and no reason to believe anyone would answer. Being first is a different act from being second.

- [Improved the query preview in the Save Query modal](https://github.com/libredb/libredb-studio/commit/ff22a5dd4f5b5a3fcd0c01339820ffa6035ae51f)

### @omerfarukbolat

The light theme rests on the shared token layer he built, and the export path escapes every field because of the pass he did over it. Both were the kind of change that moves the floor under everything else rather than fixing one thing.

- [Fixed the auth flow, middleware redirects and hooks cleanup](https://github.com/libredb/libredb-studio/pull/10)
- [Enforced the ESLint and TypeScript checks in CI, and fixed the component bugs they found](https://github.com/libredb/libredb-studio/pull/18)
- [Built a light theme through a shared token layer, and fixed four silent query-execution defects](https://github.com/libredb/libredb-studio/pull/384)
- [Escaped every field an export writes, and stopped a plan outliving its run](https://github.com/libredb/libredb-studio/pull/422)

### @suleymansurucu

Came the same day as the first, hours behind it, into the same empty repository. Two people decided this was worth their evening before there was anything here to promise them it would be.

- [Handled SQL queries in the demo connection, with a mock fallback](https://github.com/libredb/libredb-studio/commit/c6d3e10c5d5076f674af12f58d2244e0208e6c5b)

### @hbasria

Brought a fifth identity provider into the OIDC layer, and the branch he added is still what runs — `src/lib/oidc.ts` handles Zitadel's RP-initiated logout because of him. He arrived with the doc and the test in the same change, months before this repository wrote that down as a rule.

- [Added Zitadel OIDC integration support](https://github.com/libredb/libredb-studio/commit/d8227cbc)
- [Covered `OIDC_ROLE_CLAIM` in the Zitadel logout URL test](https://github.com/libredb/libredb-studio/commit/09d36a4d)
- [Added Alpine image variants, full and slim, beside the Debian default](https://github.com/libredb/libredb-studio/pull/959)

### @ugurpektas

Built out the admin section: the routes, the interactive UI around them, and the tests that hold it. He did it in one careful pass rather than leaving it half-finished for someone else.

- [Added the admin section routes and polished the interactive UI](https://github.com/libredb/libredb-studio/pull/231)

### @koraysrn

First into the agent layer, which nobody outside the core team had opened, and he has stayed in it since: its drive ownership, its PostgreSQL grounding and the history of finished runs are all partly his. He started in the part nobody volunteers for, a run behaving correctly when something goes wrong.

- [Enforced single-drive ownership in the agent, and refused post-close appends](https://github.com/libredb/libredb-studio/pull/419)
- [Aggregated the PostgreSQL grounding column read per table](https://github.com/libredb/libredb-studio/pull/537)
- [Kept the engine's own and extension-owned objects out of PostgreSQL agent grounding](https://github.com/libredb/libredb-studio/pull/625)
- [Added a History list of finished agent conversations, reopened from each run's own ledger](https://github.com/libredb/libredb-studio/pull/830)
- [Resolved `bun` through the shell on Windows in the security check](https://github.com/libredb/libredb-studio/pull/997)
- [Made the agent's drive claim durable in the run ledger instead of process memory](https://github.com/libredb/libredb-studio/pull/998)
- [Derived each drive's ceilings from the ledger, and capped artifacts per run](https://github.com/libredb/libredb-studio/pull/999)
- [Swept up and resumed agent runs that a dead process had left running](https://github.com/libredb/libredb-studio/pull/1000)
- [Added pause and resume for an agent run from the rail](https://github.com/libredb/libredb-studio/pull/1001)
- [Memoized the studio shell's children, and lazy-loaded the ERD, modals and schema explorer](https://github.com/libredb/libredb-studio/pull/1127)
- [Handed the shell's children only what they show, ending their re-render on every keystroke](https://github.com/libredb/libredb-studio/pull/1190)
- [Extracted the shared modal surface out of `Studio.tsx` into `StudioModals`](https://github.com/libredb/libredb-studio/pull/1217)

### @hasnaintypes

Went wherever the work was: the login page, the admin fleet view, a license notice nobody had stated, and the provider docs whose citations had quietly rotted. Each one arrived finished, with the reasoning written down.

- [Closed the login hero's overflow at 1280x800](https://github.com/libredb/libredb-studio/pull/550)
- [Stated elkjs's EPL-2.0 license alongside the MIT license](https://github.com/libredb/libredb-studio/pull/552)
- [Summed the fleet's own byte figure instead of re-parsing display strings](https://github.com/libredb/libredb-studio/pull/551)
- [Replaced the stale line-number citations in `oracle.md` with named citations](https://github.com/libredb/libredb-studio/pull/563)
- [Did the same for `mongodb.md`](https://github.com/libredb/libredb-studio/pull/581)
- [Detected `tlsCAFile` and ambiguous credentials in a pasted MongoDB connection string](https://github.com/libredb/libredb-studio/pull/1210)

## Contributor

### @ucmazmehmet

- [Updated the Windows native support documentation](https://github.com/libredb/libredb-studio/pull/209)

### @sifaaraldevop

- [Made Oracle Thick mode optional and mapped NJS-138 to an honest error](https://github.com/libredb/libredb-studio/pull/229)

### @yangchuansheng

- [Added the Sealos deployment option](https://github.com/libredb/libredb-studio/pull/296)

### @ducminhle

- [Added an HTTPRoute to the Helm chart](https://github.com/libredb/libredb-studio/pull/362)

### @wjiec

- [Used OIDC discovery for generic logout URLs](https://github.com/libredb/libredb-studio/pull/431)

### @Matthew-Selvam

- [Capped chart series and pie slices at the palette size instead of repeating colours](https://github.com/libredb/libredb-studio/pull/501)
- [Stopped schema-diff wrapping non-transactional dialects in `BEGIN;`/`COMMIT;`](https://github.com/libredb/libredb-studio/pull/521)
- [Stopped two concurrent first requests building and initializing two storage providers](https://github.com/libredb/libredb-studio/pull/724)
- [Stopped an LLM stream reading its source after the consumer cancels](https://github.com/libredb/libredb-studio/pull/726)

### @mfatihdayan

- [Updated the provider tri-sync rule to the shipped provider set](https://github.com/libredb/libredb-studio/pull/504)

### @HasselNot7

- [Normalized all text files to LF on checkout](https://github.com/libredb/libredb-studio/pull/555)
- [Matched the `.gitattributes` rules as whole lines in the drift guard](https://github.com/libredb/libredb-studio/pull/562)

### @v01dst

- [Used `@theme inline` so the Geist font variables resolve](https://github.com/libredb/libredb-studio/pull/561)

### @Akimbo92i

- [Made libSQL omit an unknown overview size rather than reporting zero](https://github.com/libredb/libredb-studio/pull/569)

### @cnYui

- [Made MSSQL and Oracle do the same](https://github.com/libredb/libredb-studio/pull/579)

### @dchaudhari7177

- [Re-anchored `mysql.md`'s thirteen code citations to declaration names, and put the file under the guard](https://github.com/libredb/libredb-studio/pull/582)
- [Documented `LOG_LEVEL` with both defaults, and guarded `.env.example` against undocumented `process.env` names](https://github.com/libredb/libredb-studio/pull/583)
- [Documented the bundled Node.js version, artefacts and origin in `SECURITY.md`, and guarded it against drift](https://github.com/libredb/libredb-studio/pull/584)

### @sonalisrisivani

- [Added the undocumented `DatabaseConnection` and `QueryResult` fields to `docs/API_DOCS.md`, and guarded four type blocks](https://github.com/libredb/libredb-studio/pull/580)

### @be-student

- [Replaced the `.ts:N` citations in `AGENT.md`, `FEATURES.md`, `ADDING_A_PROVIDER.md` and `SECURITY.md` with names](https://github.com/libredb/libredb-studio/pull/606)
- [Did the same for `redis.md`, and brought it under the citation guard](https://github.com/libredb/libredb-studio/pull/604)
- [Told an absent MSSQL or Oracle overview size apart from a measured zero](https://github.com/libredb/libredb-studio/pull/601)

### @NormanSMA

- [Added the Spanish README, and registered it with the localized README drift guard](https://github.com/libredb/libredb-studio/pull/605)
- [Added the `libredb-studio-bin` AUR package](https://github.com/libredb/libredb-studio/pull/1218)

### @7487

- [Named `createDatabaseProvider()` in seven provider docs, and stopped the guard passing on nothing](https://github.com/libredb/libredb-studio/pull/629)
- [Replaced `postgres.md`'s stale line-number citations with the names they meant](https://github.com/libredb/libredb-studio/pull/636)
- [Did the same for `clickhouse.md`, where two citations had drifted onto a closing brace](https://github.com/libredb/libredb-studio/pull/639)
- [Did the same for `druid.md`, and credited `quoteUnsafeIntegers()` to the file that declares it](https://github.com/libredb/libredb-studio/pull/645)
- [Did the same for `couchbase.md`, and widened the guard to `.tsx` coordinates too](https://github.com/libredb/libredb-studio/pull/644)
- [Made the create-table form emit each engine's own DDL rather than PostgreSQL's](https://github.com/libredb/libredb-studio/pull/651)
- [Held the duplicated CI-gate paragraph in sync, and dropped `.devcontainer` from the Docker context](https://github.com/libredb/libredb-studio/pull/663)

### @XiaoZ-0218

- [Dropped five docs' references to a `getPlaceholder()` the base class no longer has](https://github.com/libredb/libredb-studio/pull/642)
- [Stopped four docs crediting `SQLBaseProvider` with placeholders that live in `values.ts`](https://github.com/libredb/libredb-studio/pull/650)

### @dvd233

- [Linked `measuredNullableAggregate()` to `measured-aggregate.ts` from the MSSQL and Oracle docs](https://github.com/libredb/libredb-studio/pull/643)

### @SatvikMishra08

- [Added the Helm and subchart-build steps a fresh clone needs before `bun run test`](https://github.com/libredb/libredb-studio/pull/571)

### @saad-works

- [Resolved two static `process.env[...]` bracket shapes so the env docs guard sees them](https://github.com/libredb/libredb-studio/pull/649)
- [Gave the same guard's negative test a control, and matched its comment to the regex](https://github.com/libredb/libredb-studio/pull/652)

### @voidofrgestudio

- [Made MySQL and PostgreSQL omit an unmeasured database size instead of reporting zero bytes](https://github.com/libredb/libredb-studio/pull/627)

### @SyedMuhamadYasir

- [Replaced `sqlite.md`'s stale line-number citations with named ones, and guarded them against returning](https://github.com/libredb/libredb-studio/pull/657)
- [Added a devcontainer with Bun, Helm and 7-Zip, and named CI as the merge gate](https://github.com/libredb/libredb-studio/pull/658)
- [Emitted SQL Server and Oracle migration DDL in their own grammar, not PostgreSQL's](https://github.com/libredb/libredb-studio/pull/659)
- [Made a build mountable under a URL subpath through `BASE_PATH`, cookies and probes included](https://github.com/libredb/libredb-studio/pull/662)

### @macjayz

- [Added the npm package's description, engine keywords, homepage and issue tracker URL](https://github.com/libredb/libredb-studio/pull/697)

### @slsgzs-cloud

- [Added a Create Table action to the empty schema explorer, gated by the engine's capability](https://github.com/libredb/libredb-studio/pull/655)

### @stgomoyaa

- [Required a confirmation before a connection is deleted, on desktop and mobile alike](https://github.com/libredb/libredb-studio/pull/698)

### @mikevillari

- [Stopped short queries in serialized database errors ending in a false ellipsis](https://github.com/libredb/libredb-studio/pull/706)
- [Did the same for the saved-query previews in the command palette](https://github.com/libredb/libredb-studio/pull/707)
- [Ran a component suite the runner never named, and guarded against future omissions](https://github.com/libredb/libredb-studio/pull/711)
- [Removed the desktop header's settings cog, which had hover styling but no action](https://github.com/libredb/libredb-studio/pull/714)
- [Gave six icon-only controls accessible names, including session termination and column removal](https://github.com/libredb/libredb-studio/pull/713)
- [Stopped a qualified table completion inserting the schema twice, and matched the typed qualifier](https://github.com/libredb/libredb-studio/pull/715)
- [Made the launcher print a reachable startup link for wildcard and IPv6 binds](https://github.com/libredb/libredb-studio/pull/709)
- [Quoted PostgreSQL table completions only where `quote_ident` requires it, leaving other dialects unchanged](https://github.com/libredb/libredb-studio/pull/791)

### @2160039878-cyber

- [Added the coverage gate and the provider triad to the pull request checklist](https://github.com/libredb/libredb-studio/pull/716)
- [Derived the JWT and storage minimum-length messages from the shared constant they describe](https://github.com/libredb/libredb-studio/pull/717)
- [Derived the valid LLM providers from the default model table, and made its env reads visible to the docs guard](https://github.com/libredb/libredb-studio/pull/718)
- [Documented the command palette and its `Cmd/Ctrl+K` shortcut in the README and feature list](https://github.com/libredb/libredb-studio/pull/719)
- [Added Discussions and private security-reporting links to the issue chooser](https://github.com/libredb/libredb-studio/pull/720)
- [Added the `custom` provider, `LLM_API_URL` and `STORAGE_SQLITE_PATH` to the README's environment table](https://github.com/libredb/libredb-studio/pull/727)
- [Rewrote the page description to cover the whole database scope instead of a fixed engine list](https://github.com/libredb/libredb-studio/pull/728)
- [Replaced the Koyeb guide's nonexistent Blueprint file with the deploy-button flow that works](https://github.com/libredb/libredb-studio/pull/729)
- [Stopped the project overview counting the embedded store as an external engine, and pointed it at `EXTERNAL_DATABASE_TYPES`](https://github.com/libredb/libredb-studio/pull/730)
- [Corrected the README's claim that CI runs only Chromium, naming the WebKit security-headers suite](https://github.com/libredb/libredb-studio/pull/731)
- [Limited the SonarCloud job to the canonical repository, so a fork's pushes stop failing it](https://github.com/libredb/libredb-studio/pull/733)
- [Added a "First row is header" switch to CSV import, so a headerless file keeps its first row as data](https://github.com/libredb/libredb-studio/pull/712)
- [Applied the saved alert thresholds that the monitoring Overview and Performance tabs had ignored](https://github.com/libredb/libredb-studio/pull/738)
- [Added Email, Phone, Credit Card and SSN presets to the masking pattern editor](https://github.com/libredb/libredb-studio/pull/739)
- [Added CSV and JSON export of the filtered operations and queries to the admin Audit tab](https://github.com/libredb/libredb-studio/pull/740)
- [Added a Duplicate action that opens a copy of a saved connection in the editor, saved only on success](https://github.com/libredb/libredb-studio/pull/741)
- [Added Open Graph and Twitter card previews for shared links](https://github.com/libredb/libredb-studio/pull/762)
- [Let CSV import and result export choose a comma, semicolon or tab delimiter](https://github.com/libredb/libredb-studio/pull/760)
- [Added JSON export and import to Saved Queries, validating the whole file before anything is written](https://github.com/libredb/libredb-studio/pull/756)
- [Kept the query safety confirmation when no LLM provider is configured, instead of dropping it](https://github.com/libredb/libredb-studio/pull/742)

### @CunjieLee

- [Added a Trino session schema field, sent as `X-Trino-Schema` so bare names resolve](https://github.com/libredb/libredb-studio/pull/721)
- [Capped every job in ten workflows with a sized `timeout-minutes`, pinned by a test](https://github.com/libredb/libredb-studio/pull/736)
- [Added a `site.webmanifest` and a 180x180 Apple touch icon so Studio installs to a home screen](https://github.com/libredb/libredb-studio/pull/781)

### @nktnet1

- [Sent `field_multi_value_leniency` so Elasticsearch selects multi-valued fields instead of erroring](https://github.com/libredb/libredb-studio/pull/723)

### @Vetri1706

- [Gave each connection an optional query timeout, and dropped its cached provider on a change](https://github.com/libredb/libredb-studio/pull/752)

### @TonMtt

- [Documented how to rebase a fork branch onto `upstream/main` with `--force-with-lease`](https://github.com/libredb/libredb-studio/pull/735)

### @na12334

- [Added CSV and JSON export to the Data Profiler, masking what the screen masks](https://github.com/libredb/libredb-studio/pull/759)

### @Hashir-Ashraf-Awan

- [Added an optional TOTP second factor to local login, and refused a replayed code](https://github.com/libredb/libredb-studio/pull/779)

### @jabrailkhalil

- [Bound `Cmd/Ctrl+Shift+X` to a new query tab, working while the editor holds focus](https://github.com/libredb/libredb-studio/pull/782)
- [Moved the four keyboard shortcuts into one registry that also generates the docs line](https://github.com/libredb/libredb-studio/pull/803)

### @nightcityblade

- [Repointed two agent comments from a git-ignored design file to a reachable citation](https://github.com/libredb/libredb-studio/pull/793)

### @Abdu11ahBilal

- [Added `README_ur.md` and brought it under the localized README drift guard](https://github.com/libredb/libredb-studio/pull/783)

### @Dharshni-gth

- [Pointed the social preview at `libredb.org` and dropped the engine list from the meta description](https://github.com/libredb/libredb-studio/pull/798)
- [Made inline edits on a default `Query N` tab target the `FROM` clause table](https://github.com/libredb/libredb-studio/pull/924)

### @Swarnabha753

- [Added CSV and JSON export to the pivot table through the shared escaping helpers](https://github.com/libredb/libredb-studio/pull/796)

### @Dharshini-RS03

- [Added a results-grid wrap toggle that re-measures virtualized rows as they grow](https://github.com/libredb/libredb-studio/pull/810)
- [Kept the Run Sel button's blue fill on hover instead of the ghost hover colour](https://github.com/libredb/libredb-studio/pull/838)
- [Built the object reads with `jsonb`, so RisingWave tables show their columns](https://github.com/libredb/libredb-studio/pull/1096)

### @nycjay

- [Stopped the editor overwriting live keystrokes with its own stale text and moving the caret](https://github.com/libredb/libredb-studio/pull/809)

### @Asgabani

- [Gave a closed query tab an Undo toast that restores it in place](https://github.com/libredb/libredb-studio/pull/818)
- [Added a star toggle that lifts favourite connections into their own sidebar group](https://github.com/libredb/libredb-studio/pull/812)
- [Made sidebar connections reorderable by drag, persisting the order in `connection_order`](https://github.com/libredb/libredb-studio/pull/817)
- [Repinned the CapRover template, cut AI claims the app dropped, and warned about `JWT_SECRET` rotation](https://github.com/libredb/libredb-studio/pull/849)
- [Added a `?` dialog listing every keyboard shortcut from a single registry](https://github.com/libredb/libredb-studio/pull/821)
- [Stopped a connection switch issuing one object-tree read shaped for the previous engine](https://github.com/libredb/libredb-studio/pull/848)
- [Reported SQLite and LibreDB database size as absent, not zero, when it cannot be read](https://github.com/libredb/libredb-studio/pull/1050)

### @InnoxCodes

- [Replaced the flat agent budget figures with the real per-workflow ranges in three READMEs](https://github.com/libredb/libredb-studio/pull/891)
- [Documented that Agent mode's Start needs `STORAGE_PROVIDER` set to `sqlite` or `postgres`](https://github.com/libredb/libredb-studio/pull/890)
- [Added `autoComplete` hints so password managers fill the login email and password](https://github.com/libredb/libredb-studio/pull/896)
- [Pluralized the admin fleet status badge so two failures no longer read `2 error`](https://github.com/libredb/libredb-studio/pull/893)
- [Stopped a long column type squeezing out the column name, with the full type on hover](https://github.com/libredb/libredb-studio/pull/885)
- [Replaced the hardcoded seven engines in the admin empty state with the real catalog count](https://github.com/libredb/libredb-studio/pull/894)
- [Changed the Security tab's all-caps `ENABLED` badges to sentence case](https://github.com/libredb/libredb-studio/pull/929)
- [Made the login submit button read `Sign in`, and pinned it by role in tests](https://github.com/libredb/libredb-studio/pull/932)

### @niukanen1

- [Printed the startup banner URL from the real `HOSTNAME` bind rather than `localhost`](https://github.com/libredb/libredb-studio/pull/847)
- [Read a MongoDB collection in another database when the statement names that database](https://github.com/libredb/libredb-studio/pull/1106)
- [Fixed the `font-mediumr` typo that left labels at the wrong weight](https://github.com/libredb/libredb-studio/pull/1140)
- [Stopped asking to confirm Redis blocking commands the provider refuses anyway](https://github.com/libredb/libredb-studio/pull/1174)
- [Ran the provider docs' test commands through the isolated runner instead of bare `bun test`](https://github.com/libredb/libredb-studio/pull/1219)

### @costajohnt

- [Separated an OIDC misconfiguration from an unreachable issuer, on screen and in the audit log](https://github.com/libredb/libredb-studio/pull/871)

### @iAmAdheil

- [Added `README_hi.md`, linked it from every other README and the drift guard](https://github.com/libredb/libredb-studio/pull/845)
- [Reported the declared MySQL column type instead of the type family](https://github.com/libredb/libredb-studio/pull/1073)
- [Kept a trailing `s` in column names in the code generator's output](https://github.com/libredb/libredb-studio/pull/1177)
- [Reported the declared Oracle column type, with its length, precision and scale](https://github.com/libredb/libredb-studio/pull/1187)
- [Read Oracle `UROWID(n)` and `VECTOR(n, format)` columns back with their size](https://github.com/libredb/libredb-studio/pull/1237)

### @0utsights

- [Corrected the Keycloak role mapping: realm roles reach the ID token only when mapped](https://github.com/libredb/libredb-studio/pull/904)

### @Rayan-and-beyond

- [Listed every translated README in the contributing guide's language exception and guard rule](https://github.com/libredb/libredb-studio/pull/903)
- [Corrected the DigitalOcean checklist's health example to the `healthy` status the endpoint returns](https://github.com/libredb/libredb-studio/pull/915)
- [Replaced the UI doc index's dark-only theme claim with the dark-first model](https://github.com/libredb/libredb-studio/pull/911)
- [Documented `LIBREDB_NO_BANNER` for suppressing the startup banner in the Rancher guide](https://github.com/libredb/libredb-studio/pull/912)

### @YaoSong808

- [Closed the Code Generator on an unhandled Escape, and recorded the new global listener](https://github.com/libredb/libredb-studio/pull/892)

### @Mehmetalpertugtekin

- [Pointed the Fly guide's README link at the Environment Variables heading that exists](https://github.com/libredb/libredb-studio/pull/914)

### @DevvoLazza

- [Made the DigitalOcean pin read the published listing version instead of skipping the channel](https://github.com/libredb/libredb-studio/pull/927)
- [Retried the agent ledger's transient Windows chunk probe, keeping each stream's writes ordered](https://github.com/libredb/libredb-studio/pull/925)
- [Asserted the admin preview's category spread by type-id instead of renameable display labels](https://github.com/libredb/libredb-studio/pull/934)
- [Compacted table row counts, and added an editable count query to the table menu](https://github.com/libredb/libredb-studio/pull/926)
- [Added an opt-in block on private hosts for HTTP database transports, `DB_HTTP_BLOCK_PRIVATE_HOSTS`](https://github.com/libredb/libredb-studio/pull/1114)

### @xiechimon

- [Wrote the DigitalOcean Droplet env file under `umask 077` and installed it atomically](https://github.com/libredb/libredb-studio/pull/921)

### @Lingikaushikreddy

- [Documented how `TRUST_PROXY_HEADERS` and `TRUSTED_PROXY_HOPS` decide the rate-limit bucket key](https://github.com/libredb/libredb-studio/pull/938)
- [Tabulated the `RATE_LIMIT_*` variables and defaults behind each rate-limit bucket](https://github.com/libredb/libredb-studio/pull/939)
- [Added a one-command Keycloak OIDC demo stack](https://github.com/libredb/libredb-studio/pull/947)
- [Documented `HSTS_INCLUDE_SUBDOMAINS` and how far `includeSubDomains` reaches](https://github.com/libredb/libredb-studio/pull/940)
- [Corrected the OIDC demo's logout claim, and bound its proxy to loopback](https://github.com/libredb/libredb-studio/pull/960)
- [Published the Vault demo's services on loopback only](https://github.com/libredb/libredb-studio/pull/1004)

### @Anikesh348

- [Gave the schema explorer's icon-only table actions button a table-specific accessible name](https://github.com/libredb/libredb-studio/pull/886)

### @De-pitcher

- [Added the capabilities, error-handling and usage sections `libsql.md` was missing](https://github.com/libredb/libredb-studio/pull/946)
- [Made `temperature` and `topP` independently optional, so an endpoint that refuses both together accepts a tuning overlay](https://github.com/libredb/libredb-studio/pull/951)
- [Signposted team workspaces between `STORAGE.md` and `OIDC.md`](https://github.com/libredb/libredb-studio/pull/961)
- [Made the chart README's `docs/MFA.md` link absolute, so it resolves outside the repository](https://github.com/libredb/libredb-studio/pull/962)

### @tunglambk

- [Resolved seed connection credentials from HashiCorp Vault, so a rotated secret needs no restart](https://github.com/libredb/libredb-studio/pull/944)
- [Documented the one-command Vault demo stack in the README](https://github.com/libredb/libredb-studio/pull/956)
- [Moved the owned deployment pins, Fly.io, Railway, CapRover and the AWS AMI among them, to 0.16.2](https://github.com/libredb/libredb-studio/pull/1049)

### @nawazish2

- [Disclosed in the Admin Audit tab that denials recorded by the proxy do not appear there](https://github.com/libredb/libredb-studio/pull/989)
- [Added Elasticsearch API key authentication, preferred over Basic auth when both halves are set](https://github.com/libredb/libredb-studio/pull/994)
- [Stored local accounts in a database table, so a team is no longer limited to one admin and one user](https://github.com/libredb/libredb-studio/pull/1122)
- [Kept rotated chart x-axis labels out of the legend and off the left edge](https://github.com/libredb/libredb-studio/pull/1175)
- [Grouped sidebar connections into collapsible sections the user names](https://github.com/libredb/libredb-studio/pull/1229)

### @JavierparraDev

- [Printed the schema beside each table on the admin Operations page, so same-named tables are told apart](https://github.com/libredb/libredb-studio/pull/984)

### @linropx

- [Refused a committed `.only` before the test run, instead of letting the skipped tests pass green](https://github.com/libredb/libredb-studio/pull/987)
- [Stopped the launcher binding the machine name or container id that arrives as `HOSTNAME`](https://github.com/libredb/libredb-studio/pull/1053)

### @sloemo01

- [Read the SQLite object kinds from the provider in the agent guard, instead of scraping source text](https://github.com/libredb/libredb-studio/pull/986)
- [Added the Civo Kubernetes Marketplace to the distribution channel inventory](https://github.com/libredb/libredb-studio/pull/996)
- [Read the backlog citation scan from the git index, so an ignored draft cannot turn the local run red](https://github.com/libredb/libredb-studio/pull/995)
- [Regenerated the channel matrix that the Civo merge had left stale on `main`](https://github.com/libredb/libredb-studio/pull/1009)
- [Re-derived `SECURITY.md` note 1.4 from the code, and gave its residual a real backlog entry](https://github.com/libredb/libredb-studio/pull/1024)
- [Hoisted the last copied object-path shape checks into `assertObjectPathShape`](https://github.com/libredb/libredb-studio/pull/1023)
- [Closed the Oracle pool a failed connect had created, instead of leaving it retrying with no delay](https://github.com/libredb/libredb-studio/pull/1105)
- [Made `assertContainerPathShape` the only producer of the container-path refusal, fixing a drifted SQL Server copy](https://github.com/libredb/libredb-studio/pull/1092)
- [Sent the table's schema with Analyze, Vacuum and Reindex from the monitoring page, so non-`public` tables resolve](https://github.com/libredb/libredb-studio/pull/1091)

### @KodYazicam

- [Hoisted the copies of `assertObjectPathShape` into one export in `object-kinds.ts`](https://github.com/libredb/libredb-studio/pull/985)
- [Added the embedded LibreDB provider to the architecture diagrams](https://github.com/libredb/libredb-studio/pull/1117)
- [Listed the components the login form actually renders in `login-page.md`, dropping a file that does not exist](https://github.com/libredb/libredb-studio/pull/1116)
- [Fixed `postgres.md`'s dead link to its object surface section](https://github.com/libredb/libredb-studio/pull/1115)
- [Documented and pinned the Kafka `QueryError` for a partition the topic does not have](https://github.com/libredb/libredb-studio/pull/1168)
- [Reset every connection-scoped field after a save that leaves the connection dialog open](https://github.com/libredb/libredb-studio/pull/1167)
- [Corrected the agent data-flow doc's count of provider schema reads, and named `sys.partitions.rows` as SQL Server's statistics source](https://github.com/libredb/libredb-studio/pull/1306)

### @t957095

- [Added the missing PostgreSQL Clients link to the Japanese, Spanish, Urdu and Hindi READMEs](https://github.com/libredb/libredb-studio/pull/1012)
- [Proofread `README_zh.md` as a native speaker, and rewrote its stale transport-security note](https://github.com/libredb/libredb-studio/pull/1005)

### @NotAFlightRisk

- [Repointed the Kubero guide's dead install link at a page that exists](https://github.com/libredb/libredb-studio/pull/1021)

### @chiliec

- [Stopped schema diff writing `DEFAULT` before ClickHouse `MATERIALIZED`, `ALIAS` and `EPHEMERAL` columns](https://github.com/libredb/libredb-studio/pull/1035)
- [Held Trino `nextUri` links to the connection's own origin, so its credentials are never sent elsewhere](https://github.com/libredb/libredb-studio/pull/1090)
- [Reported a malformed Kafka read request as a query error rather than a configuration error](https://github.com/libredb/libredb-studio/pull/1137)
- [Stated `objectKinds` in the capabilities section of the provider docs that lacked it](https://github.com/libredb/libredb-studio/pull/1153)
- [Pointed backlog entries D39 and D44 at symbols instead of line numbers](https://github.com/libredb/libredb-studio/pull/1166)
- [Reset connection-scoped fields before the connection form applies a new edit target](https://github.com/libredb/libredb-studio/pull/1157)

### @rahimahisah17

- [Published the Postgres compose containers on loopback only](https://github.com/libredb/libredb-studio/pull/1039)
- [Mounted the `postgres:18` data volume at `/var/lib/postgresql`, ending a restart loop](https://github.com/libredb/libredb-studio/pull/1041)
- [Raised Next.js to 16.3.6 for a reported security vulnerability](https://github.com/libredb/libredb-studio/pull/1288)

### @bernalalexis-try

- [Showed an empty-string default in the ER diagram's column tooltip instead of hiding it](https://github.com/libredb/libredb-studio/pull/1036)
- [Read SQLite, libSQL and DuckDB column defaults as values rather than quoted catalog text](https://github.com/libredb/libredb-studio/pull/1048)

### @saitakarcesme

- [Corrected the local and hosted model counts in the LLM setup guide](https://github.com/libredb/libredb-studio/pull/1060)

### @BladeRunner-KD6-37

- [Corrected the agent API path and handler counts in `API_DOCS.md`](https://github.com/libredb/libredb-studio/pull/1063)

### @lg114

- [Expanded the Chinese README with the install channels, the feature set and the agent](https://github.com/libredb/libredb-studio/pull/1052)

### @Ehtasham-Yasin

- [Added Copy Cell and Copy Row as JSON to the results grid context menu, keeping masked values masked](https://github.com/libredb/libredb-studio/pull/1068)

### @Aditya-XR

- [Anchored the Schema Diff migration copy button outside the scrolling SQL](https://github.com/libredb/libredb-studio/pull/1082)
- [Refused Redis commands such as `SELECT` and `AUTH` that would move the connection every request shares](https://github.com/libredb/libredb-studio/pull/1121)
- [Read Oracle `DATE` and `TIMESTAMP` as the stored wall clock, whatever the server's time zone](https://github.com/libredb/libredb-studio/pull/1225)

### @NikharAsthana

- [Pinned the Schema Diff migration copy button with a clipboard test](https://github.com/libredb/libredb-studio/pull/1076)

### @igorwfaoro

- [Made the admin Overview's Recent Activity state what it covers, with a path to the Audit tab](https://github.com/libredb/libredb-studio/pull/1079)
- [Sized each result grid column from its header instead of one fixed width](https://github.com/libredb/libredb-studio/pull/1113)

### @Xavees

- [Added the capabilities, error-handling and usage sections `duckdb.md` was missing](https://github.com/libredb/libredb-studio/pull/1103)

### @yizhixiaokong

- [Added a resumable walk of an engine's own key space, and the sidebar key browser that drives it](https://github.com/libredb/libredb-studio/pull/1095)

### @MohamedIdhries

- [Covered a long-form IPv6 Trino host against a short `nextUri` in the transport tests](https://github.com/libredb/libredb-studio/pull/1093)

### @TehmeenaAkhtar

- [Made the Urdu README read more naturally, and kept the link to its renamed install heading working](https://github.com/libredb/libredb-studio/pull/1118)

### @Roberton003

- [Started the read-only MCP server at `/api/mcp`, which the maintainers then rebuilt on the official SDK](https://github.com/libredb/libredb-studio/pull/1070)

### @Reitzzz

- [Reported a PostgreSQL `statement_timeout` as a timeout instead of a user cancel](https://github.com/libredb/libredb-studio/pull/1149)

### @fatihcvs

- [Replaced line-number citations in source comments with the declaration names they meant](https://github.com/libredb/libredb-studio/pull/1141)
- [Stopped a short result page showing a `limited` badge when nothing was cut](https://github.com/libredb/libredb-studio/pull/1142)

### @MFA-G

- [Reset TLS, SSH, environment and Advanced fields when a new connection's dialog closes](https://github.com/libredb/libredb-studio/pull/1150)

### @methakon

- [Read SQL Server `time`, `date` and `datetime2` as the engine's own text, not invented UTC instants](https://github.com/libredb/libredb-studio/pull/1178)
- [Withdrew the connection dialog's transient state when a host swaps in a new edit target](https://github.com/libredb/libredb-studio/pull/1205)

### @muskanbandta23

- [Added ZopDay to the README's one-click deploy options](https://github.com/libredb/libredb-studio/pull/1183)

### @Retsumdk

- [Derived the provider docs' named citations inside the guard test instead of trusting a hand-kept list](https://github.com/libredb/libredb-studio/pull/1194)

### @shivamcoderrrr

- [Moved the query safety dialog onto the Radix alert dialog, for focus trapping and keyboard use](https://github.com/libredb/libredb-studio/pull/1191)

### @paulocoutinhox

- [Added the Portuguese README, linked it from the others and registered it with the drift guard](https://github.com/libredb/libredb-studio/pull/1017)

### @Fristail27

- [Added the Russian README, linked it from the others and registered it with the drift guard](https://github.com/libredb/libredb-studio/pull/1188)

### @Object-ions

- [Kept the confirmation dialogs' Cancel button on the studio theme's colour when the OS is dark](https://github.com/libredb/libredb-studio/pull/1202)
- [Returned focus to where it was after closing confirmation dialogs opened from app state](https://github.com/libredb/libredb-studio/pull/1204)

### @ArthurRamonSouza

- [Reworded the Apache Kafka row of the Portuguese README](https://github.com/libredb/libredb-studio/pull/1206)

### @abkucuk

- [Dropped the `tcp:` prefix from a pasted ADO.NET `Server`, so an Azure connection string connects](https://github.com/libredb/libredb-studio/pull/1212)

### @Maaz2212

- [Dropped a stale engine count from `libsql.md`](https://github.com/libredb/libredb-studio/pull/1220)
- [Stated in `login-page.md` that `NEXT_PUBLIC_APP_VERSION` comes from `package.json` at build time](https://github.com/libredb/libredb-studio/pull/1221)

### @JaredAung

- [Recorded the Scoop Extras listing in the channel inventory and the install docs](https://github.com/libredb/libredb-studio/pull/1226)

### @gurkanceylan41

- [Fixed the in-page links in `mssql.md` and `redis.md` that missed their headings](https://github.com/libredb/libredb-studio/pull/1234)

### @rivolity

- [Made the Vault Kubernetes auth mount configurable through `VAULT_K8S_AUTH_PATH`](https://github.com/libredb/libredb-studio/pull/1282)

### @berkay-byte

- [Corrected the `vacuumAction` provider count, and dropped a stale `reindex` reference](https://github.com/libredb/libredb-studio/pull/1280)

### @lb1192176991-lab

- [Documented the `*_PATH`, `*_DIR` and `*_FILE` env classification rule in `CONTRIBUTING.md`](https://github.com/libredb/libredb-studio/pull/1298)

### @lui01212

- [Corrected the X5 backlog entry's rendering notes after the modal extraction](https://github.com/libredb/libredb-studio/pull/1300)

### @cestercian

- [Added the second Neo4j integration test command, and linked the references in `neo4j.md`](https://github.com/libredb/libredb-studio/pull/1307)

### @rnihesh

- [Fixed the Db2 doc's statement terminator row, and filled the gaps it had against the code](https://github.com/libredb/libredb-studio/pull/1314)

### @mgr-punith

- [Corrected the non-SQL query formats intro in `DATABASE_PROVIDERS.md`, and added LibreDB to it](https://github.com/libredb/libredb-studio/pull/1319)

### @DevKhizerer

- [Replaced a stale type-id count in a schema statistics comment with the rule behind it](https://github.com/libredb/libredb-studio/pull/1360)

### @hridhinvarkeyjoseph

- [Retried MongoDB `listDatabases` without `authorizedDatabases` on FerretDB, which refuses the field](https://github.com/libredb/libredb-studio/pull/1302)

## Getting on this page

Take an issue labelled [good first issue](https://github.com/libredb/libredb-studio/labels/good%20first%20issue) — each one states what "done" looks like as a command you can run yourself, so you never have to ask whether you are finished. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the gates.

Reports count too. If you opened an issue that led to a fix, say so on the pull request that fixed it and we will list the report beside the change.
