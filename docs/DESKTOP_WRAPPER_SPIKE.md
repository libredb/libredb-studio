# Desktop Wrapper Spike: Recommendation

Deliverable for issue #115 (part of the distribution-channels epic #108). This was a written
recommendation only: no store submissions, no build scaffolding in the repo.

## Status

The Linux half of this recommendation is implemented (issue #232). Follow-ups 1, 3 and 4 below are
done for Linux: the Tauri v2 shell lives in [`desktop/`](../desktop/README.md), release CI attaches
a desktop AppImage per architecture, and [`packaging/flatpak/`](../packaging/flatpak/README.md)
repacks that AppImage for Flathub (the submission PR itself is a manual step). Follow-up 2 shipped
with #114. Two decisions changed during implementation, both recorded where they apply:

- **Flathub builds by repacking the release AppImage**, not from vendored cargo/npm sources - one
  build pipeline, the same bytes as every other channel. The trade-off is discussed in
  `packaging/flatpak/README.md`.
- **The auth handoff uses the password the server persists**, not a one-shot password injected per
  launch. Reusing the zero-config bootstrap file (#109) means no new secret-handling code, stable
  sessions across restarts, and a documented fallback if the handoff fails. See
  `desktop/README.md`.

Still open, all needing paid signing identities: macOS `.dmg` plus brew cask, Windows code signing,
the Microsoft Store MSIX, and the Tauri updater (follow-ups 5 to 8).

## Recommendation

**Go, with Tauri v2 and the standalone server as a sidecar process.** The wrapper is a thin
native shell that spawns the same `node server.js` payload already shipped in the
`libredb-studio-standalone-<version>-<os>-<arch>.tar.gz` release artifacts, waits for
`GET /api/db/health` to return 200, and points its webview at `http://127.0.0.1:<port>`.
The go is conditional on two spike-phase validations listed under "Go/no-go" below.

### Why Tauri v2 over Electron

| Criterion | Tauri v2 | Electron |
|---|---|---|
| Shell size | ~5-10 MB binary; uses the OS webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) | ~85-120 MB installed per app (bundles Chromium + Node) |
| Memory | One system webview process; typically lower baseline | Full Chromium; higher baseline per window |
| Updater | Built-in updater plugin with signed (minisign) update manifests, served from GitHub Releases | `electron-updater` / Squirrel; also workable but heavier artifacts to serve |
| Sidecar support | First-class: `externalBin` per target triple + the shell plugin's sidecar API (spawn, stdout/stderr events, kill) | Child processes via Node `child_process`; equally capable |
| Our renderer needs | None beyond a plain browser context — the app is a served web page; no Node integration in the renderer is needed | Node-in-renderer is Electron's main advantage and we do not need it |

Since LibreDB Studio's UI is entirely served by the sidecar HTTP server, the wrapper needs
nothing from the shell except "open a webview at a URL and manage a child process". That is
exactly the case where Tauri's size/memory advantage costs nothing.

**Concrete blockers that would force Electron — and why none hold up:**

1. *"Tauri cannot run a Node sidecar."* False. A Tauri sidecar is any executable; we ship the
   pinned Node binary (the deb/rpm packaging already downloads and checksum-verifies Node
   24.18.0 via `packaging/linux/fetch-node.sh` and ships only `bin/node`) as the `externalBin`
   and the payload directory as bundled resources, then spawn `node server.js` with `PORT` and
   `HOSTNAME` in the environment — the same contract `bin/studio.js` (the npx launcher) already
   uses.
2. *"The system webview cannot render the app."* The main risk is Monaco editor under WebKitGTK
   on Linux. Monaco runs in Safari (WKWebView engine), so macOS is low-risk; WebKitGTK lags
   Safari and has known rendering/performance quirks (uncertainty: must be verified in the
   spike, this is the primary go/no-go check). Windows WebView2 is Chromium and is a non-issue.
3. *"Old Linux distros lack WebKitGTK 4.1."* Real but acceptable: AppImage/Flatpak target
   current desktop distros, and the existing .deb/.rpm/snap server packages already cover
   headless and older systems.

If the WebKitGTK check fails badly (Monaco unusable), the fallback is Electron for the Linux
desktop artifact only — not a reason to change the overall architecture, since the sidecar
design is identical in both shells.

## Sidecar lifecycle design

The standalone `server.js` (Next.js standalone output) honours `PORT` and `HOSTNAME` from the
environment; the wrapper controls everything through env vars, never config files.

- **Free-port selection.** Bind a listener on `127.0.0.1:0`, read the OS-assigned port, close
  it, and pass that port as `PORT` with `HOSTNAME=127.0.0.1`. Binding to loopback only is
  load-bearing for the auth model below. The small close-then-spawn race is acceptable on a
  desktop machine; on `EADDRINUSE` at boot, retry with a fresh port.
- **Boot health check.** Poll `GET http://127.0.0.1:<port>/api/db/health` (unauthenticated by
  design, `src/app/api/db/health/route.ts`) until 200, with a ~30 s deadline — the same
  contract the release smoke test in `scripts/build-standalone-payload.sh` enforces. Show a
  splash/progress state until healthy; on deadline, surface the sidecar's captured
  stdout/stderr in an error dialog.
- **Crash restart policy.** If the sidecar exits after having been healthy: restart with
  backoff (e.g. 3 attempts, 1 s / 5 s / 15 s), reusing the same data directory so state and
  credentials persist. After the third failure, stop and show the captured logs. Never restart
  in a tight loop.
- **Clean shutdown.** On window close / app quit, send SIGTERM (Windows: kill the process
  tree), wait a few seconds, then SIGKILL. The wrapper is the sole owner of the process; it
  must also kill the sidecar if the wrapper itself crashes (Tauri's sidecar API ties child
  lifetime to the app process).

### Zero-config bootstrap reuse and desktop-mode auth handoff

The merged zero-config first run (#109, `src/lib/auth-bootstrap.ts`) already means the sidecar
boots with zero env vars: it generates `JWT_SECRET` and `ADMIN_PASSWORD`, persists them in
`auth-bootstrap.json` (mode 0600) inside the data directory (the directory of
`STORAGE_SQLITE_PATH`, `src/lib/data-dir.ts`), and prints the password once. Two properties of
that module matter here: explicitly set env vars always win over the persisted file, and the
server never asks for interactive input.

The desktop user should never see a login form for their own local instance. Proposed handoff,
using only existing server behaviour:

1. The wrapper resolves a per-user data directory (XDG on Linux, `~/Library/Application
   Support` on macOS, `%APPDATA%` on Windows) and passes it as `STORAGE_SQLITE_PATH`.
2. On each launch the wrapper generates a random one-shot `ADMIN_PASSWORD` and a persisted
   `JWT_SECRET` (stored in the same data dir, or delegated to the server's own bootstrap file)
   and injects both as env vars. Because env vars win, the server's bootstrap file logic is
   bypassed for the password — no banner, no stable password lying on disk.
3. After the health check passes, the wrapper POSTs `{"email": "admin@libredb.org", "password":
   <one-shot>}` to `/api/auth/login` (default email mirrors `local-auth.ts`; the route sets the
   `auth-token` JWT cookie, `src/lib/auth.ts`) and loads the app URL in the webview with that
   cookie applied. The user lands directly in the workspace.
4. Security posture: the server binds 127.0.0.1 only; the password is random per launch and
   held only in the wrapper process and the sidecar's env. This is the "localhost-only session"
   idea — no relaxation of server-side auth is required, so the wrapper works against the
   unmodified standalone payload. (Getting the login cookie into the webview is
   shell-specific plumbing — e.g. performing the login navigation inside the webview itself —
   and is a spike-phase task; uncertainty: cookie-injection ergonomics differ per webview.)

`AUTH_BOOTSTRAP=off` plus explicit env vars remains available for advanced users; the wrapper
never needs it.

## Payload strategy

Reuse `libredb-studio-standalone-<version>-<os>-<arch>.tar.gz` from GitHub Releases (built by
`scripts/build-standalone-payload.sh`, published by `release-artifacts.yml` for linux-x64,
linux-arm64, darwin-x64, darwin-arm64) as the sidecar payload verbatim. The wrapper build
downloads the tarball for its target, verifies it against `SHA256SUMS`, and bundles it as
resources — no second build pipeline for the server.

Per-OS native-module notes:

- **better-sqlite3** is the only native module in the payload; the build script verifies the
  binding loads under the packaging Node. Since v13 the package is N-API and self-contained - the
  former `bindings` / `file-uri-to-path` runtime deps are gone, and one prebuilt binary per
  platform is valid across Node majors, so the ABI-rebuild concern this note was written around no
  longer applies. Prebuilds exist for linux (glibc and musl), darwin and win32 on x64 and arm64.
- **Node runtime is bundled per platform**, pinned and checksum-verified against the official
  `SHASUMS256.txt` — the mechanism already implemented in `packaging/linux/fetch-node.sh`
  (Node 24.18.0); extend the same script pattern to darwin and win32 dist tarballs.
- **Windows gap (closed by #114):** `release-artifacts.yml` now builds the `win32-x64`
  standalone zip (bundled Node runtime + Go launcher, `packaging/windows/`), and `bin/studio.js`
  runs it via npx on Windows — the wrapper's Windows target can consume that payload directly.
- **macOS:** everything inside the .app bundle (Node binary included) must be signed and
  notarized together; unsigned nested binaries fail Gatekeeper on first launch.

## Packaging matrix

| Channel | What it requires | Wrapper needed? | Notes |
|---|---|---|---|
| AppImage | Tauri bundler output; attach to GitHub Releases | Yes | No store review; instant win once the wrapper exists |
| .deb | Tauri bundler can emit one | Already covered | Native server .deb/.rpm ship via nfpm (`packaging/linux`, systemd service). Keep the server .deb canonical; a wrapper .deb would be a separate GUI package (e.g. `libredb-studio-desktop`) to avoid conflict |
| .dmg / .app | Tauri bundler; Apple signing + notarization for a usable install | Yes | Unsigned dmg triggers "damaged/unverified" Gatekeeper flows; effectively requires the Apple Developer Program |
| Flathub | Flatpak manifest; GUI app required | Yes | Free; review is technical, not commercial. Flathub rejects headless server apps, which is why the snap (a server daemon; store publish is wired in release CI but gated on `SNAPCRAFT_STORE_CREDENTIALS`) cannot be reused here. **As implemented (#232) the manifest repacks the release AppImage** rather than doing an offline vendored build - see `packaging/flatpak/README.md` |
| MSI / MSIX (Microsoft Store) | Tauri emits NSIS .exe and MSI (WiX); MSIX for the Store is a separate packaging step on top | Yes | Store distribution: Microsoft signs the MSIX, no own cert needed; direct-download MSI/NSIS needs code signing to avoid SmartScreen warnings |
| brew cask | A notarized .dmg/.app plus a cask formula (own tap first, `homebrew/cask` once notable) | Yes | Complements the server formula that release CI renders and pushes to `libredb/homebrew-tap` (brew services; gated on `TAP_GITHUB_TOKEN`); cask is the GUI companion |

The wrapper is the single artifact that unlocks AppImage, Flathub, the Microsoft Store, dmg,
and brew cask; .deb/.rpm/snap/npx/brew-formula are already served by the server channels on
this branch.

## Signing and notarization costs

Prices are list prices as of mid-2026 and move over time (uncertainty on exact figures; orders
of magnitude are stable).

| Item | Cost | Process notes |
|---|---|---|
| Apple Developer Program | USD 99/year | Required for Developer ID signing and notarization (`notarytool` is free with membership). Notarize the .app and staple the ticket to the .dmg; sign every nested binary including the bundled Node |
| Windows OV code signing certificate | ~USD 200-500/year | Since 2023 keys must live on hardware/HSM; cloud signing (e.g. Azure Trusted Signing, ~USD 10/month, or certum/ssl.com cloud HSM) is the practical CI path. SmartScreen reputation builds up over downloads |
| Windows EV code signing | ~USD 300-700/year | Faster SmartScreen reputation; only worth it if direct-download volume matters. Not needed for Microsoft Store distribution (Store signs the MSIX; account fee is a one-time USD 19 individual / USD 99 company) |
| Flathub | Free | No signing fees; flat-manager signs repo artifacts. Cost is engineering time for the offline/vendored build |
| AppImage | Free | Optional GPG signature + zsync for delta updates; no CA involved |
| Tauri updater keys | Free | Self-managed minisign keypair; the private key becomes a release-CI secret like `TAP_GITHUB_TOKEN` / `SNAPCRAFT_STORE_CREDENTIALS` |

Minimum recurring cash cost for the full matrix: ~USD 99/year (Apple) + ~USD 120-500/year
(Windows signing path chosen) + USD 19 one-time (Store account). Linux channels are free.

## Phased plan and go/no-go

**Phase 1 — Spike (timeboxed ~1 week, throwaway branch, nothing merged).**
Prototype the Tauri v2 shell on Linux + macOS using the existing darwin/linux tarballs as
payload. Validate: (a) Monaco and the workspace under WebKitGTK, (b) sidecar lifecycle
(free port, health gate, kill on quit), (c) the auth handoff (env-injected one-shot password →
`/api/auth/login` → cookie in webview). Produce unsigned AppImage + .dmg locally.

**Phase 2 — PoC in-repo (if spike passes).**
Add `desktop/` with the Tauri project; a release-CI job (same gating pattern as the existing
optional-secret jobs) downloads the standalone tarballs, bundles Node per platform, and attaches
unsigned AppImage/.dmg/NSIS to releases as pre-release artifacts. Add the `win32-x64` standalone
payload to `release-artifacts.yml` (shared with #114). Wire the Tauri updater against GitHub
Releases.

**Phase 3 — Signing and store submissions (each its own issue).**
Order by cost/benefit: (1) AppImage attached to releases — free, immediate; (2) Flathub — free,
highest Linux-desktop reach; (3) Apple Developer Program + notarized .dmg, then the brew cask;
(4) Windows signing + winget manifest pointing at the wrapper installer (closes #114 option 2);
(5) Microsoft Store MSIX.

**Go/no-go: GO**, conditional on the two spike checks — WebKitGTK renders Monaco acceptably,
and the auth handoff works without modifying the server. If WebKitGTK fails, re-scope Linux to
Electron (or keep Linux server-only) and continue with Tauri on macOS/Windows; if the auth
handoff needs server changes, they are limited to an optional localhost-only session endpoint
and must go through a normal security review.

**Follow-up issues to open on go:**

1. Desktop wrapper PoC: Tauri v2 shell + sidecar lifecycle + auth handoff (`desktop/`).
2. Windows standalone payload (win32-x64) in `release-artifacts.yml` (blocks #114 option 2 and
   the Windows wrapper).
3. Release CI: unsigned desktop artifacts (AppImage, .dmg, NSIS) attached to releases.
4. Flathub submission (manifest, vendored offline build).
5. Apple signing + notarization in CI, then brew cask in `libredb/homebrew-tap`.
6. Windows code signing in CI; winget/Chocolatey manifests for the wrapper installer (#114).
7. Microsoft Store (MSIX) submission.
8. Tauri updater: key management and release-manifest publishing.
