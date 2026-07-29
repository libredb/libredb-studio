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

## Local verification

    scripts/build-flatpark-local.sh dist-desktop/libredb-studio-desktop_<version>_amd64.deb --install
    flatpak run org.libredb.Studio

The script serves the local `.deb` over HTTP (extra-data accepts only `http`/`https`, never
`file://`), rewrites the managed block to point at it with the real digest and size, validates the
metainfo, builds, and optionally installs into an isolated Flatpak installation.

## Before opening the upstream PR

1. **The pin must be real.** The committed manifest points at `0.9.62` with a placeholder
   `sha256`/`size`, because the GUI `.deb` first ships in that release. Replace all three with the
   published values, and refresh the newest `<release>` in the metainfo (version **and** date) to
   match. FlatPark's `audit-descriptor.mjs` fails on a zero digest.
2. Re-run the local verification above against the real release URL.
3. Copy this directory into a fork of `flatpark/flatpark` as `registry/org.libredb.Studio/`,
   dropping this README, on branch `add/org.libredb.Studio`. A maintainer merges it; never
   self-merge.
4. Disclose the pending Flathub submission (flathub/flathub#9538) in the PR body. FlatPark's
   playbook asks that an app not already be on Flathub; ours is not, but the submission is open
   and the maintainer may want to weigh in.

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
