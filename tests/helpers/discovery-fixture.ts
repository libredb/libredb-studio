/**
 * Export files for the tests of the discovery source (CapRover auto-connect spec 8.5).
 *
 * Each one is written to its own temporary directory in the exporter's shape and read back through the real
 * loader, so a test that lists or opens a discovered connection exercises the parse, the mapping and the merge it
 * depends on rather than a stand-in for them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredService, DiscoveryExport } from "@/lib/seed/discovery-export";

export interface DiscoveryExportFixture {
  /** The export file: what SEED_DISCOVERY_PATH names. */
  readonly path: string;
  /** Removes the temporary directory and everything in it. */
  remove(): void;
}

/**
 * A PostgreSQL one-click app as CapRover 1.15 deploys it: the official image, the srv-captain-- alias on the
 * overlay network, and the env keys the official template sets.
 */
export function postgresService(appName: string, password: string): DiscoveredService {
  return {
    id: `svc${appName}`,
    name: appName,
    appName,
    host: `srv-captain--${appName}`,
    image: "postgres:16",
    env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: password, POSTGRES_DB: "appdb" },
    requirepassEnv: null,
    tasks: { running: 1, desired: 1 },
  };
}

/** Writes an export of `services` from a scan that succeeded just now, so it is fresh against SEED_DISCOVERY_MAX_AGE_MS. */
export function writeDiscoveryExport(services: DiscoveredService[]): DiscoveryExportFixture {
  const dir = mkdtempSync(join(tmpdir(), "libredb-discovery-"));
  const path = join(dir, "services.json");
  const now = new Date().toISOString();
  const body: DiscoveryExport = {
    version: 1,
    platform: "caprover",
    generatedAt: now,
    checkedAt: now,
    status: { ok: true },
    network: { name: "captain-overlay-network", id: "jolhlap6b0rctoqh21rk8sidt" },
    services,
    excluded: [],
  };
  writeFileSync(path, JSON.stringify(body));
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
