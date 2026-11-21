# Seed Assets

The built-in sample databases.
On a standalone install each one is copied into the data directory at boot and advertised as a ready-to-query sample connection, so the first-run experience starts with real data (see `docs/SEED_CONNECTIONS.md`, "Built-in Sample Connections").

This directory ships inside every distribution payload (Docker image, standalone tarball, npx, deb/rpm, snap, Homebrew) as a top-level `seed-assets/` directory next to `server.js`.
It is copied explicitly by the `Dockerfile` and `scripts/build-standalone-payload.sh`, because Next.js output file tracing cannot see runtime `fs` reads.
The server reads it from `SEED_ASSETS_DIR`, by default `<working directory>/seed-assets`.

| Asset | Sample connection | Made by | Attribution |
|-------|-------------------|---------|-------------|
| `sqlite/employee.db` | Sample (Employees) | `scripts/generate-sqlite-sample.mjs` | [`sqlite/ATTRIBUTION.md`](sqlite/ATTRIBUTION.md) (CC BY-SA 3.0) |
| `libredb/sample.libredb` | Sample (LibreDB) | `scripts/generate-libredb-sample.mjs` | Written for this repository |

The files are never edited by hand: a change is a rerun of the script that made the file.
`SAMPLES` in `src/lib/seed/samples.ts` pins each file's size and SHA-256 digest, and the server refuses to copy a file that does not match.
`tests/unit/seed/sqlite-sample-asset.test.ts` and `tests/unit/seed/libredb-sample-asset.test.ts` rerun each script and fail when the committed file or its pin differs from what the script makes.
