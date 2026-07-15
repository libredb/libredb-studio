# Windows packaging (issue #114)

Everything that turns the standalone payload into the `win32-x64` release zip
installed by winget, Chocolatey, and the npx launcher. The Linux siblings live
in [`packaging/linux/`](../linux).

| Piece | Purpose |
|---|---|
| [`launcher/`](launcher) | Go source of `libredb-studio.exe` — resolves its own directory, applies the local-first defaults (`HOSTNAME`/`LIBREDB_BIND`, `STORAGE_SQLITE_PATH` under `%LOCALAPPDATA%\LibreDB\Studio`), and runs the bundled `node\node.exe` against `server.js` |
| [`fetch-node.sh`](fetch-node.sh) | Downloads the pinned Node runtime zip from nodejs.org, verifies the in-repo sha256, installs only `node.exe` into the payload |
| [`../winget/`](../winget) | winget manifest templates (`LibreDB.Studio`), rendered by [`scripts/render-windows-packaging.mjs`](../../scripts/render-windows-packaging.mjs) |
| [`../chocolatey/`](../chocolatey) | Chocolatey package templates (`libredb-studio`), rendered by the same script |

The release flow (`.github/workflows/release-artifacts.yml`, `windows-package`
job) builds the payload natively on `windows-latest`, bundles Node and the
launcher, re-packs the FLAT zip (`scripts/lib/pack-standalone-zip.sh` — flat so
winget's `NestedInstallerFiles.RelativeFilePath` stays stable across releases),
and smoke-boots `libredb-studio.exe` before anything is attached to the
release. After the release publishes, the `chocolatey` and `winget` jobs push
the community-catalog updates (secret-gated; see `docs/DISTRIBUTION.md`,
"Windows first-listing checklist").

## Working on the launcher (any OS)

The launcher is dependency-free Go with its pure logic unit-tested
host-agnostically — no Windows box needed:

```bash
cd packaging/windows/launcher
gofmt -l .          # formatting (must print nothing)
go vet ./...
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o libredb-studio.exe .
```

The same commands run in the `windows-package` release job before every build.
