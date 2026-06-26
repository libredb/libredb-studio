import * as fs from 'fs';
import { loadConfig } from './config-loader';
import { resolveAllCredentials } from './credential-resolver';
import { filterByRoles, mergeDefaults } from './connection-filter';
import { isSampleEnabled, resolveSamplePath, buildSampleConnection } from './libredb-sample';
import type { ManagedConnection } from './types';

export type { ManagedConnection, SeedConfig, SeedConnection, SeedDefaults } from './types';
export { resetCache } from './config-loader';

async function loadAndResolve(): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  if (!config) return [];
  const withDefaults = config.connections.map((conn) => mergeDefaults(conn, config.defaults));
  const resolved = resolveAllCredentials(withDefaults);
  return filterByRoles(resolved, ['*', 'admin', 'user']);
}

export async function getManagedConnections(roles: string[]): Promise<ManagedConnection[]> {
  const config = await loadConfig();
  const fromConfig = config
    ? filterByRoles(
        resolveAllCredentials(config.connections.map((conn) => mergeDefaults(conn, config.defaults))),
        roles,
      )
    : [];

  // In a test run, only consider the sample when an explicit path override is set,
  // so an uncontrolled real ./data/sample.libredb cannot perturb unrelated suites.
  // (NODE_ENV==='test' guard mirrors the existing pattern in src/lib/db/factory.ts.)
  const sampleConsideredHere =
    process.env.NODE_ENV !== 'test' || !!process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;

  if (isSampleEnabled() && sampleConsideredHere) {
    try {
      if (fs.existsSync(resolveSamplePath())) {
        return [...fromConfig, buildSampleConnection()];
      }
    } catch { /* fs error -> omit the sample */ }
  }
  return fromConfig;
}

export async function getSeedConnectionById(
  seedId: string,
  roles: string[],
): Promise<ManagedConnection | null> {
  const all = await getManagedConnections(roles);
  return all.find((c) => c.seedId === seedId) ?? null;
}

export async function getSeedConnectionByIdUnfiltered(
  seedId: string,
): Promise<ManagedConnection | null> {
  const all = await loadAndResolve();
  return all.find((c) => c.seedId === seedId) ?? null;
}
