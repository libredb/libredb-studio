# FlatPark packaging (issue #241)

[FlatPark](https://flatpark.org/) is a signed Flatpak remote that repackages **official vendor
downloads** as Flatpak `extra-data`. It does not build from source: the manifest pins a release
asset by URL and digest, the user's machine downloads it at install time, and `apply_extra`
unpacks it inside the sandbox.

This directory is the staged copy of what becomes `registry/org.libredb.Studio/` in
[flatpark/flatpark](https://github.com/flatpark/flatpark). It lives here so the descriptor set is
reviewed, versioned and locally verifiable in the same repo as the artifact it pins.

## Why a GUI `.deb` and not the AppImage

FlatPark rejects AppImages outright: unpacking one needs libfuse, which is not in the Flatpak
runtime. It accepts `.deb`, `.rpm`, `.tar.gz`, zip or an official installer. The
`libredb-studio_<version>_<arch>.deb` we already shipped is the **headless systemd server**, so
issue #241 added a second, separate package built by the Tauri bundler:

    libredb-studio-desktop_<version>_<arch>.deb

Different file name *and* different dpkg package name (`libredb-studio-desktop` vs
`libredb-studio`), so the two coexist in one release and on one machine.

## Files

| File | Role |
|---|---|
| `flatpark.yml` | Catalog descriptor: identity, tags, `update.command`, policy flags |
| `org.libredb.Studio.yml` | Flatpak manifest: runtime, `finish-args`, the managed extra-data block |
| `apply_extra.sh` | Runs offline at install time; unpacks the `.deb` with `bsdtar` |
| `libredb-studio-wrapper` | `/app/bin/libredb-studio`; sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` |
| `org.libredb.Studio.desktop` | Desktop entry, installed at build time |
| `org.libredb.Studio.metainfo.xml` | AppStream metainfo, installed at build time |
| `org.libredb.Studio.png` | 256x256 icon, installed at build time |
| `resolve-update.sh` | Prints `{version, releaseDate, sources}` so FlatPark's bot can re-pin |

`apply_extra.sh` keeps the whole `usr` tree rather than cherry-picking the binary: the shell
resolves its resources as `<exe dir>/../lib/<product name>`, so `usr/bin` has to stay next to
`usr/lib/libredb-studio-desktop`.

## x86_64 only, deliberately

The manifest pins `only-arches: [x86_64]` and `resolve-update.sh` matches `_amd64.deb`, so **the
arm64 GUI `.deb` is a normal release asset that FlatPark does not consume**. This matches the
catalog: 46 of its 47 entries are x86_64-only. Releases publish both arches regardless, so adding
arm64 later is a second `extra-data` source plus a resolver that emits two entries in `sources` -
no new release wiring. Do not treat the arm64 asset as dead weight or drop it from the required
release assets.

## Build and run it locally

No published release is needed. One-time setup:

    flatpak install -y flathub org.flatpak.Builder org.gnome.Platform//50 org.gnome.Sdk//50

Then two steps - build the artifact, then the Flatpak that pins it:

    # 1. The GUI .deb. --deb-only skips the AppImage, so the linuxdeploy GTK
    #    toolchain (librsvg2-dev and friends) is not required.
    gh release download <version> --repo libredb/libredb-studio \
      --pattern "libredb-studio-standalone-<version>-linux-x64.tar.gz"
    bash scripts/build-desktop-appimage.sh dist-desktop \
      --payload libredb-studio-standalone-<version>-linux-x64.tar.gz --deb-only --smoke

    # 2. The Flatpak, then run it.
    bash scripts/build-flatpark-local.sh \
      dist-desktop/libredb-studio-desktop_<version>_amd64.deb --install
    flatpak run org.libredb.Studio//stable

Drop `--payload` to build the payload from the working tree instead of a released tarball - slower,
but it tests the code you actually have. Building the `.deb` still needs bun, node, Rust >= 1.88 and
the Tauri Linux dependencies listed in [`desktop/README.md`](../../desktop/README.md).

The script serves the local `.deb` over HTTP (extra-data accepts only `http`/`https`, never
`file://`), rewrites the managed block to point at it with the real digest and size, validates the
metainfo, builds on branch `stable`, and optionally installs. The install step is the one that
matters most: extra-data is fetched and `apply_extra` runs there, so a successful install is what
proves the `bsdtar` unpack works - the build alone only proves the manifest parses.

`--installation <name>` targets a named Flatpak installation instead of the per-user one. It must be
registered in `/etc/flatpak/installations.d`; do **not** improvise isolation with `FLATPAK_USER_DIR`,
which produces an installation `flatpak-spawn` and the GNOME image decoder cannot see, and the app
then aborts at startup in a way that looks exactly like a packaging bug.

To remove a local build:

    flatpak --user uninstall -y org.libredb.Studio//stable
    flatpak --user remote-delete libredb-flatpark-local

`~/.var/app/org.libredb.Studio/` is keyed on the app id, so it is **shared with any other local
build of this app** (for example the Flathub AppImage repack on a different branch). Deleting it
resets connections and query history for all of them.

FlatPark's own validators must also pass, run from a checkout of `flatpark/flatpark` with this
directory copied to `registry/org.libredb.Studio/` (their playbook calls these mandatory on every
run):

    node scripts/read-descriptor.mjs registry/org.libredb.Studio/flatpark.yml
    node scripts/audit-descriptor.mjs registry/org.libredb.Studio/flatpark.yml
    scripts/build-app.sh org.libredb.Studio          # appstreamcli compose must print Success
    scripts/check-apply-extra.sh org.libredb.Studio  # unpack as root with capabilities dropped

`read-descriptor.mjs` passes today. `audit-descriptor.mjs` reports exactly one failure - the
placeholder pin below - and passes cleanly once a real published digest and size are substituted.

## Two deliberate deviations, both worth raising in the PR

**The file set follows the playbook, not the contributing page.** `flatpark.org/contributing/` lists
five files and names an `<app-id>.svg`; `docs/packaging-playbook.md` lists the eight files shipped
here and names an `<app-id>.png`. The playbook wins: 43 of the 47 catalog entries ship a PNG and
only 4 ship an SVG. Do not "fix" the icon to SVG.

**The metainfo does not call this a community package.** The playbook asks for that wording, but it
would be false: LibreDB packages its own application. The required "repackages the official upstream
build unmodified" claim is kept verbatim, and the first paragraph says who maintains it instead.
This is the same situation as `io.github.todevelopers.GseProfiler` and `dev.adonm.zuko`, both
recorded upstream as "approved by construction - submitted and maintained by its own developer".

## Before opening the upstream PR

1. **The pin must be real.** The committed manifest points at `0.9.62` with a placeholder
   `sha256`/`size`, because the GUI `.deb` first ships in that release. Replace all three with the
   published values, and refresh the newest `<release>` in the metainfo (version **and** date) to
   match. FlatPark's `audit-descriptor.mjs` fails on a zero digest.
2. Re-run the local verification above against the real release URL.
3. Copy this directory into a fork of `flatpark/flatpark` as `registry/org.libredb.Studio/`,
   dropping this README, on branch `add/org.libredb.Studio`. A maintainer merges it; never
   self-merge.
4. **Claim the developer-approved badge.** LibreDB packages its own app, which is FlatPark's
   "approved by construction" case. Set `catalog.upstream_approved: true` in `flatpark.yml` **and**
   add a row to their `docs/upstream-approvals.md` citing this submission PR, in the same PR - their
   `scripts/check-approvals.sh` fails a `true` flag with no matching row. The PR link is the
   evidence, so this lands as a follow-up commit once the PR number exists.
5. Record in the PR body what was exercised and what was not - they ask for this explicitly. The
   walkthrough in issue #241 covers GUI rendering on a real session, the embedded SQLite sample and
   a PostgreSQL TCP connection returning rows.
6. Disclose the pending Flathub submission (flathub/flathub#9538) in the PR body. Their gate is
   "not *already* on Flathub", which we satisfy (`flathub.org/api/v2/appstream/org.libredb.Studio`
   404s), and `docs/discovery-pipeline.md` treats a stalled Flathub PR as FlatPark's opening - but
   say so plainly and let the maintainer judge.

## After it merges, this copy drifts

FlatPark's CI owns the pins from then on: its bot re-runs `resolve-update.sh` and rewrites the
managed extra-data block and the `<releases>` list in the registry copy. **This staged directory
is not kept in sync automatically and must not be wired into any release gate** (it is deliberately
absent from `chart:bump` and from the required-asset list). Treat it as the submission source and
as documentation of the packaging decisions, not as the live descriptor.

## Relationship to Flathub

`packaging/flatpak/` is the Flathub manifest, which repacks the **AppImage** at build time on
Flathub's infrastructure. The two channels are deliberately independent: different artifact,
different fetch model, different review policy. FlatPark's guidance is that an app already on
Flathub should be installed from there, so if flathub/flathub#9538 is accepted, revisit whether to
keep this listing.
