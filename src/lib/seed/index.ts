import * as fs from "fs";
import { loadConfig } from "./config-loader";
import { resolveAllCredentials, seedValuesAreLiteral } from "./credential-resolver";
import { filterByRoles, mergeDefaults } from "./connection-filter";
import { getDiscoveredConnections } from "./discovery-loader";
import { isSampleEnabled, resolveSamplePath, buildSampleConnection } from "./libredb-sample";
import {
  isSqliteSampleEnabled,
  resolveSqliteSamplePath,
  buildSqliteSampleConnection,
  getSqliteSampleSeedState,
  SQLITE_SAMPLE_SEED_ID,
} from "./sqlite-sample";
import type { ManagedConnection, SeedConfig } from "./types";

export type { ManagedConnection } from "./types";
export { resetCache } from "./config-loader";

/**
 * The seed file's connections these roles may see, with the file's defaults merged in.
 *
 * Normally every `${NAME}` in them is resolved here, and a `${vault:...}` is left for
 * `resolveConnection` to read when the connection is opened. With SEED_LITERAL_VALUES on, none of
 * them passes through resolveAllCredentials and each carries the literal marker, which
 * `resolveConnection` honours by skipping Vault, so no value is resolved anywhere. The marker is set
 * after filterByRoles, because filterByRoles copies a fixed field list and SeedConnectionSchema
 * strips an undeclared key, so a marker set any earlier would not survive; filterByRoles builds a new
 * object for every connection, so setting it never reaches the cached file.
 */
function fileSeeds(config: SeedConfig, roles: string[]): ManagedConnection[] {
  const withDefaults = config.connections.map((conn) => mergeDefaults(conn, config.defaults));
  if (!seedValuesAreLiteral()) return filterByRoles(resolveAllCredentials(withDefaults), roles);
  const literal = filterByRoles(withDefaults, roles);
  for (const conn of literal) conn.literal = true;
  return literal;
}

async function loadAndResolve(): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];
  return fileSeeds(config, ["*", "admin", "user"]);
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  const fromConfig = config ? fileSeeds(config, roles) : [];

  /*
    Discovered connections (CapRover auto-connect spec 9.5 and 9.7) come after the operator's own file and
    before the built-in samples. They never pass through resolveAllCredentials: their values are the literal
    text another app on the platform network carries, so a `${NAME}` in them is not Studio's to resolve, and
    a plaintext password in them is not the operator's to be warned about. The literal marker is set here,
    after filterByRoles, because filterByRoles copies a fixed field list and SeedConnectionSchema strips an
    undeclared key, so a marker set any earlier would not survive. loadAndResolve above does not include
    them, so the unfiltered lookup never confirms to a caller that a discovered id exists. filterByRoles builds
    a new object per entry, so the marker is set on that object in place and the loader's cache is not touched.

    A discovered connection whose id the seed file read above also uses is dropped, whichever role the file's
    connection is for. The loader applies the same rule when it recomputes, but its cache and the seed file's
    expire independently, so for up to one SEED_CACHE_TTL_MS it can still list an id the file has just gained,
    and the list would carry that id twice.
  */
  const fileIds = new Set(config?.connections.map((conn) => conn.id));
  const discovered = filterByRoles(await getDiscoveredConnections(), roles)
    .filter((conn) => !fileIds.has(conn.seedId))
    .map((conn) => Object.assign(conn, { literal: true as const }));

  const out = [...fromConfig, ...discovered];

  /*
    The SQLite sample leads the built-ins, and the order is the point: a client with
    no persisted active connection selects the first of this list, so whichever sample
    comes first is what a brand-new user lands on. Agent mode executes statements on
    PostgreSQL, SQLite, DuckDB and SQL Server; the LibreDB engine has no
    database-native read-only execution profile, so leading with it put every
    zero-config user on the one connection an agent run can never execute
    against. An operator's own seed config
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
