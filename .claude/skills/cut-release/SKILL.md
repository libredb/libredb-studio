---
name: cut-release
description: Use when releasing libredb-studio - bumping the version for a release, tagging, publishing to npm/Docker/Helm/Snap/winget, monitoring a release chain, or recovering a release run that failed or published partially.
disable-model-invocation: true
---

# Cut a libredb-studio release

## Overview

A release is one tag push that fans out into a chain of workflows. Two properties drive every rule
below:

1. **GitHub releases in this repo are immutable.** Assets are frozen at publish time, so the release
   is built as a **draft**, verified complete, and **published LAST**. A published release can never
   receive a missing asset.
2. **Events created with `GITHUB_TOKEN` never trigger workflows.** Every edge in the chain is an
   explicit ref-pinned `gh workflow run`, not a `release: published` trigger.

```
bump commit on main -> all main workflows green -> draft release (hand-written notes)
  -> push bare tag -> release-artifacts: build assets -> verify asset set -> PUBLISH (last)
     -> dispatch npm-publish (--ref tag, NO version input)
     -> dispatch docker-build-push (--ref tag, publish_latest=true) -> dispatch helm-release (tag ref)
     -> dispatch operator-release (--ref tag)
     -> npm-publish dispatches npx-engine-smoke with the published version
```

Tags carry **no `v` prefix**: `0.9.65`, not `v0.9.65`.

## Phase 1 - Version bump commit on main

Direct pushes to `main` need the user's explicit authorization; otherwise open a PR.

**Order matters here.** Hand-edit the chart FIRST, run `chart:bump` LAST. `chart:bump` is what
refreshes `operator/helm-charts/libredb-studio/` from `charts/libredb-studio/`; a hand edit made
afterwards leaves that vendored copy stale, `chart:check` fails on the mismatch, and `chart:bump`
will not re-bump a version that is already in sync to repair it.

```bash
# 1. package.json "version" -> the new version, by hand
# 2. charts/libredb-studio/Chart.yaml artifacthub.io/changes -> rewrite by hand, see below
# 3. charts/libredb-studio/Chart.yaml description -> check the engine list, see below
bun run chart:bump            # Chart.yaml version+appVersion, image tag, chart README, operator chart copy
make -C operator bundle       # CSV version + controller image tag (reads package.json)
```

**Check `Chart.yaml`'s `description` against the engines that ship.** It is the string Rancher renders
on its Apps catalog card and ArtifactHub shows beside the chart, `chart:bump` never touches it, and it
has been left behind before: it still named seven engines after Couchbase, ClickHouse and Druid had
shipped, and was corrected only in chart 0.1.38, whose entire content is that sentence. Correcting it
on its own costs a whole chart version, because the #167 gate requires a `version:` bump for any
packaged-file edit once the current version is released - so **here** is where it is free, since this
step moves `version:` anyway. The chart `keywords` are the same check: ArtifactHub search matches on
them, and an engine missing there is an engine nobody finds. Read the engine count from `SHIPPED` in `src/lib/db/compatibility.ts` (minus the embedded
`libredb`) rather than from any prose, and check the same list in `README.md`, `DOCKERHUB.md` and
`deploy/rancher/CATALOG_LISTING.md` while you are here.

**Rewrite `artifacthub.io/changes` by hand, every release.** `chart:bump` *does* rewrite it, but only
to the single generic line `Track app release <version> (appVersion bump; default image tag follows)`
- its regex matches that wording and replaces it in place. So the failure mode is not a stale
changelog, it is a **meaningless** one: for a release carrying
`artifacthub.io/containsSecurityUpdates: "true"`, that one line is the entire changelog an operator
reads when deciding whether to upgrade. Write real entries, and keep one `Track app release` line
**last** so the next `chart:bump` can still find and update it. Each entry must be a single-line
**double-quoted** string - `scripts/sync-chart-version.mjs` enforces it, because ArtifactHub
permanently skips a chart version over unquoted `{}:[],&*#?|-<>=!%@`.

There is no second chance: once the chart version publishes, #167 blocks republishing it, so that
version's changelog is frozen as shipped.

Validate before committing:

```bash
bun run format && bun run lint && bun run typecheck && bun run knip && bun run test && bun run build
bun run test:coverage && bun run coverage:check     # 100% is a hard gate
bun run chart:check                                 # appVersion == package.json, changes-annotation quoting
bun run readme:check                                # localized READMEs match README.md
bun run security:check                              # docs/SECURITY.md vs the repository, both directions
helm lint charts/libredb-studio --strict
make -C operator bundle && git diff --exit-code operator/   # only AFTER committing, see below
```

Commit as `chore(release): <version> - <headline>`, then verify the operator bundle is fresh:

```bash
git add -A && git commit -m "chore(release): <version> - <headline>"
make -C operator bundle
git diff -I '^ *createdAt:' --exit-code operator/ && echo FRESH
git checkout -- operator/    # discard the createdAt-only rewrite
git push origin main
```

The freshness check is meaningless before the commit: it compares the working tree against `HEAD`, so
uncommitted bump edits always read as drift. CI runs it against the committed state.

## Phase 2 - Verify main before tagging

All six workflows must be green **on the bump commit**, because the tag will point at it:

```bash
gh run list --limit 6 --json name,status,conclusion,headSha \
  --jq '.[] | select(.headSha=="<bump-sha>") | "\(.name)\t\(.status)\t\(.conclusion // "-")"'
```

Expected: `CI`, `Docker Build and Push`, `Platform Integration Check`, `CodeQL Advanced` and
`Security Scan` all success, and `Helm Chart Release` success with its publish jobs **skipped** - the
image gate refuses to publish a chart whose `appVersion` image does not exist yet. A skipped publish
here is correct, not a failure; confirm it rather than assuming, because a chart published before the
app leaves the chain nothing to publish and #167 then blocks the retry. `Security Scan` joined this
list in 0.10.0 and is not a required check, so a red one does not block a merge - but on a release
commit, treat it as blocking anyway.
(Run this same query after tagging and `Release Artifacts` joins the list: the tag points at the bump
commit, so it shares the SHA.)

`helm repo add bitnami` (seven workflow sites: `ci.yml` x2, `helm-release.yml` x3, `npm-publish.yml`,
`operator-release.yml`) fetches a 27 MB index with no retry and flakes with
`connection reset by peer`. Verify the repo really is reachable, then re-run only the failed job:

```bash
curl -sSL -o /dev/null -w '%{http_code}\n' https://charts.bitnami.com/bitnami/index.yaml   # 200 via repo.broadcom.com
gh run rerun <run-id> --failed
```

## Phase 3 - Draft release with hand-written notes

Create the draft BEFORE pushing the tag. `release-artifacts` reuses an existing draft for the tag and
only generates notes when none exists.

```bash
gh release create <version> --draft --target main --title "<version>" --notes-file <notes.md>
gh release view <version> --json isDraft,tagName,body --jq '{isDraft, tagName, bodyStart: .body[0:80]}'
```

`gh release create --draft` prints an `untagged-<hash>` URL - that is normal for a draft with no tag
yet, and the release is still addressable as `<version>`.

Notes conventions: English, no emoji, `##` sections that explain the change and why it matters, a
`## Helm chart: <chart-version>` section, and the **last line must be a clickable compare URL**:

```
**Full changelog:** https://github.com/libredb/libredb-studio/compare/<prev>...<new>
```

## Phase 4 - Push the tag

```bash
git tag <version> <bump-sha> && git push origin <version>
```

## Phase 5 - Monitor the chain

```bash
gh run list --limit 4 --json databaseId,name,status,headBranch
gh run view <run-id> --json status,jobs \
  --jq '{status, running: [.jobs[] | select(.status!="completed") | .name], failed: [.jobs[] | select(.conclusion=="failure") | .name]}'
```

`release-artifacts` runs ~15-25 min (Snap amd64+arm64, Windows zip, deb/rpm, desktop AppImage/deb).
Never watch with `gh run watch` immediately after a push without confirming the run exists first, and
never use `gh pr checks --watch --required` right after a push: with no runs registered yet it exits
**0** with "no required checks reported", which reads as success.

The publish step verifies a fixed list of 22 **required** assets and refuses to publish an incomplete
release, so `Verify assets and publish release` is the single step that tells you whether the release
went public. Read that job's conclusion and the release's own `isDraft` - never infer publication from
the run's overall conclusion, in either direction.

The published release carries more than 22 assets: the two `.snap` files are outside the required list
because the snap jobs are credential-gated, but the store credentials are live, so they publish rather
than skip. 0.10.0 landed 20 jobs green with **nothing** skipped and 25 assets. If you ever see snap
skipping, that is an expired credential rather than the designed path.

## Phase 6 - Verify the published state

```bash
gh release view <version> --json isDraft,assets --jq '{isDraft, count: (.assets | length)}'
gh release list --limit 3        # <version> must hold the "Latest" marker, never a chart release
npm view @libredb/studio version
docker buildx imagetools inspect ghcr.io/libredb/libredb-studio:<version> | head -3
docker buildx imagetools inspect ghcr.io/libredb/libredb-studio:latest | head -3   # same digest
curl -s https://libredb.org/libredb-studio/index.yaml | grep -c "version: <chart-version>"
bun run distribution:check      # served-state drift table across channels
```

Reading `distribution:check` after a release - what "clean" looks like:

| Rows | Expected |
|---|---|
| `every_release` tier 0/1: github-release, docker-ghcr, docker-hub-mirror, npm, helm, homebrew, snap | **all OK at the new version.** Anything else here is a real chain failure |
| `winget` | DRIFT at the previous version until the auto-submitted manifest PR merges upstream (see Phase 7) |
| tier 2/3 PaaS: caprover x3, railway, dokploy, cosmos, kubero, fly-io | DRIFT is normal - `on_demand` SLA |
| linux-deb-rpm, appimage, flatpark, chocolatey, render, koyeb | SKIP by design, not a gap |

## Phase 7 - Post-release follow-ups

None of these belong in the bump commit or the chain; each needs the release to exist first.

| Follow-up | Why it waits |
|---|---|
| **winget manifest PR - watch only, do not run `wingetcreate`** | winget has no floating "latest", so every version needs its own manifests in `microsoft/winget-pkgs` - but the `winget` job in `release-artifacts.yml` now submits that PR itself, from `needs: [guard, publish-release, channels]` so it runs strictly after publish (the validation pipeline downloads `InstallerUrl`, which is only public once published). Confirm it: `gh search prs --repo microsoft/winget-pkgs "LibreDB.Studio" --state open`. The job skips cleanly when winget's `update.ci_enabled` is false, when `WINGETCREATE_GITHUB_TOKEN` is missing (classic PAT with `public_repo`; wingetcreate rejects fine-grained PATs), when the package has no listing yet, or when the version is already upstream - so a green job is not by itself proof a PR was opened. Only a genuinely missing PR calls for a manual `wingetcreate` |
| **PaaS template bumps** (caprover, railway, dokploy, cosmos, kubero, fly) | `on_demand` channels, several in upstream repos; batch them rather than blocking a release |
| **OperatorHub / community-operators catalogs** | FBC ships in TWO upstream PRs - bundle first, then rendered catalogs. The second is bot-created only when the bundle directory carries a `release-config.yaml`, and `operator/bundle/` currently ships none, so that PR must be opened by hand |
| **Chocolatey** | Gated off via `update.ci_enabled` in `distribution/channels.yaml` while the first push sits in community moderation |

## Recovery - what a failure costs

| Where it failed | Recovery | New version needed? |
|---|---|---|
| Any job BEFORE publish | Draft still exists: `gh release delete <version> --yes`, `git push --delete origin <version>`, `git tag -d <version>`, fix, re-tag | No |
| A downstream job AFTER publish (npm, docker, helm, operator, choco) | Re-dispatch that workflow pinned to the tag ref | No |
| Snap already pushed to the store, or npm already published | That artifact is immutable at that version | Yes - next patch |

**A published release is never withdrawn.** Every artifact in the chain is immutable at its version -
the GitHub release, the npm version, snap revisions, the chart tarball's index digest. A bad release is
fixed forward with the next patch, the way the ArtifactHub incident was closed; do not delete releases
or unpublish npm versions to "clean up".

Re-dispatch commands, exactly as the chain issues them:

```bash
gh workflow run npm-publish.yml --ref "refs/tags/<version>"                      # NO version input
gh workflow run docker-build-push.yml --ref "refs/tags/<version>" -f version=<version> -f publish_latest=true
gh workflow run helm-release.yml --ref "refs/tags/<version>"
gh workflow run operator-release.yml --ref "refs/tags/<version>" -f version=<version>
```

`npm-publish` must be dispatched with an **empty** version input: its `npm version <input>` step fails
with "Version not changed" whenever `package.json` already carries the tag version, which is always
true on a tag ref.

## Traps

| Trap | What happens |
|---|---|
| `artifacthub.io/changes` left to `chart:bump` | ArtifactHub shows one generic `Track app release` line as the whole changelog - and on a release flagged `containsSecurityUpdates`, that is the text an operator upgrades or does not upgrade on. Frozen once the chart publishes (#167) |
| `Chart.yaml`'s `description` left as it was | It names the engines and `chart:bump` never touches it, so it goes stale silently - and it is what Rancher's Apps card and ArtifactHub display. Fixing it later needs a chart version of its own (#167); this release is the free moment. Read the count from `SHIPPED` in `src/lib/db/compatibility.ts`, minus `libredb` |
| Chart hand-edited AFTER `chart:bump` | `operator/helm-charts/` keeps the pre-edit copy, `chart:check` fails on the mismatch, and `chart:bump` will not re-bump an already-in-sync version to fix it. Edit first, bump last |
| Chart version already released | Republishing rewrites the released chart's gh-pages index digest and OCI content (#167). `chart:check` blocks it; `force_republish` is the only escape hatch, for an asset-uploaded-but-index-failed run |
| Unquoted `{}:[],&*#?\|-<>=!%@` in a changes entry | ArtifactHub hard-skips that chart version, permanently |
| `packaging/flatpark/` bumped as part of a release | Do not touch it. FlatPark's bot has owned the pin since the 0.9.62 submission merged - it re-runs `resolve-update.sh` after each of our releases and rewrites its own copy, so this directory drifts by design (it still reads 0.9.62) and must stay out of release work. Bumping half of it fails `tests/unit/flatpark-descriptor.test.ts`, which requires the metainfo's newest `<release>` to equal the version the manifest pins as extra-data |
| `gh release create --target <short-sha>` | Rejected ("target_commitish is invalid") - use `--target main` |
| A `release-artifacts` run reporting `failure` | The release may still have published fine; check `Verify assets and publish release` before assuming otherwise |
| Reusing a failed release's version after Snap published | Snap store revisions are immutable per version; bump the patch instead |
| Renaming or removing the `test:ci` script | `npm-publish.yml` validates with `bun run test:ci` (per-file process isolation via `tests/run-core.sh`), NOT `bun run test`. Losing that script breaks every release and every re-dispatch |
| Recreating a draft after a failed run | The hand-written notes are gone with it. Keep the notes file in the scratchpad and re-apply with `gh release edit <version> --notes-file <f>` |
| A release that touches `packaging/`, the Dockerfile or the payload scripts | The chain builds channels you cannot see locally. Validate them locally first (tarball/npx/docker build+run, deb/rpm with the CI-pinned nfpm) - that local pass is what separated the clean one-attempt releases from the four-attempt one |

## Red flags - stop and re-read this skill

- About to publish a release before its assets exist
- About to add a `v` prefix to a tag
- About to pass a version input to `npm-publish`
- About to dispatch a chain workflow without `--ref refs/tags/<version>`
- About to merge or push `charts/**` without bumping the chart version
- About to declare the release done because no check is red - count the runs by name instead
