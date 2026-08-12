import * as fs from "fs";
import { loadConfig } from "./config-loader";
import { resolveAllCredentials } from "./credential-resolver";
import { filterByRoles, mergeDefaults } from "./connection-filter";
import { isSampleEnabled, resolveSamplePath, buildSampleConnection } from "./libredb-sample";
import {
  isSqliteSampleEnabled,
  resolveSqliteSamplePath,
  buildSqliteSampleConnection,
  getSqliteSampleSeedState,
  SQLITE_SAMPLE_SEED_ID,
} from "./sqlite-sample";
import type { ManagedConnection } from "./types";

export type { ManagedConnection } from "./types";
export { resetCache } from "./config-loader";

async function loadAndResolve(): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];
  const withDefaults = config.connections.map((conn) => mergeDefaults(conn, config.defaults));
  const resolved = resolveAllCredentials(withDefaults);
  return filterByRoles(resolved, ["*", "admin", "user"]);
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  const fromConfig = config
    ? filterByRoles(
        resolveAllCredentials(config.connections.map((conn) => mergeDefaults(conn, config.defaults))),
        roles,
      )
    : [];

  const out = [...fromConfig];

  /*
    The SQLite sample leads the built-ins, and the order is the point: a client with
    no persisted active connection selects the first of this list, so whichever sample
    comes first is what a brand-new user lands on. The agent runtime targets
    PostgreSQL and SQLite; the LibreDB engine has no database-native read-only
    execution profile, so leading with it put every zero-config user on the one
    connection an agent run can never execute against. An operator's own seed config
    still leads both — those are already in `out`.

    In a test run, only consider a sample when its explicit path override is set, so
    an uncontrolled real ./data/sample.* cannot perturb unrelated suites.
    (NODE_ENV==='test' guard mirrors the existing pattern in src/lib/db/factory.ts.)
  */
  const sqliteSampleConsidered = process.env.NODE_ENV !== "test" || !!process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
  if (isSqliteSampleEnabled() && sqliteSampleConsidered) {
    try {
      if (fs.existsSync(resolveSqliteSamplePath())) {
        out.push(buildSqliteSampleConnection());
      }
    } catch {
      /* fs error -> omit the sample */
    }
  }

  const libredbSampleConsidered = process.env.NODE_ENV !== "test" || !!process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
  if (isSampleEnabled() && libredbSampleConsidered) {
    try {
      if (fs.existsSync(resolveSamplePath())) {
        out.push(buildSampleConnection());
      }
    } catch {
      /* fs error -> omit the sample */
    }
  }

  return out;
}

/**
 * Seed ids whose async seeding is still in flight — advertised by the managed
 * connections API so clients poll until the sample appears (or seeding ends).
 * Empty when nothing is seeding: embedded in platform, instrumentation never
 * runs, the state stays "idle", and clients never poll.
 */
export function getPendingSeeds(): string[] {
  if (isSqliteSampleEnabled() && getSqliteSampleSeedState() === "seeding") {
    return [SQLITE_SAMPLE_SEED_ID];
  }
  return [];
}

export async function getSeedConnectionById(seedId: string, roles: string[]): Promise<ManagedConnection | null> {
  const all = await getManagedConnections(roles);
  return all.find((c) => c.seedId === seedId) ?? null;
}

export async function getSeedConnectionByIdUnfiltered(seedId: string): Promise<ManagedConnection | null> {
  const all = await loadAndResolve();
  return all.find((c) => c.seedId === seedId) ?? null;
}
