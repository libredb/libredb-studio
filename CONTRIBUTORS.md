# Contributors

Every change in this repository lands with its tests in the same pull request, under a hard 100% line-coverage gate and six required checks. That is an unusual bar for a project this size, and it means a merged pull request here is evidence about the person who wrote it, not only about the project.

So this is not a thank-you wall. Each entry links to the change itself, so a reader who does not know us can check the claim. If your name is here, the link is yours to use — a CV, a profile README, anywhere the question "what have you actually shipped" comes up.

How the rungs work is written down in [CONTRIBUTING.md](CONTRIBUTING.md#the-contributor-ladder). The short version: one merged pull request puts you on this page, three lets you take an issue without asking, and owning an area is offered rather than applied for.

Listed in the order people first landed a change. Maintainers and bots are not listed here; `git shortlog -sn` is the full record.

## Trusted contributor

### @hasnaintypes

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

### @ugurpektas

- [Added the admin section routes and polished the interactive UI](https://github.com/libredb/libredb-studio/pull/231)

### @yangchuansheng

- [Added the Sealos deployment option](https://github.com/libredb/libredb-studio/pull/296)

### @ducminhle

- [Added an HTTPRoute to the Helm chart](https://github.com/libredb/libredb-studio/pull/362)

### @wjiec

- [Used OIDC discovery for generic logout URLs](https://github.com/libredb/libredb-studio/pull/431)

### @koraysrn

- [Enforced single-drive ownership in the agent, and refused post-close appends](https://github.com/libredb/libredb-studio/pull/419)
- [Aggregated the PostgreSQL grounding column read per table](https://github.com/libredb/libredb-studio/pull/537)

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
