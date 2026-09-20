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
3. **A green chain is not a working release.** The chain builds and ships the image, so it can never
   be the thing that catches an image that does not run. Phase 7 pulls the published tag and drives
   it in a browser against real engines; it is part of the release, not an optional extra.

```
bump commit on main -> all main workflows green -> draft release (hand-written notes)
  -> push bare tag -> release-artifacts: build assets -> verify asset set -> PUBLISH (last)
     -> dispatch npm-publish (--ref tag, NO version input)
     -> dispatch docker-build-push (--ref tag, publish_latest=true) -> dispatch helm-release (tag ref)
     -> dispatch operator-release (--ref tag)
     -> npm-publish dispatches npx-engine-smoke with the published version
  -> verify the registry rows moved (Phase 6)
  -> pull `latest`, run it, drive it in a browser on two engines, read the logs (Phase 7)
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

**`Docker Build and Push` success is not one answer any more.** Since #840 it fans out over three
image variants, six jobs: `Build and Push (debian|alpine|alpine-slim)` and
`Channel E2E (docker, debian|alpine|alpine-slim)`. `fail-fast` is off on purpose, so an
`-alpine-slim` that will not build does not cancel the image every user pulls - which also means a
red leg can sit beside two that pushed their tags. Count the legs rather than reading the run's
conclusion:

```bash
gh run view <docker-run-id> --json jobs --jq '.jobs[] | "\(.name)\t\(.conclusion)"'
```

`helm repo add bitnami` (eight workflow sites: `ci.yml` x3, `helm-release.yml` x3, `npm-publish.yml`,
`operator-release.yml`) fetches a 27 MB index with no retry and flakes with
`connection reset by peer`. Verify the repo really is reachable, then re-run only the failed job:

```bash
curl -sSL -o /dev/null -w '%{http_code}\n' https://charts.bitnami.com/bitnami/index.yaml   # 200 via repo.broadcom.com
gh run rerun <run-id> --failed
```

Those eight sites do **not** all pin the same Helm CLI. Seven run Helm 4.1.3; `helm-release.yml`'s
`lint-test` job stays on Helm 3.16 on purpose, because its two `ct install` runs are the only place
the chart is installed into a cluster and our users install with Helm 3. The split is enforced by
`tests/unit/helm-pin-matrix.test.ts` in the required test lane - do not unify the odd one out.

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

The publish step verifies a fixed list of 24 **required** assets and refuses to publish an incomplete
release, so `Verify assets and publish release` is the single step that tells you whether the release
went public. Read that job's conclusion and the release's own `isDraft` - never infer publication from
the run's overall conclusion, in either direction.

The published release carries more than 24 assets: the two `.snap` files and the snap's own
`.sha256` are outside the required list
because the snap jobs are credential-gated, but the store credentials are live, so they publish rather
than skip. 0.10.0 landed 20 jobs green with **nothing** skipped and 25 assets. If you ever see snap
skipping, that is an expired credential rather than the designed path.

## Phase 6 - Verify the published state

```bash
gh release view <version> --json isDraft,assets --jq '{isDraft, count: (.assets | length)}'
gh release list --limit 3        # <version> must hold the "Latest" marker, never a chart release
npm view @libredb/studio version
# Three image variants ship per release (#840), and each needs its own check:
# `latest<suffix>` must resolve to the digest `<version><suffix>` resolves to, or
# that variant's users sit on an older image while the release reads as complete.
for s in "" "-alpine" "-alpine-slim"; do
  v=$(docker buildx imagetools inspect "ghcr.io/libredb/libredb-studio:<version>$s" --format '{{json .Manifest.Digest}}')
  l=$(docker buildx imagetools inspect "ghcr.io/libredb/libredb-studio:latest$s" --format '{{json .Manifest.Digest}}')
  [ "$v" = "$l" ] && echo "OK    latest$s" || echo "DRIFT latest$s=$l vs <version>$s=$v"
done
curl -s https://libredb.org/libredb-studio/index.yaml | grep -c "version: <chart-version>"
bun run distribution:check      # served-state drift table across channels
```

Reading `distribution:check` after a release - what "clean" looks like:

| Rows | Expected |
|---|---|
| `every_release` tier 0/1: github-release, docker-ghcr, docker-hub-mirror, npm, helm, homebrew, snap | **all OK at the new version.** Anything else here is a real chain failure |
| `winget` | DRIFT at the previous version until the auto-submitted manifest PR merges upstream (see Phase 8) |
| tier 2/3 PaaS: caprover x3, railway, dokploy, cosmos, kubero, fly-io | DRIFT is normal - `on_demand` SLA |
| linux-deb-rpm, appimage, flatpark, chocolatey, render, koyeb | SKIP by design, not a gap |

## Phase 7 - Smoke the published image

Phase 6 proves the registry rows moved. It does not prove the thing they point at runs, and every
check before this one is satisfied by an image that boots to a stack trace. Run the published
artifact, drive it in a real browser against two engines, and read its logs. Do this on every
release, and do not skip it because the chain was green: the chain builds the image, so it cannot be
the thing that catches an image that does not work.

Use `latest`, not `<version>`, and assert it resolves to the version's digest. That is the tag
almost every user pulls, and pulling it is also the last check that `latest` really moved.

```bash
docker rmi -f ghcr.io/libredb/libredb-studio:latest 2>/dev/null   # a stale local copy passes every test below
docker pull ghcr.io/libredb/libredb-studio:latest
docker image inspect ghcr.io/libredb/libredb-studio:latest --format '{{index .RepoDigests 0}}'
# ^ must equal the <version> digest Phase 6 printed. If it does not, latest did not move and
#   everything below measures the PREVIOUS release.

docker network create libredb-verify
docker run -d --name lv-pg --network libredb-verify \
  -e POSTGRES_PASSWORD=verifypass -e POSTGRES_USER=verifier -e POSTGRES_DB=shopdb postgres:18-alpine
# seed two tables, a view and a handful of rows, so counts and values are known in advance

docker run -d --name lv-studio --network libredb-verify -p 3399:3000 \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e ADMIN_PASSWORD='VerifyAdmin123!' -e USER_PASSWORD='VerifyUser123!' \
  -e AUTH_COOKIE_SECURE=false \
  -v "$PWD/verify-data:/data" \
  ghcr.io/libredb/libredb-studio:latest
```

`JWT_SECRET` is generated rather than written out: a credential-shaped literal in this file is a
`generic-api-key` hit in `Secret Scan`, which scans all of history, so pasting a fixed one here
costs a `.gitleaksignore` fingerprint that can never be removed. Nothing in this phase needs to know
it. The two passwords are literals because the browser step has to log in with them.

`AUTH_COOKIE_SECURE=false` is required, not optional: over plain HTTP the cookie is dropped and
login fails in a way that looks like bad credentials. Port 3399 rather than 3000 because another
agent's dev server or Playwright run may already hold 3000, and testing someone else's app is the
one failure this phase cannot detect. The default `ADMIN_EMAIL` is `admin@libredb.org`
(`.env.example`), not the password variable's name.

What to assert, in order, stopping at the first failure:

| Check | What passing looks like |
|---|---|
| Container state | `status=running restarts=0 oom=false`. A restart count above 0 is a crash loop that a later `curl` would still answer |
| Startup banner | `LibreDB Studio <version>` in `docker logs`. This is the only place the running code states its own version; the tag can lie, the banner cannot |
| `/health`, `/api/health`, `/api/db/health` | all 200. Three paths since 0.16.1, and a platform with a fixed probe path depends on the first two |
| Login through the browser | lands on `/admin/overview`, and the login page footer shows `v<version>` |
| PostgreSQL connection | Test Connection reports connected; the object tree counts the tables and views you seeded, exactly |
| SQLite connection | same, against a file mounted into `/data`, which also proves the volume path works |
| A query on each | row count, values and column types match what the engine itself returns. Run the same SQL through `psql` and compare, rather than eyeballing the grid |
| **A row-identity edit on each** | see below. This is the check worth the most |
| Container logs | no `[ERROR`, no stack trace, no unhandled rejection |
| Browser console | zero errors |

**The row-identity edit is the probe that earns this phase.** Everything above passes on an app that
renders correctly and writes to the wrong place, which is exactly the defect 0.16.1 shipped to fix
(#969) and the kind of defect a released IDE must never have. Drive it as a user does:

1. Query a table so the grid shows a column you can sort on, and note which id sits at which position.
2. Sort by a column so that the visual order differs from the row order. Confirm it differs: with
   ids 1..4 sorted descending by a text column, position 0 must now hold something other than id 1.
3. Click `EDIT`, change a cell in a row whose position no longer matches its id, and apply
   (`Apply changes`, an icon-only button - find it by accessible name, not by its glyph).
4. Read the table back **from the engine**, not from the grid. The edited row must be the one you
   edited, and every other row must be byte-identical to before.

A grid that repaints correctly while writing elsewhere passes step 3 and fails step 4, which is why
step 4 is not optional and why the comparison is against the engine.

Driving the browser, the three traps that cost the most time:

- Monaco intercepts clicks on its own hidden textarea. Click `.monaco-editor .view-line` and then
  type with the keyboard; clicking the textarea times out against a `view-line` pointer interception.
- A click that opens a dialog often returns a snapshot taken before the dialog mounts. Take a fresh
  snapshot rather than concluding the click did nothing, and see
  `playwright-react-click-and-monaco-typing` for the case where the React handler really did not fire.
- Grepping logs for `error|fatal|stack` matches the startup line `dual-stack verified`. Read the
  matches rather than counting them.

When a release introduces a NEW image variant, smoke every variant, not just the default. The
variants share no base layers and the Channel E2E job proves each one browses, but only a local run
proves the tag a user types resolves and boots:

```bash
for v in alpine alpine-slim; do
  docker run -d --name lv-$v --network libredb-verify -p 0:3000 \
    -e JWT_SECRET="$(openssl rand -base64 32)" \
    -e ADMIN_PASSWORD='VerifyAdmin123!' -e AUTH_COOKIE_SECURE=false \
    ghcr.io/libredb/libredb-studio:<version>-$v
done
# then per variant: the startup banner's version, /health, and `docker image inspect --format '{{.Size}}'`
```

Sizes are a claim the docs make, so they are a claim to check: 0.16.1 measured 651 MB debian,
372 MB alpine, 182 MB alpine-slim.

**Clean up when you are done**, always, including after a failure:

```bash
docker rm -f lv-studio lv-pg lv-alpine lv-alpine-slim; docker network rm libredb-verify
```

A failure here does not unpublish anything - see Recovery below, and remember the release is already
immutable. What it buys is knowing before the users do, and a next-patch decision made on measured
behaviour rather than on a guess.

## Phase 8 - Post-release follow-ups

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
| ONE image variant's leg, beside two that pushed their tags | Re-dispatch docker with `-f variant=<debian\|alpine\|alpine-slim>`, which rebuilds that leg alone. Never re-dispatch all three here: the two that succeeded already published `<version>` and `<version>-alpine`, the Docker Hub mirror's immutability rule is semver-scoped and matches both, and buildx exports every tag in one step - so the rejected mirror tag fails the whole job with GHCR already written. A single-variant dispatch also skips the chart dispatch by design | No |
| Snap already pushed to the store, or npm already published | That artifact is immutable at that version | Yes - next patch |

**A published release is never withdrawn.** Every artifact in the chain is immutable at its version -
the GitHub release, the npm version, snap revisions, the chart tarball's index digest. A bad release is
fixed forward with the next patch, the way the ArtifactHub incident was closed; do not delete releases
or unpublish npm versions to "clean up".

Re-dispatch commands, exactly as the chain issues them:

```bash
gh workflow run npm-publish.yml --ref "refs/tags/<version>"                      # NO version input
gh workflow run docker-build-push.yml --ref "refs/tags/<version>" -f version=<version> -f publish_latest=true
# ...or one variant alone, when the other legs already published (see Recovery):
gh workflow run docker-build-push.yml --ref "refs/tags/<version>" -f version=<version> -f publish_latest=true -f variant=alpine
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
| Renaming or removing the `test` script | `npm-publish.yml` validates with `bun run test`, which is `bun tests/run-tests.ts` (one bun process per test file). Losing that script breaks every release and every re-dispatch |
| Recreating a draft after a failed run | The hand-written notes are gone with it. Keep the notes file in the scratchpad and re-apply with `gh release edit <version> --notes-file <f>` |
| Calling the release verified because `distribution:check` is clean | Every row there reads a registry or a catalog. They all go green for an image that boots to a stack trace, because nothing in the chain ever runs the artifact it publishes. Phase 7 is what closes that, and it is the only phase whose failure the users would otherwise find first |
| Smoke-testing `<version>` instead of `latest` | `<version>` can be correct while `latest` still points at the previous release, which is what almost every user pulls. Pull `latest` and assert its digest equals the version's. A stale LOCAL copy does the same damage, so `docker rmi -f` before the pull |
| Reading the grid to confirm an edit landed | A grid that repaints correctly while writing to another row passes every on-screen check. Read the table back from the engine, and compare the rows you did NOT edit as well as the one you did |
| A release that touches `packaging/`, the Dockerfile or the payload scripts | The chain builds channels you cannot see locally. Validate them locally first (tarball/npx/docker build+run, deb/rpm with the CI-pinned nfpm) - that local pass is what separated the clean one-attempt releases from the four-attempt one |

## Red flags - stop and re-read this skill

- About to publish a release before its assets exist
- About to add a `v` prefix to a tag
- About to pass a version input to `npm-publish`
- About to dispatch a chain workflow without `--ref refs/tags/<version>`
- About to merge or push `charts/**` without bumping the chart version
- About to declare the release done because no check is red - count the runs by name instead
- About to close out a release without ever having RUN the published image (Phase 7)
- About to report an edit as correct from the grid rather than from the engine
