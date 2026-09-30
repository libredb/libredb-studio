# Arch Linux (AUR): `libredb-studio-bin`

The AUR package for LibreDB Studio ([#971](https://github.com/libredb/libredb-studio/issues/971)).
It repackages the prebuilt `libredb-studio-standalone-<version>-linux-{x64,arm64}.tar.gz` release
assets, so the AUR rules call for the `-bin` suffix. Nothing is compiled.

```bash
paru -S libredb-studio-bin          # or: yay -S libredb-studio-bin
sudo systemctl enable --now libredb-studio
journalctl -u libredb-studio        # the generated admin password is printed once
```

The service listens on `127.0.0.1:3000`. Configuration is `/etc/libredb-studio/env`, state and the
generated credentials live in `/var/lib/libredb-studio`. Removing the package leaves that directory
in place, so a reinstall keeps the existing credentials.

## Files

| File | Purpose |
|---|---|
| `PKGBUILD` | The package. Header comments say why each non-obvious choice was made. |
| `libredb-studio-bin.install` | Prints the first-run note on install and the restart hint on upgrade. |
| `.SRCINFO` | Generated from `PKGBUILD` with `makepkg --printsrcinfo`; the AUR rejects a push without it. |

The launcher, the systemd unit and the env file are **not** copied here. `PKGBUILD` fetches the three
files from `packaging/linux/` at the release tag and pins them by checksum, so the AUR package installs
exactly what the `.deb` and `.rpm` install and cannot drift from them.

## Design notes

- **Node.** The standalone tarball carries no runtime (the `.deb` and `.rpm` add one in
  `packaging/linux/fetch-node.sh`). The launcher execs `$LIBREDB_STUDIO_HOME/node/bin/node`, so
  `package()` symlinks that path to `/usr/bin/node` and the package depends on `nodejs-lts-krypton`
  (24.x, the `engines.node` floor), which provides `/usr/bin/node`. Arch's own `nodejs` is on 26.x.
  It is the same pin as the Homebrew formula's `node@24`. **If `engines.node` moves to a newer LTS,
  change this `depends` with it.**
- **`research/` is removed.** It holds the paper sources and Python scripts of the agent-failure study.
  Next.js traced the folder into the payload, but no compiled code reads it, and keeping it makes
  `namcap` report a missing `python` dependency.
- **Architectures.** `x86_64` and `aarch64`, each with its own source and checksum.

## Release checklist

An AUR package that is not bumped is flagged out-of-date and eventually orphaned, so every release
ends with these steps. They are manual on purpose: the push needs the maintainer's SSH key.

```bash
cd packaging/aur
VERSION=0.18.0

# 1. Version. Reset pkgrel when pkgver changes.
sed -i "s/^pkgver=.*/pkgver=$VERSION/; s/^pkgrel=.*/pkgrel=1/" PKGBUILD

# 2. Payload digests, taken from the release's own SHA256SUMS. Never use SKIP.
curl -fsSL "https://github.com/libredb/libredb-studio/releases/download/$VERSION/SHA256SUMS" \
  | grep -E 'linux-(x64|arm64)\.tar\.gz'
#    Paste them into sha256sums_x86_64 (linux-x64) and sha256sums_aarch64 (linux-arm64).

# 3. Digests of the three packaging/linux files at the tag. They only change when those files do.
for f in libredb-studio libredb-studio.service env; do
  curl -fsSL "https://raw.githubusercontent.com/libredb/libredb-studio/$VERSION/packaging/linux/$f" | sha256sum
done
#    Paste them into sha256sums, in the order of source=().

# 4. Regenerate .SRCINFO and lint.
makepkg --printsrcinfo > .SRCINFO
namcap PKGBUILD
```

Then build in a clean chroot (`extra-x86_64-build`), run `namcap` on the resulting package, copy
`PKGBUILD`, `libredb-studio-bin.install` and `.SRCINFO` into a clone of
`ssh://aur@aur.archlinux.org/libredb-studio-bin.git`, commit and push. Open a PR that updates this
directory and, once the AUR shows the new version, bump `links.last_bump_pr` for the `aur` channel in
`distribution/channels.yaml` (its pin reads the AUR RPC, so `bun run distribution:check` reports drift).

## What was verified (0.17.0, x86_64)

Built and run in an Arch Linux container with systemd as PID 1:

- `makepkg -s` builds the package, all five source checksums pass, and `makepkg --printsrcinfo` output
  matches the committed `.SRCINFO`.
- `namcap PKGBUILD` is clean. `namcap` on the package reports **0 errors**. The surviving warnings are
  all about the prebuilt payload and are not fixable here: the native addons are not stripped and lack
  PIE and full RELRO (they are upstream binaries); the musl and arm64 addons inside the x86_64 tarball
  reference libraries that are not installed and are never loaded on glibc x86_64; and `namcap` cannot
  see that the launcher reaches `nodejs-lts-krypton` through the `node/bin/node` symlink, so it calls
  the dependency "possibly not needed".
- A build in a clean chroot (`extra-x86_64-build`) finishes, and two builds in the same directory with
  a fixed `SOURCE_DATE_EPOCH` produce the same package hash.
- `pacman -U`, `systemctl enable --now libredb-studio`: `GET /api/db/health` answers 200 within a
  second, the admin password appears once in the journal, state lands in `/var/lib/libredb-studio`,
  and `pacman -Qkk` reports no altered files.
- Through the installed package: login, server-side SQLite storage, and a real PostgreSQL 17 query
  (`POST /api/db/query`) all succeed.
- `pacman -R` removes everything except `/var/lib/libredb-studio`; a reinstall logs in with the
  original password and prints no new one.

Not verified: the `aarch64` build (its checksum comes from the release's `SHA256SUMS`; no ARM machine was
available) and the AUR push itself, which needs the project's AUR account.
