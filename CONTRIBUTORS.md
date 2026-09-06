# Contributors

Every change in this repository lands with its tests in the same pull request, under a hard 100% line-coverage gate and six required checks. That is an unusual bar for a project this size, and it means a merged pull request here is evidence about the person who wrote it, not only about the project.

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

### @ugurpektas

Built out the admin section: the routes, the interactive UI around them, and the tests that hold it. He did it in one careful pass rather than leaving it half-finished for someone else.

- [Added the admin section routes and polished the interactive UI](https://github.com/libredb/libredb-studio/pull/231)

### @koraysrn

First into the agent layer, which nobody outside the core team had opened, and he has stayed in it since. Both of his changes are about a run behaving correctly when something goes wrong, which is the part nobody volunteers for.

- [Enforced single-drive ownership in the agent, and refused post-close appends](https://github.com/libredb/libredb-studio/pull/419)
- [Aggregated the PostgreSQL grounding column read per table](https://github.com/libredb/libredb-studio/pull/537)

### @hasnaintypes

Went wherever the work was: the login page, the admin fleet view, a license notice nobody had stated, and the provider docs whose citations had quietly rotted. Each one arrived finished, with the reasoning written down.

- [Closed the login hero's overflow at 1280x800](https://github.com/libredb/libredb-studio/pull/550)
- [Stated elkjs's EPL-2.0 license alongside the MIT license](https://github.com/libredb/libredb-studio/pull/552)
- [Summed the fleet's own byte figure instead of re-parsing display strings](https://github.com/libredb/libredb-studio/pull/551)
- [Replaced the stale line-number citations in `oracle.md` with named citations](https://github.com/libredb/libredb-studio/pull/563)
- [Did the same for `mongodb.md`](https://github.com/libredb/libredb-studio/pull/581)

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

## Getting on this page

Take an issue labelled [good first issue](https://github.com/libredb/libredb-studio/labels/good%20first%20issue) — each one states what "done" looks like as a command you can run yourself, so you never have to ask whether you are finished. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the gates.

Reports count too. If you opened an issue that led to a fix, say so on the pull request that fixed it and we will list the report beside the change.
