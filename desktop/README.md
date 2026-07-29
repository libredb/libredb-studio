# LibreDB Studio desktop shell

A Tauri v2 window around the standalone LibreDB Studio server. The shell adds no
features: it starts the same `node server.js` payload every other channel ships,
waits for it to become healthy, logs the local user in and shows the app. Issue
[#232](https://github.com/libredb/libredb-studio/issues/232); the design it
implements is [`docs/DESKTOP_WRAPPER_SPIKE.md`](../docs/DESKTOP_WRAPPER_SPIKE.md)
(issue #115).

The desktop build is what makes the AppImage and the Flathub listing possible -
Flathub rejects headless server applications.

## Layout

```
desktop/
  src/index.html            splash page shown while the server boots
  src-tauri/
    tauri.conf.json         bundle config; app version comes from the repo-root package.json
    desktop-entry.hbs       desktop-file template (display name, StartupWMClass)
    src/lib.rs              boot sequence and supervision (the Tauri wiring)
    src/net.rs              free-port pick + /api/db/health gate
    src/sidecar.rs          the child process: env contract, log tail, shutdown
    src/handoff.rs          reads the bootstrap password, builds the login script
    src/layout.rs           finds the bundled node runtime and payload
    src/backoff.rs          restart policy
    icons/                  bundle icons (generated from public/logo.svg)
    bin/node-<triple>       staged by the build script, git-ignored
    payload/                staged by the build script, git-ignored
```

## How it boots

1. The window opens on the bundled splash page immediately.
2. A background thread picks a free loopback port and spawns
   `node server.js` from the bundled payload with `STORAGE_PROVIDER=sqlite` and
   `STORAGE_SQLITE_PATH` inside the per-user data directory
   (`$XDG_DATA_HOME/org.libredb.Studio` on Linux, `~/.var/app/org.libredb.Studio/data/...`
   inside Flatpak).
3. It polls `GET /api/db/health` until it answers 200 (30 s budget).
4. It reads the admin password the server's zero-config first run (#109) wrote to
   `auth-bootstrap.json` in that data directory and navigates the webview to `/`.
   With a session already in the webview's cookie jar that is the workspace; on a
   first run the server redirects to `/login`, where the shell evaluates a small
   script that POSTs the credentials to the existing `/api/auth/login` route and
   replaces the page with `/`. Landing on `/` either way is deliberate - going to
   `/login` directly would send a returning admin to the admin dashboard instead.
5. If the server dies later, the shell restarts it (1 s, 5 s, 15 s) and then
   gives up with the captured server log shown on the splash page.

Notes on the choices, since they are easy to get wrong later:

- **No credentials are invented by the shell.** `JWT_SECRET` and
  `ADMIN_PASSWORD` are left unset so the server generates and persists them
  itself, mode 0600, next to the storage database. Sessions therefore survive
  restarts, and `auth-bootstrap.json` stays the documented fallback if the
  automatic handoff ever fails - the user can read the password out of it and log
  in by hand. The shell also clears inherited `ADMIN_PASSWORD` / `AUTH_BOOTSTRAP`
  / storage variables so a developer's shell cannot break that contract.
- **The server is never exposed.** `HOSTNAME=127.0.0.1` and a random port; the
  parent process' `HOSTNAME` (the machine name on most desktops) would otherwise
  become the bind address.
- **The sidecar cannot outlive the shell.** Window close and app exit both run a
  SIGTERM-then-SIGKILL shutdown, `Drop` repeats it, and on Linux the child gets
  `PR_SET_PDEATHSIG` so even a killed shell takes the server with it.
- **No shell plugin, no IPC surface.** The child process is spawned from Rust
  with `std::process`, so the webview has no command it could invoke.
- **`productName` stays space-free.** It names the bundled resource directory
  (`usr/lib/<productName>/payload`), which the Flatpak manifest's build commands
  and the build scripts then handle without quoting gymnastics. The display name
  lives in `desktop-entry.hbs` and the window `title` instead; the AppImage smoke
  test fails the build if a space reappears.
- **Symlinks do not survive bundling.** Turbopack resolves the externalized
  database drivers (`pg`, `mysql2`, `mongodb`, `ssh2`, `better-sqlite3`) through
  hashed symlinks under `payload/.next/node_modules`, and Tauri's resource copy
  drops symlinks silently - the directory is simply missing from the bundle and
  every request fails with `Failed to load external module <driver>-<hash>`, while
  the server still logs "Ready". The build script materializes those symlinks as
  real directories and the smoke test asserts the directory is present.

## Development

```bash
# One-time system dependencies (Debian/Ubuntu names)
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf file

# Stage the payload + node sidecar, then bundle an AppImage (keeps the staging
# directories so `tauri dev` works straight after)
scripts/build-desktop-appimage.sh dist --smoke --keep-stage

# Iterate on the shell itself against the staged payload
cd desktop/src-tauri && bunx @tauri-apps/cli@2.11.4 dev

# Unit tests (pure logic: port pick, env contract, handoff, backoff, shutdown)
cd desktop/src-tauri && cargo test
```

`cargo test` needs Rust >= 1.88 (the floor of the Tauri 2.11 dependency tree).

## Packaging

- **AppImage and GUI .deb:** one `scripts/build-desktop-appimage.sh` run produces
  both `libredb-studio-desktop-<version>-linux-<arch>.AppImage` and
  `libredb-studio-desktop_<version>_<debarch>.deb`, each with a `.sha256`
  sidecar. `--smoke` checks the .deb's layout and boots the bundled server out of
  the extracted AppDir (no display needed) to prove the bundle is complete.
  Release CI runs it per architecture in
  `.github/workflows/release-artifacts.yml`; both artifacts are required release
  assets. `--deb-only` skips the AppImage, which is the way to build on a host
  without the linuxdeploy GTK toolchain (`librsvg2-dev` and friends).
- **The bundled Node sidecar is named `libredb-studio-node`, not `node`.** The
  .deb installs it into the real `/usr/bin`, where `node` is owned by the distro
  `nodejs` package and dpkg would refuse the install. `externalBin` in
  `tauri.conf.json`, `NODE_BIN` in the build script and `NODE_BIN` in
  `src/layout.rs` all have to agree; `layout.rs` still probes the old name so an
  AppDir built before the rename keeps working.
- **Flatpak / Flathub:** [`packaging/flatpak/`](../packaging/flatpak/) repacks
  that AppImage. See its README for the local build and the submission steps.
- **FlatPark:** [`packaging/flatpark/`](../packaging/flatpark/) pins the GUI .deb
  as Flatpak extra-data instead, because FlatPark does not accept AppImages.
