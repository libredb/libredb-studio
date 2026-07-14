# Seed Assets

Vendored sample database templates. On a fresh standalone install these are
copied into the data directory at boot and advertised as ready-to-query
sample connections, so the first-run experience starts with real data (see
`docs/SEED_CONNECTIONS.md`, "Built-in Sample Connections").

This directory ships inside every distribution payload (Docker image,
standalone tarball, npx, deb/rpm, snap, Homebrew) as a top-level
`seed-assets/` directory next to `server.js` — it is copied explicitly by the
`Dockerfile` and `scripts/build-standalone-payload.sh` because Next.js output
file tracing cannot see runtime `fs` reads.

| Asset | Sample connection | Attribution |
|-------|-------------------|-------------|
| `sqlite/employee.db` | Sample (Employees) | [`sqlite/ATTRIBUTION.md`](sqlite/ATTRIBUTION.md) (CC BY-SA 3.0) |

The LibreDB sample (`Sample (LibreDB)`) is seeded programmatically by
`src/lib/seed/libredb-sample.ts` and has no asset here.
