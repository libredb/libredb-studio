/**
 * The run-time objects of the S3 fixtures (docker/s3/README.md): the two Parquet files too
 * large to commit and the 10,050 one-byte held/ keys that reach the Keys panel's held limit.
 *
 * It never sends a request itself: it writes the Parquet files into a fresh temporary directory with the
 * repository's DuckDB (tests/helpers/s3-large-parquet.ts, the writer the preview's unit case reads too), then runs
 * the target's own seed one-shot with that directory mounted read-only, so the one
 * signer every fixture object goes through, curl --aws-sigv4 in docker/s3/seed.sh, writes these objects too. No
 * provider module gains a write path for a fixture. tests/unit/db/s3/live-environment.test.ts holds both rules.
 *
 *   bun tests/live/s3-seed-raw.ts --target <minio|minio-region|silo|garage|rustfs>
 *
 * It is NOT in `bun run test`: the runner excludes tests/live/ by name (tests/runner/discover.ts). An argument it does
 * not accept exits 2 before anything runs; silo-tls is refused, because no row it runs needs a run-time object.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeLargeParquet } from "../helpers/s3-large-parquet";

const ROOT = path.resolve(import.meta.dir, "../..");

interface SeedTarget {
  readonly service: string;
  readonly profile?: string;
  readonly endpoint: string;
  readonly region: string;
  readonly server: "minio" | "silo" | "garage" | "rustfs";
}

/** The seed one-shots of database-compose.yml, with the endpoint, region and server each passes to seed.sh. */
const TARGETS: Readonly<Record<string, SeedTarget>> = {
  minio: {
    service: "minio-seed",
    profile: "s3-minio",
    endpoint: "http://minio:9000",
    region: "us-east-1",
    server: "minio",
  },
  "minio-region": {
    service: "minio-region-seed",
    profile: "s3-region",
    endpoint: "http://minio-region:9000",
    region: "eu-central-1",
    server: "minio",
  },
  silo: { service: "silo-seed", endpoint: "http://silo:9000", region: "us-east-1", server: "silo" },
  garage: { service: "garage-seed", endpoint: "http://garage:3900", region: "garage", server: "garage" },
  rustfs: { service: "rustfs-seed", endpoint: "http://rustfs:9000", region: "us-east-1", server: "rustfs" },
};

const args = process.argv.slice(2);
const target = args[0] === "--target" && args.length === 2 ? TARGETS[args[1]] : undefined;
if (target === undefined) {
  console.error(`s3-seed-raw.ts: --target must be one of ${Object.keys(TARGETS).join(", ")}`);
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), "s3-seed-raw-"));
let exit = 1;
try {
  await writeLargeParquet(dir);
  const compose = ["compose", "-p", "libredb-studio", "-f", path.join(ROOT, "database-compose.yml")];
  if (target.profile !== undefined) compose.push("--profile", target.profile);
  const run = spawnSync(
    "docker",
    [
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-v",
      `${dir}:/raw:ro`,
      "--entrypoint",
      "sh",
      target.service,
      "/s3/seed.sh",
      "--raw",
      "/raw",
      target.endpoint,
      target.region,
      target.server,
    ],
    { stdio: "inherit", cwd: ROOT },
  );
  exit = run.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exit);
