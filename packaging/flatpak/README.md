# Flathub packaging (org.libredb.Studio)

> **Status: dormant. LibreDB Studio is not on Flathub, and this is not being pursued.**
> The submission ([flathub/flathub#9538](https://github.com/flathub/flathub/pull/9538)) was
> declined on 2026-07-30 under Flathub's [generative AI
> policy](https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy): the
> reviewer's position was that developing with an AI assistant disqualifies the app. We closed the
> PR ourselves rather than argue it - the [closing
> comment](https://github.com/flathub/flathub/pull/9538#issuecomment-5136879185) leaves the
> maintenance record on the thread. **Point Flatpak users at
> [FlatPark](../flatpark/README.md)**, which is live and ships the same app id.
>
> This directory stays because it still earns its keep: `flatpak-smoke.yml` builds the AppImage and
> repacks it with this manifest whenever the paths it watches change, which is real coverage of the
> desktop artifact. Read the checklist below as a record of how the submission was made, not as a
> to-do - a resubmission would have to clear the from-source requirement as well.

The manifest and metadata for publishing the LibreDB Studio desktop app on
[Flathub](https://flathub.org). Issue
[#232](https://github.com/libredb/libredb-studio/issues/232).

| File | Role |
|---|---|
| `org.libredb.Studio.yml.tmpl` | Flatpak manifest template; `{{VERSION}}` / `{{SHA256_*}}` filled by `scripts/render-flatpak-manifest.mjs` |
| `org.libredb.Studio.metainfo.xml` | AppStream metadata for the store listing |
| `org.libredb.Studio.desktop` | desktop entry installed as `${FLATPAK_ID}.desktop` |
| `libredb-studio.sh` | `/app/bin/libredb-studio`, the `command:` the manifest declares |

## How it works

The manifest repacks the AppImage that release CI publishes: it downloads the
release asset, runs `--appimage-extract`, drops the AppImage's bundled WebKit
helper processes (the GNOME runtime provides its own), installs the app tree
under `/app/libredb-studio` and adds our app-id-named desktop entry, metainfo and
icons. Flathub's External Data Checker follows the `x-checker-data` blocks and
opens a version-bump pull request when a new release appears.

Two deliberate choices worth knowing before changing anything:

- **`org.gnome.Platform`, not `org.freedesktop.Platform`.** The shell is a Tauri
  (WebKitGTK) binary and only the GNOME runtime ships `webkit2gtk-4.1`. The
  runtime version in the manifest, the GNOME version of the CI container image in
  `.github/workflows/flatpak-smoke.yml`, and the SDK installed locally must all
  match.
- **Repacking a released AppImage instead of building from source.** The AppImage
  is our own MIT-licensed release artifact, already built and smoke-tested for
  every version, so Flathub ships the exact bytes every other channel ships and
  there is a single build pipeline. This is the pattern Beekeeper Studio (and
  Signal, Element) use on Flathub. Note how #9538 actually went: the AI policy
  ended the review before the repack was ever discussed, so this remains an
  untested argument and an open blocker, not a settled one. Flathub's written
  requirements say submissions must be built entirely from source and that
  "niche tooling or uncommon build setups" is not itself grounds for an
  exception. A from-source alternative exists on paper
  (`flatpak-cargo-generator` plus `flatpak-node-generator`) at the cost of a
  second, offline-vendored build of the whole Next.js app - and it is not
  turnkey, because the node generator has no Bun support.

## Sandbox

`finish-args` is deliberately minimal: window system, GPU, IPC and network. There
is no `--filesystem=` permission, so out of the box the app can reach databases
over TCP (including `127.0.0.1` on the host) and nothing else. Users who need
more grant it themselves:

```bash
# Local Postgres over its unix socket
flatpak override --user --filesystem=/run/postgresql:ro org.libredb.Studio
# Local MySQL/MariaDB over its unix socket
flatpak override --user --filesystem=/var/run/mysqld:ro org.libredb.Studio
# Opening SQLite database files kept in a specific directory
flatpak override --user --filesystem=~/databases org.libredb.Studio
# Revert
flatpak override --user --reset org.libredb.Studio
```

Application state (SQLite storage, generated admin credentials, tab layout) lives
in `~/.var/app/org.libredb.Studio/`.

## Build and test locally

```bash
# 1. Tools (one-time). The GNOME major must match runtime-version in the manifest.
flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50

# 2. Build the AppImage this manifest repacks
scripts/build-desktop-appimage.sh dist --smoke

# 3. Render the manifest against that local AppImage, lint, build, install
scripts/build-flatpak-local.sh dist/libredb-studio-desktop-<version>-linux-x64.AppImage --install

# 4. Run it
flatpak run org.libredb.Studio
```

Step 3 lints the *release* manifest (URLs and checksums as Flathub will see them)
and validates the metainfo, then builds the *local* variant, so a run before any
release exists still exercises what Flathub will build. Outputs land in
`build/flatpak/` (git-ignored).

## Submission checklist (as executed for #9538)

Kept as a record. Nothing here is scheduled; see the status note at the top.

1. Ship a release whose assets include
   `libredb-studio-desktop-<version>-linux-x64.AppImage` and the `arm64` one
   (the AppImage job in `.github/workflows/release-artifacts.yml`).
2. Add a `<release>` entry for that version to `org.libredb.Studio.metainfo.xml`.
   Flathub requires a `releases` list, and the External Data Checker does not
   maintain it - only the manifest sources.
3. Render the manifest for that version:
   ```bash
   gh release download <version> --pattern 'libredb-studio-desktop-*.AppImage.sha256' --dir dist
   cat dist/*.sha256 > dist/appimage-sums.txt
   node scripts/render-flatpak-manifest.mjs \
     packaging/flatpak/org.libredb.Studio.yml.tmpl dist/appimage-sums.txt <version> \
     dist/org.libredb.Studio.yml
   ```
4. Fork [flathub/flathub](https://github.com/flathub/flathub), branch off
   `new-pr`, and add the rendered manifest, the metainfo, the desktop entry and
   `libredb-studio.sh` at the repository root. Open the PR against base branch
   `new-pr`, titled `Add org.libredb.Studio`, and explain the AppImage repack
   choice in the description. See
   [docs.flathub.org/docs/for-app-authors/submission](https://docs.flathub.org/docs/for-app-authors/submission).
5. After the app repository (`flathub/org.libredb.Studio`) is created, request
   domain verification in the Flathub developer portal. It issues a per-app token
   that has to be published, one per line, at
   `https://libredb.org/.well-known/org.flathub.VerifiedApps.txt` (served by
   libredb-website). The token only exists after submission, so this is a
   follow-up step, not a prerequisite.
6. Keep this directory and the Flathub repository in sync: this is the source of
   truth, Flathub holds the rendered copy. Only Flathub org actions and
   `peter-evans/create-pull-request` may run in that repository, and `flat-manager`
   is never wired from here.

## Not to be confused with packaging/flatpark

[`packaging/flatpark/`](../flatpark/) is a second, independent Flatpak channel
(issue [#241](https://github.com/libredb/libredb-studio/issues/241)). It targets
the [FlatPark](https://flatpark.org/) remote, which does not build anything: it
pins the GUI `.deb` as `extra-data` and the user's own machine downloads and
unpacks it at install time. Flathub, by contrast, repacks the **AppImage** at
build time on Flathub's infrastructure. Different artifact, different fetch
model, different review policy - so the two manifests are deliberately separate
files rather than one shared template.

One shared constraint: from 0.9.62 the bundled Node sidecar inside the AppImage
is named `libredb-studio-node` rather than `node` (the GUI `.deb` cannot claim
`/usr/bin/node`). The manifest template here accepts either name, so it still
builds against an AppImage from before the rename.
